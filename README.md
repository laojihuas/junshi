# 🧠 军师 - 恋爱聊天指导工具

基于 IMA 知识库的微信聊天指导助手。用户将聊天中对方的原话粘贴进来，由 AI（IMA 知识库）生成回复建议，一键复制后去微信回复。

## 核心特性

- **多窗口独立会话**：每个浏览器窗口/标签页拥有独立的对话上下文（Chat History），互不干扰；刷新页面会话保留，关闭窗口自动清除，复制标签页自动生成新会话。
- **统一提示词管理**：系统只使用一个统一的 system_prompt，管理员在后台可随时编辑；提示词对前端用户完全隐藏，修改后所有用户下次发送消息立即生效。

## 项目结构

```
junshi/
├── index.html                 # 主页面（SPA 单页应用）
├── config.example.js          # 配置文件模板（复制为 config.js 使用）
├── css/
│   └── style.css              # 微信风格样式（移动优先）
├── js/
│   ├── utils.js               # 工具函数（Toast、Loading）
│   ├── session.js             # [多窗口会话] 窗口级会话管理（sessionStorage）
│   ├── supabase.js            # Supabase 客户端 & 数据库操作
│   ├── auth.js                # 登录 / 注册模块
│   ├── friends.js             # 好友列表模块
│   ├── chat.js                # 聊天窗口模块（含统一提示词获取）
│   ├── paywall.js             # 付费墙模块
│   └── app.js                 # 主应用控制器
├── supabase/
│   ├── sql/
│   │   └── 001_app_config.sql # [统一提示词] app_config 建表脚本（需手动执行）
│   └── functions/
│       ├── ima-proxy/         # IMA API 代理 Edge Function（透传 history/system_prompt）
│       │   ├── index.ts
│       │   └── deno.json
│       ├── activate-code/     # 激活码验证 Edge Function
│       │   ├── index.ts
│       │   └── deno.json
│       ├── prompt-get/        # [统一提示词] 获取统一提示词接口
│       │   ├── index.ts
│       │   └── deno.json
│       └── prompt-update/     # [统一提示词] 更新统一提示词接口（仅管理员）
│           ├── index.ts
│           └── deno.json
├── admin/
│   └── index.html             # 管理后台（用户管理 + 激活码管理 + 提示词管理）
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
   - 再执行 `supabase/sql/001_app_config.sql` 创建统一提示词配置表（含默认提示词）

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

在 Supabase Dashboard → Edge Functions 中创建四个函数：

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

> 该函数会透传前端传来的 `history`（窗口对话历史）与 `system_prompt`（统一提示词）
> 给 IMA API；若 IMA 拒绝附加参数，会自动去掉参数重试，保证原有检索功能不受影响。

#### activate-code（激活码验证）

```bash
supabase functions deploy activate-code --project-ref your-project-ref
```

#### prompt-get（获取统一提示词）

```bash
supabase functions deploy prompt-get --project-ref your-project-ref
```

无需额外环境变量（自动注入 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`）。

- 请求：`POST`，body 可为 `{}`
- 认证：需登录用户（Authorization: Bearer <token>）
- 返回：`{ "system_prompt": "..." }`

#### prompt-update（更新统一提示词，仅管理员）

```bash
supabase functions deploy prompt-update --project-ref your-project-ref
```

- 请求：`POST`，body `{ "system_prompt": "新提示词" }`
- 认证：需管理员（服务端通过 service_role 校验 `profiles.is_admin = true`，不可伪造）
- 返回：`{ "success": true, "system_prompt": "..." }`

记录下四个函数的 URL，格式如：
- `https://your-project-ref.functions.supabase.co/ima-proxy`
- `https://your-project-ref.functions.supabase.co/activate-code`
- `https://your-project-ref.functions.supabase.co/prompt-get`
- `https://your-project-ref.functions.supabase.co/prompt-update`

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
    prompt: {
        getUrl: 'https://your-project.functions.supabase.co/prompt-get',
        updateUrl: 'https://your-project.functions.supabase.co/prompt-update'
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

| 表名 | 用途 |
|------|------|
| `profiles` | 用户扩展信息（使用次数、VIP 状态、设备指纹、is_admin） |
| `chat_sessions` | 聊天会话（好友列表） |
| `chat_messages` | 聊天消息记录（持久化，跨刷新/跨设备保留） |
| `activation_codes` | 激活码管理 |
| `app_config` | 统一提示词配置（单行表，id=1，存 system_prompt） |

---

## 五、多窗口独立会话 & 统一提示词（v20260731）

### 实现原理

**多窗口独立会话（前端 js/session.js）**

- 每个窗口/标签页打开应用时，在 `sessionStorage`（key: `junshi_window_session`）中
  生成唯一的窗口会话 ID（UUID）与对话历史。
- 通过 `performance.getEntriesByType('navigation')[0].type` 区分页面加载方式：
  - `reload` / `back_forward`（刷新、前进后退）→ **保留**当前窗口会话
  - `navigate`（首次打开、复制标签页、新标签页）→ **生成新会话 ID 并清空历史**
- 存储结构：`{ windowSessionId, conversations: { <好友ID>: history[] }, activeFriend }`
  —— 按好友隔离 AI 上下文，同一窗口内不同好友互不干扰。
- 关闭窗口 → sessionStorage 自动清除（浏览器特性）；退出登录 → 主动清空。
- 聊天消息的**持久化存储仍保留在数据库**（chat_messages），原有功能不变；
  窗口会话只决定**发给 IMA 的 AI 上下文（history）**。

**统一提示词管理（后台）**

- 提示词存于 `app_config` 表（单行），仅管理员可通过 `prompt-update` 修改，
  服务端用 service_role 校验 `profiles.is_admin`，前端无法伪造权限。
- 前端用户发送消息时：先调 `prompt-get` 获取最新统一提示词（每次实时获取，
  管理员修改后立即生效）→ 组合 `query + history + system_prompt` 调 ima-proxy →
  由 ima-proxy 透传给 IMA API。
- 提示词内容在前端**不存储、不渲染**，用户完全感知不到提示词的存在；
  管理后台在 `admin/index.html` 的"提示词管理"Tab 中编辑。

### 后台接口

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/functions/v1/prompt-get` | POST | 登录用户 | 获取统一提示词 `{ system_prompt }` |
| `/functions/v1/prompt-update` | POST | 仅管理员 | 更新统一提示词 `{ system_prompt }` |

---

## 六、注意事项

1. **API Key 安全**：IMA 的 API Key 通过 Supabase Edge Function 的环境变量设置，绝不暴露在前端
2. **发卡平台风险**：建议定期提现，长期应接入正规支付渠道
3. **合规声明**：页面底部建议添加"本工具仅为辅助建议，不代表专业意见"的免责声明
4. **数据备份**：Supabase 免费额度有限，建议定期导出用户数据

---

## 七、技术栈

- **前端**：纯 HTML + CSS + JavaScript（单页应用）
- **后端**：Supabase（数据库 + 认证 + Edge Functions）
- **API**：IMA 知识库 API
- **设备指纹**：FingerprintJS
- **部署**：帽子云（静态托管）
