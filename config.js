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

    // 激活码相关
    activation: {
        verifyUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/activate-code'
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