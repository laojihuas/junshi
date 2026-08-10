-- ============================================================
-- 军师 - 后台用户管制 + 幽灵账号清理扩展（v20260810）
--
-- 内容：
--   1. accounts 新增 frozen 字段（冻结标记，默认 false）
--   2. check_and_consume_quota 拦截冻结账号（account_frozen）
--   3. cleanup_ghost_devices 扩展：规则 C（测试账号前缀）+ 规则 D（孤儿账号），
--      真删时同步清理关联数据（chat_messages/chat_sessions/daily_quota/profiles）
--   4. 新增 admin_user_action(p_user_id, p_action)：freeze / unfreeze / delete
--      （SECURITY DEFINER + is_admin 校验；禁止删除管理员账号）
--   5. admin_stats 用户列表新增 uid / frozen 字段（前端操作列用）
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本（幂等）
-- ============================================================

-- ------------------------------------------------------------
-- 1. accounts.frozen 字段
-- ------------------------------------------------------------
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. check_and_consume_quota：冻结账号拦截
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_and_consume_quota(
    p_identity_type text,
    p_identity_key text,
    p_ip text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_day      date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_used     int;
    v_free     int;
    v_ip_limit int := 150;
BEGIN
    -- ============ 游客（device）============
    IF p_identity_type = 'device' THEN
        IF NOT EXISTS (SELECT 1 FROM public.devices WHERE device_id = p_identity_key) THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'device_not_found');
        END IF;
        -- IP 防刷（仅游客；注册用户豁免）
        IF p_ip IS NOT NULL AND p_ip <> '' THEN
            INSERT INTO public.ip_usage (ip, day) VALUES (p_ip, v_day)
            ON CONFLICT (ip, day) DO NOTHING;
            SELECT used_count INTO v_used FROM public.ip_usage WHERE ip = p_ip AND day = v_day FOR UPDATE;
            IF v_used >= v_ip_limit THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'ip_limit');
            END IF;
            UPDATE public.ip_usage SET used_count = used_count + 1 WHERE ip = p_ip AND day = v_day;
        END IF;
        v_free := 20;  -- 游客固定 20 条/天
        INSERT INTO public.daily_quota (identity_type, identity_key, day) VALUES ('device', p_identity_key, v_day)
        ON CONFLICT (identity_type, identity_key, day) DO NOTHING;
        SELECT used_count INTO v_used FROM public.daily_quota
        WHERE identity_type = 'device' AND identity_key = p_identity_key AND day = v_day FOR UPDATE;
        IF v_used < v_free THEN
            UPDATE public.daily_quota SET used_count = used_count + 1
            WHERE identity_type = 'device' AND identity_key = p_identity_key AND day = v_day;
            RETURN jsonb_build_object('allowed', true, 'tier', 'free', 'used', v_used + 1, 'limit', v_free);
        END IF;
        -- 游客用完 → 注册引导（不弹付费墙）
        RETURN jsonb_build_object('allowed', false, 'reason', 'guest_quota_exhausted', 'used', v_used, 'limit', v_free);
    END IF;

    -- ============ 注册用户（account）============
    IF p_identity_type = 'account' THEN
        DECLARE
            v_acc public.accounts%rowtype;
            v_vip_limit int := 500;
        BEGIN
            SELECT * INTO v_acc FROM public.accounts WHERE id = p_identity_key::uuid;
            IF NOT FOUND THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'account_not_found');
            END IF;
            -- [v20260810 冻结拦截] 管理员冻结的账号禁止使用
            IF v_acc.frozen THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'account_frozen');
            END IF;
            -- VIP：500 次/天，豁免 IP 防刷
            IF v_acc.is_vip AND v_acc.vip_expires_at IS NOT NULL AND v_acc.vip_expires_at > now() THEN
                INSERT INTO public.daily_quota (identity_type, identity_key, day) VALUES ('account', p_identity_key, v_day)
                ON CONFLICT (identity_type, identity_key, day) DO NOTHING;
                SELECT used_count INTO v_used FROM public.daily_quota
                WHERE identity_type = 'account' AND identity_key = p_identity_key AND day = v_day FOR UPDATE;
                IF v_used >= v_vip_limit THEN
                    RETURN jsonb_build_object('allowed', false, 'reason', 'vip_daily_limit');
                END IF;
                UPDATE public.daily_quota SET used_count = used_count + 1
                WHERE identity_type = 'account' AND identity_key = p_identity_key AND day = v_day;
                RETURN jsonb_build_object('allowed', true, 'tier', 'vip', 'used', v_used + 1, 'limit', v_vip_limit);
            END IF;
            -- 免费档：前 3 天 50/天，之后 20/天（按账号注册天数）
            v_free := CASE
                WHEN (now() - v_acc.created_at) < interval '3 days' THEN 50
                ELSE 20
            END;
            INSERT INTO public.daily_quota (identity_type, identity_key, day) VALUES ('account', p_identity_key, v_day)
            ON CONFLICT (identity_type, identity_key, day) DO NOTHING;
            SELECT used_count INTO v_used FROM public.daily_quota
            WHERE identity_type = 'account' AND identity_key = p_identity_key AND day = v_day FOR UPDATE;
            IF v_used < v_free THEN
                UPDATE public.daily_quota SET used_count = used_count + 1
                WHERE identity_type = 'account' AND identity_key = p_identity_key AND day = v_day;
                RETURN jsonb_build_object('allowed', true, 'tier', 'free', 'used', v_used + 1, 'limit', v_free, 'bonus', v_acc.invite_bonus);
            END IF;
            -- 免费档用完 → 扣邀请余额（长期余额，不清零）
            IF v_acc.invite_bonus > 0 THEN
                UPDATE public.accounts SET invite_bonus = invite_bonus - 1, updated_at = now() WHERE id = v_acc.id;
                UPDATE public.daily_quota SET used_count = used_count + 1
                WHERE identity_type = 'account' AND identity_key = p_identity_key AND day = v_day;
                RETURN jsonb_build_object('allowed', true, 'tier', 'bonus', 'used', v_used + 1, 'limit', v_free, 'bonus', v_acc.invite_bonus - 1);
            END IF;
            -- 注册用户用完 → 付费墙
            RETURN jsonb_build_object('allowed', false, 'reason', 'quota_exhausted', 'used', v_used, 'limit', v_free);
        END;
    END IF;

    RETURN jsonb_build_object('allowed', false, 'reason', 'bad_identity');
