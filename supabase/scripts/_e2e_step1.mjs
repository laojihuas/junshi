#!/usr/bin/env node
// 端到端流程记录：步骤1 - 查 app_config（system_prompt + llm_params），并建临时用户、登录
import fs from 'fs';

const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const r = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await r.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;
fs.writeFileSync(new URL('./_e2e_jwt.tmp', import.meta.url), JWT);

// 1. app_config：system_prompt + llm_params
const cfg = await fetch(`https://${REF}.supabase.co/rest/v1/app_config?select=system_prompt,llm_params&id=eq.1`, {
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT },
});
const cfgData = await cfg.json();
console.log('===== app_config.llm_params =====');
console.log(JSON.stringify(cfgData?.[0]?.llm_params || null, null, 2));
console.log('\n===== app_config.system_prompt（统一提示词）=====');
console.log((cfgData?.[0]?.system_prompt || '').slice(0, 600) || '（空）');
fs.writeFileSync(new URL('./_e2e_prompt.tmp', import.meta.url), cfgData?.[0]?.system_prompt || '');

// 2. 建临时用户
const email = `e2e_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`https://${REF}.supabase.co/auth/v1/admin/users`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd, email_confirm: true }),
});
const uData = await u.json();
const uid = uData?.id;
if (!uid) { console.error('建用户失败:', u.status, JSON.stringify(uData).slice(0, 300)); process.exit(1); }
fs.writeFileSync(new URL('./_e2e_uid.tmp', import.meta.url), uid);
console.log(`\n临时用户: ${email} / id=${uid}`);

// 3. 登录拿 access_token
const t = await fetch(`https://${REF}.supabase.co/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd }),
});
const tData = await t.json();
if (!tData?.access_token) { console.error('登录失败:', JSON.stringify(tData).slice(0, 300)); process.exit(1); }
fs.writeFileSync(new URL('./_e2e_token.tmp', import.meta.url), tData.access_token);
console.log('登录成功，access_token 已存');

// 4. 建 chat_session（会话，拿 session_id）
const sid = await fetch(`https://${REF}.supabase.co/rest/v1/chat_sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tData.access_token}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ note: 'E2E 流程记录', friend_name: '测试好友' }),
});
const sData = await sid.json();
const sessionId = sData?.[0]?.id;
if (!sessionId) { console.error('建会话失败:', sid.status, JSON.stringify(sData).slice(0, 300)); process.exit(1); }
fs.writeFileSync(new URL('./_e2e_session.tmp', import.meta.url), sessionId);
console.log('会话已建: ' + sessionId);
