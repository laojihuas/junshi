// ============================================================
// 军师 - 恋爱聊天指导工具 · 配置文件
// ============================================================

window.APP_CONFIG = {
    // Supabase 项目配置
    supabase: {
        url: 'https://opzvvgixlfbfpdlsorbi.supabase.co',
        anonKey: 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC'
    },

    // IMA 知识库配置
    ima: {
        // IMA API 代理的 Supabase Edge Function URL（部署后填入）
        proxyUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/ima-proxy',
        // 知识库 ID（在 IMA 开放平台创建知识库后填入）
        knowledgeBaseId: 'nIUQTuLN18QIpfhpUKzd1iziyTgw0-Bj81KAUl31VFI='
    },

    // [统一提示词管理] 后台提示词接口（Edge Function）
    // 前端用户不可见提示词内容，仅在发送消息时实时获取并随请求发送
    prompt: {
        // 获取统一提示词（登录用户可调，前端每次发送消息前调用）
        getUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/prompt-get',
        // 更新统一提示词（仅管理员可调，管理后台使用）
        updateUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/prompt-update'
    },

    // 激活码相关
    activation: {
        verifyUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/activate-code'
    },

    // [邀请功能] 邀请好友得次数
    invite: {
        // 获取/生成我的邀请码（登录用户）
        getUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/invite-code',
        // 兑现邀请（注册成功后调用，给邀请人 +50 次）
        redeemUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/invite-redeem',
        // 站点地址：邀请链接前缀（如 https://junshi-3nnr22y.maozi.io；留空自动使用当前域名）
        siteUrl: 'https://junshi-3nnr22y.maozi.io',
        // 单次邀请赠送次数
        rewardTries: 50
    },

    // 发卡平台商品页链接
    store: {
        purchaseUrl: 'https://your-card-platform.com/product/junshi'
    },

    // 产品信息
    product: {
        name: '军师 - 聊天指导工具',
        freeTries: 50,
        price: 88, // 元/月
        priceDisplay: '88 元/月'
    }
};