END;
$$;

-- ------------------------------------------------------------
-- 3. cleanup_ghost_devices 扩展（规则 C 测试账号 / 规则 D 孤儿账号）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_ghost_devices(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_admin boolean;
    v_a_ids     text[] := '{}';
    v_b_ids     text[] := '{}';
    v_c_ids     uuid[] := '{}';
    v_d_ids     uuid[] := '{}';
    v_a_count   int;
    v_b_count   int;
    v_c_count   int;
    v_d_count   int;
    v_id        uuid;
BEGIN
    -- 鉴权
    SELECT is_admin INTO v_has_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_has_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    -- 规则 A：设备测试前缀（脚本命名，绝无真人用）
    --   [v20260810] 增补 wb_test（历史注册测试设备）
    SELECT coalesce(array_agg(t.device_id), '{}')
      INTO v_a_ids
      FROM (
        SELECT device_id
          FROM public.devices
         WHERE device_id ~ '^(toktest_|test_|pytest_|debug_|jstest_|wb_test)'
         ORDER BY created_at
      ) t;

    -- 规则 B：fp_ fallback 设备 + 完全无绑定 + 7 天以上未活跃
    SELECT coalesce(array_agg(d.device_id), '{}')
      INTO v_b_ids
      FROM public.devices d
     WHERE d.device_id LIKE 'fp\_%'
       AND d.created_at < now() - interval '7 days'
       AND coalesce(d.invite_code, '') = ''
       AND d.activation_code IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.device_id = d.device_id)
       AND NOT EXISTS (
            SELECT 1 FROM public.daily_quota q
             WHERE q.identity_type = 'device'
               AND q.identity_key  = d.device_id
       );

    -- 规则 C：[v20260810] 测试账号前缀（注册脚本批量账号，绝无真人用）
    --   覆盖：测msl*（历史批量注册）、wb_test*、test_/toktest_/pytest_/debug_/jstest_
    SELECT coalesce(array_agg(t.id), '{}')
      INTO v_c_ids
      FROM (
        SELECT id
          FROM public.accounts
         WHERE account_name ~ '^(测msl|wb_test|test_|toktest_|pytest_|debug_|jstest_)'
         ORDER BY created_at
      ) t;

    -- 规则 D：[v20260810] 孤儿账号：无设备绑定 + 无邀请码 + 无激活码 + 7 天以上 + 无配额/聊天记录
    SELECT coalesce(array_agg(d.id), '{}')
      INTO v_d_ids
      FROM public.accounts d
     WHERE d.device_id IS NULL
       AND coalesce(d.invite_code, '') = ''
       AND d.activation_code IS NULL
       AND d.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.daily_quota q
                        WHERE q.identity_type = 'account' AND q.identity_key = d.id::text)
       AND NOT EXISTS (SELECT 1 FROM public.chat_sessions s WHERE s.user_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.id AND p.is_admin);

    v_a_count := coalesce(array_length(v_a_ids, 1), 0);
    v_b_count := coalesce(array_length(v_b_ids, 1), 0);
    v_c_count := coalesce(array_length(v_c_ids, 1), 0);
    v_d_count := coalesce(array_length(v_d_ids, 1), 0);

    IF NOT p_dry_run THEN
        -- 删除设备行（规则 A/B）
        IF v_a_count > 0 THEN
            DELETE FROM public.devices WHERE device_id = ANY(v_a_ids);
        END IF;
        IF v_b_count > 0 THEN
            DELETE FROM public.devices WHERE device_id = ANY(v_b_ids);
        END IF;
        -- 删除账号（规则 C/D）：级联清理关联数据
        IF v_c_count > 0 OR v_d_count > 0 THEN
            FOR v_id IN SELECT unnest(v_c_ids || v_d_ids) LOOP
                -- 跳过管理员账号（防御）
                IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_id AND p.is_admin) THEN
                    CONTINUE;
                END IF;
                DELETE FROM public.chat_messages WHERE session_id IN
                    (SELECT id FROM public.chat_sessions WHERE user_id = v_id);
                DELETE FROM public.chat_sessions WHERE user_id = v_id;
                DELETE FROM public.daily_quota WHERE identity_type = 'account' AND identity_key = v_id::text;
                DELETE FROM public.profiles WHERE id = v_id;
                DELETE FROM public.accounts WHERE id = v_id;
                BEGIN
                    DELETE FROM auth.users WHERE id = v_id;
                EXCEPTION WHEN OTHERS THEN
                    NULL; -- auth 删除失败（无权限/不存在）不影响业务数据
                END;
            END LOOP;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'dry_run', p_dry_run,
        'rule_a_test_prefix', jsonb_build_object(
            'rule', 'device_id ~ ^(toktest_|test_|pytest_|debug_|jstest_)',
            'count', v_a_count,
            'device_ids', to_jsonb(v_a_ids)
        ),
        'rule_b_fp_island', jsonb_build_object(
            'rule', 'fp_* >7d 孤立设备（无绑定/无 quota）',
            'count', v_b_count,
            'device_ids', to_jsonb(v_b_ids)
        ),
        'rule_c_test_accounts', jsonb_build_object(
            'rule', 'account_name ~ ^(测msl|wb_test|test_|toktest_|pytest_|debug_|jstest_)',
            'count', v_c_count,
            'account_names', to_jsonb(
                (SELECT coalesce(array_agg(account_name), '{}') FROM public.accounts WHERE id = ANY(v_c_ids))
            )
        ),
        'rule_d_account_islands', jsonb_build_object(
            'rule', '账号无绑定/无邀请/无激活/无记录 >7d',
            'count', v_d_count,
            'account_names', to_jsonb(
                (SELECT coalesce(array_agg(account_name), '{}') FROM public.accounts WHERE id = ANY(v_d_ids))
            )
        ),
        'total_removed', CASE WHEN p_dry_run THEN 0 ELSE v_a_count + v_b_count + v_c_count + v_d_count END
    );
