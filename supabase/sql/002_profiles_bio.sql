-- ============================================================
-- 军师 - 用户个人简介（profiles.bio）
--
-- 用途：用户可在"我的简介"中填写个性化信息（名字、年龄、爱好、
-- 经历等，上限 200 字），对话时由 ima-proxy 服务端读取并注入
-- 生成上下文，组装顺序：统一提示词 > 用户简介 > 会话上下文 > 当前内容。
--
-- 执行位置：Supabase Dashboard → SQL Editor → 运行本脚本
-- ============================================================

-- 给 profiles 增加 bio 字段（200 字上限，前端 maxlength 限制，
-- 数据库 varchar(200) 兜底）
alter table public.profiles
  add column if not exists bio varchar(200) not null default '';
