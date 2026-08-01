// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理 (v6)
//
// 功能：接收前端请求 → 校验用户状态 → 检索 IMA 知识库 → 生成专业回复
//
// [v6 智能化改造 - 三期全部落地]
//   L0 参数与裁剪：
//     - max_tokens 800 → 1200（避免长回复被截断）
//     - temperature 0.7 → 0.5（回复更稳定贴合知识库风格）
//     - 单条 history 超 800 字截断（防止单条消息淹没上下文）
//     - 知识库参考 3 条 → 5 条，原文截断 260 → 500 字
//   L1 检索增强（解决"离题"）：
//     - 联合关键词提取：从最近 5 条对方消息 + query 一起提取 bigram 关键词
//     - 条件 query rewrite：规则关键词不足时用轻量 LLM 改写为完整检索问句
//     - 两轮检索：首轮（改写/query+关键词）→ 不足 2 条用历史关键词补搜
//     - 结果按多词命中次数排序去重（searchKb 内部统计 hits）
//   L2 上下文工程 + 记忆卡（解决"深度"）：
//     - 近详远略：最近 10 条全文 + 更早只保留对方消息（≤120字/条）作摘要注入 system
//     - 对方画像记忆卡（chat_sessions.memory_card，跨窗口共享）：
//       profile{stage,personality,relationship_note,recent_events} + recent_user_messages
//       主回复前读取注入 system；主回复后异步合并更新（画像提取频率 ≤ 每3分钟一次）
//     - 输出格式约束：【分析】+【回复建议 N】+【小提示】结构化三段
//   L3 提示词体系：
//     - 场景指令：按记忆卡 stage 注入对应关系阶段的指导（追求/暧昧/恋爱/挽回/普通朋友）
//     - 全局提示词(后台可编辑) > 场景指令 > 用户简介 > 记忆卡 > 更早摘要 > 知识库参考 > 格式约束
//
// 兼容性：所有增强均为服务端内部实现；旧前端（不传 session_id/history）自动降级，
// 原有"知识库拼装"与"通用建议"降级链保持不变。
//
// 请求体（JSON）：
//   query          必填 当前内容（用户粘贴的对方的话）
//   knowledge_base_id  可选，默认取环境变量
//   history        可选 本窗口对话历史 [{role,content}]
//   system_prompt  可选 后台统一提示词（前端用户不可见）
//   session_id     可选 数据库会话 ID（chat_sessions.id），用于读写记忆卡
//
// 环境变量：IMA_API_KEY, IMA_CLIENT_ID, IMA_KNOWLEDGE_BASE_ID, FREE_TRIES,
//           LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
// ============================================================

const IMA_BASE = 'https://ima.qq.com';

// 常见停用词（恋爱聊天场景），用于关键词提取
const STOP_WORDS = new Set([
  '怎么', '怎么办', '如何', '为什么', '什么', '怎样', '咋办', '咋',
  '对方', '女生', '男生', '妹子', '女孩', '我', '你', '他', '她', '它',
  '说', '了', '吗', '呢', '啊', '呀', '吧', '的', '地', '得',
  '是', '在', '和', '与', '就', '都', '很', '也', '要', '想',
  '可以', '应该', '这个', '那个', '一下', '一个', '一种', '意思',
  '感觉', '觉得', '这样', '那样', '真的', '有点', '有些', '然后',
  '但是', '因为', '所以', '如果', '没有', '不是', '就是', '还是',
  '回复', '回应', '说话', '讲', '跟', '给', '把', '被', '让', '去', '来'
]);

