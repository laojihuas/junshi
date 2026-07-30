// ============================================================
// 军师 - Supabase Edge Function: 激活码验证
//
// 功能：验证激活码 -> 标记已使用 -> 升级用户 VIP
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      headers,
      status: 405,
    });
  }

  try {
    const { code, user_id } = await req.json();

    if (!code || typeof code !== 'string') {
      return new Response(JSON.stringify({ success: false, message: '请输入激活码' }), {
        headers,
        status: 400,
      });
    }

    if (!user_id) {
      return new Response(JSON.stringify({ success: false, message: '未指定用户' }), {
        headers,
        status: 400,
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 查询激活码
    const { data: codeRecord, error: queryError } = await supabase
      .from('activation_codes')
      .select('*')
      .eq('code', code.trim().toUpperCase())
      .single();

    if (queryError || !codeRecord) {
      return new Response(JSON.stringify({ success: false, message: '无效的激活码' }), {
        headers,
        status: 200,
      });
    }

    if (codeRecord.used) {
      return new Response(JSON.stringify({ success: false, message: '该激活码已被使用' }), {
        headers,
        status: 200,
      });
    }

    // 激活码有效，开启事务处理
    // 1. 标记激活码已使用
    const { error: updateCodeError } = await supabase
      .from('activation_codes')
      .update({
        used: true,
        used_by: user_id,
        used_at: new Date().toISOString(),
      })
      .eq('id', codeRecord.id);

    if (updateCodeError) {
      console.error('[Activate Code] 标记激活码失败:', updateCodeError);
      return new Response(JSON.stringify({ success: false, message: '系统错误，请重试' }), {
        headers,
        status: 500,
      });
    }

    // 2. 更新用户 VIP 状态（30天）
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: updateUserError } = await supabase
      .from('profiles')
      .update({
        is_vip: true,
        vip_expires_at: expiresAt,
      })
      .eq('id', user_id);

    if (updateUserError) {
      console.error('[Activate Code] 升级用户失败:', updateUserError);
      // 回滚激活码标记（实际场景可考虑更严谨的事务）
      await supabase
        .from('activation_codes')
        .update({ used: false, used_by: null, used_at: null })
        .eq('id', codeRecord.id);

      return new Response(JSON.stringify({ success: false, message: '系统错误，请重试' }), {
        headers,
        status: 500,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: '🎉 激活成功！已升级为 VIP 会员',
      vip_expires_at: expiresAt,
    }), { headers, status: 200 });

  } catch (error) {
    console.error('[Activate Code] Error:', error.message);
    return new Response(JSON.stringify({
      success: false,
      message: '服务器内部错误',
    }), { headers, status: 500 });
  }
});
