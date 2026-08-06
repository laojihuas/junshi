-- ============================================================
-- 015_admin_codes.sql
-- 管理后台：生成激活码 RPC（修复后台无法生成激活码问题）
--
-- 背景：activation_codes 表 RLS 已启用，但只有 SELECT 策略
--       （public_read_activation_codes），无 INSERT 策略。
--       后台旧实现用 anon key + 管理员登录后 sb.from().insert()
--       直插 → 被 RLS 拦截（new row violates row-level security policy）。
-- 方案：按项目既有模式（admin_stats / admin_feedback_* /
--       cleanup_ghost_devices 均 SECURITY DEFINER + is_admin 校验），
--       改走 RPC，规避 RLS 直查。
--
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_generate_codes(p_count int DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_admin boolean;
    v_i int;
    v_j int;
    v_code text;
    v_codes jsonb := '[]'::jsonb;
    v_chars CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
    -- 鉴权：仅 is_admin 可生成激活码
    SELECT is_admin INTO v_has_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_has_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    -- 数量校验：默认 10，上限 200（与前端一致）
    IF p_count IS NULL OR p_count < 1 THEN
        p_count := 10;
    END IF;
    IF p_count > 200 THEN
        p_count := 200;
    END IF;

    -- 生成 16 位 XXXX-XXXX-XXXX-XXXX（大写，去易混淆字符 O/0/I/1）
    FOR v_i IN 1..p_count LOOP
        v_code := '';
        FOR v_j IN 1..16 LOOP
            v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
            IF v_j % 4 = 0 AND v_j < 16 THEN
                v_code := v_code || '-';
            END IF;
        END LOOP;
        BEGIN
            INSERT INTO public.activation_codes (code) VALUES (v_code);
            v_codes := v_codes || to_jsonb(v_code);
        EXCEPTION WHEN unique_violation THEN
            NULL; -- 撞码跳过（极低概率，16 位随机）
        END;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'count', jsonb_array_length(v_codes), 'codes', v_codes);
END;
$$;

-- 仅 authenticated（登录用户，函数内自鉴 is_admin）可执行；
-- service_role 亦放开（管理 API 直调场景），anon 不可用
GRANT EXECUTE ON FUNCTION public.admin_generate_codes(int) TO authenticated, service_role;
