# -*- coding: utf-8 -*-
# 防重复重试诊断：查 llm_usage_log 里 retry_* 的分布与比例
# 用法：SBP_PAT=<PAT> python retry_stats.py
import json, urllib.request, os, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

API = 'https://api.supabase.com/v1/projects/opzvvgixlfbfpdlsorbi/database/query'

def q(sql):
    req = urllib.request.Request(
        API,
        data=json.dumps({'query': sql}).encode('utf-8'),
        headers={
            'Authorization': 'Bearer ' + (os.environ.get('SBP_PAT') or ''),
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
        }, method='POST')
    try:
        return json.loads(urllib.request.urlopen(req).read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print('ERR', e.code, e.read().decode('utf-8')[:300])
        raise SystemExit(1)

def show(title, rows):
    print('\n== ' + title + ' ==')
    if not rows:
        print('(空)')
        return
    if isinstance(rows[0], dict):
        cols = list(rows[0].keys())
        print(' | '.join(cols))
        for r in rows:
            print(' | '.join(str(r[c]) for c in cols))
    else:
        for r in rows:
            print(r)

# 1) 每日概览（最近 14 天）：轮数 / 主回复 / 重试 / 重试率
show('每日概览（最近14天, 重试率=retry/main_reply）', q("""
select to_char(created_at at time zone 'Asia/Shanghai', 'MM-DD') as day,
  count(distinct request_id) as rounds,
  count(*) filter (where stage = 'main_reply') as main,
  count(*) filter (where stage like 'retry%') as retry,
  round(100.0 * count(*) filter (where stage like 'retry%') / nullif(count(*) filter (where stage = 'main_reply'), 0), 1) as retry_pct
from llm_usage_log
where created_at >= now() - interval '14 days'
group by 1 order by 1;
"""))

# 2) 重试原因分布（全时段）
show('重试原因分布（全时段）', q("""
select stage,
  count(*) as calls,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_retry
from llm_usage_log
where stage like 'retry%'
group by stage order by calls desc;
"""))

# 3) 重试原因分布（最近 7 天）
show('重试原因分布（最近7天）', q("""
select stage,
  count(*) as calls,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_retry
from llm_usage_log
where stage like 'retry%' and created_at >= now() - interval '7 days'
group by stage order by calls desc;
"""))

# 4) 重试率整体（全时段 / 最近7天 / 7-14天）
show('重试率整体对比', q("""
select '全时段' as period,
  count(*) filter (where stage = 'main_reply') as main,
  count(*) filter (where stage like 'retry%') as retry,
  round(100.0 * count(*) filter (where stage like 'retry%') / nullif(count(*) filter (where stage = 'main_reply'),0), 2) as retry_pct
from llm_usage_log
union all
select '最近7天', count(*) filter (where stage = 'main_reply'),
  count(*) filter (where stage like 'retry%'),
  round(100.0 * count(*) filter (where stage like 'retry%') / nullif(count(*) filter (where stage = 'main_reply'),0), 2)
from llm_usage_log where created_at >= now() - interval '7 days'
union all
select '7-14天', count(*) filter (where stage = 'main_reply'),
  count(*) filter (where stage like 'retry%'),
  round(100.0 * count(*) filter (where stage like 'retry%') / nullif(count(*) filter (where stage = 'main_reply'),0), 2)
from llm_usage_log where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days';
"""))

# 5) 同一轮里出现多次重试的异常轮（正常一轮最多 1 次 retry）
show('单轮多次重试（>1 次的 request_id 数量与最大次数）', q("""
select count(*) as multi_retry_rounds, max(n) as max_retries_in_one_round
from (
  select request_id, count(*) as n
  from llm_usage_log where stage like 'retry%'
  group by request_id having count(*) > 1
) t;
"""))

# 6) 重试发生的时段分布（高峰 vs 空闲 —— 思考链压缩 auto 档的影响）
show('重试×时段（高峰=工作日9-12/14-18）', q("""
select case when extract(hour from created_at at time zone 'Asia/Shanghai') between 9 and 11
        or extract(hour from created_at at time zone 'Asia/Shanghai') between 14 and 17 then 'peak' else 'off' end as period,
  count(*) filter (where stage = 'main_reply') as main,
  count(*) filter (where stage like 'retry%') as retry,
  round(100.0 * count(*) filter (where stage like 'retry%') / nullif(count(*) filter (where stage = 'main_reply'),0), 1) as retry_pct
from llm_usage_log
where created_at >= now() - interval '14 days'
group by 1 order by 1;
"""))
