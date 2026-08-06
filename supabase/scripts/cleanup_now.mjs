// 一次性执行清理（service_role 路径，绕过 RPC 的 admin 鉴权）
// 仅清理规则 A 测试前缀（绝对安全，无真人使用）
// 用法: SBP_PAT=xxx node cleanup_now.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
process.env.NO_PROXY = '*';

const SQL = `
-- 仅清理规则 A 测试前缀（toktest_/test_/pytest_/debug_/jstest_）
delete from public.devices
where device_id ~ '^(toktest_|test_|pytest_|debug_|jstest_)'
returning device_id;
`;

(async () => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: SQL })
  });
  const text = await r.text();
  console.log('HTTP', r.status);
  console.log(text);
})();
