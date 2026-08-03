// token 消耗检测:复刻 ima-proxy LLM 链路,用 DeepSeek usage 实测
// 对比:旧场景(220021 时代,content 空,无定向摘要,主回复小 system) vs 新场景(v43,content 有值,定向摘要5篇,主回复大 system)
// 用法: node bench_tokens.mjs
import fs from 'fs';

const llmKey = process.env.DEEPSEEK_API_KEY;
const llmModel = 'deepseek-v4-flash';
const QUERY = '她说今天被领导骂了很难受不知道怎么办';
const total = { in: 0, out: 0 };

async function llm(messages, { temperature = 0.2, maxTokens = 150, thinking = 'off' } = {}) {
  const body = { model: llmModel, messages };
  if (thinking !== 'off') {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = thinking;
    body.max_tokens = Math.max(maxTokens, 2000);
  } else {
    body.thinking = { type: 'disabled' };
    body.temperature = temperature;
    body.max_tokens = maxTokens;
    body.frequency_penalty = 0.5;
    body.presence_penalty = 0;
  }
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + llmKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  const u = d?.usage || {};
  total.in += u.prompt_tokens || 0;
  total.out += u.completion_tokens || 0;
  return { content: d?.choices?.[0]?.message?.content || '', in: u.prompt_tokens || 0, out: u.completion_tokens || 0 };
}

