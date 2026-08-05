-- ============================================================
-- 军师 - 账号体系（v20260805 用户机制重构）
--
-- 背景：设备体系("指纹=业务身份")被"清缓存/换浏览器"绕过 → 重构为：
--   游客（device_id 指纹）20 条/天 → 用完弹注册引导；
--   注册用户（账号+密码，密码由 Supabase Auth 管理）前3天 50/天、3天后 20/天，
--   用完弹付费墙（月卡 68 元/月 500 条/天 / 邀请好友注册成功 +50 封顶 300）；
--   同一台设备只能注册一个账号（防一机多号）；任意设备可登录，但同一时间
--   仅一台设备在线（active_session 单点踢旧）。
--
-- 关键设计：
--   * 账号密码在 Supabase Auth（email = hex(账号名)+'@jssl.local'），RLS/会话全复用；
--     accounts 表只存账号元数据，id = Supabase Auth user id
--   * daily_quota 双轨：identity_type='device'（游客）| 'account'（注册），
--     注册用户跨设备登录也按账号扣次（换设备不能刷）
--   * IP 防刷仅游客生效（注册用户豁免，防公司/宿舍多人误伤）
--   * 注册时游客数据自动迁移（chat_sessions.user_id 转给账号）
--   * 邀请：注册带邀请码 → 邀请人 +50（least(300, bonus+50)），注册即兑现，
--     不再需要独立 redeem 函数（旧 redeem_invite_device DROP）
--   * 激活码改绑账号（activation_codes.used_account_id）
--
-- 注意：本脚本会 DROP 旧签名函数（check_and_consume_quota/get_quota_status/
--       activate_device/redeem_invite_device），需先部署配套 Edge Functions。
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

-- 0. 激活码表加账号绑定列
ALTER TABLE public.activation_codes
    ADD COLUMN IF NOT EXISTS used_account_id text;

