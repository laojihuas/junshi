// 列出所有 devices 行 + 关联统计
// 用法: SBP_PAT=xxx node inspect_devices.mjs
const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';

process.env.NO_PROXY = '*';

const SQL = `
select d.device_id, d.created_at, d.is_vip, d.invite_bonus, d.activation_code,
       d.invite_code, d.last_ip,
       coalesce(dq.cnt, 0) as quota_days,
       coalesce(dq.tot, 0) as total_used
from public.devices d
left join lateral (
  select count(*) as cnt, sum(used_count) as tot
  from public.daily_quota
  where identity_type = 'device' and identity_key = d.device_id
) dq on true
order by d.created_at desc;
`;

(async () => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: SQL })
  });
  const text = await r.text();
  console.log('HTTP', r.status);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (json) {
    console.log(JSON.stringify(json, null, 2));
    console.log('--- summary ---');
    for (const row of json) {
      console.log(`${row.device_id.slice(0, 20)}... | created=${row.created_at} | vip=${row.is_vip} | bonus=${row.invite_bonus} | code=${row.activation_code || '-'} | invite=${row.invite_code || '-'} | quota_days=${row.quota_days} | total_used=${row.total_used}`);
    }
  } else {
    console.log(text);
  }
})();
