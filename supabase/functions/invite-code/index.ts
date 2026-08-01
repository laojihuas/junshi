// ============================================================
// 军师 - Supabase Edge Function: 邀请码获取/生成
//
// 功能：登录用户获取自己的邀请码；没有则生成一个 8 位唯一码
//       （去易混淆字符 0/O/1/I，大写字母+数字）并保存到 profiles。
//
// 请求：POST  body: {}
// 认证：需登录用户（Authorization: Bearer <token>）
// 返回：{ success, invite_code, invite_url }
// ============================================================

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0 O 1 I

function genCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
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
      return new Response(JSON.stringify({ success: false, message: '请先登录' }), { headers, status: 401 });
    }
    const user = await authResp.json();

    const restHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    // ---- 查已有邀请码 ----
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=invite_code`,
      { headers: restHeaders }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0];

    let inviteCode = profile?.invite_code;

    // ---- 没有则生成（查重，最多 10 次重试）----
    if (!inviteCode) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = genCode();
        const dupResp = await fetch(
          `${supabaseUrl}/rest/v1/profiles?invite_code=eq.${candidate}&select=id`,
          { headers: restHeaders }
        );
        const dup = await dupResp.json();
        if (!dup || dup.length === 0) {
          inviteCode = candidate;
          await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
            method: 'PATCH',
            headers: restHeaders,
            body: JSON.stringify({ invite_code: inviteCode })
          });
          break;
        }
      }
    }

    if (!inviteCode) {
      return new Response(JSON.stringify({ success: false, message: '邀请码生成失败，请重试' }), { headers, status: 500 });
    }

    return new Response(JSON.stringify({
      success: true,
      invite_code: inviteCode,
      invite_url: (Deno.env.get('SITE_URL') || '') + '?invite=' + inviteCode
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('invite-code error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
