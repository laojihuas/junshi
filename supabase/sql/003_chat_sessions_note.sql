-- ============================================================
-- 军师 - 好友备注（chat_sessions.note）
--
-- 用途：好友列表支持"改名 + 备注"，备注会直接显示在好友名
-- 字后面（如"小红 · 25岁/165"），用于标记年龄/身高/关系等
-- 关键信息，30 字上限。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

alter table public.chat_sessions
  add column if not exists note varchar(30) not null default '';
