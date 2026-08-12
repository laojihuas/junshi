-- ============================================================
-- 021_quota_params.sql 配额参数搬后台（v20260812）
-- 把写死在 008 函数里的配额数值搬到 app_config.quota_params（JSON），后台可调
--   免费档 50/30/15（按设备注册 3天/7天 档）、VIP 日配额 500、邀请 +50 封顶 300
-- 改造函数：register_device / check_and_consume_quota / redeem_invite_device / get_quota_status
-- ============================================================

-- 1) app_config 加配额参数字段
ALTER TABLE public.app_config
    ADD COLUMN IF NOT EXISTS quota_params text;

-- 2) 初始化默认值（与 008 原值一致；后台改后此处仅作兜底）
INSERT INTO public.app_config (id, quota_params, updated_at)
VALUES (1, '{"free_daily_tier1":50,"free_daily_tier2":30,"free_daily_tier3":15,"vip_daily_limit":500,"invite_bonus_each":50,"invite_bonus_cap":300}', now())
ON CONFLICT (id) DO UPDATE SET quota_params = COALESCE(EXCLUDED.quota_params, public.app_config.quota_params)
WHERE public.app_config.quota_params IS NULL;

-- 3) 配额读取 helper：qp('key', 默认值) → app_config.quota_params 里的数值（缺省/非法回退默认）
--    SECURITY DEFINER：函数内以 owner 权限读配置（规避 RLS）
CREATE OR REPLACE FUNCTION public.qp(p_key text, p_dflt int DEFAULT NULL)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT (q->>p_key)::int FROM public.app_config WHERE id = 1 AND q IS NOT NULL),
    p_dflt
  )
  FROM (SELECT (SELECT quota_params::jsonb FROM public.app_config WHERE id = 1) AS q) s
$$;

-- 4) register_device：免费三档改读配置
CREATE OR REPLACE FUNCTION public.register_device(
    p_device_id text,
    p_ip text DEFAULT NULL,
    p_invite_code text DEFAULT NULL,
    p_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_day     date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_cnt     int;
    v_code    text := upper(btrim(coalesce(p_invite_code, '')));
    v_inviter public.devices%rowtype;
    v_dev     public.devices%rowtype;
    v_free    int;
BEGIN
    PERFORM public.ensure_profile(p_user_id);

    -- 已注册设备：直接返回状态
    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF FOUND THEN
        v_free := CASE
            WHEN (now() - v_dev.created_at) < interval '3 days' THEN public.qp('free_daily_tier1', 50)
            WHEN (now() - v_dev.created_at) < interval '7 days' THEN public.qp('free_daily_tier2', 30)
            ELSE public.qp('free_daily_tier3', 15)
        END;
        RETURN jsonb_build_object(
            'success', true, 'registered', false,
            'invite_bonus', v_dev.invite_bonus,
            'is_vip', v_dev.is_vip,
            'vip_expires_at', v_dev.vip_expires_at,
            'free_daily', v_free,
            'inviter_code', v_dev.inviter_code,
            'invite_redeemed', v_dev.inviter_device_id IS NOT NULL
        );
    END IF;

    -- 新设备：同 IP 当日新设备数 ≤5（只读检查 + 锁行防并发；计数在设备落库后 +1）
    IF p_ip IS NOT NULL AND p_ip <> '' THEN
        INSERT INTO public.ip_usage (ip, day) VALUES (p_ip, v_day)
        ON CONFLICT (ip, day) DO NOTHING;
        SELECT new_devices INTO v_cnt FROM public.ip_usage WHERE ip = p_ip AND day = v_day FOR UPDATE;
        IF v_cnt >= 5 THEN
            RETURN jsonb_build_object('success', false, 'reason', 'ip_new_device_limit', 'message', '使用太频繁，请稍后再试');
        END IF;
    END IF;

    -- 校验来源邀请码（存在且非自己）
    IF v_code <> '' THEN
        SELECT * INTO v_inviter FROM public.devices WHERE invite_code = v_code;
        IF NOT FOUND THEN
            v_code := NULL;  -- 无效邀请码不阻断注册，仅忽略
        ELSIF v_inviter.device_id = p_device_id THEN
            v_code := NULL;
        END IF;
    END IF;

    INSERT INTO public.devices (device_id, inviter_code)
    VALUES (p_device_id, NULLIF(v_code, ''));

    -- [v20260805 fix] 设备落库成功后才计数：new_devices 永远 = 实际新注册数，
    -- 避免"设备行被清理/删除但计数不扣减"导致的幽灵计数 → ip_new_device_limit 误杀真实用户
    IF p_ip IS NOT NULL AND p_ip <> '' THEN
        UPDATE public.ip_usage SET new_devices = new_devices + 1 WHERE ip = p_ip AND day = v_day;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'registered', true,
        'invite_bonus', 0,
        'is_vip', false,
        'vip_expires_at', null,
        'free_daily', public.qp('free_daily_tier1', 50),
        'inviter_code', NULLIF(v_code, ''),
        'invite_redeemed', false
    );
