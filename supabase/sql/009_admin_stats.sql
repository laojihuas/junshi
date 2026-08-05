-- ============================================================
-- 军师 - 后台统计 admin_stats（v20260805 设备体系口径）
--
-- 背景：admin 前端旧统计直查 profiles + usage_count（邮箱登录时代字段，
--       设备体系上线后 usage_count 不再更新；profiles 行数 ≠ 真实用户数，
--       匿名登录每次清缓存都会新建行）。
--
-- 新口径：用户数 = devices 行数（真实注册设备）；
--         调用次数 = daily_quota.used_count 累计（含今日与历史）；
--         历史总调用另给 msg_assistant（chat_messages 计数）。
--
-- 鉴权：SECURITY DEFINER，校验 profiles.is_admin = true（auth.uid()），
--       非 admin 返回 {"error":"forbidden"}。仅 authenticated 可执行。
-- 前端调用：sb.rpc('admin_stats')
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- ============================================================
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

    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_list
    FROM (
        SELECT d.device_id, d.created_at, d.is_vip, d.vip_expires_at, d.invite_bonus,
               coalesce(dq.used_count, 0) AS today_calls,
               (SELECT coalesce(sum(used_count), 0) FROM public.daily_quota x WHERE x.device_id = d.device_id) AS total_calls
        FROM public.devices d
        LEFT JOIN public.daily_quota dq ON dq.device_id = d.device_id AND dq.day = v_day
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

-- 仅 authenticated（登录用户）可执行；函数内部自行鉴权 is_admin
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;
