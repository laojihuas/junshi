#!/usr/bin/env node
// ============================================================
// 军师 - kb_blocks 灌库脚本 [B 方案]
// 读取 C:\迷男\恋爱话术\*.md（切块文件）
// 解析块注释 <!-- 块 i/N | X 字 | 标题 -->，算 bigrams，分批 upsert
// [2026-08-06] 恋爱教学/聊天实战 已从库删除（干扰检索），不再灌入；
//   如未来要恢复，把目录加回 ROOTS 并重跑本脚本即可
// 用法: SBP_PAT=xxx node build_kb_blocks.mjs
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SUPABASE = `https://${REF}.supabase.co`;
const API = `https://api.supabase.com/v1/projects/${REF}`;
const ROOTS = {
  '恋爱话术': 'C:/迷男/恋爱话术',
  // '恋爱教学': 'C:/迷男/恋爱教学',   // 2026-08-06 已删库，不再上传
  // '聊天实战': 'C:/迷男/聊天实战',   // 2026-08-06 已删库，不再上传
};

// ---- 1. 拿 service_role ----
const kr = await fetch(`${API}/api-keys`, { headers: { 'Authorization': `Bearer ${PAT}` } });
const keys = (await kr.json()) || [];
const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
if (!sr) { console.error('未找到 service_role key'); process.exit(1); }
const SERVICE_ROLE = sr.api_key || sr.key;
console.log('service_role 获取成功');

// ---- 停用字（与旧 kb_docs 一致）----
const STOP_CHARS = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));

function calcBigrams(text, max = 800) {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) {
    const bg = clean.slice(i, i + 2);
    const chars = bg.split('');
    const real = chars.filter(c => !STOP_CHARS.has(c)).length;
    if (real === 0) continue;
    set.add(bg);
    if (set.size >= max) break;
  }
  return [...set];
}

// ---- 2. 解析切块文件 ----
// 格式：<!-- 块 i/N | X 字 [| 标题] -->\n内容\n\n---\n\n...
function parseChunkFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // 按块注释拆分
  const parts = raw.split(/<!-- 块 (\d+)\/(\d+) \| (\d+) 字(?: \| (.*?))? -->\n/);
  const blocks = [];
  // parts[0]=前置空, 然后每4组: [idx, total, len, title, content...]
  for (let i = 1; i < parts.length; i += 5) {
    if (i + 3 >= parts.length) break;
    const idx = parseInt(parts[i]);
    const title = (parts[i + 3] || '').trim();
    const content = (parts[i + 4] || '').replace(/\n---\s*$/, '').trim();
    if (!content) continue;
    blocks.push({ idx, title, content });
  }
  return blocks;
}

// ---- 3. 收集所有块 ----
const rows = [];
for (const [folder, dir] of Object.entries(ROOTS)) {
  if (!fs.existsSync(dir)) { console.warn(`目录不存在: ${dir}`); continue; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  console.log(`[${folder}] 文件数: ${files.length}`);
  for (const f of files) {
    const full = path.join(dir, f);
    const docTitle = f;  // 文档标题 = 文件名（含 .md）
    const mediaId = 'local_' + crypto.createHash('sha1').update(folder + '/' + f).digest('hex').slice(0, 24);
    const blocks = parseChunkFile(full);
    for (const b of blocks) {
      rows.push({
        media_id: mediaId,
        block_idx: b.idx - 1,
        title: docTitle,
        block_title: b.title,
        folder_id: folder,
        content: b.content,
        bigrams: calcBigrams(b.content),
        content_hash: crypto.createHash('sha1').update(b.content).digest('hex'),
      });
    }
  }
}
console.log(`解析完成: ${rows.length} 块`);

// ---- 4. 分批 upsert ----
const BATCH = 100;
let ok = 0, fail = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const res = await fetch(`${SUPABASE}/rest/v1/kb_blocks?on_conflict=media_id,block_idx`, {
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
