// v210 唤醒命中链路验证（临时放宽时间窗 → 真实命中 → 清理恢复）
// 用法: SBP_PAT=xxx node verify_wake_hit.mjs
import fs from 'fs';

const PAT = process.env.SBP_PAT;
if (!PAT) { console.error('缺少 SBP_PAT 环境变量'); process.exit(1); }
const REF = 'opzvvgixlfbfpdlsorbi';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SUPABASE_URL = `https://${REF}.supabase.co`;

async function query(sql) {
  const resp = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('query failed: ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const ak = await query("select id, api_key from public.profiles where api_key <> '' limit 1");
  if (!ak.length) { console.log('无 api_key 账号'); return; }
  const apiKey = ak[0].api_key;

  // 1) 临时放宽窗口 0-24（管理 API 直改，测完恢复）
  await query("update public.app_config set quota_params = (coalesce(quota_params::jsonb,'{}'::jsonb) || '{\"wake_start_hour\":0,\"wake_end_hour\":24}'::jsonb)::text where id = 1");
  console.log('[1] 临时窗口 0-24 已设');

  // 2) 真实 wake 调用
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, mode: 'wake' })
  });
  const d = JSON.parse(await resp.text());
  console.log('[2] wake HTTP', resp.status, '| window =', d.window, '| disabled =', d.disabled);
  console.log('   命中 =', d.wake.length, '条:', JSON.stringify(d.wake));
  console.log('   skipped =', JSON.stringify(d.skipped));

  // 3) 校验落库 + 置位
  if (d.wake.length) {
    for (const w of d.wake) {
      const msgs = await query(
        "select role, content, created_at from public.chat_messages where session_id = '" + w.session_id + "' order by created_at desc limit 1"
      );
      const s = await query("select last_wake_at from public.chat_sessions where id = '" + w.session_id + "'");
      console.log('[3] 落库校验', w.friend_name, '→ role=' + (msgs[0]?.role), 'content=' + (msgs[0]?.content || ''), '| last_wake_at=' + (s[0]?.last_wake_at ? '已置位✓' : '未置位✗'));
      // 清理：删掉刚落库的消息 + 清 last_wake_at（真实场景留待用户实际使用）
      await query("delete from public.chat_messages where id in (select id from public.chat_messages where session_id = '" + w.session_id + "' order by created_at desc limit 1)");
      await query("update public.chat_sessions set last_wake_at = null where id = '" + w.session_id + "'");
      console.log('   已清理（删除测试消息 + 清 last_wake_at）');
    }
  }

  // 4) 恢复窗口 10-24
  await query("update public.app_config set quota_params = (coalesce(quota_params::jsonb,'{}'::jsonb) || '{\"wake_start_hour\":10,\"wake_end_hour\":24}'::jsonb)::text where id = 1");
  const cfg = await query("select quota_params from public.app_config where id = 1");
  const qp = JSON.parse(cfg[0].quota_params);
  console.log('[4] 窗口已恢复 =', qp.wake_start_hour + ':00-' + qp.wake_end_hour + ':00');
}

main().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
