-- ============================================================
-- 040_console_ladder.sql
-- 军师 - 本地控制台：破层水位（v249）展示 / 参数读写 / 重置
--
-- 背景：v249 把"关系阶段"改成"水位状态机"（蓄水→试探→升层/回稳），
--       状态存在 chat_sessions.memory_card.ladder（JSON，无需改表）。
--       控制台要能看到每个会话当前水位，并能调 4 个参数。
--
-- 幂等：rerun 安全。执行位置：管理 API database/query
-- ============================================================

-- ------------------------------------------------------------
-- 1) 读水位参数（app_config.quota_params 的 4 个键）
-- ------------------------------------------------------------
create or replace function public.console_params_get(p_key text default '')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_qp jsonb := '{}'::jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    select coalesce(public.try_jsonb(quota_params), '{}'::jsonb) into v_qp
      from public.app_config where id = 1;

    return jsonb_build_object(
        'hold_turns', coalesce((v_qp->>'hold_turns')::numeric, 2),
        'probe_cool_turns', coalesce((v_qp->>'probe_cool_turns')::numeric, 2),
        'demote_after', coalesce((v_qp->>'demote_after')::numeric, 4),
        'fast_mode', coalesce((v_qp->>'fast_mode')::numeric, 0)
    );
end;
$$;

-- ------------------------------------------------------------
-- 2) 写水位参数（白名单 4 键，合并保留其它配置）
-- ------------------------------------------------------------
create or replace function public.console_params_set(p_key text default '', p_params jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_in jsonb := coalesce(p_params, '{}'::jsonb);
    v_clean jsonb := '{}'::jsonb;
    v_qp jsonb := '{}'::jsonb;
    v_num numeric;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;

    if v_in ? 'hold_turns' then
        v_num := (v_in->>'hold_turns')::numeric;
        if v_num is null or v_num < 1 or v_num > 6 then
            return jsonb_build_object('error', 'hold_turns 必须为 1~6');
        end if;
        v_clean := v_clean || jsonb_build_object('hold_turns', floor(v_num)::int);
    end if;

    if v_in ? 'probe_cool_turns' then
        v_num := (v_in->>'probe_cool_turns')::numeric;
        if v_num is null or v_num < 1 or v_num > 8 then
            return jsonb_build_object('error', 'probe_cool_turns 必须为 1~8');
        end if;
        v_clean := v_clean || jsonb_build_object('probe_cool_turns', floor(v_num)::int);
    end if;

    if v_in ? 'demote_after' then
        v_num := (v_in->>'demote_after')::numeric;
        if v_num is null or v_num < 2 or v_num > 10 then
            return jsonb_build_object('error', 'demote_after 必须为 2~10');
        end if;
        v_clean := v_clean || jsonb_build_object('demote_after', floor(v_num)::int);
    end if;

    if v_in ? 'fast_mode' then
        v_num := (v_in->>'fast_mode')::numeric;
        if v_num is null or v_num < 0 or v_num > 1 then
            return jsonb_build_object('error', 'fast_mode 必须为 0 或 1');
        end if;
        v_clean := v_clean || jsonb_build_object('fast_mode', floor(v_num)::int);
    end if;

    if v_clean = '{}'::jsonb then
        return jsonb_build_object('error', '没有可写入的参数');
    end if;

    select coalesce(public.try_jsonb(quota_params), '{}'::jsonb) into v_qp
      from public.app_config where id = 1;

    update public.app_config
       set quota_params = (v_qp || v_clean)::text
     where id = 1;

    return public.console_params_get(p_key);
end;
$$;

-- ------------------------------------------------------------
-- 3) 聊天记录：带出每个会话的水位（layer/hold/probe/cool/fails/round/ok/fail）
--    与原 039 版一致，仅新增 ladder_* 字段
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
               public.try_jsonb(s.memory_card) #>> '{ladder,layer}' as ladder_layer,
               public.try_jsonb(s.memory_card) #>> '{ladder,hold}' as ladder_hold,
               public.try_jsonb(s.memory_card) #>> '{ladder,probe}' as ladder_probe,
               public.try_jsonb(s.memory_card) #>> '{ladder,cool}' as ladder_cool,
               public.try_jsonb(s.memory_card) #>> '{ladder,fails}' as ladder_fails,
               public.try_jsonb(s.memory_card) #>> '{ladder,round}' as ladder_round,
               public.try_jsonb(s.memory_card) #>> '{ladder,ok}' as ladder_ok,
               public.try_jsonb(s.memory_card) #>> '{ladder,fail}' as ladder_fail,
               public.try_jsonb(s.memory_card) #>> '{ladder,stage_at}' as ladder_stage_at,
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
-- 4) 重置某会话水位到吸引层（调参/重跑剧本用）
-- ------------------------------------------------------------
create or replace function public.console_ladder_reset(p_key text default '', p_session_id uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    v_uid uuid := public._console_uid(p_key);
    v_card jsonb;
    v_profile jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'invalid_key');
    end if;
    if p_session_id is null then
        return jsonb_build_object('error', 'missing_session_id');
    end if;

    select public.try_jsonb(memory_card) into v_card
      from public.chat_sessions
     where id = p_session_id and user_id = v_uid
     limit 1;

    if v_card is null then
        return jsonb_build_object('error', 'session_not_found');
    end if;

    v_profile := coalesce(v_card->'profile', '{}'::jsonb) || jsonb_build_object('stage', '吸引');
    v_profile := v_profile - 'stage_source';

    update public.chat_sessions
       set memory_card = (
             v_card
             || jsonb_build_object('profile', v_profile)
             || jsonb_build_object('ladder', jsonb_build_object(
                    'layer', 1, 'hold', 0, 'probe', 0, 'cool', 0,
                    'fails', 0, 'round', 0, 'ok', 0, 'fail', 0, 'last', 0))
           )::text
     where id = p_session_id and user_id = v_uid;

    return jsonb_build_object('ok', true, 'layer', 1);
end;
$$;

-- ------------------------------------------------------------
-- 权限
-- ------------------------------------------------------------
revoke execute on function public.console_params_get(text) from public;
revoke execute on function public.console_params_set(text, jsonb) from public;
revoke execute on function public.console_chat_sessions(text, text, integer) from public;
revoke execute on function public.console_ladder_reset(text, uuid) from public;

grant execute on function public.console_params_get(text) to anon, authenticated, service_role;
grant execute on function public.console_params_set(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.console_chat_sessions(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.console_ladder_reset(text, uuid) to anon, authenticated, service_role;
