#!/usr/bin/env node
// 整句压缩短语命中测试：评估 extractSentenceKws 输出的 2-4 字短语在话术库的命中率
import fs from 'fs';
import path from 'path';

const DIR = 'C:/迷男/恋爱话术';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'));

function parseChunkFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parts = raw.split(/<!-- 块 (\d+)\/(\d+) \| (\d+) 字(?: \| (.*?))? -->\n/);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 5) {
    if (i + 3 >= parts.length) break;
    const content = (parts[i + 4] || '').replace(/\n---\s*$/, '').trim();
    if (!content) continue;
    blocks.push({ doc: parts[i], title: parts[i + 3] || '', content });
  }
  return blocks;
}
const blocks = [];
for (const f of files) blocks.push(...parseChunkFile(path.join(DIR, f)));
console.log(`话术块总数: ${blocks.length}\n`);

// 1. 整句路典型短语命中（extractSentenceKws 风格输出）
const sentencePhrases = ['怎么安慰', '不回消息', '忽冷忽热', '怎么哄', '难过', '冷战', '分手', '搭讪',
  '开场白', '怎么回', '生气', '想她', '夸她', '调情', '暧昧', '表白', '邀约', '幽默', '情话', '晚安'];
console.log('===== 整句路短语命中块数 =====');
for (const p of sentencePhrases) {
  const n = blocks.filter(b => b.content.includes(p) || (b.title || '').includes(p) || b.doc.includes(p)).length;
  console.log(`  ${p}: ${n}`);
}

// 2. 模拟整句路的真实输入 → LLM 会输出的短语命中 vs 原句 bigram 命中
const cases = [
  { q: '她说今天被领导骂了很难受', llm: ['怎么安慰', '难过', '低落'] },
  { q: '她两天没回我消息了，是不是不喜欢我了', llm: ['不回消息', '冷淡', '忽冷忽热'] },
  { q: '她生气了不理我，我该怎么哄', llm: ['怎么哄', '生气', '哄'] },
  { q: '她说只想跟我做朋友', llm: ['朋友', '冷淡', '拒绝'] },
];
console.log('\n===== 整句路 vs bigram 命中对比（块数）=====');
for (const c of cases) {
  const clean = c.q.replace(/[^\u4e00-\u9fa5]/g, '');
  const grams = [];
  for (let i = 0; i + 2 <= clean.length; i++) grams.push(clean.slice(i, i + 2));
  const bgHits = new Set();
  for (const g of grams) for (let i = 0; i < blocks.length; i++) if (blocks[i].content.includes(g)) bgHits.add(i);
  const llmHits = new Set();
  for (const p of c.llm) for (let i = 0; i < blocks.length; i++) if (blocks[i].content.includes(p)) llmHits.add(i);
  console.log(`  「${c.q}」`);
  console.log(`    原句任意bigram命中块: ${bgHits.size} | LLM整句短语命中块: ${llmHits.size}`);
}

// 3. 全词表命中评估：剩余 71 词 + 话术库特有补充词候选
const extra = ['幽默', '情话', '土味情话', '夸', '撩', '晚安', '喜欢', '想你', '关心', '哄', '赞美', '套路', '游戏', '互动', '故事', '共鸣'];
console.log('\n===== 补充候选词命中块数 =====');
for (const p of extra) {
  const n = blocks.filter(b => b.content.includes(p)).length;
  console.log(`  ${p}: ${n}`);
}
