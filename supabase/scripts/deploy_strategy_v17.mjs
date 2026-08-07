// v17 套路提炼灵魂保留：部署 + 端到端验证 + 清理
// 验证目标：
//   1. 套路能正常启动（strategy_name 非空）
//   2. memory_card.strategy 含 essence 字段（核心原理）
//   3. strategy.steps 含原文例句（引号标注，非官方腔）
// 用法: SBP_PAT=xxx node deploy_strategy_v17.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const API = 'https://api.supabase.com/v1/projects/' + REF;
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const SLUG = 'ima-proxy';
const SRC = new URL('../functions/ima-proxy/index.ts', import.meta.url);

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
async function sql(key, q) {
  const r = await jf(API + '/database/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q })
  });
  if (r.s !== 201) { console.error('SQL FAIL', r.s, JSON.stringify(r.d).slice(0, 300)); process.exit(1); }
  return r.d;
}

(async () => {
  const keys = await (await fetch(API + '/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 1. 部署
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
  const depR = await jf(API + '/functions/deploy?slug=' + SLUG, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  const ver = depR.d?.version;
  console.log('部署:', depR.s === 201 ? 'OK v' + ver : 'FAIL ' + depR.s + ' ' + JSON.stringify(depR.d).slice(0, 300));
  if (depR.s !== 201) process.exit(1);
  await new Promise(r => setTimeout(r, 3000));

  // 2. 测试用户 + 设备
  const email = 'v17_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V17Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V17Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const deviceId = 'test_v17_' + Date.now().toString(36).slice(-8);

  const before = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const beforeSum = before[0].s;
  const reg = await jf(SUPABASE + '/functions/v1/device-gate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
    body: JSON.stringify({ action: 'register', device_id: deviceId, fp_screen: '1280x720', fp_tz: '-480', fp_lang: 'zh-CN' })
  });
  console.log('设备注册:', reg.s === 200 ? 'OK' : 'FAIL ' + reg.s + ' ' + JSON.stringify(reg.d).slice(0, 200));
  if (reg.s !== 200) process.exit(1);

  // 3. 多 session 触发套路启动（任一命中即验证 essence）
  const cases = [
    { name: '场景1-下班累', q: '刚下班，好累啊，今天破事一堆', note: 'v17-a' },
    { name: '场景2-被骂', q: '今天被领导当着全组骂了，好难受', note: 'v17-b' },
    { name: '场景3-无聊', q: '好无聊啊，你在干嘛呢', note: 'v17-c' },
  ];
  let hit = null;
  for (const c of cases) {
    const sessionId = crypto.randomUUID();
    await jf(SUPABASE + '/rest/v1/chat_sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ id: sessionId, user_id: uid, friend_name: c.note, note: 'v17 验证' }),
    });
    const r = await jf(SUPABASE + '/functions/v1/ima-proxy', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ query: c.q, history: [{ role: 'user', content: c.q }], session_id: sessionId }),
    });
    const dbg = r.d?._debug || {};
    console.log('[' + c.name + '] ' + (r.s === 200 ? 'OK' : 'HTTP ' + r.s) + ' 套路=' + (dbg.strategy_name || '-'));
    console.log('  ▶ ' + String(r.d?.reply || '').slice(0, 50));
    if (dbg.strategy_name) {
      // 查 memory_card 完整 strategy
      const rows = await sql(SR, `SELECT memory_card FROM public.chat_sessions WHERE id = '${sessionId}'`);
      const mc = rows[0]?.memory_card;
      try {
        const obj = typeof mc === 'string' ? JSON.parse(mc) : mc;
        hit = obj?.strategy || null;
      } catch { hit = null; }
      if (hit) break;
    }
  }

  // 4. 验证 essence + 例句
  let pass = false;
  if (hit && hit.name) {
    console.log('\n===== 套路提炼结果（v17）=====');
    console.log('name  :', hit.name);
    console.log('goal  :', hit.goal);
    console.log('essence:', hit.essence || '（无！✗）');
    (hit.steps || []).forEach((st, i) => console.log(`step${i + 1}: ${st}`));
    const hasEssence = !!hit.essence;
    const hasQuote = (hit.steps || []).some(st => /[“"『「]/.test(st));
    pass = hasEssence && hasQuote;
    console.log('\n[essence 存在] ' + (hasEssence ? '✓' : '✗') + '  [steps 含例句] ' + (hasQuote ? '✓' : '✗'));
    console.log('总体: ' + (pass ? 'PASS ✓' : 'FAIL ✗（essence 或例句缺失）'));
  } else {
    console.log('\n未命中套路启动（检索未触发，重跑换 query 或检查 kb_blocks 数据）');
  }

  // 5. 清理
  await sql(SR, `DELETE FROM public.devices WHERE device_id = '${deviceId}'`);
  await sql(SR, `DELETE FROM public.chat_messages WHERE session_id IN (SELECT id FROM public.chat_sessions WHERE user_id = '${uid}')`);
  await sql(SR, `DELETE FROM public.chat_sessions WHERE user_id = '${uid}'`);
  const after = await sql(SR, `SELECT coalesce(sum(new_devices),0) AS s FROM ip_usage WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date`);
  const delta = after[0].s - beforeSum;
  if (delta > 0) {
    await sql(SR, `UPDATE ip_usage SET new_devices = greatest(0, new_devices - ${delta}) WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date AND new_devices > 0`);
    console.log('已扣回测试污染计数:', delta);
  }
  await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
  console.log('清理完成');
  process.exit(pass ? 0 : 1);
})();