END;
$$;

-- 5) check_and_consume_quota：VIP 日配额 + 免费三档改读配置
CREATE OR REPLACE FUNCTION public.check_and_consume_quota(
    p_device_id text,
    p_ip text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dev       public.devices%rowtype;
    v_day       date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_used      int;
    v_free      int;
    v_ip_limit  int := 150;
    v_vip_limit int := public.qp('vip_daily_limit', 500);
BEGIN
    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'device_not_found');
    END IF;

    -- VIP：500 次/天，不参与 IP 防刷
    IF v_dev.is_vip AND v_dev.vip_expires_at IS NOT NULL AND v_dev.vip_expires_at > now() THEN
        INSERT INTO public.daily_quota (device_id, day) VALUES (p_device_id, v_day)
        ON CONFLICT (device_id, day) DO NOTHING;
        SELECT used_count INTO v_used FROM public.daily_quota WHERE device_id = p_device_id AND day = v_day FOR UPDATE;
        IF v_used >= v_vip_limit THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'vip_daily_limit');
        END IF;
        UPDATE public.daily_quota SET used_count = used_count + 1 WHERE device_id = p_device_id AND day = v_day;
        RETURN jsonb_build_object('allowed', true, 'tier', 'vip', 'used', v_used + 1, 'limit', v_vip_limit);
    END IF;

    -- 非 VIP：IP 防刷（150 次/天/IP）
    IF p_ip IS NOT NULL AND p_ip <> '' THEN
        INSERT INTO public.ip_usage (ip, day) VALUES (p_ip, v_day)
        ON CONFLICT (ip, day) DO NOTHING;
        SELECT used_count INTO v_used FROM public.ip_usage WHERE ip = p_ip AND day = v_day FOR UPDATE;
        IF v_used >= v_ip_limit THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'ip_limit');
        END IF;
        UPDATE public.ip_usage SET used_count = used_count + 1 WHERE ip = p_ip AND day = v_day;
    END IF;

    -- 免费档（按注册天数）+ 邀请余额兜底
    v_free := CASE
        WHEN (now() - v_dev.created_at) < interval '3 days' THEN public.qp('free_daily_tier1', 50)
        WHEN (now() - v_dev.created_at) < interval '7 days' THEN public.qp('free_daily_tier2', 30)
        ELSE public.qp('free_daily_tier3', 15)
    END;

    INSERT INTO public.daily_quota (device_id, day) VALUES (p_device_id, v_day)
    ON CONFLICT (device_id, day) DO NOTHING;
    SELECT used_count INTO v_used FROM public.daily_quota WHERE device_id = p_device_id AND day = v_day FOR UPDATE;

    IF v_used < v_free THEN
        UPDATE public.daily_quota SET used_count = used_count + 1 WHERE device_id = p_device_id AND day = v_day;
        RETURN jsonb_build_object('allowed', true, 'tier', 'free', 'used', v_used + 1, 'limit', v_free, 'bonus', v_dev.invite_bonus);
    END IF;

    -- 免费档用完 → 消耗邀请余额（长期余额，不清零）
    IF v_dev.invite_bonus > 0 THEN
        UPDATE public.devices SET invite_bonus = invite_bonus - 1 WHERE device_id = p_device_id;
        UPDATE public.daily_quota SET used_count = used_count + 1 WHERE device_id = p_device_id AND day = v_day;
        RETURN jsonb_build_object('allowed', true, 'tier', 'bonus', 'used', v_used + 1, 'limit', v_free, 'bonus', v_dev.invite_bonus - 1);
    END IF;

    RETURN jsonb_build_object('allowed', false, 'reason', 'quota_exhausted', 'used', v_used, 'limit', v_free);
