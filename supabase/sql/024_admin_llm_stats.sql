-- ============================================================
-- 军师 - LLM 成本统计 admin_llm_stats（v187，后台成本数据）
--
-- 数据源：llm_usage_log（ima-proxy 每轮批量落库）
-- 口径（用户拍板）：
--   - "一轮" = GROUP BY request_id（该轮主回复+重试+辅助调用合计）
--   - 精确计价：峰谷（高峰=北京时间 9:00-12:00、14:00-18:00，其余空闲，官方未区分周末）
--     + 三档（缓存命中输入/未命中输入/输出）分别计价
--   - 价格：V4-Flash。2026-08-17 00:00（北京时间）起新价（官方 8/13 公告）：
--       空闲 命中0.05 / 未命中1.5 / 输出4.5（元/M）；高峰 ×2
--       旧价（8/17 前）：命中0.02 / 未命中1 / 输出2
--   - 缓存命中率 = hit_tokens / (hit_tokens + miss_tokens)
-- 返回：{ daily: 近7天逐日[7], weekly: 本周, monthly: 本月 }
--   每项：{ period, calls(轮数), total_tokens, avg_tokens(平均token/轮),
--           total_cost(元), avg_cost(平均元/轮), cache_hit_rate(0-1) }
-- 鉴权：SECURITY DEFINER + profiles.is_admin 校验（同 admin_stats）
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- ============================================================

-- 单行计价（元）：V4-Flash 新旧价 + 峰谷判定
CREATE OR REPLACE FUNCTION public.llm_row_cost(
    p_prompt int, p_comp int, p_hit int, p_miss int, p_created timestamptz)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT round((
      p_hit  * (CASE WHEN p_created < '2026-08-17 00:00:00+08' THEN 0.02
                     WHEN EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 9 AND 11
                       OR EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 14 AND 17 THEN 0.10
                     ELSE 0.05 END)
    + p_miss * (CASE WHEN p_created < '2026-08-17 00:00:00+08' THEN 1
                     WHEN EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 9 AND 11
                       OR EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 14 AND 17 THEN 3.0
                     ELSE 1.5 END)
    + p_comp * (CASE WHEN p_created < '2026-08-17 00:00:00+08' THEN 2
                     WHEN EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 9 AND 11
                       OR EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 14 AND 17 THEN 9.0
                     ELSE 4.5 END)
  ) / 1000000.0, 6)::numeric;
$$;

-- 周期聚合公共块（按 request_id 归一轮）
-- 返回 jsonb 数组或对象：period/calls/total_tokens/avg_tokens/total_cost/avg_cost/cache_hit_rate
CREATE OR REPLACE FUNCTION public.admin_llm_stats()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin boolean;
    v_daily jsonb;
    v_weekly jsonb;
    v_monthly jsonb;
    -- 上海时区"今天零点"的 timestamptz（date_trunc 上海本地 → 再标成上海时区时刻）
    v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
    v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
    v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
BEGIN
    SELECT is_admin INTO v_admin FROM public.profiles WHERE id = auth.uid();
    IF NOT coalesce(v_admin, false) THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;

    -- 近 7 天逐日（空天补 0）
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.period), '[]'::jsonb) INTO v_daily
    FROM (
        SELECT d.day AS period,
               coalesce(a.calls, 0) AS calls,
               coalesce(a.total_tokens, 0) AS total_tokens,
               round(coalesce(a.total_tokens, 0)::numeric / nullif(a.calls, 0), 0) AS avg_tokens,
               round(coalesce(a.total_cost, 0)::numeric, 4) AS total_cost,
               round(coalesce(a.total_cost, 0)::numeric / nullif(a.calls, 0), 6) AS avg_cost,
               round(coalesce(a.cache_hit_rate, 0)::numeric, 4) AS cache_hit_rate
        FROM (
            -- 先转上海本地时间再取 date（直接对 timestamptz::date 会按会话时区 UTC 截断 → 日期错位一天）
            SELECT ((v_today_start AT TIME ZONE 'Asia/Shanghai') - (s || ' days')::interval)::date AS day
            FROM generate_series(0, 6) s
        ) d
        LEFT JOIN (
            SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
                   count(DISTINCT request_id) AS calls,
                   sum(prompt_tokens + completion_tokens) AS total_tokens,
                   sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                       cache_hit_tokens, cache_miss_tokens, created_at)) AS total_cost,
                   (sum(cache_hit_tokens)::numeric
                     / nullif(sum(cache_hit_tokens + cache_miss_tokens), 0)) AS cache_hit_rate
            FROM public.llm_usage_log
            WHERE created_at >= v_today_start - interval '6 days'
            GROUP BY 1
        ) a ON a.day = d.day
    ) t;

    -- 本周（周一至今）
    SELECT to_jsonb(t) INTO v_weekly
    FROM (
        SELECT '本周' AS period,
               count(DISTINCT request_id) AS calls,
               sum(prompt_tokens + completion_tokens) AS total_tokens,
               round(sum(prompt_tokens + completion_tokens)::numeric
                     / nullif(count(DISTINCT request_id), 0), 0) AS avg_tokens,
               round(sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                     cache_hit_tokens, cache_miss_tokens, created_at))::numeric, 4) AS total_cost,
               round((sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                     cache_hit_tokens, cache_miss_tokens, created_at))
                     / nullif(count(DISTINCT request_id), 0))::numeric, 6) AS avg_cost,
               round((sum(cache_hit_tokens)::numeric
                     / nullif(sum(cache_hit_tokens + cache_miss_tokens), 0))::numeric, 4) AS cache_hit_rate
        FROM public.llm_usage_log
        WHERE created_at >= v_week_start
    ) t;

    -- 本月（1 号至今）
    SELECT to_jsonb(t) INTO v_monthly
    FROM (
        SELECT '本月' AS period,
               count(DISTINCT request_id) AS calls,
               sum(prompt_tokens + completion_tokens) AS total_tokens,
               round(sum(prompt_tokens + completion_tokens)::numeric
                     / nullif(count(DISTINCT request_id), 0), 0) AS avg_tokens,
               round(sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                     cache_hit_tokens, cache_miss_tokens, created_at))::numeric, 4) AS total_cost,
               round((sum(public.llm_row_cost(prompt_tokens, completion_tokens,
                     cache_hit_tokens, cache_miss_tokens, created_at))
                     / nullif(count(DISTINCT request_id), 0))::numeric, 6) AS avg_cost,
               round((sum(cache_hit_tokens)::numeric
                     / nullif(sum(cache_hit_tokens + cache_miss_tokens), 0))::numeric, 4) AS cache_hit_rate
        FROM public.llm_usage_log
        WHERE created_at >= v_month_start
    ) t;

    RETURN jsonb_build_object('daily', v_daily, 'weekly', v_weekly, 'monthly', v_monthly);
END;
$$;

-- 仅 authenticated（登录用户）可执行；函数内部自行鉴权 is_admin
GRANT EXECUTE ON FUNCTION public.admin_llm_stats() TO authenticated;
