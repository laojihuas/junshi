// v53 gem 精华打分验证：部署 + 检索场景 + gem 分布统计
// 用法: SBP_PAT=xxx node deploy_v53.mjs
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

  const email = 'v53_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V53Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V53Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  const cases = [
    { name: '邀约', q: '我想约她周末出来吃饭，怎么开口比较自然' },
    { name: '忽冷忽热', q: '她这两天对我忽冷忽热的，回消息很慢，我该怎么办' },
    { name: '夸她', q: '怎么夸她才不显得油腻，她发了一张自拍给我' },
    { name: '结束话题', q: '她说要去洗澡了，我怎么回显得不舔' },
    { name: '攻击', q: '呵呵，就你这样还想追我？省省吧' },
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: 'v53-' + i + '-' + Date.now() }),
    });
    const d = r.d?._debug || {};
    const gems = Array.isArray(d.kb_gem) ? d.kb_gem.join(',') : 'n/a';
    console.log('\n[' + c.name + '] kb_items=' + d.kb_items + ' gem_avg=' + d.kb_gem_avg + ' gem=[' + gems + ']');
    console.log('  ▶ ' + (r.d?.reply || '(错误 ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 150) + ')'));
  }

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
