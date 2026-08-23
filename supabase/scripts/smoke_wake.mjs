// v210 主动唤醒冒烟：验证 SQL 026 生效 + wake 模式链路
// 用法: SBP_PAT=xxx node smoke_wake.mjs
//   （PAT 从环境变量读取；不打印敏感值，仅打印 api_key 前缀）
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
  // 1) SQL 026 生效：quota_params 含唤醒默认
  const cfg = await query("select quota_params from public.app_config where id = 1");
  const qp = cfg?.[0]?.quota_params ? JSON.parse(cfg[0].quota_params) : {};
  console.log('[1] quota_params.wake_* =', JSON.stringify({
    wake_enabled: qp.wake_enabled, wake_hours: qp.wake_hours,
    wake_start_hour: qp.wake_start_hour, wake_end_hour: qp.wake_end_hour,
  }));

  // 2) chat_sessions.last_wake_at 列存在
  const col = await query("select column_name from information_schema.columns where table_schema='public' and table_name='chat_sessions' and column_name='last_wake_at'");
  console.log('[2] last_wake_at 列 =', col.length ? '存在 ✓' : '缺失 ✗');

  // 3) 找一个有 api_key 的账号（冒烟直连身份）
  const ak = await query("select id, api_key from public.profiles where api_key <> '' limit 1");
  if (!ak.length) { console.log('[3] 无 api_key 账号（跳过直连冒烟）'); return; }
  const uid = ak[0].id;
  console.log('[3] 直连账号 =', uid.slice(0, 8) + '…', 'api_key =', ak[0].api_key.slice(0, 6) + '…');

  // 4) 预判命中：该账号 吸引/舒适/恋爱 会话 + 最后消息时间 + last_wake_at
  //    （memory_card 是 text 列 → 需 ::jsonb 转）
  const sessions = await query(
    "select id, friend_name, last_wake_at, memory_card::jsonb->'profile'->>'stage' as stage from public.chat_sessions where user_id = '" + uid + "' order by updated_at desc"
  );
  console.log('[4] 会话数 =', sessions.length);
  for (const s of sessions.slice(0, 8)) {
    const last = await query(
      "select max(created_at) as last_at from public.chat_messages where session_id = '" + s.id + "'"
    );
    const lastAt = last?.[0]?.last_at || null;
    const hours = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 3600e3 : null;
    console.log('   ', (s.friend_name || '?').padEnd(10), 'stage=' + (s.stage || '-'), '沉默=' + (hours === null ? '-' : hours.toFixed(1) + 'h'), 'last_wake_at=' + (s.last_wake_at ? '有' : '无'));
  }

  // 5) wake 模式调用（真实链路：认证 → 判定 → 命中则 LLM 生成 + 落库）
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: ak[0].api_key, mode: 'wake' })
  });
  const text = await resp.text();
  console.log('[5] wake 调用 HTTP', resp.status);
  const d = JSON.parse(text);
  console.log('   window =', d.window, '| disabled =', d.disabled);
  console.log('   wake 命中 =', d.wake.length, '条:', d.wake.map((w) => `${w.friend_name} → ${w.text}`).join(' | ') || '(空)');
  console.log('   skipped =', JSON.stringify(d.skipped));
}

main().catch((e) => { console.error('冒烟失败:', e.message); process.exit(1); });
