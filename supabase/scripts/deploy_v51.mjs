// v51 字数压缩验证：部署 + 场景回归 + 字数统计（A+B+C）
// 用法: SBP_PAT=xxx node deploy_v51.mjs
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

  // 部署（multipart: file=单个源码文件）
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
  const depR = await jf('https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=' + SLUG, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  const ver = depR.d?.version;
  console.log('部署:', depR.s === 201 ? 'OK v' + ver : 'FAIL ' + depR.s + ' ' + JSON.stringify(depR.d).slice(0, 200));
  if (depR.s !== 201) process.exit(1);
  await new Promise(r => setTimeout(r, 3000));

  // 临时用户
  const email = 'v51_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V51Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V51Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  // 挽回期会话（friend_name NOT NULL + id UUID）
  const sidR = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sidR, user_id: uid, friend_name: '挽回测试', memory_card: JSON.stringify({ profile: { stage: '挽回' } }) }),
  });

  const cases = [
    { name: '攻击-挑衅', q: '呵呵，就你这样还想追我？省省吧' },
    { name: '攻击-贬低', q: '你也就这点本事了，真没意思' },
    { name: '调情', q: '今天好无聊呀，一个人在家躺着' },
    { name: '否定', q: '我觉得男生就应该天天哄着女生，不然就是不爱的表现' },
    { name: '低落', q: '今天被领导骂了一顿，好难过' },
    { name: '挽回期攻击', q: '你烦不烦，别来打扰我了行吗', sid: sidR },
    { name: '普通', q: '刚吃完饭，你呢' },
    { name: '长消息', q: '我今天跟我闺蜜出去逛街了，看到好多好看的衣服，然后我们还去吃了火锅，特别开心，你呢你今天在干嘛呀' },
  ];
  const stat = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const sid = c.sid || ('v51-case' + i + '-' + Date.now());
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: sid }),
    });
    const reply = r.d?.reply || '';
    const len = reply.replace(/\s/g, '').length;
    stat.push(len);
    const flag = len <= 30 ? 'OK' : 'LONG';
    console.log('[' + c.name + '] ' + len + '字 ' + flag + ' attack=' + r.d?._debug?.attack_detected);
    console.log('  ▶ ' + reply);
  }
  const okN = stat.filter(n => n <= 30).length;
  console.log('\n字数统计: ≤30字 ' + okN + '/' + stat.length + '，平均 ' + Math.round(stat.reduce((a, b) => a + b, 0) / stat.length) + ' 字');

  // 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('临时用户已清理');
})();
