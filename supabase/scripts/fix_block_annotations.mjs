// 切块注释重算器 v2：按块注释行扫描（不依赖 --- 分隔，避免内容含 --- 行误切丢块）
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'C:/迷男/恋爱话术_切块';
if (!fs.existsSync(DIR)) { console.error('目录不存在:', DIR); process.exit(1); }
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'));
let totalBlocks = 0;
let typeStat = {};

for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  // 按块注释行定位每个块：<!-- 块 ... --> 到下一个块注释或文件尾
  const lines = raw.split('\n');
  const parsed = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^<!-- 块 \d+\/\d+ \| \d+ 字 \| ([^\s]+) -->/);
    if (m) {
      if (cur && cur.content.trim()) parsed.push(cur);
      cur = { type: m[1], content: '' };
    } else if (cur) {
      // 跳过块间的 --- 分隔符行（它属于上一块结尾还是下一块开头不影响：不加入内容）
      if (line.trim() === '---') continue;
      cur.content += line + '\n';
    }
  }
  if (cur && cur.content.trim()) parsed.push(cur);

  if (parsed.length === 0) { console.log(`${f}: 无有效块，跳过`); continue; }
  const total = parsed.length;
  const out = parsed.map((b, i) => {
    const len = b.content.replace(/\s/g, '').length;
    return `<!-- 块 ${i + 1}/${total} | ${len} 字 | ${b.type} -->\n${b.content.trim()}`;
  }).join('\n---\n');
  fs.writeFileSync(path.join(DIR, f), out + '\n');
  const lens = parsed.map(b => b.content.replace(/\s/g, '').length).sort((a, b) => a - b);
  const types = {};
  for (const b of parsed) { types[b.type] = (types[b.type] || 0) + 1; typeStat[b.type] = (typeStat[b.type] || 0) + 1; }
  totalBlocks += total;
  const med = lens[Math.floor(lens.length / 2)];
  console.log(`${f}: ${total} 块 | ${JSON.stringify(types)} | 长度 min=${lens[0]} 中位=${med} max=${lens[lens.length - 1]}`);
}
console.log(`\nTOTAL ${totalBlocks} 块 | 类型分布 ${JSON.stringify(typeStat)}`);
