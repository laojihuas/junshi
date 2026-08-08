#!/usr/bin/env node
// v76 综合检查：功能正常性 + token 消耗 + DeepSeek 计费 + 缓存命中率
// 用法: SBP_PAT=<pat> node _e2e_check_v76.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

// deepseek-v4-flash 现行价（元 / 百万 tokens，2026-08-08，官方定价页）
const P = { hit: 0.02, miss: 1.0, out: 2.0 };

const kr = await fetch(`${API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await kr.json();
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
const JWT = sr.api_key || sr.key;

// ---------- 创建临时账号 ----------
const email = `chk_${Date.now()}@jssl.local`;
const pwd = 'E2eTest!2026';
const u = await fetch(`${BASE}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd, email_confirm: true }),
});
const uid = (await u.json())?.id;
await fetch(`${BASE}/rest/v1/rpc/register_account`, {
  method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_account_name: '综合检查', p_device_id: 'chk_dbg_000001' }),
});
await fetch(`${BASE}/rest/v1/rpc/login_account`, {
  method: 'POST', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_account_user_id: uid, p_session_id: 'chk_session_001' }),
});
const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pwd }),
});
const accountToken = (await tok.json())?.access_token;
const sid = await fetch(`${BASE}/rest/v1/chat_sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ user_id: uid, note: '综合检查', friend_name: '测试' }),
});
const sessionIdDb = (await sid.json())?.[0]?.id;

// ---------- 场景定义 ----------
// A: 连续 5 轮（history 递增，验证 DeepSeek 前缀缓存）
const cacheConv = [
  { q: '在吗', h: [] },
  { q: '今天好累啊', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }] },
  { q: '加班到现在，饭都没吃', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }] },
  { q: '你周末一般干嘛', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }, { role: 'user', content: '加班到现在，饭都没吃' }, { role: 'assistant', content: '那我给你点个外卖？' }] },
  { q: '好呀 你人还怪好的', h: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在的，刚忙完' }, { role: 'user', content: '今天好累啊' }, { role: 'assistant', content: '辛苦了，早点休息' }, { role: 'user', content: '加班到现在，饭都没吃' }, { role: 'assistant', content: '那我给你点个外卖？' }, { role: 'user', content: '你周末一般干嘛' }, { role: 'assistant', content: '周末骑车，改天带你体验一把' }] },
];
// B: 三个典型场景
const tokenCases = [
  { name: '防守·她打压', history: [{ role: 'user', content: '嗨' }, { role: 'assistant', content: '你好啊' }], query: '你好自恋啊，是不是经常这样撩妹' },
  { name: '进攻·首轮', history: [], query: '周末有什么安排吗' },
  { name: '进攻·长对话', history: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i + 1}条消息内容，聊点日常琐事` })), query: '今天心情不错，想出去走走' },
];
// C: 同一问题连续问 2 次（验证缓存复用）
const repeatQ = { q: '你觉得我是不是太粘人了', h: [] };

const results = [];
async function callProxy(name, query, history) {
  const t0 = Date.now();
  const ctl = AbortSignal.timeout(120000);
  const r = await fetch(`${BASE}/functions/v1/ima-proxy`, {
    method: 'POST',
    signal: ctl,
    headers: { Authorization: `Bearer ${accountToken}`, apikey: JWT, 'Content-Type': 'application/json', 'X-Identity-Type': 'account', 'X-Session-Id': 'chk_session_001' },
    body: JSON.stringify({ query, history, session_id: sessionIdDb }),
  });
  const d = await r.json();
  results.push({ name, query, d, ms: Date.now() - t0 });
}

console.log('==== 开始综合检查（' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '）====\n');
let i = 0;
// A 连续对话
for (const c of cacheConv) {
  i++; await callProxy(`缓存#${i}`, c.q, c.h);
}
// B 场景
for (const c of tokenCases) {
  i++; await callProxy(c.name, c.query, c.history);
}
// C 重复问
i++; await callProxy('重复问·第1次', repeatQ.q, repeatQ.h);
i++; await callProxy('重复问·第2次', repeatQ.q, repeatQ.h);

