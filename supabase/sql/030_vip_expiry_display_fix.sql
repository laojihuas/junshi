-- ============================================================
-- 军师 - VIP 过期显示修复（v030，2026-09-09）
--
-- 背景：laojihua 等账号 VIP 已到期（vip_expires_at < now），但用户界面仍显示
--       "VIP1天"。根因链：
--       ① accounts.is_vip 是激活时置位的存储值，过期不清零（无定时任务）；
--       ② login_account RPC 直接透传 v_acc.is_vip（无过期判断）→ account-auth
--          sync/login 拿到的 is_vip=true；
--       ③ 前端 auth.js 用 Math.max(1, Math.ceil((expires-now)/86400000)) 算天数，
--          过期时差值为负 → Math.max(1, 负) 恒等于 1 → 顶栏显示 "VIP1天"。
--       对照：get_quota_status / check_and_consume_quota 均实时判断
--          is_vip AND vip_expires_at > now()（正确口径，额度端早已按过期处理）。
--
-- 修复：
--   A. login_account 返回实时 is_vip / vip_days_left（对齐 get_quota_status）——
--      根治：任何调用方（sync/login/后续）都拿正确值。
--   B. 存量清理：过期但仍 is_vip=true 的 accounts/devices 置 false，
--      让后台列表与 RPC 口径一致。（续期不受影响：activate 从
--      greatest(now(), 旧 vip_expires_at) 起算，旧到期时间仍保留在列上）
--
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- 前端配套：js/auth.js refreshAccountStatus/_applyAccountSession 已改为
--           按 vip_expires_at 实时判定 is_vip + 天数下限 0（双保险）；
--           js/friends.js 显示条件加 vip_days_left > 0。
-- ============================================================

-- A. login_account 实时化
CREATE OR REPLACE FUNCTION public.login_account(
    p_account_user_id uuid,
    p_session_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_acc public.accounts%rowtype;
    v_vip  boolean;
    v_days int;
    v_day  date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
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
    -- [v030 修复] 实时计算：存储位过期不清零，必须按到期时间判断（对齐 get_quota_status）
    v_vip := v_acc.is_vip AND v_acc.vip_expires_at IS NOT NULL AND v_acc.vip_expires_at > now();
    v_days := CASE WHEN v_vip THEN greatest(1, (v_acc.vip_expires_at::date - v_day)) ELSE 0 END;
    RETURN jsonb_build_object(
        'success', true,
        'account_name', v_acc.account_name,
        'invite_code', v_acc.invite_code,
        'invite_bonus', v_acc.invite_bonus,
        'is_vip', v_vip,
        'vip_days_left', v_days,
        'vip_expires_at', v_acc.vip_expires_at,
        'device_id', v_acc.device_id
    );
END;
$$;

-- B. 存量清理：过期账号/设备 is_vip 置 false（幂等，可重复执行）
UPDATE public.accounts
SET is_vip = false, updated_at = now()
WHERE is_vip AND vip_expires_at IS NOT NULL AND vip_expires_at < now();

UPDATE public.devices
SET is_vip = false, updated_at = now()
WHERE is_vip AND vip_expires_at IS NOT NULL AND vip_expires_at < now();

-- 验证：
--   SELECT account_name, is_vip, vip_expires_at FROM accounts WHERE account_name LIKE 'laojihua%';
--   期望 is_vip=false（过期已清）
--   SELECT id, is_vip, vip_expires_at FROM accounts
--   WHERE vip_expires_at IS NOT NULL AND vip_expires_at > now() AND NOT is_vip;  -- 期望 0 行（误清检查）
