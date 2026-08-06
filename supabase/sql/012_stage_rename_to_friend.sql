-- ============================================================
-- 军师 - 阶段名"普通朋友"→"朋友"  (v20260806)
--
-- 背景：关系阶段名与前端/后端字面量同步改名，
--   并把头像底色从 #5F5E5A（灰）改成 #185FA5（追求蓝）。
-- 受影响：chat_sessions.memory_card 中 profile.stage 等于"普通朋友"的行。
-- 幂等：rerun 安全（无匹配行时 UPDATE 0 影响）。
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

update public.chat_sessions
   set memory_card = replace(memory_card, '"stage":"普通朋友"', '"stage":"朋友"')
 where memory_card is not null
   and memory_card like '%"stage":"普通朋友"%';

-- 复查（应全为 0）
select count(*) as still_remaining
  from public.chat_sessions
 where memory_card is not null
   and memory_card like '%"stage":"普通朋友"%';