// ---------- 明细表 ----------
console.log('序号 | 场景 | 战术 | 阶段 | LLM调用 | prompt(hit/miss) | completion | 合计 | 缓存命中率 | 耗时 | reply');
let gi = 0;
for (const row of results) {
  gi++;
  const d = row.d, dbg = d._debug || {};
  const usage = dbg.llm_usage || [];
  let pHit = 0, pMiss = 0, comp = 0, calls = 0;
  for (const u of usage) {
    pHit += u.prompt_cache_hit_tokens || 0;
    pMiss += u.prompt_cache_miss_tokens || 0;
    comp += u.completion_tokens || 0;
    calls++;
  }
  const tot = pHit + pMiss + comp;
  const rate = (pHit + pMiss) ? Math.round(pHit / (pHit + pMiss) * 100) : 0;
  const brief = usage.map(u => `${u.stage}${u.prompt_tokens || 0}+${u.completion_tokens || 0}`).join('/');
  console.log(`#${gi} | ${row.name} | ${dbg.tactic_category || '-'} | ${dbg.tactic_phase || '-'} | ${calls} | ${pHit}/${pMiss} | ${comp} | ${tot} | ${rate}% | ${row.ms}ms | ${(d.reply || d.error || '无').slice(0, 22)}`);
  if (d.reply) console.log(`   reply: ${d.reply.slice(0, 80)}`);
  if (!d.reply) console.log(`   [异常] ${JSON.stringify(d).slice(0, 300)}`);
}

// ---------- 汇总（DeepSeek 计费） ----------
let TpHit = 0, TpMiss = 0, Tcomp = 0, calls = 0;
const stageAgg = {};
for (const row of results) {
  const dbg = row.d._debug || {};
  for (const u of dbg.llm_usage || []) {
    const s = u.stage || '?';
    stageAgg[s] = stageAgg[s] || { hit: 0, miss: 0, comp: 0, n: 0 };
    stageAgg[s].hit += u.prompt_cache_hit_tokens || 0;
    stageAgg[s].miss += u.prompt_cache_miss_tokens || 0;
    stageAgg[s].comp += u.completion_tokens || 0;
    stageAgg[s].n++;
    TpHit += u.prompt_cache_hit_tokens || 0;
    TpMiss += u.prompt_cache_miss_tokens || 0;
    Tcomp += u.completion_tokens || 0;
    calls++;
  }
}
const Ttot = TpHit + TpMiss + Tcomp;
const costHit = TpHit / 1e6 * P.hit;
const costMiss = TpMiss / 1e6 * P.miss;
const costOut = Tcomp / 1e6 * P.out;
const costTotal = costHit + costMiss + costOut;
const reqN = results.length;
const perReq = Ttot / reqN;
const perReqCost = costTotal / reqN;

console.log('\n================ 汇总 ================');
console.log(`请求轮数: ${reqN}    LLM 调用次数: ${calls}`);
console.log(`总 prompt tokens: ${TpHit + TpMiss}（缓存命中 ${TpHit} / 未命中 ${TpMiss}）`);
console.log(`总 completion tokens: ${Tcomp}`);
console.log(`总 tokens: ${Ttot}`);
console.log(`整体缓存命中率: ${TpHit / (TpHit + TpMiss) * 100}%`);
console.log(`平均每轮 tokens: ${Math.round(perReq)}（v70 基线 6316）`);
console.log('\n-- DeepSeek 计费（deepseek-v4-flash 现行价：命中输入0.02元/M 未命中输入1元/M 输出2元/M）--');
console.log(`  缓存命中输入: ${(TpHit / 1e6).toFixed(4)}M × 0.02 = ${costHit.toFixed(5)} 元`);
console.log(`  缓存未命中输入: ${(TpMiss / 1e6).toFixed(4)}M × 1.0 = ${costMiss.toFixed(5)} 元`);
console.log(`  输出: ${(Tcomp / 1e6).toFixed(4)}M × 2.0 = ${costOut.toFixed(5)} 元`);
console.log(`  合计: ${costTotal.toFixed(5)} 元（平均每轮 ${perReqCost.toFixed(6)} 元）`);
console.log('\n-- 按调用阶段 --');
for (const [s, a] of Object.entries(stageAgg)) {
  const c = a.hit / 1e6 * P.hit + a.miss / 1e6 * P.miss + a.comp / 1e6 * P.out;
  const r = a.hit / (a.hit + a.miss) * 100;
  console.log(`  ${s.padEnd(14)} n=${a.n} hit=${a.hit} miss=${a.miss} comp=${a.comp} 命中率=${r.toFixed(1)}% 费用=${c.toFixed(5)}元`);
}

// ---------- 清理 ----------
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.chat_sessions where user_id = '${uid}'` }) });
await fetch(`${API}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: `delete from public.accounts where id = '${uid}'` }) });
await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JWT}`, apikey: JWT } });
console.log('\n临时账号已清理');
