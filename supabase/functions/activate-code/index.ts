// ============================================================
// 军师 - Supabase Edge Function: 激活码验证（设备绑定版）
//
// 功能：验证激活码 → 绑定设备指纹（devices.is_vip=true, +30 天）
//   POST body: { code }
//   设备标识：X-Device-Id 头（前端每次请求携带指纹）
// 返回：{ success, message, vip_expires_at, vip_days_left }
// ============================================================

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
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

    const deviceId = (req.headers.get('X-Device-Id') || '').trim();
    if (!deviceId || !DEVICE_RE.test(deviceId)) {
      return new Response(JSON.stringify({ success: false, message: '设备标识无效' }), { headers, status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    // 调数据库函数原子激活（绑设备指纹）
    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/activate_device`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_device_id: deviceId, p_code: code.trim().toUpperCase() })
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
