// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理
// 
// 功能：接收前端请求 -> 校验用户状态 -> 调用 IMA API -> 返回结果
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// IMA 配置（通过 Supabase Secrets 设置）
const IMA_API_KEY = Deno.env.get('IMA_API_KEY') || '';
const IMA_CLIENT_ID = Deno.env.get('IMA_CLIENT_ID') || '';
const IMA_API_URL = Deno.env.get('IMA_API_URL') || 'https://openai.ima.qq.com/v1/knowledge-bases/{knowledge_base_id}/chat';
const FREE_TRIES = parseInt(Deno.env.get('FREE_TRIES') || '50');

serve(async (req) => {
  // CORS 头
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  // 仅接受 POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      headers,
      status: 405,
    });
  }

  try {
    // ---- 解析请求体 ----
    const { query, knowledge_base_id } = await req.json();

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'query 参数不能为空' }), {
        headers,
        status: 400,
      });
    }

    // ---- 用户认证与校验 ----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: '未授权' }), {
        headers,
        status: 401,
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // 创建 Supabase 客户端（使用 Service Role Key 以绕过 RLS）
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 验证用户 token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: '认证失败' }), {
        headers,
        status: 401,
      });
    }

    // 获取用户 profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return new Response(JSON.stringify({ error: '用户不存在' }), {
        headers,
        status: 404,
      });
    }

    // ---- 检查使用权限 ----
    const isVip = profile.is_vip === true;
    let vipValid = isVip;

    if (isVip && profile.vip_expires_at) {
      vipValid = new Date(profile.vip_expires_at) > new Date();
      if (!vipValid) {
        // VIP 已过期，自动降级
        await supabase
          .from('profiles')
          .update({ is_vip: false, vip_expires_at: null })
          .eq('id', user.id);
      }
    }

    if (!vipValid) {
      // 检查免费次数
      const usageCount = profile.usage_count || 0;
      if (usageCount >= FREE_TRIES) {
        return new Response(JSON.stringify({
          error: 'free_trial_ended',
          message: `免费试用已用完（${FREE_TRIES}次），请升级 VIP`,
          usage_count: usageCount,
          free_tries: FREE_TRIES,
        }), { headers, status: 403 });
      }
    }

    // ---- 调用 IMA API ----
    if (!IMA_API_KEY || !IMA_CLIENT_ID) {
      // 开发模式：返回模拟回复
      const mockReplies = [
        `关于"${query}"，建议你可以这样回复：\n\n先表示理解对方的感受，然后表达你的真实看法，最后反问对方看法。这样的三步法最自然。`,
        `针对"${query}"的情况，建议回复：\n\n"嗯嗯，我明白你的意思。其实我最近也在想类似的事情，有空可以多聊聊~"`,
        `你可以这样回应"${query}"：\n\n"你说的这个角度很有意思，我之前都没想过。那你觉得……"展示好奇心和认同感。`
      ];
      const mockReply = mockReplies[Math.floor(Math.random() * mockReplies.length)];

      // 增加使用次数（非VIP）
      if (!vipValid) {
        await supabase
          .from('profiles')
          .update({ usage_count: (profile.usage_count || 0) + 1 })
          .eq('id', user.id);
      }

      return new Response(JSON.stringify({
        reply: mockReply,
        usage_count: profile.usage_count + (vipValid ? 0 : 1),
        is_vip: vipValid,
      }), { headers, status: 200 });
    }

    // ---- 真实 IMA API 调用 ----
    const imaUrl = IMA_API_URL.replace('{knowledge_base_id}', knowledge_base_id || '');

    const imaResponse = await fetch(imaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': IMA_CLIENT_ID,
        'Authorization': `Bearer ${IMA_API_KEY}`,
      },
      body: JSON.stringify({
        query: query.trim(),
        knowledge_base_id: knowledge_base_id,
      }),
    });

    if (!imaResponse.ok) {
      const errText = await imaResponse.text();
      console.error(`[IMA Proxy] IMA API error: ${imaResponse.status} - ${errText}`);
      throw new Error(`IMA API returned ${imaResponse.status}`);
    }

    const imaData = await imaResponse.json();
    const reply = imaData.reply || imaData.answer || imaData.response || imaData.text || JSON.stringify(imaData);

    // 增加使用次数（非VIP）
    if (!vipValid) {
      await supabase
        .from('profiles')
        .update({ usage_count: (profile.usage_count || 0) + 1 })
        .eq('id', user.id);
    }

    return new Response(JSON.stringify({
      reply: reply,
      usage_count: profile.usage_count + (vipValid ? 0 : 1),
      is_vip: vipValid,
    }), { headers, status: 200 });

  } catch (error) {
    console.error('[IMA Proxy] Error:', error.message);
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: '服务器内部错误，请稍后重试',
    }), { headers, status: 500 });
  }
});
