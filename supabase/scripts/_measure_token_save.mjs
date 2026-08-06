#!/usr/bin/env node
// 量化 buildSystemContent 固定块优化前后的字符规模（token 估算）
// 对比：git d802387（优化前） vs 当前工作区（优化后）
import { execSync } from 'child_process';
import fs from 'fs';

function extractSystemStrings(src) {
  const start = src.indexOf('function buildSystemContent');
  const end = src.indexOf('\n}\n', src.indexOf('return { systemContent'));
  const body = src.slice(start, end);
  // 提取所有单引号字符串与模板字符串（粗略：去重后拼接，忽略 ${} 动态插值）
  let total = 0;
  const re = /'([^']*)'|`([^`]*)`/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const s = m[1] || m[2] || '';
    if (s.length > 5) total += s.length; // 过滤空串/短片段
  }
  return total;
}

const cur = fs.readFileSync('supabase/functions/ima-proxy/index.ts', 'utf8');
const old = execSync('git show d802387:supabase/functions/ima-proxy/index.ts', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const oldLen = extractSystemStrings(old);
const curLen = extractSystemStrings(cur);
// 中文按 ~0.7 token/字，标点/英文按 ~0.25 token/字 粗估（DeepSeek BPE）
const estToken = (n) => Math.round(n * 0.62);
console.log(`buildSystemContent 字符串总量（优化前）: ${oldLen} 字 ≈ ${estToken(oldLen)} token`);
console.log(`buildSystemContent 字符串总量（优化后）: ${curLen} 字 ≈ ${estToken(curLen)} token`);
console.log(`固定块精简: -${oldLen - curLen} 字 ≈ -${estToken(oldLen) - estToken(curLen)} token/轮`);

// 知识库截断收益（运行时行为）：3 条 × (p50 651 - 400) 
const kbSave = 3 * (651 - 400);
console.log(`知识库截断 400 字: 每轮约 -${kbSave} 字 ≈ -${estToken(kbSave)} token（块 p50=651 字）`);
console.log(`综合固定块+知识库: 每轮约 -${oldLen - curLen + kbSave} 字 ≈ -${estToken(oldLen - curLen + kbSave)} token`);