END;
$$;

-- 6) redeem_invite_device：邀请奖励 + 封顶改读配置
CREATE OR REPLACE FUNCTION public.redeem_invite_device(
    p_invitee_device_id text,
    p_invite_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code    text := upper(btrim(coalesce(p_invite_code, '')));
    v_inviter public.devices%rowtype;
    v_invitee public.devices%rowtype;
    v_bonus   int;
    v_cap     int := public.qp('invite_bonus_cap', 300);
    v_each    int := public.qp('invite_bonus_each', 50);
BEGIN
    SELECT * INTO v_inviter FROM public.devices WHERE invite_code = v_code;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '邀请码无效');
    END IF;
    IF v_inviter.device_id = p_invitee_device_id THEN
        RETURN jsonb_build_object('success', false, 'message', '不能使用自己的邀请码');
    END IF;

    SELECT * INTO v_invitee FROM public.devices WHERE device_id = p_invitee_device_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '设备未注册');
    END IF;
    IF v_invitee.inviter_device_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '该设备已绑定过邀请');
    END IF;

    -- 邀请人封顶（超出不计，不暴露上限）
    IF v_inviter.invite_bonus >= v_cap THEN
        RETURN jsonb_build_object('success', false, 'message', '该邀请码已失效');
    END IF;

    v_bonus := least(v_cap, v_inviter.invite_bonus + v_each);
    UPDATE public.devices SET invite_bonus = v_bonus, updated_at = now() WHERE device_id = v_inviter.device_id;
    UPDATE public.devices SET inviter_device_id = v_inviter.device_id, updated_at = now() WHERE device_id = p_invitee_device_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', '邀请成功，已赠送 ' || v_each || ' 次使用额度',
        'bonus', v_bonus
    );
END;
$$;

-- 7) get_quota_status：免费三档改读配置（保持原单参签名，避免重载歧义）
CREATE OR REPLACE FUNCTION public.get_quota_status(
    p_device_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dev  public.devices%rowtype;
    v_day  date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_used int;
    v_free int;
    v_days int;
BEGIN
    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('registered', false);
    END IF;

    SELECT used_count INTO v_used FROM public.daily_quota WHERE device_id = p_device_id AND day = v_day;
    v_used := coalesce(v_used, 0);
    v_free := CASE
        WHEN (now() - v_dev.created_at) < interval '3 days' THEN public.qp('free_daily_tier1', 50)
        WHEN (now() - v_dev.created_at) < interval '7 days' THEN public.qp('free_daily_tier2', 30)
        ELSE public.qp('free_daily_tier3', 15)
    END;
    v_days := CASE
        WHEN v_dev.is_vip AND v_dev.vip_expires_at IS NOT NULL AND v_dev.vip_expires_at > now()
            THEN greatest(1, (v_dev.vip_expires_at::date - v_day))
        ELSE 0
    END;

    RETURN jsonb_build_object(
        'registered', true,
        'free_daily', v_free,
        'used_today', v_used,
        'invite_bonus', v_dev.invite_bonus,
        'is_vip', v_dev.is_vip,
        'vip_days_left', v_days,
        'vip_expires_at', v_dev.vip_expires_at
    );
END;
$$;
