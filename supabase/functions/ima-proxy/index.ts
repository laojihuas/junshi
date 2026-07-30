// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理
//
// 功能：接收前端请求 → 校验用户状态 → 调用 IMA 知识库 API → 返回回复建议
//
// IMA API:
//   POST https://ima.qq.com/openapi/wiki/v1/search_knowledge
//   Headers: ima-openapi-clientid, ima-openapi-apikey
//
// 环境变量：
//   IMA_API_KEY, IMA_CLIENT_ID, IMA_KNOWLEDGE_BASE_ID, FREE_TRIES
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
    const { query, knowledge_base_id } = await req.json();
    const kbId = knowledge_base_id || Deno.env.get('IMA_KNOWLEDGE_BASE_ID') || '';

    if (!query || !query.trim()) {
      return new Response(JSON.stringify({ error: 'query 不能为空' }), { headers, status: 400 });
    }

    // 用户认证
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';

    // 验证用户
    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!authResp.ok) {
      return new Response(JSON.stringify({ error: '认证失败' }), { headers, status: 401 });
    }
    const user = await authResp.json();

    // 查询 profile
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=*`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey } }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0];

    if (!profile) {
      return new Response(JSON.stringify({ error: '用户不存在' }), { headers, status: 404 });
    }

    // 检查 VIP
    const isVip = profile.is_vip === true;
    let vipValid = isVip;
    if (isVip && profile.vip_expires_at) {
      vipValid = new Date(profile.vip_expires_at) > new Date();
      if (!vipValid) {
        // 降级
        await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${supabaseAnonKey}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_vip: false, vip_expires_at: null })
        });
      }
    }

    if (!vipValid) {
      const usageCount = profile.usage_count || 0;
      const freeTries = parseInt(Deno.env.get('FREE_TRIES') || '50');
      if (usageCount >= freeTries) {
        return new Response(JSON.stringify({
          error: 'free_trial_ended',
          message: `免费试用已用完（${freeTries}次），请升级 VIP`,
        }), { headers, status: 403 });
      }
    }

    // 调用 IMA API
    const imaKey = Deno.env.get('IMA_API_KEY') || '';
    const imaClientId = Deno.env.get('IMA_CLIENT_ID') || '';
    let reply = '';

    if (imaKey && imaClientId) {
      try {
        const imaResp = await fetch('https://ima.qq.com/openapi/wiki/v1/search_knowledge', {
          method: 'POST',
          headers: {
            'ima-openapi-clientid': imaClientId,
            'ima-openapi-apikey': imaKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: query.trim(),
            knowledge_base_id: kbId,
            cursor: '',
          }),
        });

        if (imaResp.ok) {
          const data = await imaResp.json();
          if (data?.code === 0 && data?.data?.info_list?.length > 0) {
            const items = data.data.info_list.slice(0, 3);
            reply = '根据知识库的资料，给你参考：\n\n';
            items.forEach((item: any, i: number) => {
              reply += `【建议 ${i+1}】${item.title}\n${item.highlight_content || ''}\n\n`;
            });
            reply += '结合实际情况灵活回应。';
          }
        }
      } catch (e) {
        console.error('IMA error:', e.message);
      }
    }

    // 降级回复
    if (!reply) {
      const fallbacks = [
        `关于"${query}"，建议你：\n1️⃣ 先认可对方的感受\n2️⃣ 表达你的真实想法\n3️⃣ 用开放性问题引导对话`,
        `针对"${query}"，可以这样回：\n"嗯嗯，我明白你的意思。有空可以多聊聊~"`,
        `回应"${query}"的思路：先表示理解 → 表达看法 → 反问对方。三步法最自然。`,
      ];
      reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    // 记录使用次数
    if (!vipValid) {
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${supabaseAnonKey}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_count: (profile.usage_count || 0) + 1 })
      });
    }

    return new Response(JSON.stringify({
      reply,
      usage_count: profile.usage_count + (vipValid ? 0 : 1),
      is_vip: vipValid,
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('Error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});
