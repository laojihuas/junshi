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

    if (imaKey && imaClientId && kbId) {
      try {
        reply = await buildKnowledgeReply(imaClientId, imaKey, kbId, query.trim(), history, effectivePrompt);
        hitKnowledge = reply !== '';
      } catch (e) {
        console.error('IMA error:', e.message);
      }
    }

    // ---- 降级回复（未命中知识库 / 凭证缺失）----
    if (!reply) {
      const fallbacks = [
        `关于"${query}"，建议你：\n1️⃣ 先认可对方的感受\n2️⃣ 表达你的真实想法\n3️⃣ 用开放性问题引导对话`,
        `针对"${query}"，可以这样回：\n"嗯嗯，我明白你的意思。有空可以多聊聊~"`,
        `回应"${query}"的思路：先表示理解 → 表达看法 → 反问对方。三步法最自然。`,
      ];
      const reason = !(imaKey && imaClientId)
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
// 核心：基于知识库构建回复
// [v3] history / system_prompt 透传给 IMA（对话上下文 + 统一提示词）
// [v3.2] search_knowledge 0 命中时回退：递归浏览知识库按标题匹配关键词，
//        缓解 IMA 中文检索偶发异常导致的"知识库掉线"问题
// ============================================================
async function buildKnowledgeReply(clientId: string, apiKey: string, kbId: string, query: string, history?: any[], systemPrompt?: string): Promise<string> {
  // 1. 提取搜索关键词
  const keywords = extractKeywords(query);

  // 2. 搜索（整句 + 关键词，合并去重）
  let items = await searchKb(clientId, apiKey, kbId, query, keywords, history, systemPrompt);

  // 2.1 [v3.2] 回退：检索 0 命中时，递归浏览知识库按标题匹配
  let usedFallbackBrowse = false;
  if (items.length === 0) {
    const browseItems = await browseKbByTitle(clientId, apiKey, kbId, query);
    if (browseItems.length > 0) {
      items = browseItems;
      usedFallbackBrowse = true;
    }
  }

  if (items.length === 0) return '';

  // 3. 对前 3 个 markdown 文档获取原文
  const topItems = items.slice(0, 3);
  const withContent = await Promise.all(
    topItems.map(async (item) => ({
      ...item,
      content: await fetchDocContent(clientId, apiKey, item),
    }))
  );

  // 4. 组装回复
  const lines: string[] = [usedFallbackBrowse
    ? '（检索服务异常，已按标题匹配到知识库相关资料，给你参考：）'
    : '根据知识库的资料，给你参考：', ''];
  withContent.forEach((item, i) => {
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
