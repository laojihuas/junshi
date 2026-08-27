-- ============================================================
-- 029_story_bank.sql
-- 军师 - 用户经历库（profiles.story_bank，v218）
--
-- 背景：用户把"经历库"写进 bio，但【用户个人简介】块的语义是
--   "真实资料/事实唯一来源/不编造"，与经历库"当成自己的生活自然流露"
--   的定位冲突，导致 LLM 只被动检索、不主动带出。
--   → 拆成独立字段：bio=身份事实源；story_bank=生活经历（高价值展示/邀约引力）。
--   ima-proxy 独立注入【经历库】固定块 + 每轮纯规则联想触发。
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

alter table public.profiles
  add column if not exists story_bank text not null default '';
