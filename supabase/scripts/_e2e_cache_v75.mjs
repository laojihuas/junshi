#!/usr/bin/env node
// v75 验证：连续 5 条请求 → 看 prompt_cache_hit_tokens 是否 >0（缓存生效验证）+ 功能正常性
const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;

const email = `c_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd, email_confirm: true }),
});
const uid = (await u.json())?.id;
await fetch(`${BASE}/rest/v1/rpc/register_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_account_name: '缓存测试', p_device_id: 'cch_dbg_000001' }),
});
await fetch(`${BASE}/rest/v1/rpc/login_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'cch_session_001' }),
});
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd }),
});
const accountToken = (await tok.json())?.access_token;
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ user_id: uid, note: '缓存测试', friend_name: '测试' }),
});
const sessionIdDb = (await sid.json())?.[0]?.id;

// 连续 5 条，history 递增（模拟真实连续聊天，system 前缀固定）
const conv = [
  { q: '在吗', h: [] },
  { q: '今天好累啊', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }] },
  { q: '加班到现在，饭都没吃', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }] },
  { q: '你周末一般干嘛', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }, { role: 'user', content: '加班到现在，饭都没吃' }, { role: 'assistant', content: '那我给你点个外卖？' }] },
  { q: '好呀 你人还怪好的', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }, { role: 'user', content: '加班到现在，饭都没吃' }, { role: 'assistant', content: '那我给你点个外卖？' }, { role: 'user', content: '你周末一般干嘛' }, { role: 'assistant', content: '周末骑车，改天带你体验一把' }] },
];

console.log('轮次 | semantic_kws | 战术 | 主回复 prompt(hit/miss) | semantic prompt(hit/miss) | 命中率 | reply');
let i = 0;
for (const c of conv) {
  i++;
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'cch_session_001' },
    body: JSON.stringify({ query: c.q, history: c.h, session_id: sessionIdDb }),
  });
  const d = await r.json();
  const dbg = d._debug || {};
  const usage = dbg.llm_usage || [];
  const main = usage.find(u => u.stage === 'main_reply') || {};
  const sem = usage.find(u => u.stage === 'semantic_kws') || {};
  const hit = (main.prompt_cache_hit_tokens || 0) + (sem.prompt_cache_hit_tokens || 0);
  const miss = (main.prompt_cache_miss_tokens || 0) + (sem.prompt_cache_miss_tokens || 0);
  const rate = (hit + miss) ? Math.round(hit / (hit + miss) * 100) : 0;
  console.log(`#${i} | ${JSON.stringify(dbg.semantic_kws)} | ${dbg.tactic_category} | 主回复(${(main.prompt_cache_hit_tokens||0)}/${(main.prompt_cache_miss_tokens||0)}) | 语义(${(sem.prompt_cache_hit_tokens||0)}/${(sem.prompt_cache_miss_tokens||0)}) | ${rate}% | ${d.reply}`);
}

// 清理
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }) });
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }) });
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('\n临时账号已清理');
