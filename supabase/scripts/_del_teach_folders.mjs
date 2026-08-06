#!/usr/bin/env node
// ============================================================
// 一次性脚本：删除 kb_blocks 中 恋爱教学 + 聊天实战 两个文件夹的数据
// 用法: SBP_PAT=xxx node _del_teach_folders.mjs
// ============================================================
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const API = `https://api.supabase.com/v1/projects/${REF}`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const q = async (sql) => {
  const r = await fetch(`${API}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query: sql }),
  });
  const t = await r.text();
  if (r.status < 300) return { ok: true, data: t ? JSON.parse(t) : null };
  return { ok: false, status: r.status, body: t };
};

// 1. 删除前分布
const before = await q(`select folder_id, count(*) as n from public.kb_blocks group by folder_id order by n desc`);
console.log('删除前分布:', JSON.stringify(before.data, null, 2));

// 2. 执行删除
const del = await q(`delete from public.kb_blocks where folder_id in ('恋爱教学','聊天实战')`);
console.log('删除结果:', del.ok ? `OK` : `${del.status} ${del.body}`);

// 3. 删除后分布
const after = await q(`select folder_id, count(*) as n from public.kb_blocks group by folder_id order by n desc`);
console.log('删除后分布:', JSON.stringify(after.data, null, 2));

// 4. 残留检查：kb_docs 是否还有数据 / 是否存在 kb_docs 表
const docs = await q(`select count(*) as n from public.kb_docs`);
console.log('kb_docs 残留行数:', docs.ok ? JSON.stringify(docs.data) : `${docs.status} ${docs.body}`);

// 5. 残留检查：media_id 中是否还有指向已删文件夹的孤儿（理论上无，因为 folder_id 已删）
const orphan = await q(`select count(*) as n from public.kb_blocks where media_id like 'local_%' and folder_id not in ('恋爱话术')`);
console.log('非话术 folder 残留:', orphan.ok ? JSON.stringify(orphan.data) : `${orphan.status} ${orphan.body}`);
