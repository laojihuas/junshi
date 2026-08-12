// 逻辑重复检测验证：部署 ima-proxy + 复现"零食赌注→吃饭赌注"案例
// 期望：主回复若又立同款赌注 → LLM 复核判"框架重复" → dup_hit=true → 重生成不再换皮重犯
// 用法: SBP_PAT=xxx node deploy_logic_dup.mjs
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
(async () => {
  // 1) 部署
  const src = fs.readFileSync('supabase/functions/ima-proxy/index.ts', 'utf8');
  const boundary = '----wb' + Date.now();
  let body = '--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify({ entrypoint_path: 'index.ts', name: 'ima-proxy' }) + '\r\n';
  body += '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/octet-stream\r\n\r\n' + src + '\r\n--' + boundary + '--\r\n';
  const depR = await jf('https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  console.log('部署 ima-proxy:', depR.s === 201 ? 'OK v' + depR.d?.version : 'FAIL ' + depR.s);
  if (depR.s !== 201) process.exit(1);
  await sleep(4000);

  // 2) 临时用户 + 设备 + 会话（预置自己发过的话=零食赌注）
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find((k) => k.name === 'service_role').api_key;
  const email = 'ld_' + Date.now().toString(36) + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LdTest!2026x', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'LdTest!2026x' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const devId = 'vff-device-1786506544710'; // 配额充足
  const sid = crypto.randomUUID();
  const mc = JSON.stringify({
    profile: { stage: '暧昧' },
    recent_self_messages: ['我拿零食当赌注 这剧要是不好看 你要赔'],
    recent_user_messages: ['最近在追那个剧 我可能遇到了救星', '很好看 你可以看一下'],
    updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  await jf(SUPABASE + '/rest/v1/chat_sessions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, user_id: uid, friend_name: '逻辑重复验证', memory_card: mc }) });
  console.log('会话已预置（军师上轮立过"零食赌注"）');

  // 3) 复现案例：女生继续安利剧 → 看军师会不会又立同款赌注（框架重复）
  const hdr = { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': devId };
  const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({
      query: '真的好看，你信我就对了',
      history: [
        { role: 'user', content: '最近在追那个剧 我可能遇到了救星' },
        { role: 'assistant', content: '我拿零食当赌注 这剧要是不好看 你要赔' },
        { role: 'user', content: '很好看 你可以看一下' },
        { role: 'assistant', content: '行 那我看看 不好看找你要零食' },
        { role: 'user', content: '真的好看，你信我就对了' },
      ],
      session_id: sid,
    }),
  });
  const d = r.d || {};
  console.log('\n回复:', String(d.reply || '(错误)'));
  console.log('_debug:', JSON.stringify({ dup_hit: d._debug?.dup_hit, dup_reason: d._debug?.dup_reason, offline: d._debug?.offline, interest_streak: d._debug?.interest_streak }));
  const usage = (d._debug?.llm_usage || []).map((u) => u.stage).join(',');
  console.log('LLM 调用链:', usage || '(无)');
  const logicDup = (d._debug?.llm_usage || []).find((u) => u.stage === 'logic_dup');
  if (logicDup) console.log('logic_dup 调用: in=' + logicDup.prompt_tokens + ' out=' + logicDup.completion_tokens);
  console.log('\n[结论] dup_hit=' + d._debug?.dup_hit + (d._debug?.dup_hit ? ' 重生成已生效（换皮赌注被拦）' : ' 未触发（回复未立同款框架，或复核放行）'));

  // 4) 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  await jf(SUPABASE + '/rest/v1/chat_sessions?id=eq.' + sid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n已清理');
})();
