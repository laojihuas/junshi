-- ============================================================
-- 038_local_console_self.sql
-- 军师 - 本地控制台（file:///C:/Users/Administrator/Documents/军师控制台.html）专属接口
--
-- 背景：037 的三个 admin_* 接口要求 profiles.is_admin = true，
--       而实际自用账号 laojihua 是 accounts.unlimited = true、is_admin = false，
--       所以本地控制台（以 laojihua 登录）调 admin_* 会返回 forbidden。
--       这里补三个"按当前登录账号自我 scoped"的接口，不依赖 is_admin：
--         my_followup_status()          本人补话状态（开关 / 脚本在线 / 心跳 / 今日已发·待确认 / 最近 8 条）
--         my_chat_sessions(q, limit)    本人会话查询（昵称 / 备注 / 阶段 / 消息数 / 补话数 / 最后一条）
--         my_llm_daily(days)            逐日 token 消耗（全局成本，限 is_admin 或 unlimited 账号）
--
-- 幂等：rerun 安全。执行位置：管理 API database/query
-- ============================================================

-- ------------------------------------------------------------
-- 1) 补话状态（本人）
-- ------------------------------------------------------------
create or replace function public.my_followup_status()
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_recent jsonb;
    v_cap integer := 3;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'unauthorized');
    end if;

    select coalesce((public.try_jsonb(quota_params) ->> 'followup_session_cap')::int, 3)
      into v_cap
      from public.app_config where id = 1;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_recent
    from (
        select m.id,
               m.session_id,
               coalesce(nullif(s.note, ''), s.friend_name, '') as friend_name,
               left(m.content, 60) as content,
               m.followup_sent,
               m.created_at
        from public.chat_messages m
        join public.chat_sessions s on s.id = m.session_id
        where s.user_id = v_uid
          and m.kind = 'followup'
          and m.created_at >= v_today
        order by m.created_at desc
        limit 8
    ) t;

    return jsonb_build_object(
        'enabled', coalesce((select followup_enabled from public.profiles where id = v_uid), true),
        'online', (select followup_online from public.profiles where id = v_uid),
        'heartbeat_at', (select followup_heartbeat_at from public.profiles where id = v_uid),
        'today_generated', (
            select count(*) from public.chat_messages m
            join public.chat_sessions s on s.id = m.session_id
            where s.user_id = v_uid and m.kind = 'followup' and m.created_at >= v_today
        ),
        'today_sent', (
            select count(*) from public.chat_messages m
            join public.chat_sessions s on s.id = m.session_id
            where s.user_id = v_uid and m.kind = 'followup'
              and m.followup_sent is true and m.created_at >= v_today
        ),
        'unsent', (
            select count(*) from public.chat_messages m
            join public.chat_sessions s on s.id = m.session_id
            where s.user_id = v_uid and m.kind = 'followup'
              and m.followup_sent is null and m.created_at >= v_today
        ),
        'session_cap', coalesce(v_cap, 3),
        'sessions', (select count(*) from public.chat_sessions where user_id = v_uid),
        'recent', v_recent
    );
end;
$$;

-- ------------------------------------------------------------
-- 2) 本人会话查询（昵称 / 备注 / 阶段 / 消息数 / 补话数 / 最后一条）
-- ------------------------------------------------------------
create or replace function public.my_chat_sessions(p_q text default '', p_limit integer default 100)
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_q text := btrim(coalesce(p_q, ''));
    v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
    v_out jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'unauthorized');
    end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.last_at desc nulls last), '[]'::jsonb) into v_out
    from (
        select s.id as session_id,
               s.friend_name,
               s.note,
               s.avatar_color,
               public.try_jsonb(s.memory_card) #>> '{profile,stage}' as stage,
               coalesce(m.total_msgs, 0) as total_msgs,
               coalesce(m.girl_msgs, 0) as girl_msgs,
               coalesce(m.my_msgs, 0) as my_msgs,
               coalesce(m.followup_msgs, 0) as followup_msgs,
               m.last_at,
               m.last_role,
               left(coalesce(m.last_content, ''), 40) as last_preview,
               s.followup_at,
               s.created_at
        from public.chat_sessions s
        left join lateral (
            select count(*) as total_msgs,
                   count(*) filter (where role = 'user') as girl_msgs,
                   count(*) filter (where role = 'assistant') as my_msgs,
                   count(*) filter (where kind = 'followup') as followup_msgs,
                   max(created_at) as last_at,
                   (array_agg(role order by created_at desc))[1] as last_role,
                   (array_agg(content order by created_at desc))[1] as last_content
            from public.chat_messages c
            where c.session_id = s.id
        ) m on true
        where s.user_id = v_uid
          and (
                v_q = ''
             or s.friend_name ilike '%' || v_q || '%'
             or s.note ilike '%' || v_q || '%'
             or exists (
                  select 1 from public.chat_messages cm
                  where cm.session_id = s.id and cm.content ilike '%' || v_q || '%'
                )
          )
        order by m.last_at desc nulls last
        limit v_limit
    ) t;

    return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- ------------------------------------------------------------
