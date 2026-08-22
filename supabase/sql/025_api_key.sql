-- ============================================================
-- 025_api_key.sql
-- 军师 - 直连 API Key（v209 直连 API）
--
-- 用途：Shizuku 脚本免登录直连 ima-proxy 的令牌。
--   脚本无前端 JWT（浏览器沙箱拿不到），改持一把"API Key"：
--   ima-proxy 用 api_key 映射到 profiles.id（账号身份）→ 走账号配额，
--   后续 DB 读写由服务端 service_role 完成（绕过 RLS）。
--   API Key 等同账号的长期凭证：只存一份、可重新生成（旧 key 立即失效）。
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

alter table public.profiles
  add column if not exists api_key varchar(64) not null default '';

-- 获取或生成 API Key
--   p_regenerate = false（默认）：已有 key 则返回原值（不覆盖）；没有则生成
--   p_regenerate = true：强制生成新 key（旧 key 立即失效，用于泄露后重置）
-- 仅 authenticated（注册用户）可调；游客无账号体系，不提供直连
create or replace function public.api_key_mgmt(p_regenerate boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select api_key into v_key from public.profiles where id = v_uid;

  if p_regenerate or v_key is null or v_key = '' then
    v_key := 'jk_' || encode(gen_random_bytes(24), 'hex');
    insert into public.profiles (id, api_key)
    values (v_uid, v_key)
    on conflict (id)
    do update set api_key = excluded.api_key;
  end if;

  return v_key;
end;
$$;

revoke execute on function public.api_key_mgmt(boolean) from public, anon;
grant execute on function public.api_key_mgmt(boolean) to authenticated;
