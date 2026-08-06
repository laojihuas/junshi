#!/usr/bin/env node
// 端到端流程记录：步骤4 - 清理 E2E 测试数据（临时用户/账号/会话/临时文件）
import fs from 'fs';

const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const JWT = fs.readFileSync(new URL('./_e2e_jwt.tmp', import.meta.url), 'utf8');
const uid = fs.readFileSync(new URL('./_e2e_uid.tmp', import.meta.url), 'utf8');

// 1. 删 chat_sessions（管理 SQL）
const delS = await fetch(`${API}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }),
});
console.log('删 chat_sessions:', delS.status);

// 2. 删 accounts 行
const delA = await fetch(`${API}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }),
});
console.log('删 accounts:', delA.status);

// 3. 删 auth 用户
const delU = await fetch(`${BASE}/auth/v1/admin/users/${uid}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT },
});
console.log('删 auth 用户:', delU.status);

// 4. 清理临时文件（保留 _e2e_report.json 供查看，其余删）
const dir = new URL('.', import.meta.url);
for (const f of fs.readdirSync(dir)) {
  if (f.startsWith('_e2e_') && f.endsWith('.tmp')) {
    fs.unlinkSync(new URL(f, dir));
    console.log('删除临时文件: ' + f);
  }
}
console.log('\n清理完成（_e2e_report.json 与 step 脚本保留）');
