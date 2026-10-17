// v240 追加发话冒烟：验证 SQL 033 + ima-proxy mode=followup 通路
// 用法: SBP_PAT=xxx node smoke_followup.mjs
//   PAT 只从环境变量读；api_key 只打印前缀
//   本脚本【不会】真正生成/发送补发消息：验证时临时把 followup_enabled 置 0，
//   只走 disabled 分支；恢复后再报告"当前候选数"，真实触发交给手机脚本。
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

const ok = (c) => (c ? '✓' : '✗');
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${ok(cond)} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

async function main() {
  // 1) 配置 + 列 + 函数
  const meta = await query(`
    select
      (select count(*) from information_schema.columns where table_schema='public' and table_name='chat_messages' and column_name='kind') as kind_col,
      (select count(*) from information_schema.columns where table_schema='public' and table_name='chat_sessions' and column_name='followup_at') as fu_at_col,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='followup_candidates') as fn_cand,
      (select quota_params::jsonb->>'followup_minutes' from public.app_config where id=1) as minutes,
      (select quota_params::jsonb->>'followup_daily_cap' from public.app_config where id=1) as cap,
      (select quota_params::jsonb->>'wake_enabled' from public.app_config where id=1) as wake
  `);
  const m = meta[0] || {};
  console.log('[1] SQL 033:', JSON.stringify(m));
  check('kind 列存在', m.kind_col === 1);
  check('followup_at 列存在', m.fu_at_col === 1);
  check('followup_candidates 函数存在', m.fn_cand === 1);
  check('触发阈值 = 5 分钟', String(m.minutes) === '5');
  check('日上限 = 5 次', String(m.cap) === '5');
  check('wake 已关 (0)', String(m.wake) === '0');

  // 2) 找一个直连账号
  const acc = await query(`select id, api_key from public.profiles where api_key <> '' order by wake_enabled desc nulls last limit 1`);
  if (!acc.length) { console.log('[2] 无 api_key 账号，跳过直连冒烟'); return; }
  const { id: uid } = acc[0];
  const apiKey = acc[0].api_key;
  console.log('[2] 直连账号 =', uid.slice(0, 8) + '…', 'api_key =', apiKey.slice(0, 6) + '…');

  // 3) disabled 分支（不触发真实补发）
  await query(`update public.app_config set quota_params = jsonb_set(coalesce(quota_params::jsonb,'{}'::jsonb),'{followup_enabled}','0'::jsonb)::text where id=1`);
  const off = await callProxy({ mode: 'followup', api_key: apiKey });
  check('followup 通路通（HTTP 200）', off.status === 200, JSON.stringify(off.json));
  check('disabled=0 时返回 disabled:true', !!(off.json && off.json.disabled === true));

  // 4) 恢复开关
  await query(`update public.app_config set quota_params = jsonb_set(coalesce(quota_params::jsonb,'{}'::jsonb),'{followup_enabled}','1'::jsonb)::text where id=1`);
  const back = await query(`select quota_params::jsonb->>'followup_enabled' as v from public.app_config where id=1`);
  check('开关已恢复为 1', String(back[0]?.v) === '1');

  // 5) mode=wake 已退役
  const wk = await callProxy({ mode: 'wake', api_key: apiKey });
  check('wake 返回 200 且 retired', wk.status === 200 && !!(wk.json && wk.json.retired === true), JSON.stringify(wk.json));

  // 6) 当前候选数（只读，真正补发要等手机脚本调用）
  const cand = await query(`select count(*)::int as n from public.followup_candidates('${uid}'::uuid, 5, 60)`);
  const used = await query(`select public.followup_daily_count('${uid}'::uuid) as n`);
  console.log(`[6] 当前候选会话 = ${cand[0]?.n} 个，今日已补发 = ${used[0]?.n} 次（脚本一启动就会补，最多 ${m.cap} 次/天）`);

  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });
