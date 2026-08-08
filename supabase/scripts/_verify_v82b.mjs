// v82b 验证：预置暧昧阶段记忆卡 → 重引导（heavy）主动开窗是否切入里程碑小目标
const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;
const email = `v82b_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd, email_confirm: true }) });
const uid = (await u.json())?.id;
await fetch(`${BASE}/rest/v1/rpc/register_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_account_name: 'v82b验证', p_device_id: 'v82b_dbg_000001' }) });
await fetch(`${BASE}/rest/v1/rpc/login_account`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'v82b_session_001' }) });
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd }) });
const accountToken = (await tok.json())?.access_token;
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, { method: 'POST', headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ user_id: uid, note: 'v82b验证', friend_name: '测试' }) });
const sessionIdDb = (await sid.json())?.[0]?.id;
// 预置暧昧阶段记忆卡：stage=暧昧、goal=推进恋爱、已完成喜好 → 走重引导（heavy=true）
const card = {
  profile: { stage: '暧昧', personality: '外向活泼', relationship_note: '聊了几天，氛围不错', recent_events: '' },
  milestones: ['喜好'],
  goal: '推进恋爱',
  recent_user_messages: ['今天好无聊呀', '你周末一般干嘛'],
  recent_self_messages: ['无聊就来找我撩几句', '周末骑车，改天带你体验一把'],
};
await fetch(`${BASE}/rest/v1/chat_sessions?id=eq.${sessionIdDb}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ memory_card: JSON.stringify(card) }),
});
const queries = ['你周末一般干嘛', '我周末想约你出来玩', '那周末我们去看电影吧', '你觉得周末去爬山怎么样', '周末还是去公园逛逛吧'];
const history = [];
console.log('轮次 | stale | retreating | stage | goal | milestones | reply');
let i = 0;
for (const q of queries) {
  i++;
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'v82b_session_001' },
    body: JSON.stringify({ query: q, history, session_id: sessionIdDb }),
  });
  const d = await r.json();
  const dbg = d._debug || {};
  history.push({ role: 'user', content: q });
  if (d.reply) history.push({ role: 'assistant', content: d.reply });
  console.log(`#${i} | ${dbg.stale_rounds} | ${dbg.retreating} | ${dbg.memory_stage} | ${dbg.goal} | [${(dbg.milestones || []).join(',')}] | ${(d.reply || '').slice(0, 46)}`);
}
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }) });
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }) });
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('临时账号已清理');
