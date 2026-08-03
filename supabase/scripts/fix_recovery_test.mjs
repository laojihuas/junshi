// v12 修复验证：挽回期场景（UUID session + SQL 设 stage=挽回）+ 同步后台 system_prompt 攻击性打法口径
// 用法: SBP_PAT=xxx node fix_recovery_test.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
(async () => {
  const keys = await (await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 1) 后台 system_prompt 攻击性打法改为"反击"口径（保留其余原文）
  const cfgR = await jf(SUPABASE + '/rest/v1/app_config?id=eq.1&select=system_prompt', { headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  let sp = cfgR.d?.[0]?.system_prompt || '';
  const oldLine = `- 攻击性（她怼你）：先化解攻击点（不吵架、不被带节奏），再自然切换新话题；她只是情绪低落/受伤（非攻击）时：先共情安抚，绝不调侃。`;
  const newLine = `- 攻击性（她怼你/阴阳怪气/贬低你）：不卑微、不道歉、不当没看见，立刻反击（幽默回怼/犀利顶回/冷淡留白），怼完留钩子拿回主动权；她只是情绪低落/受伤（非攻击）时：先共情安抚，绝不调侃。`;
  if (sp.includes(oldLine)) {
    sp = sp.replace(oldLine, newLine);
    const up = await jf(SUPABASE + '/rest/v1/app_config?id=eq.1', { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ system_prompt: sp }) });
    console.log('system_prompt 攻击性打法更新:', up.s === 204 ? 'OK' : 'FAIL ' + up.s);
  } else if (sp.includes('先化解攻击点')) {
    console.log('WARN: 找到类似但未精确匹配的旧文案，需人工核对');
    const idx = sp.indexOf('攻击性');
    console.log(sp.slice(idx, idx + 120));
  } else {
    console.log('INFO: 未找到"先化解攻击点"文案（可能已是新口径）');
  }

  // 2) 临时用户 + UUID 挽回期会话（SQL 直接设 memory_card，绕过 RLS 插入限制）
  const email = 'v12r_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V12RTest!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V12RTest!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  if (!tok) { console.error('登录失败'); process.exit(1); }
  const sid = crypto.randomUUID();
  const ins = await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sid, user_id: uid, friend_name: '挽回期测试对象', note: 'v12r', memory_card: JSON.stringify({ profile: { stage: '挽回' } }) }),
  });
  console.log('挽回期会话创建:', ins.s, ins.s >= 400 ? JSON.stringify(ins.d).slice(0, 200) : '');

  // 3) 挽回期攻击场景验证（期望 attack_detected=false + 输出稳住不反击）
  const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '你烦不烦，别来打扰我了行吗', history: [{ role: 'user', content: '你烦不烦，别来打扰我了行吗' }], session_id: sid }),
  });
  const d = r.d?._debug || {};
  console.log('\n[挽回期攻击] attack_detected=' + d.attack_detected + ' stage=' + d.memory_stage + ' (期望 false / 挽回)');
  console.log('  ▶ ' + (r.d?.reply || '(错误 ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 150) + ')'));

  // 清理
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('临时用户已清理');
})();
