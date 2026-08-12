// ============================================================
// 军师 token 实测：走线上 ima-proxy 全链路，采集 _debug.llm_usage
// 用法: node run_token_test.mjs
// 流程: PAT → service_role JWT → admin 建测试用户 → 登录拿 JWT
//       → device-gate 注册测试设备 → ima-proxy 发 2 轮 → 汇总 → 清理用户
// ============================================================
import fs from 'fs';

const REF = 'opzvvgixlfbfpdlsorbi';
const BASE = `https://${REF}.supabase.co`;
const ADMIN_API = `https://api.supabase.com/v1/projects/${REF}`;

// ---- 凭证：PAT 存于 C:\Users\Administrator\Documents\资料.txt（仅本机读取，不落库）----
const credPath = 'C:/Users/Administrator/Documents/资料.txt';
const credText = fs.readFileSync(credPath, 'utf8');
const PAT = (credText.match(/sbp_[a-z0-9]+/) || [])[0];
const ANON = 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC';
if (!PAT) { console.error('未找到 PAT'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const j = (r) => { const c = r.headers.get('content-type') || ''; return c.includes('json') ? r.json() : r.text(); };

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await j(resp); } catch { data = null; }
  if (!resp.ok) {
    const t = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300);
    throw new Error(`HTTP ${resp.status} ${url.split('/').pop()}: ${t}`);
  }
  return data;
}

