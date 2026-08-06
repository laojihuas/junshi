// ============================================================
// 军师 - Supabase Edge Function: IMA API 代理 (vB 本地块级检索版)
//
// 功能：接收前端请求 → 校验用户状态 → 本地块级检索 kb_blocks → 生成专业回复
//
// [vB 完全移除 IMA]（2026-08-04）
//   - 知识库：本地 kb_blocks 块级表（15,107 块），完全替代 IMA 检索
//   - 检索：kb_blocks_recall RPC（bigrams GIN 粗筛 + 块内词频加权打分）
//   - 命中块 ≤700 字直接原文进上下文 → summarizeRef 下线（省 44% token）
//   - 移除：search_knowledge / get_media_info / get_knowledge_list / kb_docs
//   - 保留：语义拆解(v8) + 套路启动(v7) + 状态配额(v7)
//   - [2026-08-06] 知识库瘦身为恋爱话术 739 块（教学/实战删库）：
//     整句压缩(v12) 移除（话术库无问题语域，LLM 整句短语命中 0-37 块 vs bigram 270-596），
//     语义词表按话术库命中校准（20 个教学理论词零命中已移除）
//   - 环境变量仅需：LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
//
// [v14 有脾气·真人化]（解决"输出过于礼貌、不像真人"，2026-08-03）
//   - 角色定位重写：有血有肉的真人——有脾气、有态度，不是客服/老好人
//   - 敢调情：暧昧/恋爱阶段直接带钩子，别温吞水
//   - 敢否定(Neg)：对方飘/装/拿你开涮时直接顶回去，制造张力而非讨好
//   - 遇攻击必反击：ATTACK_RE 检测对方攻击/挑衅/阴阳怪气（排除挽回期），
//     命中注入【对方正在攻击你】强化块：先反击再收尾，绝不卑微解释/讨好
//   - 【线上语境与轻度否定】升级为【语气与态度】：保留安全边界（禁外貌/
//     性格/价值贬低、情绪低落/挽回期收起锋芒），放开"敢"的权限
//   - 默认温度 0.4→0.6、frequency_penalty 0.5→0.7：输出更有性格方差
//   - _debug 新增 attack_detected
//
// [v51 字数压缩]（解决"输出字数偏多"，2026-08-05，A+B+C 方案）
//   - A 硬字数：整条 ≤30 字（通常 1 句 ≤20 字，最多 2 句合计 ≤30 字），超过=失败必须压缩重写
//   - B 推拉压进一句：推拉三步用措辞在同一句完成（回应+调侃+钩子），严禁分句输出；每轮只发 1 句
//   - C 示例驱动：【自洽与输出要求】追加 3 个 ≤20 字范例（LLM 对示例比数字敏感）
//   - 说明：仅提示词改动，不动参数/架构；配合 max_tokens 3000 观察效果
//
// [v52 S1 口水过滤]（2026-08-05，只实施 S1）
//   - 参考区注入加引导语：知识库块混有口水文（铺垫/说教/废话/车轱辘话），
//     只吸收"可直接复制的话术/金句/例子"，口水段落跳过，不被带偏风格和字数
//   - 零成本零延迟；S2(LLM 精筛)/S3(切块治本) 留待后续
//
// [v53 gem 精华打分]（2026-08-05，Step 1 只改 index.ts，不碰数据库）
//   - calcGemScore：纯规则精华分（零 LLM）——引号对话示范/操作词/短句/金句符号
//     加分；说教连接词/长铺垫/形容词堆砌/套话 减分；范围 [-2,3]
//   - recallBlocks：p_limit 12→24 多捞候选池 → 内存算 gem → 剔口水(< -1) →
//     按 相关分+gem×0.8 重排 → 再走 applyQuota 取 target（候选不进 LLM，token 不变）
//   - _debug 新增 kb_gem / kb_gem_avg
//
// [v56 人性化四件套]（2026-08-05，对标 IMA copilot 对话实录）
//   - ①【先解读再回复】最高优先级：先回答"她真实意图/为什么这么说/期待什么"再写，
//     绝不盯字面回字面（她"哈哈"→找笑因强化/推进，禁"你笑得天气都好了"废话）；正反例 few-shot
//   - ②双关幽默：把她的词接出第二层意思（放盐→咸淡→生小孩），禁空洞夸赞/直给调侃
//   - ③【兴趣信号与升级】：主动追问/发照片/说喜欢/主动约=IOI，命中必须推进一档（邀约/试探/暧昧）
//   - ④【话题锚点】：extractProfile 新增 anchor 字段（≤20字），buildSystemContent 注入
//     【话题锚点】块——跨轮次围绕共同梗延伸像连续剧；锚点保护：本轮没识别不清空旧值
//   - 全部为提示词层，零额外 LLM 调用、零 token 增量
//
// [v57 长期记忆 facts]（2026-08-05，P0 facts清单 + P1 选择性回忆）
//   - memory_card.facts：长期事实清单 [{text≤40字, at, last_mention}]，上限 20 条
//   - extractProfile 顺带提取新事实（≤3 条/轮，挂 3 分钟画像限频，零新增调用）
//   - mergeFacts：去重（互含=同条，刷新提及时间）+ 按提及新旧排序 + 超上限淘汰最旧
//   - buildSystemContent 选择性注入【我记得这些】：按 query 与 fact 的 bigram 重叠
//     挑 top4（FACTS_INJECT_MAX），不全量塞——像人按话题想起相关记忆
//   - _debug 新增 facts_len
//
// [v58 M3 目标引导]（2026-08-05，战略层：目标→路线→主动推进）
//   - memory_card.goal（用户前端设置）：约见面/推进恋爱/挽回修复/保持暧昧
//   - GOAL_HINTS 目标→行动映射；buildSystemContent 注入【关系目标与进度】
//     （当前阶段+本轮动作），目标达成(按 STAGE_ORDER 达到目标 stage)则停止注入
//   - extractProfile 阶段推进：信号密集(主动追问/发照片/秒回/约你)按 追求→暧昧→恋爱
//     最多升一级；冷淡/回避可降级；拿不准保持
//   - 战略层(目标引导) > 战术层(套路) > 弹药层(锚点/幽默/IOI) 三层叠加
//
// [v11 迷男OS]（线下技巧 → 线上场景深度融合，2026-08）
//   - 三层架构：战略层(记忆卡 stage 定基调) > 战术层(strategy 套路定方向)
//     > 引擎层(pulse/balance/emotion_tone 实时输入)
//   - STAGE_VOCAB：91 词表按 M3 四阶段(meet/attract/comfort/seduction)打标分组，
//     语义拆解按"当前目标"加权：目标词 > 语义词 > bigram > 原句
//   - memory_card 新增 pulse(节奏)/balance(话题主权)/emotion_tone(情绪基线)：
//     毫秒级规则统计，防止需求感外露与连续延迟(冷暴力)
//   - buildSystemContent 新增【节奏】(礼貌阈值+延后计数) 与
//     【线上语境与轻度否定】(Neg 轻度化：只调侃行为措辞、禁人身攻击、
//     推拉结构=先回应再调侃再留钩子) 两个硬约束块
//   - extractStrategy 线上化：步骤须纯文字可发送、标注发送时机、
//     过滤肢体/眼神/现场类、禁人身攻击
//
// [v10 思考模式]（DeepSeek V4，2026-08）
//   - 模型升级 deepseek-chat → deepseek-v4-flash（旧名 2026-07-24 已弃用）
//   - 新增 thinking_mode 四档：off(普通) / low(轻度) / high(中度) / max(深度)
//   - V4 模型思考模式默认开启！llmChat 必须显式控制：
//     off → thinking:{type:'disabled'}（快、便宜，保留 temperature/惩罚参数）
//     low/high/max → thinking:{type:'enabled'} + reasoning_effort（思考档不传
//     temperature/惩罚系数，官方强制不生效；max_tokens 自动提到 2000+ 防思维链挤占）
//   - 优先级：仅 app_config.llm_params.thinking_mode（后台默认档）；请求体 thinking_mode
//     一律忽略 —— 防止用户构造请求刷最高档 max 造成成本失控
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
//     - 场景指令：按记忆卡 stage 注入对应关系阶段的指导（追求/暧昧/恋爱/挽回/朋友）
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
//   thinking_mode  已忽略（档位仅由后台 app_config 默认控制，防用户刷最高档）
//
// 环境变量：LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
// ============================================================

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
// [v11] 全部改为线上场景版（纯文字聊天：展示面+节奏+文字张力）
const STAGE_HINTS: Record<string, string> = {
  '追求': '线上追求期：核心是展示面与聊天节奏，不是高频聊天。每天 1-2 个高质量话题优于刷屏；可以有态度、带点轻度调侃制造张力，别急着表白、别查户口式提问，更别一味顺着对方。',
  '暧昧': '线上暧昧期：用文字张力推进——先回应再调侃/留白，保留一点神秘感；敢于调情，说话直接点、带点挑逗和钩子，别总温吞水；可抛出模糊邀约试探，不急着捅破窗户纸，守住"暧昧窗口"。',
  '恋爱': '线上恋爱期：回复温暖有生活感、关注细节，但别过度客气生分；可以斗嘴、可以小调侃保鲜，带点自己的脾气，但别拿原则问题开玩笑。',
  '挽回': '线上挽回期：先稳住对方情绪、不追问不施压，用稳定低压力的输出重建安全感；此阶段严禁任何调侃/打压，对方说什么都先接住情绪。',
  '朋友': '线上朋友：自然、有态度、不刻意讨好，话题轻松但保持边界。',
  '未知': '',
};

// [v8] 领域词表：知识库主题检索词
// [2026-08-06 话术库版] 恋爱教学/聊天实战已删库，词表按现存 739 块恋爱话术重新校准：
//   移除 20 个教学理论词（情绪价值/三明治夸奖/二次吸引/展示面/推倒/情感浓度等，话术库零命中），
//   补入话术库高频类别词（互动/游戏/幽默/想你/关心/赞美/撩/套路等，实测命中数据支持）
const TOPIC_VOCAB: string[] = [
  // 情绪状态
  '低落', '委屈', '生气', '难过', '伤心', '敷衍', '高冷', '冷淡', '忽冷忽热', '开心',
  // 关系阶段
  '追求', '暧昧', '恋爱', '挽回', '异地', '吵架', '冷战', '分手', '复合', '暗恋', '相亲',
  // 场景需求
  '安慰', '哄', '道歉', '解释', '试探', '邀约', '表白', '约会', '见面', '聊天', '回复', '追问',
  '关心', '赞美', '撩', '幽默', '情话', '晚安', '想你', '游戏', '互动', '故事', '共鸣',
  // 对方性格
  '慢热', '内向', '外向', '强势', '粘人', '傲娇', '独立',
  // 惯例术语（话术库高频分类标签）
  '框架', '惯例', '推拉', '冷读', '废物测试', '服从性测试', '进挪', '角色扮演',
  '开场白', '打压', '搭讪', '调戏', '引导', '高价值', '需求感', '冷冻', '兴趣指标',
  '查户口', '预选', '模糊邀约', '欲擒故纵', '冷读术', '建立吸引', '升级关系', '主导权', '展示面', '套路',
];

// [v11 迷男OS] M3 战术阶段 → 词表子集映射（词表按话术库命中校准）
//   语义拆解与套路启动检索按"当前目标"加权：
//   有套路 → strategy.goal 推断；无套路 → profile.stage 推断；都没有 → 全词表
const STAGE_VOCAB: Record<string, string[]> = {
  'meet': ['开场白', '搭讪', '惯例', '聊天', '邀约', '约会', '见面', '幽默', '游戏', '互动'],
  'attract': ['推拉', '框架', '冷读', '冷读术', '废物测试', '打压', '欲擒故纵', '调戏',
    '高价值', '服从性测试', '进挪', '角色扮演', '需求感', '查户口', '暧昧', '模糊邀约',
    '建立吸引', '升级关系', '主导权', '展示面'],
  'comfort': ['安慰', '哄', '解释', '试探', '约会', '见面', '暧昧', '关心', '共鸣',
    '故事', '互动', '赞美', '幽默'],
  'seduction': ['进挪', '兴趣指标', '升级关系', '暧昧', '撩', '角色扮演', '调戏'],
};