END;
$$;

-- ------------------------------------------------------------
-- 4. admin_user_action：用户管制（freeze / unfreeze / delete）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_user_action(p_user_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_admin boolean;
    v_name text;
    v_is_admin boolean;
BEGIN
    -- 鉴权
    SELECT is_admin INTO v_has_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_has_admin, false) THEN
        RETURN jsonb_build_object('success', false, 'message', 'forbidden');
    END IF;
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '缺少用户 id');
    END IF;

    SELECT account_name, coalesce(
        (SELECT is_admin FROM public.profiles WHERE id = p_user_id), false
    ) INTO v_name, v_is_admin
    FROM public.accounts WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '账号不存在');
    END IF;

    -- 禁止冻结/删除管理员账号
    IF v_is_admin THEN
        RETURN jsonb_build_object('success', false, 'message', '不能操作管理员账号');
    END IF;

    -- 冻结 / 解冻
    IF p_action = 'freeze' THEN
        UPDATE public.accounts SET frozen = true, updated_at = now() WHERE id = p_user_id;
        RETURN jsonb_build_object('success', true, 'message', '已冻结 ' || v_name, 'frozen', true);
    END IF;
    IF p_action = 'unfreeze' THEN
        UPDATE public.accounts SET frozen = false, updated_at = now() WHERE id = p_user_id;
        RETURN jsonb_build_object('success', true, 'message', '已解冻 ' || v_name, 'frozen', false);
    END IF;

    -- 删除（级联清理关联数据）
    IF p_action = 'delete' THEN
        DELETE FROM public.chat_messages WHERE session_id IN
            (SELECT id FROM public.chat_sessions WHERE user_id = p_user_id);
        DELETE FROM public.chat_sessions WHERE user_id = p_user_id;
        DELETE FROM public.daily_quota WHERE identity_type = 'account' AND identity_key = p_user_id::text;
        DELETE FROM public.profiles WHERE id = p_user_id;
        DELETE FROM public.accounts WHERE id = p_user_id;
        BEGIN
            DELETE FROM auth.users WHERE id = p_user_id;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
        RETURN jsonb_build_object('success', true, 'message', '已删除 ' || v_name);
    END IF;

    RETURN jsonb_build_object('success', false, 'message', '未知操作: ' || p_action);