// 中文标点切分
const SPLIT_RE = /[，。！？；、,.!?;:\s\n\r"'""''（）()【】\[\]]+/;

// [v6 L3] 关系阶段 → 场景指导映射（由记忆卡 profile.stage 触发）
const STAGE_HINTS: Record<string, string> = {
  '追求': '对方处于被追求阶段：回复要自然不油腻、适度示好、多关注对方，避免查户口式提问。',
  '暧昧': '双方处于暧昧期：营造轻松氛围、适当推进关系、保留一点张力与神秘感。',
  '恋爱': '双方已是恋人：回复温暖有生活感、关注细节，避免过度客气生分。',
  '挽回': '关系出现裂痕：先稳住对方情绪、不纠缠不施压，以重建信任为先。',
  '普通朋友': '对方是普通朋友：保持得体大方、不越界、话题轻松。',
  '未知': '',
};

// [v6 L0] 知识库参考条数与原文截断长度
const KB_REF_COUNT = 5;
const KB_CONTENT_MAX = 500;
const HISTORY_ITEM_MAX = 800;   // 单条历史上限
const SUMMARY_ITEM_MAX = 120;   // 更早消息摘要单条上限
const RECENT_FULL = 10;         // 近详远略：最近 N 条全文
const MEMORY_UPDATE_INTERVAL = 3 * 60 * 1000; // 画像提取频率：3 分钟

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    const { query, knowledge_base_id, history, system_prompt, session_id } = await req.json();
    const kbId = knowledge_base_id || Deno.env.get('IMA_KNOWLEDGE_BASE_ID') || '';

    if (!query || !query.trim()) {
      return new Response(JSON.stringify({ error: 'query 不能为空' }), { headers, status: 400 });
    }

    // ---- 用户认证 ----
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    const authResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey }
    });
    if (!authResp.ok) {
      return new Response(JSON.stringify({ error: '认证失败' }), { headers, status: 401 });
    }
    const user = await authResp.json();

    // ---- 统一提示词兜底 ----
    let effectivePrompt = (typeof system_prompt === 'string') ? system_prompt : '';
    if (!effectivePrompt.trim()) {
      effectivePrompt = await fetchSystemPrompt(supabaseUrl, serviceRoleKey);
    }

    // ---- 查询 profile ----
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=*`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey } }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0];

    if (!profile) {
      return new Response(JSON.stringify({ error: '用户不存在' }), { headers, status: 404 });
    }

    // ---- 检查 VIP / 免费次数 ----
    const isVip = profile.is_vip === true;
    let vipValid = isVip;
    if (isVip && profile.vip_expires_at) {
      vipValid = new Date(profile.vip_expires_at) > new Date();
      if (!vipValid) {
        await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${supabaseAnonKey}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_vip: false, vip_expires_at: null })
        });
      }
    }

    if (!vipValid) {
      const usageCount = profile.usage_count || 0;
      const freeTries = parseInt(Deno.env.get('FREE_TRIES') || '50');
      if (usageCount >= freeTries) {
        return new Response(JSON.stringify({
          error: 'free_trial_ended',
          message: `免费试用已用完（${freeTries}次），请升级 VIP`,
        }), { headers, status: 403 });
      }
    }

    // ---- IMA / LLM 凭证 ----
    const imaKey = Deno.env.get('IMA_API_KEY') || '';
    const imaClientId = Deno.env.get('IMA_CLIENT_ID') || '';
    const llmKey = Deno.env.get('LLM_API_KEY') || '';
    const llmBase = Deno.env.get('LLM_BASE_URL') || 'https://api.deepseek.com';
    const llmModel = Deno.env.get('LLM_MODEL') || 'deepseek-chat';

    // [v6 L2] 读取记忆卡（跨窗口共享的对方画像，按会话）
    let memoryCard = await readMemoryCard(supabaseUrl, token, supabaseAnonKey, session_id);

    // [v7] 套路打断："/" 开头 = 用户指令（如 /换策略 /停止 /不按套路），清除执行中的套路
    const strategyClear = typeof query === 'string' && query.trim().startsWith('/');
    if (strategyClear && memoryCard?.strategy) {
      memoryCard.strategy = null;
    }

    // [v6 L2] 上下文工程：近详远略压缩
    //   recent  = 最近 10 条全文（单条 ≤800 字），作为 messages 发给 LLM
    //   summary = 更早的对话只保留"对方说的话"（≤120 字/条），注入 system
    const { recent: llmHistory, summary: olderSummary } = buildContextParts(history);

    // 最近对方说过的话（供 query rewrite 与记忆卡使用）
    const recentUserMessages = (Array.isArray(history) ? history : [])
      .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
      .map((h) => h.content)
      .slice(-3);

    let reply = '';
    let hitKnowledge = false;
    let kbItems: any[] = [];
    let kbFallback = false;
    let usedRewrite = false;

    // ---- 知识库检索（L1 增强） ----
    if (imaKey && imaClientId && kbId) {
      try {
        // 1. 联合关键词：最近对方消息 + 当前 query
        const kw = extractKeywordsFromHistory(history, query);
        // 2. 条件 query rewrite：规则关键词不足 2 个时用 LLM 改写为完整问句
        let searchQuery = query.trim();
        if (kw.length < 2 && llmKey) {
          const rw = await rewriteQuery(llmKey, llmBase, llmModel, query, recentUserMessages);
          if (rw) { searchQuery = rw; usedRewrite = true; }
        }
        // 3. 首轮检索：改写/原句 + 关键词（内部按 hits 排序去重，前 5 条拉原文）
        kbItems = await searchKbAndFetch(imaClientId, imaKey, kbId, [searchQuery, ...kw], llmHistory, effectivePrompt);
        // 4. 第二轮：不足 2 条时用"仅历史"关键词补搜
        if (kbItems.length < 2) {
          const kw2 = extractKeywordsFromHistory(history, '', true).filter((k) => !kw.includes(k)).slice(0, 3);
          if (kw2.length > 0) {
            const items2 = await searchKbAndFetch(imaClientId, imaKey, kbId, kw2, llmHistory, effectivePrompt);
            const merged = mergeDedup([...kbItems, ...items2]).slice(0, KB_REF_COUNT);
            if (merged.length > kbItems.length) kbItems = merged;
          }
        }
        // 5. 浏览回退：标题匹配
        if (kbItems.length === 0) {
          const browseItems = await browseKbByTitle(imaClientId, imaKey, kbId, searchQuery || query);
          if (browseItems.length > 0) {
            kbItems = await fetchItemsContent(imaClientId, imaKey, browseItems.slice(0, KB_REF_COUNT));
            kbFallback = true;
          }
        }
        hitKnowledge = kbItems.length > 0;
      } catch (e: any) {
        console.error('知识库检索失败:', e.message);
      }
    }

    // [v7] 套路启动：当前无执行中套路 + 用户未打断 + 检索到惯例/魔术/玩法类资料 → 提炼步骤序列
    //   提炼成功则本轮起开始执行（方向盘），失败则静默走普通回答
    if (llmKey && !strategyClear && !memoryCard?.strategy && kbItems.length > 0) {
      try {
        const st = await extractStrategy(llmKey, llmBase, llmModel, kbItems, query);
        if (st) {
          memoryCard = { ...(memoryCard || {}), strategy: st };
        }
      } catch (e: any) {
        console.warn('extractStrategy failed:', e.message);
      }
    }

    // ---- LLM 主回复 ----
    const userBio = (profile && typeof profile.bio === 'string') ? profile.bio : '';
    if (llmKey) {
      try {
        // 组装 system：全局提示词 > 场景指令 > 用户简介 > 记忆卡 > 更早摘要 > 知识库参考 > 格式约束
        const systemContent = buildSystemContent({
          systemPrompt: effectivePrompt,
          userBio,
          memoryCard,
          olderSummary,
          kbItems,
          kbFallback,
        });
        const messages: any[] = [
          { role: 'system', content: systemContent },
          ...llmHistory,
          { role: 'user', content: query.trim() },
        ];
        reply = await llmChat(llmKey, llmBase, llmModel, messages, { temperature: 0.5, maxTokens: 1200 });
      } catch (e: any) {
        console.error('LLM error:', e.message);
      }
    }

    // ---- 降级：知识库拼装（LLM 不可用/失败） ----
    if (!reply && kbItems.length > 0) {
      reply = assembleKbReply(kbItems, kbFallback);
    }

    // ---- 降级：通用建议 ----
    if (!reply) {
      const fallbacks = [
        `关于"${query}"，建议你：\n1️⃣ 先认可对方的感受\n2️⃣ 表达你的真实想法\n3️⃣ 用开放性问题引导对话`,
        `针对"${query}"，可以这样回：\n"嗯嗯，我明白你的意思。有空可以多聊聊~"`,
        `回应"${query}"的思路：先表示理解 → 表达看法 → 反问对方。三步法最自然。`,
      ];
      const reason = !(imaKey && imaClientId) && !llmKey
        ? '（知识库服务未配置，以下为通用建议）'
        : '（未检索到知识库相关内容，以下为通用建议）';
      reply = reason + '\n\n' + fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    // [v6 L2] 记忆卡更新（await 保证落库；画像提取有 3 分钟频率控制，多数请求只做毫秒级规则追加）
    if (session_id) {
      try {
        await updateMemoryCard({
          supabaseUrl, token, anonKey: supabaseAnonKey, sessionId: session_id,
          history, llmKey, llmBase, llmModel, existingCard: memoryCard,
        });
      } catch (e: any) {
        console.error('记忆卡更新失败:', e.message);
      }
    }

    // ---- 记录使用次数 ----
    if (!vipValid) {
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${supabaseAnonKey}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_count: (profile.usage_count || 0) + 1 })
      });
    }

    return new Response(JSON.stringify({
      reply,
      from_knowledge_base: hitKnowledge,
      usage_count: profile.usage_count + (vipValid ? 0 : 1),
      is_vip: vipValid,
      _debug: {
        system_prompt_len: (effectivePrompt || '').length,
        history_len: Array.isArray(history) ? history.length : 0,
        llm_history_len: llmHistory.length,
        kb_hits: hitKnowledge,
        kb_items: kbItems.length,
        rewrite_used: usedRewrite,
        memory_stage: memoryCard?.profile?.stage || null,
        strategy_name: memoryCard?.strategy?.name || null,
        strategy_rounds: memoryCard?.strategy?.rounds_used ?? null,
        strategy_clear: strategyClear,
      },
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('Error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});

// ============================================================
// [v6 L2] 近详远略：上下文压缩
//   最近 RECENT_FULL 条全文（单条截断 HISTORY_ITEM_MAX）；
//   更早的只保留对方消息（≤SUMMARY_ITEM_MAX/条，最多 8 条）拼成摘要
// ============================================================
function buildContextParts(history: any[]): { recent: any[]; summary: string } {
  const valid = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
  const recent = valid.slice(-RECENT_FULL).map((h) => ({
    role: h.role,
    content: truncateText(h.content, HISTORY_ITEM_MAX),
  }));
  const older = valid.slice(0, Math.max(0, valid.length - RECENT_FULL));
  const olderUsers = older.filter((h) => h.role === 'user').map((h) => truncateText(h.content, SUMMARY_ITEM_MAX));
  const summary = olderUsers.length > 0
    ? '【更早对话要点（对方说过的话，供把握前因后果）】\n' + olderUsers.slice(-8).join('\n')
    : '';
  return { recent, summary };
}

// ============================================================
// [v6 L1] 联合关键词提取：最近 5 条对方消息 + query
//   historyOnly=true 时只从历史提取（用于第二轮补搜）
// ============================================================
function extractKeywordsFromHistory(history: any[], query: string, historyOnly = false): string[] {
  const texts: string[] = [];
  if (!historyOnly && query) texts.push(query);
  if (Array.isArray(history)) {
    const users = history
      .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
      .map((h) => h.content)
      .slice(-5);
    texts.push(...users);
  }
  return extractKeywords(texts.join(' '));
}

// ============================================================
// [v6 L1] 条件 query rewrite：把碎片化问题改写为完整检索问句
//   仅在规则关键词不足时触发，成功后用于首轮检索
// ============================================================
async function rewriteQuery(llmKey: string, llmBase: string, llmModel: string, query: string, recentUserMsgs: string[]): Promise<string> {
  try {
    const prompt = `你是恋爱话术检索助手。用户的问题："${query}"` +
      (recentUserMsgs.length > 0 ? `\n最近对话（对方说的话）：\n${recentUserMsgs.slice(-2).join('\n')}` : '') +
      `\n请把问题改写成一个完整、适合检索恋爱资料库的问句（例如："女生对我说不想理我，我该怎么回复"）。只输出改写后的问句本身，30 字以内，不要任何解释。`;
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.3, maxTokens: 60,
    });
    return content ? content.slice(0, 60) : '';
  } catch (e: any) {
    console.warn('rewriteQuery failed:', e.message);
    return '';
  }
}

// ============================================================
// [v6] 记忆卡类型与读写
//   chat_sessions.memory_card 存 JSON 字符串：
//   { profile:{stage,personality,relationship_note,recent_events},
//     recent_user_messages:[...], strategy:{...}, updated_at }
// ============================================================
// [v7] strategy：执行中的聊天惯例（跨轮次"方向盘"）
//   从检索到的惯例/魔术/玩法类资料提炼步骤序列，逐轮注入执行
type StrategyState = {
  name: string;         // 惯例名称
  goal: string;         // 套路目标
  steps: string[];      // 步骤序列（2-6 步，每步一句话）
  rounds_used: number;  // 已使用轮次（每次回复后 +1）
  max_rounds: number;   // 轮次上限（自动终止，防止无限跑）
  started_at: string;
};

type MemoryCard = {
  profile?: { stage?: string; personality?: string; relationship_note?: string; recent_events?: string };
  recent_user_messages?: string[];
  strategy?: StrategyState | null;
  updated_at?: string;
};

async function readMemoryCard(supabaseUrl: string, token: string, anonKey: string, sessionId?: string): Promise<MemoryCard | null> {
  try {
    if (!sessionId) return null;
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/chat_sessions?id=eq.${encodeURIComponent(sessionId)}&select=memory_card`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': anonKey } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    const raw = rows?.[0]?.memory_card;
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e: any) {
    console.warn('readMemoryCard failed:', e.message);
    return null;
  }
}

