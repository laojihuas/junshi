#!/usr/bin/env node
// 话术块长度分布统计（决定知识库截断安全值）
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
    blocks.push({ title: (parts[i + 3] || '').trim(), content });
  }
  return blocks;
}
const blocks = [];
for (const f of files) blocks.push(...parseChunkFile(path.join(DIR, f)));

const lens = blocks.map(b => b.content.length).sort((a, b) => a - b);
const pct = (p) => lens[Math.floor(lens.length * p)];
console.log(`块总数: ${blocks.length}`);
console.log(`长度分布: min=${lens[0]} p25=${pct(0.25)} p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} p95=${pct(0.95)} max=${lens[lens.length - 1]}`);
console.log(`>300字: ${lens.filter(x => x > 300).length} 块 (${(lens.filter(x => x > 300).length / blocks.length * 100).toFixed(0)}%)`);
console.log(`>400字: ${lens.filter(x => x > 400).length} 块 (${(lens.filter(x => x > 400).length / blocks.length * 100).toFixed(0)}%)`);
console.log(`>500字: ${lens.filter(x => x > 500).length} 块 (${(lens.filter(x => x > 500).length / blocks.length * 100).toFixed(0)}%)`);
console.log(`>600字: ${lens.filter(x => x > 600).length} 块`);
console.log(`有块标题: ${blocks.filter(b => b.title).length} 块`);
// 看几个 >400 字的块样本（判断截断 400 会不会丢金句）
const longBlocks = blocks.filter(b => b.content.length > 400).slice(0, 3);
for (const b of longBlocks) {
  console.log(`\n--- 长块样本(${b.content.length}字) ${b.title} ---`);
  console.log(b.content.slice(0, 420));
  console.log('...(截断点后):', b.content.slice(400, 500).replace(/\n/g, ' '));
}
