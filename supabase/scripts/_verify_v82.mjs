// v82 验证：话题停滞主动开窗（stale_rounds 检测 + 新话题弹药叠加 + 回复切入小目标）
// 场景：连续 5 轮聊"周末"同一话题（history 自累积），末轮对方短回复"嗯"（退缩信号）
const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;
const email = `v82_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd, email_confirm: true }) });
const uid = (await u.json())?.id;
await fetch(`${BASE}/rest/v1/rpc/register_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_account_name: 'v82验证', p_device_id: 'v82_dbg_000001' }) });
await fetch(`${BASE}/rest/v1/rpc/login_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'v82_session_001' }) });
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd }) });
const accountToken = (await tok.json())?.access_token;
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, { method: 'POST', headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ user_id: uid, note: 'v82验证', friend_name: '测试' }) });
const sessionIdDb = (await sid.json())?.[0]?.id;

const queries = [
  '你周末一般干嘛',
  '我周末想约你出来玩',
  '那周末我们去看电影吧',
  '你觉得周末去爬山怎么样',
  '周末还是去公园逛逛吧',
];
const history = [];
console.log('轮次 | 对方说 | stale_rounds | retreating | semantic_kws(前6) | reply');
let i = 0;
for (const q of queries) {
  i++;
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'v82_session_001' },
    body: JSON.stringify({ query: q, history, session_id: sessionIdDb }),
  });
  const d = await r.json();
  const dbg = d._debug || {};
  history.push({ role: 'user', content: q });
  if (d.reply) history.push({ role: 'assistant', content: d.reply });
  const kws = (dbg.semantic_kws || []).slice(0, 6).join('/');
  console.log(`#${i} | ${q} | ${dbg.stale_rounds} | ${dbg.retreating} | ${kws} | ${(d.reply || '').slice(0, 40)}`);
}
// 退缩信号轮（短回复）
const r2 = await fetch(`${BASE}/functions/v1/ima-proxy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'v82_session_001' },
  body: JSON.stringify({ query: '嗯', history, session_id: sessionIdDb }),
});
const d2 = await r2.json();
console.log(`#6(退缩) | 嗯 | ${d2._debug?.stale_rounds} | ${d2._debug?.retreating} | ${(d2._debug?.semantic_kws || []).slice(0, 6).join('/')} | ${(d2.reply || '').slice(0, 40)}`);

await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }) });
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }) });
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('临时账号已清理');
