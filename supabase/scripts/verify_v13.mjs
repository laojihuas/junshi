// v13 端到端验证:220021 兜底 + 延时
const PAT = process.env.SBP_PAT;
const SUPABASE = 'https://opzvvgixlfbfpdlsorbi.supabase.co';
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
async function jf(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
(async () => {
  const keys = await (await fetch('https://api.supabase.com/v1/projects/opzvvgixlfbfpdlsorbi/api-keys', { headers: { 'Authorization': 'Bearer ' + PAT } })).json();
  const SR = keys.find(k => k.name === 'service_role').api_key;
  const email = 'v13_' + Date.now() + '@tmp.dev';
  await jf(SUPABASE + '/auth/v1/admin/users', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V13Test!2026', email_confirm: true }) });
  const l1 = await jf(SUPABASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'V13Test!2026' }) });
  const tok = l1.d.access_token;
  const uid = l1.d.user?.id;
  const cases = [
    '她说今天被领导骂了很难受不知道怎么办',
    '女生说要睡了晚安是不是不想理我',
    '我们冷战三天了她一直不回消息',
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      const q = cases[i];
      const t0 = Date.now();
      const r = await jf(SUPABASE + '/functions/v1/ima-proxy', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, history: [{ role: 'user', content: q }], session_id: 'v13-' + i }) });
      const ms = Date.now() - t0;
      const d = r.d?._debug || {};
      console.log('用例' + (i + 1) + ' [' + ms + 'ms]: ' + q.slice(0, 16));
      console.log('  kb_items=' + d.kb_items + ' sem=' + d.semantic_route_hits + ' sent=' + d.sentence_route_hits + ' fulltext=' + d.fulltext_hits);
      console.log('  正文来源: ima=' + d.content_src?.ima + ' kb_docs=' + d.content_src?.kb_docs + ' 空=' + d.content_src?.empty);
    }
  } finally {
    await jf(SUPABASE + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + SR, 'apikey': SR } });
    console.log('临时用户已清理');
  }
})();
