// v57 长期记忆 facts 验证（适配 v20260805 设备体系：登录→注册 device→带 X-Device-Id 调用）
// 用法: SBP_PAT=xxx node verify_v57.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const GATE = SUPABASE + '/functions/v1/device-gate';
async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
(async () => {
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 1) 建用户 + 密码登录
  const email = 'v57v_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V57VTest!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V57VTest!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  // 2) 注册设备（device-gate）
  const deviceId = 'v57v-' + Date.now().toString(36);
  const reg = await jf(GATE, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok }, body: JSON.stringify({ action: 'register', device_id: deviceId }) });
  console.log('设备注册:', reg.s, reg.d?.success === true ? 'OK free_daily=' + reg.d?.free_daily : JSON.stringify(reg.d).slice(0, 120));

  // 3) 建会话 + 三阶段验证
  const sid = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, user_id: uid, friend_name: '记忆测试', memory_card: JSON.stringify({ profile: { stage: '暧昧' } }) }) });
  const call = (query, history) => jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ query, history, session_id: sid }),
  });

  const r1 = await call('我下周三生日，还不知道去哪吃呢', [{ role: 'user', content: '我下周三生日，还不知道去哪吃呢' }]);
  console.log('\n[轮1-生日] status=' + r1.s + ' facts_len=' + r1.d?._debug?.facts_len + ' facts_injected=' + r1.d?._debug?.facts_injected);
  console.log('  ▶ ' + (r1.d?.reply || JSON.stringify(r1.d).slice(0, 150)));

  const r2 = await call('对了，下周我生日那事，你想好带我去哪了吗', [
    { role: 'user', content: '我下周三生日，还不知道去哪吃呢' },
    { role: 'assistant', content: r1.d?.reply || '' },
    { role: 'user', content: '对了，下周我生日那事，你想好带我去哪了吗' }]);
  console.log('\n[轮2-生日相关(期望注入>0,带记得感)] facts_len=' + r2.d?._debug?.facts_len + ' facts_injected=' + r2.d?._debug?.facts_injected);
  console.log('  ▶ ' + (r2.d?.reply || JSON.stringify(r2.d).slice(0, 150)));

  const r3 = await call('今天天气不错，刚去公园散步了', [{ role: 'user', content: '今天天气不错，刚去公园散步了' }]);
  console.log('\n[轮3-天气不相关(期望注入=0)] facts_len=' + r3.d?._debug?.facts_len + ' facts_injected=' + r3.d?._debug?.facts_injected);
  console.log('  ▶ ' + (r3.d?.reply || JSON.stringify(r3.d).slice(0, 150)));

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
