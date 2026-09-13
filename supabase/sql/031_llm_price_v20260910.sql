-- ============================================================
-- 军师 - LLM 计价更新（v222）
--
-- 官方公告：北京时间 2026-09-10 12:00 起调整 flash 系列定价
--   空闲时段：输入缓存命中 0.02 元、输入缓存未命中 1 元、输出 4 元（元/百万 token）
--   高峰时段：空闲价的 2 倍（0.04 / 2 / 8）
-- 高峰时段口径沿用官方原定义：**工作日**北京时间 9:00-12:00、14:00-18:00；周末全天低谷
--   （v214 已修：周末高峰时段不再被误算 ×2）
--
-- 价格时间轴（元/百万 token，空闲价）：
--   a) < 2026-08-17 00:00              命中 0.02 / 未命中 1   / 输出 2
--   b) 2026-08-17 00:00 ~ 09-10 12:00  命中 0.05 / 未命中 1.5 / 输出 4.5
--   c) >= 2026-09-10 12:00             命中 0.02 / 未命中 1   / 输出 4    ← 本次
--
-- 说明：只换价格表，计价口径（按 request_id 归一轮、三档 × 峰谷）不变。
-- 鉴权：llm_row_cost 为 IMMUTABLE 纯计算函数，无鉴权；调用方 admin_llm_stats 自校验 is_admin
-- 执行位置：Supabase Dashboard → SQL Editor（或管理 API database/query）
-- ============================================================

-- 单行计价（元）：V4-Flash 三段时间价 × 峰谷倍数
-- 重构为 [基础价子查询 b] × [峰谷倍数子查询 m]，避免高峰判定表达式在三个 CASE 里重复 6 次
CREATE OR REPLACE FUNCTION public.llm_row_cost(
    p_prompt int, p_comp int, p_hit int, p_miss int, p_created timestamptz)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT round((
      p_hit  * b.hit  * m.mult
    + p_miss * b.miss * m.mult
    + p_comp * b.comp * m.mult
  )::numeric / 1000000, 6)
  FROM (
      SELECT
        CASE WHEN p_created <  '2026-08-17 00:00:00+08' THEN 0.02
             WHEN p_created <  '2026-09-10 12:00:00+08' THEN 0.05
             ELSE 0.02 END AS hit,
        CASE WHEN p_created <  '2026-08-17 00:00:00+08' THEN 1
             WHEN p_created <  '2026-09-10 12:00:00+08' THEN 1.5
             ELSE 1 END AS miss,
        CASE WHEN p_created <  '2026-08-17 00:00:00+08' THEN 2
             WHEN p_created <  '2026-09-10 12:00:00+08' THEN 4.5
             ELSE 4 END AS comp
  ) b,
  (
      SELECT CASE
        WHEN p_created >= '2026-08-17 00:00:00+08'   -- 8/17 前为早期价格，官方口径无峰谷（原实现即如此，勿回退）
         AND EXTRACT(isodow FROM p_created AT TIME ZONE 'Asia/Shanghai') < 6
         AND (EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 9 AND 11
           OR EXTRACT(hour FROM p_created AT TIME ZONE 'Asia/Shanghai') BETWEEN 14 AND 17)
        THEN 2 ELSE 1 END AS mult
  ) m;
$$;

-- 验证：100 万命中 + 100 万未命中的空闲时段成本
--   改价前（09-10 11:00，仍在高峰时段外）应 = 0.05 + 1.5 = 1.55
--   改价后（09-10 13:00）应 = 0.02 + 1   = 1.02
SELECT public.llm_row_cost(0, 0, 1000000, 1000000, '2026-09-10 11:00:00+08') AS before_new_price,
       public.llm_row_cost(0, 0, 1000000, 1000000, '2026-09-10 13:00:00+08') AS after_new_price,
       public.llm_row_cost(0, 0, 1000000, 1000000, '2026-09-14 10:00:00+08') AS after_peak,
       public.llm_row_cost(0, 0, 1000000, 1000000, '2026-09-13 10:00:00+08') AS after_weekend_offpeak;
