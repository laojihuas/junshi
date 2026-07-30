# 🧠 军师 - 恋爱聊天指导工具

基于 IMA 知识库的微信聊天指导助手。用户将聊天中对方的原话粘贴进来，由 AI（IMA 知识库）生成回复建议，一键复制后去微信回复。

## 项目结构

```
junshi/
├── index.html                 # 主页面（SPA 单页应用）
├── config.example.js          # 配置文件模板（复制为 config.js 使用）
├── css/
│   └── style.css              # 微信风格样式（移动优先）
├── js/
│   ├── utils.js               # 工具函数（Toast、Loading）
│   ├── supabase.js            # Supabase 客户端 & 数据库操作
│   ├── auth.js                # 登录 / 注册模块
│   ├── friends.js             # 好友列表模块
│   ├── chat.js                # 聊天窗口模块
│   ├── paywall.js             # 付费墙模块
│   └── app.js                 # 主应用控制器
├── supabase/
│   ├── schema.sql             # 数据库表结构 SQL
│   └── functions/
│       ├── ima-proxy/         # IMA API 代理 Edge Function
│       │   ├── index.ts
│       │   └── deno.json
│       └── activate-code/     # 激活码验证 Edge Function
│           ├── index.ts
│           └── deno.json
├── admin/
│   └── index.html             # 管理后台（用户管理 + 激活码管理）
└── README.md                  # 本文件
```

---

## 一、部署步骤

### 1. 注册与配置账号

| 服务 | 用途 | 注册链接 |
|------|------|----------|
| Supabase | 数据库 + 认证 + Edge Functions | https://supabase.com |
| 帽子云 | 前端静态托管 | https://maozi.cloud |
| IMA 开放平台 | 知识库 + API | https://openai.ima.qq.com |
| GitHub/Gitee | 代码版本管理 | https://github.com |

### 2. 配置 Supabase

1. **创建项目**
   - 在 Supabase 中创建新项目
   - 记录下 `Project URL` 和 `anon public key`（Settings → API）

2. **创建数据表**
   - 进入 Supabase SQL Editor
   - 复制 `supabase/schema.sql` 的全部内容并执行
   - 这会创建所有表、索引、触发器、RLS 策略

3. **设置管理员**
   - 手动在 `profiles` 表中为自己添加一个 `is_admin` 字段（boolean，设为 true）
   - 或在 Supabase Dashboard → SQL Editor 执行：
     ```sql
     ALTER TABLE public.profiles ADD COLUMN is_admin BOOLEAN DEFAULT false;
     UPDATE public.profiles SET is_admin = true WHERE email = '你的管理员邮箱';
     ```

### 3. 配置 IMA 知识库

1. 登录 IMA 开放平台，创建知识库并上传情感指导、聊天话术等资料
2. 获取 `Client ID`、`API Key` 和 `Knowledge Base ID`

### 4. 配置 Edge Functions

在 Supabase Dashboard → Edge Functions 中创建两个函数：

#### ima-proxy（IMA API 代理）

```bash
# 使用 Supabase CLI 部署
supabase functions deploy ima-proxy --project-ref your-project-ref

# 设置环境变量（Supabase Dashboard → Edge Functions → 对应函数 → Environment Variables）
IMA_API_KEY=your-ima-api-key
IMA_CLIENT_ID=your-ima-client-id
IMA_API_URL=https://openai.ima.qq.com/v1/knowledge-bases/{knowledge_base_id}/chat
FREE_TRIES=50
```

#### activate-code（激活码验证）

```bash
supabase functions deploy activate-code --project-ref your-project-ref
```

记录下两个函数的 URL，格式如：
- `https://your-project-ref.functions.supabase.co/ima-proxy`
- `https://your-project-ref.functions.supabase.co/activate-code`

### 5. 配置前端

1. 复制 `config.example.js` 为 `config.js`
2. 在 `config.js` 中填写真实配置：

```javascript
window.APP_CONFIG = {
    supabase: {
        url: 'https://your-project.supabase.co',
        anonKey: 'your-anon-key'
    },
    ima: {
        proxyUrl: 'https://your-project.functions.supabase.co/ima-proxy',
        knowledgeBaseId: 'your-knowledge-base-id'
    },
    activation: {
        verifyUrl: 'https://your-project.functions.supabase.co/activate-code'
    },
    store: {
        purchaseUrl: 'https://your-card-platform.com/product/xxx'
    },
    product: {
        name: '军师 - 聊天指导工具',
        freeTries: 50,
        price: 88,
        priceDisplay: '88 元/月'
    }
};
```

### 6. 部署前端到帽子云

1. 将项目推送到 GitHub 仓库
2. 登录帽子云，关联 GitHub 仓库
3. 配置部署目录为根目录 `/`
4. 自动部署完成，获得访问链接

---

## 二、付费闭环设置

### 发卡平台接入

1. 在 [链动小铺] 或类似平台注册商家账号
2. 创建商品：
   - 商品名称：军师 聊天指导工具 - 月度会员
   - 价格：99 元（含平台手续费）
   - 卡密类型：一次性激活码
3. 在管理后台生成一批激活码：
   - 访问 `admin/index.html`，登录后进入"激活码管理"Tab
   - 点击"批量生成"，然后导出为 CSV
4. 将 CSV 中的激活码导入发卡平台商品库
5. 获取商品页 URL，填入 `config.js` 的 `store.purchaseUrl`

### 付费流程

```
用户点击购买 → 跳转发卡平台 → 扫码支付 → 获得激活码
    → 回到工具输入激活码 → 验证通过 → 升级 VIP（30天）
```

---

## 三、本地开发

```bash
# 使用任意静态服务器
npx serve .

# 或 Python
python -m http.server 8080
```

然后浏览器打开 `http://localhost:8080` 即可。

> 注意：本地开发时，IMA API 代理未配置时会自动使用模拟回复。

---

## 四、数据表说明

| 表��� | 用途 |
|------|------|
| `profiles` | 用户扩展信息（使用次数、VIP 状态、设备指纹） |
| `chat_sessions` | 聊天会话（好友列表） |
| `chat_messages` | 聊天消息记录 |
| `activation_codes` | 激活码管理 |

---

## 五、注意事项

1. **API Key 安全**：IMA 的 API Key 通过 Supabase Edge Function 的环境变量设置，绝不暴露在前端
2. **发卡平台风险**：建议定期提现，长期应接入正规支付渠道
3. **合规声明**：页面底部建议添加"本工具仅为辅助建议，不代表专业意见"的免责声明
4. **数据备份**：Supabase 免费额度有限，建议定期导出用户数据

---

## 六、技术栈

- **前端**：纯 HTML + CSS + JavaScript（单页应用）
- **后端**：Supabase（数据库 + 认证 + Edge Functions）
- **API**：IMA 知识库 API
- **设备指纹**：FingerprintJS
- **部署**：帽子云（静态托管）