async function writeMemoryCard(supabaseUrl: string, token: string, anonKey: string, sessionId: string, card: MemoryCard): Promise<void> {
  if (!sessionId) return;
  await fetch(
    `${supabaseUrl}/rest/v1/chat_sessions?id=eq.${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory_card: JSON.stringify(card) }),
    }
  );
}

// [v6 L2] 记忆卡更新：
//   1) 规则追加"对方说的话"（毫秒级，每次请求）
//   2) 画像合并（LLM 提取，频率 ≤ MEMORY_UPDATE_INTERVAL）
async function updateMemoryCard(ctx: {
  supabaseUrl: string; token: string; anonKey: string; sessionId: string;
  history: any[]; llmKey: string; llmBase: string; llmModel: string;
  existingCard: MemoryCard | null;
}): Promise<void> {
  const card: MemoryCard = ctx.existingCard || { profile: {}, recent_user_messages: [] };

  // 1) 规则追加对方最近说过的话（去重：与最后一条相同则跳过）
  const lastUser = [...(Array.isArray(ctx.history) ? ctx.history : [])]
    .reverse().find((h) => h && h.role === 'user' && typeof h.content === 'string');
  const msgs = Array.isArray(card.recent_user_messages) ? card.recent_user_messages.slice() : [];
  if (lastUser && (msgs.length === 0 || msgs[msgs.length - 1] !== lastUser.content)) {
    msgs.push(truncateText(lastUser.content, 200));
    if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
    card.recent_user_messages = msgs;
  }

  // 2) 画像合并（频率控制）
  let needProfile = true;
  if (card.updated_at) {
    const last = new Date(card.updated_at).getTime();
    needProfile = !isNaN(last) && (Date.now() - last) > MEMORY_UPDATE_INTERVAL;
  }
  if (needProfile && ctx.llmKey) {
    const profile = await extractProfile(ctx.llmKey, ctx.llmBase, ctx.llmModel, card, ctx.history);
    if (profile) card.profile = profile;
    card.updated_at = new Date().toISOString();
  }

  // [v7] 套路轮次回写：每轮 +1，达到上限自动终止（用户在 "/" 打断时 strategy 已被置空）
  if (card.strategy) {
    card.strategy.rounds_used = (card.strategy.rounds_used || 0) + 1;
    if (card.strategy.rounds_used >= (card.strategy.max_rounds || 6)) {
      card.strategy = null; // 轮次上限：套路自然结束，恢复正常聊天
    }
  }

  await writeMemoryCard(ctx.supabaseUrl, ctx.token, ctx.anonKey, ctx.sessionId, card);
}

// [v6 L2] LLM 提取/合并对方画像（输出标准化 JSON）
async function extractProfile(llmKey: string, llmBase: string, llmModel: string, card: MemoryCard, history: any[]): Promise<any> {
  const cur = JSON.stringify(card.profile || {});
  const recentDialogue = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((h) => `${h.role === 'user' ? '对方' : '用户'}：${truncateText(String(h.content || ''), 200)}`)
    .join('\n');
  const prompt = `你是恋爱顾问的档案整理助手。根据最近的对话，维护"对方"的画像档案。\n当前档案：${cur}\n最近对话：\n${recentDialogue || '（无）'}\n要求：输出合并更新后的 JSON，字段：stage（关系阶段，只能是"追求/暧昧/恋爱/挽回/普通朋友/未知"）、personality（性格描述，≤50字）、relationship_note（关系背景，≤80字）、recent_events（最近重要事件，≤100字）。只输出 JSON 对象，不要任何其他文字。`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.3, maxTokens: 300,
    });
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const p = JSON.parse(content.slice(start, end + 1));
    return {
      stage: typeof p.stage === 'string' && p.stage ? p.stage : '未知',
      personality: typeof p.personality === 'string' ? p.personality.slice(0, 50) : '',
      relationship_note: typeof p.relationship_note === 'string' ? p.relationship_note.slice(0, 80) : '',
      recent_events: typeof p.recent_events === 'string' ? p.recent_events.slice(0, 100) : '',
    };
  } catch (e: any) {
    console.warn('extractProfile failed:', e.message);
    return null;
  }
}

// ============================================================
// [v7] 套路提炼：从检索到的惯例/魔术/玩法类资料中解析可执行步骤
//   特征预检（含惯例/魔术/玩法/步骤等词）→ LLM 输出 JSON {name,goal,steps}
//   steps < 2 或未命中特征 → 返回 null（不启动套路）
// ============================================================
const STRATEGY_HINT_RE = /惯例|魔术|玩法|套路|步骤|操作|流程|布局|开场|进阶|收尾|推拉|框架|冷读/;
const STRATEGY_MAX_STEPS = 6;

async function extractStrategy(
  llmKey: string, llmBase: string, llmModel: string,
  kbItems: any[], query: string
): Promise<StrategyState | null> {
  const texts = (Array.isArray(kbItems) ? kbItems : [])
    .map((i) => `${i.title || ''}\n${i.content || ''}`)
    .join('\n');
  if (!texts || !STRATEGY_HINT_RE.test(texts)) return null;

  const prompt = `你是恋爱聊天"惯例/玩法"提炼助手。用户正在替自己回复对方，当前对方的话：「${truncateText(query, 60)}」。\n`
    + `以下是检索到的资料：\n${truncateText(texts, 2400)}\n`
    + `要求：如果资料中存在"分步骤、可执行"的聊天惯例/魔术/玩法（例如灵魂沟通、推拉、冷读、惯例开场、邀约流程等），提炼成步骤序列。\n`
    + `输出 JSON：{"name":"惯例名称(≤10字)","goal":"目标(≤30字)","steps":["第1步...","第2步..."]}，steps 2-6 步，每步一句话、具体可操作、面向"替用户给对方发消息"的执行视角。\n`
    + `如果资料中没有可执行的惯例，只输出 {"name":"","steps":[]}。只输出 JSON，不要任何其他文字。`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.2, maxTokens: 400,
    });
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const p = JSON.parse(content.slice(start, end + 1));
    const steps = (Array.isArray(p.steps) ? p.steps : [])
      .map((s: any) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s: string) => s.length > 0)
      .slice(0, STRATEGY_MAX_STEPS);
    const name = typeof p.name === 'string' ? p.name.slice(0, 10) : '';
    const goal = typeof p.goal === 'string' ? p.goal.slice(0, 30) : '';
    if (!name || steps.length < 2) return null;
    return {
      name, goal, steps,
      rounds_used: 0,
      max_rounds: Math.max(steps.length * 2, 6),
      started_at: new Date().toISOString(),
    };
  } catch (e: any) {
    console.warn('extractStrategy failed:', e.message);
    return null;
  }
}

// ============================================================
// [v6 L2/L3] system 提示词组装
// 顺序：全局提示词 > 场景指令 > 用户简介 > 记忆卡 > 更早摘要 > 知识库参考 > 格式约束
// ============================================================
function buildSystemContent(opts: {
  systemPrompt: string;
  userBio: string;
  memoryCard: MemoryCard | null;
  olderSummary: string;
  kbItems: any[];
  kbFallback: boolean;
}): string {
  let s = opts.systemPrompt || '你是一位专业的恋爱聊天指导助手，请根据用户的描述给出自然、得体、可复制的回复建议。';

  // 场景指令（L3：按关系阶段注入指导）
  const stage = opts.memoryCard?.profile?.stage || '';
  if (stage && STAGE_HINTS[stage]) {
    s += `\n\n【当前关系阶段】${STAGE_HINTS[stage]}`;
  }

  // 用户简介
  if (opts.userBio && opts.userBio.trim()) {
    s += `\n\n【用户个人简介】（对话中请结合以下用户信息给出更个性化的建议）\n${opts.userBio.trim()}`;
  }

  // 记忆卡：对方画像
  const profile = opts.memoryCard?.profile;
  if (profile && (profile.personality || profile.relationship_note || profile.recent_events)) {
    const parts: string[] = [];
    if (profile.personality) parts.push(`性格：${profile.personality}`);
    if (profile.relationship_note) parts.push(`关系背景：${profile.relationship_note}`);
    if (profile.recent_events) parts.push(`最近事件：${profile.recent_events}`);
    s += `\n\n【对方画像记忆】（跨轮次记住，回答时不要重复询问这些已知信息）\n${parts.join('\n')}`;
  }

  // 记忆卡：对方近期说过的话
  const msgs = opts.memoryCard?.recent_user_messages || [];
  if (msgs.length > 0) {
    s += `\n\n【对方近期说过的话】（供判断语感与关系状态）\n${msgs.slice(-8).join('\n')}`;
  }

  // 更早对话摘要
  if (opts.olderSummary) {
    s += `\n\n${opts.olderSummary}`;
  }

  // 知识库参考
  if (opts.kbItems.length > 0) {
    const kbText = opts.kbItems
      .map((item, i) => `【参考资料 ${i + 1}】${item.title}\n${item.content || ''}`)
      .join('\n\n');
    s += `\n\n以下是从知识库检索到的参考资料，回答时优先参考这些资料的内容和风格：\n${kbText}`;
    if (opts.kbFallback) {
      s += '\n\n（注：本次检索接口异常，参考资料按标题匹配，可能不完全相关）';
    }
  }

  // [v7] 套路执行指令：方向盘优先，检索为弹药，输出不提步骤/进度
  const strategy = opts.memoryCard?.strategy;
  if (strategy && Array.isArray(strategy.steps) && strategy.steps.length > 0) {
    const stepText = strategy.steps.map((st, i) => `${i + 1}. ${st}`).join('\n');
    s += `\n\n【当前执行套路】你正在执行「${strategy.name}」惯例，目标：${strategy.goal}\n`
      + `执行步骤：\n${stepText}\n`
      + `执行规则（严格遵守）：\n`
      + `- 本套路决定对话方向，优先级高于检索到的参考资料；参考资料只作语言素材：方向一致就采用，方向冲突就忽略或只借鉴语气。\n`
      + `- 根据对方最新反应自然推进：先顺应对方，再把话题拉回套路方向，绝不生硬。\n`
      + `- 严禁向对方提及套路、步骤、进度、惯例、第几步等任何元信息，输出必须是可直接发送的自然消息。\n`
      + `- 当对方反应表明套路目标已达成或已失效时，自然收尾、平滑过渡到正常聊天，不要强行继续。`;
  }

  // 输出格式约束（L2）
  s += `\n\n【回复格式要求】（严格遵守）\n① 分析：1-2 句，结合对方画像与当前情况说明局面，用【分析】开头\n② 话术：1-3 条可直接复制发给对方的话，每条用"回复建议 N：xxx"，口语化、贴合当前关系阶段，像真人发消息\n③ 提示：1 条简短行动建议（可选），用【小提示】开头`;

  return s;
}

// ============================================================
// [v6] LLM 统一调用（OpenAI 兼容）
// ============================================================
async function llmChat(
  llmKey: string, llmBase: string, llmModel: string,
  messages: any[], opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const resp = await fetch(`${llmBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: llmModel,
      messages,
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 1200,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM 返回内容为空');
  }
  return content.trim();
}

// ============================================================
// [v6 L1] 检索知识库（多查询）并拉取前 KB_REF_COUNT 条原文
//   queries: 搜索词列表（改写/原句 + 关键词）
//   内部 searchKb 按"多词命中次数"排序去重
// ============================================================
async function searchKbAndFetch(clientId: string, apiKey: string, kbId: string, queries: string[], history?: any[], systemPrompt?: string): Promise<any[]> {
  const items = await searchKb(clientId, apiKey, kbId, queries, history, systemPrompt);
  if (items.length === 0) return [];
  return fetchItemsContent(clientId, apiKey, items.slice(0, KB_REF_COUNT));
}

// ============================================================
// 对条目批量拉取 markdown 原文
// ============================================================
async function fetchItemsContent(clientId: string, apiKey: string, items: any[]): Promise<any[]> {
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      content: await fetchDocContent(clientId, apiKey, item),
    }))
  );
}

