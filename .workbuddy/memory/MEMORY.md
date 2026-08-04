# 军师 (junshi) 项目长期记忆

## 项目约定（必须遵守）

- **GitHub 仓库为公开仓库**（`github.com/laojihuas/junshi`，默认分支 master）
- **`.workbuddy/memory/` 会随 git 推送**，任何日志中**严禁写入敏感凭证**（IMA Key / Supabase token / service_role / PAT / 密码），只写存储位置或占位符 `<sbp_pat>`
- 前端部署：帽子云（maozi.cloud）关联 GitHub 自动部署，push 后需等待构建生效

## 部署架构

- **前端**：静态 SPA（帽子云），配置在 `config.js`（git 跟踪，含 Supabase anon key / kb proxyUrl）
- **后端**：Supabase（ref: `opzvvgixlfbfpdlsorbi`）
  - Edge Functions：`ima-proxy`（核心，**vB 本地块级检索**，version 49）、`activate-code`、`prompt-get`、`prompt-update`、`invite-code`、`invite-redeem`
  - 数据表：`profiles` / `chat_sessions`（note、**memory_card** text）/ `chat_messages` / `activation_codes` / `app_config`（单行 id=1，统一 system_prompt + llm_params JSON）/ `invite_relations`
  - **kb_blocks**（B 方案，15,107 块）：media_id+block_idx PK，content≤700 字，bigrams GIN 索引，folder_id/title 索引，RLS service_role 专用
  - SQL 脚本：`supabase/sql/001~007`（app_config / bio / note / invite / memory_card / **006 kb_docs 旧版** / **007 kb_blocks**）
  - 数据库函数：`redeem_invite`（SECURITY DEFINER，写邀请关系+邀请人 usage+50，防自邀/重复/上限 20 人）、`kb_blocks_recall`（块级召回 RPC：bigrams && 粗筛 → 块内词频加权 → 同文档去重）
