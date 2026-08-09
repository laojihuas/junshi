// v20260809 机会窗口冒烟：她主动问年龄 → 期望 open_window='年龄' 且回复含镜像反问
// 对照组：普通消息 → open_window=null
const BASE = 'https://opzvvgixlfbfpdlsorbi.supabase.co';
const ADMIN_API = 'https://api.supabase.com/v1';
const PAT = process.env.SBP_PAT || '<sbp_pat>'; // 运行：SBP_PAT=<token> node _smoke_ow.mjs（凭据见本地 资料.txt，绝不入库）
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';

async function call(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, d };
}

const keysR = await call(`${ADMIN_API}/projects/opzvvgixlfbfpdlsorbi/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const sr = (Array.isArray(keysR.d) ? keysR.d : (keysR.d?.api_keys || [])).find((k) => k.name === 'service_role');
const SROLE = sr.api_key;
const adminH = { Authorization: `Bearer ${SROLE}`, apikey: SROLE };

const stamp = Date.now().toString(36);
const email = `smoke_ow_${stamp}@jssl.local`;
const password = 'Smoke!' + stamp + 'qW7';
const uR = await call(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: adminH, body: { email, password, email_confirm: true } });
const userId = uR.d.id;
const tokR = await call(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, body: { email, password } });
const userJwt = tokR.d.access_token;
const userH = { Authorization: `Bearer ${userJwt}`, apikey: ANON };
const sessToken = 'sess_' + stamp;
await call(`${BASE}/rest/v1/accounts`, { method: 'POST', headers: adminH, body: { id: userId, account_name: '测' + stamp, device_id: null, active_session: sessToken, invite_bonus: 0 } });
const sR = await call(`${BASE}/rest/v1/chat_sessions?select=id&order=created_at.desc&limit=1`, { headers: adminH });
const sid = (sR.d && sR.d[0]?.id) || null;
console.log('sid:', sid);

const cases = [
  { name: '机会窗口(问年龄)', q: '她发来：你多大呀', want: '年龄', history: [
    { role: 'user', content: '她发来：感觉你挺有意思的' },
    { role: 'assistant', content: '那你眼光不错' }] },
  { name: '对照组(普通消息)', q: '她发来：在干嘛', want: null, history: [
    { role: 'user', content: '她发来：最近怎么样' },
    { role: 'assistant', content: '还行，你呢' }] },
];

let fail = 0;
for (const c of cases) {
  const r = await call(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { ...userH, 'X-Identity-Type': 'account', 'X-Session-Id': sessToken },
    body: { query: c.q, session_id: sid, history: c.history },
  });
  const reply = (r.d && r.d.reply) || '';
  const dbg = (r.d && r.d._debug) || {};
  const got = dbg.open_window ?? null;
  const ok = got === c.want;
  if (!ok) fail++;
  console.log(`\n[${c.name}] ${ok ? 'PASS' : 'FAIL'}  open_window=${got} (want ${c.want})  status=${r.status}`);
  console.log('  reply:', JSON.stringify(reply));
  console.log('  ms_block:', dbg.ms_block, ' stage:', dbg.memory_stage);
}

// 清理临时账号与会话
try {
  await call(`${BASE}/rest/v1/chat_sessions?id=eq.${sid}`, { method: 'DELETE', headers: adminH });
  await call(`${BASE}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminH });
} catch { }
console.log('\n' + (fail === 0 ? 'ALL PASS' : `${fail} FAILED`));
process.exit(fail === 0 ? 0 : 1);