// ============================================================
// 知识库内容拼装回复（无 LLM 时的降级路径）
// ============================================================
function assembleKbReply(items: any[], usedFallbackBrowse: boolean): string {
  const lines: string[] = [usedFallbackBrowse
    ? '（检索服务异常，已按标题匹配到知识库相关资料，给你参考：）'
    : '根据知识库的资料，给你参考：', ''];
  items.forEach((item, i) => {
    lines.push(`【建议 ${i + 1}】${item.title}`);
    const summary = item.content || '';
    if (summary) {
      lines.push(summary);
    } else {
      lines.push('（可在 IMA 知识库中查看该文档全文）');
    }
    lines.push('');
  });
  lines.push('结合实际情况灵活回应。');
  return lines.join('\n');
}

// ============================================================
// 回退浏览：递归遍历知识库（含子文件夹），bigram 标题匹配
// ============================================================
async function browseKbByTitle(clientId: string, apiKey: string, kbId: string, query: string): Promise<any[]> {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];

  const all: any[] = [];

  async function walk(folderId: string): Promise<void> {
    try {
      const body: any = { knowledge_base_id: kbId, cursor: '', limit: 100 };
      if (folderId) body.folder_id = folderId;
      const data = await callIma(clientId, apiKey, 'get_knowledge_list', body);
      const list = data?.knowledge_list || [];
      for (const item of list) {
        if (item.media_type === 99) {
          const fid = item.folder_id || item.media_id || '';
          if (fid) await walk(fid);
        } else {
          all.push(item);
        }
      }
    } catch (e: any) {
      console.error(`browse folder "${folderId}" failed:`, e.message);
    }
  }

  try { await walk(''); } catch (e: any) { console.error('browseKbByTitle error:', e.message); return []; }

  const matches = all.filter((item: any) => {
    if ([2, 6, 8, 10, 12, 16, 17, 18, 19].includes(item.media_type)) return false;
    const title = item.title || '';
    return keywords.some((k) => title.includes(k)) || (query.length > 1 && title.includes(query));
  });

  return matches.slice(0, KB_REF_COUNT);
}