-- 1. 账号表（业务身份主表；id = Supabase Auth user id）
CREATE TABLE IF NOT EXISTS public.accounts (
    id               uuid PRIMARY KEY,             -- Supabase Auth user id
    account_name     text UNIQUE NOT NULL,          -- 账号名（中英文数字，唯一）
    device_id        text UNIQUE,                   -- 绑定设备指纹（同一设备只能注册一个账号）
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    inviter_account  text,                          -- 邀请人账号名（注册时兑现 +50）
    invite_code      varchar(8) UNIQUE,             -- 自己的邀请码（去混淆字符）
    invite_bonus     int NOT NULL DEFAULT 0,        -- 邀请赠送余额（不清零，封顶 300）
    is_vip           boolean NOT NULL DEFAULT false,
    vip_expires_at   timestamptz,
    activation_code  text,                          -- 绑定的激活码（审计）
    active_session   text,                          -- 当前会话 ID（单点登录：新登录覆盖）
    last_login_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_accounts_inviter ON public.accounts (inviter_account);

-- 2. daily_quota 双轨重构（identity_type: device|account）
ALTER TABLE public.daily_quota RENAME TO daily_quota_v1;
CREATE TABLE public.daily_quota (
    identity_type text NOT NULL,                    -- 'device'（游客）| 'account'（注册）
    identity_key  text NOT NULL,                    -- device_id 或 accounts.id
    day           date NOT NULL,                    -- 中国时区自然日
    used_count    int NOT NULL DEFAULT 0,
    PRIMARY KEY (identity_type, identity_key, day)
);
INSERT INTO public.daily_quota (identity_type, identity_key, day, used_count)
SELECT 'device', device_id, day, used_count FROM public.daily_quota_v1;
DROP TABLE public.daily_quota_v1;

-- 3. 游客设备注册（保留指纹召回；免费档固定 20/天）
--    签名同 010（p_fp_* 召回信号）
CREATE OR REPLACE FUNCTION public.register_device(
    p_device_id text,
    p_ip text,
    p_invite_code text DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_fp_ua text DEFAULT NULL,
    p_fp_screen text DEFAULT NULL,
    p_fp_tz text DEFAULT NULL,
    p_fp_lang text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_day      date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_cnt      int;
    v_inviter  public.devices%rowtype;
    v_dev      public.devices%rowtype;
    v_recall   public.devices%rowtype;
    v_is_fb    boolean := p_device_id LIKE 'fp\_%';
BEGIN
    PERFORM public.ensure_profile(p_user_id);

    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF FOUND THEN
        IF p_ip IS NOT NULL AND p_ip <> '' AND v_dev.last_ip IS DISTINCT FROM p_ip THEN
            UPDATE public.devices SET last_ip = p_ip, updated_at = now() WHERE device_id = p_device_id;
        END IF;
        RETURN jsonb_build_object(
            'success', true, 'registered', false,
            'free_daily', 20, 'is_vip', false, 'vip_expires_at', null,
            'invite_bonus', 0, 'invite_redeemed', false, 'inviter_code', v_dev.inviter_code
        );
    END IF;

    -- [方案C 召回] 仅 fallback 设备（fp_ 前缀）且指纹特征齐备时召回 30 天内老设备
    IF v_is_fb AND p_ip IS NOT NULL AND p_ip <> ''
       AND p_fp_ua IS NOT NULL AND p_fp_ua <> ''
       AND p_fp_screen IS NOT NULL AND p_fp_screen <> ''
    THEN
        SELECT * INTO v_recall
        FROM public.devices
        WHERE last_ip = p_ip AND fp_ua = p_fp_ua AND fp_screen = p_fp_screen
          AND (p_fp_tz IS NULL OR fp_tz = p_fp_tz)
          AND (p_fp_lang IS NULL OR fp_lang = p_fp_lang)
          AND created_at > now() - interval '30 days'
        ORDER BY updated_at DESC LIMIT 1;
        IF FOUND THEN
            IF v_recall.last_ip IS DISTINCT FROM p_ip THEN
                UPDATE public.devices SET last_ip = p_ip, updated_at = now() WHERE device_id = v_recall.device_id;
            END IF;
            RETURN jsonb_build_object(
                'success', true, 'registered', false, 'recalled', true,
                'recalled_device_id', v_recall.device_id,
                'free_daily', 20, 'is_vip', false, 'vip_expires_at', null,
                'invite_bonus', 0, 'invite_redeemed', false, 'inviter_code', v_recall.inviter_code
            );
        END IF;
    END IF;

    -- 新设备：同 IP 当日新设备数 ≤5（计数在落库后 +1）
    IF p_ip IS NOT NULL AND p_ip <> '' THEN
        INSERT INTO public.ip_usage (ip, day) VALUES (p_ip, v_day)
        ON CONFLICT (ip, day) DO NOTHING;
        SELECT new_devices INTO v_cnt FROM public.ip_usage WHERE ip = p_ip AND day = v_day FOR UPDATE;
        IF v_cnt >= 5 THEN
            RETURN jsonb_build_object('success', false, 'reason', 'ip_new_device_limit', 'message', '使用太频繁，请稍后再试');
        END IF;
    END IF;

    INSERT INTO public.devices (device_id, last_ip, fp_ua, fp_screen, fp_tz, fp_lang)
    VALUES (p_device_id, p_ip, p_fp_ua, p_fp_screen, p_fp_tz, p_fp_lang);

    IF p_ip IS NOT NULL AND p_ip <> '' THEN
        UPDATE public.ip_usage SET new_devices = new_devices + 1 WHERE ip = p_ip AND day = v_day;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'registered', true,
        'free_daily', 20, 'is_vip', false, 'vip_expires_at', null,
        'invite_bonus', 0, 'invite_redeemed', false, 'inviter_code', null
    );
END;
$$;

-- 4. 配额检查 + 原子扣次（双身份：游客 device / 注册 account）
--    返回：{ allowed, tier?, reason?, used?, limit?, bonus? }
--    tier: vip / free / bonus；reason: device_not_found / account_not_found /
--          guest_quota_exhausted（游客→注册引导）/ quota_exhausted（注册→付费墙）
--          / vip_daily_limit / ip_limit
DROP FUNCTION IF EXISTS public.check_and_consume_quota(text, text);
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

-- 5. 账号注册（账号唯一 + 设备唯一 + 邀请兑现 + 游客数据迁移）
--    密码已由 account-auth Edge Function 在 Supabase Auth 创建（email 伪装），
--    本函数只落账号元数据。p_account_user_id = Auth user id。
DROP FUNCTION IF EXISTS public.register_account(uuid, text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.register_account(
    p_account_user_id uuid,
    p_account_name text,
    p_device_id text,
    p_invite_code text DEFAULT NULL,
    p_guest_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name  text := btrim(p_account_name);
    v_code  text := upper(btrim(coalesce(p_invite_code, '')));
    v_icode text;
    v_inviter public.accounts%rowtype;
    v_dev_account_id uuid;
    v_guest uuid := p_guest_user_id;
BEGIN
    -- 格式/长度校验（字符集由 Edge Function 强校验，这里兜底）
    IF v_name = '' OR length(v_name) > 20 OR v_name ~ '^[[:space:]]' OR v_name ~ '[[:space:]]$' THEN
        RETURN jsonb_build_object('success', false, 'message', '账号格式不正确');
    END IF;

    -- 账号唯一
    IF EXISTS (SELECT 1 FROM public.accounts WHERE account_name = v_name) THEN
        RETURN jsonb_build_object('success', false, 'message', '该账号已被注册');
    END IF;
    -- 设备唯一（同一台手机/指纹只能注册一个账号）
    IF p_device_id IS NOT NULL AND p_device_id <> '' THEN
        SELECT id INTO v_dev_account_id FROM public.accounts WHERE device_id = p_device_id;
        IF v_dev_account_id IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'message', '该设备已注册过账号');
        END IF;
    END IF;

    -- 生成自己的邀请码（8 位去混淆字符，唯一为止）
    LOOP
        v_icode := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
        IF v_icode !~ '^[0-9]+$' AND NOT EXISTS (SELECT 1 FROM public.accounts WHERE invite_code = v_icode) THEN
            EXIT;
        END IF;
    END LOOP;

    -- 校验来源邀请码（存在且非自己；无效则忽略不阻断注册）
    IF v_code <> '' THEN
        SELECT * INTO v_inviter FROM public.accounts WHERE invite_code = v_code;
        IF FOUND AND v_inviter.id <> p_account_user_id THEN
            -- 邀请兑现：邀请人 +50，封顶 300（注册即兑现）
            UPDATE public.accounts
            SET invite_bonus = least(300, invite_bonus + 50), updated_at = now()
            WHERE id = v_inviter.id;
        ELSE
            v_code := '';
        END IF;
    ELSE
        v_code := '';
    END IF;

    -- 账号行
    INSERT INTO public.accounts (id, account_name, device_id, inviter_account, invite_code)
    VALUES (p_account_user_id, v_name, NULLIF(p_device_id, ''), NULLIF(v_code, ''), v_icode);

    PERFORM public.ensure_profile(p_account_user_id);

    -- 游客数据迁移：注册前的游客匿名 user 的好友/聊天转给账号
    IF v_guest IS NOT NULL AND v_guest <> p_account_user_id THEN
        UPDATE public.chat_sessions SET user_id = p_account_user_id WHERE user_id = v_guest;
        DELETE FROM public.profiles WHERE id = v_guest;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'account_name', v_name,
        'invite_code', v_icode,
        'inviter_rewarded', v_code <> ''
    );
END;
$$;

-- 6. 账号登录（记录会话实现单点：新登录覆盖 active_session）
CREATE OR REPLACE FUNCTION public.login_account(
    p_account_user_id uuid,
    p_session_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_acc public.accounts%rowtype;
BEGIN
    SELECT * INTO v_acc FROM public.accounts WHERE id = p_account_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '账号不存在');
    END IF;
    IF p_session_id IS NOT NULL THEN
        UPDATE public.accounts
        SET active_session = p_session_id, last_login_at = now(), updated_at = now()
        WHERE id = p_account_user_id;
    END IF;
    RETURN jsonb_build_object(
        'success', true,
        'account_name', v_acc.account_name,
        'invite_code', v_acc.invite_code,
        'invite_bonus', v_acc.invite_bonus,
        'is_vip', v_acc.is_vip,
        'vip_expires_at', v_acc.vip_expires_at,
        'device_id', v_acc.device_id
    );
END;
$$;

-- 7. 会话校验（单点：active_session 不匹配 → 旧设备被踢）
CREATE OR REPLACE FUNCTION public.check_account_session(
    p_account_user_id uuid,
    p_session_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_acc public.accounts%rowtype;
BEGIN
    SELECT * INTO v_acc FROM public.accounts WHERE id = p_account_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'account_not_found');
    END IF;
    IF v_acc.active_session IS NULL OR v_acc.active_session <> p_session_id THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'session_expired');
    END IF;
    RETURN jsonb_build_object('valid', true);
