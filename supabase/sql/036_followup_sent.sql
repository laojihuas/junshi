-- ============================================================
-- 036_followup_sent.sql
-- 军师 - 追加发话 v243：发送回执 + 退出清空排队任务
--
-- 用户要求：
--   ① 主线这一轮确认"没有可回复的消息"时才介入补话（门控在函数里，main_idle）
--   ② 补话不预设策略，接着当前上下文继续聊（函数内 prompt）
--   ③ 脚本退出后停止补话，并自动清空"补话排队任务"
--
-- 本文件提供：
--   1) chat_messages.followup_sent boolean
--        null = 已生成待确认（默认）
--        true = 脚本回执"已发出"（action='sent'）
--        行被 action='fail' 删除 = 发送失败
--      30 分钟没有回执 → 视为失败，自动清理（不占当日次数、不污染上下文）
--   2) RPC followup_purge_unsent(user, older_than_minutes)
--        删除该账号所有"已生成未确认"的 followup 消息，并复位对应会话 followup_at
--        p_older_than_minutes=0 → 全清（脚本退出 action='stop' 时用）
--        30 → 只清 30 分钟前的僵尸（每轮扫描顺手打扫）
--
-- 幂等：rerun 安全。执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

alter table public.chat_messages
  add column if not exists followup_sent boolean;

comment on column public.chat_messages.followup_sent is
  '补发发送回执：null=已生成待确认，true=脚本确认已发出；行不存在=发送失败已撤回';

create index if not exists idx_cm_fu_unsent
  on public.chat_messages(session_id, created_at desc)
  where kind = 'followup' and followup_sent is null;

create or replace function public.followup_purge_unsent(
  p_user_id uuid,
  p_older_than_minutes integer default 0
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  with del as (
    delete from public.chat_messages m
    using public.chat_sessions s
    where m.session_id = s.id
      and s.user_id = p_user_id
      and m.kind = 'followup'
      and m.followup_sent is not true
      and (
        p_older_than_minutes <= 0
        or m.created_at < now() - make_interval(mins => p_older_than_minutes)
      )
    returning m.session_id
  )
  select count(*)::int into n from del;

  if n > 0 then
    -- 这些会话若已没有待确认的补发，followup_at 复位（避免前端/排障误判"刚补过"）
    update public.chat_sessions s
    set followup_at = null
    where s.user_id = p_user_id
      and s.followup_at is not null
      and not exists (
        select 1 from public.chat_messages m
        where m.session_id = s.id and m.kind = 'followup'
      );
  end if;

  return n;
end;
$$;

revoke execute on function public.followup_purge_unsent(uuid, integer) from public, anon, authenticated;
grant execute on function public.followup_purge_unsent(uuid, integer) to service_role;

-- 自检
--   select public.followup_purge_unsent('<profiles.id>'::uuid, 30);
--   select count(*) from public.chat_messages where kind='followup' and followup_sent is null;
