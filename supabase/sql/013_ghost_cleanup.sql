-- ============================================================
-- 军师 - 幽灵设备清理（v20260806）
--
-- 背景：register_device 在每次匿名登录时无条件 INSERT，
--   测试脚本/IP 漂移/无痕模式都会产生 device 行。admin_stats
--   按 devices 行数报"用户数"，产生"幽灵用户"假象。
--
-- 本脚本提供：
--   cleanup_ghost_devices(p_dry_run boolean) → jsonb
--     规则 A：设备 ID 命中测试前缀（^toktest_|^test_|^pytest_|^debug_|^jstest_）
--             → 立即清理（不论活跃/绑定），脚本专用命名不会有真人用
--     规则 B：fp_ 前缀（fallback 设备） + 创建 > 7 天 + 完全无绑定
--             （无 invite_code / 无 activation_code / 无 account.device_id /
--              无 daily_quota 行）
--             → fp 是 FingerprintJS 漂移/无痕访问产生，孤岛 = 一次性访客
--     dry_run = true  返回候选列表但不删（用于 admin 按钮预览）
--     dry_run = false 真删，返回删除数
--
-- 鉴权：SECURITY DEFINER + 校验 profiles.is_admin = true，非 admin 返 forbidden。
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本（幂等）
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_ghost_devices(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_admin boolean;
    v_a_ids     text[] := '{}';
    v_b_ids     text[] := '{}';
    v_a_count   int;
    v_b_count   int;
BEGIN
    -- 鉴权
    SELECT is_admin INTO v_has_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_has_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    -- 规则 A：测试前缀（脚本命名，绝无真人用）
    SELECT coalesce(array_agg(t.device_id), '{}')
      INTO v_a_ids
      FROM (
        SELECT device_id
          FROM public.devices
         WHERE device_id ~ '^(toktest_|test_|pytest_|debug_|jstest_)'
         ORDER BY created_at
      ) t;

    -- 规则 B：fp_ fallback 设备 + 完全无绑定 + 7 天以上未活跃
    SELECT coalesce(array_agg(d.device_id), '{}')
      INTO v_b_ids
      FROM public.devices d
     WHERE d.device_id LIKE 'fp\_%'                    -- escape _ for LIKE
       AND d.created_at < now() - interval '7 days'
       AND coalesce(d.invite_code, '') = ''
       AND d.activation_code IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.device_id = d.device_id)
       AND NOT EXISTS (
            SELECT 1 FROM public.daily_quota q
             WHERE q.identity_type = 'device'
               AND q.identity_key  = d.device_id
       );

    v_a_count := coalesce(array_length(v_a_ids, 1), 0);
    v_b_count := coalesce(array_length(v_b_ids, 1), 0);

    IF NOT p_dry_run THEN
        IF v_a_count > 0 THEN
            DELETE FROM public.devices WHERE device_id = ANY(v_a_ids);
        END IF;
        IF v_b_count > 0 THEN
            DELETE FROM public.devices WHERE device_id = ANY(v_b_ids);
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'dry_run', p_dry_run,
        'rule_a_test_prefix', jsonb_build_object(
            'rule', 'device_id ~ ^(toktest_|test_|pytest_|debug_|jstest_)',
            'count', v_a_count,
            'device_ids', to_jsonb(v_a_ids)
        ),
        'rule_b_fp_island', jsonb_build_object(
            'rule', 'fp_* >7d 孤立设备（无绑定/无 quota）',
            'count', v_b_count,
            'device_ids', to_jsonb(v_b_ids)
        ),
        'total_removed', CASE WHEN p_dry_run THEN 0 ELSE v_a_count + v_b_count END
    );
END;
$$;

-- 授权：anon/authenticated 都能调（函数内自鉴 is_admin）
GRANT EXECUTE ON FUNCTION public.cleanup_ghost_devices(boolean) TO authenticated, service_role;
