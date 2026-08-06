const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
process.env.NO_PROXY = '*';

const SQL = `
select id, account_name, is_vip, vip_expires_at, invite_bonus, last_login_at, device_id
from public.accounts
order by created_at desc nulls last;
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
