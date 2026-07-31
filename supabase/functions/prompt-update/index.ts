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
// 请求：POST  body: { system_prompt: string }
// 返回：{ success: true, system_prompt: string }
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
    const { system_prompt } = await req.json();
    if (typeof system_prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'system_prompt 必须为字符串' }), { headers, status: 400 });
    }
    if (system_prompt.length > 20000) {
      return new Response(JSON.stringify({ error: 'system_prompt 过长（上限 20000 字符）' }), { headers, status: 400 });
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

    // ---- 更新统一提示词（app_config 单行表，id=1，upsert 保证行存在）----
    const updateResp = await fetch(`${supabaseUrl}/rest/v1/app_config?id=eq.1`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        system_prompt: system_prompt,
        updated_by: user.id,
        updated_at: new Date().toISOString()
      })
    });

    if (!updateResp.ok) {
      console.error('prompt-update PATCH failed:', updateResp.status, await updateResp.text());
      return new Response(JSON.stringify({ error: '保存失败，请检查 app_config 表是否存在' }), { headers, status: 500 });
    }

    return new Response(JSON.stringify({
      success: true,
      system_prompt: system_prompt,
      message: '提示词已更新，所有用户下次发送消息时立即生效'
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('prompt-update error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});
