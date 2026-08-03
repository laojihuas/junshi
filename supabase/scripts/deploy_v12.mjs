// v14 部署 + 端到端验证：有脾气/敢调情/敢否定/会反击
// 用法: SBP_PAT=xxx node deploy_v12.mjs
// 注意: 挽回期用例的 chat_sessions 插入必须带 friend_name(NOT NULL),否则 stage 读不到 → attack_detected 误判
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
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
  // 1) service_role
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 2) 查当前 app_config（确认 system_prompt 是否有"得体/礼貌"类词）
  const cfgR = await jf(SUPABASE + '/rest/v1/app_config?id=eq.1&select=system_prompt,llm_params', {
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR }
  });
  const cfg = cfgR.d?.[0] || {};
  console.log('=== 当前 system_prompt ===');
  console.log(cfg.system_prompt || '(empty)');
  console.log('=== 当前 llm_params ===');
  console.log(cfg.llm_params || '(empty)');

  // 3) 更新 llm_params（v12: 温度 0.6 / freq 0.7；保留 thinking_mode）
  const oldParams = (() => { try { return JSON.parse(cfg.llm_params || '{}'); } catch { return {}; } })();
  const newParams = {
    temperature: 0.6,
    frequency_penalty: 0.7,
    presence_penalty: typeof oldParams.presence_penalty === 'number' ? oldParams.presence_penalty : 0,
    max_tokens: typeof oldParams.max_tokens === 'number' ? oldParams.max_tokens : 1200,
    thinking_mode: typeof oldParams.thinking_mode === 'string' ? oldParams.thinking_mode : 'off',
  };
  const updR = await jf(SUPABASE + '/rest/v1/app_config?id=eq.1', {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm_params: JSON.stringify(newParams) })
  });
  console.log('llm_params 更新:', updR.s === 204 ? 'OK' : 'FAIL ' + updR.s);

  // 4) 部署 Edge Function（multipart: file=单个源码文件）
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
    headers: {
      'Authorization': 'Bearer ' + PAT,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body,
  });
  const ver = depR.d?.version;
  console.log('部署:', depR.s === 201 ? 'OK v' + ver : 'FAIL ' + depR.s + ' ' + JSON.stringify(depR.d).slice(0, 300));
  if (depR.s !== 201) process.exit(1);
  await new Promise(r => setTimeout(r, 3000));

  // 5) 端到端验证（临时用户）
  const email = 'v12_' + Date.now() + '@tmp.dev';
  const a1 = await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V12Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V12Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败:', JSON.stringify(l1.d)); process.exit(1); }

  // 6) 挽回期测试会话：预设 memory_card.stage=挽回（friend_name 为 NOT NULL 必填；id 必须 UUID）
  const sidRecovery = crypto.randomUUID();
  await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sidRecovery, user_id: uid, friend_name: '挽回期测试对象', note: 'v12test', memory_card: JSON.stringify({ profile: { stage: '挽回' } }) })
  });

  const cases = [
    { name: '攻击-挑衅', q: '呵呵，就你这样还想追我？省省吧', want: '反击' },
    { name: '攻击-贬低', q: '你也就这点本事了，真没意思', want: '反击' },
    { name: '调情', q: '今天好无聊呀，一个人在家躺着', want: '有态度/调情', stage: '暧昧' },
    { name: '否定', q: '我觉得男生就应该天天哄着女生，不然就是不爱的表现', want: '敢于否定' },
    { name: '低落', q: '今天被领导骂了一顿，好难过', want: '共情不调侃' },
    { name: '挽回期攻击', q: '你烦不烦，别来打扰我了行吗', want: '不反击/稳住', sid: sidRecovery },
    { name: '普通', q: '刚吃完饭，你呢', want: '自然' },
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const sid = c.sid || ('v12-case' + i + '-' + Date.now());
    const t0 = Date.now();
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: sid }),
    });
    const ms = Date.now() - t0;
    const d = r.d?._debug || {};
    console.log('\n[' + c.name + '] ' + ms + 'ms (期望: ' + c.want + ')');
    console.log('  attack_detected=' + d.attack_detected + ' stage=' + d.memory_stage + ' thinking=' + d.thinking_mode);
    console.log('  ▶ ' + (r.d?.reply || '(错误 ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 150) + ')'));
  }

  // 7) 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户已清理');
})();
