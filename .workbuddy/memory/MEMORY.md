# 军师 (junshi) 项目长期记忆

## 项目约定（必须遵守）

- **GitHub 仓库为公开仓库**（`github.com/laojihuas/junshi`，默认分支 master）
- **`.workbuddy/memory/` 会随 git 推送**，任何日志中**严禁写入敏感凭证**（IMA Key / Supabase token / service_role / PAT / 密码），只写存储位置或占位符 `<sbp_pat>`
- 前端部署：帽子云（maozi.cloud）关联 GitHub 自动部署，push 后需等待构建生效

## 部署架构

- **前端**：静态 SPA（帽子云），配置 `config.js`（git 跟踪，含 Supabase anon key / kb proxyUrl / device.gateUrl / **account.authUrl**）
- **后端**：Supabase（ref `opzvvgixlfbfpdlsorbi`）
  - Edge Functions：`ima-proxy`（核心，**vB 本地块级检索**，v62 双身份配额）、**`account-auth`（v4，verify_jwt=false！注册/登录/sync）**、`device-gate`（**游客专用** v4）、`activate-code`（**绑账号** v15）、`prompt-get`、`prompt-update`（旧 `invite-code`/`invite-redeem` **已删除**，邀请注册即兑现）
  - 数据表：`profiles` / `chat_sessions`（note、memory_card text）/ `chat_messages` / `activation_codes`（+used_account_id）/ `app_config`（单行 id=1：统一 system_prompt + llm_params JSON）/ **`accounts`（账号，id=auth user id）/ `devices`（游客指纹）/ `daily_quota`（**identity_type+identity_key** 双轨）/ `ip_usage`（ip+day，含 new_devices）**
  - **kb_blocks**（B 方案，15,107 块）：media_id+block_idx PK，content≤700 字，bigrams GIN 索引，RLS service_role 专用
  - SQL：`supabase/sql/001~015`（006 kb_docs 旧版、007 kb_blocks、008 配额设备体系、009 admin_stats、**010 设备召回**、**011 账号体系**、012 stage 改名、013 幽灵清理、014 feedback、**015 admin_generate_codes 激活码生成**）
  - 配额函数（SECURITY DEFINER，仅 service_role 调）：`register_device`（游客，IP 新设备≤5/天，固定 20/天）、`check_and_consume_quota(identity_type,identity_key,ip)`（双身份原子扣次）、`register_account`（账号唯一+设备唯一+邀请兑现+游客数据迁移）、`login_account`（active_session 单点）、`check_account_session`、`activate_account`（绑账号+30天）、`get_quota_status`、`ensure_profile`
  - 管理 RPC（SECURITY DEFINER + profiles.is_admin 校验，后台走 RPC 规避 RLS 直查）：`admin_stats` / `admin_feedback_list` / `admin_feedback_mark` / `cleanup_ghost_devices` / **`admin_generate_codes(p_count)`（生成激活码，16 位 XXXX-XXXX-XXXX-XXXX，撞码跳过）**
