// 一键迁移 SQL：把 chat_sessions.memory_card.profile.stage 中所有 "普通朋友" → "朋友"
// 用法：node deploy_stage_rename.mjs
// PAT 从 资料.txt 读取，不入日志。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF = 'opzvvgixlfbfpdlsorbi';
const FILE = 'C:\\Users\\Administrator\\Documents\\资料.txt';
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const patLine = lines.find(l => l.startsWith('令牌') || l.startsWith('令牌sbp_'));
if (!patLine) { console.error('找不到 PAT 行'); process.exit(1); }
const PAT = patLine.replace(/^令牌/, '').trim();
if (!PAT.startsWith('sbp_')) { console.error('PAT 格式异常'); process.exit(1); }

const SQL_PATH = path.resolve(__dirname, '../sql/012_stage_rename_to_friend.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

// [v20260805] 强制禁用代理 + 浏览器 UA，避开 Cloudflare 1010
process.env.NO_PROXY = '*';
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.NODE_OPTIONS = '--no-warnings';

const url = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const body = JSON.stringify({ query: SQL });

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${PAT}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
  body,
});
const text = await res.text();
console.log('HTTP', res.status);
let json = null;
try { json = JSON.parse(text); } catch {}
if (json) {
  // 执行 SQL 默认返回数组（每个 statement 一项）
  console.log(JSON.stringify(json, null, 2));
} else {
  console.log(text);
}