- **知识库（B 方案已完全本地化）**：**IMA 已彻底移除**（secrets 已删，代码零引用）。本地切块源在 `C:\迷男\{恋爱话术,恋爱教学,聊天实战}\`，灌库脚本 `supabase/scripts/build_kb_blocks.mjs`（SBP_PAT 环境变量）。检索 = kb_blocks_recall RPC，命中块原文直入 LLM（summarizeRef 已下线）

## 记忆体系（三层，隔离边界）

- **窗口历史**：`js/session.js` WindowSession（sessionStorage key `junshi_window_session`）。`navigation.type` reload/back_forward 保留，navigate（复制标签页/新开）重建 UUID 清空历史。按好友隔离，单好友 50 条。**仅"杀进程恢复"路径（app.js getLastView → Chat.open(restoreContext=true)）从数据库重建最近 50 条；从好友列表手动进入不重建 → 窗口历史可能为空**
- **数据库消息**：chat_messages 全量持久化，仅用于界面显示与恢复，不是 AI 上下文
- **记忆卡**（唯一跨窗口载体，**按 chat_sessions.id 隔离，不同好友永不交叉**，RLS 按 user_id 兜底）：`chat_sessions.memory_card` JSON = profile{stage,personality,relationship_note,recent_events} + `recent_user_messages`（对方的话 ≤20）+ **`recent_self_messages`（军师自己发过的话 ≤20，v9 新增）** + **v11 引擎层 pulse{delay_count}/balance{direction,user_initiate_ratio,user_msg_len_avg}/emotion_tone{baseline,volatility}** + strategy + updated_at。主回复后 await updateMemoryCard（规则追加毫秒级 + 画像 LLM 提取 ≤3 分钟限频）

## LLM 生成链路（ima-proxy）

- 前端(query+history+session_id+system_prompt) → ima-proxy → [**本地 kb_blocks 块级检索**=弹药] + [DeepSeek=生成]；降级链：LLM → 知识库拼装(assembleKbReply) → 通用建议
- **检索（vB）**：语义词(semanticKws×2) + 整句词(sentenceKws×2.5) + bigram + 原句 → kb_blocks_recall RPC → 命中块 ≤700 字原文直入 system（同文档≤2块，总≤5块）；标题兜底 browseBlocksByTitle（ilike）。**summarizeRef 已下线**（块即原文，无需 LLM 摘要）
- LLM secrets：`LLM_API_KEY`（DeepSeek）、`LLM_BASE_URL=https://api.deepseek.com`、**`LLM_MODEL=deepseek-v4-flash`（v10 起，deepseek-chat 已 2026-07-24 弃用）**；主回复参数后台可调（app_config.llm_params，默认 0.4/0.5/0/1200 + thinking_mode）
- **v11 迷男OS（2026-08-02，version 38）**：迷男方法精髓 × 线上纯文字场景融合，三层架构
  - 战略层：记忆卡 profile.stage 定基调（STAGE_HINTS 全部改线上版：追求=展示面+节奏/暧昧=文字张力/恋爱=小调侃保鲜/挽回=禁调侃先稳情绪）
  - 战术层：strategy 套路定方向（extractStrategy 线上化：步骤纯文字可发送+标发送时机+过滤肢体/眼神/现场类+禁人身攻击；启动检索词 `resolveStrategySearchKws` 按 stage/goal 动态取）
  - 引擎层：`resolveStageVocab` 把 91 词按 M3 四阶段(meet/attract/comfort/seduction)打标分组，extractSemanticKeywords 按"当前目标"加权（目标词优先最多2个）；`pulse.delay_count` 连续建议延后 ≥2 强制恢复（防冷暴力）；`balance.direction` self_pursuing→"短句+延后20-40分钟回写 pulseAdvice" / user_pursuing→顺势热聊；`emotion_tone.baseline` negative→禁延后禁调侃先共情
  - **Neg 轻度化保留**（用户明确要求）：buildSystemContent【线上语境与轻度否定】块——只调侃行为/措辞/情境（禁外貌/性格/价值否定）、每3-5轮最多1次、情绪低落/挽回期禁用；推拉结构=先回应(拉)→轻调侃/留白(推)→留钩子
  - 返回值改 `{systemContent, pulseAdvice}`（pulseAdvice 顶层声明，v31 教训）；_debug 新增 stage_vocab/balance_direction/emotion_baseline/pulse_delay_count
  - 验证：stage=暧昧→stage_vocab 自动切 seduction 词表✅；balance/emotion_tone 落库✅
- **v10 思考模式（2026-08-02，version 35）**：四档 off/low/high/max（off=普通默认，思考档 UI 文案 轻度/中度/深度）
  - **V4 思考模式默认开启**！llmChat 必须显式三态：off → `thinking:{type:'disabled'}`（保留 temperature/惩罚参数）；思考档 → `thinking:{type:'enabled'}`+`reasoning_effort`（官方无 medium，"中度"=默认 high；思考档不传温度/惩罚系数，max_tokens 自动 ≥2000）
  - 优先级：**仅 app_config.llm_params.thinking_mode 后台默认档**（v10b 起忽略请求体传参——防用户构造请求刷最高档 max 成本失控）；`isV4=/v4/.test(model)` 兼容旧模型
  - 内部辅助调用（rewriteQuery/语义拆解/定向摘要/画像提取/套路提炼）保持默认 off（显式 disabled），开思考只增成本
  - 前端**无切换 UI**（v10b 撤掉），后台 admin"思考模式默认档"下拉（默认 off）是唯一控制点
