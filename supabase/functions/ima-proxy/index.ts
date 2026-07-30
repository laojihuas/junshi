// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理
//
// 功能：接收前端请求 → 校验用户状态 → 调用 IMA 知识库 API → 返回回复建议
//
// IMA API 格式（基于 ima-skill 文档）：
//   POST https://ima.qq.com/openapi/wiki/v1/search_knowledge
//   Headers: ima-openapi-clientid, ima-openapi-apikey, Content-Type
//
// 环境变量（通过 Supabase Dashboard 设置）：
//   IMA_API_KEY            - IMA OpenAPI Key
//   IMA_CLIENT_ID          - IMA Client ID
//   IMA_KNOWLEDGE_BASE_ID  - 知识库 ID
//   FREE_TRIES             - 免费试用次数（默认 50）
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// IMA 配置（从 Supabase Secrets 读取，不暴露到前端）
const IMA_API_KEY = Deno.env.get('IMA_API_KEY') || '';
const IMA_CLIENT_ID = Deno.env.get('IMA_CLIENT_ID') || '';
const IMA_KB_ID = Deno.env.get('IMA_KNOWLEDGE_BASE_ID') || '';
const FREE_TRIES = parseInt(Deno.env.get('FREE_TRIES') || '50');

// IMA API 地址
const IMA_BASE_URL = 'https://ima.qq.com';
const IMA_SEARCH_PATH = '/openapi/wiki/v1/search_knowledge';

serve(async (req) => {
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

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    // ---- 1. 解析请求 ----
    const { query, knowledge_base_id } = await req.json();
    const kbId = knowledge_base_id || IMA_KB_ID;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'query 参数不能为空' }), { headers, status: 400 });
    }

    // ---- 2. 用户认证 ----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: '未授权' }), { headers, status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: '认证失败' }), { headers, status: 401 });
    }

    // ---- 3. 读取用户 profile ----
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return new Response(JSON.stringify({ error: '用户不存在' }), { headers, status: 404 });
    }

    // ---- 4. 检查使用权限 ----
    const isVip = profile.is_vip === true;
    let vipValid = isVip;

    if (isVip && profile.vip_expires_at) {
      vipValid = new Date(profile.vip_expires_at) > new Date();
      if (!vipValid) {
        await supabase.from('profiles').update({ is_vip: false, vip_expires_at: null }).eq('id', user.id);
      }
    }

    if (!vipValid) {
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

    // ---- 5. 调用 IMA 知识库搜索 ----
    let reply = '';
    let imaAvailable = !!(IMA_API_KEY && IMA_CLIENT_ID);

    if (imaAvailable) {
      try {
        // 构建 IMA 搜索请求
        const searchUrl = `${IMA_BASE_URL}${IMA_SEARCH_PATH}`;
        const searchBody = {
          query: query.trim(),
          knowledge_base_id: kbId,
          cursor: '',
        };

        console.log(`[IMA] 调用知识库搜索: kb=${kbId}, query="${query.substring(0, 50)}..."`);

        const imaResp = await fetch(searchUrl, {
          method: 'POST',
          headers: {
            'ima-openapi-clientid': IMA_CLIENT_ID,
            'ima-openapi-apikey': IMA_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(searchBody),
        });

        const respText = await imaResp.text();

        if (imaResp.ok) {
          const data = JSON.parse(respText);
          if (data.code === 0 && data.data && data.data.info_list && data.data.info_list.length > 0) {
            // 整理知识库搜索结果为回复建议
            const results = data.data.info_list.slice(0, 3); // 取前 3 条
            reply = `根据知识库中的资料，给你以下建议：\n\n`;
            results.forEach((item: any, idx: number) => {
              reply += `【建议 ${idx + 1}】${item.title}\n`;
              if (item.highlight_content) {
                reply += `${item.highlight_content}\n`;
              }
              reply += '\n';
            });
            reply += `你可以参考以上内容，结合实际情况回复对方。`;
          } else {
            // 知识库搜索结果为空，降级
            console.log('[IMA] 知识库搜索无结果:', respText.substring(0, 200));
            reply = fallbackReply(query);
          }
        } else {
          console.error(`[IMA] API 错误 ${imaResp.status}: ${respText.substring(0, 200)}`);
          reply = fallbackReply(query);
        }
      } catch (e: any) {
        console.error('[IMA] 调用失败:', e.message);
        reply = fallbackReply(query);
      }
    } else {
      // IMA 未配置，使用模拟回复
      reply = fallbackReply(query);
    }

    // ---- 6. 记录使用次数（非VIP） ----
    if (!vipValid) {
      await supabase
        .from('profiles')
        .update({ usage_count: (profile.usage_count || 0) + 1 })
        .eq('id', user.id);
    }

    return new Response(JSON.stringify({
      reply,
      usage_count: profile.usage_count + (vipValid ? 0 : 1),
      is_vip: vipValid,
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('[IMA Proxy] 严重错误:', error.message);
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: '服务器内部错误，请稍后重试',
    }), { headers, status: 500 });
  }
});

// 降级回复模板（IMA 不可用时使用）
function fallbackReply(query: string): string {
  const replies = [
    `关于"${query}"，建议你先冷静分析一下对方的意图。可以从对方最近几条消息的整体情绪来判断，不要只看单句。\n\n推荐回复思路：\n1️⃣ 先认可对方的感受\n2️⃣ 表达你的真实想法\n3️⃣ 用一个开放性问题引导对话继续`,
    `针对"${query}"的情况，我建议这样回复：\n\n"嗯嗯，我明白你的意思。其实我最近也在想类似的事情，有空可以多聊聊~"\n\n这样既表达了理解，又为后续对话埋下了伏笔。`,
    `你可以这样回应"${query}"：\n\n"你说的这个角度很有意思，我之前都没想过。那你觉得……（追问一个开放性问题）"\n\n展示好奇心和认同感，能有效拉近距离。`,
    `关于"${query}"，我的建议：\n\n先表示理解 → 再表达自己的看法 → 最后反问对方的想法。\n这个「共情-表达-引导」三步法是最自然的聊天节奏。`,
    `对于"${query}"，可以考虑这样回：\n\n"哈哈哈，你这么说让我想起一件事…（分享一个相关的有趣经历）"\n\n用故事回应故事，能让对话更有温度。`,
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}
