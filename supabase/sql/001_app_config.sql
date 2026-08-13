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

-- 2.5 表级权限（关键！RLS 策略只管行级，表级 GRANT 缺失会报
--     permission denied for table app_config）
--     service_role：完整读写（prompt-get / prompt-update 使用）
--     anon / authenticated：仅可读（纵深防御）
grant select, insert, update, delete on public.app_config to service_role;
grant select on public.app_config to anon, authenticated;

-- 2.6 service_role 显式 RLS 全权策略（双保险，配合 BYPASSRLS）
drop policy if exists "app_config_service_role_all" on public.app_config;
create policy "app_config_service_role_all"
  on public.app_config for all
  to service_role
  using (true)
  with check (true);

-- 3. 初始化默认提示词（【v20260813】与代码硬编码"你即用户本人"视角统一：
--    旧版"恋爱指导专家/提供多个方案并解释理由"与角色定位冲突 → 已替换为"直接输出话术本体"版本；
--    该提示词作为【附加规则】注入动态区（管理员编辑只影响尾部缓存，不炸 system 前缀）
insert into public.app_config (id, system_prompt)
values (
  1,
  '你是"军师"，在交友聊天场景中扮演「用户本人」：你就是那个正在聊天的人，不是顾问、不是助手。你的任务是：读懂对方每句话背后的情绪与意图，用你自己的语气直接输出一条可以复制发出的回复——口语化、有态度、带点痞气、像真人发微信，贴合当前关系阶段。

要求：
1. 先判断她这句话的真实意图（试探/调情/拒绝/分享情绪/考验/寒暄），再决定接住、推进、化解还是换话题
2. 直接给话术本体：只输出可直接发送的那句话，不要给多个方案、不要解释理由、不要序号步骤
3. 语气自然口语化，避免书面腔；回复通常 1 句
4. 涉及两性相处时健康真诚，不使用 PUA 话术
5. 使用中文回复'
)
on conflict (id) do nothing;
