#!/usr/bin/env node
// 话术库分析：评估 TOPIC_VOCAB 命中率 + 高频短语分布，为检索改革提供数据依据
import fs from 'fs';
import path from 'path';

const DIR = 'C:/迷男/恋爱话术';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'));

// 与 build_kb_blocks.mjs 相同的切块解析
function parseChunkFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parts = raw.split(/<!-- 块 (\d+)\/(\d+) \| (\d+) 字(?: \| (.*?))? -->\n/);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 5) {
    if (i + 3 >= parts.length) break;
    const title = (parts[i + 3] || '').trim();
    const content = (parts[i + 4] || '').replace(/\n---\s*$/, '').trim();
    if (!content) continue;
    blocks.push({ title, content });
  }
  return blocks;
}

const blocks = [];
for (const f of files) {
  const bs = parseChunkFile(path.join(DIR, f));
  blocks.push(...bs.map(b => ({ doc: f, ...b })));
}
console.log(`文件 ${files.length} 个，块 ${blocks.length} 个`);

// 1. TOPIC_VOCAB 命中块数（词出现在 content 或 doc 名）
const TOPIC_VOCAB = [
  '低落','委屈','生气','难过','伤心','敷衍','高冷','冷淡','忽冷忽热','开心',
  '追求','暧昧','恋爱','挽回','异地','吵架','冷战','分手','复合','暗恋','相亲',
  '安慰','哄','道歉','解释','试探','邀约','表白','约会','见面','聊天','回复','追问',
  '慢热','内向','外向','强势','粘人','傲娇','独立','海王',
  '框架','惯例','服从性测试','推拉','欲擒故纵','情绪价值','冷读','废物测试',
  '三明治夸奖','进挪','角色扮演','开场白','打压','搭讪','展示面','二次吸引',
  '模糊邀约','预选','需求感','跪舔','冷冻','兴趣指标','推倒','暧昧',
  '查户口','试探','引导','高价值','调戏','侧面展示','假性分手','长期吸引',
  '短期吸引','建立吸引','升级关系','关系推进','主导权','服从命令','筛选话术',
  '暴露需求感','第三方话题','逗比话题','男神框架','设置陷阱','表情包开场',
  '情感浓度','心理锚定','一推一拉','冷读术','吸引阶段',
];
let hit0 = 0;
const vocabHits = TOPIC_VOCAB.map(w => {
  const n = blocks.filter(b => b.content.includes(w) || b.doc.includes(w) || (b.title || '').includes(w)).length;
  if (n === 0) hit0++;
  return { w, n };
}).sort((a, b) => b.n - a.n);
console.log(`\n===== TOPIC_VOCAB 91 词命中块数（739 块中）=====`);
console.log(`零命中词数: ${hit0} / ${TOPIC_VOCAB.length}`);
console.log(`命中≥30块的词(${vocabHits.filter(x => x.n >= 30).length}):`, vocabHits.filter(x => x.n >= 30).map(x => `${x.w}:${x.n}`).join(' '));
console.log(`命中1-29块的词(${vocabHits.filter(x => x.n >= 1 && x.n < 30).length}):`, vocabHits.filter(x => x.n >= 1 && x.n < 30).map(x => `${x.w}:${x.n}`).join(' '));
console.log(`零命中词:`, vocabHits.filter(x => x.n === 0).map(x => x.w).join('、'));

// 2. 高频 2-4 字短语（整句路候选）
const STOP = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));
function bigrams(text, n) {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i + n <= clean.length; i++) {
    const g = clean.slice(i, i + n);
    const real = g.split('').filter(c => !STOP.has(c)).length;
    if (real === 0) continue;
    set.add(g);
  }
  return [...set];
}
const freq = new Map();
for (const b of blocks) {
  for (const n of [2, 3, 4]) {
    for (const g of bigrams(b.content, n)) freq.set(g, (freq.get(g) || 0) + 1);
  }
}
const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
console.log(`\n===== 话术库高频 2-4 字短语 TOP 60 =====`);
console.log(top.map(([g, n]) => `${g}:${n}`).join(' '));

// 3. 块标题 top 分布（作为检索命中甜区参考）
const tFreq = new Map();
for (const b of blocks) if (b.title) tFreq.set(b.title, (tFreq.get(b.title) || 0) + 1);
console.log(`\n===== 块标题 TOP 40（共 ${tFreq.size} 种）=====`);
console.log([...tFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, n]) => `${t}:${n}`).join(' '));
