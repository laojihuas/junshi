-- ============================================================
-- 军师 - 设备身份 + 三层配额体系（v20260805）
--
-- 背景：剔除邮箱登录 → Supabase 匿名登录 + 设备指纹(device_id) 双轨。
--   device_id = 业务身份（配额/激活码/邀请归属），匿名 user 只是会话载体。
--
-- 配额规则：
--   ① 免费档：新设备前3天 50次/天、3-7天 30次/天、7天后 15次/天，每日清零
--   ② 邀请：+50次/人（邀请人累计封顶300次，超出不计），邀请余额不清零；
--      经邀请链接打开且首次新建好友后才兑现（前端控制调用时机）
--   ③ 激活码：68元/月，绑设备指纹，500次/天 × 30天，到期回落免费档
--   防刷：IP 每日 150 次（仅无 VIP 用户）；同 IP 每日新设备 ≤5
--
-- 注意：这些函数仅供 Edge Function（service_role）调用，前端不直调。
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

-- 0. 激活码表增加设备绑定列（绑指纹而非 user id：匿名 user 清缓存即消失）
ALTER TABLE public.activation_codes
    ADD COLUMN IF NOT EXISTS used_device_id text;

-- 1. 设备表（业务身份主表）
CREATE TABLE IF NOT EXISTS public.devices (
    device_id         text PRIMARY KEY,                 -- 设备指纹（FingerprintJS visitorId）
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    invite_bonus      int NOT NULL DEFAULT 0,           -- 邀请赠送余额（不清零，封顶 300）
    is_vip            boolean NOT NULL DEFAULT false,
    vip_expires_at    timestamptz,
    activation_code   text,                             -- 绑定的激活码（审计）
    invite_code       varchar(8) UNIQUE,                -- 自己的邀请码（去混淆字符）
    inviter_device_id text,                             -- 邀请人设备（兑现后写入，一个设备只能被绑一次）
    inviter_code      varchar(8)                        -- 来源邀请码（注册时暂存，首次建好友后兑现）
);

CREATE INDEX IF NOT EXISTS idx_devices_inviter_device
    ON public.devices (inviter_device_id);

-- 2. 每日配额消耗表（device 维度，天然按天清零）
CREATE TABLE IF NOT EXISTS public.daily_quota (
    device_id  text NOT NULL REFERENCES public.devices (device_id) ON DELETE CASCADE,
    day        date NOT NULL,                           -- 中国时区自然日
    used_count int NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
);

-- 3. IP 每日消耗表（防刷：次数 + 新设备数）
CREATE TABLE IF NOT EXISTS public.ip_usage (
    ip          text NOT NULL,
    day         date NOT NULL,
    used_count  int NOT NULL DEFAULT 0,
    new_devices int NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day)
);

