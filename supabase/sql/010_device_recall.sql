-- ============================================================
-- 军师 - 设备召回（v20260805 方案C 兜底式）
--
-- 背景：方案A(Cookie 兜底)已封住"清缓存"路径，但 FingerprintJS 走
-- jsdelivr CDN 时好时坏，加载失败时前端走 fallback 生成 'fp_'+hash 备用指纹。
-- 若某次访问指纹服务成功(visitorId) 某次失败(fp_xxx)，同一台机器会在
-- 两个 ID 间横跳 → 旧 ID 已注册、新 ID 是新设备 → 免费档回满刷额度。
--
-- 召回设计（兜底式，仅对 fallback 设备启用，正常指纹路径零影响）：
--   register_device 遇到"新设备且 device_id 以 fp_ 开头"时，尝试按
--   多信号召回 30 天内的老设备：
--     同 last_ip + 同 fp_ua(服务端算的 UA 哈希) + 同 fp_screen + 同 fp_tz
--     + 同 fp_lang + 创建 30 天内
--   命中 → 返回 { success, registered:false, recalled:true,
--                 recalled_device_id:<老ID>, 老设备状态 }
--         不写新行（前端换用老 ID 后幂等命中已存在分支）
--   未命中 → 正常注册新设备（写指纹特征列，供后续召回）
--   非 fp_ 前缀新设备 → 完全不受影响（FingerprintJS 指纹稳定，无需召回）
--
-- 误并防护：多信号全等才召回（公司同批设备同 WiFi 场景才可能误并，
-- 发生率 ~0.5-1%，且仅影响 fallback 时刻；正常指纹路径永远不触发）
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- 注意：register_device 签名变更（新增 4 个指纹参数），旧签名函数 DROP
-- ============================================================

-- 1. devices 表增加召回信号列
ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS last_ip  text,   -- 最近一次注册/使用 IP（每次 register 更新）
    ADD COLUMN IF NOT EXISTS fp_ua    text,   -- UA 哈希（服务端 device-gate 计算）
    ADD COLUMN IF NOT EXISTS fp_screen text,  -- 屏幕 "1920x1080"
    ADD COLUMN IF NOT EXISTS fp_tz     text,  -- 时区偏移分钟 "-480"
    ADD COLUMN IF NOT EXISTS fp_lang   text;  -- 语言 "zh-CN"

CREATE INDEX IF NOT EXISTS idx_devices_recall
    ON public.devices (last_ip, fp_ua, fp_screen, fp_tz, fp_lang)
    WHERE last_ip IS NOT NULL AND last_ip <> '';

-- 2. 重定义 register_device（签名变更：+p_fp_ua, p_fp_screen, p_fp_tz, p_fp_lang）
DROP FUNCTION IF EXISTS public.register_device(text, text, text, uuid);

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
    v_code     text := upper(btrim(coalesce(p_invite_code, '')));
    v_inviter  public.devices%rowtype;
    v_dev      public.devices%rowtype;
    v_recall   public.devices%rowtype;
    v_free     int;
    v_is_fb    boolean := p_device_id LIKE 'fp\_%';
BEGIN
    PERFORM public.ensure_profile(p_user_id);

    -- 已注册设备：直接返回状态（顺手更新 last_ip 便于召回匹配；不动其他）
    SELECT * INTO v_dev FROM public.devices WHERE device_id = p_device_id;
    IF FOUND THEN
        IF p_ip IS NOT NULL AND p_ip <> '' AND v_dev.last_ip IS DISTINCT FROM p_ip THEN
            UPDATE public.devices SET last_ip = p_ip, updated_at = now() WHERE device_id = p_device_id;
        END IF;
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

    -- [方案C 召回] 仅 fallback 指纹设备（fp_ 前缀）且 IP/指纹特征齐备时尝试召回
    IF v_is_fb
       AND p_ip IS NOT NULL AND p_ip <> ''
       AND p_fp_ua IS NOT NULL AND p_fp_ua <> ''
       AND p_fp_screen IS NOT NULL AND p_fp_screen <> ''
    THEN
        SELECT * INTO v_recall
        FROM public.devices
        WHERE last_ip = p_ip
          AND fp_ua = p_fp_ua
          AND fp_screen = p_fp_screen
          AND (p_fp_tz IS NULL OR fp_tz = p_fp_tz)
          AND (p_fp_lang IS NULL OR fp_lang = p_fp_lang)
          AND created_at > now() - interval '30 days'
        ORDER BY updated_at DESC
        LIMIT 1;

        IF FOUND THEN
            v_free := CASE
                WHEN (now() - v_recall.created_at) < interval '3 days' THEN 50
                WHEN (now() - v_recall.created_at) < interval '7 days' THEN 30
                ELSE 15
            END;
            -- 更新老设备 last_ip（保持召回链路活跃）
            IF v_recall.last_ip IS DISTINCT FROM p_ip THEN
                UPDATE public.devices SET last_ip = p_ip, updated_at = now() WHERE device_id = v_recall.device_id;
            END IF;
            RETURN jsonb_build_object(
                'success', true, 'registered', false, 'recalled', true,
                'recalled_device_id', v_recall.device_id,
                'invite_bonus', v_recall.invite_bonus,
                'is_vip', v_recall.is_vip,
                'vip_expires_at', v_recall.vip_expires_at,
                'free_daily', v_free,
                'inviter_code', v_recall.inviter_code,
                'invite_redeemed', v_recall.inviter_device_id IS NOT NULL
            );
        END IF;
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

    INSERT INTO public.devices (device_id, inviter_code, last_ip, fp_ua, fp_screen, fp_tz, fp_lang)
    VALUES (p_device_id, NULLIF(v_code, ''), p_ip, p_fp_ua, p_fp_screen, p_fp_tz, p_fp_lang);

    -- [v20260805 fix] 设备落库成功后才计数：new_devices 永远 = 实际新注册数
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

-- 3. 授权（新签名）
GRANT EXECUTE ON FUNCTION public.register_device(text, text, text, uuid, text, text, text, text) TO service_role;
