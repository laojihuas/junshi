// ============================================================
// 军师 - 恋爱聊天指导工具 · 配置文件
// ============================================================

window.APP_CONFIG = {
    // Supabase 项目配置
    supabase: {
        url: 'https://opzvvgixlfbfpdlsorbi.supabase.co',
        anonKey: 'sb_publishable_2TJBUFOXCXL-Kp-f_qbp6g_TIlbMmfC'
    },

    // 知识库代理（本地 kb_blocks 块级检索，Edge Function 纯本地查询）
    kb: {
        proxyUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/ima-proxy'
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

    // [v20260805 设备身份] 游客设备注册 / 配额状态（未注册用户专用）
    device: {
        gateUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/device-gate'
    },

    // [v20260805 账号体系] 注册 / 登录 / 会话（账号+密码，Supabase Auth 管理）
    account: {
        authUrl: 'https://opzvvgixlfbfpdlsorbi.supabase.co/functions/v1/account-auth'
    },

    // [邀请功能] 邀请好友得次数（注册时填邀请码自动兑现，无需 redeem 接口）
    invite: {
        // 站点地址：邀请链接前缀（留空自动使用当前域名）
        siteUrl: 'https://junshi-3nnr22y.maozi.io',
        // 单次邀请赠送次数
        rewardTries: 50
    },

    // 发卡平台商品页链接（酷发卡：军师包月卡，自动发货=卡密）
    store: {
        purchaseUrl: 'https://www.kufaka.com/item/fv0pn0'
    },

    // 产品信息
    product: {
        name: '军师 - 聊天指导工具',
        price: 68, // 元/月
        priceDisplay: '68 元/月'
    }
};