const PAT = process.env.SBP_PAT;
const REF = 'opzvvgixlfbfpdlsorbi';
const SQL = `
delete from public.devices where device_id like 'smokev60\_%'
returning device_id;
`;
(async () => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: SQL })
  });
  console.log('HTTP', r.status, await r.text());
})();
