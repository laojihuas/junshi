// ============================================================
// 军师 - Supabase Edge Function: 账号注册 / 登录 / 会话
//
// 功能：账号体系（v20260805 用户机制重构）。
//   游客（device 指纹）20 条/天用完 → 注册引导；
//   注册：账号+密码（账号=中文/英文/数字，密码由 Supabase Auth 管理，
//         email 伪装为 hex(账号名)@jssl.local，复用 RLS/会话，账号名不可见）
//   登录：任意设备可登录；同一时间仅一台设备在线（active_session 单点踢旧）
//   绑定：同一台设备（device_id）只能注册一个账号
//   迁移：注册时游客匿名 user 的好友/聊天自动转给账号
//   邀请：注册带邀请码 → 邀请人 +50（封顶 300，注册即兑现）
//
//   POST { action:'register'|'login'|'sync', ... }
//     register: { account_name, password, invite_code?, device_id }
//               Authorization: 游客匿名 JWT（取 p_guest_user_id 做数据迁移）
//     login:    { account_name, password }
//     sync:     { session_id }  + Authorization: 账号 JWT（校验单点会话有效性）
//
// 认证：注册/登录无需登录；sync 需要账号 JWT。
// ============================================================

const ACCOUNT_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{3,20}$/;

// 账号名 → 伪 email（hex 编码，唯一可逆；用户不可见）
function accountToEmail(name: string): string {
  let hex = '';
  for (const ch of name) {
    hex += ch.codePointAt(0)!.toString(16);
  }
  return hex + '@jssl.local';
}

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Session-Id',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    const body = await req.json();
    const action = body.action;
    if (!action || !['register', 'login', 'sync'].includes(action)) {
      return new Response(JSON.stringify({ success: false, message: '未知操作' }), { headers, status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!serviceRoleKey || !supabaseUrl) {
      return new Response(JSON.stringify({ success: false, message: '服务未配置' }), { headers, status: 500 });
    }

    const srHeaders = {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'apikey': serviceRoleKey,
      'Content-Type': 'application/json'
    };

    // ============ 注册 ============
    if (action === 'register') {
      // body 已在顶层解析，复用
      const accountName = (body.account_name || '').toString().trim();
      const password = (body.password || '').toString();
      const inviteCode = (body.invite_code || '').toString().trim().toUpperCase();
      const deviceId = (body.device_id || '').toString().trim();

      if (!ACCOUNT_RE.test(accountName)) {
        return new Response(JSON.stringify({ success: false, message: '账号需 3-20 位中文/英文/数字' }), { headers, status: 400 });
      }
      if (password.length < 6) {
        return new Response(JSON.stringify({ success: false, message: '密码至少 6 位' }), { headers, status: 400 });
      }
      if (!deviceId) {
        return new Response(JSON.stringify({ success: false, message: '设备初始化中，请重试' }), { headers, status: 400 });
      }

      // 游客匿名 user id（用于数据迁移；无则跳过）
      const authHeader = req.headers.get('Authorization') || '';
      const guestToken = authHeader.replace('Bearer ', '');
      let guestUserId: string | null = null;
      if (guestToken) {
        const gResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: { 'Authorization': `Bearer ${guestToken}`, 'apikey': supabaseAnonKey }
        });
        if (gResp.ok) {
          const g = await gResp.json();
          guestUserId = g?.id || null;
        }
      }

      const email = accountToEmail(accountName);

      // 1) 在 Supabase Auth 创建账号（email 伪装；账号名进 user_metadata）
      const createResp = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { account_name: accountName }
        })
      });
      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({}));
        // 邮箱冲突 = 账号已存在
        if (String(err.code || err.error_code || '').includes('already') || createResp.status === 422) {
          return new Response(JSON.stringify({ success: false, message: '该账号已被注册' }), { headers, status: 200 });
        }
        console.error('account-auth create user failed:', createResp.status, JSON.stringify(err).slice(0, 300));
        return new Response(JSON.stringify({ success: false, message: '注册失败，请稍后再试' }), { headers, status: 500 });
      }
      const created = await createResp.json();
      const accountUserId: string = created.id;

      // 2) 落账号元数据 + 邀请兑现 + 游客数据迁移
      const regResp = await fetch(`${supabaseUrl}/rest/v1/rpc/register_account`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({
          p_account_user_id: accountUserId,
          p_account_name: accountName,
          p_device_id: deviceId,
          p_invite_code: inviteCode || null,
          p_guest_user_id: guestUserId
        })
      });
      const reg = regResp.ok ? await regResp.json() : null;
      if (!reg || reg.success !== true) {
        // 注册失败（账号冲突/设备已注册）→ 回滚 Auth user，避免孤儿账号
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${accountUserId}`, {
          method: 'DELETE',
          headers: srHeaders
        });
        return new Response(JSON.stringify({ success: false, message: reg?.message || '注册失败' }), { headers, status: 200 });
      }

      // 3) 登录拿会话（signInWithPassword）
      const loginResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const session = loginResp.ok ? await loginResp.json() : null;
      if (!session || !session.access_token) {
        console.error('account-auth post-register login failed:', loginResp.status);
        return new Response(JSON.stringify({ success: false, message: '注册成功，请重新登录' }), { headers, status: 200 });
      }

      // 4) 生成会话 ID（单点）并落库
      const sessionId = crypto.randomUUID();
      await fetch(`${supabaseUrl}/rest/v1/rpc/login_account`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({ p_account_user_id: accountUserId, p_session_id: sessionId })
      });

      return new Response(JSON.stringify({
        success: true,
        message: '注册成功',
        session_id: sessionId,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user: session.user
        },
        account: {
          account_name: accountName,
          user_id: accountUserId,
          invite_code: reg.invite_code,
          inviter_rewarded: !!reg.inviter_rewarded
        }
      }), { headers, status: 200 });
    }

    // ============ 登录 ============
    if (action === 'login') {
      // body 已在顶层解析，复用
      const accountName = (body.account_name || '').toString().trim();
      const password = (body.password || '').toString();
      if (!accountName || !password) {
        return new Response(JSON.stringify({ success: false, message: '请输入账号和密码' }), { headers, status: 400 });
      }

      const email = accountToEmail(accountName);
      const loginResp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!loginResp.ok) {
        return new Response(JSON.stringify({ success: false, message: '账号或密码错误' }), { headers, status: 200 });
      }
      const session = await loginResp.json();
      const accountUserId: string = session.user?.id || '';

      // 会话 ID（单点）并落库
      const sessionId = crypto.randomUUID();
      let accountInfo: any = {};
      const infoResp = await fetch(`${supabaseUrl}/rest/v1/rpc/login_account`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({ p_account_user_id: accountUserId, p_session_id: sessionId })
      });
      if (infoResp.ok) accountInfo = await infoResp.json();

      return new Response(JSON.stringify({
        success: true,
        message: '登录成功',
        session_id: sessionId,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user: session.user
        },
        account: {
          account_name: accountName,
          user_id: accountUserId,
          invite_code: accountInfo.invite_code,
          invite_bonus: accountInfo.invite_bonus || 0,
          is_vip: !!accountInfo.is_vip,
          vip_expires_at: accountInfo.vip_expires_at || null
        }
      }), { headers, status: 200 });
    }

    // ============ 会话校验（单点踢旧检测）============
    if (action === 'sync') {
      // body 已在顶层解析，复用
      const sessionId = (body.session_id || '').toString();
      const authHeader = req.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token || !sessionId) {
        return new Response(JSON.stringify({ success: false, valid: false }), { headers, status: 200 });
      }
      // 从 JWT 解析账号 user id
      const uResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
      });
      if (!uResp.ok) {
        return new Response(JSON.stringify({ success: false, valid: false, reason: 'auth_failed' }), { headers, status: 200 });
      }
      const u = await uResp.json();
      const accountUserId: string = u?.id || '';
      if (!accountUserId) {
        return new Response(JSON.stringify({ success: false, valid: false, reason: 'auth_failed' }), { headers, status: 200 });
      }
      const chkResp = await fetch(`${supabaseUrl}/rest/v1/rpc/check_account_session`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({ p_account_user_id: accountUserId, p_session_id: sessionId })
      });
      const chk = chkResp.ok ? await chkResp.json() : { valid: false };
      if (chk.valid !== true) {
        return new Response(JSON.stringify({ success: false, valid: false, reason: chk.reason || 'session_expired' }), { headers, status: 200 });
      }
      // 有效会话：顺带返回账号状态（邀请余额/VIP 等，供顶部导航）
      let accountInfo: any = null;
      const infoResp = await fetch(`${supabaseUrl}/rest/v1/rpc/login_account`, {
        method: 'POST',
        headers: srHeaders,
        body: JSON.stringify({ p_account_user_id: accountUserId })
      });
      if (infoResp.ok) accountInfo = await infoResp.json();
      return new Response(JSON.stringify({ success: true, valid: true, account: accountInfo }), { headers, status: 200 });
    }

    return new Response(JSON.stringify({ success: false, message: '未知操作' }), { headers, status: 400 });
  } catch (error: any) {
    console.error('account-auth error:', error.message);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), { headers, status: 500 });
  }
});
