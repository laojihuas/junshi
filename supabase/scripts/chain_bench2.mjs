// ima-proxy 完整链路耗时检测 v2（补齐 bigram/套路启动/fetchKbFolders）
// 用法: SBP_PAT=xxx node chain_bench2.mjs "她说今天被领导骂了很难受不知道怎么办"
import fs from 'fs';
import os from 'os';
import path from 'path';

const PAT = process.env.SBP_PAT;
const QUERY = process.argv[2] || '她说今天被领导骂了很难受不知道怎么办';
const KB_ID = 'nIUQTuLN18QIpfhpUKzd1iziyTgw0-Bj81KAUl31VFI=';
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = `https://${REF}.supabase.co`;
const imaClientId = fs.readFileSync(path.join(os.homedir(), '.config/ima/client_id'), 'utf8').trim();
const imaKey = fs.readFileSync(path.join(os.homedir(), '.config/ima/api_key'), 'utf8').trim();
const llmKey = process.env.DEEPSEEK_API_KEY;
const llmBase = 'https://api.deepseek.com';
const llmModel = 'deepseek-v4-flash';
const times = {};
const t = (n) => { times[n] = { start: Date.now(), ms: 0 }; };
const tE = (n) => { if (times[n]) times[n].ms = Date.now() - times[n].start; };

async function llmChat(messages, { temperature = 0.2, maxTokens = 150 } = {}) {
  const r = await fetch(`${llmBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llmModel, messages, temperature, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

const IMA_H = { 'ima-openapi-clientid': imaClientId, 'ima-openapi-apikey': imaKey, 'ima-openapi-ctx': 'bench', 'Content-Type': 'application/json' };
async function ima(api, body) {
  const r = await fetch(`https://ima.qq.com/openapi/wiki/v1/${api}`, { method: 'POST', headers: IMA_H, body: JSON.stringify(body) });
  const d = await r.json();
  return d?.data || null;
}

// ---- bigram 规则词（同步复刻线上 extractKeywords）----
const STOP_WORDS = new Set(['吗', '呢', '啊', '呀', '吧', '么', '什么', '怎么', '为什么', '这个', '那个', '一下', '一个', '一种', '意思', '感觉', '觉得', '这样', '那样', '真的', '有点', '有些', '然后', '但是', '因为', '所以', '如果', '没有', '不是', '就是', '还是', '回复', '回应', '说话', '讲', '跟', '给', '把', '被', '让', '去', '来', '可以', '应该']);
const STOP_CHARS = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));
const SPLIT_RE = /[，。！？；、,.!?;:\s\n\r"'""''（）()【】\[\]]+/;
function extractKeywords(query) {
  const q = query.replace(SPLIT_RE, '');
  const bigrams = [];
  for (let i = 0; i + 2 <= q.length; i++) bigrams.push(q.slice(i, i + 2));
  const strict = [], loose = [];
  for (const b of bigrams) {
    if (STOP_WORDS.has(b)) continue;
    const real = b.split('').filter((c) => !STOP_CHARS.has(c)).length;
    if (real === 0) continue;
    if (real === 2) strict.push(b); else loose.push(b);
  }
  return [...new Set([...strict, ...loose])].slice(0, 5);
}
const kw = extractKeywords(QUERY);

const history = [{ role: 'user', content: QUERY }];

console.log('===== 链路耗时检测 v2 =====');
console.log('场景:', QUERY, '| bigram 词:', JSON.stringify(kw), '\n');

// ---- 0. fetchKbFolders（文件夹识别,每轮必跑）----
t('0_fetchKbFolders');
let hs = null, jx = null;
try {
  async function walk(folderId) {
    const body = { knowledge_base_id: KB_ID, cursor: '', limit: 50 };
    if (folderId) body.folder_id = folderId;
    const data = await ima('get_knowledge_list', body);
    const list = data?.knowledge_list || [];
    for (const item of list) {
      if (item.media_type === 99) {
        const fid = item.folder_id || item.media_id || '';
        const name = item.title || item.name || '';
        if (!hs && /话术|惯例/.test(name)) hs = fid;
        if (!jx && /教学|理论|课程/.test(name)) jx = fid;
        if (fid) await walk(fid);
      }
    }
  }
  await walk('');
} catch (e) { console.log('  folders异常:', e.message); }
tE('0_fetchKbFolders');
console.log(`[${times['0_fetchKbFolders'].ms}ms] fetchKbFolders → hs=${!!hs} jx=${!!jx}`);

// ---- 1+2. 语义拆解 + 整句压缩 ----
t('1_语义拆解LLM');
let semanticKws = [];
try {
  const c = await llmChat([{ role: 'user', content: `你是恋爱话术检索助手，负责把"对方说的话"拆解成适合检索恋爱资料库的短关键词。\n对方的话：「${QUERY.slice(0, 80)}」\n要求：只输出 JSON 数组（如 ["推拉","试探"]），3-5 个词，每个词 2-5 字；不要任何解释文字。` }], { temperature: 0.2, maxTokens: 150 });
  semanticKws = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1) || '[]').filter(w => typeof w === 'string');
} catch (e) {}
tE('1_语义拆解LLM');

t('2_整句压缩LLM');
let sentenceKws = [];
try {
  const c = await llmChat([{ role: 'user', content: `你是恋爱话术检索助手，负责把"对方说的话"压缩成适合检索恋爱资料库的短短语。\n对方的话：「${QUERY.slice(0, 80)}」\n要点：贴近原话场景，优先常见短语（如"怎么回""怎么安慰""忽冷忽热"）。\n示例：输入"她说今天被领导骂了很难受" 输出：["怎么安慰","难过","低落"]\n要求：只输出 JSON 数组，2-4 个短语，每个 2-4 字；不要解释文字。` }], { temperature: 0.2, maxTokens: 150 });
  sentenceKws = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1) || '[]').filter(w => typeof w === 'string');
} catch (e) {}
tE('2_整句压缩LLM');
console.log(`[${times['1_语义拆解LLM'].ms}ms] 语义拆解 →`, JSON.stringify(semanticKws));
console.log(`[${times['2_整句压缩LLM'].ms}ms] 整句压缩 →`, JSON.stringify(sentenceKws));

