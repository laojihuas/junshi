// 部署 ima-proxy + prompt-update，app_config 设 thinking_budget=auto（默认档），并验证高峰判定
// 用法: SBP_PAT=xxx node deploy_budget_auto.mjs
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
  const ok1 = await deploy('ima-proxy', 'supabase/functions/ima-proxy/index.ts');
  const ok2 = await deploy('prompt-update', 'supabase/functions/prompt-update/index.ts');
  if (!ok1 || !ok2) process.exit(1);
  await sleep(4000);

  // 设 thinking_budget=auto（默认档；保留 thinking_mode=high）
  const cfg = await jf('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "update app_config set llm_params = '{\"thinking_mode\":\"high\",\"thinking_budget\":\"auto\"}' where id = 1 returning llm_params" }),
  });
  console.log('app_config:', cfg.s, JSON.stringify(cfg.d).slice(0, 150));

  // 验证：当前真实时间下 auto 档行为
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const h = parts.find((p) => p.type === 'hour')?.value;
  console.log(`当前 Asia/Shanghai: ${wd} ${h} 点`);

  // 复刻 isDeepSeekPeak 测试边界
  const cases = [
    ['周一 08:59', 'Mon', 8, false], ['周一 09:00', 'Mon', 9, true], ['周一 11:59', 'Mon', 11, true],
    ['周一 12:00', 'Mon', 12, false], ['周一 13:59', 'Mon', 13, false], ['周一 14:00', 'Mon', 14, true],
    ['周一 17:59', 'Mon', 17, true], ['周一 18:00', 'Mon', 18, false], ['周六 10:00', 'Sat', 10, false],
    ['周日 15:00', 'Sun', 15, false],
  ];
  const isPeak = (wd2, h2) => {
    if (wd2 === 'Sat' || wd2 === 'Sun') return false;
    return (h2 >= 9 && h2 < 12) || (h2 >= 14 && h2 < 18);
  };
  let pass = 0;
  for (const [name, w, hh, expect] of cases) {
    const got = isPeak(w, hh);
    const ok = got === expect;
    if (ok) pass++;
    console.log(`  ${name}: ${got ? '高峰' : '非高峰'} ${ok ? 'PASS' : 'FAIL(期望' + expect + ')'}`);
  }
  console.log(`边界测试 ${pass}/${cases.length} 通过`);

  // 端到端：真实调用验证 _debug.thinking_budget=auto + budget_peak（当前若高峰则 budget_active=true）
  const email = 'ba_' + Date.now().toString(36) + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'BaTest!2026x', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'BaTest!2026x' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const devs = await jf(SUPABASE + '/rest/v1/devices?select=device_id&order=created_at.desc&limit=1', { headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  const devId = (Array.isArray(devs.d) && devs.d[0]?.device_id) || 'ba-dev';
  const sid = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, user_id: uid, friend_name: 'auto验证' }) });
  const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': devId },
    body: JSON.stringify({ query: '她说今天被领导骂了很难受', history: [], session_id: sid }),
  });
  console.log('\n端到端: reply=' + (r.d?.reply || '(错误)').slice(0, 30));
  console.log('_debug:', JSON.stringify({ thinking_mode: r.d?._debug?.thinking_mode, thinking_budget: r.d?._debug?.thinking_budget, budget_active: r.d?._debug?.budget_active, budget_peak: r.d?._debug?.budget_peak }));
  const main = (r.d?._debug?.llm_usage || []).find((u) => u.stage === 'main_reply');
  console.log('main_reply 思考 token:', main?.completion_tokens_details?.reasoning_tokens ?? 'N/A');

  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  await jf(SUPABASE + '/rest/v1/chat_sessions?id=eq.' + sid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n已清理（app_config 保持 thinking_budget=auto 默认档）');
})();
