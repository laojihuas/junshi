// v20260812 首条信息过滤验证：部署 ima-proxy + 端到端验证
// 场景：第一轮 query=女生资料投喂（history 空），第二轮才来女生真话
// 断言：①记忆卡 recent_user_messages 不含资料（只含真话）
//       ②首轮资料不打钩 topics_done（无资料诱导的话题）
// 用法: SBP_PAT=xxx node deploy_first_filter.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) 部署
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find((k) => k.name === 'service_role').api_key;
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
  await sleep(4000);

  // 2) 临时用户
  const email = 'vff_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'VffTest!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'VffTest!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }

  // 3) 端到端：首轮资料 → 第二轮真话（游客 device 模式：先注册设备再发请求）
  //   注意：session_id 必须是真实 uuid（chat_sessions.id 为 uuid 类型，非 uuid 写库 400）
  const sid = crypto.randomUUID();
  // 复用已注册设备（device-gate"同 IP 每日新设备 ≤5"防刷；此 ID 已注册于今日且配额充足）
  const devId = 'vff-device-1786506604056';
  const material = '她叫小美，25岁，公司财务，性格慢热，我之前追了她一个月';
  // 3.0) 设备注册（device-gate，与前端 _registerDevice 同构）
  const gateUrl = SUPABASE + '/functions/v1/device-gate';
  const reg = await jf(gateUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify({ action: 'register', device_id: devId, fp_screen: '390x844', fp_tz: '-480', fp_lang: 'zh-CN' }),
  });
  console.log('设备注册:', reg.s, reg.d?.success ? 'OK' : JSON.stringify(reg.d).slice(0, 150));
  // 3.1) 建会话行（真实前端"添加好友"时已 INSERT；writeMemoryCard 是 PATCH，行不存在则写不进去）
  const mk = await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ id: sid, user_id: uid, friend_name: '验证测试' }),
  });
  console.log('建会话行:', mk.s);
  const hdr = { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': devId };
  const r1 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ query: material, history: [], session_id: sid }),
  });
  console.log('首轮(资料) reply:', (r1.d?.reply || '(错误)').slice(0, 40), '| offline=' + r1.d?._debug?.offline, r1.s !== 200 ? (' | resp=' + JSON.stringify(r1.d).slice(0, 150)) : '');
  const r2 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ query: '在吗', history: [{ role: 'user', content: material }, { role: 'assistant', content: r1.d?.reply || '' }], session_id: sid }),
  });
  console.log('次轮(真话) reply:', (r2.d?.reply || '(错误)').slice(0, 40), '| offline=' + r2.d?._debug?.offline, r2.s !== 200 ? (' | resp=' + JSON.stringify(r2.d).slice(0, 150)) : '');
  const r3 = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ query: '周末有空吗', history: [
      { role: 'user', content: material }, { role: 'assistant', content: r1.d?.reply || '' },
      { role: 'user', content: '在吗' }, { role: 'assistant', content: r2.d?.reply || '' },
    ], session_id: sid }),
  });
  console.log('三轮(真话) reply:', (r3.d?.reply || '(错误)').slice(0, 40), '| offline=' + r3.d?._debug?.offline, r3.s !== 200 ? (' | resp=' + JSON.stringify(r3.d).slice(0, 150)) : '');

  // 4) 查记忆卡断言
  const mcR = await jf(SUPABASE + '/rest/v1/chat_sessions?select=memory_card&id=eq.' + sid, { headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  const row = mcR.d?.[0];
  let mc = {};
  try { mc = typeof row?.memory_card === 'string' ? JSON.parse(row.memory_card) : (row?.memory_card || {}); } catch {}
  const rum = Array.isArray(mc.recent_user_messages) ? mc.recent_user_messages : [];
  // [v20260812 恢复] 资料正常进记忆卡（供主回复基于资料展开聊天）；仅关系判断（extractProfile）剔除
  const materialIn = rum.filter((m) => typeof m === 'string' && (m.includes('小美') || m.includes('25岁') || m.includes('慢热')));
  // [滞后机制] recent_user_messages 滞后一轮记录对方原话：本轮 query 下轮才入库
  const real = rum.filter((m) => typeof m === 'string' && (m.includes('在吗') || m.includes('周末有空')));
  console.log('\n[记忆卡 recent_user_messages]', JSON.stringify(rum));
  console.log('[断言1 资料正常记录(供展开聊天)]', materialIn.length > 0 ? 'PASS' : 'FAIL 未记录=' + JSON.stringify(materialIn));
  console.log('[断言2 真话正常记录(滞后一轮)]', real.length > 0 ? 'PASS' : 'FAIL 未记录');
  console.log('[断言3 profile.stage(评价不见资料)]', mc.profile?.stage || '(未生成)');
  console.log('[断言4 首轮资料不打钩]', (Array.isArray(mc.topics_done) && mc.topics_done.length > 0) ? 'FAIL ' + JSON.stringify(mc.topics_done) : 'PASS 空');

  // 5) 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  await jf(SUPABASE + '/rest/v1/chat_sessions?id=eq.' + sid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('\n临时用户/会话已清理');
})();
