-- ============================================================
-- 028_date_mode.sql
-- 军师 - 账号级约会方向开关（v217）
--
-- 背景：用户要求"我的简介"增加约会按钮：
--   开（date_mode=true）：所有话题默认自然往见面/约会发展（不硬转，借话头顺势带）
--   关（date_mode=false，默认）：约会话题可聊但点到为止，不发起真实邀约
--   该开关为账号级（profiles 表），对话时由 ima-proxy 读取注入【约会方向】块。
--   游客（匿名）同样可用：ensure_profile 已为其建行，RPC 放行 anon。
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

-- 1) 账号级约会方向开关（默认关闭；存量行为 NULL 视为关闭）
alter table public.profiles
  add column if not exists date_mode boolean not null default false;

-- 2) 查询/设置开关（仿 wake_mgmt：SECURITY DEFINER，authenticated+anon 可调）
--    p_enabled = null（缺省）：仅查询当前状态
--    p_enabled = true/false：设置后返回新状态
create or replace function public.date_mode_mgmt(p_enabled boolean default null)
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
    insert into public.profiles (id, date_mode)
    values (v_uid, p_enabled)
    on conflict (id)
    do update set date_mode = excluded.date_mode;
  end if;

  return coalesce((select date_mode from public.profiles where id = v_uid), false);
end;
$$;

revoke execute on function public.date_mode_mgmt(boolean) from public;
grant execute on function public.date_mode_mgmt(boolean) to authenticated, anon;
