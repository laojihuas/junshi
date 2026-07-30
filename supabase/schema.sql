-- ============================================================
-- 军师 - 恋爱聊天指导工具 · 数据库 Schema
-- Supabase SQL 初始化脚本（idempotent - 可重复运行）
-- ============================================================

-- ============================================================
-- 第 0 步：基础 GRANT 权限（关键修复！）
-- Supabase 的 anon 和 authenticated 角色需要这些权限才能访问表
-- ============================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- 0. 扩展用户表（Supabase Auth 自动生成 auth.users，通过触发器同步到 public.profiles）
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    phone TEXT,
    nickname TEXT DEFAULT '',
    usage_count INTEGER NOT NULL DEFAULT 0,
    is_vip BOOLEAN NOT NULL DEFAULT false,
    vip_expires_at TIMESTAMPTZ,
    device_id TEXT,
    activated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 显式授权（防止 Supabase 默认权限丢失）
GRANT SELECT, INSERT, UPDATE ON public.profiles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_sessions TO anon, authenticated;
GRANT SELECT, INSERT ON public.chat_messages TO anon, authenticated;
GRANT SELECT ON public.activation_codes TO anon, authenticated;
GRANT INSERT, UPDATE ON public.activation_codes TO authenticated;

-- 自动创建 profile 的触发器（SECURITY DEFINER 绕过 RLS）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, phone)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.phone
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 1. chat_sessions 聊天会话表（每个好友一个会话）
CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    friend_name TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#07C160',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON public.chat_sessions(user_id);

-- 2. chat_messages 聊天消息表
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON public.chat_messages(session_id);

-- 3. activation_codes 激活码表
CREATE TABLE IF NOT EXISTS public.activation_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    used BOOLEAN NOT NULL DEFAULT false,
    used_by UUID REFERENCES public.profiles(id),
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activation_codes_code ON public.activation_codes(code);

-- 4. 自动更新 updated_at 的函数
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_chat_sessions_updated_at ON public.chat_sessions;
CREATE TRIGGER update_chat_sessions_updated_at
    BEFORE UPDATE ON public.chat_sessions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 5. Row Level Security (RLS) 策略
-- ============================================================

-- 开启 RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;

-- 清理旧策略（让脚本可重复运行）
DROP POLICY IF EXISTS "users_read_own_profile" ON public.profiles;
DROP POLICY IF EXISTS "users_update_own_profile" ON public.profiles;
DROP POLICY IF EXISTS "users_insert_own_profile" ON public.profiles;
DROP POLICY IF EXISTS "users_manage_own_sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "users_select_own_sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "users_insert_own_sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "users_update_own_sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "users_delete_own_sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "users_read_own_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "users_insert_own_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "public_read_activation_codes" ON public.activation_codes;

-- profiles：用户只能看/改自己的数据
CREATE POLICY "users_read_own_profile"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "users_update_own_profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- chat_sessions：拆分为明确的四个策略
CREATE POLICY "users_select_own_sessions"
    ON public.chat_sessions FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_sessions"
    ON public.chat_sessions FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_update_own_sessions"
    ON public.chat_sessions FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_sessions"
    ON public.chat_sessions FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- chat_messages：通过会话归属控制
CREATE POLICY "users_read_own_messages"
    ON public.chat_messages FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

CREATE POLICY "users_insert_own_messages"
    ON public.chat_messages FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

-- activation_codes：公开可读（用于验证）
CREATE POLICY "public_read_activation_codes"
    ON public.activation_codes FOR SELECT
    TO anon, authenticated
    USING (true);

-- ============================================================
-- 6. 管理员后台需要的视图（可选）
-- ============================================================
CREATE OR REPLACE VIEW public.admin_user_stats AS
SELECT
    p.id,
    p.email,
    p.phone,
    p.nickname,
    p.usage_count,
    p.is_vip,
    p.vip_expires_at,
    p.activated_at,
    p.created_at,
    p.device_id,
    COUNT(DISTINCT cs.id) AS session_count,
    COUNT(DISTINCT cm.id) AS message_count
FROM public.profiles p
LEFT JOIN public.chat_sessions cs ON cs.user_id = p.id
LEFT JOIN public.chat_messages cm ON cm.session_id IN (SELECT id FROM public.chat_sessions WHERE user_id = p.id)
GROUP BY p.id, p.email, p.phone, p.nickname, p.usage_count, p.is_vip, p.vip_expires_at, p.activated_at, p.created_at, p.device_id;

-- ============================================================
-- 7. 自动补建缺失 profile（如果之前注册的用户没创建 profile）
-- ============================================================
INSERT INTO public.profiles (id, email, phone)
SELECT au.id, au.email, au.phone
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 8. 诊断查询（运行后可以查看权限和策略是否正确）
-- ============================================================
-- 取消注释下面这行可以查看 chat_sessions 的权限和策略：
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'chat_sessions';
-- SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'chat_sessions';
