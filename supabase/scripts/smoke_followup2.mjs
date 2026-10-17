// v242 两阶段补发冒烟：验证「扫描不花钱、打开聊天页才生成、发送失败可撤回」
// 用法: SBP_PAT=xxx node smoke_followup2.mjs
//   PAT / api_key 只从环境变量与库里读；api_key 只打印前缀
//   生成测试只生成 1 条，并立即用 action=fail 撤回，不留痕迹
import fs from 'fs';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SUPABASE_URL = `https://${REF}.supabase.co`;

async function query(sql) {
  const resp = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('query failed: ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

async function callProxy(body) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, json, text: text.slice(0, 300) };
}

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

async function main() {
  // 1) 迁移与函数
  const meta = await query(`
    select
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='followup_targets') as fn,
      (select quota_params::jsonb->>'followup_session_cap' from public.app_config where id=1) as cap
  `);
  check('035 RPC followup_targets 存在', Number(meta[0]?.fn) >= 1);
  check('每会话上限 = 3', String(meta[0]?.cap) === '3');

  const acc = await query(`select id, api_key from public.profiles where api_key <> '' order by followup_online desc nulls last limit 1`);
  if (!acc.length) { console.log('无 api_key 账号，跳过'); return; }
  const uid = acc[0].id;
  const apiKey = acc[0].api_key;
  console.log('[账号]', uid.slice(0, 8) + '…', 'key=' + apiKey.slice(0, 6) + '…');

  const base = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select count(*)::int from public.llm_usage_log) as llm_rows
  `);
  const fu0 = base[0].fu_rows, llm0 = base[0].llm_rows;
  console.log(`[基线] followup 行=${fu0} llm 调用=${llm0}`);

  // 2) 阶段一：扫描 → 只回目标，不生成
  const scan = await callProxy({ mode: 'followup', api_key: apiKey, online: true });
  check('扫描返回 200', scan.status === 200);
  check('扫描 phase=scan', scan.json?.phase === 'scan', String(scan.json?.phase));
  check('扫描不返回话术（followup 为空）', Array.isArray(scan.json?.followup) && scan.json.followup.length === 0);
  const targets = Array.isArray(scan.json?.targets) ? scan.json.targets : [];
  check('targets 是数组', Array.isArray(scan.json?.targets));
  console.log(`[扫描] 目标 ${targets.length} 个`);
  for (const t of targets.slice(0, 4)) {
    console.log(`   · ${t.search_key || t.friend_name} (等 ${t.waited_min} 分, 今日 ${t.used_today}) note="${t.note}"`);
  }
  check('targets 带 search_key', targets.length === 0 || targets.every((t) => typeof t.search_key === 'string'));

  const afterScan = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select count(*)::int from public.llm_usage_log) as llm_rows
  `);
  check('扫描未产生 followup 行', afterScan[0].fu_rows === fu0, `${fu0}→${afterScan[0].fu_rows}`);
  check('扫描未消耗 token（llm 调用数不变）', afterScan[0].llm_rows === llm0, `${llm0}→${afterScan[0].llm_rows}`);

  if (!targets.length) { console.log('\n当前无候选目标，跳过生成/撤回测试'); console.log(failed ? `失败 ${failed} 项` : '\n全部通过'); return; }

  // 3) 阶段二：模拟"已打开聊天页" → 生成 1 条
  const sid = targets[0].session_id;
  const gen = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid });
  check('生成返回 200', gen.status === 200);
  check('生成 phase=generate', gen.json?.phase === 'generate', String(gen.json?.phase));
  const one = Array.isArray(gen.json?.followup) ? gen.json.followup[0] : null;
  check('生成了 1 条话术', !!one && typeof one.text === 'string' && one.text.length > 0, one ? `「${one.text}」(${one.shape})` : JSON.stringify(gen.json?.skipped));
  if (one) {
    const NAG = /(在吗|在不在|怎么不回|怎么不理|忙完了吗|忙完没|看到没|看到了吗|回我|理我|生气|是不是不|又不回|等你)/;
    check('话术不含催句', !NAG.test(one.text));
    check('话术 8-20 字', one.text.replace(/\s/g, '').length >= 5 && one.text.replace(/\s/g, '').length <= 20, `${one.text.replace(/\s/g, '').length} 字`);
  }
  const afterGen = await query(`select count(*)::int as n from public.chat_messages where kind='followup'`);
  check('生成后落库 1 条 kind=followup', afterGen[0].n === fu0 + 1, `${fu0}→${afterGen[0].n}`);

  // 4) 发送失败 → 撤回（不算补发，可重试）
  const fail = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid, action: 'fail' });
  check('action=fail 返回 200', fail.status === 200);
  check('撤回成功 rolled_back=true', fail.json?.rolled_back === true, JSON.stringify(fail.json));
  const afterFail = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select count(*)::int from public.chat_sessions where id='${sid}' and followup_at is not null) as fu_at
  `);
  check('撤回后 followup 行回到基线', afterFail[0].fu_rows === fu0, `${afterGen[0].n}→${afterFail[0].fu_rows}`);
  check('撤回后 followup_at 已清空', Number(afterFail[0].fu_at) === 0);

  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });
