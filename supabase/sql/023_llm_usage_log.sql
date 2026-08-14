-- ============================================================
-- 军师 - LLM 调用 usage 落库（v186，后台成本统计数据源）
--
-- 背景：ima-proxy 的 llmChat 已采集每次调用的 usage（token 数），
--       但只透传 _debug.llm_usage、未落库 → 后台无法聚合"每天/每周/每月
--       平均 token/条、元/条、缓存命中率"。
--
-- 设计：
--   - 明细表：一行 = 一次 LLM 调用（主回复/重试/辅助调用都记）
--   - request_id = 一轮一个（Edge Function 每请求独立沙箱，顶层变量赋值）
--     → 聚合时 GROUP BY request_id 即"一轮对话"（用户口径）
--   - cache_hit/cache_miss 拆分存储：DeepSeek 缓存命中输入价远低于未命中，
--     精确计价必需；缓存命中率 = hit/(hit+miss)
--   - 写：仅 service_role（REST service_role JWT 写入，绕过 RLS）
--     读：admin_llm_stats RPC（SECURITY DEFINER + is_admin 校验）
--
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.llm_usage_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      text NOT NULL,          -- 一轮一个（前端无关，后端每请求生成）
    session_id      uuid,                   -- 会话 ID（可空：辅助调用前可能无）
    stage           text NOT NULL,          -- main_reply / retry / aux_*（llmChat 的 _stage）
    model           text DEFAULT '',        -- 实际模型名（llmModel）
    prompt_tokens   int  NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cache_hit_tokens   int NOT NULL DEFAULT 0,
    cache_miss_tokens  int NOT NULL DEFAULT 0,
    thinking        text DEFAULT '',        -- 实际思考档位（off/low/high/max）
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- 聚合查询用索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON public.llm_usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_request ON public.llm_usage_log (request_id);

-- 安全：RLS 开启，不建任何 anon/authenticated 策略 → 匿名/登录用户默认全拒；
--       service_role 天然绕过 RLS 可写；读取走 SECURITY DEFINER RPC
ALTER TABLE public.llm_usage_log ENABLE ROW LEVEL SECURITY;

-- 关键：管理 API 建表不会继承 default privileges → service_role 必须显式授权
--   （缺这步 ima-proxy 用 service_role REST 写库会静默 401/无权限，冒烟实测踩坑）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.llm_usage_log TO service_role;
