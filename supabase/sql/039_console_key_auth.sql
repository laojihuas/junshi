-- ============================================================
-- 039_console_key_auth.sql
-- 军师 - 本地控制台免登录（api_key 直通）
--
-- 需求：本地控制台（file:///C:/Users/Administrator/Documents/军师控制台.html）
--       每次打开都要输账号密码，太烦 → 全部取消。
--
-- 做法：控制台不再登录取 JWT，改为直接带「直连 API Key」调 RPC。
--       api_key 本身就是账号级凭证（手机脚本用的就是它），
--       这里把 038 的三个 my_* 接口 + 两个开关 + key 管理，各做一份 p_key 版本，
--       函数内用 _console_uid(p_key) 反查 profiles.id，再按该 id 限定数据范围。
--       授权给 anon（不带 JWT 也能调），但函数内部必须验出有效 key。
--
-- 幂等：rerun 安全。执行位置：管理 API database/query
-- ============================================================

-- ------------------------------------------------------------
-- 0) key → profiles.id（内部函数，不对外授权）
-- ------------------------------------------------------------
create or replace function public._console_uid(p_key text)
returns uuid
language sql stable security definer
set search_path = public
as $$
    select id from public.profiles
     where coalesce(api_key, '') <> ''
       and api_key = btrim(coalesce(p_key, ''))
     limit 1;
$$;

revoke execute on function public._console_uid(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1) 首屏：一次性拿账号信息 + 补话状态 + 开关
-- ------------------------------------------------------------
create or replace function public.console_bootstrap(p_key text default '')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_recent jsonb;
    v_cap integer := 3;
    v_online boolean;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    select coalesce((public.try_jsonb(quota_params) ->> 'followup_session_cap')::int, 3)
      into v_cap from public.app_config where id = 1;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_recent
    from (
        select m.id, m.session_id,
               coalesce(nullif(s.note, ''), s.friend_name, '') as friend_name,
               left(m.content, 60) as content,
               m.followup_sent, m.created_at
        from public.chat_messages m
        join public.chat_sessions s on s.id = m.session_id
        where s.user_id = v_uid and m.kind = 'followup' and m.created_at >= v_today
        order by m.created_at desc
        limit 8
    ) t;

    return jsonb_build_object(
        'ok', true,
        'account', jsonb_build_object(
            'id', v_uid,
            'account_name', coalesce((select account_name from public.accounts where id = v_uid), ''),
            'unlimited', coalesce((select unlimited from public.accounts where id = v_uid), false),
            'is_vip', coalesce((select is_vip from public.accounts where id = v_uid), false),
            'vip_expires_at', (select vip_expires_at from public.accounts where id = v_uid),
            'api_key', (select api_key from public.profiles where id = v_uid)
        ),
        'followup', jsonb_build_object(
            'enabled', coalesce((select followup_enabled from public.profiles where id = v_uid), true),
            'online', (select followup_online from public.profiles where id = v_uid),
            'heartbeat_at', (select followup_heartbeat_at from public.profiles where id = v_uid),
            'today_generated', (select count(*) from public.chat_messages m
                                 join public.chat_sessions s on s.id = m.session_id
                                 where s.user_id = v_uid and m.kind = 'followup' and m.created_at >= v_today),
            'today_sent', (select count(*) from public.chat_messages m
                            join public.chat_sessions s on s.id = m.session_id
                            where s.user_id = v_uid and m.kind = 'followup'
                              and m.followup_sent is true and m.created_at >= v_today),
            'unsent', (select count(*) from public.chat_messages m
                        join public.chat_sessions s on s.id = m.session_id
                        where s.user_id = v_uid and m.kind = 'followup'
                          and m.followup_sent is null and m.created_at >= v_today),
            'session_cap', coalesce(v_cap, 3),
            'sessions', (select count(*) from public.chat_sessions where user_id = v_uid),
            'recent', v_recent
        ),
        'date_mode', coalesce((select date_mode from public.profiles where id = v_uid), false)
    );
end;
$$;

