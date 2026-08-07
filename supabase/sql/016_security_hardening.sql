-- ============================================================
-- 016_security_hardening.sql
-- 安全加固（2026-08-07 全站安全审计修复）
--
-- 背景：审计发现
--   P0-1 activation_codes 表 RLS 策略 public_read_activation_codes qual=true
--        + anon 表级 SELECT → 匿名可拖全部激活码（含未使用）
--   P0-2 admin_user_stats 视图（非 security_invoker，绕过底层 RLS）
--        anon 有 SELECT → 匿名可拖全量用户 email/is_vip/device_id
--   P1-1 配额/会话/激活/管理 RPC 默认 PUBLIC 可 EXECUTE（SECURITY DEFINER
--        无调用者鉴权）→ 任意身份扣配额/踢人/枚举
--   P1-2 accounts/devices/daily_quota/ip_usage/feedback/invite_relations
--        未开启 RLS（仅靠表级 GRANT 兜底，无纵深防御）
--
-- 方案：
--   ① activation_codes 仅 service_role 可访问（前端激活走 activate-code EF）
--   ② admin_user_stats 仅 service_role（已被 admin_stats RPC 取代）
--   ③ 配额/会话/激活 RPC 仅 service_role；管理 RPC 仅 authenticated（函数内 is_admin 校验）
--   ④ 6 张表开启 RLS（默认全拒，service_role 自带 BYPASSRLS 不受影响）
--   ⑤ 新增 admin_list_codes RPC（admin 后台激活码列表替代直查表）
--
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- 配套前端改动：
--   - js/supabase.js 删除 DB.verifyActivationCode（死代码，激活已走 activate-code EF）
--   - admin/index.html loadCodes 改调 admin_list_codes RPC
-- ============================================================

-- ① 收紧 activation_codes：删公开读策略 + 收回 anon/authenticated 全部表权限
DROP POLICY IF EXISTS public_read_activation_codes ON public.activation_codes;
REVOKE ALL ON public.activation_codes FROM anon, authenticated;

-- ② 收紧 admin_user_stats 视图（已被 admin_stats RPC 取代，仅 service_role 可读）
REVOKE ALL ON public.admin_user_stats FROM anon, authenticated;
GRANT SELECT ON public.admin_user_stats TO service_role;

-- ③ 收紧 RPC EXECUTE：配额/会话/激活函数仅 service_role（Edge Function 用）；
--    管理函数仅 authenticated（admin 前端用，函数内 is_admin 校验）
REVOKE EXECUTE ON FUNCTION public.register_device(text, text, text, uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_and_consume_quota(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_account(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.login_account(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_account_session(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.activate_account(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_quota_status(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_profile(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_generate_codes(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_feedback_list() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_feedback_mark(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_ghost_devices(boolean) FROM PUBLIC;
-- 注意：submit_feedback 保留 anon/authenticated（公开反馈入口，014 设计）

-- ④ 开启缺失的 RLS（默认无策略=全拒；service_role 有 BYPASSRLS 属性不受影响）
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_relations ENABLE ROW LEVEL SECURITY;

-- ⑤ 新增 admin_list_codes RPC（admin 后台激活码列表；收紧后替代前端直查表）
CREATE OR REPLACE FUNCTION public.admin_list_codes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin boolean;
    v_list jsonb;
BEGIN
    SELECT is_admin INTO v_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_list
    FROM (
        SELECT code, used, used_account_id, used_at, created_at
        FROM public.activation_codes
        ORDER BY created_at DESC
    ) c;
    RETURN jsonb_build_object('success', true, 'codes', v_list);
END;
$$;

-- ⑥ 授权
GRANT EXECUTE ON FUNCTION public.admin_list_codes() TO authenticated, service_role;
