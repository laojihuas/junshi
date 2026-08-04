// vB 部署 + 端到端验证：本地块级检索（完全移除 IMA）
// 用法: SBP_PAT=xxx node deploy_vB.mjs
import fs from 'fs';
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const SLUG = 'ima-proxy';
const SRC = new URL('../functions/ima-proxy/index.ts', import.meta.url);

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}

(async () => {
  // 1) service_role
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 2) 确认 kb_blocks 数据量
  const cntR = await jf(SUPABASE + '/rest/v1/kb_blocks?select=media_id&limit=1', {
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Prefer': 'count=exact' }
  });
  console.log('kb_blocks 行数:', cntR.d?.[0] ? '(有数据)' : 'EMPTY!');

  // 3) 部署 Edge Function（multipart: file=单个源码文件）
  const src = fs.readFileSync(SRC, 'utf8');
  const form = new FormData();
  form.append('file', new Blob([src], { type: 'text/typescript' }), 'index.ts');
  form.append('metadata', JSON.stringify({ entrypoint_path: 'index.ts', name: SLUG }));
  const depR = await fetch(
    'https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=' + SLUG,
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + PAT }, body: form, proxies: undefined }
  );
  console.log('部署 HTTP:', depR.status);
  const depD = await depR.json();
  console.log('version:', depD.version || JSON.stringify(depD).slice(0, 200));

  // 4) 端到端：建测试用户 → 调函数 → 验证块级检索
  const email = 'test_vB_' + Date.now() + '@test.com';
  const userR = await jf(SUPABASE + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!', email_confirm: true })
  });
  const uid = userR.d?.id;
  console.log('测试用户:', uid || ('创建失败 ' + userR.s));

  // 登录拿 JWT
  const tokR = await jf(SUPABASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  });
  const JWT = tokR.d?.access_token;
  console.log('登录:', JWT ? 'OK' : 'FAIL ' + tokR.s);

  // 建会话
  const sessR = await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ user_id: uid, friend_name: '测试对象', note: 'vB验证' })
  });
  const sessionId = sessR.d?.[0]?.id;
  console.log('会话:', sessionId || 'FAIL');

  // 调函数：搭讪相关查询（验证块级命中）
  const fnR = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '我今天在街上看到一个很喜欢的女生，想上去搭讪但是很紧张，怎么开场？',
      session_id: sessionId,
      history: [],
    })
  });
  const fnD = fnR.d;
  console.log('=== 函数返回 ===');
  console.log('status:', fnR.s);
  console.log('reply 前200:', (fnD?.reply || '').slice(0, 200));
  console.log('from_knowledge_base:', fnD?.from_knowledge_base);
  console.log('_debug.kb_items:', fnD?._debug?.kb_items);
  console.log('_debug.kb_hits:', fnD?._debug?.kb_hits);
  console.log('_debug.semantic_kws:', JSON.stringify(fnD?._debug?.semantic_kws));
  console.log('_debug.sentence_kws:', JSON.stringify(fnD?._debug?.sentence_kws));
  console.log('_debug.fulltext_hits:', fnD?._debug?.fulltext_hits);
  console.log('_debug.content_src:', JSON.stringify(fnD?._debug?.content_src));
  console.log('_debug.perf:', JSON.stringify(fnD?._debug?.perf));

  // 清理测试用户
  if (uid) {
    const delR = await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
    console.log('清理测试用户:', delR.s === 204 || delR.s === 200 ? 'OK' : 'FAIL ' + delR.s);
  }
})();
