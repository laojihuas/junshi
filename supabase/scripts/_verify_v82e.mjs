// v82e 验证：真·聊死场景（"无聊"反复 5 轮，关键词全重叠）→ topicDead 触发后 LLM 是否执行收集
const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;
const email = `v82e_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd, email_confirm: true }) });
const uid = (await u.json())?.id;
await fetch(`${BASE}/rest/v1/rpc/register_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_account_name: 'v82e验证', p_device_id: 'v82e_dbg_000001' }) });
await fetch(`${BASE}/rest/v1/rpc/login_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'v82e_session_001' }) });
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd }) });
const accountToken = (await tok.json())?.access_token;
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, { method: 'POST', headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ user_id: uid, note: 'v82e验证', friend_name: '测试' }) });
const sessionIdDb = (await sid.json())?.[0]?.id;
const card = {
  profile: { stage: '暧昧', personality: '开朗', relationship_note: '聊了几天，氛围轻松', recent_events: '' },
  milestones: [],
  goal: '推进恋爱',
  recent_user_messages: ['今天好无聊', '无聊死了'],
  recent_self_messages: ['无聊就来找我撩几句', '无聊的话我给你讲个段子'],
};
await fetch(`${BASE}/rest/v1/chat_sessions?id=eq.${sessionIdDb}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ memory_card: JSON.stringify(card) }),
});
const queries = ['今天好无聊', '好无聊啊', '无聊死了 在家呆着', '太无聊了 找点事做', '哎 真的无聊'];
const history = [];
console.log('轮次 | stale | retreating | ms_block | reply');
let i = 0;
for (const q of queries) {
  i++;
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'v82e_session_001' },
    body: JSON.stringify({ query: q, history, session_id: sessionIdDb }),
  });
  const d = await r.json();
  const dbg = d._debug || {};
  history.push({ role: 'user', content: q });
  if (d.reply) history.push({ role: 'assistant', content: d.reply });
  console.log(`#${i} | ${dbg.stale_rounds} | ${dbg.retreating} | ${dbg.ms_block} | ${(d.reply || '').slice(0, 50)}`);
}
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }) });
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }) });
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('临时账号已清理');
