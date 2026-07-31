// ============================================================
// 军师 - Supabase Edge Function: 获取统一提示词
//
// 功能：读取系统统一的 system_prompt（app_config 表单行记录），
//       返回给前端。前端用户不可见提示词内容，仅在发送消息时
//       实时调用本接口获取并随 IMA 请求发送。
//
// 权限：任何已登录用户可调用（提示词本身不涉密，但需登录避免
//       被未授权外部直接抓取到提示词内容）。
//
// 请求：POST  body: {}（无需参数）
// 返回：{ system_prompt: string }
// ============================================================

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
    // ---- 用户认证（必须登录）----
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';

    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!authResp.ok) {
      return new Response(JSON.stringify({ error: '认证失败' }), { headers, status: 401 });
    }

    // ---- 读取统一提示词（app_config 单行表，id=1）----
    // 使用 service_role 读取（不受 RLS 限制，确保一定能读到配置）
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const configResp = await fetch(
      `${supabaseUrl}/rest/v1/app_config?id=eq.1&select=system_prompt,updated_at`,
      { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
    );

    let systemPrompt = '';
    if (configResp.ok) {
      const rows = await configResp.json();
      if (rows && rows.length > 0) {
        systemPrompt = rows[0].system_prompt || '';
      }
    }

    return new Response(JSON.stringify({ system_prompt: systemPrompt }), { headers, status: 200 });

  } catch (error: any) {
    console.error('prompt-get error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});
