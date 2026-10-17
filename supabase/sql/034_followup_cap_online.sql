-- ============================================================
-- 034_followup_cap_online.sql
-- 军师 - 追加发话 v241：日上限改为「每会话 3 次」+ 脚本在线开关
--
-- 用户拍板的三处调整：
--   ① 日上限从「账号总量 5 次」改为「每个会话每天最多补 3 次」
--      （同一会话要补满 3 次，必须她回过 3 次 → 每次沉默期仍只补 1 条）
--   ② 手机脚本退出后不许再补：新增 profiles.followup_online，
--      脚本退出时调 action=stop 置 false → 之后任何调用都不再生成
--      （没有服务端 cron，脚本不调本来就没人触发；本标记是防「退出后残留定时器」）
--   ③ 心跳记录 followup_heartbeat_at：只做观测/排查，不参与拦截
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

-- 1) 脚本在线标记（null=未设置，按在线处理，兼容老脚本；false=脚本已 stop）
alter table public.profiles
  add column if not exists followup_online boolean;

-- 2) 脚本心跳（每次轮询刷新，仅观测用）
alter table public.profiles
  add column if not exists followup_heartbeat_at timestamptz;

-- 3) 配置：新增每会话上限（默认 3），删掉账号级 daily_cap
update public.app_config
set quota_params = (
  (coalesce(quota_params::jsonb, '{}'::jsonb) - 'followup_daily_cap')
  || '{"followup_session_cap": 3, "followup_scan_limit": 3}'::jsonb
)::text,
    updated_at = now()
where id = 1;

-- 4) 候选会话：加「该会话今日 followup 条数 < 每会话上限」过滤
--    旧三参版本先删，避免重载歧义
drop function if exists public.followup_candidates(uuid, integer, integer);

create or replace function public.followup_candidates(
  p_user_id uuid,
  p_min_minutes integer default 5,
  p_max_minutes integer default 60,
  p_session_cap integer default 3
)
returns table (
  session_id uuid,
  friend_name text,
  memory_card text,
  last_at timestamptz,
  waited_min integer,
  used_today integer
)
language sql
security definer
set search_path = public
as $$
  with last_msg as (
    select distinct on (m.session_id) m.session_id, m.role, m.kind, m.created_at
    from public.chat_messages m
    join public.chat_sessions s on s.id = m.session_id
    where s.user_id = p_user_id
    order by m.session_id, m.created_at desc
  ),
  today_fu as (
    select m.session_id, count(*)::int as n
    from public.chat_messages m
    join public.chat_sessions s on s.id = m.session_id
    where s.user_id = p_user_id
      and m.kind = 'followup'
      -- 北京时间自然日 00:00 起算
      and m.created_at >= (((now() at time zone 'Asia/Shanghai')::date)::timestamp at time zone 'Asia/Shanghai')
    group by m.session_id
  )
  select s.id, s.friend_name, s.memory_card, lm.created_at,
         floor(extract(epoch from (now() - lm.created_at)) / 60)::int,
         coalesce(t.n, 0)
  from public.chat_sessions s
  join last_msg lm on lm.session_id = s.id
  left join today_fu t on t.session_id = s.id
  where s.user_id = p_user_id
    and lm.role = 'assistant'
    and lm.kind <> 'followup'
    and coalesce(t.n, 0) < greatest(p_session_cap, 1)
    and lm.created_at <= now() - make_interval(mins => greatest(p_min_minutes, 1))
    and lm.created_at >= now() - make_interval(mins => greatest(p_max_minutes, 1))
  order by lm.created_at asc
  limit 50;
$$;

revoke execute on function public.followup_candidates(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.followup_candidates(uuid, integer, integer, integer) to service_role;

-- 5) 自检
--   select quota_params::jsonb from public.app_config where id=1;
--   select count(*) from public.followup_candidates('<profiles.id>'::uuid, 5, 60, 3);
--   select id, followup_enabled, followup_online, followup_heartbeat_at from public.profiles where api_key <> '';
