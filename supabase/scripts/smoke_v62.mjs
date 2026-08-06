const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺 PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = 'https://' + REF + '.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
const DEV = 'smokev62_' + Date.now().toString(36);
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
    body: JSON.stringify({ user_id: uid, friend_name: 'v62冒烟', memory_card: JSON.stringify({
      profile: { stage: '追求' }, milestones: ['照片', '年龄', '喜好'],
      facts: [{ text: '她最爱川菜，有一家隐藏小店', at: new Date().toISOString(), last_mention: new Date().toISOString() }],
      recent_user_messages: [], recent_self_messages: []
    }) })
  });
  const sessionId = sessR.d?.[0]?.id;
  console.log('建会话:', sessR.s, sessionId ? 'OK' : JSON.stringify(sessR.d).slice(0, 120));

  // 场景：聊偏了（对方在聊她工作的事，军师接得不好）→ 用户按"换话题"
  const history = [
    { role: 'user', content: '今天公司事好多，烦死了' },
    { role: 'assistant', content: '辛苦辛苦，加班也要注意休息啊' },
    { role: 'user', content: '嗯嗯，我们领导今天又双叒发飙了' },
    { role: 'assistant', content: '领导的脾气咱也管不了，别往心里去' },
    { role: 'user', content: '唉，最近真的好累' },
  ];
  const fnR = await jf(SUPABASE + '/functions/v1/ima-proxy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + JWT, 'apikey': ANON, 'Content-Type': 'application/json', 'X-Device-Id': DEV },
    body: JSON.stringify({ query: '/换话题', session_id: sessionId, history })
  });
  const d = fnR.d;
  console.log('HTTP:', fnR.s);
  console.log('reply:', (d?.reply || '').slice(0, 150));
  console.log('switch_topic:', d?._debug?.switch_topic, '| kb_hits:', d?._debug?.kb_hits);
  console.log('semantic_kws:', JSON.stringify(d?._debug?.semantic_kws), '| sentence_kws:', JSON.stringify(d?._debug?.sentence_kws));
})();
