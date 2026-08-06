const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺 PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const DEV = 'smokev60_' + Date.now().toString(36);
process.env.NO_PROXY = '*';

async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}

(async () => {
  // 1) 匿名登录（Supabase 匿名用户）
  const anonR = await jf(SUPABASE + '/auth/v1/signup', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ANON, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const JWT = anonR.d?.access_token;
  console.log('匿名登录:', anonR.s, JWT ? 'OK' : JSON.stringify(anonR.d).slice(0, 150));
  if (!JWT) return;

  // 2) 注册设备（device-gate）
  const gateR = await jf(SUPABASE + '/functions/v1/device-gate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', device_id: DEV })
  });
  console.log('设备注册:', gateR.s, JSON.stringify(gateR.d).slice(0, 120));

  // 3) 建会话（带 memory_card：stage=朋友，验证主动推进）
  const uid = anonR.d?.user?.id;
  const sessR = await jf(SUPABASE + '/rest/v1/chat_sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ user_id: uid, friend_name: 'v60冒烟', memory_card: JSON.stringify({ profile: { stage: '朋友' }, recent_user_messages: [], recent_self_messages: [] }) })
  });
  const sessionId = sessR.d?.[0]?.id;
  console.log('建会话:', sessR.s, sessionId ? 'OK' : JSON.stringify(sessR.d).slice(0, 120));

  // 4) 调 ima-proxy（游客身份：X-Device-Id）——带前几轮历史：普通朋友寒暄，看军师是否主动推进
  const history = [
    { role: 'user', content: '你好呀，我是小美，认识一下？' },
    { role: 'assistant', content: '小美你好，我加你了。平时喜欢干点啥？' },
    { role: 'user', content: '喜欢看电影、吃好吃的，你呢' },
    { role: 'assistant', content: '巧了，我最近在找好吃的店，你有什么私藏推荐吗' },
    { role: 'user', content: '我超爱川菜，有一家隐藏小店特别赞' },
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
  console.log('kb_hits:', d?._debug?.kb_hits, '| content_src:', JSON.stringify(d?._debug?.content_src));
})();
