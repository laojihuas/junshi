-- ============================================================
-- 035_followup_targets.sql
-- 军师 - 追加发话 v242：两阶段协议（先给目标 → 打开聊天页 → 再生成）
--
-- 起因（线上实测 bug）：v241 在「轮询」时就调 LLM 生成并落库 kind='followup'，
--   但手机脚本没把消息发出去 → 库里 18 条「补发」、微信里 0 条，
--   token 白花，且这些假消息还会污染直连上下文（AI 以为自己真说过）。
--
-- v242 协议：
--   ① 轮询（不带 session_id）→ 只回 targets[]，不生成、不落库、不计数
--   ② 脚本打开该好友聊天页成功 → 带 session_id 再来 → 此刻才生成 + 落库
--   ③ 发送失败 → action='fail' → 撤回刚生成那条（删除），不计入当日次数
--
-- 本文件：
--   1) 新增 RPC followup_targets —— 在 034 的 followup_candidates 基础上
--      · 多返回 note（微信备注，脚本优先用它搜索会话）
--      · 支持 p_session_id 只查单个会话（生成阶段的资格复核）
--   2) 保留旧 followup_candidates（不删，防旧函数调用 400；代码已改用新函数）
--
-- 幂等：rerun 安全。执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

create or replace function public.followup_targets(
  p_user_id uuid,
  p_min_minutes integer default 5,
  p_max_minutes integer default 60,
  p_session_cap integer default 3,
  p_session_id uuid default null
)
returns table (
  session_id uuid,
  friend_name text,
  note text,
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
  select s.id, s.friend_name, s.note, s.memory_card, lm.created_at,
         floor(extract(epoch from (now() - lm.created_at)) / 60)::int,
         coalesce(t.n, 0)
  from public.chat_sessions s
  join last_msg lm on lm.session_id = s.id
  left join today_fu t on t.session_id = s.id
  where s.user_id = p_user_id
    and (p_session_id is null or s.id = p_session_id)
    and lm.role = 'assistant'
    and lm.kind <> 'followup'
    and coalesce(t.n, 0) < greatest(p_session_cap, 1)
    and lm.created_at <= now() - make_interval(mins => greatest(p_min_minutes, 1))
    and lm.created_at >= now() - make_interval(mins => greatest(p_max_minutes, 1))
  order by lm.created_at asc
  limit 50;
$$;

revoke execute on function public.followup_targets(uuid, integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.followup_targets(uuid, integer, integer, integer, uuid) to service_role;

-- 自检
--   select count(*) from public.followup_targets('<profiles.id>'::uuid, 5, 60, 3, null);
--   select * from public.followup_targets('<profiles.id>'::uuid, 5, 60, 3, '<session_id>'::uuid);
