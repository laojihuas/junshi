# 军师 (junshi) 项目长期记忆

## 项目约定（必须遵守）

- **GitHub 仓库为公开仓库**（`github.com/laojihuas/junshi`，默认分支 master）
- **`.workbuddy/memory/` 会随 git 推送**，任何日志中**严禁写入敏感凭证**：
  - IMA API Key / Client ID
  - Supabase access token / service role key
  - 任何密码、密钥
- 敏感值如需记录，只写存储位置（如 `~/.config/ima/api_key`）或占位符（`<sbp_pat>`）
- 前端部署：帽子云（maozi.cloud）关联 GitHub 自动部署，push 后需等待构建生效

## 部署架构

- **前端**：静态 SPA（帽子云托管），配置在 `config.js`（git 跟踪，含 Supabase anon key / IMA knowledgeBaseId）
- **后端**：Supabase（项目 ref: `opzvvgixlfbfpdlsorbi`）
  - Edge Functions: `ima-proxy`（IMA 知识库代理，v6 智能化版：联合检索/记忆卡/场景指令/结构化输出）、`activate-code`（激活码验证）、`prompt-get`（获取统一提示词）、`prompt-update`（管理员更新提示词）、`invite-code`（获取/生成邀请码）、`invite-redeem`（注册兑现邀请，service_role + RPC）
  - 数据表：`profiles` / `chat_sessions`（含 note、**memory_card** text 存记忆卡 JSON）/ `chat_messages` / `activation_codes` / `app_config`（单行 id=1，存统一 system_prompt，需手动执行 `supabase/sql/001_app_config.sql` 建表）/ `invite_relations`（邀请关系，invitee_id 唯一）
  - 数据库函数：`redeem_invite`（SECURITY DEFINER，原子兑现邀请：写关系 + 邀请人 usage_count+50，防自邀/重复/不存在，单码上限 20 人）
- **IMA 知识库**：知识库「恋爱知识」，ID `nIUQTuLN18QIpfhpUKzd1iziyTgw0-Bj81KAUl31VFI=`，凭证在本机 `~/.config/ima/`（client_id / api_key）

## 多窗口会话 + 统一提示词（v20260731）

- **窗口会话隔离**：`js/session.js`（WindowSession）基于 sessionStorage（key `junshi_window_session`，结构 `{windowSessionId, conversations:{好友ID:history[]}, activeFriend}`）。用 `performance navigation.type` 区分：`reload`/`back_forward` 保留会话，`navigate`（含复制标签页）重建新 UUID 清空历史。历史按好友隔离，单好友 50 条上限。聊天消息持久化仍存数据库（chat_messages），窗口会话只决定发给 IMA 的 AI 上下文
- **统一提示词**：前端每次发送前调 prompt-get 获取最新 system_prompt（失败降级空串不阻塞），与 history 一起经 ima-proxy 透传 IMA；提示词不存储不渲染，前端不可见；后台"提示词管理"tab 编辑，prompt-update 服务端用 service_role 校验 profiles.is_admin
- **ima-proxy v3 容错**：`callSearch()` 先带附加参数调 search_knowledge，IMA 拒绝时去参重试（原有功能不受影响）

## LLM 生成 + 用户简介 + 记忆卡（v6 智能化，ima-proxy v16）

- **架构**：前端(query+窗口×好友history+session_id) → ima-proxy → [IMA知识库检索=参考] + [DeepSeek 生成专业答复]；提示词/简介/记忆卡服务端注入
- **LLM 配置**（secrets）：`LLM_API_KEY`（DeepSeek）、`LLM_BASE_URL=https://api.deepseek.com`、`LLM_MODEL=deepseek-chat`；降级链：LLM → 知识库拼装(assembleKbReply) → 通用建议；主回复 max_tokens=1200 / temperature=0.5
- **我的简介**：`profiles.bio`（varchar 200）；前端好友页 ✎ 弹窗编辑（friends.js showBioModal/saveBio）
- **v6 增强**（三期全落地）：
  - L0：单条 history >800 字截断；知识库参考 5 条 × 原文 500 字（KB_REF_COUNT/KB_CONTENT_MAX）
  - L1：联合关键词（最近 5 条对方消息+query bigram）；条件 query rewrite（关键词 <2 个时 LLM 改写）；两轮检索；searchKb 多查询按 hits 排序去重（每词前 2 条、上限 8）
  - L2：近详远略 buildContextParts（最近 10 条全文+更早仅留对方消息 ≤120 字注入 system）；**记忆卡**存 `chat_sessions.memory_card`（JSON：`profile{stage,personality,relationship_note,recent_events}` + `recent_user_messages` ≤20 条 + updated_at），updateMemoryCard 主回复后 await 更新（规则追加毫秒级 + 画像 LLM 提取 ≤3 分钟一次）；输出格式约束【分析】+【回复建议 N】+【小提示】
  - L3：STAGE_HINTS 场景指令（追求/暧昧/恋爱/挽回/普通朋友）按记忆卡 stage 注入；组装顺序：全局提示词 > 场景指令 > 用户简介 > 记忆卡 > 更早摘要 > 知识库参考 > 格式约束
- **多会话隔离**：窗口 history 由前端 WindowSession（sessionStorage）传递；记忆卡按 session_id 跨窗口共享（后端读写 chat_sessions.memory_card，RLS 校验归属）

## 套路执行机制（v7，ima-proxy v17→v18）

