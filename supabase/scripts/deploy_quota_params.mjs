// 部署 prompt-update/prompt-get + 端到端验证配额参数保存链路
// 流程：临时管理员用户 → prompt-get 读当前 → prompt-update 改 vip=666 → prompt-get 确认 → 恢复 500
// 用法: SBP_PAT=xxx node deploy_quota_params.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const fs = await import('node:fs');
async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function deploy(slug, path) {
  const src = fs.readFileSync(path, 'utf8');
  const boundary = '----wb' + Date.now() + slug;
  let body = '--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify({ entrypoint_path: 'index.ts', name: slug }) + '\r\n';
  body += '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/octet-stream\r\n\r\n' + src + '\r\n--' + boundary + '--\r\n';
  const r = await jf('https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=' + slug, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  console.log('部署', slug + ':', r.s === 201 ? 'OK v' + r.d?.version : 'FAIL ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 200));
  return r.s === 201;
}
(async () => {
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find((k) => k.name === 'service_role').api_key;
  const ok1 = await deploy('prompt-update', 'supabase/functions/prompt-update/index.ts');
  const ok2 = await deploy('prompt-get', 'supabase/functions/prompt-get/index.ts');
  if (!ok1 || !ok2) process.exit(1);
  await sleep(4000);

  // 临时管理员：admin API 建用户 + 设 is_admin
  const email = 'qpa_' + Date.now().toString(36) + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'QpaTest!2026x', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'QpaTest!2026x' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  await jf(SUPABASE + '/rest/v1/profiles?id=eq.' + uid, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify({ is_admin: true }) });

  const authH = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok };
  // 1) prompt-get 读当前
  const g1 = await jf(SUPABASE + '/functions/v1/prompt-get', { method: 'POST', headers: authH, body: '{}' });
  console.log('[1] prompt-get quota_params:', JSON.stringify(g1.d?.quota_params));
  // 2) prompt-update 改 vip_daily_limit=666
  const up = await jf(SUPABASE + '/functions/v1/prompt-update', {
    method: 'POST', headers: authH,
    body: JSON.stringify({ quota_params: { ...(g1.d?.quota_params || {}), vip_daily_limit: 666 } }),
  });
  console.log('[2] prompt-update 保存 vip=666:', up.s, JSON.stringify(up.d).slice(0, 120));
  // 3) prompt-get 确认
  const g2 = await jf(SUPABASE + '/functions/v1/prompt-get', { method: 'POST', headers: authH, body: '{}' });
  console.log('[3] prompt-get 回读 vip:', g2.d?.quota_params?.vip_daily_limit, g2.d?.quota_params?.vip_daily_limit === 666 ? 'PASS' : 'FAIL');
  // 4) 非法值应被拒
  const bad = await jf(SUPABASE + '/functions/v1/prompt-update', { method: 'POST', headers: authH, body: JSON.stringify({ quota_params: { vip_daily_limit: 999999 } }) });
  console.log('[4] 非法值 999999 被拒:', bad.s === 400 ? 'PASS' : 'FAIL ' + JSON.stringify(bad.d).slice(0, 100));
  // 5) 恢复 500
  await jf(SUPABASE + '/functions/v1/prompt-update', { method: 'POST', headers: authH, body: JSON.stringify({ quota_params: { ...(g1.d?.quota_params || {}), vip_daily_limit: 500 } }) });
  const g3 = await jf(SUPABASE + '/functions/v1/prompt-get', { method: 'POST', headers: authH, body: '{}' });
  console.log('[5] 恢复 vip=500:', g3.d?.quota_params?.vip_daily_limit === 500 ? 'PASS' : 'FAIL');

  // 清理临时用户（注意不动 app_config 其他字段）
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n已清理');
})();
