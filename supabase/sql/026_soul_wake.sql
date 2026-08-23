-- ============================================================
-- 026_soul_wake.sql
-- 军师 - 主动唤醒（v210，直连专属辅助功能）
--
-- 用途：Shizuku 脚本免登录直连 ima-proxy 时，携带 mode=wake 拉取
--   "该主动唤醒的会话名单"。ima-proxy 侧判定规则（用户拍板 v210）：
--     ① 仅 api_key 直连模式生效（网页版完全不参与，不影响主架构）
--     ② 阶段：memory_card.profile.stage ∈ 吸引/舒适/恋爱（"吸引阶段以上"）
--     ③ 沉默判定：该会话最后一条消息距今 > wake_hours（默认 22 小时）
--     ④ 时间窗：北京时间 [wake_start_hour, wake_end_hour)（默认 10:00-24:00，
--        跳过休息时段；end=24 表示含到 23:59）
--     ⑤ 只唤醒一次：last_wake_at 为空或早于最后一条消息时间才触发
--        （唤醒后对方回了新消息 → 新一轮沉默期才可再唤醒）
--     ⑥ 生成话术 = LLM 新话题（配合当前时间，不接旧话题），生成即落库
--        chat_messages(role=assistant) + 置 last_wake_at → 下次直连接话上下文连续
--   Shizuku 不常开 → 打空是常态：脚本不启动 = 无调用 = 无副作用（纯辅助）
--
-- 幂等：rerun 安全。
-- 执行位置：管理 API database/query 或 Dashboard SQL Editor
-- ============================================================

-- 1) 会话级防重标记：last_wake_at > 最后一条消息时间 → 本次沉默期已唤醒过
alter table public.chat_sessions
  add column if not exists last_wake_at timestamptz;

-- 2) 唤醒默认配置（并入 quota_params JSON，后台"配额参数"卡可见可调；
--    与 021/022 同款 jsonb 合并写法：已有 key 保留，缺省补默认）
update public.app_config
set quota_params = (
  coalesce(quota_params::jsonb, '{}'::jsonb)
  || '{"wake_enabled":1,"wake_hours":22,"wake_start_hour":10,"wake_end_hour":24}'::jsonb
)::text,
    updated_at = now()
where id = 1;