- **认证（v20260805 用户机制重构）**：**游客+账号双轨**。游客=Supabase 匿名登录+device 指纹（20/天，用完→注册引导）；注册用户=账号+密码（**Supabase Auth 管理，email 伪装 hex(账号名)@jssl.local**，RLS/会话全复用；账号名存 user_metadata + accounts 表）。一机一号（accounts.device_id unique）；任意设备可登录但**同一时间仅一台在线**（登录生成 session_id 存 active_session，ima-proxy 每次校验，旧设备 401 session_expired→前端登出）。注册时游客 chat_sessions.user_id 自动迁移到账号
- **设备指纹双持久化（v20260805 方案A）**：`_getDeviceId` 读取顺序 **Cookie → localStorage → FingerprintJS/fallback**，生成后 Cookie+localStorage 双写（Cookie 90 天滚动续期）。**清浏览器缓存不再丢身份**（Cookie 默认不清）；FingerprintJS 走 jsdelivr CDN 时好时坏，fallback 是漂移根源
- **设备召回（v20260805 方案C 兜底式，010_device_recall.sql）**：fallback 设备天然带 `fp_` 前缀 → register_device 遇 fp_ 新设备按多信号召回 30 天内老设备（同 last_ip + 同 fp_ua(服务端算 UA 哈希) + 同 fp_screen + 同 fp_tz + 同 fp_lang），命中返回 recalled+recalled_device_id **不写新行**，前端换用老 ID 双写持久化；正常指纹路径零影响。**register_device 签名已变（+4 指纹参数，旧签名 DROP）**；device-gate v4 透传指纹特征
- **配额规则（v20260805 重构后）**：①**游客固定 20 条/天**（Asia/Shanghai 自然日清零），用完→注册引导 ②**注册用户前 3 天 50/天、之后 20/天**，用完→付费墙 ③邀请 +50/人封顶 300（**好友注册成功即兑现**，先扣免费档再扣 bonus）④激活码 68元/月 500条/天×30天（绑账号）；**VIP 豁免 IP 防刷；IP 150次/天仅游客生效**（注册用户豁免防公司/宿舍误伤）
- **受限文案（chat.js _handleQuotaBlock）**：guest_quota_exhausted→注册引导弹窗；quota_exhausted→付费墙；session_expired→"账号已在其他设备登录"+登出；vip_daily_limit→"服务过载请明天再试"；ip_limit/ip_new_device_limit→"使用太频繁"；**顶部导航（friends.js）账号模式显示邀请赠送/VIP 剩余天数，游客不显示**；免费档/IP上限/VIP500 均不告知用户
- **知识库（B 方案完全本地化）**：**IMA 已彻底移除**（secrets 已删，代码零引用）。本地切块源仅 `C:\迷男\恋爱话术\`（**2026-08-06 恋爱教学/聊天实战 已删库且不再上传**，干扰检索；kb_blocks 现 739 块全为话术；如未来恢复：把目录加回 build_kb_blocks.mjs ROOTS 重跑）。灌库脚本 `supabase/scripts/build_kb_blocks.mjs`（SBP_PAT 环境变量）。检索 = kb_blocks_recall RPC，命中块原文直入 LLM。**ima-proxy kbFolders={hs:'恋爱话术',jx:null}，applyQuota !jx 分支 hs 吃满 pickCount**（防弹药从 5 条缩到 2-3 条）

## 记忆体系（三层隔离）

- **窗口历史**：`js/session.js` WindowSession（sessionStorage `junshi_window_session`）。reload/back_forward 保留，新开页重建。按好友隔离，单好友 50 条。**仅"杀进程恢复"路径（app.js getLastView→Chat.open(restoreContext=true)）从库重建最近 50 条；从好友列表进入不重建 → 窗口历史可能为空**
- **数据库消息**：chat_messages 全量持久化，仅界面显示/恢复用，不是 AI 上下文
- **记忆卡**（唯一跨窗口载体，**按 chat_sessions.id 隔离，好友间永不交叉**）：JSON = profile{stage,personality,relationship_note,recent_events} + recent_user_messages（≤20）+ **recent_self_messages（≤20，v9）** + **v11 pulse{delay_count}/balance{direction,user_initiate_ratio,user_msg_len_avg}/emotion_tone{baseline,volatility}** + strategy + updated_at。主回复后 await updateMemoryCard（规则追加毫秒级 + 画像 LLM 提取 ≤3 分钟限频）

## LLM 生成链路（ima-proxy）

- 前端(query+history+session_id+system_prompt) → ima-proxy → [kb_blocks 块级检索=弹药] + [DeepSeek=生成]；降级：LLM → 知识库拼装(assembleKbReply) → 通用建议
- **检索（vB）**：语义词(semanticKws×2) + 整句词(sentenceKws×2.5) + bigram + 原句 → kb_blocks_recall RPC → 命中块 ≤700 字原文直入 system（同文档≤2块，总≤5块）；标题兜底 browseBlocksByTitle
- LLM secrets：`LLM_API_KEY`、`LLM_BASE_URL=https://api.deepseek.com`、**`LLM_MODEL=deepseek-v4-flash`**（deepseek-chat 已 2026-07-24 弃用）；主回复参数后台可调（app_config.llm_params，默认 0.4/0.5/0/1200 + thinking_mode）
- **v15 时间/位置（version 58）**：注入【当前时间】+【我的位置】块——`formatCurrentTime()` Asia/Shanghai **小时级稳定**（无分钟，不破坏前缀缓存），时段显式映射；`extractLocation(bio)` 城市词表+正则（命中才注入）。**别加分钟破坏缓存**
- **v16 套路轮数（version 59）**：max_rounds `Math.max(steps.length+1,3)`；对方抛更有趣话题时优先跟随、套路自然搁置
- **v11 迷男OS（version 38）**：战略层 STAGE_HINTS 全线上版；战术层 extractStrategy 步骤纯文字可发送+标时机+过滤肢体/眼神/现场类；引擎层 `resolveStageVocab` 91 词按 M3 打标、pulse.delay_count≥2 强制恢复、balance/emotion_tone 调节节奏。**Neg 轻度化保留**：只调侃行为/措辞/情境，3-5 轮≤1 次，情绪低落/挽回期禁用；返回值 `{systemContent, pulseAdvice}`（pulseAdvice 顶层声明，v31 教训）
- **v10 思考模式（version 35）**：四档 off/low/high/max；**仅 app_config.llm_params.thinking_mode 后台默认档**（v10b 起忽略请求体传参）；off → `thinking:{type:'disabled'}`，思考档 → `enabled`+reasoning_effort（无 medium，"中度"=high，不传温度/惩罚，max_tokens≥2000）；内部辅助调用保持 off；前端无切换 UI
- **v9 记忆自洽（version 32）**：记忆卡补记 recent_self_messages；buildSystemContent 首段硬编码"**你即用户本人**"；输出 1-2 句先正面回应再转折；自洽硬约束；主回复后 `isNearDuplicate`（bigram ≥0.85）→ 带提示重生成一次
- v8 语义拆解：TOPIC_VOCAB 91 词 + extractSemanticKeywords（LLM 拆 3-5 个检索词）；首轮顺序 `[...semanticKws, ...kw, searchQuery]`
- L0-L3：单条 history ≤800 字；知识库 5 条×500 字；近详远略（最近 10 条全文+更早仅对方消息 ≤120 字）；STAGE_HINTS 按 stage 注入；组装：全局提示词>场景指令>简介>记忆卡>更早摘要>参考>格式约束
- 套路（v7/v18）：extractStrategy 提炼 2-6 步存 memory_card.strategy；`/` 开头输入清除；轮次上限自动终止；**状态感知配额已失效（2026-08-06 教学/实战删库后仅剩话术，hs 吃满参考配额）**；套路走独立惯例检索通道

