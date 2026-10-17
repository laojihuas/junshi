// v243 补话冒烟：主线门控 + 两阶段 + 发送回执 + 退出清空排队
// 用法: SBP_PAT=xxx node smoke_followup2.mjs
//   只读 + 1~2 次真实生成（约 0.002 元），结束后清理干净，不留痕迹
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
    body: JSON.stringify({ query: sql }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('query failed: ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

async function callProxy(body) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ima-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, json, text: text.slice(0, 300) };
}

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

async function main() {
  // 1) 迁移
  const meta = await query(`
    select
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='chat_messages' and column_name='followup_sent') as sent_col,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='followup_purge_unsent') as purge_fn
  `);
  check('036 followup_sent 列存在', Number(meta[0]?.sent_col) === 1);
  check('036 followup_purge_unsent 存在', Number(meta[0]?.purge_fn) === 1);

  const acc = await query(`select id, api_key from public.profiles where api_key <> '' order by followup_online desc nulls last limit 1`);
  if (!acc.length) { console.log('无 api_key 账号，跳过'); return; }
  const uid = acc[0].id;
  const apiKey = acc[0].api_key;
  console.log('[账号]', uid.slice(0, 8) + '…');

  const base = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select count(*)::int from public.llm_usage_log) as llm_rows
  `);
  const fu0 = base[0].fu_rows, llm0 = base[0].llm_rows;
  console.log(`[基线] followup=${fu0} llm=${llm0}`);

  // 2) 主线不空闲 → 不介入
  const busy = await callProxy({ mode: 'followup', api_key: apiKey, online: true });
  check('不带 main_idle 返回 phase=wait_main', busy.json?.phase === 'wait_main', String(busy.json?.phase));
  check('main_idle=false 时 targets 为空', Array.isArray(busy.json?.targets) && busy.json.targets.length === 0);
  const afterBusy = await query(`select (select count(*)::int from public.llm_usage_log) as llm_rows`);
  check('主线忙时 0 token', afterBusy[0].llm_rows === llm0, `${llm0}→${afterBusy[0].llm_rows}`);

  // 3) 主线空闲 → 给目标
  const scan = await callProxy({ mode: 'followup', api_key: apiKey, online: true, main_idle: true });
  check('main_idle=true 返回 phase=scan', scan.json?.phase === 'scan', String(scan.json?.phase));
  const targets = Array.isArray(scan.json?.targets) ? scan.json.targets : [];
  console.log(`[扫描] 目标 ${targets.length} 个`);
  for (const t of targets.slice(0, 3)) {
    console.log(`   · ${t.search_key || t.friend_name} (等 ${t.waited_min} 分, 今日 ${t.used_today})`);
  }
  const afterScan = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select count(*)::int from public.llm_usage_log) as llm_rows
  `);
  check('扫描未落库', afterScan[0].fu_rows === fu0, `${fu0}→${afterScan[0].fu_rows}`);
  check('扫描未花 token', afterScan[0].llm_rows === llm0);

  if (!targets.length) {
    console.log('\n当前无候选目标，跳过生成/回执测试');
    console.log(failed ? `失败 ${failed} 项` : '\n全部通过');
    return;
  }
  const sid = targets[0].session_id;

  // 4) 生成
  const gen = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid });
  const one = Array.isArray(gen.json?.followup) ? gen.json.followup[0] : null;
  check('生成 1 条话术', !!one && !!one.text, one ? `「${one.text}」` : JSON.stringify(gen.json?.skipped));
  check('shape=延续（不预设策略）', one?.shape === '延续', String(one?.shape));
  if (one) {
    const NAG = /(在吗|在不在|怎么不回|怎么不理|忙完了吗|忙完没|看到没|看到了吗|回我|理我|生气|是不是不|又不回|等你)/;
    check('不含催句', !NAG.test(one.text));
    check('禁刚字开头', !/^刚/.test(one.text), one.text.slice(0, 6));
  }
  const afterGen = await query(`select followup_sent, count(*)::int as n from public.chat_messages where session_id='${sid}' and kind='followup' group by followup_sent`);
  check('落库 followup_sent=null（待确认）', afterGen.length === 1 && afterGen[0].followup_sent === null, JSON.stringify(afterGen));

  // 5) 失败撤回
  const fail = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid, action: 'fail' });
  check('action=fail 撤回成功', fail.json?.rolled_back === true, JSON.stringify(fail.json));
  const afterFail = await query(`select count(*)::int as n from public.chat_messages where session_id='${sid}' and kind='followup'`);
  check('撤回后该会话无 followup 行', afterFail[0].n === 0, String(afterFail[0].n));

  // 6) 再生成 + 发送成功回执
  const gen2 = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid });
  const two = Array.isArray(gen2.json?.followup) ? gen2.json.followup[0] : null;
  check('第二次生成成功', !!two?.text, two?.text || '');
  const sent = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid, action: 'sent' });
  check('action=sent 回执成功', sent.json?.confirmed === true, JSON.stringify(sent.json));
  const afterSent = await query(`select followup_sent from public.chat_messages where session_id='${sid}' and kind='followup'`);
  check('回执后 followup_sent=true', afterSent[0]?.followup_sent === true, JSON.stringify(afterSent));

  // 7) 已确认发出的不会被 fail 误删（防止发出去的话被当成失败撤回）
  const fail2 = await callProxy({ mode: 'followup', api_key: apiKey, session_id: sid, action: 'fail' });
  check('已发送的 followup 不被 fail 删除', fail2.json?.rolled_back === false, JSON.stringify(fail2.json));
  const stillThere = await query(`select count(*)::int as n from public.chat_messages where session_id='${sid}' and kind='followup'`);
  check('该行仍在', Number(stillThere[0].n) === 1, String(stillThere[0].n));

  // 8) 退出：下线 + 清空排队（这条已 sent，不该被清）
  const stop = await callProxy({ mode: 'followup', api_key: apiKey, action: 'stop' });
  check('action=stop 返回 stopped', stop.json?.stopped === true, JSON.stringify(stop.json));
  check('stop 返回 purged_unsent 字段', typeof stop.json?.purged_unsent === 'number', String(stop.json?.purged_unsent));
  const offline = await callProxy({ mode: 'followup', api_key: apiKey, main_idle: true });
  check('停止后轮询 offline:true', offline.json?.offline === true, JSON.stringify(offline.json));

  // 9) 收尾：清掉本次测试产生的行 + 恢复在线（直接写库，不触发补话）
  await query(`
    delete from public.chat_messages where session_id='${sid}' and kind='followup';
    update public.chat_sessions set followup_at = null where id='${sid}';
    update public.profiles set followup_online = true where id='${uid}';
  `);
  const fin = await query(`
    select
      (select count(*)::int from public.chat_messages where kind='followup') as fu_rows,
      (select followup_online from public.profiles where id='${uid}') as online
  `);
  check('测试痕迹已清理', fin[0].fu_rows === fu0, `${fu0}→${fin[0].fu_rows}`);
  check('已恢复 online=true', fin[0].online === true);

  console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });
