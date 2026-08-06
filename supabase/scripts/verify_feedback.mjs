// 端到端验证 feedback RPC：管理员读取 / 非管理员拒绝
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺 PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
process.env.NO_PROXY = '*';

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}

(async () => {
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  const email = 'fbadmin_' + Date.now() + '@jssl.local';
  const u = await jf(SUPABASE + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!', email_confirm: true })
  });
  const uid = u.d?.id;
  await jf(SUPABASE + '/rest/v1/profiles', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: uid, is_admin: true })
  });
  const tok = await jf(SUPABASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  });
  const JWT = tok.d?.access_token;

  const list = await jf(SUPABASE + '/rest/v1/rpc/admin_feedback_list', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: '{}'
  });
  console.log('管理员调 admin_feedback_list:', list.s, JSON.stringify(list.d).slice(0, 200));

  const anonList = await jf(SUPABASE + '/rest/v1/rpc/admin_feedback_list', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: '{}'
  });
  console.log('匿名调 admin_feedback_list:', anonList.s, JSON.stringify(anonList.d).slice(0, 120));

  if (uid) await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
})();
