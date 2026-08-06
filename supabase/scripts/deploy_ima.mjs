// 部署 ima-proxy 到生产（只部署，不端到端）
// 用法：node deploy_ima.mjs
import fs from 'fs';
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const SLUG = 'ima-proxy';
const SRC = new URL('../functions/ima-proxy/index.ts', import.meta.url);

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const form = new FormData();
  form.append('file', new Blob([src], { type: 'text/typescript' }), 'index.ts');
  // [v20260805] ima-proxy 业务由前端 anon JWT 鉴权（evaluate_for_user），supabase 默认 verify_jwt=true 也行
  // 但稳妥起见，不加 verify_jwt:false 默认即 true
  form.append('metadata', JSON.stringify({ entrypoint_path: 'index.ts', name: SLUG }));
  const depR = await fetch(
    'https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=' + SLUG,
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + PAT }, body: form }
  );
  console.log('部署 HTTP:', depR.status);
  const depD = await depR.json();
  console.log('version:', depD.version || JSON.stringify(depD).slice(0, 300));
})();
