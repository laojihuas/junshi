#!/usr/bin/env node
// ============================================================
// 军师 - kb_docs 离线构建脚本（本地文件直建）
// 用法: SBP_PAT=xxx node build_kb_cache.mjs [本地目录] [知识库名]
// 默认目录: C:\备份\Obsidian\谜男方法
//
// 流程:
//   1. 递归读本地所有 .md（跳过隐藏目录）
//   2. 清洗: 剥 YAML frontmatter + 标题前缀 + Obsidian 链接 + HTML 标签
//   3. 预计算 bigrams（2-gram 去重 ≤800）供在线数组重叠粗筛
//   4. media_id = 'local_' + sha1(相对路径)（稳定，可幂等重跑）
//   5. 分批 upsert 到 kb_docs（service_role，100 篇/批）
//
// 幂等: media_id 稳定 + on_conflict=media_id + content_hash 检测，可重复执行
// 不含明文凭证（从 SBP_PAT 取 Management PAT 再拿 service_role）
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const ROOT_DIR = process.argv[2] || 'C:\\备份\\Obsidian\\谜男方法';

// ---- 1. 拿 service_role ----
const kr = await fetch(`${API}/api-keys`, { headers: { 'Authorization': `Bearer ${PAT}` } });
const keys = (await kr.json()) || [];
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
if (!sr) { console.error('未找到 service_role key'); process.exit(1); }
const SERVICE_ROLE = sr.api_key || sr.key;
console.log('service_role 获取成功');

// ---- 2. 收集文件 ----
const files = [];
function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue; // 隐藏目录（.obsidian 等）
    const full = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(full, r);
    else if (ent.name.endsWith('.md')) files.push({ full, rel: r });
  }
}
walk(ROOT_DIR, '');
console.log(`本地文件: ${files.length} 篇`);

// ---- 3. 清洗 ----
const STOP_CHARS = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));

function stripFrontmatter(t) {
  if (t.startsWith('---')) {
    const end = t.indexOf('\n---', 3);
    if (end !== -1) return t.slice(end + 4);
  }
  return t;
}

function cleanMarkdown(t) {
  let s = t;
  // YAML frontmatter
  s = stripFrontmatter(s);
  // Obsidian 链接 [[目标|显示]] → 显示 ; [[目标]] → 目标
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
       .replace(/\[\[([^\]]+)\]\]/g, '$1');
  // 行首标题前缀（保留文字）
  s = s.split('\n').map(l => l.replace(/^\s*#{1,6}\s*/, '')).join('\n');
  // HTML 标签
  s = s.replace(/<[^>]+>/g, ' ');
  // 行内代码 / 引用标记
  s = s.replace(/^>\s*/gm, '').replace(/`/g, '');
  // 压缩 3+ 空行为 2
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function calcBigrams(text, max = 800) {
  // 去空白与标点，只留中文字符
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) {
    const bg = clean.slice(i, i + 2);
    const chars = bg.split('');
    const real = chars.filter(c => !STOP_CHARS.has(c)).length;
    if (real === 0) continue;          // 全停用字无信息量
    set.add(bg);
    if (set.size >= max) break;
  }
  return [...set];
}

// ---- 4. 组装行 ----
const rows = [];
for (const { full, rel } of files) {
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); } catch (e) { console.warn(`读取失败: ${rel} ${e.message}`); continue; }
  const content = cleanMarkdown(raw);
  if (!content) continue;
  const mediaId = 'local_' + crypto.createHash('sha1').update(rel).digest('hex').slice(0, 24);
  rows.push({
    media_id: mediaId,
    title: path.basename(full),
    folder_id: rel.split('/')[0] || 'root',
    content,
    bigrams: calcBigrams(content),
    content_hash: crypto.createHash('sha1').update(content).digest('hex'),
  });
}
console.log(`清洗完成: ${rows.length} 行（跳过 ${files.length - rows.length} 空文件）`);

// ---- 5. 分批 upsert ----
const BATCH = 100;
let ok = 0, fail = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const res = await fetch(`${SUPABASE}/rest/v1/kb_docs?on_conflict=media_id`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'apikey': SERVICE_ROLE,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates, return=minimal',
    },
    body: JSON.stringify(batch),
  });
  if (res.ok) ok += batch.length;
  else { fail += batch.length; console.error(`批 ${i / BATCH + 1} 失败: ${res.status} ${(await res.text()).slice(0, 200)}`); }
  if ((i / BATCH) % 10 === 0) console.log(`进度: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}
console.log(`\n入库完成: 成功 ${ok} / 失败 ${fail} / 总 ${rows.length}`);
