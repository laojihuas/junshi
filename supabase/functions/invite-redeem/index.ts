// ============================================================
// 军师 - Supabase Edge Function: 邀请码兑现
//
// 功能：新用户注册成功后调用，校验邀请码 → 给邀请人 +50 次使用额度。
//       服务端用 service_role 处理（注册用户此时可能未确认邮箱、
//       未登录，不能依赖前端 token），并通过数据库函数 redeem_invite
//       原子完成"写邀请关系 + 加额度"。
//
// 请求：POST  body: { invite_code: string, invitee_id: string, invitee_email?: string }
// 返回：{ success: boolean, message: string, usage_count?: number }
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
    const { invite_code, invitee_id, invitee_email } = await req.json();
    if (!invite_code || typeof invite_code !== 'string') {
      return new Response(JSON.stringify({ success: false, message: '缺少邀请码' }), { headers, status: 400 });
    }
    if (!invitee_id) {
      return new Response(JSON.stringify({ success: false, message: '缺少用户信息' }), { headers, status: 400 });
    }

    const code = invite_code.trim().toUpperCase();
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const restHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    // ---- 根据邀请码找邀请人 ----
    const inviterResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?invite_code=eq.${encodeURIComponent(code)}&select=id`,
      { headers: restHeaders }
    );
    const inviterList = await inviterResp.json();
    const inviter = inviterList?.[0];

    if (!inviter) {
      return new Response(JSON.stringify({ success: false, message: '邀请码无效' }), { headers, status: 200 });
    }

    // ---- 调数据库函数原子兑现（写邀请关系 + 给邀请人 +50 次）----
    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/redeem_invite`, {
      method: 'POST',
      headers: restHeaders,
      body: JSON.stringify({
        p_inviter: inviter.id,
        p_invitee: invitee_id,
        p_invitee_email: invitee_email || null
      })
    });

    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      console.error('invite-redeem rpc failed:', rpcResp.status, errText);
      return new Response(JSON.stringify({ success: false, message: '兑换失败，请重试' }), { headers, status: 500 });
    }

    const result = await rpcResp.json();
    return new Response(JSON.stringify(result), { headers, status: 200 });

  } catch (error: any) {
    console.error('invite-redeem error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
