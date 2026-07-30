// ============================================================
// 军师 - Supabase Edge Function: 激活码验证
//
// 功能：验证激活码 → 标记已使用 → 升级用户 VIP
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
    const { code } = await req.json();
    if (!code || !code.trim()) {
      return new Response(JSON.stringify({ success: false, message: '请输入激活码' }), { headers, status: 400 });
    }

    // 获取用户信息
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!authResp.ok) {
      return new Response(JSON.stringify({ success: false, message: '请先登录' }), { headers, status: 401 });
    }
    const user = await authResp.json();

    // 用 service_role 查询激活码
    const codeUpper = code.trim().toUpperCase();
    const codeResp = await fetch(
      `${supabaseUrl}/rest/v1/activation_codes?code=eq.${encodeURIComponent(codeUpper)}&select=*`,
      { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
    );
    const codeList = await codeResp.json();
    const codeRecord = codeList?.[0];

    if (!codeRecord) {
      return new Response(JSON.stringify({ success: false, message: '无效的激活码' }), { headers, status: 200 });
    }
    if (codeRecord.used) {
      return new Response(JSON.stringify({ success: false, message: '该激活码已被使用' }), { headers, status: 200 });
    }

    // 标记激活码已使用
    await fetch(`${supabaseUrl}/rest/v1/activation_codes?id=eq.${codeRecord.id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ used: true, used_by: user.id, used_at: new Date().toISOString() })
    });

    // 升级 VIP（30天）
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_vip: true, vip_expires_at: expiresAt })
    });

    return new Response(JSON.stringify({
      success: true,
      message: '🎉 激活成功！已升级为 VIP 会员',
      vip_expires_at: expiresAt,
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('Activate error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
