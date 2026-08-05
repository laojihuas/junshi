// v57 长期记忆 facts 验证：提取 → 相关命中注入 → 不相关不注入
// 用法: SBP_PAT=xxx node deploy_v57.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
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
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;
  const fs = await import('node:fs');
  const fileContent = fs.readFileSync(SRC, 'utf8');
  const boundary = '----wb' + Date.now();
  let body = '--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify({ entrypoint_path: 'index.ts', name: SLUG }) + '\r\n';
  body += '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/octet-stream\r\n\r\n' + fileContent + '\r\n--' + boundary + '--\r\n';
  const depR = await jf('https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=' + SLUG, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  console.log('部署:', depR.s === 201 ? 'OK v' + depR.d?.version : 'FAIL ' + depR.s + ' ' + JSON.stringify(depR.d).slice(0, 200));
  if (depR.s !== 201) process.exit(1);
  await new Promise(r => setTimeout(r, 3000));

  const email = 'v57_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V57Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V57Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }
  const sid = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, user_id: uid, friend_name: '记忆测试', memory_card: JSON.stringify({ profile: { stage: '暧昧' } }) }) });

  // 轮1：提取事实（她说生日）
  const r1 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '我下周三生日，还不知道去哪吃呢', history: [{ role: 'user', content: '我下周三生日，还不知道去哪吃呢' }], session_id: sid }),
  });
  console.log('\n[轮1-她提到生日] facts_len=' + r1.d?._debug?.facts_len + ' facts_injected=' + r1.d?._debug?.facts_injected);
  console.log('  ▶ ' + r1.d?.reply);

  // 轮2：相关话题 → 应命中注入
  const r2 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '对了，下周我生日那事，你想好带我去哪了吗', history: [
      { role: 'user', content: '我下周三生日，还不知道去哪吃呢' },
      { role: 'assistant', content: r1.d?.reply || '' },
      { role: 'user', content: '对了，下周我生日那事，你想好带我去哪了吗' } ], session_id: sid }),
  });
  console.log('\n[轮2-生日相关(期望注入>0,回复带记得感)] facts_len=' + r2.d?._debug?.facts_len + ' facts_injected=' + r2.d?._debug?.facts_injected);
  console.log('  ▶ ' + r2.d?.reply);

  // 轮3：不相关话题 → 应不注入
  const r3 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '今天天气不错，刚去公园散步了', history: [{ role: 'user', content: '今天天气不错，刚去公园散步了' }], session_id: sid }),
  });
  console.log('\n[轮3-天气不相关(期望注入=0)] facts_len=' + r3.d?._debug?.facts_len + ' facts_injected=' + r3.d?._debug?.facts_injected);
  console.log('  ▶ ' + r3.d?.reply);

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