// [v11] 根据记忆卡解析当前 M3 战术阶段词表（目标驱动）
function resolveStageVocab(memoryCard: MemoryCard | null): string[] {
  const goal = memoryCard?.strategy?.goal || '';
  const stage = memoryCard?.profile?.stage || '';
  let phase: keyof typeof STAGE_VOCAB = 'attract';
  if (/邀约|约会|见面|约出|约/.test(goal)) phase = 'meet';
  else if (/挽回|安抚|共情|信任|稳定|舒适|聊天|倾听/.test(goal)) phase = 'comfort';
  else if (/试探|暧昧|升级|推进|表白|升温|试探性/.test(goal)) phase = 'seduction';
  else if (/吸引|推拉|框架|调情|逗|挑逗|地位/.test(goal)) phase = 'attract';
  else if (stage === '挽回' || stage === '恋爱') phase = 'comfort';
  else if (stage === '暧昧') phase = 'seduction';
  else if (stage === '追求') phase = 'attract';
  return STAGE_VOCAB[phase] || [];
}

// [v11] 套路启动检索词：按当前目标动态取（话术库命中词校准版）
function resolveStrategySearchKws(memoryCard: MemoryCard | null): string[] {
  const goal = memoryCard?.strategy?.goal || '';
  const stage = memoryCard?.profile?.stage || '';
  if (/邀约|约会|见面/.test(goal)) return ['邀约', '约会', '见面', '搭讪', '开场白'];
  if (/暧昧|升级|推进|表白/.test(goal)) return ['暧昧', '升级关系', '进挪', '兴趣指标', '撩'];
  if (/挽回|安抚|共情|信任/.test(goal)) return ['挽回', '安慰', '哄', '关心', '道歉'];
  if (stage === '暧昧') return ['推拉', '暧昧', '冷读', '进挪', '撩'];
  if (stage === '挽回') return ['挽回', '安慰', '哄', '冷冻', '道歉'];
  if (stage === '恋爱') return ['推拉', '角色扮演', '关心', '互动', '幽默'];
  return ['惯例', '冷读', '开场白', '搭讪', '互动'];
}

// [v6 L0] 知识库参考条数与原文截断长度
// [v59 降本] KB 参考块 5→3（主回复 system 未命中部分 ≈15%↓，检索质量影响小）
const KB_REF_COUNT = 3;
const KB_CONTENT_MAX = 500;
const HISTORY_ITEM_MAX = 800;   // 单条历史上限
const SUMMARY_ITEM_MAX = 80;    // 更早消息摘要单条上限（v59 120→80 降本）
const RECENT_FULL = 10;         // 近详远略：最近 N 条全文
const MEMORY_UPDATE_INTERVAL = 3 * 60 * 1000; // 画像提取频率：3 分钟

