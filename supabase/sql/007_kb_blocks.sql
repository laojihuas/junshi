-- ============================================================
-- 军师 - kb_blocks 块级知识库表 [B 方案]
-- 背景：15,107 个切块（恋爱话术 739 + 恋爱教学 8664 + 聊天实战 5704）
--   替代 kb_docs 整篇缓存 + 移除 IMA 依赖（运行时完全本地化）
--   [2026-08-06] 恋爱教学/聊天实战 已删库（干扰检索），仅剩恋爱话术 739 块；
--     重建数据时按当前 build_kb_blocks.mjs（ROOTS 只含恋爱话术）灌入
--
-- 结构：
--   media_id   = 源文档唯一 ID（本地方案：folder_hash + sha1(title)）
--   block_idx  = 块序号（从 0 开始，同文档内唯一）
--   title      = 文档标题（含 .md）
--   block_title = 块标题（标题感知切块产生，无则空）
--   folder_id  = 来源目录（恋爱教学/恋爱话术/聊天实战）
--   content    = 块内容（≤700 字，对话块可超长）
--   bigrams    = 预计算 2-gram 数组（≤800，GIN 索引粗筛）
--   content_hash = 内容哈希（增量检测）
--
-- 检索设计（块级）：
--   kb_blocks_recall RPC：bigrams && 粗筛 → 块内词频加权打分 → topN
--   权重：整句词 ×2.5 / 语义词 ×2（与 kb_recall 一致，行为可预期）
--   词在块内出现次数上限 5 次（短块天然精准）
--
-- 旧数据：kb_docs 整篇缓存表删除（完全清除旧知识库，改为块级）
-- ============================================================

-- ---------- 建块级表 ----------
create table if not exists public.kb_blocks (
  media_id     text not null,
  block_idx    int not null,
  title        text not null,
  block_title  text default '',
  folder_id    text default '',
  content      text not null,
  bigrams      text[],
  content_hash text,
  updated_at   timestamptz default now(),
  primary key (media_id, block_idx)
);

comment on table public.kb_blocks is 'IMA 知识库切块缓存（块级检索用，service_role 专用）';

-- bigrams 数组重叠粗筛索引（&& 操作符）
create index if not exists kb_blocks_bigrams_idx on public.kb_blocks using gin (bigrams);

-- 按来源目录过滤 + 标题查询
create index if not exists kb_blocks_folder_idx on public.kb_blocks (folder_id);
create index if not exists kb_blocks_title_idx on public.kb_blocks (title);

-- RLS：默认全拒，仅 service_role 绕过 RLS 访问
alter table public.kb_blocks enable row level security;
grant select, insert, update, delete on public.kb_blocks to service_role;

-- ---------- 块级召回 RPC ----------
-- 粗筛：查询词 bigrams 数组重叠（&&）走 GIN
-- 精排：词在【块内】出现次数 × 权重（单词上限 5 次），块短所以精准
-- 返回：块级结果（media_id, block_idx, title, block_title, folder_id, content, score）
create or replace function public.kb_blocks_recall(
  p_grams text[],        -- 粗筛 2-gram 数组
  p_words text[],        -- 查询词（整句词+语义词）
  p_weights numeric[],   -- 对应权重（与 p_words 同序）
  p_limit int default 8, -- 返回块数
  p_max_blocks_per_doc int default 2  -- 同文档最多取几块（去重）
) returns table(media_id text, block_idx int, title text, block_title text, folder_id text, content text, score numeric)
language sql stable as $$
  with scored as (
    select b.media_id, b.block_idx, b.title, b.block_title, b.folder_id, b.content,
      (select coalesce(sum(
         least((length(b.content) - length(replace(b.content, p_words[i], ''))) / greatest(length(p_words[i]), 1), 5) * p_weights[i]), 0)
       from generate_subscripts(p_words, 1) as i
       where length(p_words[i]) > 0
         and (length(b.content) - length(replace(b.content, p_words[i], ''))) / greatest(length(p_words[i]), 1) > 0
      ) as sc
    from public.kb_blocks b
    where b.bigrams && p_grams
    -- [v76] 粗筛上限 500→1000：教学/实战删库后仅 739 块，bigram 命中常超 500（实测 270-596），
    --   旧 limit 500 无排序截断会丢候选；小库全量打分无性能压力
    limit 1000
  ),
  ranked as (
    select *, row_number() over (partition by media_id order by sc desc, block_idx) as rn
    from scored
    where sc > 0
  )
  select media_id, block_idx, title, block_title, folder_id, content, sc
  from ranked
  where rn <= p_max_blocks_per_doc
  order by sc desc
  limit p_limit;
$$;

grant execute on function public.kb_blocks_recall(text[], text[], numeric[], int, int) to service_role;

-- ---------- 清除旧知识库（完全移除 IMA 相关旧数据）----------
-- 旧 kb_docs 整篇缓存表：数据删除（表保留以防回滚，但内容清空）
delete from public.kb_docs;

-- 旧 kb_recall RPC：删除（被 kb_blocks_recall 取代）
drop function if exists public.kb_recall(text[], text[], numeric[], int);
