const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺 PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const DEV = 'smokev61_' + Date.now().toString(36);
process.env.NO_PROXY = '*';

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}

(async () => {
  const anonR = await jf(SUPABASE + '/auth/v1/signup', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const JWT = anonR.d?.access_token;
  console.log('匿名登录:', anonR.s, JWT ? 'OK' : JSON.stringify(anonR.d).slice(0, 150));
  if (!JWT) return;

  const gateR = await jf(SUPABASE + '/functions/v1/device-gate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', device_id: DEV })
  });
  console.log('设备注册:', gateR.s);

  const uid = anonR.d?.user?.id;
  const sessR = await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ user_id: uid, friend_name: 'v61冒烟', memory_card: JSON.stringify({ profile: { stage: '朋友' }, milestones: [], recent_user_messages: [], recent_self_messages: [] }) })
  });
  const sessionId = sessR.d?.[0]?.id;
  console.log('建会话:', sessR.s, sessionId ? 'OK' : JSON.stringify(sessR.d).slice(0, 120));

  // 历史里：她发了照片、说了年龄、聊了喜好 → 里程碑应命中 照片/年龄/喜好
  const history = [
    { role: 'user', content: '你好呀，我是小美，认识一下？' },
    { role: 'assistant', content: '小美你好，我加你了。平时喜欢干点啥？' },
    { role: 'user', content: '给你看张照片，这是我上周去海边拍的 [图片]' },
    { role: 'assistant', content: '这张拍得不错，很自然。对了你今年多大，感觉你挺年轻' },
    { role: 'user', content: '我 24，你猜对啦。我超爱川菜，有一家隐藏小店特别赞' },
  ];
  const fnR = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': DEV },
    body: JSON.stringify({ query: '今天天气不错，你那边呢', session_id: sessionId, history })
  });
  const d = fnR.d;
  console.log('HTTP:', fnR.s);
  console.log('reply:', (d?.reply || '').slice(0, 150));
  console.log('memory_stage:', d?._debug?.memory_stage, '| goal:', d?._debug?.goal);
  console.log('milestones:', JSON.stringify(d?._debug?.milestones));

  // 再读一次 memory_card 看落库的 milestones
  const mcR = await jf(SUPABASE + '/rest/v1/chat_sessions?select=memory_card&id=eq.' + sessionId, {
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON }
  });
  const raw = mcR.d?.[0]?.memory_card;
  let mc = null; try { mc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  console.log('落库 milestones:', JSON.stringify(mc?.milestones), '| stage:', mc?.profile?.stage);

  // 清理测试设备
  await jf(SUPABASE + '/rest/v1/devices?device_id=eq.' + DEV, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON } });
})();
