-- ============================================================
-- 军师 - 阶段名"未知"→"陌生"  (v20260809)
--
-- 背景：六关系阶段命名同步改名（未知 → 陌生），
--   并把"朋友"头像底色与"陌生"统一为灰色 #5F5E5A（前端改动）。
-- 受影响：chat_sessions.memory_card 中 profile.stage 等于"未知"的行。
-- 幂等：rerun 安全（无匹配行时 UPDATE 0 影响）。
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

update public.chat_sessions
   set memory_card = replace(memory_card, '"stage":"未知"', '"stage":"陌生"')
 where memory_card is not null
   and memory_card like '%"stage":"未知"%';

-- 复查（应全为 0）
select count(*) as still_remaining
  from public.chat_sessions
 where memory_card is not null
   and memory_card like '%"stage":"未知"%';
