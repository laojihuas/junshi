// v241 追加发话冒烟：验证 SQL 034 + 脚本在线开关 + 每会话上限
// 用法: SBP_PAT=xxx node smoke_followup.mjs
//   PAT 只从环境变量读；api_key 只打印前缀
//   本脚本【不会】真正生成/发送补发消息：
//     - stop 之后用 offline 分支验证"退出就不补"
//     - disabled 分支验证总开关
//     - 最后用 SQL 直接恢复 online=true，不经过接口，避免触发真实补发
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
  // 1) 结构 + 配置
  const meta = await query(`
    select
      (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='followup_online') as online_col,
      (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='followup_heartbeat_at') as hb_col,
      (select quota_params::jsonb->>'followup_session_cap' from public.app_config where id=1) as cap,
      (select quota_params::jsonb->>'followup_scan_limit' from public.app_config where id=1) as scan,
      (select quota_params::jsonb->>'followup_daily_cap' from public.app_config where id=1) as old_cap
  `);
  const m = meta[0] || {};
  console.log('[1] SQL 034:', JSON.stringify(m));
  check('followup_online 列存在', m.online_col === 1);
  check('followup_heartbeat_at 列存在', m.hb_col === 1);
  check('每会话上限 = 3', String(m.cap) === '3');
  check('单轮最多补 3 个', String(m.scan) === '3');
  check('账号级 daily_cap 已移除', m.old_cap === null);

  // 2) 直连账号
  const acc = await query(`select id, api_key from public.profiles where api_key <> '' order by wake_enabled desc nulls last limit 1`);
  if (!acc.length) { console.log('[2] 无 api_key 账号，跳过'); return; }
  const uid = acc[0].id;
  const apiKey = acc[0].api_key;
  console.log('[2] 直连账号 =', uid.slice(0, 8) + '…', 'api_key =', apiKey.slice(0, 6) + '…');

  // 3) 脚本退出 → stop
  const stop = await callProxy({ mode: 'followup', api_key: apiKey, action: 'stop' });
  check('action=stop 返回 stopped:true', stop.status === 200 && stop.json?.stopped === true, JSON.stringify(stop.json));
  const afterStop = await query(`select followup_online from public.profiles where id='${uid}'`);
  check('库里 followup_online=false', afterStop[0]?.followup_online === false);

  // 4) 退出后再轮询 → 一律不补（关键需求）
  const offline = await callProxy({ mode: 'followup', api_key: apiKey });
  check('脚本停止后轮询返回 offline:true', offline.json?.offline === true, JSON.stringify(offline.json));
  check('返回 reason=script_offline', offline.json?.reason === 'script_offline');
  check('offline 时 followup 为空', Array.isArray(offline.json?.followup) && offline.json.followup.length === 0);

  // 5) 恢复在线：直接写库（不经过接口，避免触发真实补发）
  await query(`update public.profiles set followup_online = true where id='${uid}'`);
  const back = await query(`select followup_online from public.profiles where id='${uid}'`);
  check('online 已恢复 true', back[0]?.followup_online === true);

  // 6) 总开关 disabled 分支
  await query(`update public.app_config set quota_params = jsonb_set(coalesce(quota_params::jsonb,'{}'::jsonb),'{followup_enabled}','0'::jsonb)::text where id=1`);
  const off = await callProxy({ mode: 'followup', api_key: apiKey });
  check('总开关关 → disabled:true', off.json?.disabled === true);
  await query(`update public.app_config set quota_params = jsonb_set(coalesce(quota_params::jsonb,'{}'::jsonb),'{followup_enabled}','1'::jsonb)::text where id=1`);
  const on = await query(`select quota_params::jsonb->>'followup_enabled' as v from public.app_config where id=1`);
  check('总开关已恢复 1', String(on[0]?.v) === '1');

  // 7) wake 退役
  const wk = await callProxy({ mode: 'wake', api_key: apiKey });
  check('wake 返回 200 + retired', wk.status === 200 && wk.json?.retired === true);

  // 8) 当前候选（只读）
  const cand = await query(`select count(*)::int as n from public.followup_candidates('${uid}'::uuid, 5, 60, 3)`);
  console.log(`[8] 当前候选会话 = ${cand[0]?.n} 个（脚本上线后每轮最多补 3 个）`);

  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });
