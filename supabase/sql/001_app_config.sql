-- ============================================================
-- 军师 - 统一提示词配置表（app_config 单行表）
--
-- 用途：存储系统唯一的统一 system_prompt，由管理员在后台维护。
-- 前端用户不可见提示词内容，仅通过 Edge Function 读取。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

-- 1. 建表（单行约束：id 恒为 1）
create table if not exists public.app_config (
  id            int primary key default 1 check (id = 1),
  system_prompt text not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null
);

-- 2. 开启 RLS（Edge Function 走 service_role 不受 RLS 限制；
--    普通用户仅允许读取，防止直接篡改）
alter table public.app_config enable row level security;

-- 读取策略：已登录用户可读（供 prompt-get 使用；实际业务中
-- prompt-get 用 service_role 读取，此策略为纵深防御）
drop policy if exists "app_config_read" on public.app_config;
create policy "app_config_read"
  on public.app_config for select
  using (auth.role() = 'authenticated');

-- 写入策略：仅允许 service_role（不创建任何 anon/authenticated 写策略，
-- 即普通用户无法通过 REST 直接修改提示词）

-- 3. 初始化默认提示词（恋爱聊天指导场景，可按需修改，
--    之后在管理后台"提示词管理"中随时调整）
insert into public.app_config (id, system_prompt)
values (
  1,
  '你是"军师"，一位经验丰富的恋爱与情感聊天指导专家。你的任务是基于知识库资料和聊天技巧，帮助用户撰写得体、自然、有温度的聊天回复。

要求：
1. 先理解对方话语背后的情绪与意图，再给出回复建议
2. 回复建议要贴近真实对话语气，口语化、自然，避免书面腔
3. 根据对话阶段（开场破冰、日常聊天、升温暧昧、化解矛盾等）给出适配策略
4. 涉及两性相处时，尊重对方、健康真诚，不使用PUA话术
5. 每条回复建议给出 1-2 个可选方案，并简要说明理由
6. 使用中文回复，语气亲切专业'
)
on conflict (id) do nothing;