## 关键踩坑（务必先读）

- **无 CLI 部署 Edge Function**（本机 CLI Bun 编译 CPU 不支持）：`POST /v1/projects/{ref}/functions/deploy?slug={slug}`，multipart **file=单个源码文件**，metadata `{"entrypoint_path":"index.ts","name":slug}`（**登录类函数需加 `"verify_jwt":false`**，否则无 JWT 请求被拦）；urllib/requests 均需禁代理 + 浏览器 UA（否则 Cloudflare 1010）；任意 SQL 用 `POST /v1/projects/{ref}/database/query`；**REST RPC 鉴权用 service_role JWT（api-keys 端点拿），PAT 只用于管理 API**（混用报 "Expected 3 parts in JWT"）
- **req.json() 只能消费一次**：Deno.serve 里顶层解构后内层再 `await req.json()` → Body already consumed → 500；顶层解析一次，各分支复用
- **prompt-update 校验坑（v11 修复）**：LLM_PARAM_RANGE 不能 `Array.isArray(range)` 区分枚举/区间（数值区间也是数组）→ 用 `typeof range[0]==='string'`
- **作用域教训（v31 事故）**：函数内 `let` 声明必须提到 Deno.serve 顶层，_debug 外引用块内 let → ReferenceError 全 500；esbuild 查不到，部署前 tsc/transpileModule 校验
- **端到端验证**：`GET /v1/projects/{ref}/api-keys` 拿 service_role JWT → `POST /auth/v1/admin/users`（email_confirm:true，**成功返回 200 非 201**）→ `POST /auth/v1/token?grant_type=password`（必须带 apikey）→ 调函数看 _debug → 清理
- **激活码后台权限坑（015 修复）**：activation_codes 表 RLS 只给了 SELECT 策略，后台直插被 RLS 拦 → 一律走 SECURITY DEFINER RPC（is_admin 校验）；新函数默认 PUBLIC 可 EXECUTE（无需 GRANT anon 也能调），安全靠函数内鉴权兜底
- **管理 API database/query 成功返回 200 或 201 都可能**（清理/断言脚本须判 `code < 300`，只判 200 会漏判）；api-keys 端点必须带浏览器 UA
- **令牌位置**：Supabase PAT 存于 `C:\Users\Administrator\Documents\资料.txt`（部署自取；日志只记位置不记内容）

## 前端其他（简）

- 暗色主题 css/style.css（`--bg-page:#000`）；好友备注 `chat_sessions.note`；长按 600ms Action Sheet；PWA：install-prompt.js 4 道防打扰，sw.js 网络优先只缓存同源；图标用 managed venv Pillow 生成