- **定位**：junshi 输出以**话术为主**（军师扮演用户与女生对话，分析不用）；「恋爱教学」文件夹不舍删 → 其中惯例/魔术"武装"到多轮聊天布局，逐轮贯彻技巧
- **strategy** 存 `memory_card.strategy`（name/goal/steps[2-6]/rounds_used/max_rounds=steps×2≥6/started_at）
- **启动**：检索结果含惯例特征词（惯例|魔术|玩法|套路|步骤|操作|流程|布局|开场|进阶|收尾|推拉|框架|冷读）→ `extractStrategy` LLM 提炼步骤；steps<2 或未命中特征不启动
- **注入**【当前执行套路】：**套路=方向盘（优先级高于检索参考资料），检索=弹药（方向一致采用/冲突忽略或借鉴语气）**；先顺应女方再拉回；**严禁向对方提及套路/步骤/进度等元信息**；套路完成/失效自然收尾
- **打断**：`"/"` 开头输入 = 用户指令 → `strategyClear` 清除套路；每轮 `rounds_used+1` 达上限自动终止
- **检索配额平衡（v18）**：`fetchKbFolders` 按名识别话术/教学文件夹（识别不到降级不配额）→ `applyQuota` 状态感知配额（执行期话术≤3+教学≤2、未启动期教学≤3+话术≤2），**两类内容始终同在上下文**；套路启动走**独立惯例检索通道**（"聊天惯例/魔术玩法流程/惯例步骤推拉"），结果只喂 extractStrategy **不混入主回复参考**
- `_debug` 含 `strategy_name/strategy_rounds/strategy_clear/folder_hs/folder_jx` 便于验证
- **部署坑**：本机 curl schannel SSL 握手失败 → 云端部署 Edge Function 改用 **Python requests** multipart（metadata 字段名 `entrypoint_path`），脚本模板可放 Temp 不入库

## 暗色主题 + 好友长按管理（v20260731-late）

- **全局暗色**（`css/style.css` 全部重写）：`--bg-page:#000` / `--bg-elevated:#1C1C1E` / 顶部导航多层 CSS 渐变（深紫蓝星空+星点）作图底；主标题"军师"+ 副标题"你专属的恋爱顾问"；聊天气泡用绿色渐变
- **好友备注**：`chat_sessions.note`（varchar 30，SQL `supabase/sql/003_chat_sessions_note.sql`）；列表 `.friend-name` 内追加 `.friend-note` 绿色描边小标签
- **长按 Action Sheet**：touchstart/mousedown 计时 600ms 触发 → 底部弹出"改名/备注"+"删除"+"取消"（index.html #action-sheet）；navigator.vibrate(15) 触觉反馈；触发后阻止 click 进入聊天
- **编辑好友弹窗**（#modal-edit-friend）：昵称(20字) + 备注(30字)；保存调 `DB.updateSession`；Enter 友好（昵称框 Enter 跳备注，备注框 Enter 提交）

## 关键技术点

- **ima-proxy v2 搜索策略**：IMA `search_knowledge` 是关键词搜索（非 AI 对话），整句/3-4 字长词返回空；**bigram（2 字窗口）命中率最高**（"不回"25条/"高冷"26条）。Edge Function 用两阶段 bigram 提取（双实义字优先）→ 多关键词轮询搜索合并 → `get_media_info` 拉取 markdown 原文 → 清洗导航/元数据后拼装回复
- **无 CLI 部署 Edge Function**（本机 supabase CLI 2.110 为 Bun 编译，CPU 不支持报 Illegal instruction）：
  - Secrets: `POST https://api.supabase.com/v1/projects/{ref}/secrets`
  - 部署（云端打包）: `POST /v1/projects/{ref}/functions/deploy?slug={slug}`，multipart/form-data（metadata JSON + file 源码），`/functions/{slug}/deploy` 是错误路径；**metadata 字段名必须是 `entrypoint_path`（不是 entrypoint）**
  - **执行任意 SQL**: `POST /v1/projects/{ref}/database/query`，body `{"query":"..."}`，成功返回 201/空数组（无需进 Dashboard）

## PWA 添加到桌面（v20260731-late2）

- **4 道防打扰**（`js/install-prompt.js` 的 PWAInstall 对象）：
  1. 已从桌面打开（`display-mode:standalone` / `navigator.standalone`）
  2. 已安装成功（`appinstalled` → localStorage `pwa_installed=1` 永久）
  3. 拒绝冷却（递增）：第 1 次 7 天 / 第 2 次 30 天 / 第 3 次起永久
  4. 环境检查：必须已登录 + 在 friends 首页 + 浏览器支持
- **触发点**：App.init() 登录成功路径 + 登录按钮 async 成功路径 → `PWAInstall.maybeShow()`（内部 `setTimeout 2000ms` + `_inflight` 防重复）
- **Android Chrome**：`beforeinstallprompt` 拦截 → `deferredPrompt.prompt()` → `userChoice.outcome==='accepted'` 走 appinstalled 路径
- **iOS Safari**：不支持，必须图文引导（分享按钮 → 添加到主屏幕），3 步教程
- **Service Worker**（`sw.js`）：网络优先 + 失败回退缓存，**只缓存同源**（Supabase/IMA/DeepSeek 跨域不缓存，避免陈旧 API 响应）；`navigator.serviceWorker.register('sw.js')` 在 `'load'` 事件内执行
- **图标生成**：Python managed venv + Pillow（`C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe`），字体 `C:\Windows\Fonts\simhei.ttf`；脚本放 `C:\Users\Administrator\AppData\Local\Temp\` 不入库
- **帽子云静态托管**支持 PWA 完整特性（需 HTTPS + manifest.json + SW）
- 文件：`manifest.json` / `sw.js` / `js/install-prompt.js` / `icons/{icon-192,icon-512,apple-touch-icon}.png`
