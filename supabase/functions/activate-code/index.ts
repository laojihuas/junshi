// ============================================================
// 军师 - Supabase Edge Function: 激活码验证（账号绑定版）
//
// [v20260805 用户机制重构] 激活码只服务注册用户（绑账号，68元/月 500条/天×30天）。
//   POST body: { code }
//   认证：Authorization: Bearer <账号 JWT>（解析 user id → 账号）
// 返回：{ success, message, vip_expires_at, vip_days_left }
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!serviceRoleKey || !supabaseUrl) {
      return new Response(JSON.stringify({ success: false, message: '服务未配置' }), { headers, status: 500 });
    }

    // 账号 JWT → user id
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ success: false, message: '请先登录' }), { headers, status: 401 });
    }
    const uResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!uResp.ok) {
      return new Response(JSON.stringify({ success: false, message: '登录已失效，请重新登录' }), { headers, status: 401 });
    }
    const u = await uResp.json();
    const accountUserId: string = u?.id || '';
    if (!accountUserId) {
      return new Response(JSON.stringify({ success: false, message: '登录已失效，请重新登录' }), { headers, status: 401 });
    }

    // 调数据库函数原子激活（绑账号）
    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/activate_account`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_account_user_id: accountUserId, p_code: code.trim().toUpperCase() })
    });

    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      console.error('activate rpc failed:', rpcResp.status, errText.slice(0, 300));
      return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
    }

    const result = await rpcResp.json();
    return new Response(JSON.stringify(result), { headers, status: 200 });

  } catch (error: any) {
    console.error('Activate error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