-- ============================================================
-- helper：确保匿名用户的 profiles 行存在（chat_sessions.user_id
-- 外键 references profiles.id，匿名登录不会自动建行）
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_profile(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_user_id IS NOT NULL THEN
        INSERT INTO public.profiles (id) VALUES (p_user_id)
        ON CONFLICT (id) DO NOTHING;
    END IF;
END;
$$;

-- ============================================================
-- 设备注册：新设备写 devices（IP 新设备限流）；已存在返回状态
-- 入参：p_device_id 指纹、p_ip、p_invite_code（URL 邀请码，暂存）、p_user_id（匿名用户 id，建 profile）
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_device(
    p_device_id text,
    p_ip text,
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
            WHEN (now() - v_dev.created_at) < interval '3 days' THEN 50
            WHEN (now() - v_dev.created_at) < interval '7 days' THEN 30
            ELSE 15
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
        'free_daily', 50,
        'inviter_code', NULLIF(v_code, ''),
        'invite_redeemed', false
    );
END;
$$;

-- ============================================================
-- 配额检查 + 原子扣次（ima-proxy 每次调用前执行）
-- 返回：{ allowed, tier?, reason?, used?, limit?, bonus? }
--   tier: vip / free / bonus
--   reason: device_not_found / vip_daily_limit / ip_limit / quota_exhausted
-- ============================================================
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
    v_vip_limit int := 500;
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
        WHEN (now() - v_dev.created_at) < interval '3 days' THEN 50
        WHEN (now() - v_dev.created_at) < interval '7 days' THEN 30
        ELSE 15
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

-- ============================================================
-- 激活码激活（绑设备指纹）
-- ============================================================
CREATE OR REPLACE FUNCTION public.activate_device(
    p_device_id text,
    p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code     text := upper(btrim(coalesce(p_code, '')));
    v_rec      public.activation_codes%rowtype;
    v_expires  timestamptz;
    v_days     int;
BEGIN
    IF v_code = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '请输入激活码');
    END IF;

    SELECT * INTO v_rec FROM public.activation_codes WHERE code = v_code;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '无效的激活码');
    END IF;
    IF v_rec.used OR v_rec.used_device_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '该激活码已被使用');
    END IF;

    -- 设备不存在则自动注册（激活不依赖先注册）
    INSERT INTO public.devices (device_id) VALUES (p_device_id)
    ON CONFLICT (device_id) DO NOTHING;

    -- 标记激活码已使用（绑设备指纹）
    UPDATE public.activation_codes
    SET used = true, used_device_id = p_device_id, used_at = now()
    WHERE id = v_rec.id;

    -- 续期逻辑：从 max(now, 现有到期日) 起 +30 天
    SELECT coalesce(vip_expires_at, now()) INTO v_expires FROM public.devices WHERE device_id = p_device_id;
    v_expires := greatest(now(), v_expires) + interval '30 days';
    v_days := greatest(1, (v_expires::date - (now() AT TIME ZONE 'Asia/Shanghai')::date));

    UPDATE public.devices
    SET is_vip = true, vip_expires_at = v_expires, activation_code = v_code, updated_at = now()
    WHERE device_id = p_device_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', '激活成功！已升级为 VIP',
        'vip_expires_at', v_expires,
        'vip_days_left', v_days
    );
END;
$$;

-- ============================================================
-- 邀请兑现（前端在"首次新建好友成功"后调用；邀请人 +50，封顶 300）
-- ============================================================
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

    -- 邀请人封顶 300 次（超出不计，不暴露上限）
    IF v_inviter.invite_bonus >= 300 THEN
        RETURN jsonb_build_object('success', false, 'message', '该邀请码已失效');
    END IF;

    v_bonus := least(300, v_inviter.invite_bonus + 50);
    UPDATE public.devices SET invite_bonus = v_bonus, updated_at = now() WHERE device_id = v_inviter.device_id;
    UPDATE public.devices SET inviter_device_id = v_inviter.device_id, updated_at = now() WHERE device_id = p_invitee_device_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', '邀请成功，已赠送 50 次使用额度',
        'bonus', v_bonus
    );
END;
$$;

-- ============================================================
-- 配额状态查询（顶部导航：只暴露邀请赠送次数 + VIP 剩余天数）
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_quota_status(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dev   public.devices%rowtype;
    v_day   date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_used  int;
    v_free  int;
    v_days  int;
BEGIN
    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('registered', false);
    END IF;

    SELECT used_count INTO v_used FROM public.daily_quota WHERE device_id = p_device_id AND day = v_day;
    v_used := coalesce(v_used, 0);
    v_free := CASE
        WHEN (now() - v_dev.created_at) < interval '3 days' THEN 50
        WHEN (now() - v_dev.created_at) < interval '7 days' THEN 30
        ELSE 15
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

-- 授权（仅 service_role：Edge Function 调用；前端不直调）
GRANT EXECUTE ON FUNCTION public.ensure_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_device(text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_consume_quota(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_device(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_invite_device(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_quota_status(text) TO service_role;

-- 表级授权（关键！RLS 只管行级，表级 GRANT 缺失会 permission denied；
--   仅 service_role 有权限，anon/authenticated 无法直查/篡改配额表）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices, public.daily_quota, public.ip_usage TO service_role;
