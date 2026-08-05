// v15 时间/位置注入：部署 + 场景验证 + 清理（防幽灵计数）
// 用法: SBP_PAT=xxx node deploy_time_v15.mjs
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

  // 1. 部署（multipart: file=单个源码文件）
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
  const email = 'v15_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V15Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V15Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  const deviceId = 'test_time_' + Date.now().toString(36).slice(-10);
  // 测试前 ip_usage new_devices 总量（用于清理时扣回）
  const before = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const beforeSum = before[0].s;

  const reg = await jf(SUPABASE + '/functions/v1/device-gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify({ action: 'register', device_id: deviceId, invite_code: null })
  });
  console.log('设备注册:', reg.s, JSON.stringify(reg.d));

  // 3. 给测试用户写简介（含位置）
  await jf(SUPABASE + '/rest/v1/profiles?id=eq.' + uid, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio: '我在北京工作，程序员' })
  });

  // 4. 场景验证（带 X-Device-Id）
  const cases = [
    { name: '问时间', q: '现在几点了呀？' },
    { name: '傍晚说晚', q: '这么晚了还不睡？' },
    { name: '半夜约人', q: '好无聊啊，出来玩不？' },
    { name: '位置', q: '你在哪儿呀？离我近不近？' },
  ];
  for (const c of cases) {
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: 'v15-' + c.name + '-' + Date.now() }),
    });
    console.log('\n[' + c.name + '] ' + (r.s === 200 ? 'OK' : 'HTTP ' + r.s));
    console.log('  时间:', r.d?._debug?.now_cn || '-');
    console.log('  位置:', r.d?._debug?.location || '-');
    console.log('  ▶ ' + (r.d?.reply || JSON.stringify(r.d).slice(0, 200)));
  }

  // 5. 清理：删设备 + 扣回 ip_usage 计数 + 删临时用户
  await sql(SR, `DELETE FROM public.devices WHERE device_id = '${deviceId}'`);
  const after = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const delta = after[0].s - beforeSum;
  if (delta > 0) {
    await sql(SR, `UPDATE ip_usage SET new_devices = greatest(0, new_devices - ${delta}) WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date AND new_devices > 0`);
    console.log('已扣回测试污染计数:', delta);
  }
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('临时用户/设备已清理');
})();