// ---- 3. 主检索（完整 searchQueries = 语义+整句+bigram+原句,串行）----
t('3_IMA主检索');
const queries = [...semanticKws, ...sentenceKws, ...kw, QUERY];
const perQ = [];
const map = new Map();
for (const q of queries) {
  if (!q || q.length < 2) continue;
  const t0 = Date.now();
  const data = await ima('search_knowledge', { query: q, cursor: '', knowledge_base_id: KB_ID, history: history.slice(-10) });
  const list = (data?.info_list || []).slice(0, 2);
  perQ.push({ q, ms: Date.now() - t0, hits: list.length });
  for (const it of list) {
    if ([99, 2, 6, 8, 10, 12, 16, 17, 18, 19].includes(it.media_type)) continue;
    if (!map.has(it.media_id)) map.set(it.media_id, it);
  }
}
tE('3_IMA主检索');
console.log(`[${times['3_IMA主检索'].ms}ms] 主检索 ${queries.length} query 串行（命中${map.size}篇）:`);
perQ.forEach(p => console.log(`    ${p.q}(${p.q.length}字): ${p.ms}ms 命中${p.hits}`));

// ---- 4. 套路启动（无 strategy 时每轮必跑:5 词检索 + 可能 extractStrategy）----
t('4_套路启动');
const stKws = ['惯例', '推拉', '冷读', '开场白', '步骤'];
const stMap = new Map();
for (const q of stKws) {
  const data = await ima('search_knowledge', { query: q, cursor: '', knowledge_base_id: KB_ID, history: history.slice(-10) });
  const list = (data?.info_list || []).slice(0, 2);
  for (const it of list) {
    if ([99, 2, 6, 8, 10, 12, 16, 17, 18, 19].includes(it.media_type)) continue;
    if (!stMap.has(it.media_id)) stMap.set(it.media_id, it);
  }
}
let stStrategy = null;
const convItems = [...stMap.values()].slice(0, 5);
const texts = convItems.map((i) => `${i.title || ''}\n${i.content || ''}`).join('\n');
if (/步骤|惯例|玩法|推拉|流程|套路|招|法|术|技巧|操作/.test(texts)) {
  const t0 = Date.now();
  const c = await llmChat([{ role: 'user', content: `你是恋爱聊天"惯例/玩法"提炼助手。对方的话：「${QUERY.slice(0, 60)}」。\n以下是检索到的资料：\n${texts.slice(0, 2400)}\n要求：如果资料中存在分步骤可执行的聊天惯例，提炼成 JSON：{"name":"...","goal":"...","steps":["第1步..."]} steps 2-6 步；没有则输出 {"name":"","steps":[]}。只输出 JSON。` }], { temperature: 0.2, maxTokens: 400 });
  stStrategy = { ms: Date.now() - t0, got: c.includes('"steps"') && !c.includes('"steps":[]') };
}
tE('4_套路启动');
console.log(`[${times['4_套路启动'].ms}ms] 套路启动: 5 词检索命中${convItems.length}篇` + (stStrategy ? `, extractStrategy LLM ${stStrategy.ms}ms got=${stStrategy.got}` : ', 未触发 LLM'));

// ---- 5. 拉全文（get_media_info × N,如实记录失败）----
t('5_拉全文');
const items = [...map.values()].slice(0, 5);
const docs = await Promise.all(items.map(async (item) => {
  const t0 = Date.now();
  try {
    const mi = await ima('get_media_info', { media_id: item.media_id });
    return { title: item.title, ms: Date.now() - t0, ok: !!(mi?.url_info?.url) };
  } catch (e) { return { title: item.title, ms: Date.now() - t0, err: e.message }; }
}));
tE('5_拉全文');
console.log(`[${times['5_拉全文'].ms}ms] 拉全文 ${items.length} 篇（并行）:`);
docs.forEach(d => console.log(`    ${d.title.slice(0, 26)}: ${d.ms}ms ${d.ok ? 'OK' : (d.err ? 'ERR:' + d.err : '无url')}`));

// ---- 6. 画像提取 LLM（记忆卡更新,新 session 首次必触发）----
t('6_画像提取LLM');
let profileMs = 0;
try {
  const t0 = Date.now();
  const c = await llmChat([{ role: 'user', content: `你是情感分析助手。根据对话提炼对方画像，输出 JSON：{"stage":"阶段","personality":"性格","relationship_note":"关系备注","recent_events":"近期事件"}。\n最近对话：\n用户：${QUERY}\n只输出 JSON。` }], { temperature: 0.2, maxTokens: 300 });
  profileMs = Date.now() - t0;
} catch (e) {}
tE('6_画像提取LLM');
console.log(`[${times['6_画像提取LLM'].ms}ms] 画像提取 LLM: ${profileMs}ms`);

// ---- 汇总 ----
console.log('\n===== 汇总（串行加总） =====');
let total = 0;
for (const [k, v] of Object.entries(times)) { total += v.ms; console.log(`${String(k).padEnd(18)} ${String(v.ms).padStart(6)}ms`); }
console.log(`${'合计'.padEnd(18)} ${String(total).padStart(6)}ms`);
console.log('端到端实测参考: 31-33s（含函数冷启动/网络/主回复thinking）');
