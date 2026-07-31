// ============================================================
// 军师 - 恋爱聊天指导工具 · 配置文件
// 使用前请复制为 config.js 并填写真实值
// ============================================================

window.APP_CONFIG = {
    // Supabase 项目配置（从 Supabase Dashboard -> Settings -> API 获取）
    supabase: {
        url: 'https://your-project-id.supabase.co',
        anonKey: 'your-anon-key-here'
    },

    // IMA 知识库配置
    ima: {
        // IMA API 代理的 Supabase Edge Function URL（部署后获取）
        proxyUrl: 'https://your-project-id.functions.supabase.co/ima-proxy',
        // 知识库 ID（在 IMA 开放平台创建知识库后获取）
        knowledgeBaseId: 'your-knowledge-base-id'
    },

    // [统一提示词管理] 后台提示词接口（Edge Function）
    // 前端用户不可见提示词内容，仅在发送消息时实时获取并随请求发送
    prompt: {
        // 获取统一提示词（登录用户可调，前端每次发送消息前调用）
        getUrl: 'https://your-project-id.functions.supabase.co/prompt-get',
        // 更新统一提示词（仅管理员可调，管理后台使用）
        updateUrl: 'https://your-project-id.functions.supabase.co/prompt-update'
    },

    // 激活码相关
    activation: {
        // 激活码验证 Edge Function URL
        verifyUrl: 'https://your-project-id.functions.supabase.co/activate-code'
    },

    // 发卡平台商品页链接
    store: {
        // 用户点击"购买"时跳转的 URL
        purchaseUrl: 'https://your-card-platform.com/product/xxx'
    },

    // 产品信息
    product: {
        name: '军师 - 聊天指导工具',
        freeTries: 50,
        price: 88, // 元/月
        priceDisplay: '88 元/月'
    }
};
