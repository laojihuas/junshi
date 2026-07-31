// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理 (v2)
//
// 功能：接收前端请求 → 校验用户状态 → 检索 IMA 知识库 → 返回基于知识库内容的回复
//
// v2 改进（修复"答非所问"）：
//   1. 关键词提取：整句搜索命中率低，自动拆分为关键词多次搜索并合并去重
//   2. 内容获取：搜索结果命中 markdown 文档时，调用 get_media_info 拉取原文，
//      回复基于真实知识库内容，而非仅文档标题
//   3. 明确降级提示：未命中知识库时回复中标注，便于区分"知识库回复"与"通用建议"
//
// IMA API:
//   POST https://ima.qq.com/openapi/wiki/v1/search_knowledge
//   POST https://ima.qq.com/openapi/wiki/v1/get_media_info
//   Headers: ima-openapi-clientid, ima-openapi-apikey
//
// [v3 新增] 多窗口会话 + 统一提示词支持：
//   请求体新增可选参数 history（对话历史数组 [{role, content}]）
//   与 system_prompt（后台统一管理的系统提示词，前端用户不可见）。
//   二者随 search_knowledge 请求体透传给 IMA；
//   若 IMA 拒绝附加参数，自动回退为不带附加参数的原始调用，
//   保证原有功能不受影响。
//
// 环境变量：
//   IMA_API_KEY, IMA_CLIENT_ID, IMA_KNOWLEDGE_BASE_ID, FREE_TRIES
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
    // [v3] history: 本窗口对话历史数组（[{role, content}]），可为空
    //       system_prompt: 前端可选的统一提示词（用户不可见）
    // [v3.1] 统一提示词服务端兜底：无论前端是否传 system_prompt，
    //        服务端都会保证拿到"最新的统一提示词"——
    //        前端传了 → 使用前端值（实时获取，与后台一致）
    //        前端没传（旧版本前端）→ 服务端自动从 app_config 读取注入
    const { query, knowledge_base_id, history, system_prompt } = await req.json();
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

    // [v3.1] 统一提示词兜底：前端未提供时，服务端读取 app_config 注入
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

    // ---- IMA 凭证检查 ----
    const imaKey = Deno.env.get('IMA_API_KEY') || '';
    const imaClientId = Deno.env.get('IMA_CLIENT_ID') || '';

    let reply = '';
    let hitKnowledge = false;

    // [v4] 多级回复生成：
    //   1) 知识库参考：search_knowledge → 0命中时浏览回退（标题匹配），拉取原文
    //   2) LLM 生成：system_prompt(统一提示词) + history(会话上下文) + query(当前内容)
    //       + 知识库参考资料，一起发给 LLM，得到专业答复
    //   3) LLM 未配置/失败 → 知识库内容拼装
    //   4) 全部失败 → 通用建议
    // 多会话隔离：history 由前端按"窗口×好友"从 sessionStorage 传递，
    // ima-proxy 本身无状态，天然实现多用户多会话互不干扰。

    let kbItems: any[] = [];
    let kbFallback = false;
    if (imaKey && imaClientId && kbId) {
      try {
        // 1. 检索知识库（search → 浏览回退），前 3 条拉取原文
        kbItems = await searchKbAndFetch(imaClientId, imaKey, kbId, query.trim(), history, effectivePrompt);
        if (kbItems.length === 0) {
          const browseItems = await browseKbByTitle(imaClientId, imaKey, kbId, query.trim());
          if (browseItems.length > 0) {
            kbItems = await fetchItemsContent(imaClientId, imaKey, browseItems.slice(0, 3));
            kbFallback = true;
          }
        }
        hitKnowledge = kbItems.length > 0;
      } catch (e) {
        console.error('知识库检索失败:', e.message);
      }
    }

    // 2. LLM 生成专业答复（提示词 + 上下文 + 当前内容 + 知识库参考）
    const llmKey = Deno.env.get('LLM_API_KEY') || '';
    if (llmKey) {
      try {
        reply = await buildLlmReply(llmKey, effectivePrompt, history, query.trim(), kbItems, kbFallback);
      } catch (e) {
        console.error('LLM error:', e.message);
      }
    }

    // 3. LLM 未配置/失败 → 知识库拼装（原有行为）
    if (!reply && kbItems.length > 0) {
      reply = assembleKbReply(kbItems, kbFallback);
    }

    // 4. 降级回复（LLM 与知识库均不可用）
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
      // [v3 调试] 回显本次请求携带的上下文，用于确认
      // system_prompt / history 是否真正到达 ima-proxy（前端不可见提示词内容，仅回显长度）
      _debug: {
        system_prompt_len: (effectivePrompt || '').length,
        history_len: Array.isArray(history) ? history.length : 0,
        kb_hits: hitKnowledge,
      },
    }), { headers, status: 200 });

  } catch (error: any) {
    console.error('Error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});

// ============================================================
// [v3.1] 从 app_config 读取统一提示词（service_role，绕过 RLS）
// 供"前端未传 system_prompt"时服务端兜底注入。
// 读取失败返回空字符串（不影响主流程）。
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
  } catch (e) {
    console.warn('fetchSystemPrompt error:', e.message);
    return '';
  }
}