-- 3) 逐日 token 消耗（llm_usage_log 无 user_id，故为全局口径；
--    仅 is_admin 或 unlimited 账号可读，避免普通用户看到成本数据）
-- ------------------------------------------------------------
create or replace function public.my_llm_daily(p_days integer default 14)
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_ok boolean;
    v_days integer := greatest(1, least(coalesce(p_days, 14), 90));
    v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_out jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'unauthorized');
    end if;

    select coalesce((select is_admin from public.profiles where id = v_uid), false)
        or coalesce((select unlimited from public.accounts where id = v_uid), false)
      into v_ok;
    if not coalesce(v_ok, false) then
        return jsonb_build_object('error', 'forbidden');
    end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb) into v_out
    from (
        select d.day,
               coalesce(a.calls, 0) as calls,
               coalesce(a.prompt_tokens, 0) as prompt_tokens,
               coalesce(a.completion_tokens, 0) as completion_tokens,
               coalesce(a.total_tokens, 0) as total_tokens,
               coalesce(a.cache_hit, 0) as cache_hit_tokens,
               coalesce(a.cache_miss, 0) as cache_miss_tokens,
               round(coalesce(a.total_cost, 0)::numeric, 4) as total_cost,
               round(coalesce(a.total_tokens, 0)::numeric / nullif(a.calls, 0), 0) as avg_tokens,
               round(coalesce(a.total_cost, 0)::numeric / nullif(a.calls, 0), 6) as avg_cost,
               round(coalesce(a.hit_rate, 0)::numeric, 4) as cache_hit_rate
        from (
            select ((v_today_start at time zone 'Asia/Shanghai') - (s || ' days')::interval)::date as day
            from generate_series(0, v_days - 1) s
        ) d
        left join (
            select (created_at at time zone 'Asia/Shanghai')::date as day,
                   count(distinct request_id) as calls,
                   sum(prompt_tokens) as prompt_tokens,
                   sum(completion_tokens) as completion_tokens,
                   sum(prompt_tokens + completion_tokens) as total_tokens,
                   sum(cache_hit_tokens) as cache_hit,
                   sum(cache_miss_tokens) as cache_miss,
                   sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                       cache_hit_tokens, cache_miss_tokens, created_at)) as total_cost,
                   (sum(cache_hit_tokens)::numeric
                     / nullif(sum(cache_hit_tokens + cache_miss_tokens), 0)) as hit_rate
            from public.llm_usage_log
            where created_at >= v_today_start - ((v_days - 1) || ' days')::interval
            group by 1
        ) a on a.day = d.day
    ) t;

    return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- ------------------------------------------------------------
-- 4) 权限：仅登录用户可调（函数内用 auth.uid() 自我限定）
-- ------------------------------------------------------------
revoke execute on function public.my_followup_status() from public, anon;
revoke execute on function public.my_chat_sessions(text, integer) from public, anon;
revoke execute on function public.my_llm_daily(integer) from public, anon;

grant execute on function public.my_followup_status() to authenticated;
grant execute on function public.my_chat_sessions(text, integer) to authenticated;
grant execute on function public.my_llm_daily(integer) to authenticated;

-- ------------------------------------------------------------
-- 5) 自检
--   select public.followup_mgmt(null);      -- 需带登录 JWT
--   select public.my_followup_status();
--   select public.my_chat_sessions('', 5);
--   select public.my_llm_daily(7);
-- ------------------------------------------------------------
