// 通用 SQL 执行器（管理 API database/query）
// 用法: SBP_PAT=xxx node exec_sql.mjs <sql文件路径>
//   PAT 只从环境变量读，禁止硬编码/打印
import fs from 'fs';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const file = process.argv[2];
if (!file) { console.error('用法: node exec_sql.mjs <sql文件路径>'); process.exit(1); }

const REF = 'opzvvgixlfbfpdlsorbi';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sql = fs.readFileSync(file, 'utf8');

const resp = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PAT}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await resp.text();
console.log('SQL HTTP:', resp.status);
if (!resp.ok) { console.error(text.slice(0, 800)); process.exit(1); }
console.log('结果:', text.slice(0, 400));
