// v56 人性化四件套验证：意图解读/双关幽默/IOI升级/锚点
// 用法: SBP_PAT=xxx node deploy_v56.mjs
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

  const email = 'v56_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V56Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V56Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  const cases = [
    { name: '意图-哈哈(应有笑因不盯字面)', q: '哈哈', history: [
      { role: 'user', content: '你是不是经常这么撩女生' },
      { role: 'assistant', content: '这么问 是不是怕我被别人撩走啊' },
      { role: 'user', content: '谁怕啊 你想多了' },
      { role: 'assistant', content: '嘴上说没有 眼睛倒是很诚实 你这种女生嘴越硬心里越软' },
      { role: 'user', content: '哈哈' } ] },
    { name: '意图-敷衍(随便,应主导不追问)', q: '随便啊，你看着办', history: [
      { role: 'user', content: '周末要不要一起出去逛逛' },
      { role: 'assistant', content: '正好知道有家店你肯定喜欢' },
      { role: 'user', content: '随便啊，你看着办' } ] },
    { name: '意图-借口(太远/上班,应化解或洒脱)', q: '太远了吧，我明天还要上班呢', history: [
      { role: 'user', content: '周末有空吗，带你去个有意思的地方' },
      { role: 'assistant', content: '那必须给你留个位置' },
      { role: 'user', content: '太远了吧，我明天还要上班呢' } ] },
    { name: '双关-放盐', q: '放盐就放盐，怎么又说到生一群小孩了', history: [
      { role: 'user', content: '回头我带只鸡过去 咱俩加菜' },
      { role: 'assistant', content: '鸡我负责 你负责把盐放准就行' },
      { role: 'user', content: '是呢 最怕手抖' },
      { role: 'assistant', content: '手抖了还有我兜底' },
      { role: 'user', content: '放盐就放盐，怎么又说到生一群小孩了' } ] },
    { name: 'IOI-发照片(应接住并升级)', q: '你说的是这只吗，图片，漂亮吧', history: [
      { role: 'user', content: '又路过环山路那家奶茶店了 那只猫今天没在门口' },
      { role: 'assistant', content: '是不是跑钦北山找你了' },
      { role: 'user', content: '你说的是这只吗，图片，漂亮吧' } ] },
    { name: 'IOI-喜欢小孩(应推进)', q: '我肯定喜欢小孩啊', history: [
      { role: 'user', content: '咱俩这顿白粥配鸡 都要吃出未来规划了' },
      { role: 'assistant', content: '那得看你俩谁先认怂' },
      { role: 'user', content: '我肯定喜欢小孩啊' } ] },
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: c.q, history: c.history, session_id: 'v56-' + i + '-' + Date.now() }),
    });
    const reply = r.d?.reply || '(错误)';
    const len = reply.replace(/\s/g, '').length;
    console.log('\n[' + c.name + '] (' + len + '字)');
    console.log('  ▶ ' + reply);
  }

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
