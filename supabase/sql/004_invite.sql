-- ============================================================
-- 军师 - 邀请功能（v20260801）
--
-- 1. profiles 增加 invite_code 字段（8位唯一邀请码）
-- 2. 新建 invite_relations 表记录邀请关系（一个账号只能被一个邀请人绑定）
-- 3. 创建 redeem_invite 原子兑现函数：注册成功后给邀请人 +50 次使用额度
--    （SECURITY DEFINER 单条 SQL 事务，防重复绑定 / 防刷上限 20 人）
--
-- 注意：redeem_invite 上限 20 人 = 1000 次额度，如想调整改
--       v_max_invites 即可（重新执行本脚本会覆盖函数）。
-- ============================================================

-- 1. profiles 邀请码字段（8 位大写字母数字，去掉易混淆字符 0/O/1/I）
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS invite_code VARCHAR(8);

-- 唯一索引（NULL 不参与唯一约束，存量用户不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_invite_code
    ON public.profiles (invite_code)
    WHERE invite_code IS NOT NULL;

-- 2. 邀请关系表
CREATE TABLE IF NOT EXISTS public.invite_relations (
    id            BIGSERIAL PRIMARY KEY,
    inviter_id    UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
    invitee_id    UUID NOT NULL UNIQUE REFERENCES public.profiles (id) ON DELETE CASCADE,
    invitee_email TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_relations_inviter
    ON public.invite_relations (inviter_id);

-- 3. 原子兑现函数：注册成功后给邀请人 +50 次额度
--    入参：邀请人 id、被邀请人 id、被邀请人邮箱
--    返回：{ success, message, usage_count? }
CREATE OR REPLACE FUNCTION public.redeem_invite(
    p_inviter  uuid,
    p_invitee  uuid,
    p_invitee_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_max_invites int := 20;           -- 单个邀请码最多生效人数（防刷）
    v_count  int;
    v_usage  int;
    v_exists uuid;
BEGIN
    -- 不能邀请自己
    IF p_inviter = p_invitee THEN
        RETURN jsonb_build_object('success', false, 'message', '不能填写自己的邀请码');
    END IF;

    -- 被邀请人必须真实存在（已注册）
    SELECT id INTO v_exists FROM profiles WHERE id = p_invitee;
    IF v_exists IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '用户不存在');
    END IF;

    -- 一个账号只能被绑定一次
    PERFORM 1 FROM invite_relations WHERE invitee_id = p_invitee;
    IF FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '该账号已绑定过邀请人');
    END IF;

    -- 邀请人收益上限（防刷）
    SELECT count(*) INTO v_count FROM invite_relations WHERE inviter_id = p_inviter;
    IF v_count >= v_max_invites THEN
        RETURN jsonb_build_object('success', false, 'message', '该邀请码已达兑换上限');
    END IF;

    -- 写邀请关系
    INSERT INTO invite_relations (inviter_id, invitee_id, invitee_email)
    VALUES (p_inviter, p_invitee, p_invitee_email);

    -- 给邀请人 +50 次额度
    SELECT usage_count INTO v_usage FROM profiles WHERE id = p_inviter;
    v_usage := coalesce(v_usage, 0) + 50;
    UPDATE profiles SET usage_count = v_usage WHERE id = p_inviter;

    RETURN jsonb_build_object(
        'success', true,
        'message', '邀请成功，已赠送 50 次使用额度',
        'usage_count', v_usage
    );
END;
$$;

-- 授权（调用方带 service_role / 或直接执行，均可用）
GRANT EXECUTE ON FUNCTION public.redeem_invite(uuid, uuid, text) TO service_role;
