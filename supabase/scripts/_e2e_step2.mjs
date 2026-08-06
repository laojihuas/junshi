#!/usr/bin/env node
// 端到端流程记录：步骤2（账号通道） - register_account → login_account → 建会话 → 调 ima-proxy 完整一轮
import fs from 'fs';
import path from 'path';

const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const JWT = fs.readFileSync(new URL('./_e2e_jwt.tmp', import.meta.url), 'utf8');
const uid = fs.readFileSync(new URL('./_e2e_uid.tmp', import.meta.url), 'utf8');
const accountToken = fs.readFileSync(new URL('./_e2e_token.tmp', import.meta.url), 'utf8');
const out = new URL('./_e2e_result.json', import.meta.url);

const deviceId = 'e2e_dbg_000001';
const sessionId = 'e2e_session_000001';

// 1. register_account（建 accounts 行；service_role 调）
const reg = await fetch(`${BASE}/rest/v1/rpc/register_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_account_name: 'E2E测试', p_device_id: deviceId }),
});
const regData = await reg.json();
console.log('register_account:', reg.status, JSON.stringify(regData).slice(0, 200));
if (regData?.success !== true && !regData?.message?.includes('已存在')) {
  // 已存在/设备占用等错误不致命，继续试 login
}

// 2. login_account（设置 active_session）
const login = await fetch(`${BASE}/rest/v1/rpc/login_account`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_session_id: sessionId }),
});
const loginData = await login.json();
console.log('login_account:', login.status, JSON.stringify(loginData).slice(0, 200));
if (loginData?.success !== true) { console.error('登录失败'); process.exit(1); }

// 3. 建会话
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ user_id: uid, note: 'E2E 流程记录', friend_name: '测试好友' }),
});
const sData = await sid.json();
const sessionIdDb = Array.isArray(sData) ? sData?.[0]?.id : sData?.id;
if (!sessionIdDb) { console.error('建会话失败:', sid.status, JSON.stringify(sData).slice(0, 300)); process.exit(1); }
console.log('会话: ' + sessionIdDb);

// 4. 构造请求
const history = [
  { role: 'user', content: '最近好像有点累' },
  { role: 'assistant', content: '累了？那我给你讲个笑话提提神' },
  { role: 'user', content: '哈哈 你还有这功能' },
  { role: 'assistant', content: '不止，我还能陪聊陪吃陪散步，三陪服务了解一下' },
  { role: 'user', content: '今天加班到现在 好烦 不想上班了' },
];
const query = '今天加班到现在 好烦 不想上班了';

// 5. 调 ima-proxy
const t0 = Date.now();
const resp = await fetch(`${BASE}/functions/v1/ima-proxy`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accountToken}`,
    apikey: JWT,
    'Content-Type': 'application/json',
    'X-Identity-Type': 'account',
    'X-Session-Id': sessionId,
  },
  body: JSON.stringify({ query, history, session_id: sessionIdDb }),
});
const wallMs = Date.now() - t0;
const data = await resp.json();
console.log('ima-proxy HTTP:', resp.status, `总耗时 ${wallMs}ms`);

const result = { request: { query, history, session_id: sessionIdDb }, response: data, wall_ms: wallMs };
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log('结果已存: ' + path.basename(out.pathname));

console.log('\n===== reply =====');
console.log(data.reply);
console.log('\n===== _debug 摘要 =====');
const d = data._debug || {};
console.log(JSON.stringify({
  system_prompt_len: d.system_prompt_len, history_len: d.history_len, llm_history_len: d.llm_history_len,
  kb_hits: d.kb_hits, kb_items: d.kb_items, semantic_kws: d.semantic_kws,
  thinking_mode: d.thinking_mode, rewrite_used: d.rewrite_used, kb_gem_avg: d.kb_gem_avg,
  perf: d.perf, llm_usage: d.llm_usage,
  reasoning_len: (d.llm_reasoning || '').length,
}, null, 2));