async function main() {
  // 1. service_role JWT（管理 API 拿，PAT 鉴权；返回为顶层数组）
  const keys = await call(`${ADMIN_API}/api-keys`, { headers: { Authorization: `Bearer ${PAT}` } });
  const keyList = Array.isArray(keys) ? keys : (keys.api_keys || []);
  const sr = keyList.find((k) => k.name === 'service_role');
  if (!sr) throw new Error('api-keys 里没有 service_role');
  const SROLE = sr.api_key;
  const adminH = { Authorization: `Bearer ${SROLE}`, apikey: SROLE };

  // 2. admin 创建测试用户
  const stamp = Date.now().toString(36);
  const email = `toktest_${stamp}@jssl.local`;
  const password = 'TokTest!' + stamp + 'aZ9';
  const u = await call(`${BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminH,
    body: { email, password, email_confirm: true },
  });
  const userId = u.id;
  console.log(`[1] 测试用户已创建: ${email} (${userId.slice(0, 8)}...)`);

  // 3. 密码登录拿 user JWT
  const tok = await call(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: { email, password },
  });
  const userJwt = tok.access_token;
  const userH = { Authorization: `Bearer ${userJwt}`, apikey: ANON };
  console.log('[2] 登录成功，拿到 user JWT');

  // 4. device-gate 设备（复用已注册设备：device-gate 有"同 IP 每日新设备 ≤5"防刷）
  const deviceId = 'toktest_' + stamp + '_dev';
  const existing = await call(
    `${BASE}/rest/v1/devices?select=device_id&order=created_at.desc&limit=1`,
    { headers: adminH }
  );
  const useDevice = (Array.isArray(existing) && existing[0]?.device_id) || deviceId;
  if (useDevice !== deviceId) {
    console.log(`[3] 复用已有设备: ${useDevice}`);
  } else {
    const reg = await call(`${BASE}/functions/v1/device-gate`, {
      method: 'POST',
      headers: userH,
      body: { action: 'register', device_id: deviceId, fp_screen: '1280x720', fp_tz: '-480', fp_lang: 'zh-CN' },
    });
    console.log(`[3] 设备注册: ${deviceId} → ${JSON.stringify(reg).slice(0, 120)}`);
  }

  // 4.5 预建真实 session 行（真实前端会先建 chat_sessions；否则记忆卡 PATCH 0 行 → 画像限频失真）
  const sessionId = crypto.randomUUID();
  await call(`${BASE}/rest/v1/chat_sessions`, {
    method: 'POST',
    headers: adminH,
    body: { id: sessionId, user_id: userId, friend_name: 'token测试', note: 'token 实测' },
  });
  console.log(`[4] session 已预建: ${sessionId}`);

  // 5. ima-proxy 两轮对话
  const scene = [
    { query: '她说今天被领导骂了很难受不知道怎么办', history: [] },
    { query: '她说其实也不是什么大事，就是当着全组的面被骂觉得特别丢人，我该怎么接', history: null },
  ];
  const rounds = [];
  for (let i = 0; i < scene.length; i++) {
    const q = scene[i];
    const body = { query: q.query, session_id: sessionId };
    if (i === 1) {
      body.history = [
        { role: 'user', content: scene[0].query },
        { role: 'assistant', content: rounds[0].reply },
      ];
    }
    const resp = await call(`${BASE}/functions/v1/ima-proxy`, {
      method: 'POST',
      headers: { ...userH, 'X-Device-Id': useDevice },
      body,
    });
    rounds.push(resp);
    const dbg = resp._debug || {};
    console.log(`\n===== 第 ${i + 1} 轮 =====`);
    console.log(`回复: ${String(resp.reply).slice(0, 80)}`);
    console.log(`kb_hits=${dbg.kb_hits} thinking=${dbg.thinking_mode}`);
    if (dbg.llm_usage) {
      for (const uu of dbg.llm_usage) {
        const det = uu.completion_tokens_details || {};
        const pdet = uu.prompt_tokens_details || {};
        const rt = det.reasoning_tokens ? ` 思考${det.reasoning_tokens}` : '';
        const ct = pdet.cached_tokens ? ` 缓存${pdet.cached_tokens}` : '';
        console.log(`  ${uu.stage.padEnd(16)} 输入 ${String(uu.prompt_tokens).padStart(5)} / 输出 ${String(uu.completion_tokens).padStart(5)}${rt}${ct}`);
      }
    } else {
      console.log('  (无 llm_usage，检查 _debug)');
    }
  }

  // 6. 汇总（含缓存命中与成本核算；价格：输入未命中 1 元/百万、命中 0.02 元/百万、输出 2 元/百万）
  console.log('\n===== token 汇总（DeepSeek usage 实测，含思考/缓存）=====');
  const agg = {};
  for (const r of rounds) {
    for (const uu of (r._debug?.llm_usage || [])) {
      agg[uu.stage] = agg[uu.stage] || { in: 0, out: 0, think: 0, cached: 0, n: 0 };
      agg[uu.stage].in += uu.prompt_tokens || 0;
      agg[uu.stage].out += uu.completion_tokens || 0;
      agg[uu.stage].think += (uu.completion_tokens_details?.reasoning_tokens) || 0;
      agg[uu.stage].cached += (uu.prompt_tokens_details?.cached_tokens) || 0;
      agg[uu.stage].n += 1;
    }
  }
  let tin = 0, tout = 0, tthink = 0, tcached = 0;
  for (const [stage, v] of Object.entries(agg)) {
    const thinkTag = v.think ? ` / 思考 ${v.think}` : '';
    const hitRate = v.in > 0 ? Math.round(v.cached / v.in * 100) : 0;
    console.log(`  ${stage.padEnd(16)} ×${v.n}  输入 ${String(v.in).padStart(6)} / 输出 ${String(v.out).padStart(6)}${thinkTag} / 缓存 ${String(v.cached).padStart(6)} (${hitRate}%) / 小计 ${v.in + v.out + v.think}`);
    tin += v.in; tout += v.out; tthink += v.think; tcached += v.cached;
  }
  const hitRate = tin > 0 ? Math.round(tcached / tin * 100) : 0;
  // 成本：命中输入 0.02 元/百万、未命中 1 元/百万、输出（含思考）2 元/百万
  const uncachedCost = (tin - tcached) * 1e-6;
  const cachedCost = tcached * 0.02e-6;
  const outCost = tout * 2e-6;
  const cost = uncachedCost + cachedCost + outCost;
  console.log(`\n两轮合计: 输入 ${tin} / 输出 ${tout} / 思考 ${tthink} / 缓存命中 ${tcached} (${hitRate}%) / 总计 ${tin + tout + tthink} token`);
  console.log(`成本估算: 未命中 ${uncachedCost.toFixed(4)} 元 + 缓存 ${cachedCost.toFixed(4)} 元 + 输出 ${outCost.toFixed(4)} 元 = ${cost.toFixed(4)} 元 / ${rounds.length} 轮`);
  console.log(`单轮成本: ${(cost / rounds.length).toFixed(4)} 元（若缓存命中率高，主回复大 system 的前缀成本极低）`);

  // 7. 清理测试用户 + 测试 session
  try {
    await call(`${BASE}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminH });
    await call(`${BASE}/rest/v1/chat_sessions?id=eq.${sessionId}`, { method: 'DELETE', headers: adminH });
    console.log('\n[5] 测试用户 + session 已清理');
  } catch (e) {
    console.log('\n[5] 清理失败（可手动删）:', e.message);
  }
}

main().catch((e) => { console.error('\n失败:', e.message); process.exit(1); });
