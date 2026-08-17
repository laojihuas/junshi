// ============================================================
// 军师 - Supabase Edge Function: 更新统一提示词（管理员）
//
// 功能：管理员修改系统统一的 system_prompt（app_config 表单行记录）。
//       修改后所有用户下一次发送消息时立即生效（前端每次发送前
//       实时调用 prompt-get 获取最新提示词）。
//
// 权限：仅管理员可调用 —— 服务端使用 service_role 校验
//       profiles.is_admin === true，不信任前端传入的任何权限标记。
//
// 请求：POST  body: { system_prompt?: string, llm_params?: object }
//   system_prompt 与 llm_params 至少提供一个（llm_params 为 LLM 生成参数：
//   [v77] 仅支持 thinking_mode——temperature/惩罚系数/max_tokens 已由 ima-proxy 六阶段联动表接管）
// 返回：{ success: true, system_prompt?: string, llm_params?: object }
// ============================================================

// [v10] 数值区间 或 字符串枚举（thinking_mode：off/low/high/max）
// [v77] 采样参数（temperature/惩罚系数/max_tokens）已由 ima-proxy 六阶段联动表接管，后台不再接收
// [v20260812] thinking_budget 思考链压缩三档（auto=高峰自动/on=始终压缩/off=不压缩）
// [v202 低配版] mode 版本档位（full=普通版/lite=低配版）
// [v206 WB版] mode 新增 wb=WB版（消息分诊+策略决策链路）
const LLM_PARAM_RANGE: Record<string, [number, number] | string[]> = {
  thinking_mode: ['off', 'low', 'high', 'max'],
  thinking_budget: ['auto', 'on', 'off'],
  mode: ['full', 'lite', 'wb'],
};

// [v20260812 配额参数搬后台] 允许的配额键 + 数值区间（v20260813：加 guest_daily；cap 允许 0=不封顶）
const QUOTA_PARAM_RANGE: Record<string, [number, number]> = {
  guest_daily: [1, 10000],        // 游客每日（默认 20）
  free_daily_tier1: [1, 10000],   // 注册用户 0-3 天（默认 50）
  free_daily_tier2: [1, 10000],   // 注册用户 3 天+（默认 20）
  free_daily_tier3: [1, 10000],   // 保留（不再使用，兼容后台旧值）
  vip_daily_limit: [1, 10000],    // 激活码日配额（默认 500）
  invite_bonus_each: [1, 1000],   // 邀请奖励每次（默认 50）
  invite_bonus_cap: [0, 10000],   // 邀请累计封顶（默认 0=不封顶）
};
function validateQuotaParams(v: any): string | null {
  if (typeof v !== 'object' || Array.isArray(v) || v === null) return 'quota_params 必须为 JSON 对象';
  for (const key of Object.keys(v)) {
    if (!(key in QUOTA_PARAM_RANGE)) return `不支持的配额参数: ${key}`;
    const [min, max] = QUOTA_PARAM_RANGE[key];
    const val = v[key];
    if (typeof val !== 'number' || !isFinite(val) || val < min || val > max) {
      return `${key} 必须为 ${min}~${max} 之间的整数`;
    }
    if (val !== Math.floor(val)) return `${key} 必须为整数`;
  }
  return null;
}

function validateLlmParams(v: any): string | null {
  if (typeof v !== 'object' || Array.isArray(v) || v === null) return 'llm_params 必须为 JSON 对象';
  for (const key of Object.keys(v)) {
    if (!(key in LLM_PARAM_RANGE)) return `不支持的参数: ${key}`;
    const val = v[key];
    const range = LLM_PARAM_RANGE[key];
    // 注意：数值区间 [min,max] 也是数组！用首元素类型区分：string → 枚举，number → 区间
    if (typeof range[0] === 'string') {
      // 枚举校验（字符串档位，如 thinking_mode）
      if (typeof val !== 'string' || !(range as string[]).includes(val)) {
        return `${key} 必须为 ${range.join(' / ')} 之一`;
      }
    } else {
      const [min, max] = range as [number, number];
      if (typeof val !== 'number' || !isFinite(val) || val < min || val > max) {
        return `${key} 必须为 ${min}~${max} 之间的数字`;
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    const body = await req.json();
    const { system_prompt, llm_params, quota_params } = body;
    if (typeof system_prompt !== 'string' && llm_params === undefined && quota_params === undefined) {
      return new Response(JSON.stringify({ error: '至少提供 system_prompt / llm_params / quota_params 之一' }), { headers, status: 400 });
    }
    if (typeof system_prompt === 'string' && system_prompt.length > 20000) {
      return new Response(JSON.stringify({ error: 'system_prompt 过长（上限 20000 字符）' }), { headers, status: 400 });
    }
    let llmParamsJson: string | null = null;
    if (llm_params !== undefined) {
      const err = validateLlmParams(llm_params);
      if (err) return new Response(JSON.stringify({ error: err }), { headers, status: 400 });
      llmParamsJson = JSON.stringify(llm_params);
    }
    // [v20260812 配额参数] 校验后整体写入 quota_params（与 llm_params 互不影响）
    let quotaParamsJson: string | null = null;
    if (quota_params !== undefined) {
      const err = validateQuotaParams(quota_params);
      if (err) return new Response(JSON.stringify({ error: err }), { headers, status: 400 });
      quotaParamsJson = JSON.stringify(quota_params);
    }

    // ---- 用户认证 ----
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!authResp.ok) {
      return new Response(JSON.stringify({ error: '认证失败' }), { headers, status: 401 });
    }
    const user = await authResp.json();

    // ---- 管理员校验（service_role 直查，绕过 RLS，绝对可信）----
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=is_admin`,
      { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0];

    if (!profile || profile.is_admin !== true) {
      return new Response(JSON.stringify({ error: '无权限：仅管理员可修改提示词' }), { headers, status: 403 });
    }

    // ---- 更新统一提示词 / LLM 参数（用 upsert POST + Prefer merge-duplicates）----
    // 用 upsert 而非 PATCH：因为 app_config 表是单行表，upsert 在主键冲突时
    // 自动走 update 路径；且 upsert 不受 PostgREST PATCH schema 缓存影响。
    const patchBody: any = {
      id: 1,
      updated_by: user.id,
      updated_at: new Date().toISOString()
    };
    if (typeof system_prompt === 'string') patchBody.system_prompt = system_prompt;
    if (llmParamsJson !== null) patchBody.llm_params = llmParamsJson;
    if (quotaParamsJson !== null) patchBody.quota_params = quotaParamsJson;

    const upsertResp = await fetch(`${supabaseUrl}/rest/v1/app_config`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(patchBody)
    });

    if (!upsertResp.ok) {
      const errText = await upsertResp.text();
      console.error('prompt-update upsert failed:', upsertResp.status, errText);
      // 返回真实错误供诊断（不向用户暴露太多细节）
      return new Response(JSON.stringify({
        error: `保存失败 [${upsertResp.status}]: ${errText.slice(0, 300)}`
      }), { headers, status: 500 });
    }

    const result: any = { success: true, message: '配置已更新，所有用户下次发送消息时立即生效' };
    if (typeof system_prompt === 'string') result.system_prompt = system_prompt;
    if (llmParamsJson !== null) result.llm_params = JSON.parse(llmParamsJson);
    return new Response(JSON.stringify(result), { headers, status: 200 });

  } catch (error: any) {
    console.error('prompt-update error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误: ' + (error.message || '未知') }), { headers, status: 500 });
  }
});