- **v9 记忆与自洽修复（2026-08-02，version 32）**：解决"重复说过的话"与"逻辑自相矛盾"
  - 记忆卡补记 `recent_self_messages`（自己发过的话）→ 窗口历史丢失后 AI 仍知道自己说过什么
  - buildSystemContent 首段硬编码角色定位"**你即用户本人**"（覆盖后台提示词的顾问视角）；参考资料降级为弹药（冲突时以对话连续性为准）；输出 1-2 句（先正面回应再转折）；自洽硬约束（禁自相矛盾/推翻自己/答非所问/重复）
  - 主回复后 bigram 相似度兜底：`isNearDuplicate` 与 recent_self_messages 命中 ≥0.85 或一字不差 → 带提示重生成一次
  - `_debug` 新增 `self_msgs_len`
- v8 语义拆解检索：TOPIC_VOCAB 91 词表 + extractSemanticKeywords（LLM 拆 3-5 个 2-5 字检索词，词表约束+few-shot）；首轮顺序 `[...semanticKws, ...kw, searchQuery]`；rewriteQuery 降级为语义拆解失败且规则词不足时
- L0-L3：单条 history ≤800 字；知识库参考 5 条×500 字（长文档 summarizeRef 定向摘要 ≤320 字）；近详远略（最近 10 条全文+更早仅对方消息 ≤120 字注入 system）；STAGE_HINTS 场景指令按 stage 注入；组装顺序：全局提示词>场景指令>简介>记忆卡>更早摘要>参考>格式约束
- 套路（v7/v18）：检索含惯例特征词 → extractStrategy LLM 提炼 2-6 步存 memory_card.strategy；**套路=方向盘，检索=弹药**；`/` 开头输入清除；轮次上限自动终止；fetchKbFolders 识别话术/教学文件夹 → applyQuota 状态感知配额（执行期话术≤3+教学≤2）；套路启动走独立惯例检索通道

## 关键踩坑（务必先读）

- **IMA API**：search_knowledge 只认短关键词（bigram 命中率最高），长词/整句返回空；get_knowledge_list limit ≤50；文件夹字段是 title/media_id；新版 `sb_publishable_*` key 非 JWT，REST 需 apikey+Bearer 双传（Edge Functions gateway 可过）
- **无 CLI 部署 Edge Function**（本机 CLI Bun 编译 CPU 不支持）：`POST /v1/projects/{ref}/functions/deploy?slug={slug}`，multipart 的 **file=单个源码文件**（非压缩包），metadata `{"entrypoint_path":"index.ts","name":slug}`；requests 需 `proxies={'http':None,'https':None}`（本机代理不稳）；Secrets 用 `POST /v1/projects/{ref}/secrets`；任意 SQL 用 `POST /v1/projects/{ref}/database/query`（201/空数组）
- **prompt-update 校验坑（v11 修复）**：LLM_PARAM_RANGE 是 `Record<string, [number,number] | string[]>`，**不能**用 `Array.isArray(range)` 区分枚举/区间（数值区间本身也是数组）→ 用 `typeof range[0]==='string'` 判断
- **作用域教训（v31 事故）**：函数内 `let` 声明必须提到 Deno.serve 顶层，_debug 块外引用块内 let → ReferenceError → 全 500；esbuild 只查语法抓不到，部署前用 tsc/transpileModule 校验
- **端到端验证**（无需真实凭证）：`GET /v1/projects/{ref}/api-keys` 拿 service_role JWT → `POST /auth/v1/admin/users`（email_confirm:true 不发邮件；别用 SignUp 会邮件限流；别手工 INSERT auth.users；**成功返回 200 不是 201**）→ `POST /auth/v1/token?grant_type=password`（必须带 apikey header）→ 调函数看 _debug → 清理
- **前端降级**：`_callIMA` 异常返回"掉线了"（不返回 mock）

## 前端其他（简）

- 暗色主题：css/style.css（`--bg-page:#000`，聊天气泡绿色渐变）；好友备注 `chat_sessions.note`；长按 600ms Action Sheet（改名/备注/删除）；PWA：install-prompt.js 4 道防打扰（standalone/已安装/拒绝冷却/登录+首页），iOS 图文引导，sw.js 网络优先只缓存同源；图标用 managed venv Pillow 生成（脚本放 Temp）