// ============================================================
// [v4] 检索知识库并拉取前 3 条原文，返回 [{media_id,title,content}]
// search_knowledge 优先；携带 history/system_prompt 透传（容错回退）
// ============================================================
async function searchKbAndFetch(clientId: string, apiKey: string, kbId: string, query: string, history?: any[], systemPrompt?: string): Promise<any[]> {
  const keywords = extractKeywords(query);
  const items = await searchKb(clientId, apiKey, kbId, query, keywords, history, systemPrompt);
  if (items.length === 0) return [];
  return fetchItemsContent(clientId, apiKey, items.slice(0, 3));
}

// ============================================================
// [v4] 对条目批量拉取 markdown 原文
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
// [v4] 知识库内容拼装回复（无 LLM 时的降级路径，原有行为）
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
// [v4] LLM 生成专业答复 —— 核心实现
// 将「统一提示词 + 会话上下文(history) + 当前内容(query) +
// 知识库参考资料」一起发送给 LLM（OpenAI 兼容接口），
// 得到真正基于提示词与上下文的专业回复。
//
// 多会话隔离：messages 中的 history 来自各窗口 sessionStorage，
// 每次请求独立组装，ima-proxy 无状态 → 多用户多会话互不干扰。
//
// 环境变量：
//   LLM_API_KEY  必填（腾讯混元 / DeepSeek / OpenAI 等 API Key）
//   LLM_BASE_URL 默认 https://api.hunyuan.cloud.tencent.com/v1
//   LLM_MODEL    默认 hunyuan-lite（免费额度）
// ============================================================
async function buildLlmReply(
  llmKey: string,
  systemPrompt: string,
  history: any[],
  query: string,
  kbItems: any[],
  kbFallback: boolean
): Promise<string> {
  const llmBase = Deno.env.get('LLM_BASE_URL') || 'https://api.hunyuan.cloud.tencent.com/v1';
  const llmModel = Deno.env.get('LLM_MODEL') || 'hunyuan-lite';

  // 组装 system 提示词：统一提示词 + 知识库参考资料
  let systemContent = systemPrompt || '你是一位专业的恋爱聊天指导助手，请根据用户的描述给出自然、得体、可复制的回复建议。';
  if (kbItems.length > 0) {
    const kbText = kbItems
      .map((item, i) => `【参考资料 ${i + 1}】${item.title}\n${item.content || ''}`)
      .join('\n\n');
    systemContent += `\n\n以下是从知识库检索到的参考资料，回答时优先参考这些资料的内容和风格：\n${kbText}`;
    if (kbFallback) {
      systemContent += '\n\n（注：本次检索接口异常，参考资料按标题匹配，可能不完全相关）';
    }
  }

  // 组装 messages：system + 会话上下文 history + 当前问题
  const messages: any[] = [{ role: 'system', content: systemContent }];
  if (Array.isArray(history) && history.length > 0) {
    // 只保留 role 合法的历史，且截取最近 20 条控制上下文长度
    const valid = history
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-20)
      .map((h) => ({ role: h.role, content: h.content }));
    messages.push(...valid);
  }
  messages.push({ role: 'user', content: query });

  const resp = await fetch(`${llmBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: llmModel,
      messages,
      temperature: 0.7,
      max_tokens: 800,
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
// [v3.2] 回退浏览：递归遍历知识库（含子文件夹），收集所有条目，
// 用 bigram 关键词匹配标题，返回最多 5 条。
// 用于 search_knowledge 中文检索 0 命中的兜底。
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
          // 文件夹：递归进入（用 folder_id 或 media_id 作为子文件夹 ID）
          const fid = item.folder_id || item.media_id || '';
          if (fid) await walk(fid);
        } else {
          all.push(item);
        }
      }
    } catch (e) {
      console.error(`browse folder "${folderId}" failed:`, e.message);
    }
  }

  try { await walk(''); } catch (e) { console.error('browseKbByTitle error:', e.message); return []; }

  // 标题匹配（关键词命中或整句包含）
  const matches = all.filter((item: any) => {
    if ([2, 6, 8, 10, 12, 16, 17, 18, 19].includes(item.media_type)) return false;
    const title = item.title || '';
    return keywords.some((k) => title.includes(k)) || (query.length > 1 && title.includes(query));
  });

  return matches.slice(0, 5);
}

// ============================================================
// 关键词提取：bigram（2字窗口）切词 → 双实义字优先 → top 5
// 实测 IMA search_knowledge 对 2 字词命中率最高，
// 整句/长词（3-4字）往往返回空结果。
// 两阶段过滤：
//   阶段1 严格：两字均为实义字（如"不回""高冷""约会"）→ 优先
//   阶段2 宽松：至少一个实义字（如"不想""理我"）→ 补足名额
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

  // 严格词优先，宽松词补足；去重保序，最多 5 个
  return [...new Set([...strict, ...loose])].slice(0, 5);
}

// ============================================================
// 搜索知识库：整句 + 关键词（bigram），合并去重
// 每个关键词取前 2 条，总上限 6 条，控制耗时与噪声
// [v3] 附加 history / system_prompt 透传；若 IMA 拒绝附加参数则回退
// ============================================================
async function searchKb(clientId: string, apiKey: string, kbId: string, query: string, keywords: string[], history?: any[], systemPrompt?: string): Promise<any[]> {
  const results: any[] = [];
  const seen = new Set<string>();

  const searchQueries = [query, ...keywords];
  for (const q of searchQueries) {
    if (!q || q.length < 2) continue;
    if (results.length >= 6) break;

    try {
      const data = await callSearch(clientId, apiKey, kbId, q, history, systemPrompt);
      const list = (data?.info_list || []).slice(0, 2);
      for (const item of list) {
        // 跳过文件夹（media_type=99）与纯图片/音视频
        if (item.media_type === 99) continue;
        if ([2, 6, 8, 10, 12, 16, 17, 18, 19].includes(item.media_type)) continue;
        if (!seen.has(item.media_id)) {
          seen.add(item.media_id);
          results.push(item);
        }
      }
    } catch (e) {
      console.error(`search "${q}" failed:`, e.message);
    }
  }

  return results;
}

// ============================================================
// [v3] search_knowledge 统一调用（带 history/system_prompt 透传 + 容错回退）
// 先尝试携带附加参数；若 IMA 返回错误（可能不支持这些参数），
// 去掉附加参数重试一次，确保原有检索功能不受影响。
// ============================================================
async function callSearch(clientId: string, apiKey: string, kbId: string, q: string, history?: any[], systemPrompt?: string): Promise<any> {
  const baseBody: any = { query: q, knowledge_base_id: kbId, cursor: '' };

  // 仅当存在有效附加数据时才携带（历史数组需为 [{role, content}] 结构）
  const hasHistory = Array.isArray(history) && history.length > 0 &&
    history.every((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
  const hasPrompt = typeof systemPrompt === 'string' && systemPrompt.trim() !== '';

  if (!hasHistory && !hasPrompt) {
    return callIma(clientId, apiKey, 'search_knowledge', baseBody);
  }

  const extraBody = { ...baseBody };
  if (hasHistory) extraBody.history = history.slice(-20); // 最多携带最近 20 条
  if (hasPrompt) extraBody.system_prompt = systemPrompt;

  try {
    return await callIma(clientId, apiKey, 'search_knowledge', extraBody);
  } catch (e) {
    // IMA 不接受附加参数 → 回退为原始调用（不抛错，保持兼容）
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
  } catch (e) {
    console.error('fetch content failed:', e.message);
    return '';
  }
}

// ============================================================
// Markdown 清洗：去 frontmatter、站点导航、标记符号、截断
// ============================================================
const NAV_LINES = ['首页', '恋爱话术资源社区', '下载APP', '登录 / 注册', '个人中心', '我的书架', '我的话术', '退出登录', '当前位置', '情感文章'];

function cleanMarkdown(text: string): string {
  let t = text;

  // 去掉 YAML frontmatter
  if (t.startsWith('---')) {
    const end = t.indexOf('\n---', 3);
    if (end !== -1) t = t.slice(end + 4);
  }

  // 去掉网页抓取残留的站点导航行与元数据行
  t = t.split('\n').filter((line) => {
    const l = line.trim();
    if (!l) return true;
    if (NAV_LINES.some((n) => l.includes(n))) return false;
    // 去掉"更新时间/阅读数/责任编辑"等元数据行
    if (/^(更新时间|更新日期|阅读数|责任编辑|来源|发布于)/.test(l)) return false;
    return true;
  }).join('\n');

  // 去掉行内 markdown 符号
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

  // 截断到 260 字（保留完整句子边界）
  if (t.length > 260) {
    const cut = t.slice(0, 260);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
    if (lastPunct > 80) {
      return cut.slice(0, lastPunct + 1) + '……';
    }
    return cut + '……';
  }
  return t;
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
