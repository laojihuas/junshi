#!/usr/bin/env node
// 端到端流程记录：步骤3 - 用真实请求数据重建完整 system 文本 + 复现检索链路
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ts = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/typescript');

const SRC = fs.readFileSync('supabase/functions/ima-proxy/index.ts', 'utf8');
const JWT = fs.readFileSync(new URL('./_e2e_jwt.tmp', import.meta.url), 'utf8');
const PROMPT = fs.readFileSync(new URL('./_e2e_prompt.tmp', import.meta.url), 'utf8');
const result = JSON.parse(fs.readFileSync(new URL('./_e2e_result.json', import.meta.url), 'utf8'));

// ---- 提取器：按起始标记提取顶层声明（跳过类型标注，括号平衡）----
function extractTop(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i === -1) throw new Error('未找到: ' + startMarker);
  // 定位实际赋值起点：
  //   function X(...) { → ')' 后第一个 '{'
  //   const X: T = { / [ → '=' 后第一个 { 或 [
  let j = i;
  if (startMarker.startsWith('function')) {
    const paren = src.indexOf('(', j);
    let depth = 0, bodyStart = -1;
    for (let k = paren; k < src.length; k++) {
      if (src[k] === '(') depth++;
      else if (src[k] === ')') { depth--; if (depth === 0) { bodyStart = k + 1; break; } }
    }
    // 从参数列表后开始，找真正的函数体 {（跳过返回类型标注 {…}）
    let pos = bodyStart;
    for (;;) {
      const open = src.indexOf('{', pos);
      let d = 0, end = -1;
      for (let k = open; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
      }
      if (end === -1) throw new Error('未闭合: ' + startMarker);
      const rest = src.slice(end).replace(/^\s*/, '');
      if (rest.startsWith('{')) { pos = end; continue; } // 返回类型闭合，后面还有函数体
      return src.slice(i, end);
    }
  } else {
    const eq = src.indexOf('=', j);
    // 正则常量（= /.../ 开头）→ 直接取到行尾
    const afterEq = src.slice(eq + 1).replace(/^\s*/, '');
    if (afterEq.startsWith('/')) {
      const nl = src.indexOf('\n', eq);
      return src.slice(i, nl === -1 ? src.length : nl);
    }
    // '=' 后找第一个 { 或 [
    let found = -1;
    for (let k = eq + 1; k < src.length; k++) {
      if (src[k] === '{' || src[k] === '[') { found = k; break; }
      if (src[k] === ';' || src[k] === '\n') break; // 单行值无括号
    }
    if (found === -1) {
      // 单行值：到行尾分号
      const semi = src.indexOf(';', eq);
      return src.slice(i, semi === -1 ? src.indexOf('\n', eq) : semi + 1);
    }
    j = found;
  }
  // 从 j 开始括号平衡
  let depth = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('未闭合: ' + startMarker);
}

// ---- 提取 buildSystemContent 需要的所有依赖符号 ----
const symbols = [];
const grabs = [
  'function periodOfHour',
  'function formatCurrentTime',
  'const CITY_HINTS',
  'function extractLocation',
  'const STAGE_HINTS',
  'const GOAL_HINTS',
  'const MILESTONE_CHAIN',
  'const MILESTONE_TIPS',
  'const STAGE_ORDER',
  'const ESCALATION_HINTS',
  'function thisEscalationBlock',
  'const ATTACK_RE',
  'const FACTS_INJECT_MAX',
  'function truncateText',
  'function buildSystemContent',
  // gem 精排复现（检索）
  'const GEM_WEIGHT',
  'const GEM_MIN',
  'const GEM_DIALOG_RE',
  'const GEM_ACTION_RE',
  'const GEM_CONNECTOR_RE',
  'const GEM_ADJ_RE',
  'const GEM_FLUFF_RE',
  'const GEM_SYMBOL_RE',
  'const GEM_TITLE_RE',
  'function calcGemScore',
  'function applyQuota',
  'const KB_REF_COUNT',
];
for (const g of grabs) symbols.push(extractTop(SRC, g));
// KB_CONTENT_MAX 是单行 const
symbols.push('const KB_CONTENT_MAX = 400;');
// STOP_CHARS（bigram 计算用）
symbols.push(extractTop(SRC, 'const STOP_CHARS'));

const bundle = symbols.join('\n\n');
const js = ts.transpileModule(bundle, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = {};
const fn = new Function('return (function(){' + js + '\nreturn { buildSystemContent, calcGemScore, applyQuota, KB_REF_COUNT, KB_CONTENT_MAX };})();');
const api = fn();

// ---- 复现检索（与 recallBlocks 同参数）----
const { query, history } = result.request;
const semanticKws = result.response._debug.semantic_kws || [];
const STOP = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));
const gramsOf = (text) => {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) {
    const bg = clean.slice(i, i + 2);
    if (bg.split('').every(c => STOP.has(c))) continue;
    set.add(bg);
    if (set.size >= 200) return;
  }
  return set;
};
const queries = [...semanticKws, query];
const grams = new Set();
for (const q of queries) for (const g of gramsOf(q)) grams.add(g);
const semSet = new Set(semanticKws);
const weights = queries.map(q => (semSet.has(q) ? 2 : 1.5));
const rpc = await fetch(`https://opzvvgixlfbfpdlsorbi.supabase.co/rest/v1/rpc/kb_blocks_recall`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_grams: [...grams].slice(0, 80), p_words: queries.slice(0, 20), p_weights: weights.slice(0, 20), p_limit: 24, p_max_blocks_per_doc: 2 }),
});
const rows = await rpc.json();
const items = rows.map(r => ({ ...r, _gem: api.calcGemScore(r.content || '', r.block_title || ''), _ft_score: Number(r.score) || 0 }));
const scored = items
  .map(it => ({ ...it, _gem: it._gem }))
  .filter(it => it._gem >= -1)
  .sort((a, b) => ((b._ft_score || 0) + (b._gem || 0) * 0.8) - ((a._ft_score || 0) + (a._gem || 0) * 0.8));
const kbItems = api.applyQuota(scored, { hsFolder: '恋爱话术', jxFolder: null, pickCount: 3 });

// ---- 重建 system ----
const llmHistory = history.slice(-8);
const built = api.buildSystemContent({
  systemPrompt: PROMPT,
  userBio: '',
  memoryCard: null,
  olderSummary: '',
  kbItems,
  kbFallback: false,
  lastUserText: query,
  hasRecentHistory: llmHistory.length >= 4,
  switchTopic: false,
});
const systemContent = built.systemContent;

// ---- 输出完整报告 ----
const out = {
  request: result.request,
  kb_reproduce: {
    queries, grams_count: grams.size, weights,
    rpc_rows: rows.length,
    kbItems: kbItems.map((it, i) => ({
      rank: i + 1, title: it.title, folder_id: it.folder_id,
      ft_score: it._ft_score, gem: it._gem, content: it.content.slice(0, 400),
    })),
  },
  system_content: systemContent,
  messages: [
    { role: 'system', content: systemContent },
    ...llmHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: query },
  ],
  llm_output: {
    reply: result.response.reply,
    reasoning: result.response._debug.llm_reasoning,
    usage: result.response._debug.llm_usage,
  },
  debug: result.response._debug,
  wall_ms: result.wall_ms,
};
fs.writeFileSync(new URL('./_e2e_report.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('报告已生成: _e2e_report.json');
console.log('system 字符数:', systemContent.length);
console.log('召回块数:', kbItems.length, '| 检索原始:', rows.length, '条');
