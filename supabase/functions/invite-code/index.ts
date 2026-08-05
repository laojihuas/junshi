// ============================================================
// 军师 - Supabase Edge Function: 邀请码获取/生成（设备版）
//
// 功能：设备获取自己的邀请码；没有则生成 8 位唯一码（去 0/O/1/I）存 devices。
//   POST body: {}   设备标识：X-Device-Id 头
// 返回：{ success, invite_code, invite_url }
// ============================================================

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0 O 1 I
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    const deviceId = (req.headers.get('X-Device-Id') || '').trim();
    if (!deviceId || !DEVICE_RE.test(deviceId)) {
      return new Response(JSON.stringify({ success: false, message: '设备标识无效' }), { headers, status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const restHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    // 查已有邀请码
    const devResp = await fetch(
      `${supabaseUrl}/rest/v1/devices?device_id=eq.${encodeURIComponent(deviceId)}&select=invite_code`,
      { headers: restHeaders }
    );
    const devList = await devResp.json();
    const dev = Array.isArray(devList) ? devList[0] : null;

    let inviteCode = dev?.invite_code || '';

    // 没有则生成（查重，最多 10 次重试）
    if (!inviteCode) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = genCode();
        const dupResp = await fetch(
          `${supabaseUrl}/rest/v1/devices?invite_code=eq.${candidate}&select=device_id`,
          { headers: restHeaders }
        );
        const dup = await dupResp.json();
        if (!dup || dup.length === 0) {
          inviteCode = candidate;
          // 设备可能未注册（防御）：先确保行存在再写入邀请码
          await fetch(`${supabaseUrl}/rest/v1/devices`, {
            method: 'POST',
            headers: restHeaders,
            body: JSON.stringify({ device_id: deviceId, invite_code: inviteCode })
          }).catch(() => {});
          await fetch(`${supabaseUrl}/rest/v1/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
            method: 'PATCH',
            headers: restHeaders,
            body: JSON.stringify({ invite_code: inviteCode, updated_at: new Date().toISOString() })
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
