-- ============================================================
-- 018_chat_messages_update_policy.sql
-- chat_messages 补充 UPDATE 策略（2026-08-10）
--
-- 背景：前端"重生"按钮（v130）需覆盖旧回复内容（DB.updateMessage），
--   但 chat_messages 仅有 SELECT/INSERT 策略、无 UPDATE 策略，
--   RLS 拦截导致写入静默失败——界面显示新内容、数据库仍是旧内容，
--   页面重载（杀进程恢复）后回退旧回复。
--
-- 方案：新增 users_update_own_messages，与现有 SELECT/INSERT 策略
--   相同的所有权校验（chat_sessions.user_id = auth.uid()），
--   用户只能覆盖自己会话内的消息，不增加额外风险面。
--
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- 配套前端改动：js/chat.js regenMessage 校验 updateMessage 返回值，
--   写入失败即回滚（界面保持旧回复），不再出现界面/数据库不一致。
-- ============================================================

CREATE POLICY "users_update_own_messages" ON public.chat_messages
FOR UPDATE TO public
USING (
    EXISTS (
        SELECT 1 FROM public.chat_sessions
        WHERE chat_sessions.id = chat_messages.session_id
          AND chat_sessions.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.chat_sessions
        WHERE chat_sessions.id = chat_messages.session_id
          AND chat_sessions.user_id = auth.uid()
    )
);
