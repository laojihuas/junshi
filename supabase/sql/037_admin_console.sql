-- ============================================================
-- 037_admin_console.sql
-- 军师 - 本地控制台改版（v244）
--
-- 1) 彻底撤除 22h 唤醒（v210/v216）残留：
--    - app_config.quota_params 里的 wake_* 四个键
--    - wake_mgmt RPC
--    - profiles.wake_enabled / chat_sessions.last_wake_at 两个已无引用的列
-- 2) 新增后台查询接口：
--    - admin_followup_status()   补话开关卡片：账号开关 / 脚本在线 / 心跳 / 今日发送 / 最近 8 条
--    - admin_chat_sessions(q,lim) 聊天昵称记录查询（昵称/备注/阶段/消息数/补话数/最后一条）
--    - admin_llm_daily(days)     逐日 token 消耗（输入/输出/缓存/费用），支持 7/14/30/90 天
--
-- 幂等：rerun 安全。执行位置：管理 API database/query
-- ============================================================

-- ------------------------------------------------------------
-- 1) 撤除唤醒残留
-- ------------------------------------------------------------
update public.app_config
   set quota_params = (coalesce(nullif(btrim(quota_params), ''), '{}')::jsonb
                       - 'wake_enabled' - 'wake_hours' - 'wake_start_hour' - 'wake_end_hour')::text
 where id = 1;

drop function if exists public.wake_mgmt(boolean);

-- 列上已无任何代码/函数引用（ima-proxy 的 mode=wake 退役分支同步删除）
alter table public.profiles drop column if exists wake_enabled;
alter table public.chat_sessions drop column if exists last_wake_at;

-- ------------------------------------------------------------
-- 2) 安全 JSON 解析（memory_card 是 text 列，脏数据不炸查询）
-- ------------------------------------------------------------
create or replace function public.try_jsonb(p text)
returns jsonb
language plpgsql
immutable
as $$
begin
    if p is null or btrim(p) = '' then
        return null;
    end if;
    return p::jsonb;
exception when others then
    return null;
end;
$$;

-- ------------------------------------------------------------
-- 3) 补话状态（控制台顶部开关卡片）
-- ------------------------------------------------------------
create or replace function public.admin_followup_status()
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_admin boolean;
    v_uid uuid := auth.uid();
    v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_recent jsonb;
begin
    select is_admin into v_admin from public.profiles where id = v_uid;
    if not coalesce(v_admin, false) then
        return jsonb_build_object('error', 'forbidden');
    end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_recent
    from (
        select m.id,
               m.session_id,
               coalesce(nullif(s.note, ''), s.friend_name, '') as friend_name,
               left(m.content, 60) as content,
               m.followup_sent,
               m.created_at
        from public.chat_messages m
        left join public.chat_sessions s on s.id = m.session_id
        where m.kind = 'followup' and m.created_at >= v_today
        order by m.created_at desc
        limit 8
    ) t;

    return jsonb_build_object(
        'enabled', coalesce((select followup_enabled from public.profiles where id = v_uid), true),
        'online', (select followup_online from public.profiles where id = v_uid),
        'heartbeat_at', (select followup_heartbeat_at from public.profiles where id = v_uid),
        'today_generated', (select count(*) from public.chat_messages
                             where kind = 'followup' and created_at >= v_today),
        'today_sent', (select count(*) from public.chat_messages
                        where kind = 'followup' and followup_sent is true and created_at >= v_today),
        'unsent', (select count(*) from public.chat_messages
                    where kind = 'followup' and followup_sent is null and created_at >= v_today),
        'recent', v_recent
    );
end;
$$;

-- ------------------------------------------------------------
-- 4) 聊天昵称记录查询
--    p_q 为空 = 列出最近会话；非空 = 匹配昵称/备注/聊天内容
-- ------------------------------------------------------------
create or replace function public.admin_chat_sessions(p_q text default '', p_limit integer default 100)
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_admin boolean;
    v_q text := btrim(coalesce(p_q, ''));
    v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
    v_out jsonb;
begin
    select is_admin into v_admin from public.profiles where id = auth.uid();
    if not coalesce(v_admin, false) then
        return jsonb_build_object('error', 'forbidden');
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
               s.created_at,
               coalesce(nullif(p.nickname, ''), '') as owner
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
        left join public.profiles p on p.id = s.user_id
        where v_q = ''
           or s.friend_name ilike '%' || v_q || '%'
           or s.note ilike '%' || v_q || '%'
           or exists (
                select 1 from public.chat_messages cm
                where cm.session_id = s.id and cm.content ilike '%' || v_q || '%'
              )
        order by m.last_at desc nulls last
        limit v_limit
    ) t;

    return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- ------------------------------------------------------------
-- 5) 逐日 token 消耗（默认 14 天，范围 1-90）
-- ------------------------------------------------------------
create or replace function public.admin_llm_daily(p_days integer default 14)
returns jsonb
language plpgsql SECURITY DEFINER
set search_path = public
as $$
declare
    v_admin boolean;
    v_days integer := greatest(1, least(coalesce(p_days, 14), 90));
    v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_out jsonb;
begin
    select is_admin into v_admin from public.profiles where id = auth.uid();
    if not coalesce(v_admin, false) then
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
-- 6) 权限：仅 authenticated 可调，函数内自校验 is_admin
-- ------------------------------------------------------------
revoke execute on function public.admin_followup_status() from public, anon;
revoke execute on function public.admin_chat_sessions(text, integer) from public, anon;
revoke execute on function public.admin_llm_daily(integer) from public, anon;

grant execute on function public.admin_followup_status() to authenticated;
grant execute on function public.admin_chat_sessions(text, integer) to authenticated;
grant execute on function public.admin_llm_daily(integer) to authenticated;
