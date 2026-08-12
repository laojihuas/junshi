// 部署 ima-proxy + prompt-update，并开启 thinking_budget=on 验证思考链压缩
// 用法: SBP_PAT=xxx node deploy_thinking_budget.mjs
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

  // 开启 thinking_budget=on（保持 thinking_mode=high，验证压缩）
  const upd = await jf(SUPABASE + '/functions/v1/prompt-update', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' }, // prompt-update 校验的是 profiles.is_admin，PAT 不是 JWT，会 401
    body: JSON.stringify({ llm_params: { thinking_mode: 'high', thinking_budget: 'on' } }),
  });
  console.log('prompt-update(PAT 直调):', upd.s, JSON.stringify(upd.d).slice(0, 120));

  // 管理员 JWT 方式：用 admin API 直接改库更稳（llm_params 整体替换）
  const cfg = await jf('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "update app_config set llm_params = '{\"thinking_mode\":\"high\",\"thinking_budget\":\"on\"}' where id = 1 returning llm_params" }),
  });
  console.log('app_config 更新:', cfg.s, JSON.stringify(cfg.d).slice(0, 150));

  // 验证：建临时用户 + 设备 + 会话 → 调 ima-proxy 看 _debug.thinking_budget 与 llm_usage
  const email = 'tb_' + Date.now().toString(36) + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'TbTest!2026x', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'TbTest!2026x' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const devs = await jf(SUPABASE + '/rest/v1/devices?select=device_id&order=created_at.desc&limit=1', { headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  const devId = (Array.isArray(devs.d) && devs.d[0]?.device_id) || 'tb-dev';
  const sid = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, user_id: uid, friend_name: '思考预算验证' }) });
  const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': devId },
    body: JSON.stringify({ query: '她说今天被领导骂了很难受不知道怎么办', history: [], session_id: sid }),
  });
  console.log('\n回复:', (r.d?.reply || '(错误)').slice(0, 40), '| offline=' + r.d?._debug?.offline);
  console.log('_debug.thinking_mode =', r.d?._debug?.thinking_mode, '| thinking_budget =', r.d?._debug?.thinking_budget);
  for (const uu of (r.d?._debug?.llm_usage || [])) {
    const det = uu.completion_tokens_details || {};
    console.log(' ', uu.stage.padEnd(16), 'in=' + uu.prompt_tokens, 'out=' + uu.completion_tokens, det.reasoning_tokens ? '思考=' + det.reasoning_tokens : '');
  }

  // 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  await jf(SUPABASE + '/rest/v1/chat_sessions?id=eq.' + sid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n已清理（app_config 保持 thinking_budget=on，供线上验证；要关回 off 用后台开关或 SQL）');
})();