END;
$$;

-- 8. 激活码激活（绑账号；续期从 max(now, 现有到期) +30 天）
DROP FUNCTION IF EXISTS public.activate_device(text, text);
CREATE OR REPLACE FUNCTION public.activate_account(
    p_account_user_id uuid,
    p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code    text := upper(btrim(coalesce(p_code, '')));
    v_rec     public.activation_codes%rowtype;
    v_expires timestamptz;
    v_days    int;
BEGIN
    IF v_code = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '请输入激活码');
    END IF;
    SELECT * INTO v_rec FROM public.activation_codes WHERE code = v_code;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '无效的激活码');
    END IF;
    IF v_rec.used OR v_rec.used_account_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '该激活码已被使用');
    END IF;
    -- 账号必须存在
    IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_user_id) THEN
        RETURN jsonb_build_object('success', false, 'message', '账号不存在');
    END IF;
    UPDATE public.activation_codes
    SET used = true, used_account_id = p_account_user_id::text, used_at = now()
    WHERE id = v_rec.id;
    SELECT coalesce(vip_expires_at, now()) INTO v_expires FROM public.accounts WHERE id = p_account_user_id;
    v_expires := greatest(now(), v_expires) + interval '30 days';
    v_days := greatest(1, (v_expires::date - (now() AT TIME ZONE 'Asia/Shanghai')::date));
    UPDATE public.accounts
    SET is_vip = true, vip_expires_at = v_expires, activation_code = v_code, updated_at = now()
    WHERE id = p_account_user_id;
    RETURN jsonb_build_object(
        'success', true, 'message', '激活成功！已升级为 VIP',
        'vip_expires_at', v_expires, 'vip_days_left', v_days
    );
