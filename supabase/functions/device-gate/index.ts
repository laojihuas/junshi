// ============================================================
// 军师 - Supabase Edge Function: 设备注册 / 配额状态
//
// 功能：剔除登录后的设备身份入口。
//   POST { action:'register'|'status', device_id, invite_code?, user_id? }
//   register：新设备写 devices（同 IP 每日新设备 ≤5 防刷），
//             已存在设备直接返回状态；URL 邀请码暂存（首次建好友后兑现）
//   status：返回配额状态（顶部导航只展示邀请赠送次数 + VIP 剩余天数）
//
// 认证：匿名登录 JWT（Authorization: Bearer <token>）
// ============================================================

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
    const { action, device_id, invite_code, user_id } = await req.json();
    if (!action || (action !== 'register' && action !== 'status')) {
      return new Response(JSON.stringify({ success: false, message: '未知操作' }), { headers, status: 400 });
    }
    if (!device_id || !DEVICE_RE.test(device_id)) {
      return new Response(JSON.stringify({ success: false, message: '设备标识无效' }), { headers, status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!serviceRoleKey || !supabaseUrl) {
      return new Response(JSON.stringify({ success: false, message: '服务未配置' }), { headers, status: 500 });
    }

    // 匿名登录校验（拿 user.id 用于 ensure_profile 兜底外键）
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    let authUserId: string | null = null;
    if (token) {
      const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
      });
      if (authResp.ok) {
        const u = await authResp.json();
        authUserId = u?.id || null;
      }
    }
    // register 必须已匿名登录（register 需要建 profiles 行）
    if (action === 'register' && !authUserId) {
      return new Response(JSON.stringify({ success: false, message: '未登录，请重试' }), { headers, status: 401 });
    }

    const clientIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || '';
    const restHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    let rpcName: string;
    let rpcBody: Record<string, unknown>;
    if (action === 'register') {
      rpcName = 'register_device';
      rpcBody = {
        p_device_id: device_id,
        p_ip: clientIp,
        p_invite_code: (invite_code || '').toString().trim().toUpperCase() || null,
        p_user_id: authUserId
      };
    } else {
      rpcName = 'get_quota_status';
      rpcBody = { p_device_id: device_id };
    }

    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: restHeaders,
      body: JSON.stringify(rpcBody)
    });

    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      console.error('device-gate rpc failed:', rpcName, rpcResp.status, errText.slice(0, 300));
      return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
    }

    const result = await rpcResp.json();
    return new Response(JSON.stringify(result), { headers, status: 200 });

  } catch (error: any) {
    console.error('device-gate error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
