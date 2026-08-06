// 部署 ima-proxy
// 用法: SBP_PAT=xxx node deploy_ima_proxy.mjs
//   （PAT 从环境变量读取，禁止硬编码到脚本/日志/仓库）
import fs from 'fs';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SLUG = 'ima-proxy';
const SRC = 'C:/Users/Administrator/Documents/junshi/supabase/functions/ima-proxy/index.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const form = new FormData();
  form.append('file', new Blob([src], { type: 'text/typescript' }), 'index.ts');
  form.append('metadata', JSON.stringify({ entrypoint_path: 'index.ts', name: SLUG }));

  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${SLUG}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${PAT}`, 'User-Agent': UA }, body: form }
  );
  console.log('部署 HTTP:', resp.status);
  const d = await resp.json();
  console.log('version:', d.version || JSON.stringify(d).slice(0, 300));
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
