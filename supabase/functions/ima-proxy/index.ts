// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理 (v10)
//
// 功能：接收前端请求 → 校验用户状态 → 检索 IMA 知识库 → 生成专业回复
//
// [v10 思考模式]（DeepSeek V4，2026-08）
//   - 模型升级 deepseek-chat → deepseek-v4-flash（旧名 2026-07-24 已弃用）
//   - 新增 thinking_mode 四档：off(普通) / low(轻度) / high(中度) / max(深度)
//   - V4 模型思考模式默认开启！llmChat 必须显式控制：
//     off → thinking:{type:'disabled'}（快、便宜，保留 temperature/惩罚参数）
//     low/high/max → thinking:{type:'enabled'} + reasoning_effort（思考档不传
//     temperature/惩罚系数，官方强制不生效；max_tokens 自动提到 2000+ 防思维链挤占）
//   - 优先级：请求体 thinking_mode > app_config.llm_params.thinking_mode > off
//   - 内部辅助调用（rewriteQuery/语义拆解/定向摘要/画像提取/套路提炼）保持显式
//     disabled：检索辅助任务开思考只会变慢变贵
//   - _debug 新增 thinking_mode 便于验证
//
// [v9 记忆与自洽修复]（解决"重复说过的话"与"逻辑自相矛盾"）
//   - 记忆卡新增 recent_self_messages：记录军师(自己)发过的话（按 session_id 隔离），
//     窗口 history 丢失后 AI 仍知道自己说过什么 → 防重复开场白
//   - 角色定位硬编码"你即用户本人"（不依赖后台提示词），顾问视角 → 参与者视角
//   - system 新增自洽硬约束：严禁自相矛盾/推翻自己/答非所问；先正面回应再转折
//   - 输出放宽为 1-2 句（第一句正面回应，第二句才允许转折）
//   - 参考资料降级为"弹药"：与已有对话冲突时以对话连续性为准
//   - 主回复生成后做 bigram 相似度兜底：与"自己发过的话"高相似 → 带提示重生成一次
//   - _debug 新增 self_msgs_len 便于验证
//
// [v8 语义拆解检索]（词表约束 + few-shot，替代"整句直搜"）
//   - TOPIC_VOCAB 领域词表 91 词：主题词 4 类 41 词 + 技巧术语 50 词
//     （由本地 4379 篇知识库全文 bigram 高频统计 + LLM 特征段落提炼合成）
//   - extractSemanticKeywords：LLM 把对方的话拆解为 3-5 个 2-5 字检索词
//     （词表词优先 + 少量贴近原话的字面词），输出 JSON 数组
//   - 首轮检索词顺序：语义词 > bigram 字面词 > 原句垫底
//   - rewriteQuery 降级为"语义拆解失败且规则词不足"时才触发
//   - _debug 新增 semantic_kws 便于验证
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
//   thinking_mode  可选 思考模式档位 off|low|high|max（优先级 > 后台默认）
//
// 环境变量：IMA_API_KEY, IMA_CLIENT_ID, IMA_KNOWLEDGE_BASE_ID, FREE_TRIES,
//           LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
// ============================================================

const IMA_BASE = 'https://ima.qq.com';

// [v10 思考模式] 档位类型与合法集合（优先级：请求体 > 后台默认 > off）
type ThinkingMode = 'off' | 'low' | 'high' | 'max';
const THINKING_MODES = new Set<string>(['off', 'low', 'high', 'max']);
const THINKING_MAX_TOKENS = 2000; // 思考档输出预算下限：防思维链挤占最终回复

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

