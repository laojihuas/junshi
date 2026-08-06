#!/usr/bin/env node
// v73 验证：建临时账号 → 4 个场景批量跑 → 检查战术类别/阶段/字数 → 清理
import fs from 'fs';

const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;

// 建账号
const email = `v73_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd, email_confirm: true }),
});
const uid = (await u.json())?.id;
if (!uid) { console.error('建用户失败'); process.exit(1); }

// 注册账号 + 登录
await fetch(`${BASE}/rest/v1/rpc/register_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_account_name: 'v73验证', p_device_id: 'v73_dbg_000001' }),
});
await fetch(`${BASE}/rest/v1/rpc/login_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'v73_session_001' }),
});
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd }),
});
const accountToken = (await tok.json())?.access_token;
if (!accountToken) { console.error('登录失败'); process.exit(1); }

// 建会话
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ user_id: uid, note: 'v73验证', friend_name: '测试' }),
});
const sessionIdDb = (await sid.json())?.[0]?.id;

// 场景定义
const cases = [
  { name: '防守·打压挑衅', history: [{ role: 'user', content: '嗨' }, { role: 'assistant', content: '你好啊，刚忙完' }], query: '你好自恋啊，是不是经常这样撩妹' },
  { name: '进攻·正常推进', history: [{ role: 'user', content: '周末有什么安排' }, { role: 'assistant', content: '打算去新开的那家店试试' }], query: '一个人去多没意思' },
  { name: '救场·暴露需求后', history: [{ role: 'user', content: '你最近忙吗' }, { role: 'assistant', content: '我好想你' }], query: '哈哈 你这么想我啊' },
  { name: '进攻·第10回合(诱惑期)', history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i + 1}条消息` })), query: '今天心情不错' },
];

const results = [];
for (const c of cases) {
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'v73_session_001' },
    body: JSON.stringify({ query: c.query, history: c.history, session_id: sessionIdDb }),
  });
  const d = await r.json();
  const dbg = d._debug || {};
  results.push({
    name: c.name, reply: d.reply, reply_len: (d.reply || '').length,
    tactic_category: dbg.tactic_category, tactic_phase: dbg.tactic_phase,
    semantic_kws: dbg.semantic_kws, kb_items: dbg.kb_items, reasoning_len: (dbg.llm_reasoning || '').length,
    system_prompt_len: dbg.system_prompt_len,
  });
  console.log(JSON.stringify(results[results.length - 1], null, 2));
}

// 清理
await fetch(`${API}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }),
});
await fetch(`${API}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }),
});
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('\n临时账号已清理');
