#!/usr/bin/env node
// ============================================================
// 军师 - kb_blocks 灌库脚本 [v79]
// 读取 C:\迷男\恋爱话术_切块\*.md（语义切块产物）
// 格式：<!-- 块 i/N | X 字 | 类型 -->\n内容\n---\n...
// 类型（话术/套路）写入 block_title 前缀 [话术]/[套路]，供检索双档过滤
// 灌库前清空 kb_blocks 旧数据（旧 739 块硬切块，防新旧混杂）
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
  '恋爱话术': 'C:/迷男/恋爱话术_切块',   // [v79] 语义切块产物目录
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

// ---- 2. 解析语义切块文件 ----
// 格式：<!-- 块 i/N | X 字 | 类型 -->\n内容\n---\n...
function parseChunkFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = raw.split(/\n---\n/);
  const blocks = [];
  for (const c of chunks) {
    const m = c.match(/^<!-- 块 \d+\/\d+ \| \d+ 字 \| ([^\s]+) -->\n([\s\S]*)$/);
    if (!m) continue;
    const type = m[1];
    const content = m[2].trim();
    if (!content) continue;
    // 块标题：从内容首行【X】提取（无则留空）
    const t = content.match(/^【([^】]{1,20})】/);
    blocks.push({ type, title: t ? t[1] : '', content });
  }
  return blocks;
}

// ---- 3. 收集所有块 ----
const rows = [];
for (const [folder, dir] of Object.entries(ROOTS)) {
  if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(1); }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  console.log(`[${folder}] 文件数: ${files.length}`);
  for (const f of files) {
    const full = path.join(dir, f);
    const docTitle = f;
    const mediaId = 'local_' + crypto.createHash('sha1').update(folder + '/' + f).digest('hex').slice(0, 24);
    const blocks = parseChunkFile(full);
    let idx = 0;
    for (const b of blocks) {
      rows.push({
        media_id: mediaId,
        block_idx: idx++,                              // 从 0 递增
        title: docTitle,
        block_title: `[${b.type}]${b.title || '未命名'}`, // [v79] 类型前缀，检索双档过滤用
        folder_id: folder,
        content: b.content,
        bigrams: calcBigrams(b.content),
        content_hash: crypto.createHash('sha1').update(b.content).digest('hex'),
      });
    }
  }
}
console.log(`解析完成: ${rows.length} 块`);

// ---- 4. 清空旧数据（防新旧混杂；PostgREST 禁止无 WHERE 的 DELETE，
//      kb_blocks 无 id 列，用 media_id=neq 哨兵值删全表）----
console.log('清空旧 kb_blocks...');
const del = await fetch(`${SUPABASE}/rest/v1/kb_blocks?media_id=neq.__none__`, {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${SERVICE_ROLE}`, 'apikey': SERVICE_ROLE, 'Prefer': 'count=exact' },
});
const delCount = del.headers.get('content-range') || `status=${del.status}`;
console.log(`清空完成: ${del.status} ${delCount}`);

// ---- 5. 分批 upsert ----
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
