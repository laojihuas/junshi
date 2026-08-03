// ima-proxy 链路耗时检测（本地复刻,不改线上代码,真实凭证）
// 用法: SBP_PAT=xxx node chain_bench.mjs "她说今天被领导骂了很难受不知道怎么办"
import fs from 'fs';
import os from 'os';
import path from 'path';

const PAT = process.env.SBP_PAT;
const QUERY = process.argv[2] || '她说今天被领导骂了很难受不知道怎么办';
const KB_ID = 'nIUQTuLN18QIpfhpUKzd1iziyTgw0-Bj81KAUl31VFI=';
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = `https://${REF}.supabase.co`;

// 凭证
const imaClientId = fs.readFileSync(path.join(os.homedir(), '.config/ima/client_id'), 'utf8').trim();
const imaKey = fs.readFileSync(path.join(os.homedir(), '.config/ima/api_key'), 'utf8').trim();
const llmKey = process.env.DEEPSEEK_API_KEY;
const llmBase = 'https://api.deepseek.com';
const llmModel = 'deepseek-v4-flash';

const times = {};
function t(name) { times[name] = { start: Date.now(), ms: 0 }; }
function tEnd(name) { if (times[name]) times[name].ms = Date.now() - times[name].start; }

async function llmChat(messages, { temperature = 0.2, maxTokens = 150 } = {}) {
  const r = await fetch(`${llmBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llmModel, messages, temperature, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

async function imaSearch(q, history) {
  const body = { query: q, cursor: '', knowledge_base_id: KB_ID };
  if (history && history.length) body.history = history.slice(-10);
  const r = await fetch('https://ima.qq.com/openapi/wiki/v1/search_knowledge', {
    method: 'POST',
    headers: { 'ima-openapi-clientid': imaClientId, 'ima-openapi-apikey': imaKey, 'ima-openapi-ctx': 'bench', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  return d?.data?.info_list || [];
}

const history = [{ role: 'user', content: QUERY }];
const STOP_WORDS = new Set(fs.readFileSync(path.join(process.cwd(), 'supabase/functions/ima-proxy/index.ts'), 'utf8').match(/const STOP_WORDS = new Set\(\[([\s\S]*?)\]\);/)?.[1].split(',').map(s => s.trim().replace(/['"']/g, '')).filter(Boolean) || []);

console.log('===== 链路耗时检测 =====');
console.log('场景:', QUERY, '\n');

// ---- 1. extractSemanticKeywords ----
t('1_语义拆解LLM');
const semPrompt = `你是恋爱话术检索助手，负责把"对方说的话"拆解成适合检索恋爱资料库的短关键词。
对方的话：「${QUERY.slice(0, 80)}」
知识库领域词表（检索词应优先从中选择，可少量自创补充）：
要求：只输出 JSON 数组（如 ["推拉","试探"]），3-5 个词，每个词 2-5 字；不要任何解释文字。`;
let semanticKws = [];
try {
  const c = await llmChat([{ role: 'user', content: semPrompt }], { temperature: 0.2, maxTokens: 150 });
  semanticKws = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1) || '[]').filter(w => typeof w === 'string');
} catch (e) { console.log('  语义拆解异常:', e.message); }
tEnd('1_语义拆解LLM');
console.log(`[${times['1_语义拆解LLM'].ms}ms] 语义拆解 →`, JSON.stringify(semanticKws));

// ---- 2. extractSentenceKws ----
t('2_整句压缩LLM');
const senPrompt = `你是恋爱话术检索助手，负责把"对方说的话"压缩成适合检索恋爱资料库的短短语。
对方的话：「${QUERY.slice(0, 80)}」
要点：短语必须贴近原话语气/场景，优先选择资料库里常见的问题短语（如"怎么回""怎么安慰""忽冷忽热""不回消息"）。
示例：输入"她说今天被领导骂了很难受" 输出：["怎么安慰","难过","低落"]
要求：只输出 JSON 数组，2-4 个短语，每个 2-4 字；不要解释文字。`;
let sentenceKws = [];
try {
  const c = await llmChat([{ role: 'user', content: senPrompt }], { temperature: 0.2, maxTokens: 150 });
  sentenceKws = JSON.parse(c.slice(c.indexOf('['), c.lastIndexOf(']') + 1) || '[]').filter(w => typeof w === 'string');
} catch (e) { console.log('  整句压缩异常:', e.message); }
tEnd('2_整句压缩LLM');
console.log(`[${times['2_整句压缩LLM'].ms}ms] 整句压缩 →`, JSON.stringify(sentenceKws));

// ---- 3. searchKb（串行 IMA 检索）----
t('3_IMA检索全部query');
const queries = [...semanticKws, ...sentenceKws, QUERY];
const perQuery = [];
for (const q of queries) {
  const t0 = Date.now();
  const list = await imaSearch(q, history);
  perQuery.push({ q, ms: Date.now() - t0, hits: list.length });
}
tEnd('3_IMA检索全部query');
console.log(`[${times['3_IMA检索全部query'].ms}ms] IMA 检索 ${queries.length} 个 query（串行）:`);
perQuery.forEach(p => console.log(`    ${p.q}(${p.q.length}字): ${p.ms}ms, 命中${p.hits}`));

// ---- 4. fetchItemsContent（get_media_info + 下载 + LLM 摘要）----
t('4_拉全文+摘要');
const items = [];
for (const p of perQuery) {
  if (p.hits === 0) continue;
  const list = await imaSearch(p.q, history);
  for (const it of list.slice(0, 2)) {
    if (!items.find(x => x.media_id === it.media_id)) items.push(it);
    if (items.length >= 5) break;
  }
  if (items.length >= 5) break;
}
const docs = await Promise.all(items.map(async (item) => {
  const t0 = Date.now();
  try {
    const mi = await (await fetch('https://ima.qq.com/openapi/wiki/v1/get_media_info', {
      method: 'POST',
      headers: { 'ima-openapi-clientid': imaClientId, 'ima-openapi-apikey': imaKey, 'ima-openapi-ctx': 'bench', 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: item.media_id }),
    })).json();
    const urlInfo = mi?.data?.url_info;
    let len = 0;
    if (urlInfo?.url) {
      const md = await (await fetch(urlInfo.url, { headers: urlInfo.headers || {} })).text();
      len = md.length;
    }
    let sum = '';
    if (len > 500) {
      const sp = `你是恋爱话术提炼助手。用户正要回复对方，对方的话：「${QUERY.slice(0, 60)}」。\n以下是从知识库检索到的资料【${item.title}】：\n${md.slice(0, 3500)}\n要求：提取与当前问题直接相关的话术要点、可操作步骤或关键语句，150-300 字。直接输出要点，若资料与当前问题明显无关，只输出两个字：无关。`;
      sum = await llmChat([{ role: 'user', content: sp }], { temperature: 0.2, maxTokens: 400 });
    }
    return { title: item.title, ms: Date.now() - t0, len, summarized: sum ? sum.length : 0, unrelated: sum.includes('无关') };
  } catch (e) {
    return { title: item.title, ms: Date.now() - t0, err: e.message };
  }
}));
tEnd('4_拉全文+摘要');
console.log(`[${times['4_拉全文+摘要'].ms}ms] 拉取 ${docs.length} 篇全文+定向摘要（并行）:`);
docs.forEach(d => console.log(`    ${d.title.slice(0, 30)}: ${d.ms}ms, 正文${d.len}字, 摘要${d.summarized}字${d.unrelated ? '(无关被弃)' : ''}${d.err ? ' ERR:' + d.err : ''}`));

// ---- 5. 主回复 LLM ----
t('5_主回复LLM');
const sysPrompt = `你即用户本人，是一位深谙恋爱心理与聊天技巧的军师。用户把对方的话发给你，你要以第一人称"我"的口吻，替用户回一条 1-2 句话的回复。对方的话：「${QUERY}」`;
const reply = await llmChat([{ role: 'system', content: sysPrompt }, { role: 'user', content: QUERY }], { temperature: 0.4, maxTokens: 1200 });
tEnd('5_主回复LLM');
console.log(`[${times['5_主回复LLM'].ms}ms] 主回复 → ${reply.slice(0, 40)}...`);

// ---- 汇总 ----
console.log('\n===== 汇总（瀑布） =====');
let total = 0;
for (const [k, v] of Object.entries(times)) { total += v.ms; console.log(`${String(k).padEnd(20)} ${String(v.ms).padStart(6)}ms`); }
console.log(`${'合计(串行加总)'.padEnd(20)} ${String(total).padStart(6)}ms`);
