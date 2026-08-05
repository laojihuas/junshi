// v16 套路轮数收紧 + 优先级降级：部署 + 验证 + 清理
// 用法: SBP_PAT=xxx node deploy_strategy_v16.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const API = 'https://api.supabase.com/v1/projects/' + REF;
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const SLUG = 'ima-proxy';
const SRC = new URL('../functions/ima-proxy/index.ts', import.meta.url);

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
async function sql(key, q) {
  const r = await jf(API + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q })
  });
  if (r.s !== 201) { console.error('SQL FAIL', r.s, JSON.stringify(r.d).slice(0, 300)); process.exit(1); }
  return r.d;
}

(async () => {
  const keys = await (await fetch(API + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 1. 部署
  const fs = await import('node:fs');
  const fileContent = fs.readFileSync(SRC, 'utf8');
  const boundary = '----wb' + Date.now();
  const meta = JSON.stringify({ entrypoint_path: 'index.ts', name: SLUG });
  let body = '';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="metadata"\r\n\r\n' + meta + '\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="file"; filename="index.ts"\r\n';
  body += 'Content-Type: application/octet-stream\r\n\r\n';
  body += fileContent + '\r\n';
  body += '--' + boundary + '--\r\n';
  const depR = await jf(API + '/functions/deploy?slug=' + SLUG, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  const ver = depR.d?.version;
  console.log('部署:', depR.s === 201 ? 'OK v' + ver : 'FAIL ' + depR.s + ' ' + JSON.stringify(depR.d).slice(0, 300));
  if (depR.s !== 201) process.exit(1);
  await new Promise(r => setTimeout(r, 3000));

  // 2. 测试用户 + 设备
  const email = 'v16_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V16Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V16Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const deviceId = 'test_v16_' + Date.now().toString(36).slice(-8);

  const before = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const beforeSum = before[0].s;
  await jf(SUPABASE + '/functions/v1/device-gate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify({ action: 'register', device_id: deviceId, invite_code: null })
  });
  await jf(SUPABASE + '/rest/v1/profiles?id=eq.' + uid, {
    method: 'PATCH', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio: '我在北京工作，程序员' })
  });

  // 3. 套路启动验证：新会话（无记忆卡）→ 观察 strategy_max_rounds
  const cases = [
    { name: '新会话-套路启动', q: '在干嘛呢', sid: 'v16-a-' + Date.now() },
    { name: '新会话-套路启动2', q: '今天好无聊', sid: 'v16-b-' + Date.now() },
    { name: '新会话-套路启动3', q: '刚下班，好累', sid: 'v16-c-' + Date.now() },
  ];
  for (const c of cases) {
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: c.sid }),
    });
    const d = r.d || {};
    const mr = d._debug?.strategy_max_rounds;
    const name = d._debug?.strategy_name;
    const ok = mr != null && mr <= 5;
    console.log('[' + c.name + '] ' + (r.s === 200 ? 'OK' : 'HTTP ' + r.s) + ' 套路=' + (name || '-') + ' max_rounds=' + (mr ?? '-') + (ok ? ' ✓(≤5)' : ' ✗'));
    console.log('  ▶ ' + String(d.reply || '').slice(0, 60));
  }

  // 4. 清理
  await sql(SR, `DELETE FROM public.devices WHERE device_id = '${deviceId}'`);
  const after = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const delta = after[0].s - beforeSum;
  if (delta > 0) {
    await sql(SR, `UPDATE ip_usage SET new_devices = greatest(0, new_devices - ${delta}) WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date AND new_devices > 0`);
    console.log('已扣回测试污染计数:', delta);
  }
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('清理完成');
})();
