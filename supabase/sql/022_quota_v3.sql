-- ============================================================
-- 022_quota_v3.sql 配额规则对齐（v20260813）
-- 用户规则（v20260813 拍板）：
--   游客（新用户打开即用）20 条/天，用完弹窗提示登录
--   注册用户：注册后连续 3 天 50 条/天，3 天后统一 20 条/天（按 accounts.created_at）
--   邀请：+50 条/人、上不封顶（后台保留 invite_bonus_cap 字段，0=不封顶，管理员可改）
--   后台 quota_params 保留（021 只改了死代码版本，线上生效版本仍是硬编码 → 本次全部改读配置）
-- 注意：021 曾定义 2 参 check_and_consume_quota / 1 参 get_quota_status / 4 参 register_device
--   （死代码，ima-proxy/device-gate 调用的是 3 参/2 参/8 参版本），本次仅改线上生效版本。
-- ============================================================

-- 1) quota_params 默认值合并更新（先并入 guest_daily 新增 key，再遍历更新本次规则涉及的 key；
--    保留后台已设的其它 key）
UPDATE public.app_config
SET quota_params = (
  SELECT jsonb_object_agg(
    key,
    CASE key
      WHEN 'guest_daily'      THEN '20'::jsonb
      WHEN 'free_daily_tier1' THEN '50'::jsonb
      WHEN 'free_daily_tier2' THEN '20'::jsonb
      WHEN 'free_daily_tier3' THEN '20'::jsonb
      WHEN 'vip_daily_limit'  THEN '500'::jsonb
      WHEN 'invite_bonus_each' THEN '50'::jsonb
      WHEN 'invite_bonus_cap' THEN '0'::jsonb
      ELSE value
    END
  )::text
  FROM jsonb_each(COALESCE(quota_params::jsonb, '{}'::jsonb) || '{"guest_daily":20}'::jsonb)
)
WHERE id = 1;

-- 2) register_device（8 参，线上生效）：游客 free_daily 改读 guest_daily
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
    v_guest    int := public.qp('guest_daily', 20);
BEGIN
    PERFORM public.ensure_profile(p_user_id);

    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF FOUND THEN
        IF p_ip IS NOT NULL AND p_ip <> '' AND v_dev.last_ip IS DISTINCT FROM p_ip THEN
            UPDATE public.devices SET last_ip = p_ip, updated_at = now() WHERE device_id = p_device_id;
        END IF;
        RETURN jsonb_build_object(
            'success', true, 'registered', false,
            'free_daily', v_guest, 'is_vip', false, 'vip_expires_at', null,
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
                'free_daily', v_guest, 'is_vip', false, 'vip_expires_at', null,
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
        'free_daily', v_guest, 'is_vip', false, 'vip_expires_at', null,
        'invite_bonus', 0, 'invite_redeemed', false, 'inviter_code', null
    );
END;
$$;

-- 3) check_and_consume_quota（3 参，线上生效）：游客/注册/VIP 全读配置
--    规则：游客 guest_daily(默认20)；注册用户按 accounts.created_at 前 3 天 tier1(默认50) 之后 tier2(默认20)；
--    VIP vip_daily_limit(默认500)；冻结拦截保留
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
        v_free := public.qp('guest_daily', 20);  -- 游客固定（后台可调）
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
            v_vip_limit int := public.qp('vip_daily_limit', 500);
        BEGIN
            SELECT * INTO v_acc FROM public.accounts WHERE id = p_identity_key::uuid;
            IF NOT FOUND THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'account_not_found');
            END IF;
            -- [v20260810 冻结拦截] 管理员冻结的账号禁止使用
            IF v_acc.frozen THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'account_frozen');
            END IF;
            -- VIP：vip_daily_limit 次/天，豁免 IP 防刷
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
            -- 免费档：前 3 天 tier1(默认50)/天，之后 tier2(默认20)/天（按账号注册天数，后台可调）
            v_free := CASE
                WHEN (now() - v_acc.created_at) < interval '3 days' THEN public.qp('free_daily_tier1', 50)
                ELSE public.qp('free_daily_tier2', 20)
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

-- 4) register_account：邀请奖励读配置 + cap<=0 不封顶（"上不封顶"，后台保留 cap 可调）
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
    v_each  int := public.qp('invite_bonus_each', 50);
    v_cap   int := public.qp('invite_bonus_cap', 0);
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
            -- 邀请兑现：邀请人 +v_each（cap>0 时封顶，cap<=0 上不封顶）
            IF v_cap > 0 THEN
                UPDATE public.accounts
                SET invite_bonus = least(v_cap, invite_bonus + v_each), updated_at = now()
                WHERE id = v_inviter.id;
            ELSE
                UPDATE public.accounts
                SET invite_bonus = invite_bonus + v_each, updated_at = now()
                WHERE id = v_inviter.id;
            END IF;
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

-- 5) get_quota_status（2 参，线上生效）：读配置
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
        v_free := public.qp('guest_daily', 20);
    ELSIF p_identity_type = 'account' THEN
        DECLARE
            v_acc public.accounts%rowtype;
        BEGIN
            SELECT * INTO v_acc FROM public.accounts WHERE id = p_identity_key::uuid;
            IF NOT FOUND THEN
                RETURN jsonb_build_object('registered', false);
            END IF;
            v_free := CASE
                WHEN (now() - v_acc.created_at) < interval '3 days' THEN public.qp('free_daily_tier1', 50)
                ELSE public.qp('free_daily_tier2', 20)
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

-- 6) redeem_invite_device（设备邀请码兑现）：cap<=0 不封顶（与账号版一致）
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
    v_cap     int := public.qp('invite_bonus_cap', 0);
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

    -- 邀请人封顶（cap>0 封顶；cap<=0 上不封顶）
    IF v_cap > 0 AND v_inviter.invite_bonus >= v_cap THEN
        RETURN jsonb_build_object('success', false, 'message', '该邀请码已失效');
    END IF;

    IF v_cap > 0 THEN
        v_bonus := least(v_cap, v_inviter.invite_bonus + v_each);
    ELSE
        v_bonus := v_inviter.invite_bonus + v_each;
    END IF;
    UPDATE public.devices SET invite_bonus = v_bonus, updated_at = now() WHERE device_id = v_inviter.device_id;
    UPDATE public.devices SET inviter_device_id = v_inviter.device_id, updated_at = now() WHERE device_id = p_invitee_device_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', '邀请成功，已赠送 ' || v_each || ' 次使用额度',
        'bonus', v_bonus
    );
END;
$$;