// [v8] 领域词表：知识库主题检索词（本地 4379 篇全文 bigram 高频统计 + LLM 特征段落提炼）
//   主题词 4 类（情绪/关系阶段/场景需求/对方性格）+ 技巧术语，共 91 词
const TOPIC_VOCAB: string[] = [
  // 情绪状态
  '低落', '委屈', '生气', '难过', '伤心', '敷衍', '高冷', '冷淡', '忽冷忽热', '开心',
  // 关系阶段
  '追求', '暧昧', '恋爱', '挽回', '异地', '吵架', '冷战', '分手', '复合', '暗恋', '相亲',
  // 场景需求
  '安慰', '哄', '道歉', '解释', '试探', '邀约', '表白', '约会', '见面', '聊天', '回复', '追问',
  // 对方性格
  '慢热', '内向', '外向', '强势', '粘人', '傲娇', '独立', '海王',
  // 技巧术语
  '框架', '惯例', '服从性测试', '推拉', '欲擒故纵', '情绪价值', '冷读', '废物测试',
  '三明治夸奖', '进挪', '角色扮演', '开场白', '打压', '搭讪', '展示面', '二次吸引',
  '模糊邀约', '预选', '需求感', '跪舔', '冷冻', '兴趣指标', '推倒', '暧昧',
  '查户口', '试探', '引导', '高价值', '调戏', '侧面展示', '假性分手', '长期吸引',
  '短期吸引', '建立吸引', '升级关系', '关系推进', '主导权', '服从命令', '筛选话术',
  '暴露需求感', '第三方话题', '逗比话题', '男神框架', '设置陷阱', '表情包开场',
  '情感浓度', '心理锚定', '一推一拉', '冷读术', '吸引阶段',
];

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
    const { query, knowledge_base_id, history, system_prompt, session_id, thinking_mode: reqThinkingMode } = await req.json();
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

    // [v7] 读取 app_config：统一提示词兜底 + LLM 生成参数（后台可调）
    const appConfig = await fetchAppConfig(supabaseUrl, serviceRoleKey);
    let effectivePrompt = (typeof system_prompt === 'string') ? system_prompt : '';
    if (!effectivePrompt.trim()) effectivePrompt = appConfig.system_prompt;
    const llmParams = appConfig.llm_params;

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
    // [v10] 模型升级：deepseek-chat 已于 2026-07-24 弃用，V4 思考/非思考都走 deepseek-v4-flash
    const llmModel = Deno.env.get('LLM_MODEL') || 'deepseek-v4-flash';

    // [v10] 思考模式生效档位：请求体 > 后台默认 > off（非法值一律回退，不信任输入）
    let effectiveThinkingMode: ThinkingMode = llmParams.thinking_mode;
    if (typeof reqThinkingMode === 'string' && THINKING_MODES.has(reqThinkingMode)) {
      effectiveThinkingMode = reqThinkingMode as ThinkingMode;
    }

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
    let kbFolders: { hs: string | null; jx: string | null } = { hs: null, jx: null };
    // [v8] 语义拆解词（if 块外声明：_debug 在块外引用，块内 let 会 ReferenceError → 500）
    let semanticKws: string[] = [];

    // ---- 知识库检索（L1 增强） ----
    if (imaKey && imaClientId && kbId) {
      try {
        // [v7] 知识库文件夹识别（话术=hs / 教学=jx），用于检索配额平衡
        kbFolders = await fetchKbFolders(imaClientId, imaKey, kbId);
        // 配额：套路执行期话术为主(3)教学兜底(2)；未启动期教学为主(3)话术兜底(2)，
        //   保证两类内容始终同在上下文——话术加权不消灭策略素材
        const quotaOpts = {
          hsFolder: kbFolders.hs,
          jxFolder: kbFolders.jx,
          strategyActive: !!memoryCard?.strategy,
        };

        // [v8] 1. LLM 语义拆解（词表约束 + few-shot）→ 知识库主题检索词
        const kw = extractKeywordsFromHistory(history, query);
        if (llmKey) {
          semanticKws = await extractSemanticKeywords(llmKey, llmBase, llmModel, query, recentUserMessages);
        }
        // [v8] 2. 条件 query rewrite 降级：仅当语义拆解失败 且 规则词不足时触发
        let searchQuery = query.trim();
        if (semanticKws.length === 0 && kw.length < 2 && llmKey) {
          const rw = await rewriteQuery(llmKey, llmBase, llmModel, query, recentUserMessages);
          if (rw) { searchQuery = rw; usedRewrite = true; }
        }
        // [v8] 3. 首轮检索词顺序：语义词 > bigram 字面词 > 原句垫底
        //   （内部按 hits 排序去重，前 5 条拉原文）
        const searchQueries = [...semanticKws, ...kw, searchQuery];
        // [v7] 定向摘要精读：LLM 可用时对长文档做"针对当前问题"的摘要，替代硬截断
        const kbSummaryOpts = llmKey
          ? { llm: { key: llmKey, base: llmBase, model: llmModel, question: query } }
          : undefined;
        kbItems = await searchKbAndFetch(imaClientId, imaKey, kbId, searchQueries, llmHistory, effectivePrompt, { ...quotaOpts, ...kbSummaryOpts });
        // 4. 第二轮：不足 2 条时用"仅历史"关键词补搜
        if (kbItems.length < 2) {
          const kw2 = extractKeywordsFromHistory(history, '', true).filter((k) => !kw.includes(k)).slice(0, 3);
          if (kw2.length > 0) {
            const items2 = await searchKbAndFetch(imaClientId, imaKey, kbId, kw2, llmHistory, effectivePrompt, { ...quotaOpts, ...kbSummaryOpts });
            const merged = mergeDedup([...kbItems, ...items2]).slice(0, KB_REF_COUNT);
            if (merged.length > kbItems.length) kbItems = merged;
          }
        }
        // 5. 浏览回退：标题匹配
        if (kbItems.length === 0) {
          const browseItems = await browseKbByTitle(imaClientId, imaKey, kbId, searchQuery || query);
          if (browseItems.length > 0) {
            kbItems = await fetchItemsContent(imaClientId, imaKey, browseItems.slice(0, KB_REF_COUNT), kbSummaryOpts);
            kbFallback = true;
          }
        }
        hitKnowledge = kbItems.length > 0;

        // [v7] 套路启动（独立惯例检索通道）：当前无套路 + 用户未打断 → 专门检索惯例/魔术/玩法类内容，
        //   LLM 提炼步骤启动套路；结果仅用于启动，不混入主回复参考（话术加权不影响套路启动素材）
        if (llmKey && !strategyClear && !memoryCard?.strategy) {
          try {
            const convItems = await searchKbAndFetch(
              imaClientId, imaKey, kbId,
              ['惯例', '推拉', '冷读', '开场白', '步骤'],
              llmHistory, effectivePrompt, { ...quotaOpts, pickCount: 5 }
            );
            if (convItems.length > 0) {
              const st = await extractStrategy(llmKey, llmBase, llmModel, convItems, query);
              if (st) {
                memoryCard = { ...(memoryCard || {}), strategy: st };
                quotaOpts.strategyActive = true; // 本轮起按执行期配额
              }
            }
          } catch (e: any) {
            console.warn('strategy bootstrap failed:', e.message);
          }
        }
      } catch (e: any) {
        console.error('知识库检索失败:', e.message);
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
        reply = await llmChat(llmKey, llmBase, llmModel, messages, {
          temperature: llmParams.temperature,
          maxTokens: llmParams.max_tokens,
          frequencyPenalty: llmParams.frequency_penalty,
          presencePenalty: llmParams.presence_penalty,
          thinking: effectiveThinkingMode,
        });
        // [v9] 防重复兜底：与"自己发过的话"高相似 → 带提示重生成一次
        const selfMsgs = Array.isArray(memoryCard?.recent_self_messages) ? memoryCard.recent_self_messages : [];
        if (reply && selfMsgs.length > 0 && isNearDuplicate(reply, selfMsgs)) {
          const retry = await llmChat(llmKey, llmBase, llmModel, [
            { role: 'system', content: systemContent + '\n\n注意：你刚才生成的那句话与【你之前发过的话】重复了。严禁重复，必须换一句全新的、意思不重复的说法。直接输出新的话术本体。' },
            ...llmHistory,
            { role: 'user', content: query.trim() },
          ], {
            temperature: llmParams.temperature,
            maxTokens: llmParams.max_tokens,
            frequencyPenalty: llmParams.frequency_penalty,
            presencePenalty: llmParams.presence_penalty,
            thinking: effectiveThinkingMode,
          });
          if (retry) reply = retry;
        }
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
        semantic_kws: semanticKws,
        thinking_mode: effectiveThinkingMode,
        memory_stage: memoryCard?.profile?.stage || null,
        self_msgs_len: Array.isArray(memoryCard?.recent_self_messages) ? memoryCard.recent_self_messages.length : 0,
        strategy_name: memoryCard?.strategy?.name || null,
        strategy_rounds: memoryCard?.strategy?.rounds_used ?? null,
        strategy_clear: strategyClear,
        folder_hs: !!kbFolders?.hs,
        folder_jx: !!kbFolders?.jx,
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
// [v9] 与"自己发过的话"的字面相似度检测（防重复兜底）
//   bigram 命中比例 ≥0.85 或一字不差 → 判定重复，触发重生成
// ============================================================
function isNearDuplicate(text: string, prev: string[]): boolean {
  const t = text.trim();
  if (!t) return false;
  const gram = (str: string, n: number): string[] => {
    const s = str.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const out: string[] = [];
    for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
    return out;
  };
  const tg = gram(t, 2);
  if (tg.length === 0) return false;
  const tset = new Set(tg);
  for (const p of prev) {
    if (!p || !p.trim()) continue;
    if (p.trim() === t) return true;
    const pg = gram(p, 2);
    if (pg.length === 0) continue;
    let hit = 0;
    for (const g of pg) if (tset.has(g)) hit++;
    if (hit / Math.max(pg.length, 1) >= 0.85 || hit / tset.size >= 0.85) return true;
  }
  return false;
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
// [v8] LLM 语义拆解：把"对方说的话"拆成知识库主题检索词
//   词表约束（TOPIC_VOCAB 优先）+ few-shot 样板（字面词+词表词混合）
//   输出 3-5 个 2-5 字中文词；失败/无结果返回 []，上层降级为 bigram/原句
// ============================================================
const SEMANTIC_KW_MAX = 5;
const SEMANTIC_KW_MIN = 3;
const KW_LEN_MAX = 5;   // IMA search_knowledge 对长词掉命中，拆解词控制在 5 字内

async function extractSemanticKeywords(
  llmKey: string, llmBase: string, llmModel: string,
  query: string, recentUserMsgs: string[]
): Promise<string[]> {
  try {
    const prompt = '你是恋爱话术检索助手，负责把"对方说的话"拆解成适合检索恋爱资料库的短关键词。\n'
      + `对方的话：「${truncateText(query, 80)}」\n`
      + (recentUserMsgs.length > 0 ? `最近对话（对方说的）：\n${recentUserMsgs.slice(-2).join('\n')}\n` : '')
      + `知识库领域词表（检索词应优先从中选择，可少量自创补充）：\n${TOPIC_VOCAB.join('、')}\n`
      + '示例：\n'
      + '输入："她说今天被领导骂了很难受"\n输出：["被骂","委屈","哄","工作压力","情绪低落"]\n'
      + '输入："她两天没回我消息了"\n输出：["不回消息","高冷","试探","冷落","追问"]\n'
      + `要求：只输出 JSON 数组（如 ["推拉","试探"]），${SEMANTIC_KW_MIN}-${SEMANTIC_KW_MAX} 个词，每个词 2-${KW_LEN_MAX} 字；`
      + '优先使用词表中的词，可加 1-2 个贴近原话的字面词；不要任何解释文字。';
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.2, maxTokens: 150,
    });
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const arr = JSON.parse(content.slice(start, end + 1));
    const kws: string[] = [];
    for (const w of arr) {
      if (typeof w !== 'string') continue;
      const t = w.trim();
      if (t.length < 2 || t.length > KW_LEN_MAX) continue;
      if (!/[\u4e00-\u9fa5]/.test(t)) continue; // 只收中文词（IMA 中文检索）
      if (STOP_WORDS.has(t)) continue;
      kws.push(t);
    }
    return [...new Set(kws)].slice(0, SEMANTIC_KW_MAX);
  } catch (e: any) {
    console.warn('extractSemanticKeywords failed:', e.message);
    return [];
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
  // [v9] 军师(自己)发过的话：窗口 history 丢失后仍能知道自己说过什么，防重复（按 session_id 隔离）
  recent_self_messages?: string[];
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

  // [v9] 1.5) 规则追加军师(自己)发过的话（防重复：AI 需知道自己上一条说了什么）
  const lastSelf = [...(Array.isArray(ctx.history) ? ctx.history : [])]
    .reverse().find((h) => h && h.role === 'assistant' && typeof h.content === 'string');
  const selfMsgs = Array.isArray(card.recent_self_messages) ? card.recent_self_messages.slice() : [];
  if (lastSelf && (selfMsgs.length === 0 || selfMsgs[selfMsgs.length - 1] !== lastSelf.content)) {
    selfMsgs.push(truncateText(lastSelf.content, 200));
    if (selfMsgs.length > 20) selfMsgs.splice(0, selfMsgs.length - 20);
    card.recent_self_messages = selfMsgs;
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
  // [v9] 角色定位硬编码"本人"（最高优先级，覆盖后台提示词的顾问视角）：
  //   解决"顾问不需要人设一致"导致的答非所问与自相矛盾
  let s = '【角色定位】(最高优先级)\n'
    + '你正在扮演「用户本人」用交友app跟对方聊天，你就是那个说话的人，不是顾问、不是助手。\n'
    + '你之前发出的每句话都是既定事实，后续回复必须与之衔接一致：不重复、不推翻、不自相矛盾。\n\n'
    + (opts.systemPrompt || '你是一位专业的恋爱聊天指导助手，请根据用户的描述给出自然、得体、可复制的回复建议。');

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

  // [v9] 记忆卡：军师(自己)发过的话（防重复 + 保自洽；窗口 history 丢失后仍有效）
  const selfMsgs = opts.memoryCard?.recent_self_messages || [];
  if (selfMsgs.length > 0) {
    s += `\n\n【你之前发过的话】（跨轮次记住，严禁原样或意思重复，后续回复必须与之一致衔接）\n${selfMsgs.slice(-8).join('\n')}`;
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
    // [v9] 参考资料降级为"弹药"：只提供语气/角度/措辞，冲突时以对话连续性为准
    s += `\n\n以下是从知识库检索到的参考资料。它们只是弹药：仅提供语气、角度、措辞素材；\n当参考内容与你之前说过的话或当前对话逻辑冲突时，以对话上下文为准，忽略参考。\n${kbText}`;
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

  // [v9] 自洽 + 输出要求：先正面回应再转折，严禁自相矛盾/重复；放宽为 1-2 句
  s += `\n\n【自洽与输出要求】（严格遵守）\n`
    + `- 你是同一个人，必须逻辑自洽：严禁自相矛盾、严禁推翻自己说过的话、严禁答非所问。\n`
    + `- 对方问什么，第一句必须正面回答；想幽默或转折，必须先正面回应再转折。\n`
    + `- 严禁重复你之前发过的任何一句话（含意思相近的说法）。\n`
    + `- 输出 1-2 句话术本体，可直接复制发给对方；不要输出【分析】【建议】、序号、步骤、进度、括号说明等任何附加内容；口语化、贴合当前关系阶段，像真人发微信。`;

  return s;
}

// ============================================================
// [v6] LLM 统一调用（OpenAI 兼容）
// [v10] 思考模式三态控制：
//   - thinking='off'（默认）：显式 thinking:{type:'disabled'} + 传 temperature/惩罚参数
//     （V4 模型思考模式默认开启，必须显式禁用，否则内部辅助调用也会悄悄思考）
//   - thinking=low/high/max：thinking:{type:'enabled'} + reasoning_effort；
//     思考档下 temperature/惩罚系数官方强制不生效，不传；max_tokens 提到 ≥2000
//   - 兼容旧模型（deepseek-chat 等非 V4）：不传 thinking 字段，维持原行为
// ============================================================
async function llmChat(
  llmKey: string, llmBase: string, llmModel: string,
  messages: any[], opts: { temperature?: number; maxTokens?: number; frequencyPenalty?: number; presencePenalty?: number; thinking?: ThinkingMode } = {}
): Promise<string> {
  const thinking = opts.thinking ?? 'off';
  const isV4 = /v4/.test(llmModel);
  const body: any = {
    model: llmModel,
    messages,
  };
  if (isV4 && thinking !== 'off') {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = thinking;
    // 思考模式：temperature / top_p / presence_penalty / frequency_penalty 不生效（官方强制）
    body.max_tokens = Math.max(opts.maxTokens ?? 1200, THINKING_MAX_TOKENS);
  } else {
    if (isV4) body.thinking = { type: 'disabled' }; // V4 默认开思考，非思考档显式关闭
    body.temperature = opts.temperature ?? 0.4;
    body.max_tokens = opts.maxTokens ?? 1200;
    body.frequency_penalty = opts.frequencyPenalty ?? 0.5;
    body.presence_penalty = opts.presencePenalty ?? 0;
  }
  const resp = await fetch(`${llmBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
//   [v7] opts：{hsFolder,jxFolder,strategyActive,pickCount} 状态感知配额
// ============================================================
async function searchKbAndFetch(clientId: string, apiKey: string, kbId: string, queries: string[], history?: any[], systemPrompt?: string, opts?: {
  hsFolder?: string | null;
  jxFolder?: string | null;
  strategyActive?: boolean;
  pickCount?: number;
  llm?: { key: string; base: string; model: string; question: string };
}): Promise<any[]> {
  const items = await searchKb(clientId, apiKey, kbId, queries, history, systemPrompt);
  if (items.length === 0) return [];
  const picked = opts ? applyQuota(items, opts) : items.slice(0, KB_REF_COUNT);
  return fetchItemsContent(clientId, apiKey, picked, opts?.llm ? { llm: opts.llm } : undefined);
}

// ============================================================
// [v7] 状态感知配额：话术/教学两类内容按 strategy 状态分桶选取，
//   保证"话术加权"不消灭策略素材——两类始终同在上下文，LLM 自行取舍
//   执行期：话术 ≤3 + 教学 ≤2；未启动期：教学 ≤3 + 话术 ≤2
// ============================================================
function applyQuota(items: any[], opts: { hsFolder?: string | null; jxFolder?: string | null; strategyActive?: boolean; pickCount?: number }): any[] {
  const count = opts.pickCount || KB_REF_COUNT;
  const hs = opts.hsFolder;
  const jx = opts.jxFolder;
  if (!hs && !jx) return items.slice(0, count);

  const hsList: any[] = [];
  const jxList: any[] = [];
  const otherList: any[] = [];
  for (const it of items) {
    const pid = it.parent_folder_id || '';
    if (hs && pid === hs) hsList.push(it);
    else if (jx && pid === jx) jxList.push(it);
    else otherList.push(it);
  }

  const hsQuota = opts.strategyActive ? 3 : 2;
  const jxQuota = opts.strategyActive ? 2 : 3;
  const picked = [
    ...hsList.slice(0, Math.min(hsQuota, count)),
    ...jxList.slice(0, Math.min(jxQuota, count)),
    ...otherList,
  ];
  return picked.slice(0, count);
}

// ============================================================
// [v7] 知识库文件夹识别：递归遍历，按名称匹配
//   返回 {hs:话术文件夹id, jx:教学文件夹id}，识别不到则为 null（降级不配额）
// ============================================================
async function fetchKbFolders(clientId: string, apiKey: string, kbId: string): Promise<{ hs: string | null; jx: string | null }> {
  const res: { hs: string | null; jx: string | null } = { hs: null, jx: null };
  try {
    async function walk(folderId: string): Promise<void> {
      const body: any = { knowledge_base_id: kbId, cursor: '', limit: 50 };
      if (folderId) body.folder_id = folderId;
      const data = await callIma(clientId, apiKey, 'get_knowledge_list', body);
      const list = data?.knowledge_list || [];
      for (const item of list) {
        if (item.media_type === 99) {
          const fid = item.folder_id || item.media_id || '';
          const name = item.title || item.name || '';
          if (!res.hs && /话术|惯例/.test(name)) res.hs = fid;
          if (!res.jx && /教学|理论|课程/.test(name)) res.jx = fid;
          if (fid) await walk(fid);
        }
      }
    }
    await walk('');
  } catch (e: any) {
    console.warn('fetchKbFolders failed:', e.message);
  }
  return res;
}

// ============================================================
// 对条目批量拉取 markdown 原文
//   [v7] opts.llm 存在时：长文档（>KB_CONTENT_MAX）用 LLM 做
//   "定向摘要"（针对当前问题提取要点），替代硬截断 500 字
// ============================================================
async function fetchItemsContent(clientId: string, apiKey: string, items: any[], opts?: {
  llm?: { key: string; base: string; model: string; question: string };
}): Promise<any[]> {
  return Promise.all(
    items.map(async (item) => {
      const full = await fetchDocContent(clientId, apiKey, item);
      let content = full ? truncateText(full, KB_CONTENT_MAX) : '';
      if (opts?.llm?.key && full && full.length > KB_CONTENT_MAX) {
        const sum = await summarizeRef(opts.llm.key, opts.llm.base, opts.llm.model, opts.llm.question, item.title || '', full);
        if (sum) content = sum;
      }
      return { ...item, content };
    })
  );
}

// ============================================================
// [v7] 定向摘要精读：针对当前问题，从长文档中提取相关要点
//   替代"硬截断前 500 字"——长文档关键内容常在后段（如套路步骤）
//   返回摘要（≤320 字）；失败/无关时返回 null（上层降级为截断）
// ============================================================
async function summarizeRef(llmKey: string, llmBase: string, llmModel: string, question: string, title: string, fullText: string): Promise<string | null> {
  const prompt = `你是恋爱话术提炼助手。用户正要回复对方，对方的话：「${truncateText(question, 60)}」。\n`
    + `以下是从知识库检索到的资料【${title}】：\n${truncateText(fullText, 3500)}\n`
    + `要求：提取与当前问题直接相关的话术要点、可操作步骤或关键语句（若资料是惯例/套路类，把步骤序列提取出来），150-300 字。`
    + `直接输出要点，不要任何解释、标题或格式头；若资料与当前问题明显无关，只输出两个字：无关。`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.2, maxTokens: 400,
    });
    if (!content || content.includes('无关')) return null;
    return truncateText(content.trim(), 320);
  } catch (e: any) {
    console.warn('summarizeRef failed:', e.message);
    return null;
  }
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
      const body: any = { knowledge_base_id: kbId, cursor: '', limit: 50 };
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
// Markdown 清洗：去 frontmatter、站点导航、标记符号
// [v7] 不再在此截断——返回清洗后全文，
//   由 fetchItemsContent 统一做"定向摘要 / 截断"
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
// [v7] 从 app_config 读取统一提示词 + LLM 生成参数（service_role，绕过 RLS）
//   llm_params 存 JSON 字符串：{"temperature":0.4,"frequency_penalty":0.5,"presence_penalty":0,"max_tokens":1200,"thinking_mode":"off"}
// ============================================================
type LlmParams = {
  temperature: number;
  frequency_penalty: number;
  presence_penalty: number;
  max_tokens: number;
  thinking_mode: ThinkingMode;
};
const DEFAULT_LLM_PARAMS: LlmParams = { temperature: 0.4, frequency_penalty: 0.5, presence_penalty: 0, max_tokens: 1200, thinking_mode: 'off' };

async function fetchAppConfig(supabaseUrl: string, serviceRoleKey: string): Promise<{ system_prompt: string; llm_params: LlmParams }> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/app_config?id=eq.1&select=system_prompt,llm_params`,
      { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
    );
    const rows = resp.ok ? await resp.json() : [];
    const row = rows?.[0] || {};
    let raw: any = {};
    if (row.llm_params) {
      try { raw = JSON.parse(row.llm_params); } catch (e) { raw = {}; }
    }
    const num = (v: any, d: number) => (typeof v === 'number' && isFinite(v)) ? v : d;
    // [v10] thinking_mode：后台默认档（枚举校验，非法回退 off）
    const tm = (typeof raw.thinking_mode === 'string' && THINKING_MODES.has(raw.thinking_mode))
      ? raw.thinking_mode as ThinkingMode
      : DEFAULT_LLM_PARAMS.thinking_mode;
    return {
      system_prompt: (typeof row.system_prompt === 'string') ? row.system_prompt : '',
      llm_params: {
        temperature: Math.max(0, Math.min(2, num(raw.temperature, DEFAULT_LLM_PARAMS.temperature))),
        frequency_penalty: Math.max(0, Math.min(2, num(raw.frequency_penalty, DEFAULT_LLM_PARAMS.frequency_penalty))),
        presence_penalty: Math.max(0, Math.min(2, num(raw.presence_penalty, DEFAULT_LLM_PARAMS.presence_penalty))),
        max_tokens: Math.max(100, Math.min(8000, num(raw.max_tokens, DEFAULT_LLM_PARAMS.max_tokens))),
        thinking_mode: tm,
      },
    };
  } catch (e: any) {
    console.warn('fetchAppConfig failed:', e.message);
    return { system_prompt: '', llm_params: { ...DEFAULT_LLM_PARAMS } };
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