// ============================================================
// 关键词提取：bigram（2字窗口）切词 → 双实义字优先 → top 5
// ============================================================
const STOP_CHARS = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));

function extractKeywords(query: string): string[] {
  const q = query.replace(SPLIT_RE, '');
  const bigrams: string[] = [];
  for (let i = 0; i + 2 <= q.length; i++) {
    bigrams.push(q.slice(i, i + 2));
  }

  const strict: string[] = [];
  const loose: string[] = [];
  for (const b of bigrams) {
    if (STOP_WORDS.has(b)) continue;
    const chars = b.split('');
    const realCount = chars.filter((c) => !STOP_CHARS.has(c)).length;
    if (realCount === 0) continue;
    if (realCount === 2) strict.push(b);
    else loose.push(b);
  }

  return [...new Set([...strict, ...loose])].slice(0, 5);
}

// ============================================================
// [v6 L1] 搜索知识库：多搜索词轮询，合并去重并按"命中词数"排序
//   每个词取前 2 条，总上限 8 条；hits 越多排越前
// ============================================================
async function searchKb(clientId: string, apiKey: string, kbId: string, queries: string[], history?: any[], systemPrompt?: string): Promise<any[]> {
  const map = new Map<string, { item: any; hits: number; order: number }>();
  let order = 0;

  for (const q of queries) {
    if (!q || q.length < 2) continue;
    if (map.size >= 8) break;

    try {
      const data = await callSearch(clientId, apiKey, kbId, q, history, systemPrompt);
      const list = (data?.info_list || []).slice(0, 2);
      for (const item of list) {
        if (item.media_type === 99) continue;
        if ([2, 6, 8, 10, 12, 16, 17, 18, 19].includes(item.media_type)) continue;
        const key = item.media_id;
        if (map.has(key)) {
          map.get(key)!.hits += 1;
        } else {
          map.set(key, { item, hits: 1, order: order++ });
        }
      }
    } catch (e: any) {
      console.error(`search "${q}" failed:`, e.message);
    }
  }

  const sorted = [...map.values()].sort((a, b) => b.hits - a.hits || a.order - b.order);
  return sorted.map((v) => v.item);
}

