// 调 RPC cleanup_ghost_devices(p_dry_run) 走 service_role 路径看候选
// 用法: SBP_PAT=xxx node cleanup_ghost.mjs [true|false]
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';

const dryRun = process.argv[2] !== 'false';
console.log('dryRun =', dryRun);

process.env.NO_PROXY = '*';

(async () => {
  // 拿 service_role
  const keysR = await fetch('https://api.supabase.com/v1/projects/' + REF + '/api-keys', {
    headers: { 'Authorization': 'Bearer ' + PAT }
  });
  const keys = await keysR.json();
  const SR = keys.find(k => k.name === 'service_role').api_key;

  // 调 RPC：service_role 走管理员路径（函数的 is_admin 对 service_role 不生效→ 用 SECURITY DEFINER 跳过）
  const resp = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/cleanup_ghost_devices`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SR,
      'apikey': SR,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_dry_run: dryRun })
  });
  const text = await resp.text();
  console.log('HTTP', resp.status);
  console.log(text);
})();