END;
$$;

-- 9. 配额状态查询（双轨）
DROP FUNCTION IF EXISTS public.get_quota_status(text);
CREATE OR REPLACE FUNCTION public.get_quota_status(
    p_identity_type text,
    p_identity_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_day  date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    v_used int;
    v_free int;
    v_days int;
    v_bonus int := 0;
    v_vip boolean := false;
    v_vip_exp timestamptz;
BEGIN
    IF p_identity_type = 'device' THEN
        IF NOT EXISTS (SELECT 1 FROM public.devices WHERE device_id = p_identity_key) THEN
            RETURN jsonb_build_object('registered', false);
        END IF;
        v_free := 20;
    ELSIF p_identity_type = 'account' THEN
        DECLARE
            v_acc public.accounts%rowtype;
        BEGIN
            SELECT * INTO v_acc FROM public.accounts WHERE id = p_identity_key::uuid;
            IF NOT FOUND THEN
                RETURN jsonb_build_object('registered', false);
            END IF;
            v_free := CASE
                WHEN (now() - v_acc.created_at) < interval '3 days' THEN 50
                ELSE 20
            END;
            v_bonus := v_acc.invite_bonus;
            v_vip := v_acc.is_vip AND v_acc.vip_expires_at IS NOT NULL AND v_acc.vip_expires_at > now();
            v_vip_exp := v_acc.vip_expires_at;
            v_days := CASE WHEN v_vip THEN greatest(1, (v_acc.vip_expires_at::date - v_day)) ELSE 0 END;
        END;
    ELSE
        RETURN jsonb_build_object('registered', false);
    END IF;

    SELECT used_count INTO v_used FROM public.daily_quota
    WHERE identity_type = p_identity_type AND identity_key = p_identity_key AND day = v_day;
    v_used := coalesce(v_used, 0);

    RETURN jsonb_build_object(
        'registered', true,
        'identity_type', p_identity_type,
        'free_daily', v_free,
        'used_today', v_used,
        'invite_bonus', v_bonus,
        'is_vip', v_vip,
        'vip_days_left', v_days,
        'vip_expires_at', v_vip_exp
    );
END;
$$;

-- 10. 后台统计（适配双轨：用户数 = 游客设备 + 注册账号）
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
    SELECT is_admin INTO v_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    SELECT (SELECT count(*) FROM public.devices) + (SELECT count(*) FROM public.accounts) INTO v_users;
    SELECT count(*) INTO v_vip FROM public.accounts WHERE is_vip AND coalesce(vip_expires_at, now()) >= now();
    SELECT coalesce(sum(used_count), 0) INTO v_today_calls FROM public.daily_quota WHERE day = v_day;
    SELECT coalesce(sum(used_count), 0) INTO v_total_calls FROM public.daily_quota;
    SELECT count(*) FILTER (WHERE used) INTO v_codes_used FROM public.activation_codes;
    SELECT count(*) INTO v_codes_total FROM public.activation_codes;
    SELECT count(*) INTO v_msg_assistant FROM public.chat_messages WHERE role = 'assistant';

    -- 用户列表 = 注册账号（优先展示）+ 游客设备（无账号绑定）
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_list
    FROM (
        SELECT a.account_name AS device_id, a.created_at, a.is_vip, a.vip_expires_at, a.invite_bonus,
               coalesce(dq.used_count, 0) AS today_calls,
               (SELECT coalesce(sum(used_count), 0) FROM public.daily_quota x
                WHERE x.identity_type = 'account' AND x.identity_key = a.id::text) AS total_calls,
               true AS is_account
        FROM public.accounts a
        LEFT JOIN public.daily_quota dq ON dq.identity_type = 'account' AND dq.identity_key = a.id::text AND dq.day = v_day
        UNION ALL
        SELECT d.device_id, d.created_at, d.is_vip, d.vip_expires_at, d.invite_bonus,
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

-- 11. 授权（新签名；旧签名函数已 DROP）
GRANT EXECUTE ON FUNCTION public.register_device(text, text, text, uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_consume_quota(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_account(uuid, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_account(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_account_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_account(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_quota_status(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO service_role;
