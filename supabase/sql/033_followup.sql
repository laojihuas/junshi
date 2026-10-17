-- ============================================================
-- 033_followup.sql
-- 军师 - 追加发话（v240，只服务手机直连）
--
-- 需求（用户拍板）：
--   发出话术后 5 分钟没回复 → 主动补发一条；她再不回就不再发（同一次沉默只补一条）。
--   账号一天最多触发 5 次。补发不许掉价，只走三种形态（自说自话/给台阶/半句钩子）。
--   网页版不参与；v210 的 22h 沉默唤醒正式下线。
--
-- 设计要点：不新增状态机，用消息自身的 kind 标记做幂等
--   → 补发消息落库 kind='followup' → 下一轮判定"最后一条已是 followup"直接跳过，
--     重复轮询天然不会重复发。
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

-- 1) 消息来源标记：'reply'（正常对话/脚本生成）| 'followup'（本机制的补发）
alter table public.chat_messages
  add column if not exists kind text not null default 'reply';

comment on column public.chat_messages.kind is '消息来源：reply=正常对话 followup=追加发话（v240）';

-- 2) 最后一条消息查询加速（每轮判定按 session 取最新 1 条）
create index if not exists idx_chat_messages_sess_time
  on public.chat_messages (session_id, created_at desc);

-- 3) 会话级补发时间戳（后台统计/"最近补发"展示用；防重不依赖它）
alter table public.chat_sessions
  add column if not exists followup_at timestamptz;

-- 4) 账号级开关（默认开：手机直连就是要这个功能，想关再关）
alter table public.profiles
  add column if not exists followup_enabled boolean not null default true;

-- 5) 配置并入 quota_params（后台"配额参数"卡可见可调）
--    与 021/022/026 同款 jsonb 合并写法：已有 key 保留，缺省补默认
update public.app_config
set quota_params = (
  coalesce(quota_params::jsonb, '{}'::jsonb)
  || '{
        "followup_enabled": 1,
        "followup_minutes": 5,
        "followup_max_minutes": 60,
        "followup_daily_cap": 5,
        "followup_start_hour": 9,
        "followup_end_hour": 23,
        "followup_scan_limit": 10
      }'::jsonb
)::text,
    updated_at = now()
where id = 1;

-- 6) [v240 下线] 22h 沉默唤醒关掉：脚本即使还在调 mode=wake 也拿不到名单（函数侧返回 200 空）
--    保留 wake_* key 本身（prompt-update 白名单里还在，删 key 会让后台保存配额参数报错）
update public.app_config
set quota_params = jsonb_set(coalesce(quota_params::jsonb, '{}'::jsonb), '{wake_enabled}', '0'::jsonb)::text,
    updated_at = now()
where id = 1;

-- 6c) 候选会话（一次查询出"该补发"的名单，替代逐会话 N 次 REST 请求）
--     判定全在 SQL：最后一条是我发的、kind 不是 followup、距今在 [min,max] 分钟内
--     stage 过滤仍交给函数侧（memory_card 是 text 列，解析放 JS 更省事）
create or replace function public.followup_candidates(
  p_user_id uuid, p_min_minutes integer default 5, p_max_minutes integer default 60
)
returns table (
  session_id uuid,
  friend_name text,
  memory_card text,
  last_at timestamptz,
  waited_min integer
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
  )
  select s.id, s.friend_name, s.memory_card, lm.created_at,
         floor(extract(epoch from (now() - lm.created_at)) / 60)::int
  from public.chat_sessions s
  join last_msg lm on lm.session_id = s.id
  where s.user_id = p_user_id
    and lm.role = 'assistant'
    and lm.kind <> 'followup'
    and lm.created_at <= now() - make_interval(mins => greatest(p_min_minutes, 1))
    and lm.created_at >= now() - make_interval(mins => greatest(p_max_minutes, 1))
  order by lm.created_at asc
  limit 50;
$$;

revoke execute on function public.followup_candidates(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.followup_candidates(uuid, integer, integer) to service_role;

-- 7) 账号当天已补发次数（北京时间自然日）
--    SECURITY DEFINER + 只授 service_role：跨会话统计，普通用户不可调
create or replace function public.followup_daily_count(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int
  from public.chat_messages m
  join public.chat_sessions s on s.id = m.session_id
  where s.user_id = p_user_id
    and m.kind = 'followup'
    -- 北京时间当天 00:00 → 转回 timestamptz
    and m.created_at >= (((now() at time zone 'Asia/Shanghai')::date)::timestamp at time zone 'Asia/Shanghai');
$$;

revoke execute on function public.followup_daily_count(uuid) from public, anon, authenticated;
grant execute on function public.followup_daily_count(uuid) to service_role;

-- 7b) 账号级开关读写（前端"启用追加发话"按钮调用；仿 wake_mgmt）
--     p_enabled = null（缺省）：仅查询当前状态
--     p_enabled = true/false：设置后返回新状态
create or replace function public.followup_mgmt(p_enabled boolean default null)
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
    insert into public.profiles (id, followup_enabled)
    values (v_uid, p_enabled)
    on conflict (id)
    do update set followup_enabled = excluded.followup_enabled;
  end if;

  -- 缺省视为开（与列默认值一致）
  return coalesce((select followup_enabled from public.profiles where id = v_uid), true);
end;
$$;

revoke execute on function public.followup_mgmt(boolean) from public, anon;
grant execute on function public.followup_mgmt(boolean) to authenticated;

-- 8) 自检
--   select kind, count(*) from public.chat_messages group by kind;
--   select quota_params::jsonb from public.app_config where id = 1;
--   select public.followup_daily_count('<profiles.id>');
