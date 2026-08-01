-- ============================================================
-- 军师 - 记忆卡字段（chat_sessions.memory_card）
--
-- 用途：存储跨窗口共享的"对方画像记忆卡"（JSON 文本）：
--   { profile:{stage,personality,relationship_note,recent_events},
--     recent_user_messages:[],      对方说过的话（≤20 条）
--     recent_self_messages:[],      军师(自己)发过的话（v9 新增，防重复）
--     strategy:{...}, updated_at }
-- 隔离边界：按 chat_sessions.id（好友）存储，RLS 按 user_id 兜底，
--   不同好友之间记忆永不交叉。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本（幂等）
-- ============================================================

alter table public.chat_sessions
  add column if not exists memory_card text;