Deno.serve(async (req) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Identity-Type, X-Session-Id',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    // [v13] 阶段计时埋点（仅检测，不改行为）：_debug.perf 输出各段耗时
    const perfMark: [string, number][] = [];
    const mark = (name: string) => perfMark.push([name, Date.now()]);
    mark('start');

    const { query, knowledge_base_id, history, system_prompt, session_id } = await req.json();
    // [B方案] 完全本地检索，不再使用 IMA knowledge_base_id（保留解构以兼容前端请求体）

    if (!query || !query.trim()) {
      return new Response(JSON.stringify({ error: 'query 不能为空' }), { headers, status: 400 });
    }

    // ---- 用户认证（匿名登录 JWT，仅作会话校验）----
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

    // [v20260805 用户机制重构] 身份解析（双轨）：
    //   游客（device）：X-Device-Id 头 → 20 条/天 + IP 防刷，用完弹注册引导
    //   注册用户（account）：X-Identity-Type: account + 账号 JWT + X-Session-Id
    //     → 按账号扣次（前3天50/之后20 + 邀请余额 + VIP500），单点校验
    const clientIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || '';
    const identityType = (req.headers.get('X-Identity-Type') || 'device').trim() === 'account' ? 'account' : 'device';

    let identityKey = '';
    let sessionCheck: any = null;

    if (identityType === 'account') {
      // 注册用户：身份 = 账号 user id（JWT 解析）；必须带 X-Session-Id 校验单点
      identityKey = user?.id || '';
      if (!identityKey) {
        return new Response(JSON.stringify({ error: 'account_required', message: '请先登录' }), { headers, status: 401 });
      }
      const sessionId = (req.headers.get('X-Session-Id') || '').trim();
      if (!sessionId) {
        return new Response(JSON.stringify({ error: 'session_required', message: '请重新登录' }), { headers, status: 401 });
      }
      // 单点校验：active_session 不匹配 → 账号已在其他设备登录
      if (serviceRoleKey && supabaseUrl) {
        const chkResp = await fetch(`${supabaseUrl}/rest/v1/rpc/check_account_session`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ p_account_user_id: identityKey, p_session_id: sessionId })
        });
        sessionCheck = chkResp.ok ? await chkResp.json() : { valid: false };
        if (sessionCheck.valid !== true) {
          return new Response(JSON.stringify({ error: 'session_expired', message: '账号已在其他设备登录' }), { headers, status: 401 });
        }
      }
    } else {
      // 游客：设备指纹
      identityKey = (req.headers.get('X-Device-Id') || '').trim();
      if (!identityKey) {
        return new Response(JSON.stringify({ error: 'device_required', message: '缺少设备标识' }), { headers, status: 401 });
      }
    }

    // 配额检查 + 原子扣次（RPC 内 SECURITY DEFINER 事务；双身份）
    let quotaInfo: any = null;
    if (serviceRoleKey && supabaseUrl) {
      const quotaResp = await fetch(`${supabaseUrl}/rest/v1/rpc/check_and_consume_quota`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_identity_type: identityType, p_identity_key: identityKey, p_ip: clientIp })
      });
      if (quotaResp.ok) {
        quotaInfo = await quotaResp.json();
      } else {
        const errText = await quotaResp.text();
        console.error('quota rpc failed:', quotaResp.status, errText.slice(0, 300));
      }
    }

    if (!quotaInfo || quotaInfo.allowed !== true) {
      const reason = quotaInfo?.reason || 'quota_error';
      // 受限文案分层：
      //   游客用完(guest_quota_exhausted) → 注册引导（不弹付费墙）
      //   注册用户用完(quota_exhausted) → 付费墙（月卡/邀请）
      //   VIP 满 500(vip_daily_limit) → 服务过载；IP 超限 → 使用太频繁
      let message = '今日次数已用完，请明天再来';
      if (reason === 'guest_quota_exhausted') message = '今日免费次数已用完，注册登录继续畅聊';
      else if (reason === 'quota_exhausted') message = '今日免费额度已用完，升级 VIP 或邀请好友继续畅聊';
      else if (reason === 'vip_daily_limit') message = '服务过载，请明天再试';
      else if (reason === 'ip_limit' || reason === 'ip_new_device_limit') message = '使用太频繁，请稍后再试';
      else if (reason === 'device_not_found') message = '设备未注册，请重试';
      else if (reason === 'account_not_found') message = '账号异常，请重新登录';
      return new Response(JSON.stringify({ error: reason, message, quota: quotaInfo }), { headers, status: 403 });
    }

    // [v7] 读取 app_config：统一提示词兜底 + LLM 生成参数（后台可调）
    const appConfig = await fetchAppConfig(supabaseUrl, serviceRoleKey);
    let effectivePrompt = (typeof system_prompt === 'string') ? system_prompt : '';
    if (!effectivePrompt.trim()) effectivePrompt = appConfig.system_prompt;
    const llmParams = appConfig.llm_params;

    // ---- LLM 凭证（[B方案] 完全移除 IMA，仅保留 LLM）----
    const llmKey = Deno.env.get('LLM_API_KEY') || '';
    const llmBase = Deno.env.get('LLM_BASE_URL') || 'https://api.deepseek.com';
    // [v10] 模型升级：deepseek-chat 已于 2026-07-24 弃用，V4 思考/非思考都走 deepseek-v4-flash
    const llmModel = Deno.env.get('LLM_MODEL') || 'deepseek-v4-flash';

    // [v10] 思考模式生效档位：仅后台默认档（忽略请求体传参，防用户构造请求刷最高档）
    const effectiveThinkingMode: ThinkingMode = llmParams.thinking_mode;

    // [v6 L2] 读取记忆卡（跨窗口共享的对方画像，按会话）
    let memoryCard = await readMemoryCard(supabaseUrl, token, supabaseAnonKey, session_id);

    // [v7] 套路打断："/" 开头 = 用户指令（如 /换策略 /停止 /不按套路），清除执行中的套路
    const rawQuery = typeof query === 'string' ? query.trim() : '';
    const strategyClear = rawQuery.startsWith('/');
    if (strategyClear && memoryCard?.strategy) {
      memoryCard.strategy = null;
    }
    // [v62 切换话题] "/换话题" = 用户一键换话题：不延续旧话题，主动抛新话题开场
    const switchTopic = strategyClear && (rawQuery === '/换话题' || rawQuery.startsWith('/换话题 '));

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
    // [v11] 节奏建议（buildSystemContent 产出 → updateMemoryCard 回写；同样提到顶层防作用域事故）
    let pulseAdvice: { delay?: boolean; short?: boolean } | null = null;
    // [v57] 长期记忆本轮注入条数（_debug 用；同样提到顶层防作用域事故）
    let factsInjected = 0;

    // ---- 知识库检索（[B方案] 纯本地块级检索，完全移除 IMA 依赖） ----
    if (serviceRoleKey && supabaseUrl) {
      mark('ready'); // 认证/配置/记忆卡读取完成
      try {
        // [B] 文件夹识别改为本地 folder_id 映射：话术=恋爱话术
        //   [2026-08-06] 恋爱教学/聊天实战 已删库（干扰检索），仅剩恋爱话术一类，jx 置空
        kbFolders = { hs: '恋爱话术', jx: null };
        // 配额：仅剩话术一类，hs 直接吃满参考配额（见 applyQuota 的 !jx 分支）
        const quotaOpts = {
          hsFolder: kbFolders.hs,
          jxFolder: kbFolders.jx,
          strategyActive: !!memoryCard?.strategy,
        };

        // [v8] 1. LLM 语义拆解（词表约束 + few-shot + [v11]当前目标阶段加权）→ 检索词（语义路）
        // [v62 切换话题] 换话题时 query 是"/换话题"无实义，跳过 LLM 拆词（省 token），
        //   直接用"新话题/开场白"固定检索词，再叠加记忆卡里的喜好/兴趣当话题弹药
        const kw = extractKeywordsFromHistory(history, switchTopic ? '' : query);
        if (switchTopic) {
          semanticKws = ['新话题', '开场白', '话题', '破冰'];
          const hobbyKws = extractKeywordsFromHistory(history, '', true).slice(0, 3);
          kw.push(...hobbyKws); // 用对方聊过的兴趣词（如"川菜/电影"）当新话题方向
        } else if (llmKey) {
          semanticKws = await extractSemanticKeywords(llmKey, llmBase, llmModel, query, recentUserMessages, resolveStageVocab(memoryCard));
        }
        mark('semantic');
        // [2026-08-06] 整句压缩（v12）已移除：话术库无"问题描述"语域，LLM 整句短语命中
        //   实测 0-37 块（怎么安慰0/怎么哄0/不回消息1），原句 bigram 直接命中 270-596 块
        //   → 整句路纯浪费一次 LLM 调用，检索词序列收敛为 语义词 > 规则词 > 原句垫底
        // [v8] 2. 条件 query rewrite 降级：仅当语义词全空 且 规则词不足时触发
        let searchQuery = query.trim();
        if (semanticKws.length === 0 && kw.length < 2 && llmKey) {
          const rw = await rewriteQuery(llmKey, llmBase, llmModel, query, recentUserMessages);
          if (rw) { searchQuery = rw; usedRewrite = true; }
        }
        // [B] 3. 检索词序列：语义词(语义路) > bigram/规则词 > 原句垫底
        //   统一走本地 kb_blocks_recall 块级召回（块内词频加权）
        const semanticSet = new Set<string>(semanticKws);
        const searchQueries = [...semanticKws, ...kw, searchQuery];
        kbItems = await recallBlocks(supabaseUrl, serviceRoleKey, semanticKws, searchQueries, quotaOpts);
        mark('kb1');
        // 4. 第二轮：不足 2 条时用"仅历史"关键词补搜
        if (kbItems.length < 2) {
          const kw2 = extractKeywordsFromHistory(history, '', true).filter((k) => !kw.includes(k)).slice(0, 3);
          if (kw2.length > 0) {
            const items2 = await recallBlocks(supabaseUrl, serviceRoleKey, semanticKws, kw2, quotaOpts);
            const merged = mergeDedup([...kbItems, ...items2]).slice(0, KB_REF_COUNT);
            if (merged.length > kbItems.length) kbItems = merged;
          }
        }
        // 5. 标题兜底：块级召回空时按关键词过滤标题（本地 REST 查询）
        if (kbItems.length === 0) {
          const browseItems = await browseBlocksByTitle(supabaseUrl, serviceRoleKey, searchQuery || query, quotaOpts);
          if (browseItems.length > 0) {
            kbItems = browseItems;
            kbFallback = true;
          }
        }
        mark('kbft');
        hitKnowledge = kbItems.length > 0;

        // [v7] 套路启动（独立惯例检索通道）：当前无套路 + 用户未打断 → 专门检索惯例/魔术/玩法类内容，
        //   LLM 提炼步骤启动套路；结果仅用于启动，不混入主回复参考（话术加权不影响套路启动素材）
        //   [v11] 检索词按当前目标动态取（resolveStrategySearchKws）
        //   [v13] 降频：套路检索词 <3 个有实义内容（title/content 非空）不触发 LLM 提炼（LLM 4s 大头）
        if (llmKey && !strategyClear && !memoryCard?.strategy) {
          try {
            const convItems = await recallBlocks(
              supabaseUrl, serviceRoleKey,
              resolveStrategySearchKws(memoryCard), resolveStrategySearchKws(memoryCard),
              { ...quotaOpts, pickCount: 5 }
            );
            const usable = (Array.isArray(convItems) ? convItems : [])
              .filter((i) => i && (i.title || '') && (i.content || '')).length;
            if (usable >= 2) {
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
        mark('strategy');
      } catch (e: any) {
        console.error('知识库检索失败:', e.message);
      }
    }

    // ---- LLM 主回复 ----
    // [v20260805] 简介从 profiles.bio 读取（匿名用户注册时 ensure_profile 已建行，RLS 按 user 隔离）
    let userBio = '';
    try {
      const bioResp = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=bio`,
        { headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey } }
      );
      const bioList = await bioResp.json();
      if (Array.isArray(bioList) && bioList[0] && typeof bioList[0].bio === 'string') {
        userBio = bioList[0].bio;
      }
    } catch (e: any) {
      console.warn('读取简介失败:', e.message);
    }
    if (llmKey) {
      try {
        // 组装 system：[P0-3] 固定块前移（缓存友好）+ 去冗余（llmHistory≥4 不注入近期话/自己话）
        const built = buildSystemContent({
          systemPrompt: effectivePrompt,
          userBio,
          memoryCard,
          olderSummary,
          kbItems,
          kbFallback,
          // [v14] 对方当前这句话 → 攻击性检测
          lastUserText: switchTopic ? '' : query,
          // [P0-3] llmHistory ≥4 条 → llmHistory 已含近期对话，system 不再重复注入
          hasRecentHistory: llmHistory.length >= 4,
          // [v62 切换话题] 用户一键换话题：注入【切换话题】指令
          switchTopic,
        });
        const systemContent = built.systemContent;
        pulseAdvice = built.pulseAdvice;
        factsInjected = built.factsInjected;
        const messages: any[] = [
          { role: 'system', content: systemContent },
          ...llmHistory,
          // [v62 切换话题] 换话题时 user 消息用引导语（不把 "/换话题" 指令本身发给 LLM 当用户话）
          { role: 'user', content: switchTopic ? '（用户按了"换话题"，请按 system 里的【切换话题】指令直接给一句新话题开场白）' : query.trim() },
        ];
        reply = await llmChat(llmKey, llmBase, llmModel, messages, {
          temperature: llmParams.temperature,
          maxTokens: llmParams.max_tokens,
          frequencyPenalty: llmParams.frequency_penalty,
          presencePenalty: llmParams.presence_penalty,
          thinking: effectiveThinkingMode,
          _stage: 'main_reply',
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
    mark('llm_reply');

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
      const reason = !llmKey
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
          pulseAdvice,
        });
      } catch (e: any) {
        console.error('记忆卡更新失败:', e.message);
      }
    }
    mark('memory');

    return new Response(JSON.stringify({
      reply,
      from_knowledge_base: hitKnowledge,
      // [v20260805] 配额已在 RPC 内原子扣次，此处透传扣次信息（不暴露免费档上限以外的敏感值）
      quota: quotaInfo ? {
        tier: quotaInfo.tier,
        used: quotaInfo.used,
        limit: quotaInfo.limit,
        bonus: quotaInfo.bonus ?? null,
      } : null,
      _debug: {
        system_prompt_len: (effectivePrompt || '').length,
        history_len: Array.isArray(history) ? history.length : 0,
        llm_history_len: llmHistory.length,
        kb_hits: hitKnowledge,
        kb_items: kbItems.length,
        rewrite_used: usedRewrite,
        semantic_kws: semanticKws,
        // [2026-08-06] 整句路已移除，仅剩语义路命中统计
        semantic_route_hits: kbItems.filter((it: any) => (it._semanticHits || 0) > 0).length,
        rule_route_hits: kbItems.filter((it: any) => (it._hits || 0) > (it._semanticHits || 0)).length,
        // [B方案] 本地块级检索命中统计
        fulltext_hits: kbItems.filter((it: any) => it._fulltext).length,
        // [B方案] 正文来源：全部为本地块（block_idx 标记块级命中）
        content_src: {
          blocks: kbItems.filter((it: any) => typeof it.block_idx === 'number').length,
          empty: kbItems.filter((it: any) => !it.content).length,
        },
        // [v53] 精华分统计（验证 gem 精排）：最终进上下文的块的 gem 分布
        kb_gem: kbItems.map((it: any) => it._gem ?? null),
        kb_gem_avg: kbItems.length
          ? Math.round(kbItems.reduce((a: number, it: any) => a + (it._gem || 0), 0) / kbItems.length * 10) / 10
          : null,
        // [v57] 长期记忆统计：facts 总量 + 本轮命中注入数（验证选择性回忆）
        facts_len: Array.isArray(memoryCard?.facts) ? memoryCard.facts.length : 0,
        facts_injected: factsInjected,
        // [v13] 阶段耗时（ms）：start/ready/semantic/sentence/kb1/kbft/strategy/llm_reply/memory
        perf: (() => {
          const o: Record<string, number> = {};
          for (let i = 1; i < perfMark.length; i++) o[perfMark[i][0]] = perfMark[i][1] - perfMark[i - 1][1];
          return o;
        })(),
        thinking_mode: effectiveThinkingMode,
        memory_stage: memoryCard?.profile?.stage || null,
        // [v58] 关系目标（验证目标引导注入）
        goal: memoryCard?.goal || null,
        // [v61] 里程碑进度（验证推进引导）
        milestones: Array.isArray(memoryCard?.milestones) ? memoryCard!.milestones : [],
        // [v62] 切换话题模式（验证【切换话题】注入）
        switch_topic: switchTopic,
        self_msgs_len: Array.isArray(memoryCard?.recent_self_messages) ? memoryCard.recent_self_messages.length : 0,
        // [v14] 攻击检测是否命中（验证反击指令注入）
        attack_detected: ATTACK_RE.test(query) && (memoryCard?.profile?.stage || '') !== '挽回',
        // [v15] 时间/位置注入验证
        now_cn: formatCurrentTime(),
        location: extractLocation(userBio || '') || null,
        // [v11] 引擎层 debug：验证阶段加权与节奏/主权/情绪引擎是否生效
        stage_vocab: resolveStageVocab(memoryCard).slice(0, 5),
        balance_direction: memoryCard?.balance?.direction || null,
        emotion_baseline: memoryCard?.emotion_tone?.baseline || null,
        pulse_delay_count: memoryCard?.pulse?.delay_count ?? null,
        strategy_name: memoryCard?.strategy?.name || null,
        strategy_rounds: memoryCard?.strategy?.rounds_used ?? null,
        // [v20260805] 套路总轮数上限（前端策略徽标显示进度 x/y 用；零成本，随 _debug 返回）
        strategy_max_rounds: memoryCard?.strategy?.max_rounds ?? null,
        strategy_clear: strategyClear,
        folder_hs: !!kbFolders?.hs,
        folder_jx: !!kbFolders?.jx,
        // [vB] LLM token 用量（token 测量用）
        llm_usage: llmUsageLog.map((u) => ({ stage: u.stage, ...u.usage })),
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
      temperature: 0.3, maxTokens: 60, _stage: 'rewrite',
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
  query: string, recentUserMsgs: string[], stageVocab?: string[]
): Promise<string[]> {
  try {
    const prompt = '你是恋爱话术检索助手，负责把"对方说的话"拆解成适合检索恋爱话术库的短关键词。\n'
      + `对方的话：「${truncateText(query, 80)}」\n`
      + (recentUserMsgs.length > 0 ? `最近对话（对方说的）：\n${recentUserMsgs.slice(-2).join('\n')}\n` : '')
      + (stageVocab && stageVocab.length > 0
        ? `当前对话目标相关的检索词（优先使用，最多选 2 个）：\n${stageVocab.join('、')}\n`
        : '')
      + `知识库领域词表（检索词应优先从中选择，可少量自创补充）：\n${TOPIC_VOCAB.join('、')}\n`
      + '示例：\n'
      + '输入："她说今天被领导骂了很难受"\n输出：["委屈","安慰","哄","难过","关心"]\n'
      + '输入："她两天没回我消息了，是不是不喜欢我了"\n输出：["冷淡","高冷","忽冷忽热","追问","试探"]\n'
      + '输入："她生气了不理我，我该怎么哄"\n输出：["生气","哄","道歉","解释","冷战"]\n'
      + `要求：只输出 JSON 数组（如 ["推拉","试探"]），${SEMANTIC_KW_MIN}-${SEMANTIC_KW_MAX} 个词，每个词 2-${KW_LEN_MAX} 字；`
      + '优先使用词表中的词，可加 1-2 个贴近原话的字面词；不要任何解释文字。';
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.2, maxTokens: 150, _stage: 'semantic_kws',
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
// [2026-08-06] LLM 整句压缩（v12）已移除：
//   话术库（739 块，均为话术本体）与"用户的问题"语域不同，LLM 整句短语命中实测极差
//   （怎么安慰=0 / 怎么哄=0 / 不回消息=1 / 忽冷忽热=1），原句 bigram 直接命中 270-596 块；
//   原设计是为教学库"问题+方法"结构服务，教学删库后整句路失去甜区，纯浪费一次 LLM 调用。
//   检索词序列收敛为：语义词（词表）> 规则词 > 原句 bigram 垫底
// ============================================================

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

// [v11 迷男OS 引擎层] 节奏引擎（线上"假性时间限制"量化）
type PulseState = {
  delay_count?: number;   // 连续建议延迟回复的轮数（≥2 触发礼貌阈值，强制恢复正常）
  avg_gap_min?: number;   // 近 5 轮平均回复间隔（分钟，可选项）
};

// [v11] 话题主权引擎（线上"框架"量化：谁在追谁）
type BalanceState = {
  direction: 'self_pursuing' | 'balanced' | 'user_pursuing'; // 用户需求感外露 / 均衡 / 对方主动
  user_initiate_ratio?: number; // 近 6 轮对方主动发起的比例
  user_msg_len_avg?: number;    // 近 6 轮对方平均消息长度（字）
};

// [v11] 情绪基线引擎（推拉比例调节器）
type EmotionTone = {
  baseline: 'positive' | 'neutral' | 'negative';
  volatility: 'calm' | 'moderate' | 'volatile';
};

type MemoryCard = {
  profile?: { stage?: string; personality?: string; relationship_note?: string; recent_events?: string };
  recent_user_messages?: string[];
  // [v9] 军师(自己)发过的话：窗口 history 丢失后仍能知道自己说过什么，防重复（按 session_id 隔离）
  recent_self_messages?: string[];
  // [v57] 长期事实清单：值得跨天记住的硬事实（约定/日期/偏好/雷点/家庭/工作）
  //   [{text(≤40字), at(首次记录), last_mention(最近提及)}]，上限 FACTS_MAX，按 last_mention 新旧排序
  facts?: { text: string; at: string; last_mention: string }[];
  // [v58] 关系目标（用户在前端设置）：约见面 / 推进恋爱 / 挽回修复 / 保持暧昧 / 保持当前关系 / ''(未设置=默认推进)
  //   目标引导 = 战略层：决定军师每轮往哪使劲（M3 路线图）
  goal?: string;
  // [v61 里程碑] 关系推进里程碑：从"未知"一路推到"恋爱"要逐个收集的信息/动作
  //   ['照片','年龄','喜好','住哪','家庭','恋爱经历','敏感面','加微信','约会']
  //   已完成项（对方已给出/已发生）由 LLM 在 extractProfile 时判定合并，构建 system 时注入进度
  milestones?: string[];
  // [v11] 迷男OS 引擎层：节奏 / 话题主权 / 情绪基线（毫秒级规则统计，随记忆卡落库）
  pulse?: PulseState;
  balance?: BalanceState;
  emotion_tone?: EmotionTone;
  strategy?: StrategyState | null;
  updated_at?: string;
};

// [v57] facts 容量与注入上限
const FACTS_MAX = 20;          // 长期记忆上限（超了淘汰最久没提的）
const FACTS_INJECT_MAX = 4;    // 每轮按相关度最多注入几条

// [v58 M3 目标引导] 目标 → 行动路线（战略层）
//   目标由用户在前端设置（memory_card.goal）；这里决定每轮注入的"本轮动作"
//   正常推进顺序：未知/朋友 → 追求(Attract) → 暧昧(Comfort前) → 恋爱(确立)
const GOAL_HINTS: Record<string, { hint: string }> = {
  '约见面': {
    hint: '本轮向"见面"推进：先用具体由头做模糊邀约（如"那家店感觉你会喜欢，改天带你去"）→ 她接住就敲定具体时间地点（结合当前时间/位置，不现实就改约）→ 她推脱就洒脱留钩子（"那这顿先记我账上"）绝不纠缠。',
  },
  '推进恋爱': {
    hint: '本轮向"恋爱"推进：先确认舒适感够不够（聊三观/家庭/日常等深度话题的频率）→ 够就试探暧昧窗口（如"我们俩这状态算啥"的半玩笑试探）→ 不够就补舒适感话题+推进见面。她给兴趣信号（主动追问/发照片/吃醋）时，必须顺势推进一档。',
  },
  '挽回修复': {
    hint: '挽回路径：本轮先稳情绪、重建信任——不追问不施压、稳定低压力的输出、她说啥先接住情绪；对方明显松动后再逐步重新制造吸引，此路径禁用调侃与反击。',
  },
  '保持暧昧': {
    hint: '本轮维持暧昧张力：推拉+留白+神秘感，不急着捅破窗户纸；守住暧昧窗口，适度抛模糊邀约试探但不逼问。',
  },
  '保持当前关系': {
    hint: '用户选择保持当前关系阶段，暂停升级推进：本轮正常聊天、稳住现有关系温度即可，不主动试探升级、不收集新的里程碑信息；她主动给信号就自然接住，但不主动发起推进；情绪价值照给，绝不冷场。',
  },
};

// [v58] 阶段推进正常顺序（升级判定用：只允许顺序前进，不越级）
const STAGE_ORDER = ['未知', '朋友', '追求', '暧昧', '恋爱'];

// [v61 里程碑] 关系推进里程碑链（默认一路推到恋爱要逐个拿下的"小目标"）
//   顺序有讲究：先易后难、先公开后私密、先线上后线下——
//   照片(吸引力确认) → 年龄(基础信息) → 喜好(邀约弹药) → 住哪(距离判断) →
//   家庭(信任表态) → 恋爱经历(私密升级) → 敏感面(情绪信任) → 加微信(渠道升级) → 约会(线下落地)
//   [v61b] 排序修正：喜好提前到住哪前（聊天初期即可收集，作邀约弹药）；
//   里程碑不阻塞关系升级——stage 推进只看兴趣信号，里程碑只是每轮的"战术抓手"。
const MILESTONE_CHAIN = ['照片', '年龄', '喜好', '住哪', '家庭', '恋爱经历', '敏感面', '加微信', '约会'];

// [v61] 各里程碑对应的"本轮推进话术方向"（带台阶可退，军师用来主动引导）
const MILESTONE_TIPS: Record<string, string> = {
  '照片': '自然地要一张她的照片（"看看你长啥样，下次别认错人"），或先发自己的一张引导互换；她给了就顺势夸一句并记下。',
  '年龄': '轻巧地聊到年龄（"你看着不像 xx 岁，是不是改小了两岁"），交换信息时自然带出；别像查户口。',
  '喜好': '深挖一个具体喜好（吃的/玩的/歌/电影），问出能当"邀约由头"的细节（如最爱的店、最想看的电影），记住并复用；这是最轻松的破冰话题，聊天早期就该多攒。',
  '住哪': '聊到她住哪个区/通勤（"你平时在哪个区活动，那边好吃的多吗"），为以后的约地点/接人做铺垫；顺口带出自己住哪。',
  '家庭': '聊家庭/家乡/成长背景（"你是本地人吗，家里几个孩子"），自然地交换，拉近"自己人"的感觉，不盘问。',
  '恋爱经历': '半开玩笑地聊情感史（"像你这样的应该不缺人追吧"），引导她讲上一段/恋爱观；她愿意说 = 信任升级，接住情绪别评判。',
  '敏感面': '引导她说出脆弱/真实的一面（烦恼、压力、怕什么），先共情接住再推进；她向你展露情绪 = 最重要的信任里程碑。',
  '加微信': '给出一个自然的由头换微信（"App 老吞消息，加个微信吧，改天发我那家店"），拿到微信 = 渠道升级，之后推进更直接。',
  '约会': '落到具体见面：用已收集的喜好/住哪做模糊邀约（"改天带你去你说的那家店"），她接住就敲定时间地点，不现实就改约。',
};

// [v60 主动推进] 无目标时的默认推进指令：军师是主动方，不设目标也要"带着推进意图聊"
//   每个 stage 定义本轮该往哪带一步；带台阶可退（不硬推），优先调用知识库话术当弹药。
//   设了目标（goal）时由 GOAL_HINTS 接管推进方向，这里不重复注入；挽回特殊路径不推进。
const ESCALATION_HINTS: Record<string, string> = {
  '未知': '本轮主动推进：先用惯例/话术制造一点张力，为建立连接铺垫——轻松调侃、带钩子的开场或具体的小邀约由头（如"那家店感觉你会喜欢，改天带你去"），自然开场，别查户口。',
  '朋友': '本轮主动推进：从朋友往暧昧探一步——用推拉或惯例话术做一次轻度试探：模糊邀约（"改天带你去xx"）、半玩笑的拉近距离、或调侃里带一点暧昧钩子。带台阶可退：她接住就顺势带，她回避就洒脱退一步，绝不纠缠。',
  '追求': '本轮主动推进：试探暧昧窗口——半玩笑的拉近距离（如"我们俩这状态算啥"）、推拉话术制造张力、或一次具体但轻松的邀约（结合时间/地点现实性）。她给正反馈就大胆往上抬一档，冷场就换话题养氛围。',
  '暧昧': '本轮主动推进：把暧昧张力往上抬——推拉+留白+一次模糊邀约（"改天带你去那家店"）、调侃里带亲密暗示。敢于调情但守住暧昧窗口，不急着捅破，留钩子让她回味。',
  '恋爱': '本轮主动推进：维持并加固恋爱浓度——具体约见面（结合时间/地点现实性）、共同回忆或未来钩子（"下次带你尝尝我说的那家"），有情绪价值、有小脾气，但别过度客气。',
  '挽回': '',
};

// [v60 主动推进] 按当前 stage 拼装"主动推进"指令块（无目标/目标已达成时注入）
//   核心：军师是主动方——主动制造窗口（试探/邀约/张力），读反馈再决定下一步；
//   绝不表白、绝不逼问、绝不纠缠；优先调用知识库话术当弹药；挽回期禁用推进。
// [v61] 里程碑：默认推进路径 = 未完成里程碑逐个拿下（照片→…→约会），
//   stage 升级与里程碑收集互相印证：里程碑是"战术动作"，stage 是"战略判定"。
function thisEscalationBlock(stage: string, milestones: string[] = [], nextMs: string = ''): string {
  const hint = ESCALATION_HINTS[stage || '未知'];
  if (!hint) return ''; // 挽回等无推进指令的阶段：不注入
  let s = `\n\n【主动推进】(战略方向，严格遵守)\n`
    + `- 你是关系的主动推进方，不是等待者。每轮都要带着"往下一阶段带一步"的意图说话，但进攻藏在话术里，绝不暴露目的、绝不显得急。\n`
    + `- 本轮推进动作：${hint}\n`
    + `- 主动开窗：对方没给信号你就自己制造窗口——半玩笑试探、模糊邀约、调侃带钩子，选一个自然的角度发起；不必等她主动。\n`
    + `- 读反馈再决定下一步：她接住（回撩/应约/延长话题/发照片）→ 顺势再进一档；她回避/冷淡/转移 → 洒脱退一步换话题养氛围，隔 1-2 轮再推进，绝不硬推、绝不表白、绝不逼问。\n`
    + `- 弹药优先：需要具体话术时，从下方知识库参考资料里挑现成的惯例/推拉/邀约话术来执行推进，不要自己硬编。\n`
    + `- 节奏：推进频率不设限，但同一种进攻手法不要连续两轮用；情绪低落/挽回期禁用一切推进（见【节奏】）。`;
  // [v61] 里程碑引导：默认路径有"下一目标"就明确给出，让推进有抓手
  if (nextMs && MILESTONE_TIPS[nextMs]) {
    s += `\n\n【本轮里程碑目标】下一目标：「${nextMs}」\n`
      + `- 本轮主动引导，把「${nextMs}」推进/拿下：${MILESTONE_TIPS[nextMs]}\n`
      + `- 已完成的里程碑（她已给过这些信息，别再重复要）：${milestones.length ? milestones.join('、') : '（无）'}\n`
      + `- 顺序原则：按里程碑链推进（照片→年龄→喜好→住哪→家庭→恋爱经历→敏感面→加微信→约会），不跳级硬要；她给了信息就自然记住并复用（对应【我记得这些】）。`;
  }
  return s;
}

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
//   [v11] 3) 引擎层毫秒级统计：balance 话题主权 + emotion_tone 情绪初判
//   4) pulseAdvice 回写：本轮的节奏建议（是否建议延迟）计入 delay_count
async function updateMemoryCard(ctx: {
  supabaseUrl: string; token: string; anonKey: string; sessionId: string;
  history: any[]; llmKey: string; llmBase: string; llmModel: string;
  existingCard: MemoryCard | null;
  pulseAdvice?: { delay?: boolean; short?: boolean } | null;
}): Promise<void> {
  const card: MemoryCard = ctx.existingCard || { profile: {}, recent_user_messages: [] };

  // 1) 规则追加对方最近说过的话（去重：与最后一条相同则跳过）
  const lastUser = [...(Array.isArray(ctx.history) ? ctx.history : [])]
    .reverse().find((h) => h && h.role === 'user' && typeof h.content === 'string');
  const msgs = Array.isArray(card.recent_user_messages) ? card.recent_user_messages.slice() : [];
  if (lastUser && (msgs.length === 0 || msgs[msgs.length - 1] !== lastUser.content)) {
    msgs.push(truncateText(lastUser.content, 200));
    if (msgs.length > 12) msgs.splice(0, msgs.length - 12); // [v59] 20→12 记忆卡压缩降本
    card.recent_user_messages = msgs;
  }

  // [v9] 1.5) 规则追加军师(自己)发过的话（防重复：AI 需知道自己上一条说了什么）
  const lastSelf = [...(Array.isArray(ctx.history) ? ctx.history : [])]
    .reverse().find((h) => h && h.role === 'assistant' && typeof h.content === 'string');
  const selfMsgs = Array.isArray(card.recent_self_messages) ? card.recent_self_messages.slice() : [];
  if (lastSelf && (selfMsgs.length === 0 || selfMsgs[selfMsgs.length - 1] !== lastSelf.content)) {
    selfMsgs.push(truncateText(lastSelf.content, 200));
    if (selfMsgs.length > 12) selfMsgs.splice(0, selfMsgs.length - 12); // [v59] 20→12 记忆卡压缩降本
    card.recent_self_messages = selfMsgs;
  }

  // [v11] 1.6) 引擎层毫秒级统计：话题主权 balance（近 6 轮：谁发起、消息长度比）
  const hist6 = (Array.isArray(ctx.history) ? ctx.history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .slice(-6);
  const userMsgs6 = hist6.filter((h) => h.role === 'user');
  const selfMsgs6 = hist6.filter((h) => h.role === 'assistant');
  const initRatio = hist6.length >= 2 ? userMsgs6.length / hist6.length : 0.5;
  const userLenAvg = userMsgs6.length > 0
    ? Math.round(userMsgs6.reduce((a, h) => a + String(h.content).length, 0) / userMsgs6.length)
    : 0;
  const selfLenAvg = selfMsgs6.length > 0
    ? Math.round(selfMsgs6.reduce((a, h) => a + String(h.content).length, 0) / selfMsgs6.length)
    : 0;
  const direction: BalanceState['direction'] = hist6.length < 2
    ? 'balanced'
    : (initRatio < 0.4 && selfLenAvg > Math.max(userLenAvg * 1.5, 30))
      ? 'self_pursuing'
      : (initRatio > 0.6 && userLenAvg > Math.max(selfLenAvg * 1.3, 20))
        ? 'user_pursuing'
        : 'balanced';
  card.balance = {
    direction,
    user_initiate_ratio: Math.round(initRatio * 100) / 100,
    user_msg_len_avg: userLenAvg,
  };

  // [v11] 1.7) 情绪基线初判（关键词规则；画像提炼时 LLM 精修）：negative 时禁用调侃
  const lastText = userMsgs6.length > 0 ? String(userMsgs6[userMsgs6.length - 1].content) : '';
  const negScore = (/难受|伤心|难过|委屈|生气|烦|累死|累|哭|失望|讨厌|烦死|焦虑|压力/.test(lastText) ? 2 : 0)
    + (/怎么老|又|别烦|不想理|不想说/.test(lastText) ? 1 : 0);
  const posScore = (/哈哈|开心|喜欢|可爱|好呀|没问题|期待|笑死|有意思/.test(lastText) ? 1 : 0);
  let baseline: EmotionTone['baseline'] = card.emotion_tone?.baseline || 'neutral';
  if (negScore > posScore) baseline = 'negative';
  else if (posScore > 0) baseline = 'positive';
  card.emotion_tone = {
    baseline,
    volatility: card.emotion_tone?.volatility || 'moderate',
  };

  // [v11] 1.8) 节奏回写：本轮 system 是否建议了延迟 → 累计 delay_count（≥2 下轮强制恢复）
  if (ctx.pulseAdvice) {
    const cur = card.pulse || { delay_count: 0 };
    const nextDelay = ctx.pulseAdvice.delay
      ? Math.min((cur.delay_count || 0) + 1, 5)
      : Math.max((cur.delay_count || 0) - 1, 0);
    card.pulse = { ...cur, delay_count: nextDelay };
  }

  // 2) 画像合并（频率控制）
  let needProfile = true;
  if (card.updated_at) {
    const last = new Date(card.updated_at).getTime();
    needProfile = !isNaN(last) && (Date.now() - last) > MEMORY_UPDATE_INTERVAL;
  }
  if (needProfile && ctx.llmKey) {
    // [v57] extractProfile 现在返回 { profile, facts }
    const extracted = await extractProfile(ctx.llmKey, ctx.llmBase, ctx.llmModel, card, ctx.history);
    if (extracted) {
      const profile = extracted.profile;
      // [v20260805] 手动标注优先：用户在前端手动设置过 stage（stage_source=manual）时，
      //   AI 推断不覆盖手动值；恢复 AI 判断（前端清除 manual 标记）后重新接管
      const prev = card.profile || {};
      if (prev.stage_source === 'manual') {
        profile.stage = prev.stage;
        profile.stage_source = 'manual';
      }
      // [v56] 锚点保护：LLM 本轮没识别出锚点时不清空已有锚点（防反复丢失）
      if (!profile.anchor && prev.anchor) {
        profile.anchor = prev.anchor;
      }
      card.profile = profile;
      // [v57] 长期事实合并（去重 + 上限淘汰）
      mergeFacts(card, extracted.facts || []);
      // [v61] 里程碑合并（LLM 判定 + 已有并集，按链序排序）
      if (Array.isArray(extracted.milestones)) {
        card.milestones = extracted.milestones;
      }
    }
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
// [v57] 返回 {profile, facts}：profile=画像对象；facts=本轮新提取的长期事实（string[]）
// [v61] profile 新增 milestones：关系推进里程碑已完成项（照片/年龄/喜好/住哪/家庭/恋爱经历/敏感面/加微信/约会）
async function extractProfile(llmKey: string, llmBase: string, llmModel: string, card: MemoryCard, history: any[]): Promise<{ profile: any; facts: string[] } | null> {
  const cur = JSON.stringify(card.profile || {});
  const curMilestones = JSON.stringify(Array.isArray(card.milestones) ? card.milestones : []);
  const recentDialogue = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((h) => `${h.role === 'user' ? '对方' : '用户'}：${truncateText(String(h.content || ''), 200)}`)
    .join('\n');
  const prompt = `你是恋爱顾问的档案整理助手。根据最近的对话，维护"对方"的画像档案。\n当前档案：${cur}\n当前里程碑：${curMilestones}\n最近对话：\n${recentDialogue || '（无）'}\n要求：输出合并更新后的 JSON，字段：stage（关系阶段，只能是"追求/暧昧/恋爱/挽回/朋友/未知"）、personality（性格描述，≤50字）、relationship_note（关系背景，≤80字）、recent_events（最近重要事件，≤100字）、anchor（你俩对话中的长期话题锚点：反复出现或充满笑点的具体意象，如宠物/店/地名/共同物件/口头禅，≤20字；无则空字符串）、milestones（关系推进里程碑已完成项数组，从"照片/年龄/喜好/住哪/家庭/恋爱经历/敏感面/加微信/约会"9项中选出对方已给出/已发生的项，保留当前里程碑里已有的项并加上本轮新完成的，去重；没有则空数组）、facts（从最近对话里新提取的"值得跨天记住的硬事实"数组，如明确的日期/约定/生日/她的偏好/雷点/家庭/工作/宠物名，每条≤40字，最多3条；没有新事实则空数组）。\n`
    + `[v60 阶段推进] stage 判定注意：你是主动推进方。升级信号包括两类——①对方给密集兴趣信号（她主动追问、发照片、秒回、调侃你、话明显变长、约你）；②用户（你）主动试探成功：用户发出试探/邀约/调侃带钩子/试探暧昧后，她积极接住（应约、回撩、延长话题、发照片、开玩笑接梗）。两类信号任一成立，stage 可按正常顺序"朋友→追求→暧昧→恋爱"升一级（最多升一级，不越级）；\n`
    + `但若用户连续试探她都不接（冷淡/回避/转移话题/争吵），stage 可降级或改为"朋友"；拿不准就保持当前 stage 不变。只输出 JSON 对象，不要任何其他文字。`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.3, maxTokens: 500, _stage: 'extract_profile',
    });
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const p = JSON.parse(content.slice(start, end + 1));
    const facts = (Array.isArray(p.facts) ? p.facts : [])
      .map((t: any) => (typeof t === 'string' ? t.trim().slice(0, 40) : ''))
      .filter((t: string) => t.length > 0)
      .slice(0, 3);
    // [v61] 里程碑：取 LLM 判定结果 + 合并已有（LLM 可能漏报历史项，并集兜底）
    const llmMs = (Array.isArray(p.milestones) ? p.milestones : [])
      .map((m: any) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m: string) => MILESTONE_CHAIN.includes(m));
    const mergedMs = Array.from(new Set([
      ...(Array.isArray(card.milestones) ? card.milestones : []),
      ...llmMs,
    ])).filter((m) => MILESTONE_CHAIN.includes(m));
    // 按链顺序排，保证进度展示稳定
    mergedMs.sort((a, b) => MILESTONE_CHAIN.indexOf(a) - MILESTONE_CHAIN.indexOf(b));
    return {
      profile: {
        stage: typeof p.stage === 'string' && p.stage ? p.stage : '未知',
        personality: typeof p.personality === 'string' ? p.personality.slice(0, 50) : '',
        relationship_note: typeof p.relationship_note === 'string' ? p.relationship_note.slice(0, 80) : '',
        recent_events: typeof p.recent_events === 'string' ? p.recent_events.slice(0, 100) : '',
        // [v56] 话题锚点：跨轮次连续剧感的共同梗（无则空，不覆盖已有锚点由合并逻辑处理）
        anchor: typeof p.anchor === 'string' ? p.anchor.slice(0, 20) : '',
      },
      facts,
      milestones: mergedMs,
    };
  } catch (e: any) {
    console.warn('extractProfile failed:', e.message);
    return null;
  }
}

// [v57] 合并新事实到长期记忆：去重(互含视为同条并刷新提及时间) + 上限淘汰(按提及新旧)
function mergeFacts(card: MemoryCard, newFacts: string[]): void {
  const now = new Date().toISOString();
  const facts = Array.isArray(card.facts) ? card.facts.slice() : [];
  for (const t of newFacts) {
    const text = (t || '').trim().slice(0, 40);
    if (!text) continue;
    const dup = facts.find((f) => (f.text && f.text.includes(text)) || text.includes(f.text || ''));
    if (dup) {
      dup.last_mention = now; // 已有类似事实 → 只刷新提及时间
      continue;
    }
    facts.push({ text, at: now, last_mention: now });
  }
  facts.sort((a, b) => ((b.last_mention || '').localeCompare(a.last_mention || '')));
  if (facts.length > FACTS_MAX) facts.splice(FACTS_MAX);
  card.facts = facts;
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

  const prompt = `你是恋爱聊天"惯例/玩法"提炼助手。用户正在替自己用交友APP（纯文字聊天）回复对方，当前对方的话：「${truncateText(query, 60)}」。\n`
    + `以下是检索到的资料：\n${truncateText(texts, 2400)}\n`
    + `要求：如果资料中存在"分步骤、可执行"的聊天惯例/魔术/玩法（例如推拉、冷读、惯例开场、邀约流程等），提炼成步骤序列。\n`
    + `输出 JSON：{"name":"惯例名称(≤10字)","goal":"目标(≤30字)","steps":["第1步...","第2步..."]}，steps 2-6 步。\n`
    + `线上适配（必须遵守）：\n`
    + `- 所有步骤必须是"可直接发送给对方"的文字话术/话术思路（纯文字聊天场景）；\n`
    + `- 涉及肢体接触、眼神、当面魔术、现场气氛等线下动作的步骤，一律改写为文字版或删除；\n`
    + `- 允许轻度调侃/轻度否定（Neg），但禁止人身攻击、外貌否定、价值贬低；\n`
    + `- 每步可附带发送时机提示（如"对方回复后隔20-40分钟再发""对方主动追问时用"），写在该步末尾括号内；\n`
    + `- 每步一句话、具体可操作、面向"替用户给对方发消息"的执行视角。\n`
    + `如果资料中没有可执行的惯例，只输出 {"name":"","steps":[]}。只输出 JSON，不要任何其他文字。`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.2, maxTokens: 400, _stage: 'extract_strategy',
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
      // [v16] 轮数收紧：一个惯例通常一答一问两三步就完成，不再挂 6 轮下限
      //   （原 Math.max(steps.length*2,6) 导致套路对象迟迟不清空、压制其他话题）
      max_rounds: Math.max(steps.length + 1, 3),
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

// [v14] 对方攻击/挑衅/阴阳怪气检测（命中 → 注入反击指令；排除挽回期由调用方控制）
const ATTACK_RE = /你(就|真是|也太|凭什么|有什么|算个|配|只会|不过|还敢)|呵呵|呵呵哒|无语|服了|就这|搞笑|有病|弱智|智障|傻逼|滚|闭嘴|拉黑|删了|嫌你|嫌弃|配不上|看不上|幼稚|矫情|作死|省省|别来|少来|敷衍|冷漠|没意思|没趣|装什么|装|PUA|渣男|海王/;

// ============================================================
// [v15] 时间 + 位置事实块
//   解决"17点说成8点""下午说成晚上""三更半夜都能约人"等时间/空间幻觉。
//   时间：Asia/Shanghai，按"小时"粒度生成文本 → 同一小时内 system 前缀稳定，
//         保住 DeepSeek 前缀缓存（跨小时才 miss 一次，成本可接受）。
//   位置：从 profiles.bio 规则提取（城市词表 + 正则），命中才注入，绝不编造。
// ============================================================

// 小时 → 时段显式映射（LLM 直接拿结论，不再自己推断时段）
function periodOfHour(h: number): string {
  if (h >= 0 && h <= 4) return '凌晨';
  if (h >= 5 && h <= 6) return '清晨';
  if (h >= 7 && h <= 11) return '上午';
  if (h >= 12 && h <= 13) return '中午';
  if (h >= 14 && h <= 16) return '下午';
  if (h >= 17 && h <= 18) return '傍晚';   // 关键：17-18 点是傍晚不是晚上
  return '晚上';
}

function formatCurrentTime(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const y = get('year');
  const mo = get('month').replace('月', '');   // "8月" → "8"
  const d = get('day').replace('日', '');      // "5日" → "5"
  const wd = get('weekday');                   // "星期三"
  const h = parseInt(get('hour'), 10);
  const period = periodOfHour(h);
  const isWeekend = wd === '星期六' || wd === '星期日';
  // 严格小时级稳定：同一小时内文本完全相同（保证 DeepSeek 前缀缓存命中），
  // 不展示分钟——LLM 只需知道"几点多/什么时段"，误差 1 小时内不影响判断
  return `现在是${y}年${mo}月${d}日 ${wd}（${isWeekend ? '周末' : '工作日'}），${period}${h}点多（北京时间）。`;
}

// 城市/地区词表（一线/新一线/省会 + 常见地级市 + 省级名；规则提取够用，不追求穷尽）
const CITY_HINTS = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '武汉', '西安', '苏州', '南京',
  '天津', '长沙', '郑州', '东莞', '青岛', '沈阳', '宁波', '昆明', '大连', '厦门', '合肥',
  '佛山', '福州', '济南', '哈尔滨', '长春', '温州', '石家庄', '南昌', '贵阳', '南宁',
  '太原', '兰州', '银川', '乌鲁木齐', '呼和浩特', '海口', '三亚', '拉萨', '西宁',
  '泉州', '常州', '南通', '徐州', '扬州', '绍兴', '嘉兴', '金华', '台州', '惠州',
  '珠海', '中山', '江门', '汕头', '湛江', '绵阳', '泸州', '宜宾', '南充', '达州', '乐山',
  '遵义', '六盘水', '大理', '丽江', '桂林', '柳州', '襄阳', '宜昌', '岳阳', '衡阳',
  '香港', '澳门', '台北', '高雄',
  '广东', '江苏', '浙江', '四川', '湖北', '湖南', '山东', '河南', '福建', '安徽', '河北',
  '陕西', '江西', '辽宁', '吉林', '黑龙江', '山西', '云南', '贵州', '广西', '甘肃', '青海',
  '宁夏', '新疆', '内蒙古', '西藏', '海南',
];

function extractLocation(bio: string): string {
  if (!bio) return '';
  // 优先结构化表达：我在xx / 坐标xx / 住xx / 来自xx / 城市xx 等
  const m = bio.match(/(?:我在|坐标|住|人在|来自|城市|位于|常驻|base)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z]{2,12})/i);
  if (m) {
    const t = m[1];
    const hit = CITY_HINTS.find((c) => t.includes(c) || t.startsWith(c));
    if (hit) return hit;
    const suf = t.match(/^([\u4e00-\u9fa5]{2,6}[省市自治])/);
    if (suf) return suf[1];
  }
  // 兜底：全文扫城市词表（如 bio 直接写"在北京""深圳工作"）
  const hit = CITY_HINTS.find((c) => bio.includes(c));
  return hit || '';
}

function buildSystemContent(opts: {
  systemPrompt: string;
  userBio: string;
  memoryCard: MemoryCard | null;
  olderSummary: string;
  kbItems: any[];
  kbFallback: boolean;
  // [v14] 对方当前这句话（query），用于攻击性检测
  lastUserText?: string;
  // [P0-3] 窗口是否有足够历史（llmHistory ≥4 条）：
  //   true → 不注入【对方近期话】/【自己发过话】（llmHistory 已含，避免冗余）
  //   false/undefined → 注入（窗口恢复等 llmHistory 缺失场景兜底）
  hasRecentHistory?: boolean;
  // [v62 切换话题] 用户一键换话题：不延续旧话题，主动抛一个新话题开场（清套路已由外层处理）
  switchTopic?: boolean;
}): { systemContent: string; pulseAdvice: { delay?: boolean; short?: boolean } | null; factsInjected: number } {
  // [P0-3] system 组装顺序优化：固定块全部前移 → DeepSeek 前缀缓存命中
  //   （角色定位/关系阶段/简介/语气态度/自洽输出 每轮不变 → 前缀稳定）
  //   变化块（攻击检测/画像/近期话/自己话/摘要/知识库/套路/节奏）后移 → 后缀变化不影响缓存
  // [v9] 角色定位硬编码"本人"（最高优先级，覆盖后台提示词的顾问视角）：
  //   解决"顾问不需要人设一致"导致的答非所问与自相矛盾
  // [v14] 加入"有脾气"人格：真人不是客服，敢调情/敢否定/遇攻击必反击
  let s = '【角色定位】(最高优先级)\n'
    + '你正在扮演「用户本人」用交友app跟对方聊天，你就是那个说话的人，不是顾问、不是助手。\n'
    + '你是一个有血有肉的真人，有自己的脾气、态度和审美：不讨好、不卑微、不油腻，偶尔毒舌但从不没品。\n'
    + '你敢于调情（关系到位就大胆带钩子）、敢于否定（对方飘了就直接顶回去）、敢于拒绝（不想接的话题就冷着）。\n'
    + '对方挑衅、贬低或攻击你时，你必须反击，绝不委屈求全、绝不假装没看见、绝不低头解释。\n'
    + '你之前发出的每句话都是既定事实，后续回复必须与之衔接一致：不重复、不推翻、不自相矛盾。\n\n'
    + (opts.systemPrompt || '你是用户本人，一个有趣、有脾气、有底线的真人。请根据对方的原话，用你自己的语气给出可直接发出的回复：口语化、有态度、像个真人发微信。');

  // [v56 意图优先] 先解读潜台词再回复：解决"盯字面回字面"（她哈哈→你回"笑得好"这种废话）
  //   最高优先级块，紧跟角色定位；固定块，前缀缓存不受影响
  s += `\n\n【先解读再回复】(每轮最高优先，解读过程不要输出)\n`
    + `动手写回复前，先在心中回答三个问题：\n`
    + `1. 她这句话的真实意图是什么？——试探/调情/拒绝/分享情绪/考验/随口寒暄；\n`
    + `2. 她为什么这么说？——通常是我上一句的某个点触发的（梗/夸赞/邀约/冒犯/让她没接住）；\n`
    + `3. 她在期待我什么反应？——接住、推进、化解、还是换话题。\n`
    + `解读铁律：\n`
    + `- 绝不盯字面回字面。她发"哈哈"不是要你夸她笑得好，而是你上一句戳中了她的点：找到"她为什么笑"，基于原因回复——强化戳中她的那个点，或顺势推进，禁止回应笑本身。\n`
    + `- 反例（废话）：她"哈哈" → 你"你哈哈的笑，连天气都变好了"。\n`
    + `- 正例：她"哈哈"（因为你调侃她嘴硬）→ "笑这么欢，看来被我说中了，你这种女生嘴越硬心里越软"。\n`
    + `- 敷衍信号（嗯/哦/好/随便）≠ 冷漠攻击，是兴趣下降 → 换话题或侧面展示价值，不追问不施压。\n`
    + `- 借口信号（太远/没空/改天/要睡了）→ 先判断是考验还是真拒绝：考验就幽默化解+留钩子，真拒绝就洒脱退一步绝不纠缠。`;

  // [v15] 当前时间（小时级稳定，不破坏前缀缓存）+ 我的位置（从简介提取，命中才注入）
  //   放在角色定位后、语气态度前：基础事实靠前才有约束力
  s += `\n\n【当前时间】（必须严格遵守，所有时刻/时段/星期表述以此为准）\n${formatCurrentTime()}\n`
    + `- 严禁编造或猜错时刻；说"今晚/明天/周末/这么晚/三更半夜"等词必须与这个时间一致；\n`
    + `- 判断"现在这个点还适不适合约人、打电话、聊深夜话题"以此为准，不要半夜答应见面或深夜约人。`;
  const myLoc = extractLocation(opts.userBio || '');
  if (myLoc) {
    s += `\n\n【我的位置】（涉及见面、约人、距离、异地等表述以此为准）\n我所在城市：${myLoc}。\n`
      + `- 不知道对方在哪时不得假设对方离我很近；\n`
      + `- "过来找你/见面/顺路/接送"等邀约，必须同时结合【当前时间】与【我的位置】判断是否现实，不现实就委婉拒绝或改约。`;
  }

  // [v11 迷男OS] 线上语境 + 轻度否定（Neg 轻度化保留：迷男"否定-地位博弈"的线上版）
  // [v14] 升级为【语气与态度】：从"软化、克制"改为"敢调情/敢否定/敢反击"，保留安全边界
  // [P0-3] 固定块前移：语气态度不随轮次变化，放前缀内提高缓存命中
  s += `\n\n【语气与态度】（严格遵守）\n`
    + `- 你不是客服，说话要有态度：该热情就热情，该冷淡就冷淡，该怼就怼。永远温吞、永远顺着对方 = 无趣。\n`
    + `- 敢于调情：暧昧/恋爱阶段直接一点，把"想你"说成带钩子的话（如"今晚梦到我没？"），用文字张力推进，别端着。\n`
    + `- 敢于否定：对方说得不对、太飘、太装、或者拿你开涮时，直接顶回去（幽默反击/犀利回怼/轻蔑留白），制造一点地位博弈的张力，而不是讨好。只怼她的"行为/措辞/态度"，不贬低外貌/性格/价值。\n`
    + `- 敢于拒绝和冷淡：不想接的话题就冷着、不回、或者故意岔开；别每条都秒回、别话痨，偶尔留白让她猜。\n`
    + `- 遇到攻击必须反击：对方阴阳怪气、贬低你、试探你底线时，立刻反击，绝不卑微解释、绝不假装没事、绝不低头讨好（见上方【对方正在攻击/挑衅你】）。\n`
    + `- 安全边界：以上一切"敢"都建立在有品的基础上——不骂脏话、不人格侮辱、不戳对方痛处；\n`
    + `- 对方情绪低落、真正受伤或关系处于挽回期 → 收起锋芒，先共情再说话，此场景禁用调侃与反击。\n`
    + `- 推拉结构：推拉三步必须压缩进同一句话——用措辞同时完成"正面回应+轻调侃/留白+钩子"，严禁拆成分句输出。如她"呵呵 就你这样？"你一句"放心 我没打算追你 你倒先给自己加戏了"（回应+调侃+钩子全在里面）。\n`
    + `- 每轮只发 1 句，把最狠、最钩人的那一句发出去，宁缺毋滥。\n`
    + `- [v56] 幽默优先用双关/谐音/具体意象：把她的词接出第二层意思制造会心一笑（如她说"放盐"→你接"咸淡"→"生小孩"；她说"远"→你接"哪个山头修炼"）。拒绝空洞夸赞和直给式调侃（"你笑得好美"=废话，"你这种女生嘴越硬心里越软"=双关）。\n`
    + `- [v56] 她说的话里藏着可延伸的意象（宠物/地名/店/物件/口头禅）就抓住它做文章，而不是换一个新话题回应。`;

  // [v9] 自洽 + 输出要求：先正面回应再转折，严禁自相矛盾/重复；放宽为 1-2 句
  // [v51] 硬字数上限：1-2 句 → ≤30 字（通常 1 句 ≤20 字）；推拉已压进一句（见【语气与态度】）
  // [P0-3] 固定块前移（同语气态度）
  s += `\n\n【自洽与输出要求】（严格遵守）\n`
    + `- 你是同一个人，必须逻辑自洽：严禁自相矛盾、严禁推翻自己说过的话、严禁答非所问。\n`
    + `- 对方问什么，第一句必须正面回答；想幽默或转折，必须先正面回应再转折。\n`
    + `- 严禁重复你之前发过的任何一句话（含意思相近的说法）。\n`
    + `- 硬字数：整条回复 ≤30 字，通常 1 句（≤20 字），最多 2 句合计 ≤30 字。超过 30 字 = 失败，必须压缩重写后再输出。\n`
    + `- 只输出可直接复制发给对方的话术本体；不要输出【分析】【建议】、序号、步骤、进度、括号说明等任何附加内容；口语化、贴合当前关系阶段，像真人发微信。\n`
    + `- 字数范例（学这个密度）：她"今天好无聊呀" → "这么闲？我有个消磨时间的绝招"（17字）；她"呵呵 就你这样？" → "放心 我没打算追你 你倒先给自己加戏了"（19字）；她"我觉得男生就该天天哄女生" → "那你还得找个保姆型的"（10字）。`;

  // [v56 兴趣信号升级] 她给 IOI 必须推进关系，只接话不推进=浪费信号
  s += `\n\n【兴趣信号与升级】（严格遵守）\n`
    + `- 兴趣信号(IOI)：主动追问你、发照片、说喜欢你/想念、主动约时间、深夜还聊、主动报备行踪、给你起外号 = 信号。\n`
    + `- 命中信号必须把关系往前推一步：邀约（明确时间地点）、试探（"那下次带你去？"）、亲密升级（调侃里带暧昧），选当前关系阶段能接住的那一档。\n`
    + `- 只接话不推进 = 浪费信号，等于告诉她你没兴趣；但也不要一步跳太远（刚认识就约家里），每轮推进一档即可。`;

  // [v56 话题锚点] 记忆卡 profile.anchor：跨轮次围绕同一意象延伸，像连续剧
  const anchor = opts.memoryCard?.profile?.anchor || '';
  if (anchor) {
    s += `\n\n【话题锚点】你和她的对话有一个长期共同梗：「${anchor}」——它是你俩的专属记忆，用来拉近距离。\n`
      + `- 每轮尽量自然地把它挂进回复（提一嘴、延伸、用它当邀约由头），但不生硬、不每句都提；\n`
      + `- 它出现在她的话里时，立刻抓住做文章（升级/调侃/延伸），别忽略。`;
  }

  // 场景指令（L3：按关系阶段注入指导）——阶段相对稳定，放前缀后段
  const stage = opts.memoryCard?.profile?.stage || '';
  if (stage && STAGE_HINTS[stage]) {
    s += `\n\n【当前关系阶段】${STAGE_HINTS[stage]}`;
  }

  // 用户简介（固定）
  if (opts.userBio && opts.userBio.trim()) {
    s += `\n\n【用户个人简介】（对话中请结合以下用户信息给出更个性化的建议）\n${opts.userBio.trim()}`;
  }

  // ===== 以下为每轮变化块（后缀，不影响缓存前缀）=====

  // [v14] 对方正在攻击/挑衅 → 注入反击强化指令（变化，置于前缀之后）
  const lastUserText = opts.lastUserText || '';
  const stageNow = opts.memoryCard?.profile?.stage || '';
  const attackDetected = !!lastUserText.trim()
    && stageNow !== '挽回'
    && ATTACK_RE.test(lastUserText);
  if (attackDetected) {
    s += `\n\n【对方正在攻击/挑衅你】（最高优先级，必须执行）\n`
      + `- 对方这句话带有攻击、贬低或阴阳怪气的意味，你被冒犯了。绝不能卑微道歉、绝不能假装没看见、绝不能跪舔讨好。\n`
      + `- 立刻反击：用幽默反击（先顺着她的话接住，再轻轻扎回去）、犀利回怼或冷淡留白，一句话把态度亮出来。\n`
      + `- 反击要有底气但不失风度：就事论事怼她的言行，不骂脏话、不贬低外貌/性格/价值，怼完留个钩子（反问/留白）把主动权拿回自己手里。\n`
      + `- 如果她只是真正情绪低落（受伤、难过、哭），那是两码事：先共情，别反击。`;
  }

  // 记忆卡：对方画像（跨轮次相对稳定，但会随 updateMemoryCard 变化，放后缀）
  const profile = opts.memoryCard?.profile;
  if (profile && (profile.personality || profile.relationship_note || profile.recent_events)) {
    const parts: string[] = [];
    if (profile.personality) parts.push(`性格：${profile.personality}`);
    if (profile.relationship_note) parts.push(`关系背景：${profile.relationship_note}`);
    if (profile.recent_events) parts.push(`最近事件：${profile.recent_events}`);
    s += `\n\n【对方画像记忆】（跨轮次记住，回答时不要重复询问这些已知信息）\n${parts.join('\n')}`;
  }

  // [P0-3] 去冗余：llmHistory ≥4 条时，其内容已含对方近期话/自己发过话，不再注入
  //   （仅窗口恢复等 llmHistory 缺失场景注入，防重复占用上下文）
  const hasRecent = opts.hasRecentHistory === true;
  // 记忆卡：对方近期说过的话
  const msgs = opts.memoryCard?.recent_user_messages || [];
  if (!hasRecent && msgs.length > 0) {
    s += `\n\n【对方近期说过的话】（供判断语感与关系状态）\n${msgs.slice(-8).join('\n')}`;
  }

  // [v9] 记忆卡：军师(自己)发过的话（防重复 + 保自洽；窗口 history 丢失后仍有效）
  const selfMsgs = opts.memoryCard?.recent_self_messages || [];
  if (!hasRecent && selfMsgs.length > 0) {
    s += `\n\n【你之前发过的话】（跨轮次记住，严禁原样或意思重复，后续回复必须与之一致衔接）\n${selfMsgs.slice(-8).join('\n')}`;
  }

  // 更早对话摘要
  if (opts.olderSummary) {
    s += `\n\n${opts.olderSummary}`;
  }

  // [v57] 长期事实选择性注入：按当前 query 相关度挑 top N（不全量塞，防记忆稀释）
  //   像人一样"根据当前话题想起相关的事"；无相关事实则不注入
  let factsInjected = 0;
  const factsList = opts.memoryCard?.facts || [];
  const qText = opts.lastUserText || '';
  if (factsList.length > 0 && qText.trim()) {
    const qs = qText.replace(/\s/g, '');
    const scoredFacts = factsList
      .map((f) => {
        const ft = (f.text || '').replace(/\s/g, '');
        let hit = 0;
        for (let i = 0; i + 2 <= ft.length; i++) {
          if (qs.includes(ft.slice(i, i + 2))) hit++;
        }
        return { f, hit };
      })
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .slice(0, FACTS_INJECT_MAX);
    if (scoredFacts.length > 0) {
      factsInjected = scoredFacts.length;
      s += `\n\n【我记得这些】(长期记忆，按当前话题想起的)\n`
        + scoredFacts.map((x) => `- ${x.f.text}`).join('\n')
        + `\n- 结合它们自然回应：对方提到相关的事时，要自然带出"我记得"的感觉，别生硬背诵、别每条都提。`;
    }
  }

  // [v58/v61] 关系目标 + 里程碑进度（战略层）：用户设了 goal 按目标使劲；
  //   没设 goal = 默认一路推进到恋爱（未知→朋友→追求→暧昧→恋爱）；
  //   "保持当前关系" = 用户选择停止升级，只维持现状。
  //   [v61] 里程碑：推进时按"下一个未完成里程碑"给具体引导；已完成的展示进度。
  const goal = opts.memoryCard?.goal || '';
  const goalHint = GOAL_HINTS[goal];
  const curStage = opts.memoryCard?.profile?.stage || '';
  const milestones = Array.isArray(opts.memoryCard?.milestones) ? (opts.memoryCard!.milestones!) : [];
  const nextMs = MILESTONE_CHAIN.find((m) => !milestones.includes(m)) || '';

  if (goal === '保持当前关系') {
    // 停止升级：只显示进度 + 维持现状指令（GOAL_HINTS 已含 hint）
    s += `\n\n【关系里程碑】(已暂停推进，保持当前关系)\n`
      + `已完成：${milestones.length ? milestones.map((m) => '✓' + m).join(' ') : '（无）'}\n`
      + `待完成：${nextMs || '全部完成'}\n`
      + `- 用户明确选择保持当前关系：本轮及后续都不主动推进升级、不引导新的里程碑信息；正常聊天稳住温度即可。\n`
      + `- 她主动提起或主动给信息时自然接住，但绝不主动发起试探/邀约/收集；情绪价值照给，绝不冷场。`;
  } else if (goalHint) {
    const curIdx = STAGE_ORDER.indexOf(curStage);
    const goalTarget = goal === '挽回修复' || goal === '推进恋爱'
      ? '恋爱'
      : goal === '约见面' ? '' : '暧昧';
    const goalIdx = goalTarget ? STAGE_ORDER.indexOf(goalTarget) : -1;
    const achieved = goalIdx > -1 && curIdx >= goalIdx;
    if (!achieved) {
      s += `\n\n【关系目标与进度】(战略方向，严格遵守)\n`
        + `目标：${goal}\n`
        + `当前阶段：${curStage || '未知'}\n`
        + `本轮动作：${goalHint.hint}`;
      // 目标推进中：里程碑作为战术弹药（除非目标是挽回——挽回期不收集里程碑）
      if (goal !== '挽回修复') {
        s += `\n\n【关系里程碑】(推进进度)\n`
          + `已完成：${milestones.length ? milestones.map((m) => '✓' + m).join(' ') : '（无）'}\n`
          + `下一目标：${nextMs ? `「${nextMs}」——${MILESTONE_TIPS[nextMs] || ''}` : '里程碑全部完成，正常升温即可'}\n`
          + `- 本轮在完成目标的同时，尽量自然地把「${nextMs || ''}」往前推一步，但不强行、不盘问；对方明显抗拒就换一个，过几轮再试。`;
      }
    } else {
      // [v60] 目标已达成：不再按目标使劲，改按里程碑/当前 stage 继续（恋爱后还差"约会"等）
      s += thisEscalationBlock(curStage, milestones, nextMs);
    }
  } else {
    // [v60/v61 默认推进] 没设目标 = 默认从当前阶段一级一级推进到恋爱（用户用军师就是为了谈恋爱）
    s += thisEscalationBlock(curStage, milestones, nextMs);
  }

  // [v62 切换话题] 用户一键换话题：覆盖推进，本轮唯一任务 = 抛一个新话题开场
  //   放在所有目标/推进指令之后 = 最高优先级；检索词已切到"新话题/开场白"方向
  if (opts.switchTopic) {
    s += `\n\n【切换话题】(本轮最高优先级，覆盖上面的所有目标与推进指令)\n`
      + `- 用户对当前话题不满意，要求换一个新话题继续聊。\n`
      + `- 本轮任务：给出一句可以直接发给对方的新话题开场白（1 句，≤30 字，带钩子/情绪/好奇心）。\n`
      + `- 新话题从哪来（按优先级）：①记忆卡/长期事实里她聊过、但还没深挖的兴趣点（如"你上次说的那家店"）；②话题锚点 anchor；③下面知识库参考资料里的开场白/惯例；④结合当前时间/位置的轻松日常话题（天气、最近热门、吃的）。\n`
      + `- 禁忌：不延续旧话题、不道歉、不解释为什么换话题、不提"换个话题吧"这种元话术；直接自然开场，像想到什么随口问一样。\n`
      + `- 输出只需这一句话术本体，不要任何附加说明。`;
  }

  // 知识库参考
  if (opts.kbItems.length > 0) {
    const kbText = opts.kbItems
      .map((item, i) => `【参考资料 ${i + 1}】${item.title}\n${item.content || ''}`)
      .join('\n\n');
    // [v9] 参考资料降级为"弹药"：只提供语气/角度/措辞，冲突时以对话连续性为准
    // [v52 S1] 口水过滤引导：检索块混有口水文，只吸收金句，不被带偏
    s += `\n\n以下是从知识库检索到的参考资料。它们只是弹药：仅提供语气、角度、措辞素材；\n当参考内容与你之前说过的话或当前对话逻辑冲突时，以对话上下文为准，忽略参考。\n`
      + `注意：参考里混有口水文（铺垫、说教、废话、车轱辘话），只吸收其中"可直接复制的话术/金句/例子"；\n口水段落直接跳过，不要被它带偏你的风格和字数。\n${kbText}`;
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
      + `- 套路决定对话方向；但对方抛出明显更有趣/更投入/更感兴趣的新话题时，优先跟随对方，套路自然搁置、不强拉回。\n`
      + `- 参考资料与套路冲突时以对话连续性为准；方向一致才采用参考素材。\n`
      + `- 根据对方最新反应自然推进：先顺应对方，再判断要不要往套路方向带，绝不生硬。\n`
      + `- 严禁向对方提及套路、步骤、进度、惯例、第几步等任何元信息，输出必须是可直接发送的自然消息。\n`
      + `- 当对方反应表明套路目标已达成或已失效、或话题已自然转移时，套路视为完成，自然过渡到正常聊天，不要强行拉回。`;
  }

  // [v11 迷男OS] 节奏建议（引擎层 → 线上"假性时间限制"）：delay 建议回写记忆卡
  const pulse = opts.memoryCard?.pulse || {};
  const balance = opts.memoryCard?.balance;
  const emotion = opts.memoryCard?.emotion_tone;
  let pulseAdvice: { delay?: boolean; short?: boolean } | null = null;
  const delayCount = pulse.delay_count || 0;
  const isNegative = emotion?.baseline === 'negative';
  if (delayCount >= 2) {
    // 礼貌阈值：已连续建议延后两轮，强制恢复正常节奏，防"冷暴力"观感
    s += `\n\n【节奏】前面已经自然放慢过节奏，本轮立即正常回复，不要刻意延后，也无需秒回。`;
  } else if (isNegative) {
    s += `\n\n【节奏】对方当前情绪不好，本轮尽快回复（不要刻意延后），先给到情绪价值。`;
  } else if (balance?.direction === 'self_pursuing') {
    s += `\n\n【节奏】你最近一直在主动追话题、消息偏长，需求感有点外露。本轮：回复短一点（1 句即可），自然延后 20-40 分钟再发，把节奏主动权收回来。`;
    pulseAdvice = { delay: true, short: true };
  } else if (balance?.direction === 'user_pursuing') {
    s += `\n\n【节奏】对方最近明显更主动、消息也更长，这是升温信号。本轮顺势热聊，不用刻意延后，回复热情一点、适当带钩子。`;
  } else {
    s += `\n\n【节奏】按正常聊天节奏回复即可，不用刻意延后，也不必秒回。`;
  }

  return { systemContent: s, pulseAdvice, factsInjected };
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
  messages: any[], opts: { temperature?: number; maxTokens?: number; frequencyPenalty?: number; presencePenalty?: number; thinking?: ThinkingMode; _stage?: string } = {}
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
  // [vB] usage 采集（token 测量用，_debug 透传）
  if (data?.usage) {
    llmUsageLog.push({ stage: (opts as any)._stage || 'llm', usage: data.usage });
  }
  return content.trim();
}

// [vB] LLM usage 日志（token 测量；顶层声明防作用域事故）
const llmUsageLog: { stage: string; usage: any }[] = [];

// ============================================================
// [v53] 精华打分（零 LLM，规则驱动）：金句信号加分、口水信号减分
//   用途：RPC 相关分之外的质量分，混合排序 + 剔口水
//   设计要点：纯文本规则、可解释、随时调参；不增加任何 LLM 调用
// ============================================================
const GEM_WEIGHT = 0.8;                 // 精华分合并权重（相关分仍为主序）
const GEM_MIN = -1;                     // 低于此分 = 口水块，直接剔出候选池
const GEM_DIALOG_RE = /[""「」『』]/g;   // 对话示范引号（可复制例句）
const GEM_ACTION_RE = /你说|你就|不如|试试|可以说|跟她说|告诉她|回她|回他/; // 可操作话术
const GEM_CONNECTOR_RE = /首先|然后|总之|因此|很多人|一般来说|所以说/;      // 说教连接词
const GEM_ADJ_RE = /非常|真的|特别|超级|十分|极其/;                       // 形容词堆砌
const GEM_FLUFF_RE = /我觉得|其实呢|我们要知道|大家都知道/;               // 空话套话
const GEM_SYMBOL_RE = /→|｜|👉/;                                        // 金句符号（话术分隔）
const GEM_TITLE_RE = /话术|案例|例句|实战|示例/;                          // 块标题命中

function calcGemScore(content: string, blockTitle: string): number {
  const c = content || '';
  if (!c) return 0;
  let gem = 0;
  // 加分：对话示范
  const quotes = Math.floor((c.match(GEM_DIALOG_RE) || []).length / 2);
  if (quotes >= 2) gem += 1.5;
  else if (quotes >= 1) gem += 0.8;
  // 加分：可操作话术
  if (GEM_ACTION_RE.test(c)) gem += 0.5;
  // 加分：短句密度（平均句长 ≤12 字 = 口语化金句）
  const sents = c.split(/[。！？!?；;\n]+/).filter((s) => s.trim().length > 0);
  const avgLen = sents.length ? c.replace(/\s/g, '').length / sents.length : 99;
  if (avgLen <= 12) gem += 0.6;
  // 加分：金句符号
  if (GEM_SYMBOL_RE.test(c)) gem += 0.4;
  // 加分：块标题含话术/案例
  if (blockTitle && GEM_TITLE_RE.test(blockTitle)) gem += 0.5;
  // 减分：说教连接词 ≥3
  if ((c.match(GEM_CONNECTOR_RE) || []).length >= 3) gem -= 1.0;
  // 减分：>30 字长句 ≥2（铺垫）
  if (sents.filter((s) => s.length > 30).length >= 2) gem -= 0.6;
  // 减分：形容词堆砌 ≥3
  if ((c.match(GEM_ADJ_RE) || []).length >= 3) gem -= 0.5;
  // 减分：空话套话 ≥2
  if ((c.match(GEM_FLUFF_RE) || []).length >= 2) gem -= 0.5;
  return Math.max(-2, Math.min(3, gem));
}

// ============================================================
// [B方案] 本地块级召回（唯一检索入口，完全移除 IMA）
//   kb_blocks 表（739 块，仅恋爱话术）：bigrams GIN 粗筛 + 块内词频加权打分（RPC kb_blocks_recall）
//   [2026-08-06] 权重：语义词×2 / 规则词与原文×1.5（整句路已移除）
//   块内容 ≤700 字直接原文进上下文——无需下载全文、无需 summarizeRef
//   返回 items 带 _fulltext 标记与 _ft_score；同文档最多 2 块（RPC 内去重）
//   失败/空缓存 → 返回 []，不影响主链路
// ============================================================
async function recallBlocks(
  supabaseUrl: string, serviceRoleKey: string,
  semanticKws: string[], extraQueries: string[],
  opts?: { pickCount?: number; hsFolder?: string | null; jxFolder?: string | null; strategyActive?: boolean }
): Promise<any[]> {
  try {
    // 查询词集：语义词 + 额外词（规则词/原句 bigram 垫底）
    const queries = [...semanticKws, ...extraQueries]
      .filter((q) => q && typeof q === 'string' && q.trim().length >= 2);
    if (queries.length === 0) return [];

    // 1. 查询词集 → bigram 数组（过滤全停用字 2-gram）
    const grams = new Set<string>();
    const addGrams = (text: string) => {
      const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
      for (let i = 0; i + 2 <= clean.length; i++) {
        const bg = clean.slice(i, i + 2);
        const chars = bg.split('');
        if (chars.every((c) => STOP_CHARS.has(c))) continue;
        grams.add(bg);
        if (grams.size >= 200) return;
      }
    };
    for (const q of queries) addGrams(q);
    if (grams.size === 0) return [];

    // 2. 权重数组（与 queries 同序：语义词 2 / 其他 1.5）
    const semanticSet = new Set(semanticKws);
    const weights = queries.map((q) => (semanticSet.has(q) ? 2 : 1.5));

    // 3. 调数据库 RPC：粗筛+块内词频打分+同文档去重+limit 一次完成
    // [v53] p_limit 12→24：多捞候选池给 gem 精排（候选只做重排，最终仍取 target 进 LLM，token 不变）
    const target = opts?.pickCount || KB_REF_COUNT;
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/kb_blocks_recall`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_grams: [...grams].slice(0, 80),
        p_words: queries.slice(0, 20),
        p_weights: weights.slice(0, 20),
        p_limit: Math.max(target * 4, 24),
        p_max_blocks_per_doc: 2,
      }),
    });
    if (!resp.ok) return [];
    const rows: any[] = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];

    let items = rows.map((r) => ({
      media_id: r.media_id,
      block_idx: r.block_idx,
      title: r.title,
      block_title: r.block_title || '',
      folder_id: r.folder_id || '',
      content: r.content || '',
      _hits: 1, _semanticHits: 0, _fulltext: true, _ft_score: Number(r.score) || 0,
    }));

    // [v53] 内存 gem 精排：算精华分 → 剔口水块(< GEM_MIN) → 按 相关分+gem×权重 重排
    //   全被剔光时退回原始列表（保证有弹药可用）；排序后 applyQuota 从精排池里挑
    const scored = items
      .map((it) => ({ ...it, _gem: calcGemScore(it.content || '', it.block_title || '') }))
      .filter((it) => it._gem >= GEM_MIN)
      .sort((a, b) => ((b._ft_score || 0) + (b._gem || 0) * GEM_WEIGHT) - ((a._ft_score || 0) + (a._gem || 0) * GEM_WEIGHT));
    if (scored.length > 0) items = scored;

    // 4. 状态感知配额（仅剩恋爱话术一类；jx 空时 hs 吃满，见 applyQuota）
    return opts ? applyQuota(items, {
      hsFolder: opts.hsFolder,
      jxFolder: opts.jxFolder,
      strategyActive: !!opts.strategyActive,
      pickCount: target,
    }) : items.slice(0, target);
  } catch (e: any) {
    console.warn('recallBlocks failed:', e.message);
    return [];
  }
}

