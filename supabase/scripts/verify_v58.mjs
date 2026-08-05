// v58 M3 目标引导验证：goal 注入 → 方向性回复；目标达成停止注入
// 用法: SBP_PAT=xxx node verify_v58.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const GATE = SUPABASE + '/functions/v1/device-gate';
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

  // 部署（multipart: file=单个源码文件）
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

  const email = 'v58_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V58Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V58Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const deviceId = 'v58-' + Date.now().toString(36);
  await jf(GATE, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok }, body: JSON.stringify({ action: 'register', device_id: deviceId }) });

  // 场景A：goal=推进恋爱, stage=追求 → 期望方向性(模糊邀约/试探推进)
  const sidA = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sidA, user_id: uid, friend_name: '目标测试A', memory_card: JSON.stringify({ profile: { stage: '追求' }, goal: '推进恋爱' }) }) });
  const rA = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ query: '你在干嘛呀', history: [{ role: 'user', content: '你在干嘛呀' }], session_id: sidA }),
  });
  console.log('\n[场景A-追求+推进恋爱] goal=' + rA.d?._debug?.goal + ' stage=' + rA.d?._debug?.memory_stage);
  console.log('  ▶ ' + (rA.d?.reply || JSON.stringify(rA.d).slice(0, 150)));

  // 场景B：goal=保持暧昧, stage=恋爱(已达成) → 期望不再注入(正常维系即可,不强行推进)
  const sidB = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sidB, user_id: uid, friend_name: '目标测试B', memory_card: JSON.stringify({ profile: { stage: '恋爱' }, goal: '保持暧昧' }) }) });
  const rB = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ query: '周末想干嘛呀', history: [{ role: 'user', content: '周末想干嘛呀' }], session_id: sidB }),
  });
  console.log('\n[场景B-恋爱+保持暧昧(已达成)] goal=' + rB.d?._debug?.goal + ' stage=' + rB.d?._debug?.memory_stage + ' (期望:正常聊天,不强行注入)');
  console.log('  ▶ ' + (rB.d?.reply || JSON.stringify(rB.d).slice(0, 150)));

  // 场景C：无目标 → 正常现状打法
  const sidC = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sidC, user_id: uid, friend_name: '目标测试C', memory_card: JSON.stringify({ profile: { stage: '暧昧' } }) }) });
  const rC = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ query: '今天好累啊', history: [{ role: 'user', content: '今天好累啊' }], session_id: sidC }),
  });
  console.log('\n[场景C-暧昧无目标] goal=' + rC.d?._debug?.goal + ' (期望:null,按暧昧常规打法)');
  console.log('  ▶ ' + (rC.d?.reply || JSON.stringify(rC.d).slice(0, 150)));

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
