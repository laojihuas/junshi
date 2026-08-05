// ============================================================
// 军师 - Supabase Edge Function: 邀请码兑现（设备版）
//
// 功能：被邀请设备"首次新建好友成功"后调用（前端控制时机）。
//   校验邀请码 → 给邀请人 +50 次（封顶 300，超出不计）→ 绑定邀请关系。
//   POST body: { invite_code, device_id }
// 返回：{ success, message, bonus? }
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
    const { invite_code, device_id } = await req.json();
    if (!invite_code || typeof invite_code !== 'string') {
      return new Response(JSON.stringify({ success: false, message: '缺少邀请码' }), { headers, status: 400 });
    }
    if (!device_id || !DEVICE_RE.test(device_id)) {
      return new Response(JSON.stringify({ success: false, message: '设备标识无效' }), { headers, status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const restHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    // 调数据库函数原子兑现（写邀请关系 + 邀请人 +50，封顶 300）
    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/redeem_invite_device`, {
      method: 'POST',
      headers: restHeaders,
      body: JSON.stringify({
        p_invitee_device_id: device_id,
        p_invite_code: invite_code.trim().toUpperCase()
      })
    });

    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      console.error('invite-redeem rpc failed:', rpcResp.status, errText.slice(0, 300));
      return new Response(JSON.stringify({ success: false, message: '兑换失败，请重试' }), { headers, status: 500 });
    }

    const result = await rpcResp.json();
    return new Response(JSON.stringify(result), { headers, status: 200 });

  } catch (error: any) {
    console.error('invite-redeem error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