// ============================================================
// search_knowledge 统一调用（带 history/system_prompt 透传 + 容错回退）
// ============================================================
async function callSearch(clientId: string, apiKey: string, kbId: string, q: string, history?: any[], systemPrompt?: string): Promise<any> {
  const baseBody: any = { query: q, knowledge_base_id: kbId, cursor: '' };

  const hasHistory = Array.isArray(history) && history.length > 0 &&
    history.every((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
  const hasPrompt = typeof systemPrompt === 'string' && systemPrompt.trim() !== '';

  if (!hasHistory && !hasPrompt) {
    return callIma(clientId, apiKey, 'search_knowledge', baseBody);
  }

  const extraBody = { ...baseBody };
  if (hasHistory) extraBody.history = history.slice(-RECENT_FULL); // 最多携带最近 10 条
  if (hasPrompt) extraBody.system_prompt = systemPrompt;

  try {
    return await callIma(clientId, apiKey, 'search_knowledge', extraBody);
  } catch (e: any) {
    console.warn(`IMA search with extra params failed (${e.message}), retry without extra params`);
    return callIma(clientId, apiKey, 'search_knowledge', baseBody);
  }
}

// ============================================================
// 获取 markdown 文档原文
// ============================================================
async function fetchDocContent(clientId: string, apiKey: string, item: any): Promise<string> {
  try {
    const data = await callIma(clientId, apiKey, 'get_media_info', { media_id: item.media_id });
    const urlInfo = data?.url_info;
    if (!urlInfo?.url) return '';

    const resp = await fetch(urlInfo.url, {
      headers: urlInfo.headers || {},
    });
    if (!resp.ok) return '';
    const text = await resp.text();
    return cleanMarkdown(text);
  } catch (e: any) {
    console.error('fetch content failed:', e.message);
    return '';
  }
}

// ============================================================
// Markdown 清洗：去 frontmatter、站点导航、标记符号、截断
// [v6 L0] 截断 260 → KB_CONTENT_MAX(500)
// ============================================================
const NAV_LINES = ['首页', '恋爱话术资源社区', '下载APP', '登录 / 注册', '个人中心', '我的书架', '我的话术', '退出登录', '当前位置', '情感文章'];

function cleanMarkdown(text: string): string {
  let t = text;

  if (t.startsWith('---')) {
    const end = t.indexOf('\n---', 3);
    if (end !== -1) t = t.slice(end + 4);
  }

  t = t.split('\n').filter((line) => {
    const l = line.trim();
    if (!l) return true;
    if (NAV_LINES.some((n) => l.includes(n))) return false;
    if (/^(更新时间|更新日期|阅读数|责任编辑|来源|发布于)/.test(l)) return false;
    return true;
  }).join('\n');

  t = t
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.、)]\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (t.length > KB_CONTENT_MAX) {
    const cut = t.slice(0, KB_CONTENT_MAX);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
    if (lastPunct > 80) {
      return cut.slice(0, lastPunct + 1) + '……';
    }
    return cut + '……';
  }
  return t;
}

