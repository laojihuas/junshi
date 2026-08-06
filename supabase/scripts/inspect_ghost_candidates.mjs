const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
process.env.NO_PROXY = '*';

const SQL = `
-- 规则 A：测试前缀候选
select 'rule_a' as rule, device_id, created_at
from public.devices
where device_id ~ '^(toktest_|test_|pytest_|debug_|jstest_)'

union all

-- 规则 B：fp_ 孤岛候选
select 'rule_b' as rule, d.device_id, d.created_at
from public.devices d
where d.device_id like 'fp\_%'
  and d.created_at < now() - interval '7 days'
  and coalesce(d.invite_code, '') = ''
  and d.activation_code is null
  and not exists (select 1 from public.accounts a where a.device_id = d.device_id)
  and not exists (
      select 1 from public.daily_quota q
      where q.identity_type = 'device' and q.identity_key = d.device_id
  )
order by rule, created_at;
`;

(async () => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: SQL })
  });
  const text = await r.text();
  console.log('HTTP', r.status);
  let json; try { json = JSON.parse(text); } catch { json = text; }
  console.log(JSON.stringify(json, null, 2));
})();