END;
$$;

-- ------------------------------------------------------------
-- 5. admin_stats：用户列表新增 uid / frozen（前端操作列用）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin boolean;
    v_users int;
    v_vip int;
    v_today_calls int;
    v_total_calls int;
    v_codes_used int;
    v_codes_total int;
    v_msg_assistant int;
    v_list jsonb;
    v_day date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
    -- 鉴权：当前登录用户必须是 is_admin
    SELECT is_admin INTO v_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    SELECT count(*) INTO v_users FROM public.devices;
    SELECT count(*) INTO v_vip FROM public.devices WHERE is_vip AND coalesce(vip_expires_at, now()) >= now();
    SELECT coalesce(sum(used_count), 0) INTO v_today_calls FROM public.daily_quota WHERE day = v_day;
    SELECT coalesce(sum(used_count), 0) INTO v_total_calls FROM public.daily_quota;
    SELECT count(*) FILTER (WHERE used) INTO v_codes_used FROM public.activation_codes;
    SELECT count(*) INTO v_codes_total FROM public.activation_codes;
    SELECT count(*) INTO v_msg_assistant FROM public.chat_messages WHERE role = 'assistant';

    -- 用户列表 = 注册账号（优先展示）+ 游客设备（无账号绑定）
    -- [v20260810] 新增 uid（账号 id，操作列用）+ frozen（冻结标记）
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_list
    FROM (
        SELECT a.id AS uid, a.account_name AS device_id, a.created_at, a.is_vip, a.vip_expires_at, a.invite_bonus,
               coalesce(a.frozen, false) AS frozen,
               coalesce(dq.used_count, 0) AS today_calls,
               (SELECT coalesce(sum(used_count), 0) FROM public.daily_quota x
                WHERE x.identity_type = 'account' AND x.identity_key = a.id::text) AS total_calls,
               true AS is_account
        FROM public.accounts a
        LEFT JOIN public.daily_quota dq ON dq.identity_type = 'account' AND dq.identity_key = a.id::text AND dq.day = v_day
        UNION ALL
        SELECT NULL::uuid AS uid, d.device_id, d.created_at, d.is_vip, d.vip_expires_at, d.invite_bonus,
               false AS frozen,
               coalesce(dq.used_count, 0) AS today_calls,
               (SELECT coalesce(sum(used_count), 0) FROM public.daily_quota x
                WHERE x.identity_type = 'device' AND x.identity_key = d.device_id) AS total_calls,
               false AS is_account
        FROM public.devices d
        LEFT JOIN public.daily_quota dq ON dq.identity_type = 'device' AND dq.identity_key = d.device_id AND dq.day = v_day
        LEFT JOIN public.accounts a2 ON a2.device_id = d.device_id
        WHERE a2.id IS NULL  -- 已注册账号的设备行不再单列（避免重复计数）
    ) t;

    RETURN jsonb_build_object(
        'user_count', v_users,
        'vip_count', v_vip,
        'today_calls', v_today_calls,
        'total_calls', v_total_calls,
        'msg_assistant', v_msg_assistant,
        'codes_used', v_codes_used,
        'codes_total', v_codes_total,
        'users', v_list
    );
END;
$$;

-- ------------------------------------------------------------
-- 授权（新函数/重定义函数）
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.cleanup_ghost_devices(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_user_action(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;