// ============================================================
// 工具函数
// ============================================================
function truncateText(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '……';
}

function mergeDedup(items: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const it of items) {
    if (!it || !it.media_id || seen.has(it.media_id)) continue;
    seen.add(it.media_id);
    out.push(it);
  }
  return out;
}

// ============================================================
// [v3.1] 从 app_config 读取统一提示词（service_role，绕过 RLS）
// ============================================================
async function fetchSystemPrompt(supabaseUrl: string, serviceRoleKey: string): Promise<string> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/app_config?id=eq.1&select=system_prompt`,
      { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
    );
    if (!resp.ok) {
      console.warn('fetchSystemPrompt failed:', resp.status);
      return '';
    }
    const rows = await resp.json();
    return (rows?.[0]?.system_prompt) || '';
  } catch (e: any) {
    console.warn('fetchSystemPrompt error:', e.message);
    return '';
  }
}

// ============================================================
// IMA OpenAPI 统一调用
// ============================================================
async function callIma(clientId: string, apiKey: string, apiPath: string, body: any): Promise<any> {
  const resp = await fetch(`${IMA_BASE}/openapi/wiki/v1/${apiPath}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': clientId,
      'ima-openapi-apikey': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`IMA ${apiPath} HTTP ${resp.status}`);
  }

  const json = await resp.json();
  if (json?.code !== 0) {
    throw new Error(`IMA ${apiPath} code=${json?.code} msg=${json?.msg}`);
  }
  return json?.data || null;
}
