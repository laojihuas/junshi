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
  - Edge Functions: `ima-proxy`（IMA 知识库代理，v3 支持透传 history/system_prompt）、`activate-code`（激活码验证）、`prompt-get`（获取统一提示词）、`prompt-update`（管理员更新提示词）
  - 数据表：`profiles` / `chat_sessions` / `chat_messages` / `activation_codes` / `app_config`（单行 id=1，存统一 system_prompt，需手动执行 `supabase/sql/001_app_config.sql` 建表）
- **IMA 知识库**：知识库「恋爱知识」，ID `nIUQTuLN18QIpfhpUKzd1iziyTgw0-Bj81KAUl31VFI=`，凭证在本机 `~/.config/ima/`（client_id / api_key）

## 多窗口会话 + 统一提示词（v20260731）

- **窗口会话隔离**：`js/session.js`（WindowSession）基于 sessionStorage（key `junshi_window_session`，结构 `{windowSessionId, conversations:{好友ID:history[]}, activeFriend}`）。用 `performance navigation.type` 区分：`reload`/`back_forward` 保留会话，`navigate`（含复制标签页）重建新 UUID 清空历史。历史按好友隔离，单好友 50 条上限。聊天消息持久化仍存数据库（chat_messages），窗口会话只决定发给 IMA 的 AI 上下文
- **统一提示词**：前端每次发送前调 prompt-get 获取最新 system_prompt（失败降级空串不阻塞），与 history 一起经 ima-proxy 透传 IMA；提示词不存储不渲染，前端不可见；后台"提示词管理"tab 编辑，prompt-update 服务端用 service_role 校验 profiles.is_admin
- **ima-proxy v3 容错**：`callSearch()` 先带附加参数调 search_knowledge，IMA 拒绝时去参重试（原有功能不受影响）

## 关键技术点

- **ima-proxy v2 搜索策略**：IMA `search_knowledge` 是关键词搜索（非 AI 对话），整句/3-4 字长词返回空；**bigram（2 字窗口）命中率最高**（"不回"25条/"高冷"26条）。Edge Function 用两阶段 bigram 提取（双实义字优先）→ 多关键词轮询搜索合并 → `get_media_info` 拉取 markdown 原文 → 清洗导航/元数据后拼装回复
- **无 CLI 部署 Edge Function**（本机 supabase CLI 2.110 为 Bun 编译，CPU 不支持报 Illegal instruction）：
  - Secrets: `POST https://api.supabase.com/v1/projects/{ref}/secrets`
  - 部署（云端打包）: `POST /v1/projects/{ref}/functions/deploy?slug={slug}`，multipart/form-data（metadata JSON + file 源码），`/functions/{slug}/deploy` 是错误路径