// ============================================================
// [B方案] 标题兜底：块级召回空时，按关键词过滤本地 kb_blocks 标题
//   REST 查询：title=ilike.*词* 匹配文档标题，取每文档第一块
// ============================================================
async function browseBlocksByTitle(
  supabaseUrl: string, serviceRoleKey: string,
  query: string, opts?: { pickCount?: number; hsFolder?: string | null; jxFolder?: string | null; strategyActive?: boolean }
): Promise<any[]> {
  try {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];
    const target = opts?.pickCount || KB_REF_COUNT;
    const out: any[] = [];
    const seen = new Set<string>();
    for (const kw of keywords) {
      if (out.length >= target) break;
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/kb_blocks?select=media_id,block_idx,title,block_title,folder_id,content&title=ilike.*${encodeURIComponent(kw)}*&limit=10&order=block_idx.asc`,
        { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
      );
      if (!resp.ok) continue;
      const rows: any[] = await resp.json();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (out.length >= target) break;
        const key = r.media_id + ':' + r.block_idx;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          media_id: r.media_id, block_idx: r.block_idx, title: r.title,
          block_title: r.block_title || '', folder_id: r.folder_id || '',
          content: r.content || '',
          _hits: 0, _semanticHits: 0, _fulltext: true, _ft_score: 0,
        });
      }
    }
    return out.slice(0, target);
  } catch (e: any) {
    console.warn('browseBlocksByTitle failed:', e.message);
    return [];
  }
}

// ============================================================
// [v7] 状态感知配额：话术/教学两类内容按 strategy 状态分桶选取，
//   保证"话术加权"不消灭策略素材——两类始终同在上下文，LLM 自行取舍
//   执行期：话术 ≤3 + 教学 ≤2；未启动期：教学 ≤3 + 话术 ≤2
//   [B方案] hs/jx 判定改用 folder_id（本地 kb_blocks：恋爱话术=hs，恋爱教学/聊天实战=jx）
//   [2026-08-06] 教学/实战已删库：jx 为空时 hs 直接吃满 pickCount
//     （否则上下文弹药从 5 条缩水到 2-3 条，务必保留 !jx 分支）
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
    const pid = it.folder_id || it.parent_folder_id || '';
    if (hs && pid === hs) hsList.push(it);
    else if (jx && pid === jx) jxList.push(it);
    else otherList.push(it);
  }

  const hsQuota = !jx ? count : (opts.strategyActive ? 3 : 2);
  const jxQuota = !jx ? 0 : (opts.strategyActive ? 2 : 3);
  const picked = [
    ...hsList.slice(0, Math.min(hsQuota, count)),
    ...jxList.slice(0, Math.min(jxQuota, count)),
    ...otherList,
  ];
  return picked.slice(0, count);
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
//   llm_params 存 JSON 字符串：{"temperature":0.6,"frequency_penalty":0.7,"presence_penalty":0,"max_tokens":1200,"thinking_mode":"off"}
// ============================================================
type LlmParams = {
  temperature: number;
  frequency_penalty: number;
  presence_penalty: number;
  max_tokens: number;
  thinking_mode: ThinkingMode;
};
// [v14] temperature 0.4→0.6、frequency_penalty 0.5→0.7：输出更有性格方差、更少模板腔
const DEFAULT_LLM_PARAMS: LlmParams = { temperature: 0.6, frequency_penalty: 0.7, presence_penalty: 0, max_tokens: 1200, thinking_mode: 'off' };

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

