-- ============================================================
-- 027_wake_enabled.sql
-- 军师 - 账号级唤醒开关（v216，直连唤醒 v210 的补充）
--
-- 背景：v210 唤醒是全局开关（app_config.quota_params.wake_enabled，后台可调）。
--   用户要求每个账号可自选是否参与唤醒（"在 API Key 旁边加启用唤醒按钮，默认关闭"）。
--   两个开关是 AND 关系：全局开 + 账号开 → 该账号的会话才会被唤醒。
--   只影响直连唤醒（mode=wake），正常聊天不受影响。
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

-- 1) 账号级唤醒开关（默认关闭；存量行为 NULL 视为关闭）
alter table public.profiles
  add column if not exists wake_enabled boolean not null default false;

-- 2) 查询/设置开关（仿 api_key_mgmt：SECURITY DEFINER，authenticated 可调）
--    p_enabled = null（缺省）：仅查询当前状态
--    p_enabled = true/false：设置后返回新状态
create or replace function public.wake_mgmt(p_enabled boolean default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  if p_enabled is not null then
    insert into public.profiles (id, wake_enabled)
    values (v_uid, p_enabled)
    on conflict (id)
    do update set wake_enabled = excluded.wake_enabled;
  end if;

  return coalesce((select wake_enabled from public.profiles where id = v_uid), false);
end;
$$;

revoke execute on function public.wake_mgmt(boolean) from public, anon;
grant execute on function public.wake_mgmt(boolean) to authenticated;