-- ------------------------------------------------------------
-- 2) 开关（补话 / 约会方向）
-- ------------------------------------------------------------
create or replace function public.console_followup_set(p_key text default '', p_enabled boolean default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    if p_enabled is not null then
        insert into public.profiles (id, followup_enabled)
        values (v_uid, p_enabled)
        on conflict (id) do update set followup_enabled = excluded.followup_enabled;
    end if;

    return jsonb_build_object(
        'ok', true,
        'enabled', coalesce((select followup_enabled from public.profiles where id = v_uid), true)
    );
end;
$$;

create or replace function public.console_date_set(p_key text default '', p_enabled boolean default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    if p_enabled is not null then
        insert into public.profiles (id, date_mode)
        values (v_uid, p_enabled)
        on conflict (id) do update set date_mode = excluded.date_mode;
    end if;

    return jsonb_build_object(
        'ok', true,
        'date_mode', coalesce((select date_mode from public.profiles where id = v_uid), false)
    );
end;
$$;

-- ------------------------------------------------------------
-- 3) 聊天昵称记录
-- ------------------------------------------------------------
create or replace function public.console_chat_sessions(p_key text default '', p_q text default '', p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_q text := btrim(coalesce(p_q, ''));
    v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
    v_out jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.last_at desc nulls last), '[]'::jsonb) into v_out
    from (
        select s.id as session_id, s.friend_name, s.note, s.avatar_color,
               public.try_jsonb(s.memory_card) #>> '{profile,stage}' as stage,
               coalesce(m.total_msgs, 0) as total_msgs,
               coalesce(m.girl_msgs, 0) as girl_msgs,
               coalesce(m.my_msgs, 0) as my_msgs,
               coalesce(m.followup_msgs, 0) as followup_msgs,
               m.last_at, m.last_role,
               left(coalesce(m.last_content, ''), 40) as last_preview,
               s.followup_at, s.created_at
        from public.chat_sessions s
        left join lateral (
            select count(*) as total_msgs,
                   count(*) filter (where role = 'user') as girl_msgs,
                   count(*) filter (where role = 'assistant') as my_msgs,
                   count(*) filter (where kind = 'followup') as followup_msgs,
                   max(created_at) as last_at,
                   (array_agg(role order by created_at desc))[1] as last_role,
                   (array_agg(content order by created_at desc))[1] as last_content
            from public.chat_messages c where c.session_id = s.id
        ) m on true
        where s.user_id = v_uid
          and (
                v_q = ''
             or s.friend_name ilike '%' || v_q || '%'
             or s.note ilike '%' || v_q || '%'
             or exists (select 1 from public.chat_messages cm
                         where cm.session_id = s.id and cm.content ilike '%' || v_q || '%')
          )
        order by m.last_at desc nulls last
        limit v_limit
    ) t;

    return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- ------------------------------------------------------------
-- 4) 逐日 token（llm_usage_log 无 user_id → 全局口径；限 is_admin 或 unlimited）
-- ------------------------------------------------------------
create or replace function public.console_llm_daily(p_key text default '', p_days integer default 14)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_ok boolean;
    v_days integer := greatest(1, least(coalesce(p_days, 14), 90));
    v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
    v_out jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
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
-- 5) key 管理（用旧 key 换新 key；控制台自己记住新 key）
-- ------------------------------------------------------------
create or replace function public.console_key_mgmt(p_key text default '', p_regenerate boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_key text;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    select api_key into v_key from public.profiles where id = v_uid;

    if p_regenerate or v_key is null or v_key = '' then
        v_key := 'jk_' || encode(gen_random_bytes(24), 'hex');
        update public.profiles set api_key = v_key where id = v_uid;
    end if;

    return jsonb_build_object('ok', true, 'api_key', v_key);
end;
$$;

-- ------------------------------------------------------------
-- 6) 权限：anon 可调（函数内验 key）
-- ------------------------------------------------------------
revoke execute on function public.console_bootstrap(text) from public;
revoke execute on function public.console_followup_set(text, boolean) from public;
revoke execute on function public.console_date_set(text, boolean) from public;
revoke execute on function public.console_chat_sessions(text, text, integer) from public;
revoke execute on function public.console_llm_daily(text, integer) from public;
revoke execute on function public.console_key_mgmt(text, boolean) from public;

grant execute on function public.console_bootstrap(text) to anon, authenticated, service_role;
grant execute on function public.console_followup_set(text, boolean) to anon, authenticated, service_role;
grant execute on function public.console_date_set(text, boolean) to anon, authenticated, service_role;
grant execute on function public.console_chat_sessions(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.console_llm_daily(text, integer) to anon, authenticated, service_role;
grant execute on function public.console_key_mgmt(text, boolean) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 7) 自检（在管理 API 里直接跑，不需要 JWT）
--   select public.console_bootstrap('<api_key>');
--   select jsonb_array_length(public.console_chat_sessions('<api_key>', '', 5));
--   select jsonb_array_length(public.console_llm_daily('<api_key>', 7));
--   select public.console_bootstrap('bad_key');   -- 应返回 {"error":"invalid_key"}
-- ------------------------------------------------------------
