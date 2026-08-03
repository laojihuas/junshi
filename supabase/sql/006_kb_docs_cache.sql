-- ============================================================
-- 军师 - 知识库全文缓存表（kb_docs）[v12 二期：本地整句匹配用]
--
-- 背景：IMA search_knowledge 只认 2-4 字短语，≥6 字整句 100% 返回空（2026-08-03 实测）。
--   二期"本地整句匹配"需在本地对"整句 vs 全文"算相关度，必须先缓存知识库全文。
--
-- 用途：存储知识库每篇文档的清洗后全文，供：
--   1. 离线构建脚本一次性灌入（本机 4379 篇 md：恋爱教学 3132 + 聊天实战 1195 + 恋爱话术 52）
--   2. ima-proxy 在线"整句匹配"召回时查缓存（毫秒级，避免每轮实时拉全库）
--   3. content_hash 变化时全量重建（增量保鲜：命中文档顺带 upsert）
--
-- 检索设计（v12b）：bigrams 列预计算每篇的 2-gram 数组 + GIN 索引，
--   在线查询用数组重叠（&&）粗筛出候选（几十篇）→ 内存按词来源加权精排。
--   media_id：本地构建时用 'local_' + sha1(相对路径) 自造（本地文件无 IMA media_id），
--   全文直接取自本地 content，不依赖 IMA get_media_info。
--
-- 安全：RLS 默认拒绝，仅 service_role 可读写；不含任何用户数据，无敏感字段。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本（幂等，可重复执行）
-- ============================================================

create table if not exists public.kb_docs (
  media_id     text primary key,        -- 唯一 ID（本地构建：local_+sha1(路径)）
  title        text,                    -- 文档标题（含 .md 后缀）
  folder_id    text,                    -- 来源目录（恋爱教学/恋爱话术/聊天实战）
  content      text,                    -- 清洗后全文
  bigrams      text[],                  -- 预计算 2-gram 数组（去重，≤800 个），供数组重叠粗筛
  content_hash text,                    -- 全文哈希，检测知识库更新
  updated_at   timestamptz default now()
);

comment on table public.kb_docs is 'IMA 知识库全文缓存（本地整句匹配用，service_role 专用）';

-- 幂等补列（表已存在的升级路径）
alter table public.kb_docs add column if not exists bigrams text[];

-- bigrams 数组重叠粗筛索引（&& 操作符）
create index if not exists kb_docs_bigrams_idx on public.kb_docs using gin (bigrams);

-- 按来源目录过滤
create index if not exists kb_docs_folder_idx on public.kb_docs (folder_id);

-- RLS：默认全拒，仅 service_role 绕过 RLS 访问（Edge Function 用 service_role key）
alter table public.kb_docs enable row level security;

-- 授权：service_role 读写（REST 层经 service_role 访问；幂等可重复执行）
grant select, insert, update, delete on public.kb_docs to service_role;

-- ============================================================
-- [v13b] kb_recall：本地整句匹配 RPC（精排下推到数据库端）
--   目的：把"粗筛(200篇拉全文)+ 内存打分"改为"库内打分排序，只返回 topN(≤5 篇含 content)"
--   → 每轮带宽从 ~560KB 降到 ~14KB（免费套餐 egress 5GB/月，彻底无后顾之忧）
--   打分：查询词在 content 中的出现次数 × 权重（整句词 2.5 / 语义词 2），单词上限 5 次
--   粗筛：bigrams 数组重叠（&&）走 GIN 索引，limit 200 候选
-- 调用：POST /rest/v1/rpc/kb_recall {p_grams, p_words, p_weights, p_limit}
-- ============================================================
create or replace function public.kb_recall(
  p_grams text[],        -- 粗筛 2-gram 数组
  p_words text[],        -- 查询词（整句词+语义词）
  p_weights numeric[],   -- 对应权重（与 p_words 同序）
  p_limit int default 5  -- 返回条数
) returns table(media_id text, title text, folder_id text, content text, score numeric)
language sql stable as $$
  with scored as (
    select d.media_id, d.title, d.folder_id, d.content,
      (select coalesce(sum(
         least((length(d.content) - length(replace(d.content, p_words[i], ''))) / greatest(length(p_words[i]), 1), 5) * p_weights[i]), 0)
       from generate_subscripts(p_words, 1) as i
       where length(p_words[i]) > 0
         and (length(d.content) - length(replace(d.content, p_words[i], ''))) / greatest(length(p_words[i]), 1) > 0
      ) as sc
    from public.kb_docs d
    where d.bigrams && p_grams
    limit 200
  )
  select media_id, title, folder_id, content, sc
  from scored
  where sc > 0
  order by sc desc
  limit p_limit;
$$;

grant execute on function public.kb_recall(text[], text[], numeric[], int) to service_role;
