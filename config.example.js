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