// 从线上代码提取 TOPIC_VOCAB 91 词(保证 prompt 与线上一致)
const src = fs.readFileSync('supabase/functions/ima-proxy/index.ts', 'utf8');
const vocabMatch = src.match(/const TOPIC_VOCAB: string\[\] = \[([\s\S]*?)\];/);
const TOPIC_VOCAB = vocabMatch ? [...vocabMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

console.log('===== token 消耗检测 =====');
console.log('场景:', QUERY, '\n');

// ---- 1. 语义拆解(真实 prompt: 91词词表 + few-shot) ----
const p1 = `你是恋爱话术检索助手，负责把"对方说的话"拆解成适合检索恋爱资料库的短关键词。
对方的话：「${QUERY.slice(0, 80)}」
知识库领域词表（检索词应优先从中选择，可少量自创补充）：
${TOPIC_VOCAB.join('、')}
示例：
输入："她说今天被领导骂了很难受"
输出：["被骂","委屈","哄","工作压力","情绪低落"]
要求：只输出 JSON 数组（如 ["推拉","试探"]），3-5 个词，每个词 2-5 字；不要任何解释文字。`;
const r1 = await llm([{ role: 'user', content: p1 }], { temperature: 0.2, maxTokens: 150 });
console.log(`语义拆解: 输入 ${r1.in} / 输出 ${r1.out} token`);

// ---- 2. 整句压缩 ----
const p2 = `你是恋爱话术检索助手，负责把"对方说的话"压缩成适合检索恋爱资料库的短短语。
对方的话：「${QUERY.slice(0, 80)}」
要点：短语必须贴近原话语气/场景，优先选择资料库里常见的问题短语（如"怎么回""怎么安慰""忽冷忽热""不回消息"）。
示例：
输入："她说今天被领导骂了很难受" 输出：["怎么安慰","难过","低落"]
要求：只输出 JSON 数组，2-4 个短语，每个 2-4 字；不要解释文字。`;
const r2 = await llm([{ role: 'user', content: p2 }], { temperature: 0.2, maxTokens: 150 });
console.log(`整句压缩: 输入 ${r2.in} / 输出 ${r2.out} token`);

// ---- 3. 套路提炼(首轮,2400 字资料) ----
const sampleDoc = ('如何安抚被领导批评的女生：先共情再给建议。共情安抚的核心是承接情绪，不要急着讲道理。可以这样说："被领导骂肯定很难受，换我我也憋屈，说说咋回事？" 然后引导她说出细节，全程不评判只倾听。\n').repeat(40).slice(0, 2400);
const p3 = `你是恋爱聊天"惯例/玩法"提炼助手。用户正在替自己回复对方，当前对方的话：「${QUERY.slice(0, 60)}」。
以下是检索到的资料：
${sampleDoc}
要求：如果资料中存在"分步骤、可执行"的聊天惯例，提炼成 JSON：{"name":"...","goal":"...","steps":["第1步..."]} steps 2-6 步；没有则输出 {"name":"","steps":[]}。只输出 JSON。`;
const r3 = await llm([{ role: 'user', content: p3 }], { temperature: 0.2, maxTokens: 400 });
console.log(`套路提炼(首轮): 输入 ${r3.in} / 输出 ${r3.out} token`);

// ---- 4. 画像提取(首轮) ----
const p4 = `你是情感分析助手。根据对话提炼对方画像，输出 JSON：{"stage":"阶段","personality":"性格","relationship_note":"关系备注","recent_events":"近期事件"}。
最近对话：
对方：${QUERY}
用户：先共情她的情绪，问她具体发生了什么。
对方：她说领导当着全组骂她，她觉得特别丢人。
只输出 JSON。`;
const r4 = await llm([{ role: 'user', content: p4 }], { temperature: 0.2, maxTokens: 300 });
console.log(`画像提取(首轮): 输入 ${r4.in} / 输出 ${r4.out} token`);

// ---- 5. 定向摘要 ×5(新场景才有;旧场景 content 空不触发) ----
let sumIn = 0, sumOut = 0, sumCount = 0;
const docFull = ('先共情再给建议。共情安抚的核心是承接情绪，不要急着讲道理。可以这样说："被领导骂肯定很难受，换我我也憋屈，说说咋回事？" 然后引导她说出细节，全程不评判只倾听。最后给一个简单的安慰话术。\n').repeat(60).slice(0, 3500);
for (let i = 0; i < 5; i++) {
  const p5 = `你是恋爱话术提炼助手。用户正要回复对方，对方的话：「${QUERY.slice(0, 60)}」。
以下是从知识库检索到的资料【文档标题${i + 1}】：
${docFull}
要求：提取与当前问题直接相关的话术要点、可操作步骤或关键语句（若资料是惯例/套路类，把步骤序列提取出来），150-300 字。直接输出要点，不要任何解释、标题或格式头；若资料与当前问题明显无关，只输出两个字：无关。`;
  const r5 = await llm([{ role: 'user', content: p5 }], { temperature: 0.2, maxTokens: 400 });
  sumIn += r5.in; sumOut += r5.out; sumCount++;
}
console.log(`定向摘要 ×5: 输入 ${sumIn} / 输出 ${sumOut} token`);

// ---- 6. 主回复(对比:旧=小system标题参考 / 新=大system含摘要) ----
function buildSys(withContent) {
  const base = '你即用户本人，是一位深谙恋爱心理与聊天技巧的军师。线上场景，输出 1-2 句回复。\n\n以下是从知识库检索到的参考资料。它们只是弹药：仅提供语气、角度、措辞素材；当参考内容与当前对话冲突时，以对话上下文为准。\n';
  if (!withContent) return base + '【参考资料 1】女朋友吵架了怎么安慰？\n【参考资料 2】喜欢的人牙疼该怎么安慰她？\n【参考资料 3】她说只想跟我做朋友怎么办？\n【参考资料 4】把妹聊天实战：酒过半巡\n【参考资料 5】今天只推荐一首歌\n\n格式约束：直接输出回复文本。';
  let refs = '';
  for (let i = 1; i <= 5; i++) refs += `【参考资料 ${i}】文档标题${i}\n先共情再给建议，承接情绪不要讲道理，可引导说出细节，最后给一个简短安慰话术。\n\n`;
  return base + refs + '格式约束：直接输出回复文本。';
}
const history = [{ role: 'user', content: QUERY }];
const r6old = await llm([{ role: 'system', content: buildSys(false) }, ...history, { role: 'user', content: QUERY }], { temperature: 0.8, maxTokens: 3000, thinking: 'high' });
const r6new = await llm([{ role: 'system', content: buildSys(true) }, ...history, { role: 'user', content: QUERY }], { temperature: 0.8, maxTokens: 3000, thinking: 'high' });
console.log(`主回复(旧/标题参考): 输入 ${r6old.in} / 输出 ${r6old.out} token`);
console.log(`主回复(新/含摘要):   输入 ${r6new.in} / 输出 ${r6new.out} token`);

// ---- 汇总对比 ----
const oldIn = r1.in + r2.in + r3.in + r4.in + r6old.in;
const oldOut = r1.out + r2.out + r3.out + r4.out + r6old.out;
const newIn = r1.in + r2.in + r3.in + r4.in + sumIn + r6new.in;
const newOut = r1.out + r2.out + r3.out + r4.out + sumOut + r6new.out;
console.log('\n===== 对比 =====');
console.log(`旧场景(无正文,首轮): 输入 ${oldIn} / 输出 ${oldOut} / 合计 ${oldIn + oldOut} token`);
console.log(`新场景(有正文,首轮): 输入 ${newIn} / 输出 ${newOut} / 合计 ${newIn + newOut} token`);
console.log(`增量: 输入 +${newIn - oldIn} / 输出 +${newOut - oldOut} / 合计 +${newIn + newOut - oldIn - oldOut}`);
console.log('\n注: 后续轮次(非首轮)无套路提炼+画像提取,每轮约减 ' + (r3.in + r3.out + r4.in + r4.out) + ' token');
