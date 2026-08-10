-- ============================================================
-- 军师 - 游客设备管控（v20260810）
--
-- 内容：
--   1. devices 新增 frozen 字段（设备冻结标记）
--   2. check_and_consume_quota 拦截冻结设备（device_frozen）
--   3. admin_user_action 重构：支持 device 类型（冻结/解冻/删除）
--      游客设备删除级联清理其匿名 user 的会话/配额/auth
--   4. 保护：管理员账号或其设备不可冻结/删除
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本（幂等）
-- ============================================================

-- ------------------------------------------------------------
-- 1. devices.frozen 字段
-- ------------------------------------------------------------
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2. check_and_consume_quota：冻结设备拦截（完整重定义）
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
    v_frozen   boolean;
BEGIN
    -- ============ 游客（device）============
    IF p_identity_type = 'device' THEN
        SELECT frozen INTO v_frozen FROM public.devices WHERE device_id = p_identity_key;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'device_not_found');
        END IF;
        -- [v20260810 冻结拦截] 管理员封禁的设备禁止使用
        IF v_frozen THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'device_frozen');
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
-- 3. admin_user_action 重构：支持 account + device 双类型
--    旧签名 (uuid, text) 已废弃，前端改传 (text, text, text)
--    p_type = 'account'（默认，p_target=账号 uuid）| 'device'（p_target=device_id）
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_user_action(uuid, text);
CREATE OR REPLACE FUNCTION public.admin_user_action(p_target text, p_action text, p_type text DEFAULT 'account')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_admin boolean;
    v_name text;
    v_is_admin boolean;
    v_protected boolean;
BEGIN
    -- 鉴权
    SELECT is_admin INTO v_has_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_has_admin, false) THEN
        RETURN jsonb_build_object('success', false, 'message', 'forbidden');
    END IF;
    IF p_target IS NULL OR btrim(p_target) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '缺少目标');
    END IF;

    -- ============ 注册账号 ============
    IF p_type = 'account' THEN
        SELECT a.account_name, coalesce((SELECT is_admin FROM public.profiles WHERE id = a.id), false)
          INTO v_name, v_is_admin
          FROM public.accounts a WHERE a.id = p_target::uuid;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', '账号不存在');
        END IF;
        IF v_is_admin THEN
            RETURN jsonb_build_object('success', false, 'message', '不能操作管理员账号');
        END IF;
        IF p_action = 'freeze' THEN
            UPDATE public.accounts SET frozen = true, updated_at = now() WHERE id = p_target::uuid;
            RETURN jsonb_build_object('success', true, 'message', '已冻结 ' || v_name, 'frozen', true);
        END IF;
        IF p_action = 'unfreeze' THEN
            UPDATE public.accounts SET frozen = false, updated_at = now() WHERE id = p_target::uuid;
            RETURN jsonb_build_object('success', true, 'message', '已解冻 ' || v_name, 'frozen', false);
        END IF;
        IF p_action = 'delete' THEN
            DELETE FROM public.chat_messages WHERE session_id IN
                (SELECT id FROM public.chat_sessions WHERE user_id = p_target::uuid);
            DELETE FROM public.chat_sessions WHERE user_id = p_target::uuid;
            DELETE FROM public.daily_quota WHERE identity_type = 'account' AND identity_key = p_target;
            DELETE FROM public.profiles WHERE id = p_target::uuid;
            DELETE FROM public.accounts WHERE id = p_target::uuid;
            BEGIN
                DELETE FROM auth.users WHERE id = p_target::uuid;
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
            RETURN jsonb_build_object('success', true, 'message', '已删除 ' || v_name);
        END IF;
        RETURN jsonb_build_object('success', false, 'message', '未知操作: ' || p_action);
    END IF;

    -- ============ 游客设备 ============
    IF p_type = 'device' THEN
        SELECT coalesce(d.device_id, ''), coalesce(
            (SELECT bool_or(is_admin) FROM public.profiles WHERE device_id = p_target), false
        ) INTO v_name, v_is_admin
        FROM public.devices d WHERE d.device_id = p_target;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', '设备不存在');
        END IF;
        -- 保护：管理员自身设备（profiles.is_admin 关联）不可操作
        IF v_is_admin THEN
            RETURN jsonb_build_object('success', false, 'message', '不能操作管理员设备');
        END IF;
        IF p_action = 'freeze' THEN
            UPDATE public.devices SET frozen = true, updated_at = now() WHERE device_id = p_target;
            RETURN jsonb_build_object('success', true, 'message', '已冻结设备 ' || left(v_name, 12), 'frozen', true);
        END IF;
        IF p_action = 'unfreeze' THEN
            UPDATE public.devices SET frozen = false, updated_at = now() WHERE device_id = p_target;
            RETURN jsonb_build_object('success', true, 'message', '已解冻设备 ' || left(v_name, 12), 'frozen', false);
        END IF;
        IF p_action = 'delete' THEN
            -- 级联：该设备的匿名 user（profiles.device_id）的会话/消息
            DELETE FROM public.chat_messages WHERE session_id IN (
                SELECT s.id FROM public.chat_sessions s
                JOIN public.profiles p ON p.id = s.user_id
                WHERE p.device_id = p_target
            );
            DELETE FROM public.chat_sessions WHERE user_id IN (
                SELECT id FROM public.profiles WHERE device_id = p_target
            );
            DELETE FROM public.daily_quota WHERE identity_type = 'device' AND identity_key = p_target;
            DELETE FROM public.profiles WHERE device_id = p_target;
            DELETE FROM public.devices WHERE device_id = p_target;
            BEGIN
                DELETE FROM auth.users WHERE id IN (SELECT id FROM public.profiles WHERE device_id = p_target);
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
            RETURN jsonb_build_object('success', true, 'message', '已删除设备 ' || left(v_name, 12));
        END IF;
        RETURN jsonb_build_object('success', false, 'message', '未知操作: ' || p_action);
    END IF;

    RETURN jsonb_build_object('success', false, 'message', '未知类型: ' || p_type);
END;
$$;

-- ------------------------------------------------------------
-- 授权
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.check_and_consume_quota(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_user_action(text, text, text) TO authenticated, service_role;
