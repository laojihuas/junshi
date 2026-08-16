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
//   - 保留：语义拆解(v8) + 状态配额(v7)
//   - [2026-08-11] 套路机制整体移除（v7→v151 全链路清除）：仅保留弹药(话术)检索
//   - [2026-08-06] 知识库瘦身为恋爱话术 739 块（教学/实战删库）：
//     整句压缩(v12) 移除（话术库无问题语域，LLM 整句短语命中 0-37 块 vs bigram 270-596），
//     语义词表按话术库命中校准（20 个教学理论词零命中已移除）
//   - 环境变量仅需：LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
//
// [v14 有脾气·真人化]（解决"输出过于礼貌、不像真人"，2026-08-03）
//   - 角色定位重写：有血有肉的真人——有脾气、有态度，不是客服/老好人
//   - 敢调情：暧昧/恋爱阶段直接带钩子，别温吞水
//   - 敢否定(Neg)：对方飘/装/拿你开涮时直接顶回去，制造张力而非讨好
//   - 遇攻击必反击：ATTACK_RE 检测对方攻击/挑衅/阴阳怪气，
//     命中注入【对方正在攻击你】强化块：先反击再收尾，绝不卑微解释/讨好
//   - 【线上语境与轻度否定】升级为【语气与态度】：保留安全边界（禁外貌/
//     性格/价值贬低、情绪低落或真正受伤时收起锋芒），放开"敢"的权限
//   - 默认温度 0.4→0.6、frequency_penalty 0.5→0.7：输出更有性格方差
//   - _debug 新增 attack_detected
//
// [v51 字数压缩]（解决"输出字数偏多"，2026-08-05，A+B+C 方案）
//   - A 硬字数：整条 ≤30 字（通常 1 句 ≤20 字，最多 2 句合计 ≤30 字），超过=失败必须压缩重写
//   - [v73] 用户定稿：整条 ≤20 字（通常 1 句），同步【切换话题】开场白 ≤20 字
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
// [v58→v141→v20260813→2026-08-15 战略层演进]（目标引导已删，攻略已砍，话题清单已砍）
//   - [v141] GOAL_HINTS 目标引导与 ESCALATION 默认推进已删除（从未见效且与攻略重复，浪费 token）
//   - memory_card.goal 仅剩两个语义：'保持当前关系'（不升级）或 空（默认推进，前端只剩这两个选项）
//   - [v20260813 攻略已砍] 战略驱动 = 关系话题清单；[2026-08-15 话题清单已砍]（用户拍板）
//     推进改由战术卡组 + 知识库弹药 + 机会窗口承担，战略层不再注入方向指令
//   - extractProfile 阶段推进：信号密集(主动追问/发照片/秒回/约你)按 吸引→舒适→恋爱
//     最多升一级；冷淡/回避可降级；拿不准保持
//   - 战略层(目标/清单已删) > 弹药层(锚点/幽默/IOI) 两层叠加（战术层套路已于 2026-08-11 移除）
//
// [v11 迷男OS]（线下技巧 → 线上场景深度融合，2026-08）
//   - 架构：战略层(记忆卡 stage 定基调) + 引擎层(pulse/balance/emotion_tone 实时输入)
//     （战术层 strategy 套路已于 2026-08-11 移除）
//   - STAGE_VOCAB：91 词表按 M3 四阶段(meet/attract/comfort/seduction)打标分组，
//     语义拆解按"当前目标"加权：目标词 > 语义词 > bigram > 原句
//   - memory_card 新增 pulse(节奏)/balance(话题主权)/emotion_tone(情绪基线)：
//     毫秒级规则统计，防止需求感外露与连续延迟(冷暴力)
//   - buildSystemContent 新增【节奏】(礼貌阈值+延后计数) 与
//     【线上语境与轻度否定】(Neg 轻度化：只调侃行为措辞、禁人身攻击、
//     推拉结构=先回应再调侃再留钩子) 两个硬约束块
//   - [2026-08-11] extractStrategy 线上化已随套路机制整体移除
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
//   - 内部辅助调用（rewriteQuery/语义拆解/定向摘要/画像提取）保持显式
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
//   - TOPIC_VOCAB 领域词表 78 词 5 类（2026-08-06 校准后实测）：情绪状态 10 / 关系阶段 11 /
//     场景需求 23 / 对方性格 7 / 惯例术语 27（由本地话术库 bigram 高频统计 + LLM 特征提炼合成）
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
//     - 场景指令：按记忆卡 stage 注入对应关系阶段的指导（吸引/舒适/恋爱，v182 三阶段统一）
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

// [v6 L3→v182 三阶段统一] 关系阶段 → 场景指导映射（迷男三大阶段：吸引/舒适/恋爱）
//   [v182 用户拍板] 六关系阶段废弃，统一为三阶段；"诱惑"对外一律显示为"恋爱"
//   [v188 社交地位心法] 每阶段追加社交地位主线：吸引=压对方地位到你之下；舒适=让她靠努力表现把地位往上提；恋爱=地位平等
const STAGE_HINTS: Record<string, string> = {
  '吸引': '线上吸引期：核心是展示面与聊天节奏，不是高频聊天。每天 1-2 个高质量话题优于刷屏；可以有态度、带点轻度调侃制造张力，别急着表白、别无意义盘问（年龄/照片/住哪这类信息交换允许自然提问），更别一味顺着对方。社交地位心法：把她的社交地位压在你之下——你定调、她追随；可以轻度调侃、慢半拍回应、不急于捧她，让她感觉到你在上位；压制要轻、要带笑，落在"她可爱有趣"的钩子上，绝不贬低。',
  '舒适': '线上舒适期：建立信任与情感连接——先回应再分享，多聊生活与共同点，制造"咱们是一类人"的感觉；聊天自然升温，多用"咱们/我们都"，对方分享经历时先接住再连接自己的相似故事；不必再端着，但别急着推进关系。社交地位心法：给她向上的台阶——她主动分享、关心、努力表现时，明确接住并给予具体认可（"你懂我""这点真不错"），让她靠努力表现赢得地位上升；认可要具体、不廉价，形成"她表现→你认可"的正向循环。',
  '恋爱': '线上恋爱期：关系已确立，用文字张力保鲜——回复温暖有生活感、关注细节，但别过度客气生分；可以斗嘴、可以小调侃、可以抛见面邀约与调情，测试一点服从性；守住边界但不温吞，敢于把暧昧兑现成见面。社交地位心法：你俩地位平等——互相调情、互相给予、互相接招，谁都不跪谁都不端；可以自然表露在乎，也可以坦然要求她回馈，把暧昧兑现成见面。',
};

// [v182 三阶段统一] 存量记忆卡/LLM 输出可能仍是旧六阶段（陌生/朋友/追求/暧昧/恋爱/挽回）
//   → 统一换算成三阶段：陌生/朋友→吸引，追求/挽回→舒适，暧昧→恋爱
function normalizeStage(s: string): string {
  if (s === '吸引' || s === '舒适' || s === '恋爱') return s;
  if (s === '陌生' || s === '朋友') return '吸引';
  if (s === '追求' || s === '挽回') return '舒适';
  if (s === '暧昧') return '恋爱';
  return '吸引';
}

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
//   语义拆解按"当前关系阶段"加权：profile.stage 推断；无 → 全词表
const STAGE_VOCAB: Record<string, string[]> = {
  'meet': ['开场白', '搭讪', '惯例', '聊天', '邀约', '约会', '见面', '幽默', '游戏', '互动'],
  'attract': ['推拉', '框架', '冷读', '冷读术', '废物测试', '打压', '欲擒故纵', '调戏',
    '高价值', '服从性测试', '进挪', '角色扮演', '需求感', '查户口', '暧昧', '模糊邀约',
    '建立吸引', '升级关系', '主导权', '展示面'],
  'comfort': ['安慰', '哄', '解释', '试探', '约会', '见面', '暧昧', '关心', '共鸣',
    '故事', '互动', '赞美', '幽默'],
  'seduction': ['进挪', '兴趣指标', '升级关系', '暧昧', '撩', '角色扮演', '调戏'],
};

// [v11→v182] 根据记忆卡解析当前 M3 战术阶段词表（三阶段：吸引→attract、舒适→comfort、恋爱→seduce）
function resolveStageVocab(memoryCard: MemoryCard | null): string[] {
  const stage = memoryCard?.profile?.stage || '';
  let phase: keyof typeof STAGE_VOCAB = 'attract';
  if (stage === '恋爱') phase = 'seduction';
  else if (stage === '舒适') phase = 'comfort';
  return STAGE_VOCAB[phase] || [];
}

// [v6 L0] 知识库参考条数与原文截断长度
// [v59 降本] KB 参考块 5→3（主回复 system 未命中部分 ≈15%↓，检索质量影响小）
// [2026-08-06 降本] 话术块普遍 650+ 字（p50=651），核心话术在前 400 字（后段为提示/来源/铺垫）：
//   KB_CONTENT_MAX 500→400 且真正启用截断（此前常量未被使用，3 条 ≈2000 字全量注入）
// [v79 语义切块] 知识库已重切为 4551 小块（话术 30-100 字/套路整块）
// [v79.4 简化] 主回复统一纯弹药 5 块话术
// [2026-08-11] 套路机制整体移除：只检索话术(弹药)块，套路块不再检索
const KB_REF_COUNT = 3;                       // 兜底默认（旧逻辑兼容）
const KB_AMMO_COUNT = 5;                      // 主回复统一弹药块数
const KB_CONTENT_MAX = 2000;                  // 完整注入兜底（实际不触发截断）
const HISTORY_ITEM_MAX = 800;   // 单条历史上限
const SUMMARY_ITEM_MAX = 60;    // 更早消息摘要单条上限（v59 80→60 降本）
const RECENT_FULL = 5;          // 近详远略：最近 N 条全文（v70 10→8；v199 8→5：逻辑记忆 v195 已承担远期脉络，压缩省输入成本，与 LOGIC_SUMMARY_INPUT_N 对齐）
const MEMORY_UPDATE_INTERVAL = 5 * 60 * 1000; // 画像提取频率：5 分钟（v70 3→5 降频）

// [v195 逻辑记忆] 每轮用最近 N 条消息生成一句话逻辑脉络（≤80 字）落卡，
//   下一轮注入动态区作"既定事实基准"，防模型前后矛盾/忘约定（胡言乱语）。
//   环境变量 LOGIC_SUMMARY_ENABLED=0 可快速关停，默认开启。
const LOGIC_SUMMARY_ENABLED = Deno.env.get('LOGIC_SUMMARY_ENABLED') !== '0';
const LOGIC_SUMMARY_INPUT_N = 5;     // 输入：最近 5 条消息（含她+我，不足取全部）
const LOGIC_SUMMARY_MAX = 80;        // 输出：一句话 ≤80 字

// [v185 错字彩蛋] 秒回拟人：上一条消息距现在 <60s 且掷骰子 1/5 命中 →
//   注入"写错一个字"指令（代码层概率，不依赖 LLM 执行概率）。
//   环境变量 USE_TYPO_HINT=0 可快速关停，默认开启。
const USE_TYPO_HINT = Deno.env.get('USE_TYPO_HINT') !== '0';
const TYPO_PROBABILITY = 0.2;   // 1/5
const TYPO_WINDOW_MS = 60 * 1000; // <1 分钟

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

    // [v186] 本轮唯一 ID（usage 落库聚合口径：一轮 = 一个 request_id）
    currentRequestId = crypto.randomUUID();

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
      else if (reason === 'account_frozen') message = '账号已被冻结，请联系管理员';
      else if (reason === 'device_frozen') message = '设备已被封禁，请联系管理员';
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
    // [v20260812 思考预算三档] 后台开关（默认 auto）：
    //   on=始终压缩；off=永不压缩；auto=高峰时段(工作日9-12/14-18,价格翻倍)压缩,其余不压缩
    const rawThinkingBudget = llmParams.thinking_budget || 'auto';
    const budgetPeak = rawThinkingBudget === 'auto' && isDeepSeekPeak();
    const effectiveThinkingBudget = rawThinkingBudget === 'on' || budgetPeak;

    // [v6 L2] 读取记忆卡（跨窗口共享的对方画像，按会话）
    let memoryCard = await readMemoryCard(supabaseUrl, token, supabaseAnonKey, session_id);

    const rawQuery = typeof query === 'string' ? query.trim() : '';
    // [v62 切换话题] "/换话题" = 用户一键换话题：不延续旧话题，主动抛新话题开场
    const switchTopic = rawQuery === '/换话题' || rawQuery.startsWith('/换话题 ');

    // [v20260812 首条过滤·仅评价] 用户投喂的女生资料（首条 user 消息）仍需给 LLM 用于展开聊天，
    //   因此主回复/检索/记忆/统计全部走原始 history；只在"关系判断"处（extractProfile 阶段/画像）剔除首条。

    // [v6 L2] 上下文工程：近详远略压缩
    //   recent  = 最近 10 条全文（单条 ≤800 字），作为 messages 发给 LLM
    //   summary = 更早的对话只保留"对方说的话"（≤120 字/条），注入 system
    const { recent: llmHistory, summary: olderSummary } = buildContextParts(history);

    // [v76] 会话间隔注入：查本会话最后一条 AI 回复时间 → "距上次聊天多久"
    //   解决"隔几天当刚聊过"的时间线幻觉；首轮/查询失败/间隔 <1min → 不注入（降级无害）
    let lastGapText = '';
    if (serviceRoleKey && supabaseUrl && session_id) {
      try {
        const lastResp = await fetch(
          `${supabaseUrl}/rest/v1/chat_messages?session_id=eq.${encodeURIComponent(session_id)}&select=created_at&role=eq.assistant&order=created_at.desc&limit=1`,
          { headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey } }
        );
        if (lastResp.ok) {
          const rows = await lastResp.json();
          if (Array.isArray(rows) && rows[0] && rows[0].created_at) {
            lastGapText = formatGapSince(new Date(rows[0].created_at));
          }
        }
      } catch (e: any) {
        console.warn('会话间隔查询失败:', e.message);
      }
    }

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
    // [v73] 战术类别/阶段（同上：_debug 块外引用，必须顶层声明）
    let tactic: { category: TacticCategory; phase: 'attract' | 'comfort' | 'seduce'; cardIndex: number } = { category: 'attack', phase: 'attract', cardIndex: -1 };
    // [v11] 节奏建议（buildSystemContent 产出 → updateMemoryCard 回写；同样提到顶层防作用域事故）
    let pulseAdvice: { delay?: boolean; short?: boolean } | null = null;
    // [v57] 长期记忆本轮注入条数（_debug 用；同样提到顶层防作用域事故）
    let factsInjected = 0;
    // [v76] 输出后时间校验命中词（_debug 用；null=未触发）
    let lastTimeConflict: string | null = null;
  // [v20260812 逻辑重复检测] 本轮防重复判定结果（_debug 用；提到顶层防作用域事故）
  let dupHit = false;
  // [v199] 本轮重试触发原因（_debug 用；''=未触发重试）
  let retryReason = '';
    // [v77] 本轮实际使用的六阶段采样参数（_debug 用；按 memoryCard.profile.stage 取档）
    let usedStageLlm = DEFAULT_STAGE_LLM;
    // [v183 锚点降频] 锚点注入模式（_debug 用；提到顶层防作用域事故，块内赋值）
    let anchorMode: 'full' | 'light' | 'none' = 'none';
    // [v195 逻辑记忆] 本轮生成的逻辑脉络（_debug 用；updateMemoryCard 前赋值，随卡落库）
    let logicSummary: string | null = null;

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
        // [v79 语义切块] 主回复统一纯弹药检索（v79.4）：5 块话术弹药
        //   [2026-08-11] 套路机制已移除，不再有独立启动通道，仅话术弹药
        // [v148 弹药阶段加权] 战术判定提前到检索前（纯规则零 LLM）：
        //   phase 参与 recallBlocks 排序（同阶段文档加权、异阶段降权），
        //   保证"嗯"在吸引期拿到冷读/打压类弹药、舒适期拿到联系感/共鸣类弹药
        tactic = resolveTacticCategory(switchTopic ? '' : query, history, memoryCard);

        const searchQueries = [...semanticKws, ...kw, searchQuery];
        kbItems = await recallBlocks(supabaseUrl, serviceRoleKey, semanticKws, searchQueries, { ...quotaOpts, pickCount: KB_AMMO_COUNT, type: '话术', phase: tactic.phase });
        mark('kb1');
        // 4. 第二轮：弹药不足 2 条时用"仅历史"关键词补搜
        if (kbItems.length < 2) {
          const kw2 = extractKeywordsFromHistory(history, '', true).filter((k) => !kw.includes(k)).slice(0, 3);
          if (kw2.length > 0) {
            const items2 = await recallBlocks(supabaseUrl, serviceRoleKey, semanticKws, kw2, { ...quotaOpts, pickCount: KB_AMMO_COUNT, type: '话术', phase: tactic.phase });
            const merged = mergeDedup([...kbItems, ...items2]).slice(0, KB_AMMO_COUNT);
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
        // [v129 删除选句通道] 选句"整句复制知识库原句"与聊天场景格格不入（选句判定天然不契合语境）→ 移除。
        //   保味改由主回复 prompt 承担：【措辞底线】动态注入（riskHit 时）+ 参考资料引导语保留直白度
        // [v129] 高危词预检：本轮参考弹药含强敏感词 → 高风险消毒轮（注入保味指令 + 生成后消毒检测）
        lastRiskHit = kbItems.some((it: any) => RISK_WORDS.some((w) => String((it && it.content) || '').includes(w)));
        lastSanitizeHit = false;
        if (!reply) {
        // [v148] 战术判定已提前到检索前（549 行，phase 供弹药加权），此处直接复用
        // 组装 system：[P0-3] 固定块前移（缓存友好）+ 去冗余（llmHistory≥4 不注入近期话/自己话）
        // [v183 锚点降频] 事件驱动三态（方案 A+B，替代"每轮注入+鼓励每轮用"）：
        //   full = 本轮她的话含锚点词 → 完整锚点块（抓住做文章，最高优先级发挥点）
        //   light = 最近 4 轮没提过且轮次为 4 的倍数 → 轻量提醒（防 LLM 忘掉连续剧线，但不再强制每轮塞）
        //   none = 最近提过（history 可见，无需打扰）/无锚点/轮次未到 → 不注入（省 token + 消除"每轮硬塞"行为）
        anchorMode = 'none';
        const anchorKw = (memoryCard?.profile?.anchor || '').trim();
        if (anchorKw) {
          const userTexts = (Array.isArray(history) ? history : [])
            .filter((h: any) => h && h.role === 'user' && typeof h.content === 'string')
            .map((h: any) => String(h.content || ''));
          const hitThis = !switchTopic && String(query || '').includes(anchorKw);
          const hitRecent = userTexts.slice(-4).some((t) => t.includes(anchorKw));
          if (hitThis) anchorMode = 'full';
          else if (!hitRecent && userTexts.length % 4 === 0) anchorMode = 'light';
        }
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
          // [v73] 战术指令（全局原则+阶段卡+命中类别卡组）
          tactic,
          // [v76] 距上次聊天间隔（变化区注入，不动前缀缓存）
          lastGapText,
          // [v81 回退 v78] 思考档（v78 曾注入【思考预算】，已删除；档位由 llmChat 控制）
          // [v20260812 思考预算开关] thinkingBudget=on 时恢复注入（默认 off 不注入，保持自然思考）
          thinking: effectiveThinkingMode,
          thinkingBudget: effectiveThinkingBudget,
          // [v129] 高危词预检结果 → 命中则注入【措辞底线】保味指令
          riskHit: lastRiskHit,
          // [v183] 锚点三态（调用处已预判）
          anchorMode,
        });
        const systemContent = built.systemContent;
        let innerContent = built.dynamicContent;
        pulseAdvice = built.pulseAdvice;
        factsInjected = built.factsInjected;
        // [v185 错字彩蛋] 秒回拟人：上一条消息距现在 <60s 且掷骰子 1/5 命中 → 动态注入"写错一个字"指令
        //   代码层概率（真 20%），LLM 不掷骰子只执行；指令只在本轮出现 → 不扩散到后续轮次
        lastTypoHit = false;
        if (USE_TYPO_HINT && llmKey) {
          try {
            const histAll = (Array.isArray(history) ? history : []).filter((h: any) => h && h.created_at);
            const lastTs = histAll.length ? Date.parse(String(histAll[histAll.length - 1].created_at)) : NaN;
            if (!isNaN(lastTs) && Date.now() - lastTs < TYPO_WINDOW_MS && Math.random() < TYPO_PROBABILITY) {
              innerContent += '\n\n【错字彩蛋】对方秒回，这条回复里故意写错一个字（常见输入法错字，如"在→再、的→地、怎么→咋么"），错一个就够，仅本轮生效，下一轮恢复正常。';
              lastTypoHit = true;
            }
          } catch (e: any) {
            console.warn('错字彩蛋判定失败:', e.message);
          }
        }
        // [v20260813 缓存重构] system 只含字节级稳定块；动态块全部注入最后一条 user 消息的
        //   【军师内参】区（位于 history 之后 → 尾部变化不再破坏 system+history 前缀缓存）
        const INNER_INTRO = '【军师内参】（以下是系统注入的内部信息，不是对方发来的消息：仅供执行参考，不得引用、复述或回复这些内容）\n';
        const messages: any[] = [
          { role: 'system', content: systemContent },
          ...llmHistory,
          // [v62 切换话题] 换话题时 user 尾部用引导语（不把 "/换话题" 指令本身发给 LLM 当用户话）
          // [v20260809 归属加固] 当前这条待回复的话 = 对方说的，显式标注【对方说】
          { role: 'user', content: INNER_INTRO + innerContent + '\n\n' + (switchTopic ? '（用户按了"换话题"，请按内参里的【切换话题】指令直接给一句新话题开场白）' : '【对方说】' + query.trim()) },
        ];
        // [v77] 六阶段三参数联动：按记忆卡阶段取采样档（temperature/presence/frequency）
        usedStageLlm = resolveStageLlmParams(memoryCard?.profile?.stage);
        // [v185 错字彩蛋·档位] 命中错字轮 → 本次生成降级 off 档：
        //   秒回短句无需深度思考（省 token/延时，与"秒回"设定自洽）；
        //   更关键：thinking 档下 LLM 会自我纠正、不肯写错字（实测 high 档把"错字"敷衍成口语词"咋"）
        const replyThinking: ThinkingMode = lastTypoHit ? 'off' : effectiveThinkingMode;
        reply = await llmChat(llmKey, llmBase, llmModel, messages, {
          temperature: usedStageLlm.temperature,
          maxTokens: MAIN_MAX_TOKENS,
          frequencyPenalty: usedStageLlm.frequency_penalty,
          presencePenalty: usedStageLlm.presence_penalty,
          thinking: replyThinking,
          _stage: 'main_reply',
        });
        // [v9] 防重复兜底：与"自己发过的话"高相似 → 带提示重生成一次
        // [v70 降本] 只与最近 5 条比较（全量 ≤20 条命中率高，误触发=多花一整轮重发成本）
        // [v20260812 逻辑重复检测] dupHit 保留字面层：
        //   ①字面 bigram ≥0.85 → 直接判重（零额外 LLM）
        //   [v196 简化] ②LLM 复核层（judgeLogicDup）+ ③框架语义组（frameSuspicious）已砍：
        //     逻辑记忆(v195) + 决策流程④ 已承担"换皮重复同一套框架"的拦截，LLM 复核冗余且费成本
        // [v76] 时间一致性兜底：回复出现与【当前时间】冲突的时段词（早安/晚安/这么晚等）→ 同上重生成
        //   （多触发源合并成一次重试，避免同一轮双重重生成）
        const selfMsgs = Array.isArray(memoryCard?.recent_self_messages) ? memoryCard.recent_self_messages.slice(-5) : [];
        dupHit = !!(reply && selfMsgs.length > 0 && isNearDuplicate(reply, selfMsgs));
        const timeHit = timeConflict(reply);
        lastTimeConflict = timeHit;
        // [v129 消毒检测] 参考句含强敏感词、回复里这些词全部消失 → 判定消毒 →
        //   并入现有 v9/v76 重生成通道（复用重试机制，不新增调用），重生成时 notes 注入保味指令
        const sanitizedWords = detectSanitize(reply, kbItems);
        lastSanitizeHit = sanitizedWords !== null;
        if ((dupHit || timeHit || sanitizedWords) && llmKey) {
          const notes: string[] = [];
          if (dupHit) notes.push(`你刚才生成的那句话与【你之前发过的话】重复了。严禁重复：要么延续你上轮立过的框架（赌注/约定/梗）往下推进，要么换一个完全不同的角度，不得换着词再说一遍同样的意思或同样的套路。`);
          if (timeHit) notes.push(`你刚才生成的那句话里的时刻（${timeHit}）与【当前时间】不符（现在是${formatCurrentTime()}）。以【当前时间】为准重写，不得再出现与现在时段矛盾的词。`);
          if (sanitizedWords) notes.push(`你刚才的回复把参考话术里的直白措辞（${sanitizedWords.join('/')}）全软化了，这是消毒不是加分。保留直白度：只许改人称、加语气词、调句序、换种说法，禁止同义软化或删掉擦边意象。`);
          // [v199 重试原因落库] _stage 按触发原因标记（可多因合并），llm_usage_log 直接 group by 统计
          const retryReasons: string[] = [];
          if (dupHit) retryReasons.push('dup');
          if (timeHit) retryReasons.push('time');
          if (sanitizedWords) retryReasons.push('sanitize');
          if (retryReasons.length > 0) retryReason = retryReasons.join('+');
          const retry = await llmChat(llmKey, llmBase, llmModel, [
            // [v20260813 缓存重构] system + 【军师内参】与主回复完全一致（复用同一 built →
            //   system+history 前缀缓存整段命中）；重试指令 notes 追加在 user 消息尾部
            { role: 'system', content: systemContent },
            ...llmHistory,
            { role: 'user', content: INNER_INTRO + innerContent + '\n\n【对方说】' + query.trim() + '\n\n注意：' + notes.join('') + ' 直接输出新的话术本体，不要解释。' },
          ], {
            temperature: usedStageLlm.temperature,
            maxTokens: MAIN_MAX_TOKENS,
            frequencyPenalty: usedStageLlm.frequency_penalty,
            presencePenalty: usedStageLlm.presence_penalty,
            // [v185] 重试沿用主回复档位（错字轮=off）
            thinking: replyThinking,
            // [v199] 重试原因落库（retry_dup / retry_time / retry_sanitize / retry_dup+time ...）
            _stage: ('retry_' + (retryReasons.join('+') || 'unknown')) as any,
          });
          if (retry) reply = retry;
        }
        } // [v129] if (!reply) 主回复生成块结束
      } catch (e: any) {
        console.error('LLM error:', e.message);
      }
    }
    mark('llm_reply');

    // [v117b 标签泄露兜底] LLM 偶发把上下文里的【我发的】/【对方说】前缀复制进回复（模仿历史消息格式），
    // 统一剥掉：只删行首归属标签，保留话术本体；主回复与重试分支都已写入 reply，此处一次覆盖
    if (reply) reply = stripRoleTags(reply);

    // ---- [v126→v127 掉线直连] LLM 不可用/失败：不再本地拼装糊弄，直接掉线提示 ----
    //   背景：用户反馈"一直以为降级是 LLM 安全机制触发"，实际是 LLM 调用失败/超时/未配置
    //   后走了本地拼装（assembleKbReply / 通用建议模板）——那不是军师水平，且误导用户。
    //   决定：LLM 没产出 → reply='掉线了'，前端统一提示"军师掉线了，稍后再试"，不落库不渲染。
    if (!reply) {
      reply = '掉线了';
    }

    // [v195 逻辑记忆] 每轮用最近 5 条消息生成一句话逻辑脉络（下一轮注入用）：
    //   放主回复之后（失败/掉线不影响主回复返回，保留上轮值降级无害）；随 updateMemoryCard 覆盖落库
    if (LOGIC_SUMMARY_ENABLED && llmKey) {
      try {
        logicSummary = await buildLogicSummary(llmKey, llmBase, llmModel, history, memoryCard?.logic_summary?.text || null);
      } catch (e: any) {
        console.warn('逻辑记忆生成失败:', e.message);
      }
    }

    // [v6 L2] 记忆卡更新（await 保证落库；画像提取有 3 分钟频率控制，多数请求只做毫秒级规则追加）
    //   [v20260812 仅评价过滤] 记忆/统计走原始 history（资料正常记录，供主回复基于资料展开聊天）；
    //   只有 extractProfile（关系阶段/画像判定）在函数内部剔除首条资料
    if (session_id) {
      try {
        await updateMemoryCard({
          supabaseUrl, token, anonKey: supabaseAnonKey, sessionId: session_id,
          history, llmKey, llmBase, llmModel, existingCard: memoryCard,
          pulseAdvice,
          // [v126] 本轮回复立即入库（防重复窗口即时生效，重生/隔轮不再漏检）
          // [v127] 掉线信号不入库：避免"掉线了"污染 recent_self_messages 防重复窗口
          currentReply: (reply && reply !== '掉线了') ? reply : null,
          // [v195 逻辑记忆] 本轮生成的逻辑脉络（覆盖写入 logic_summary；null=保留旧值）
          logicSummary,
        });
      } catch (e: any) {
        console.error('记忆卡更新失败:', e.message);
      }
    }
    mark('memory');

    // [v129 消毒观测] 每轮记录高危词预检 + 消毒检测结果，跑几天用 grep "[sanitize]" 统计消毒率
    // [v185] 顺带记录 typo_hit，grep "[sanitize]" 可同时看错字命中率
    console.info(`[sanitize] risk_hit=${lastRiskHit} sanitize_hit=${lastSanitizeHit} typo_hit=${lastTypoHit} reply_from=${reply === '掉线了' ? 'offline' : 'llm'}`);

    // [v186] 先构造响应体，落库成功后再返回（usage 写库失败不影响主回复）
    const payload = {
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
        // [v127] 掉线标记：true=LLM 未产出（失败/超时/未配置），reply 为"掉线了"
        offline: reply === '掉线了',
        system_prompt_len: (effectivePrompt || '').length,
        history_len: Array.isArray(history) ? history.length : 0,
        llm_history_len: llmHistory.length,
        kb_hits: hitKnowledge,
        kb_items: kbItems.length,
        // [v129] 消毒观测（替换已删除的选句通道字段）：本轮参考弹药是否含敏感词 + 生成后是否检出消毒
        risk_hit: lastRiskHit,
        sanitize_hit: lastSanitizeHit,
        // [v185 错字彩蛋] 本轮是否命中秒回错字（验证 20% 命中率）
        typo_hit: lastTypoHit,
        // [v20260812 逻辑重复检测] 验证：dup_hit=是否字面判重（v196 起仅字面层）
        dup_hit: dupHit,
        // [v199] 重试触发原因（''=本轮无重试；dup/time/sanitize 可叠加）
        retry_reason: retryReason,
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
        // [v13] 阶段耗时（ms）：start/ready/semantic/sentence/kb1/kbft/llm_reply/memory
        perf: (() => {
          const o: Record<string, number> = {};
          for (let i = 1; i < perfMark.length; i++) o[perfMark[i][0]] = perfMark[i][1] - perfMark[i - 1][1];
          return o;
        })(),
        thinking_mode: effectiveThinkingMode,
        // [v20260812 思考预算三档] 验证：raw=后台档位(off/on/auto) active=实际是否压缩 peak=auto 档高峰命中
        thinking_budget: rawThinkingBudget,
        budget_active: effectiveThinkingBudget,
        budget_peak: budgetPeak,
        // [v183] 锚点注入模式（验证三态：full=她提梗/light=每4轮提醒/none=不注入）
        anchor_mode: anchorMode,
        memory_stage: memoryCard?.profile?.stage || null,
        // [v195 逻辑记忆] 本轮生成的逻辑脉络（验证生成/注入；null=未生成或关闭）
        logic_summary: logicSummary || memoryCard?.logic_summary?.text || null,
        // [v58] 关系目标（验证目标引导注入）
        goal: memoryCard?.goal || null,
        // [v20260809] 机会窗口命中验证（null=未命中；命中显示话题名，排查"她问军师没反问"用）
        open_window: switchTopic ? null : detectOpenWindow(query),
        // [v62] 切换话题模式（验证【切换话题】注入）
        switch_topic: switchTopic,
        // [v76] 会话间隔注入文本（验证时间流逝感知；''=未注入）
        last_gap: lastGapText,
        // [v76] 输出后时间校验命中词（验证时间一致性；null=未触发）
        time_conflict: lastTimeConflict,
        // [v77] 六阶段采样参数档（验证阶段联动；stage 在 memory_stage 字段）
        stage_temp: usedStageLlm.temperature,
        stage_presence: usedStageLlm.presence_penalty,
        stage_freq: usedStageLlm.frequency_penalty,
        self_msgs_len: Array.isArray(memoryCard?.recent_self_messages) ? memoryCard.recent_self_messages.length : 0,
        // [v14] 攻击检测是否命中（验证反击指令注入；三阶段下无挽回豁免）
        attack_detected: ATTACK_RE.test(query),
        // [v73 迷男精髓] 战术类别与阶段（验证卡组注入）
        tactic_category: tactic.category,
        tactic_phase: tactic.phase,
        // [v15] 时间/位置注入验证
        now_cn: formatCurrentTime(),
        location: extractLocation(userBio || '') || null,
        // [v11] 引擎层 debug：验证阶段加权与节奏/主权/情绪引擎是否生效
        stage_vocab: resolveStageVocab(memoryCard).slice(0, 5),
        balance_direction: memoryCard?.balance?.direction || null,
        emotion_baseline: memoryCard?.emotion_tone?.baseline || null,
        pulse_delay_count: memoryCard?.pulse?.delay_count ?? null,
        folder_hs: !!kbFolders?.hs,
        folder_jx: !!kbFolders?.jx,
        // [vB] LLM token 用量（token 测量用）
        llm_usage: llmUsageLog.map((u) => ({ stage: u.stage, ...u.usage })),
        // [v72] 思考链原文（thinking 档才有；完整保留，调试/教学用）
        llm_reasoning: llmReasoning || null,
      },
    };
    // [v186] 批量落库 LLM usage（写库失败只记日志，不影响已构造的响应）
    await persistLlUsage();
    return new Response(JSON.stringify(payload), { headers, status: 200 });

  } catch (error: any) {
    console.error('Error:', error.message);
    return new Response(JSON.stringify({ error: '服务器错误' }), { headers, status: 500 });
  }
});

// ============================================================
// [v6 L2] 近详远略：上下文压缩
//   最近 RECENT_FULL 条全文（单条截断 HISTORY_ITEM_MAX）；
//   更早的只保留对方消息（≤SUMMARY_ITEM_MAX/条，最多 6 条）拼成摘要
// [v20260809 归属加固] recent 每条 content 加说话人前缀：
//   【对方说】= role user（对方）；【我发的】= role assistant（用户本人/军师发出的）
//   ——显式标注说话人，杜绝 LLM 按 API 原生 role 语义（user=人类/AI）误判归属
// ============================================================
function buildContextParts(history: any[]): { recent: any[]; summary: string } {
  const valid = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
  const recent = valid.slice(-RECENT_FULL).map((h) => ({
    role: h.role,
    content: (h.role === 'user' ? '【对方说】' : '【我发的】') + truncateText(h.content, HISTORY_ITEM_MAX),
  }));
  const older = valid.slice(0, Math.max(0, valid.length - RECENT_FULL));
  const olderUsers = older.filter((h) => h.role === 'user').map((h) => truncateText(h.content, SUMMARY_ITEM_MAX));
  const summary = olderUsers.length > 0
    ? '【更早对话要点（对方说过的话，供把握前因后果）】\n' + olderUsers.slice(-6).join('\n')
    : '';
  return { recent, summary };
}

// ============================================================
// [v195 逻辑记忆] 每轮用最近 LOGIC_SUMMARY_INPUT_N 条消息生成一句话逻辑脉络
//   目的：把"正在聊什么/立过的约定/她表明的态度/我方立场"固化成既定事实，
//         注入下一轮动态区 → 模型不前后矛盾、不忘记约定（防胡言乱语）。
//   输入：最近 5 条消息（含她+我，带归属前缀；不足 5 条取全部）；
//         少于 2 条（纯首条投喂）→ 返回 null 跳过
//   输出：一句话 ≤LOGIC_SUMMARY_MAX 字；失败/掉线 → null（调用方保留上轮值，降级无害）
//   成本：输入 ~500 token + 输出 ~100 token ≈ 0.001 元/轮（未命中价）
// ============================================================
async function buildLogicSummary(
  llmKey: string, llmBase: string, llmModel: string,
  history: any[], prevSummary?: string | null
): Promise<string | null> {
  if (!llmKey) return null;
  const valid = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string');
  if (valid.length < 2) return null; // 无对话可总结（首条投喂/单条）
  const recentText = valid.slice(-LOGIC_SUMMARY_INPUT_N)
    .map((h) => (h.role === 'user' ? '【她】' : '【我】') + truncateText(String(h.content), HISTORY_ITEM_MAX))
    .join('\n');
  const prompt = `你是聊天逻辑记忆助手。把最近这段对话压缩成一句话逻辑脉络（≤${LOGIC_SUMMARY_MAX}字），供下一轮回复时保持前后一致。\n`
    + `必须覆盖：①正在聊什么；②立过的约定/赌注/承诺（原文引用关键短语）；③她表明的态度或立场；④我方刚说过的话要点。\n`
    + `铁律：只输出那一句话本身，不要引号、不要"总结："前缀、不要解释、不要分点。\n`
    + (prevSummary ? `上一轮脉络（作延续参考，本轮在其基础上更新）：${truncateText(prevSummary, 120)}\n` : '')
    + `最近对话：\n${recentText}`;
  try {
    const content = await llmChat(llmKey, llmBase, llmModel, [{ role: 'user', content: prompt }], {
      temperature: 0.3, maxTokens: 150, _stage: 'logic_summary',
    });
    const t = (content || '').trim().replace(/^["'「]+|["'」]+$/g, '').replace(/\s+/g, ' ').slice(0, LOGIC_SUMMARY_MAX);
    if (!t) return null;
    return t;
  } catch (e: any) {
    console.warn('buildLogicSummary failed:', e.message);
    return null;
  }
}

// ============================================================
// [v9] 与"自己发过的话"的字面相似度检测（防重复兜底）
//   bigram 命中比例 ≥0.85 或一字不差 → 判定重复，触发重生成
//   [v20260812 逻辑重复检测] 拆出 bigramScore 供"疑似区间"复核用
// ============================================================
function bigramScore(text: string, prev: string): number {
  const gram = (str: string, n: number): string[] => {
    const s = str.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const out: string[] = [];
    for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
    return out;
  };
  const tg = gram(text, 2);
  if (tg.length === 0) return 0;
  const tset = new Set(tg);
  const pg = gram(prev, 2);
  if (pg.length === 0) return 0;
  let hit = 0;
  for (const g of pg) if (tset.has(g)) hit++;
  return Math.max(hit / Math.max(pg.length, 1), hit / tset.size);
}

function isNearDuplicate(text: string, prev: string[]): boolean {
  const t = text.trim();
  if (!t) return false;
  for (const p of prev) {
    if (!p || !p.trim()) continue;
    if (p.trim() === t) return true;
    if (bigramScore(t, p) >= 0.85) return true;
  }
  return false;
}

// ============================================================
// [v76] 输出后时间一致性校验（方案6）
//   只判"描述当下状态"的硬词（早安/晚安/这么晚/这么早/大中午等）：
//   邀约/未来计划类（晚上见/明天/改天/周末）不判——那是合理约时间，不是幻觉。
//   命中 → 返回命中词标签（供重生成提示）；未命中 → null
//   小时取 Asia/Shanghai（与 formatCurrentTime 同源），hourCycle h23 防 0 点报 "24"
// ============================================================
const TIME_STATE_WORDS: Array<{ re: RegExp; hours: number[]; label: string }> = [
  { re: /早安|早上好|早晨好/, hours: [5, 6, 7, 8, 9, 10, 11], label: '早安' },
  { re: /晚安|睡吧|该睡了|要睡了/, hours: [20, 21, 22, 23, 0, 1, 2, 3], label: '晚安' },
  { re: /这么晚|这么晚了|还没睡|这么晚还/, hours: [21, 22, 23, 0, 1, 2, 3, 4], label: '这么晚' },
  { re: /这么早|这么早就|起这么早/, hours: [4, 5, 6, 7, 8, 9, 10], label: '这么早' },
  { re: /大中午|中午了|该吃午饭/, hours: [11, 12, 13, 14], label: '中午' },
  { re: /大清早|一大早/, hours: [5, 6, 7, 8], label: '大清早' },
];

function shHour(): number {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date());
    return parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  } catch {
    return new Date().getHours();
  }
}

function timeConflict(text: string): string | null {
  if (!text || !text.trim()) return null;
  const h = shHour();
  for (const w of TIME_STATE_WORDS) {
    if (w.re.test(text) && !w.hours.includes(h)) return w.label;
  }
  return null;
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
    // [v75 缓存③] prompt 固定部分（角色/词表/示例/要求）前移 → 前缀稳定可缓存命中；
    //   query/最近对话 挪尾部（动态内容不影响前缀）
    // [v20260811 降本] 词表 78 词全量 → 当前档子集（stageVocab 未命中时兜底 40 词）：
    //   语义拆词只是"拆短词"，LLM 并不需要看完整词表；few-shot 2 组 → 1 组
    const vocabList = (stageVocab && stageVocab.length > 0 ? stageVocab : TOPIC_VOCAB.slice(0, 40));
    const prompt = '你是恋爱话术检索助手，把"对方说的话"拆成检索恋爱话术库的短关键词。\n'
      + `知识库词表（优先选词，可少量自创）：${vocabList.join('、')}\n`
      + '示例：\n'
      + '输入："她说今天被领导骂了很难受"\n输出：["委屈","安慰","哄","难过","关心"]\n'
      + `要求：只输出 JSON 数组，${SEMANTIC_KW_MIN}-${SEMANTIC_KW_MAX} 个词，每个 2-${KW_LEN_MAX} 字，词表优先、可加 1-2 个贴近原话的字面词，无解释。\n`
      + `对方的话：「${truncateText(query, 80)}」\n`
      + (recentUserMsgs.length > 0 ? `最近对话（对方说的）：\n${recentUserMsgs.slice(-2).join('\n')}\n` : '');
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
//     recent_user_messages:[...], updated_at }
//   [2026-08-11] strategy 套路字段已随套路机制移除
// ============================================================

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
  // [v58] 关系目标（用户在前端设置）：'保持当前关系' / ''(未设置=默认推进)
  //   目标引导 = 战略层：决定军师每轮往哪使劲（M3 路线图）
  goal?: string;
  // [v195 逻辑记忆] 最近 N 条消息的逻辑脉络（一句话 ≤80 字，覆盖式单条）：
  //   每轮 LLM 生成 → 下一轮注入动态区作既定事实基准（防前后矛盾/忘约定）
  logic_summary?: { text: string; round: number; at: string };
  // [v11] 迷男OS 引擎层：节奏 / 情绪基线（毫秒级规则统计，随记忆卡落库）
  pulse?: PulseState;
  balance?: BalanceState;
  emotion_tone?: EmotionTone;
  updated_at?: string;
};

// [v57] facts 容量与注入上限
const FACTS_MAX = 20;          // 长期记忆上限（超了淘汰最久没提的）
const FACTS_INJECT_MAX = 3;    // 每轮按相关度最多注入几条（v79.2 4→3 收紧）


// [v190 资料型投喂识别] 用户把女生背景资料（第三人称描述："她叫XX，25岁，住XX…"）
//   粘贴给军师 → 非女生原话，画像提取时与真实对话区分标注；但资料仍进记忆卡（画像提取可见）
//   特征：以"她叫/她今年/她住/她喜欢…"等第三人称描述开头，且不是简短反问
function isProfileFeed(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 6) return false;
  return /(^|[，。；\n])(她叫|她今年|她现在|她住|她家在|她名字|她是.{0,6}(岁|人|的)|她喜欢|她爱|她生日|她星座|她属|她爸妈|她家|她工作|她在).{0,10}(岁|住|区|市|县|村|镇|家|名字|名|工作|公司|学校|大学|喜欢|爱|生日|星座|属)/.test(t)
    || /(^|[，。；\n])(女生|女孩|妹子)(叫|今年|现在|住|是|在|喜欢|爱)/.test(t);
}



// [v20260809 机会窗口] 对方主动问起相关话题 = 她亲手递来的窗口（纯规则，零 LLM）
//   命中 → buildSystemContent 注入【机会窗口】块：回答后必须单次镜像反问
//   她先开口后的镜像反问 = 社交互惠，不是查户口（查户口 = 连环盘问不回应）
//   数组顺序 = 匹配优先级（先命中者胜）
const OPEN_WINDOW_PATTERNS: Array<[string, RegExp]> = [
  ['年龄', /你多大|你几岁|你多大了|你几岁了|你今年多大|你哪年|你是哪年|你是哪一年|你哪一年|哪一年生|你属[什么啥]/],
  ['喜好', /你喜欢什么|你最爱|你平时(喜欢|爱)|你有什么(爱好|兴趣)|你最爱(看|吃|听|玩)/],
  ['住哪', /你住哪|你住在|你在哪个(区|城市|片区)|你是哪里人|你哪的|你家在哪|你家是哪/],
  ['家庭', /你家几口|你是独生|你爸妈|你爸你妈|你家里/],
  ['照片', /发(张|个)照片|你长什么样|看看你|你照片(发|给)|自拍/],
  ['感情经历', /你谈过|你前任|你以前(对象|女朋友)|你感情(史|经历)|你交往过/],
  ['压力', /你最近(在)?(烦|愁|压力)|你有什么压力|你怕什么|你最难/],
];

// [v20260809] 检测"她主动问话题库话题"：命中返回话题 short 名（如'年龄'），否则 null
//   仅对对方原话（query）检测；switchTopic 时主流程传 ''，天然跳过
function detectOpenWindow(query: string): string | null {
  const q = String(query || '').trim();
  if (!q) return null;
  for (const [name, re] of OPEN_WINDOW_PATTERNS) {
    if (re.test(q)) return name;
  }
  return null;
}

// [v147 机会窗口扩展] 她主动"袒露自我"（分享日常/自述特质/分享经历/表达喜好/关心你/分享心情）
//   = 舒适期窗口：她信任你、想拉近距离，主动递了"了解我"的钥匙
//   与话题窗口（她问你）互补：她问你 → 镜像反问等价交换；她自述 → 先接住再升级
//   命中 → buildSystemContent 注入【接住分享】块：①先接情绪（认可/共鸣）②再深挖一句 ③可轻升级，禁止交易式接话
//   数组顺序 = 匹配优先级（自述特质 > 日常习惯 > 分享经历 > 表达喜好 > 关心对方 > 分享心情）
const SELF_DISCLOSURE_PATTERNS: Array<[string, RegExp]> = [
  ['自述特质', /我(比较|挺|很|有点|其实|就是|这个人|属于|性格|自认|觉得|特别|真.{0,2}|更|也).{0,14}(专一|内向|外向|慢热|宅|懒|随性|固执|认真|简单|直接|念旧|爱笑|爱哭|怕|喜欢|讨厌|接受不了|受不了|不习惯|不愿意)/],
  ['日常习惯', /(?:我)?(每天|经常|习惯|平时|一般|总是|每周|最近|睡前|早起).{1,16}(喝|吃|睡|看|玩|做|去|爱|买|听|逛|聊|追|刷|运动|跑步|健身|做饭)/],
  ['分享经历', /我(最近|上周|昨天|前天|以前|小时候|之前|上个月|那天|今天).{1,18}(去了|遇到|干了|做|发现|买了|看了|吃了|玩了|见了|试了|学了|参加|错过|丢|摔|哭|笑)/],
  ['表达喜好', /我最喜欢|我最爱|我超爱|我好喜欢|我特别喜欢|我的最爱|我只爱|我就爱|超喜欢|特别喜欢|最爱(吃|喝|看|听|玩|逛)/],
  ['关心对方', /你(要|记得|别|一定|最近|今天|明天|该|多|早点|少).{0,12}(注意|照顾好|早点休息|休息|吃饭|忙|累|睡|热|冷|熬夜|饿|感冒|吃药)/],
  ['分享心情', /我(今天|最近|现在|这两天|有点|好|挺|特别|真的|莫名).{1,12}(开心|烦|累|难过|兴奋|纠结|焦虑|无聊|郁闷|委屈|生气|emo|破防|上头|心累)/],
];

// [v147] 检测"她主动袒露自我"：命中返回类型名（如'自述特质'），否则 null
function detectSelfDisclosure(query: string): string | null {
  const q = String(query || '').trim();
  if (!q) return null;
  for (const [name, re] of SELF_DISCLOSURE_PATTERNS) {
    if (re.test(q)) return name;
  }
  return null;
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
    if (parsed && typeof parsed === 'object') {
      // [2026-08-11] 存量清洗：旧套路字段 strategy、旧里程碑字段 milestones 已废弃，读入即剥离，写回时自然消失
      // [2026-08-13] 攻略 guide 已砍，存量卡读入即剥离
      // [2026-08-15 话题清单已砍] topics_done/interest/current_topic_id/topic_health_history/
      //   topic_sovereignty/last_transition_type/bridge_hook_planted 一并剥离（写回自然消失）
      // [v182 三阶段统一] 存量 stage 六阶段 → 换算三阶段
      delete parsed.strategy;
      delete parsed.milestones;
      delete parsed.guide;
      delete parsed.topics_done;
      delete parsed.interest;
      delete parsed.current_topic_id;
      delete parsed.topic_health_history;
      delete parsed.topic_sovereignty;
      delete parsed.last_transition_type;
      delete parsed.bridge_hook_planted;
      if (parsed.profile && typeof parsed.profile.stage === 'string') {
        parsed.profile.stage = normalizeStage(parsed.profile.stage);
      }
      return parsed;
    }
    return null;
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
  // [v126] 本轮刚生成的回复：主请求 history 不含本轮 reply，旧逻辑滞后一轮才入库，
  //   导致它在"重生请求"和下一轮防重复判定时不在 recent_self_messages 防重复窗口内
  //   → 重生时仍可能生成同一句。生成后立即写入。
  currentReply?: string | null;
  // [v195 逻辑记忆] 本轮生成的逻辑脉络（非空 → 覆盖写入 logic_summary；null=保留旧值）
  logicSummary?: string | null;
}): Promise<void> {
  const card: MemoryCard = ctx.existingCard || { profile: {}, recent_user_messages: [] };
  // [v20260812 仅评价过滤] 本会话尚无任何"女生原话"历史 → 本轮 query 是首条（用户投喂资料）
  //   → 画像提取等"关系进展评价"跳过；其余记忆/统计不受影响
  const firstRound = !(Array.isArray(ctx.history) && ctx.history.some((h) => h && h.role === 'user'));

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
  // [v126] 优先用本轮刚生成的 reply：history 里"最后一条 assistant"是上一轮的回复，
  //   本轮 reply 若不入库则滞后一轮，防重复（重生/隔轮）会漏掉它
  const lastSelf = [...(Array.isArray(ctx.history) ? ctx.history : [])]
    .reverse().find((h) => h && h.role === 'assistant' && typeof h.content === 'string');
  const selfMsgs = Array.isArray(card.recent_self_messages) ? card.recent_self_messages.slice() : [];
  const toAdd = (ctx.currentReply && ctx.currentReply.trim())
    ? ctx.currentReply
    : (lastSelf && lastSelf.content) || '';
  if (toAdd && (selfMsgs.length === 0 || selfMsgs[selfMsgs.length - 1] !== toAdd)) {
    selfMsgs.push(truncateText(toAdd, 200));
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
  //   [v20260812 降本] 首轮（firstRound，用户投喂资料/无对话）跳过画像提取：
  //   extractProfile 输入为空纯输出默认值（stage=陌生），白烧 ~700 token/新好友；
  //   次轮起（有真实对话）才提取，由限频兜底
  let needProfile = true;
  if (card.updated_at) {
    const last = new Date(card.updated_at).getTime();
    needProfile = !isNaN(last) && (Date.now() - last) > MEMORY_UPDATE_INTERVAL;
  }
  if (needProfile && ctx.llmKey && !firstRound) {
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
      // [v83] 年龄/地区保护：LLM 本轮没识别出时不清空已有值（防反复丢失）
      if (!profile.age && prev.age) {
        profile.age = prev.age;
      }
      if (!profile.region && prev.region) {
        profile.region = prev.region;
      }
      card.profile = profile;
      // [v57] 长期事实合并（去重 + 上限淘汰）
      mergeFacts(card, extracted.facts || []);
    }
    card.updated_at = new Date().toISOString();
  }

  // [v195 逻辑记忆] 本轮生成成功 → 覆盖写入（单条，记录轮次/时间）；失败/未生成 → 保留旧值
  if (ctx.logicSummary) {
    const prevRound = (card.logic_summary && card.logic_summary.round) || 0;
    card.logic_summary = { text: ctx.logicSummary, round: prevRound + 1, at: new Date().toISOString() };
  }

  await writeMemoryCard(ctx.supabaseUrl, ctx.token, ctx.anonKey, ctx.sessionId, card);
}

// [v6 L2] LLM 提取/合并对方画像（输出标准化 JSON）
// [v57] 返回 {profile, facts}：profile=画像对象；facts=本轮新提取的长期事实（string[]）
async function extractProfile(llmKey: string, llmBase: string, llmModel: string, card: MemoryCard, history: any[]): Promise<{ profile: any; facts: string[] } | null> {
  const cur = JSON.stringify(card.profile || {});
  // [v20260812 仅评价过滤] 首条 user 消息多为用户投喂的女生资料（"她叫XX，25岁…"）
  // [v190 修正] 首条资料【保留】喂画像提取（age/region/personality 需从资料读到 →
  //   用户要求"资料记入记忆卡"）；但 prompt 明确资料行不算已聊话题、不推进阶段
  const userMsgs = (Array.isArray(history) ? history : [])
    // [v20260809 归属加固] 只取对方（role=user）的话喂画像提取：
    //   把军师/用户自己发的（assistant）也喂进去 → LLM 偶尔把"自己说的话"当对方画像
    .filter((h) => h && h.role === 'user' && typeof h.content === 'string');
  const recentDialogue = userMsgs
    .slice(-6)
    .map((h) => {
      const text = String(h.content || '');
      // [v190] 资料行标注：第三人称背景资料（供提取静态画像），与真实对话区分
      return (isProfileFeed(text) ? '[背景资料] ' : '[对话] ') + `对方：${truncateText(text, 200)}`;
    })
    .join('\n');
  const prompt = `你是恋爱顾问的档案整理助手。根据最近的对话，维护"对方"的画像档案。\n当前档案：${cur}\n最近内容：\n${recentDialogue || '（无）'}\n说明：[背景资料] 行是你的用户粘贴的对方背景资料（非对方原话），可用于提取静态画像字段（age/region/personality 等），但**不算真实对话，不得据此判定"聊过某个话题"、不得作为关系阶段推进依据**；[对话] 行才是对方本人说的话。\n要求：输出合并更新后的 JSON，字段：stage（关系阶段，只能是"吸引/舒适/恋爱"）、personality（性格描述，≤50字）、relationship_note（关系背景，≤80字）、recent_events（最近重要事件，≤100字）、anchor（你俩对话中的长期话题锚点：反复出现或充满笑点的具体意象，如宠物/店/地名/共同物件/口头禅，≤20字；无则空字符串）、age（对方年龄，如"25岁"或"25"；对方没明确说过则空字符串，保留已有值不清空）、region（对方提到的地点/地址信息——城市或小地方都算，不限大小：如"北京""上海浦东""平南""XX县""XX村"；对方说"我是XX人/我住XX/我在XX/我家在XX"这类话都算，只要不是开玩笑；同时提到多个地点时选最小最具体的那个（如"广西"和"平南"同时出现→"平南"）；对方完全没提及则空字符串，保留已有值不清空）。\n`
    + `[v60→v182 阶段推进] 你是主动推进方：她给密集兴趣信号（主动追问/发照片/秒回/调侃/话变长/约你），或你试探邀约后她积极接住（应约/回撩/延长话题/发照片/接梗）→ stage 按"吸引→舒适→恋爱"升一级（最多一级，不越级）；她连续冷淡/回避/转移/争吵 → 降级到"吸引"；拿不准保持现状。只输出 JSON 对象，不要任何其他文字。`;
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
    return {
      profile: {
        stage: typeof p.stage === 'string' && p.stage ? normalizeStage(p.stage) : '吸引',
        personality: typeof p.personality === 'string' ? p.personality.slice(0, 50) : '',
        relationship_note: typeof p.relationship_note === 'string' ? p.relationship_note.slice(0, 80) : '',
        recent_events: typeof p.recent_events === 'string' ? p.recent_events.slice(0, 100) : '',
        // [v56] 话题锚点：跨轮次连续剧感的共同梗（无则空，不覆盖已有锚点由合并逻辑处理）
        anchor: typeof p.anchor === 'string' ? p.anchor.slice(0, 20) : '',
        // [v83] 年龄/地区：话题"年龄""住哪"聊出结果时提取的具体值，供好友列表展示
        age: typeof p.age === 'string' ? p.age.trim().slice(0, 10) : '',
        region: typeof p.region === 'string' ? p.region.trim().slice(0, 20) : '',
      },
      facts,
    };
  } catch (e: any) {
    console.warn('extractProfile failed:', e.message);
    return null;
  }
}

// [v20260813 攻略已砍] advanceGuide / updateGuideProgress / evalGuideSignals / extractGuide 已整体删除
//   （攻略状态机 + LLM 制定攻略 + LLM 低频评估全部移除，省 ~900 token/次 的攻略生成与定期评估调用）
// [2026-08-15 话题清单已砍] TOPIC_LIBRARY/rankTopicList/assessTopicHealth/兴趣引擎/打钩/主权/门槛
//   已整体删除（用户拍板）；话题推进改由战术卡组 + 知识库弹药 + 机会窗口承担

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
// [v6 L2/L3] system 提示词组装
// 顺序：全局提示词 > 场景指令 > 用户简介 > 记忆卡 > 更早摘要 > 知识库参考 > 格式约束
// ============================================================

// [v14] 对方攻击/挑衅/阴阳怪气检测（命中 → 注入反击指令）
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

// [v76] 距上次聊天的人类可读间隔（≤24h 精确到小时，>24h 到天）
//   间隔 <1min（连续对话中）或时间无效 → 返回 ''（不注入，避免噪音）
function formatGapSince(last: Date): string {
  const ms = Date.now() - last.getTime();
  if (isNaN(ms) || ms < 60000) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m > 0 ? `${hours}小时${m}分钟前` : `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}天${h}小时前` : `${days}天前`;
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

// ============================================================
// [v73 迷男精髓战术卡组] 底层战术方案（替代旧"语气态度/兴趣信号/攻击检测"三块）
//   来源：桌面《迷男精髓.md》23 卡，按四类结构化：
//   防守8 / 进攻6 / 救场4 / 状态5（阶段卡+全局原则）
//   注入策略（方案A 按类注入）：每轮 = 全局原则 + 当前阶段卡 + 命中类别卡组
//   全量约3000字 → 每轮只注入一类 ≈600-800字，token 可控
// ============================================================
type TacticCategory = 'defense' | 'attack' | 'rescue';

interface TacticCard {
  scene: string;     // 场景名
  attitude: string;  // 态度
  method: string;    // 手法
  examples: string[]; // 话术范例
  trigger?: RegExp | null; // [v20260811] 触发词（防守/救场细分卡用；null/缺省=该卡无独立触发）
}

const TACTIC_CARDS: Record<TacticCategory, TacticCard[]> = {
  defense: [
    { scene: '对方低兴趣（敷衍"嗯/哦/哈哈"）', attitude: '撤退 + 惩罚', method: '切断话题，贴"无趣"标签后主动离场', examples: ['看来你不擅长聊天，我先去忙了，下次翻你牌子。', '你这回复速度让我以为在跟AI客服聊天，回见。'], trigger: /^(嗯|哦|呵呵|哈{2,}|随便|不知道|没意思|无聊|敷衍|不想聊)$/ },
    { scene: '对方打压/挑衅（"你好自恋""你经常这样撩妹吧"）', attitude: '放松 + 傲娇', method: '认同并夸张化（Agree & Amplify），让她拳头打棉花', examples: ['这都被你发现了，我自恋到每天被镜子帅醒，你要不要也来膜拜一下？', '对啊，我刚从海王培训班毕业，你是第一个实验对象，惊不惊喜？'], trigger: /自恋|撩妹|这么会撩|你经验很丰富|经常这样|PUA/ },
    { scene: '对方废物测试（无理要求/刁难问题）', attitude: '不接招 + 幽默', method: '曲解她的动机，把质问变成"你在对我感兴趣"', examples: ['你问这么细，是想查户口还是想给我介绍对象？先说好，我要求很高。', '你这句话的逻辑，让我怀疑你是来碰瓷的。'], trigger: /你帮我|你证明|你凭什么|凭什么听|给我发|必须听/ },
    { scene: '对方ASD抗拒亲密（"我才不去你家""我不是随便的人"）', attitude: '完全同意 + 甩锅', method: '后退一步，把"想多了"的帽子扣回给她', examples: ['想啥呢？我家猫会后空翻我都没让你看，你别自作多情啊。', '我知道你不是随便的人，正好我也不是。既然你有防备心，那咱们还是去人多的地方吧。'], trigger: /我才不去|我不是随便|别想|想得美|谁要跟你|你该不会|拉黑/ },
    { scene: '对方服从度低（叫发照片/语音等小事不干）', attitude: '轻蔑 + 无所谓', method: '取消指令，给她贴"胆小/没意思"标签', examples: ['看来你对自己不自信，没事，保护弱者自尊是我的美德。', '发个语音都不敢？行吧，我理解，毕竟不是人人都对自己的声音有信心。'], trigger: /不敢|怕了|才不要|不想发|凭什么听|你管我/ },
    { scene: '对方突然消失后回来（隔天/更久才回）', attitude: '冷淡 + 惩罚', method: '延迟回复（2-4小时），回应极度简短，让她感知失温', examples: ['（隔2-3小时）阅。', '（隔2小时发一张打哈欠的猫表情包）'], trigger: null },
    { scene: '对方搬出"前男友/其他追求者"', attitude: '无视 + 拉回框架', method: '不贬低对手，把焦点转回她对你的态度', examples: ['哦。有人追你说明你确实不错，不过我现在比较好奇，你理想型的男生是什么样的？', '那你觉得我跟他谁更烦人？……哈哈不开玩笑，说真的，你喜欢的男生一般什么特质？'], trigger: /前男友|追求者|别人追|有个男生|他在追|前任/ },
    { scene: '对方说你"油嘴滑舌/海王"', attitude: '认可 + 反调侃', method: '认下标签，反过来指控她"你经验也很丰富嘛"', examples: ['被你识破了，我刚从海王培训班毕业，你是第一个实验对象。你呢？这么懂，怕不是培训班导师？', '我这叫幽默感，不过你警惕性这么高，该不会是被我戳中了吧？'], trigger: /海王|油嘴|渣男|套路深|油嘴滑舌|对多少女生|对每个女生/ },
  ],
  attack: [
    { scene: '主动推进话题', attitude: '自信 + 控场', method: '植入"假性时间限制"，让她放松警惕', examples: ['我朋友在那边催了，不过还有5分钟，我想听听你对刚才那件事的看法……', '待会儿要开个线上会，趁现在有空，我想问你一个特别奇葩的问题……'] },
    { scene: '主动升高关系', attitude: '推拉 + 暧昧', method: '先认可她的某个特质，再调侃她另一个点', examples: ['你性格真的很好，可惜长了张嘴。', '再聊下去我可能要对你这人上瘾了，不过你放心，我自制力很强。', '你知道吗，你刚才那一瞬间，差点让我心动了。不过也就那一瞬间。'] },
    { scene: '主动制造推拉', attitude: '情绪过山车', method: '一句话同时包含"认可"和"调侃"', examples: ['你刚才那句话水平很高，我差点要欣赏你了……可惜后面那句暴露智商了。', '看你气质，要是再矮5厘米，简直就是我理想型了。', '你笑起来挺好看的，以后还是少说话吧，保持形象。'] },
    { scene: '主动筛选她（让她证明自己）', attitude: '设门槛 + 考验', method: '她表现出兴趣后，让她"表现"才能获得你的认可', examples: ['你说你品味好，那我考考你……（抛个选餐厅/选电影的问题），答对了有奖励。', '在遇到你这么有趣的灵魂之前，我差点以为这软件上都是机器人。来，说说你这辈子干过最酷的一件事是啥？'] },
    { scene: '主动植入"我们"概念', attitude: '同盟感', method: '把话题从"你和我"变成"咱们"，建立共鸣', examples: ['看来咱俩都属于那种表面正经、内心叛逆的类型。', '咱俩有一点特别像，就是……（某个共同特质）'] },
    { scene: '主动种心锚（模糊邀约）', attitude: '随意 + 不认真', method: '用"如果……的话……"句式，植入见面可能性但不约具体时间', examples: ['如果你真像你说的那么能吃辣，下次我路过那家川菜馆，倒是可以勉为其难叫你出来验证一下。', '算了，文字聊天聊不出你的精髓，万一你是个骗子呢？我还是留点悬念，等以后见面亲自拆穿你吧。'] },
  ],
  rescue: [
    { scene: '阶段推进受阻（卡住/冷场）', attitude: '强势切话题', method: '不接她上句话，直接开启高能量无厘头新话题', examples: ['算了刚才那个聊得我脑壳疼。突然想问个严肃的……奥特曼打怪兽的时候，怪兽有医保吗？', '停，这个聊不下去了。换个频道：如果你明天突然变富婆了，你第一件事干嘛？'] },
    { scene: '自己说错话（暴露需求感）', attitude: '补救 + 重新定义', method: '追加一条消息，把真话包装成"开玩笑"或"测试"', examples: ['我靠，刚那句话是旁边哥们抢我手机发的……好吧我发的，但我说的是想你的猫。', '撤回？不可能撤回的。但如果你当真了，那我只能承认我是个温柔的人设崩了。'] },
    { scene: '邀约被拒绝', attitude: '无所谓 + 退一步', method: '完全接受，表明"我根本没当真"，退回舒适区', examples: ['哈哈我就随口一说，看把你紧张的。行，那改天再说，我刚说到哪了？', '拒绝得这么干脆，还好我心大，不然该哭了。行吧，下次有机会再说。'] },
    { scene: '气氛太严肃/走心过头', attitude: '破解 + 轻松化', method: '用玩笑或自嘲打破沉重氛围', examples: ['完了完了，聊得这么深入，再聊下去我怕你要爱上我了。赶紧换个话题，说说你最近有什么糗事。', '不行，太正经了，这不是我的风格。我得说个烂笑话打破一下气氛。'] },
  ],
};

// 阶段卡（场景19-21：按对方发言回合数判定）
const TACTIC_PHASE_CARDS: Record<'attract' | 'comfort' | 'seduce', string> = {
  attract: '吸引期（本轮判定：关系刚起步/对方投入少或降温）：只做DHV（展示价值）和筛选，不暴露任何兴趣；禁无意义盘问（年龄/照片/住哪这类信息交换允许自然提问），禁用未来邀约；多用"我"少用"你"，陈述句为主、冷读为主。范例："看你头像，我有90%把握你是个表面安静、内心极其有主见的人。"',
  comfort: '舒适期（本轮判定：已有熟悉感/她愿意分享）：建立信任和情感纽带，制造"我们是一类人"的感觉；她分享经历后立刻连接你的相似故事；多用"咱们"、"看来我们都……"。范例："你也有过那种时候？我也是！我记得有一次……"',
  seduce: '恋爱期（本轮判定：关系已确立或聊得够热）：制造见面理由、测试服从性；开始植入模糊邀约、种心锚；遇ASD立刻退回舒适期，绝不纠缠。范例："下次有机会带你见识一下什么叫真正的……"',
};

// 防守类触发词（v73 强/弱分级防误伤）：
//   强信号 = 明确对抗/测试/ASD/竞争者词 → 命中即防守
//   弱信号 = 敷衍词 → 仅当整条消息极短（≤4 字）才判防守（"一个人去多没意思"含"没意思"但不是敷衍）
const DEFENSE_STRONG_RE = /(自恋|撩妹|海王|油嘴|渣|套路深|经常这样|对多少女生|对每个女生|这么会撩|你帮我|你证明|你凭什么|凭什么听|给我发|必须听|我才不去|我不是随便|别想|想得美|谁要跟你|你该不会|前男友|追求者|别人追|有个男生|他在追|你经验很丰富|呵呵哒|无语|服了|就这|有病|滚|闭嘴|拉黑|嫌你|配不上|看不上|幼稚|装什么|装|PUA)/;
const DEFENSE_WEAK_RE = /^(嗯|哦|呵呵|哈{2,}|随便|不知道|没意思|无聊|敷衍|不想聊)$/;
// 救场类触发词：self 暴露需求感（最近自己发过的话）+ 对方明确拒绝邀约
const SELF_NEED_RE = /(想你|喜欢你|很想你|舍不得|爱你|好想|离不开|一定要见|求你了)/;
const INVITE_REJECT_RE = /(不去|算了|没空|改天|再说吧|别约|不想见|拒绝|呵呵不了)/;

// [v73→v182 三阶段统一] 战术类别与阶段判定（每轮一次，纯规则零 LLM）
//   [v182] 战术阶段 = 关系阶段直接映射（吸引→attract、舒适→comfort、恋爱→seduce），
//   不再用回合数/温度计推导——阶段由 extractProfile 自动升级或用户长按手动指定；
//   旧 resolveTacticPhase（回合数+温度计推导）已整体删除
function resolveTacticCategory(query: string, history: any[], memoryCard: MemoryCard | null): { category: TacticCategory; phase: 'attract' | 'comfort' | 'seduce'; cardIndex: number } {
  const stage = memoryCard?.profile?.stage || '吸引';
  const phase = stage === '舒适' ? 'comfort' : stage === '恋爱' ? 'seduce' : 'attract';
  let category: TacticCategory = 'attack';
  const q = (query || '').trim();
  const lastSelf = (Array.isArray(history) ? history : []).filter((h) => h.role === 'assistant').slice(-1).map((h) => String(h.content || '')).join('');
  if (DEFENSE_STRONG_RE.test(q) || (q.length <= 4 && DEFENSE_WEAK_RE.test(q))) category = 'defense';
  else if (SELF_NEED_RE.test(lastSelf) || INVITE_REJECT_RE.test(q)) category = 'rescue';
  // [v20260811 降本] 命中具体卡 → 只注入该卡（防守/救场按触发词细分；-1=未细分，全组精简注入）
  let cardIndex = -1;
  if (category === 'defense') {
    for (let i = 0; i < TACTIC_CARDS.defense.length; i++) {
      const tr = (TACTIC_CARDS.defense[i] as any).trigger;
      if (tr && tr.test(q)) { cardIndex = i; break; }
    }
    if (cardIndex === -1 && q.length <= 4 && DEFENSE_WEAK_RE.test(q)) cardIndex = 0; // 敷衍 → 低兴趣卡
  } else if (category === 'rescue') {
    if (INVITE_REJECT_RE.test(q)) cardIndex = 2; // 邀约被拒
    else if (SELF_NEED_RE.test(lastSelf)) cardIndex = 1; // 暴露需求感
  }
  return { category, phase, cardIndex };
}

// [v148 弹药按阶段加权] 文档级阶段映射：kb_blocks.title = 源文件名（52 个类别文档），
//   天然蕴含 M3 阶段语义（搭讪/冷读/打压/框架=吸引；联系感/共谋/共鸣/情感链接=舒适；
//   进挪/调情/邀约/约会=诱惑；异议/废物测试=防守；其余=通用）。
//   目的：同一句"嗯"，吸引期应接冷读/打压类弹药，舒适期应接联系感/共鸣类弹药——
//   而不是检索出 5 块阶段混杂的话术让 LLM 自己猜。
//   匹配顺序 = 优先级（seduce 优先，防"搭讪与邀约"这类跨组文档被 attract 提前截走）
const TITLE_STAGE_RULES: Array<[string[], 'attract' | 'comfort' | 'seduce' | 'general' | 'defense']> = [
  [['进挪', '关系升高', '恋爱调情', '隐性诱惑', '约会', '合约恋人', '打情骂俏', '游戏与陷阱', '表达兴趣', '搭讪与邀约'], 'seduce'],
  [['搭讪', '冷读', '打压', '高价值', '框架', '勾起好奇', '初聊', '开场白', '颜色星座', '趣味搭讪'], 'attract'],
  [['联系感', '共谋', '共鸣', '价值型', '情感链接', '情感波动', '聊天话题', '聊天对白', '聊天交流', '聊天模板', '话块连情'], 'comfort'],
  [['异议', '化解IOD', '废物测试'], 'defense'],
];

// [v148] 文档 title → M3 阶段（未命中 = general，三阶段通用：幽默/语录/表情/趣味问答等）
function titleStage(title: string): 'attract' | 'comfort' | 'seduce' | 'general' | 'defense' {
  const t = title || '';
  for (const [kws, stage] of TITLE_STAGE_RULES) {
    if (kws.some((k) => t.includes(k))) return stage;
  }
  return 'general';
}

// [v75 缓存白捡①] 战术固定前导：使用说明+全局原则（每轮完全一致 → 进固定前缀可缓存命中）
// [v79.2] 卡组不再自带范例 → 措辞改为"按手法生成"，范例由参考弹药提供
// [v129 保味] 战术指令措辞从"禁止照抄原文"改为"保留直白度、禁止软化"（整句照抄仍禁：v83 触发平台过滤空回复）
const GLOBAL_TACTIC_PREAMBLE = `\n\n【战术指令】(本轮最高优先，先判断后回复)\n`
  + `执行顺序：①判断她这条消息属于防守/进攻/救场哪一类 ②匹配对应场景 ③按该场景的"态度+手法"临场输出一句话话术（措辞保留【参考资料】金句的直白度和意象，可换说法贴合语境，禁止软化成文明腔；整句照抄会被平台拦）。\n`
  + `全局原则（全程生效）：\n`
  + `- 回复字数统一 ≥5 且 ≤18 字（[v20260815 用户定稿] 至少 5 字防纯语气词敷衍、最多 18 字封顶；通常 1-2 句短句，能拆两句就不合一句；超 18 字=失败必须压缩）。\n`
  + `- 她回复越短越敷衍，你延迟越久（模拟高价值）；陈述句 > 提问句，用冷读代替查户口；永远不让她觉得你在"等"她消息。\n`
  + `- 安全边界：不骂脏话、不人格侮辱、不贬低外貌/价值；对方情绪低落或真正受伤 → 收起锋芒先共情，此场景禁用调侃与反击。`;

// [v75] 战术变化部分（每轮按类别/阶段变化 → 放后缀不破坏前缀缓存）：阶段卡 + 命中类别卡组
// [v79.2 瘦身] 卡组只输出"场景→态度→手法"规则；examples 范例已由知识库参考弹药承担
//   （切块后弹药精准，无需卡组自带范例，每轮省 ~200-400 字）
// [v20260811 降本] 只注入命中的那张卡（cardIndex≥0，防守/救场细分触发词）；
//   攻击类常态无触发词（cardIndex=-1）→ 精简注入全组（合并场景+手法一行，去态度列）
function buildTacticBlock(category: TacticCategory, phase: 'attract' | 'comfort' | 'seduce', cardIndex = -1): string {
  const cards = TACTIC_CARDS[category];
  let cardText: string;
  if (cardIndex >= 0 && cards[cardIndex]) {
    const c = cards[cardIndex];
    cardText = `场景：${c.scene}\n态度：${c.attitude}｜手法：${c.method}`;
  } else {
    // 攻击/未细分：每卡一行（场景→手法），省态度列与换行
    cardText = cards.map((c) => `- ${c.scene} → ${c.method}`).join('\n');
  }
  return `\n\n【当前阶段】${TACTIC_PHASE_CARDS[phase]}\n\n`
    + `【${category === 'defense' ? '防守' : category === 'attack' ? '进攻' : '救场'}类战术卡】（本轮命中，严格按卡执行）\n${cardText}`;
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
  // [v62 切换话题] 用户一键换话题：不延续旧话题，主动抛一个新话题开场
  switchTopic?: boolean;
  // [v73 迷男精髓] 本轮战术：类别（防守/进攻/救场）+ 阶段（吸引/舒适/诱惑）+ 命中卡索引，主流程 resolveTacticCategory 产出
  tactic?: { category: 'defense' | 'attack' | 'rescue'; phase: 'attract' | 'comfort' | 'seduce'; cardIndex?: number };
  // [v76] 距上次聊天的人类可读间隔（如"2天3小时前"），空=不注入；放后缀变化区
  lastGapText?: string;
  // [v78→v81 回退] 本轮思考档（off/low/high/max）：v78 曾用于注入【思考预算】压缩思考链，
  //   已删除（用户实测变笨）；档位机制本身由 llmChat 的 thinking 参数控制，此处保留签名兼容
  thinking?: ThinkingMode;
  // [v20260812 思考预算开关] 后台开关：on 且思考档时注入【思考预算】压缩思考链（省成本）
  thinkingBudget?: boolean;
  // [v129] 本轮参考弹药是否含敏感词（高危词预检结果）→ 命中则注入【措辞底线】保味指令
  riskHit?: boolean;
  // [v183 锚点降频] 锚点注入模式（调用处预判，事件驱动）：
  //   full=本轮她的话含锚点词→完整块；light=每4轮轻量提醒；none=不注入
  anchorMode?: 'full' | 'light' | 'none';
}): { systemContent: string; dynamicContent: string; pulseAdvice: { delay?: boolean; short?: boolean } | null; factsInjected: number } {
  // [v20260813 缓存重构] 结构：systemContent=字节级稳定块（进 system 前缀，整段命中缓存）；
  //   dynamicContent=每轮/低频变化块（由组装处注入最后一条 user 消息【军师内参】区，
  //   在 history 之后 → 动态变化不再截断 system+history 的前缀缓存）
  // [P0-3] 旧方案（v75/v80）已把固定块前移、变化块后移，但变化块仍在 system 尾部、
  //   位于 history 之前 → 时间块每小时变一次，其后 history 前缀整段失效（38% 命中率元凶）。
  // [v9] 角色定位硬编码"本人"（最高优先级，覆盖后台提示词的顾问视角）
  // [v73] 删除旧"有脾气/敢调情"硬编码（已被战术卡组+全局原则覆盖），后台提示词可大幅精简
  // [v20260813→v179 回移] systemPrompt（后台提示词）v178 曾移入动态区，v179 按用户决定移回
  //   固定区（用户简介前）：后台提示词基本定稿不常改 → 放固定区优先级更高；改一次全站缓存
  //   失效可接受（低频操作）
  let s = '【角色定位】(最高优先级)\n'
    + '你正在扮演「用户本人」用交友app跟对方聊天，你就是那个说话的人，不是顾问、不是助手。\n'
    + '你的人设原型是《迷男方法》作者迷男（Mystery）——一个自带神秘感的玩家，像魔术师一样把聊天变成有悬念的游戏：\n'
    + '- 神秘感：永远留一手、永远有反转。先抛钩子再揭晓（"我有个故事，改天讲""你猜""这个秘密只告诉你"），吊起她的好奇，话不一次性说满。\n'
    + '- 框架控制：你是奖品，她才是需要努力取悦你的那个。从不乞求、从不长篇解释、从不急着推进；该直给时也敢直给，不端着。\n'
    + '- 情绪稳定：任何测试/打压/试探都激怒不了你；你越稳，她好奇心越重。\n'
    + '- 语言质感：冷读开篇（"你看起来…但其实…"）、故事化叙述、自嘲式幽默、含蓄暧昧点到即止，让她自己脑补。\n'
    + '- 筛选者：像面试官一样考验她，她的每次主动都值得一句"这你倒是有点意思"。\n'
    + '你之前发出的每句话都是既定事实，后续回复必须与之衔接一致：不重复、不推翻、不自相矛盾。\n';

  // [v20260809 归属加固] 显式声明对话记录的角色归属（历史每条已带【对方说】/【我发的】前缀；
  //   此处重申规则，杜绝"把自己说过的话当成对方说的"错位）
  // [v117b 标签泄露] 补充输出约束：LLM 偶发把【我发的】/【对方说】前缀复制进回复（模仿历史消息格式），严禁
  // [v20260811 降本] 精简：五条并三条，去重复表述
  s += `\n\n【对话记录角色说明】(最高优先级，防归属错位)\n`
    + `- 对话记录里【对方说】=她的话；【我发的】=你自己（用户本人）之前发出的。分析她的意图只看【对方说】，回顾自己说过的话只看【我发的】，严禁把两者混淆。\n`
    + `- 当前待回复的最后一句话是对方（她）说的。\n`
    + `- 输出是发给她的消息本体：直接写话术内容，严禁在输出中携带或仿写【对方说】【我发的】等任何标注前缀。`;

  // [v56 意图优先] 先解读潜台词再回复：解决"盯字面回字面"（她哈哈→你回"笑得好"这种废话）
  // [v73 精简] 三问保留，正反例/信号段删除（敷衍/借口信号已由防守类战术卡覆盖）
  s += `\n\n【先解读再回复】(最高优先，解读过程不输出)\n`
    + `动手前先想三件事：①她这句话的真实意图（试探/调情/拒绝/分享情绪/考验/寒暄）；②她为什么这么说（多是我上一句的某个点触发的）；③她期待我什么反应（接住/推进/化解/换话题）。\n`
    + `铁律：绝不盯字面回字面。她发"哈哈"不是要你夸她笑得好，而是你上一句戳中了她——找到"她为什么笑"，基于原因强化那个点或顺势推进，禁止回应笑本身。`;

  // [v15] 当前时间：已从固定前缀区移出（[v20260811 缓存] 每小时变一次，放固定区会打断其后所有块的前缀缓存，
  //   38% 命中率元凶）→ 挪到变化区尾部注入（见文末 buildCurrentTimeBlock）

  // [v73] 【语气与态度】已删除：被战术卡组（防守/进攻类）+ 全局原则（含安全边界）覆盖

  // [v9] 自洽 + 输出要求：先正面回应再转折，严禁自相矛盾/重复；放宽为 1-2 句
  // [v73] 硬字数上限：整条 ≤20 字（用户定稿），通常 1 句（已并入战术前导全局原则）
  // [P0-3] 固定块前移（前缀稳定）
  // [2026-08-06 降本] 范例 3→1
  // [v79.2 去重] 删"第一句必须正面回答"（与防守/救场战术卡冲突：防守要求不接招/离场）；
  //   删"≤20字"硬字数（战术前导 GLOBAL_TACTIC_PREAMBLE 已含完整字数规则）
  // [v20260811 降本] 精简：删重复表述（保味原则与措辞底线/参考资料引导重复）
  // [v20260813 降本] 去重："不重复/自洽"已由【角色定位】首段声明，此处不再复述；
  //   字数上限以战术前导 GLOBAL_TACTIC_PREAMBLE 为唯一权威（≤20字）
  s += `\n\n【自洽与输出要求】（严格遵守）\n`
    + `- 【延续自洽】先回看你之前发过的话：立过的赌注/约定/梗/邀约/承诺必须延续推进（如"零食赌注"→记账、加码、催兑现），不得另起一个同款新框架；同一套话术框架（打赌/威胁/邀约/夸赞/推拉套路）不得在近几轮里换着词重复使用——要么延续上轮的框架往下推，要么换一个完全不同的角度。\n`
    + `- 只输出可直接复制发给对方的话术本体；不要输出【分析】【建议】、序号、步骤、进度、括号说明等任何附加内容；口语化、贴合关系阶段，像真人发微信。\n`
    + `- 密度范例：她"今天好无聊呀"→"这么闲啊 我正好有办法治你的无聊"（15字）。`;

  // [v196 决策流程] 思考链脚手架（对齐 IMA 思路）：定卡→消化弹药→候选池→淘汰→决策
  //   思考档（high/max）生效，思考过程不输出，最终只输出选定的话术本体
  s += `\n\n【决策流程】(思考档生效，回复前按序完成，思考过程不输出)\n`
    + `① 定卡：本轮属于哪张战术卡（防守/进攻/救场，具体到卡）？她这句话的真实意图是什么？\n`
    + `② 消化弹药：把【参考资料】里的方案提炼成 2-3 个可执行方向（如"先赞同再曲解""反转测试""不解释离场"），选最贴合【角色定位】人设的一个方向——禁止直接抄参考句，要按方向重新创作。\n`
    + `③ 生成候选：基于该方向快速生成 3-5 个候选回复，每个在心里标注（对应策略/字数/人设匹配度）。\n`
    + `④ 淘汰：对照【角色定位】人设（神秘、从容、控场、像魔术师一样留一手）+ 字数 ≥5≤18 + 无标点 + 口语化，淘汰不符的，保留最稳最妙的一个。\n`
    + `⑤ 决策：只输出最终选定的那一句话术本体，不要分析/说明/序号。`;

  // [v75 缓存①] 战术固定前导：使用说明+全局原则（每轮完全一致 → 前缀缓存白捡）
  s += GLOBAL_TACTIC_PREAMBLE;

  // [v73] 【兴趣信号与升级】已删除：被进攻类战术卡（升高关系/推拉/筛选）覆盖

  // [v20260813 缓存重构] ===== 固定区尾部（低频稳定块）=====
  //   以下两块基于 profiles.bio：用户极少修改 → 字节级稳定，留在 system 前缀区
  // [v75 缓存②] 【我的位置】（用户相关：按简介提取，命中才注入）
  const myLoc = extractLocation(opts.userBio || '');
  if (myLoc) {
    s += `\n\n【我的位置】（涉及见面、约人、距离、异地等表述以此为准）\n我所在城市：${myLoc}。\n`
      + `- 不知道对方在哪时不得假设对方离我很近；\n`
      + `- "过来找你/见面/顺路/接送"等邀约，必须同时结合【当前时间】与【我的位置】判断是否现实，不现实就委婉拒绝或改约。`;
  }

  // [v20260813 用户要求] 【用户个人简介】上移固定区尾部（bio 极少变 → 稳定命中）；
  //   措辞从顾问视角改为"你自己的信息"（配合"你即用户本人"角色）
  // [v20260813→v179 回移] 后台提示词（systemPrompt）从动态区移回固定区，放在用户个人简介前面：
  //   用户确认后台提示词基本定稿、不会频繁编辑 → 放固定区优先级更高、语义更顺；
  //   代价=每次编辑后台提示词全站缓存失效一次（低频操作，可接受）。
  //   空值时用硬编码兜底，保证固定区结构稳定
  const extraRule = (opts.systemPrompt && opts.systemPrompt.trim())
    ? opts.systemPrompt.trim()
    : '你是用户本人，一个有趣、有神秘感、有底线的真人。请根据对方的原话，用你自己的语气给出可直接发出的回复：口语化、有态度、像个真人发微信。';
  s += `\n\n【附加规则】\n${extraRule}`;

  // [v190 检索引用强化] 用户简介 = 用户真实资料的唯一事实源（v197 明确：仅资料，不参与人设筛选，
  //   人设筛选锚定【角色定位】——简介可能没填/无风格，靠它筛选会失效）
  //   对方问及自身情况（年龄/工作/城市/学历/家庭/爱好/收入等）→ 必须先在本简介中检索对应项，
  //   有则照实引用回答；简介没有的项不得编造（用模糊带过/反问她/转移）；与简介冲突的说法一律禁止
  if (opts.userBio && opts.userBio.trim()) {
    s += `\n\n【用户个人简介】（这是你自己的真实资料，是聊天中一切"关于你的事实"的唯一来源）\n${opts.userBio.trim()}\n`
      + `- 对方问到你的个人信息（年龄/工作/城市/学历/家庭/爱好/收入/经历等）时，先从本简介检索对应信息，有就如实引用；\n`
      + `- 简介里没有的信息：不编造，用含糊带过、反问对方或转移话题的方式处理；\n`
      + `- 你回复中出现的任何个人事实（几岁/哪人/做什么/家庭情况/兴趣）必须与本简介一致，禁止自相矛盾。`;
  }

  // [v20260813 缓存重构] ===== 动态区（注入最后一条 user 消息的【军师内参】，不占 system）=====
  //   背景：这些块每轮/低频变化，旧结构塞在 system 尾部仍会截断其后 history 的前缀缓存
  //   （时间每小时变 → history 几乎永不命中，38% 命中率元凶）。
  //   现在 system 只保留字节级稳定块，动态区作为独立字符串由组装处注入 user 尾部。
  let d = '';

  // [v80 缓存优化] 【上次聊天】块已后置到变化区尾部（每轮变，放前面会打断后续稳定块缓存）

  // [v20260812 思考预算开关] v81 曾回退（用户实测变笨）；现做成后台开关：
  //   thinkingBudget=on 且思考档 → 恢复 v78 压缩指令（省成本，可接受质量下降时打开）
  if (opts.thinkingBudget && opts.thinking && opts.thinking !== 'off') {
    d += `\n\n【思考预算】（思考档生效，最高优先）\n最终回复只有 ≤18 字（统一字数区间），思考也必须克制：只做必要推理（潜台词/意图/策略判断），最多 3 步直接给结论，禁止长篇分析、禁止复述对话内容、禁止罗列选项。`;
  }

  // [v75 缓存②] 【话题锚点】（记忆卡 profile.anchor，跨轮次变化）
  // [v183 锚点降频] 三态注入（方案 A 措辞降频 + 方案 B 事件驱动）：
  //   full（她本轮提到梗）：完整块，抓住做文章——这是锚点的核心价值（连续剧接续），只在此刻全力发挥
  //   light（每4轮一次轻量提醒）：只提醒"梗还在"，措辞明确"自然时再提、不必刻意"→ 不再诱导 LLM 每轮硬塞
  //   none（最近提过/轮次未到）：不注入 → 省 token，且消除"每轮强制连续剧"导致的重复腻感
  const anchor = opts.memoryCard?.profile?.anchor || '';
  const anchorMode = opts.anchorMode || 'none';
  if (anchor && anchorMode !== 'none') {
    if (anchorMode === 'full') {
      d += `\n\n【话题锚点】你和她的对话有一个长期共同梗：「${anchor}」——她刚刚提到了它，这是你俩的专属记忆，拉近距离的利器。\n`
        + `- 本轮必须自然地接住它：接梗/延伸/升级（调侃、回忆、拿它当邀约由头），这是本轮最高优先级的发挥点；\n`
        + `- 接住之后自然收住，别在这一个梗上反复打转。`;
    } else {
      d += `\n\n【话题锚点】你和她有个共同梗：「${anchor}」（你俩的专属记忆）。最近没怎么提它了，自然相关时（她主动提、或话题天然搭得上）可以顺势提一嘴；不要刻意找机会硬提。`;
    }
  }

  // [v75 缓存②] 【当前关系阶段】（按 stage 变化，放动态区）
  const stage = opts.memoryCard?.profile?.stage || '';
  if (stage && STAGE_HINTS[stage]) {
    d += `\n\n【当前关系阶段】${STAGE_HINTS[stage]}`;
  }

  // 记忆卡：对方画像（跨轮次相对稳定，但会随 updateMemoryCard 变化，放动态区）
  const profile = opts.memoryCard?.profile;
  if (profile && (profile.personality || profile.relationship_note || profile.recent_events)) {
    const parts: string[] = [];
    if (profile.personality) parts.push(`性格：${profile.personality}`);
    if (profile.relationship_note) parts.push(`关系背景：${profile.relationship_note}`);
    if (profile.recent_events) parts.push(`最近事件：${profile.recent_events}`);
    d += `\n\n【对方画像记忆】（跨轮次记住，回答时不要重复询问这些已知信息）\n${parts.join('\n')}`;
  }

  // [v195 逻辑记忆] 最近几条消息的逻辑脉络（系统级既定事实基准）：
  //   覆盖"正在聊什么/约定赌注/她表态/我方立场"，回答必须与其衔接一致，防前后矛盾
  const logicSummary = opts.memoryCard?.logic_summary?.text || '';
  if (logicSummary) {
    d += `\n\n【逻辑记忆】(最近对话的逻辑脉络，系统级既定事实基准)\n${logicSummary}\n`
      + `- 这是已经发生的既定事实：后续回复必须与此衔接一致，不得自相矛盾、不得推翻、不得假装不知道。\n`
      + `- 立过的约定/赌注/梗/承诺必须延续推进（如"零食赌注"→记账、加码、催兑现），换话题也不许丢弃。`;
  }

  // [P0-3] 去冗余：llmHistory ≥4 条时，其内容已含对方近期话/自己发过话，不再注入
  //   （仅窗口恢复等 llmHistory 缺失场景注入，防重复占用上下文）
  const hasRecent = opts.hasRecentHistory === true;
  // 记忆卡：对方近期说过的话
  // [v79.2 收紧] 8→4：llmHistory 已含近 5 条全文（v199 8→5），此处仅兜底窗口恢复场景，4 条足够
  const msgs = opts.memoryCard?.recent_user_messages || [];
  if (!hasRecent && msgs.length > 0) {
    d += `\n\n【对方近期说过的话】（供判断语感与关系状态）\n${msgs.slice(-4).join('\n')}`;
  }

  // [v9] 记忆卡：军师(自己)发过的话（防重复 + 保自洽；窗口 history 丢失后仍有效）
  // [v79.2 收紧] 8→4：llmHistory 已含近 5 条，兜底场景 4 条足够防重复
  const selfMsgs = opts.memoryCard?.recent_self_messages || [];
  if (!hasRecent && selfMsgs.length > 0) {
    d += `\n\n【你之前发过的话】（跨轮次记住，严禁原样或意思重复，后续回复必须与之一致衔接）\n${selfMsgs.slice(-4).join('\n')}`;
  }

  // 更早对话摘要
  if (opts.olderSummary) {
    d += `\n\n${opts.olderSummary}`;
  }

  // [v80 缓存优化] 【长期事实】块已后置到变化区尾部（按 query 相关度选，每轮变）

  // [v58] 关系目标（战略层）：'保持当前关系' / 空=默认推进
  //   [2026-08-15 话题清单已砍] 默认推进不再由话题清单驱动，交给战术卡组 + 知识库弹药
  const goal = opts.memoryCard?.goal || '';

  // 停止升级：维持现状指令（不主动推进升级、不引导新话题）
  if (goal === '保持当前关系') {
    d += `\n\n【关系状态】用户明确选择保持当前关系：本轮及后续都不主动推进升级、不引导新话题；正常聊天稳住温度即可，她主动聊就自然接住，但绝不主动发起试探/邀约/收集，情绪价值照给，绝不冷场。`;
  }

  // [v62 切换话题] 用户一键换话题：覆盖推进，本轮唯一任务 = 抛一个新话题开场
  //   放在所有目标/推进指令之后 = 最高优先级；检索词已切到"新话题/开场白"方向
  if (opts.switchTopic) {
    d += `\n\n【切换话题】(本轮最高优先级，覆盖上面的所有目标与推进指令)\n`
      + `- 用户对当前话题不满意，要求换一个新话题继续聊。\n`
      + `- 本轮任务：给出一句可以直接发给对方的新话题开场白（1 句，≥5 且 ≤18 字，带钩子/情绪/好奇心）。\n`
      + `- 新话题从哪来（按优先级）：①记忆卡/长期事实里她聊过、但还没深挖的兴趣点（如"你上次说的那家店"）；②话题锚点 anchor；③下面知识库参考资料里的开场白/惯例；④结合当前时间/位置的轻松日常话题（天气、最近热门、吃的）。\n`
      + `- 禁忌：不延续旧话题、不道歉、不解释为什么换话题、不提"换个话题吧"这种元话术；直接自然开场，像想到什么随口问一样。\n`
      + `- 输出只需这一句话术本体，不要任何附加说明。`;
  }

  // ===== 变化区尾部（战术/query 相关，放最后最小化对前缀缓存的破坏）=====
  // [v73 迷男精髓] 战术变化部分：当前阶段卡 + 命中类别卡组
  //   防守（敷衍/打压/废物测试/ASD/服从度低/消失/提前男友/海王）→ 防守卡
  //   self 暴露需求感 或 邀约被拒 → 救场卡；其余常态 → 进攻卡
  // [v80 缓存优化] 后置到稳定块（位置/锚点/阶段/简介/画像/目标）之后：
  //   战术切换不再打断稳定块的前缀缓存
  const tactic = opts.tactic || { category: 'attack' as const, phase: 'attract' as const, cardIndex: -1 };
  d += buildTacticBlock(tactic.category, tactic.phase, typeof tactic.cardIndex === 'number' ? tactic.cardIndex : -1);

  // [v20260809 机会窗口] 她主动问起相关话题 → 回答后必须镜像反问（最高优先，紧跟战术块）
  //   窗口只开这一轮：她问你没接，下轮再主动提就成了强行翻旧账，更生硬
  const openWindow = detectOpenWindow(opts.lastUserText || '');
  if (openWindow) {
    d += `\n\n【机会窗口】(本轮最高优先级，必须接住)\n`
      + `- 她主动问起了「${openWindow}」相关——这是她亲手递过来的窗口：说明她对你有兴趣，且大概率愿意等价交换信息。\n`
      + `- 本轮动作：先自然回答她的问题（自己也交换同等信息，别有保留），然后必须顺势镜像反问（"你呢？"），把「${openWindow}」这个话题顺势聊开。\n`
      + `- 区分查户口：查户口 = 连环盘问、她不回应还继续追问（禁止）；她先开口后的单次镜像反问 = 社交互惠（必须做），二者性质完全不同，别把互惠当查户口。\n`
      + `- 窗口只开这一轮，错过就没了：本轮必须接住，绝不只答不问、绝不让话题滑走。\n`
      + `- 例外：若她以责备/挑衅语气问（如"你多大的人了还这样"）→ 语境不适用，正常回应即可，不强求反问。`;
  }

  // [v147 机会窗口扩展] 她主动袒露自我（分享日常/自述特质/经历/喜好/关心你）→ 注入【接住分享】块
  //   与话题窗口互斥：她问你（detectOpenWindow）走镜像反问；她自述（detectSelfDisclosure）走接住分享
  //   修复案例："我比较专一"（自述特质）被按字面接成"那我外卖请你"（交易式）；"每天睡醒就喝消水肿"（分享）
  //   被接成"先给我带杯咖啡"（索取）→ 必须先接情绪再接事
  const selfDisclosure = !openWindow ? detectSelfDisclosure(opts.lastUserText || '') : null;
  if (selfDisclosure) {
    d += `\n\n【接住分享】(本轮最高优先级，必须接住)\n`
      + `- 她在主动向你分享/袒露自己（「${selfDisclosure}」类）——这不是闲聊，是她信任你、想拉近距离的信号：她给你递了"了解我"的钥匙。\n`
      + `- 本轮动作（三步，一步都不能省）：①先接住她的分享——认可/共鸣/顺着她的点回应（如"你这也太自律了吧""看得出来你是个讲究人"），先给情绪价值，绝不急着谈条件、不急着邀约、不急着拉回自己身上；②自然深挖一句——围绕她分享的点追问细节或关联一个你自己的相似经历（"我最近也在研究…""那你是不是…"），让她愿意继续讲；③可以轻升级——把话题往"咱俩"方向带（如"那以后我的咖啡也归你管了"这种，但只作收尾点缀，不喧宾夺主）。\n`
      + `- 铁律：她分享生活/特质时，回复绝不能是交易式接话（带咖啡/请客/点外卖/多少钱/几点了这类谈条件），必须先接情绪再接事；禁止只回"确实/厉害/哈哈"这种无内容附和。\n`
      + `- 区分查户口：她讲完你追问细节 = 关心；连环盘问不回应 = 查户口（禁止）。`;
  }

  // [v57] 长期事实选择性注入：按当前 query 相关度挑 top N（不全量塞，防记忆稀释）
  //   像人一样"根据当前话题想起相关的事"；无相关事实则不注入
  // [v80 缓存优化] 后置到变化区尾部（按 query 选 → 每轮变，不打断前面稳定块缓存）
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
      d += `\n\n【我记得这些】(长期记忆，按当前话题想起的)\n`
        + scoredFacts.map((x) => `- ${x.f.text}`).join('\n')
        + `\n- 结合它们自然回应：对方提到相关的事时，要自然带出"我记得"的感觉，别生硬背诵、别每条都提。`;
    }
  }

  // [v76] 上次聊天间隔（时间相关、每轮可能变；间隔 <1min 或查询失败不注入）
  // [v80 缓存优化] 后置到变化区尾部：每轮变，放前面会打断后续稳定块缓存
  if (opts.lastGapText) {
    d += `\n\n【上次聊天】（时间流逝感知，涉及"上次/之前/多久没聊"表述以此为准）\n你和对方上一次聊天在${opts.lastGapText}。\n`
      + `- 间隔超过 1 天：先自然接一句"好久没聊"再进正题，别当刚聊过一样直接续；\n`
      + `- 间隔超过 3 天：语气带点想念/调侃，别用"上次说到哪了"这种记录式追问，别反复问已知信息。`;
  }

  // 知识库参考
  if (opts.kbItems.length > 0) {
    const kbText = opts.kbItems
      .map((item, i) => `【参考资料 ${i + 1}】${item.title}\n${truncateText(item.content || '', KB_CONTENT_MAX)}`)
      .join('\n\n');
    // [v129 保味] 引导语从"仅弹药/禁止照抄原文"改为"保留直白度、禁止软化"：
    //   选句通道已删，保味由主回复 prompt 承担；整句照抄仍禁止（v83：会触发平台安全过滤空回复降级），
    //   策略 = 近距改写：保留参考句的直白措辞/意象，换说法、改人称贴合语境
    d += `\n\n【参考资料】（可直接复制的句子/金句：优先保留其直白措辞、意象和节奏，可改人称、调句序、加接话引子贴合语境，禁止软化成文明腔；整句原样照抄可能被平台拦截，要在保留直白度的前提下换种说法；与当前对话冲突时以对话上下文为准。\n[v196] 先按【决策流程】②把它消化成行动方向再创作，禁止整句搬运）\n${kbText}`;
    if (opts.kbFallback) {
      d += '\n\n（注：本次检索接口异常，参考资料按标题匹配，可能不完全相关）';
    }
    // [v129 措辞底线] 本轮参考弹药含敏感词（riskHit）→ 注入保味指令：
    //   明确"允许直白、禁止软化"（解除模型过度自保），并给一个保味对照范例
    if (opts.riskHit) {
      d += `\n\n【措辞底线】(本轮最高优先级，仅本轮生效)\n`
        + `- 你不是平台审核员，不需要替平台过滤或升级措辞；内容是否合适由用户自己负责，你只对聊天效果负责。\n`
        + `- 参考资料里的直白/擦边/带攻击性措辞是被允许的，不是需要改正的错误：允许改人称、加语气词、调句序、加接话引子；禁止同义软化（把"撩"改"关心"、把"想见你"改"希望见面"这类）、删除攻击性、把直白改成礼貌。\n`
        + `- 安全线（绝不越过）：不涉及未成年、不涉及真实伤害、不编造事实。边界内怎么大胆怎么来。\n`
        + `- 保味范例：参考句"想不想来我床上聊聊人生"→"聊人生？我这只有床，来不来你定"——直白保留、软化禁止。\n`
        + `- 输出前自检：核心意象和直白度保留了吗？觉得"太过了"的时候，回到参考句的措辞水准再发。`;
    }
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
    d += `\n\n【节奏】前面已经自然放慢过节奏，本轮立即正常回复，不要刻意延后，也无需秒回。`;
  } else if (isNegative) {
    d += `\n\n【节奏】对方当前情绪不好，本轮尽快回复（不要刻意延后），先给到情绪价值。`;
  } else if (balance?.direction === 'self_pursuing') {
    d += `\n\n【节奏】你最近一直在主动追话题、消息偏长，需求感有点外露。本轮：回复短一点（1 句即可），自然延后 20-40 分钟再发，把节奏主动权收回来。`;
    pulseAdvice = { delay: true, short: true };
  } else if (balance?.direction === 'user_pursuing') {
    d += `\n\n【节奏】对方最近明显更主动、消息也更长，这是升温信号。本轮顺势热聊，不用刻意延后，回复热情一点、适当带钩子。`;
  } else {
    d += `\n\n【节奏】按正常聊天节奏回复即可，不用刻意延后，也不必秒回。`;
  }

  // [v15] 当前时间（[v20260811 缓存] 挪到全部块的最后：每小时变一次，只要放中间就会打断
  //   其后所有稳定块的 DeepSeek 前缀缓存——这是缓存命中率 38% 的元凶，现在放末尾，
  //   前面 1200+ 字固定/低频块全部可稳定命中）
  d += `\n\n【当前时间】（严格遵守，所有时刻/时段表述以此为准）\n${formatCurrentTime()}\n`
    + `- 严禁编造或猜错时刻；"今晚/明天/周末/这么晚"等词必须与时间一致；判断这个点适不适合约人/打电话/聊深夜话题以此为准，别半夜答应见面或约人。`;

  return { systemContent: s, dynamicContent: d, pulseAdvice, factsInjected };
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
// [v127 超时治降级] LLM 调用超时/重试配置
//   背景：摸底确认降级真凶 = thinking 模式慢响应 + 裸 fetch 无超时 → 被 Edge Function 60s
//   超时切断 → catch → 降级知识库拼装。加超时 + 主回复失败重试：
//   主回复（thinking 档可能慢）25s 超时，超时重试降 thinking off 15s（提速保底，避免降级）
//   辅助调用（全 off 档）15s 超时不重试（失败已有上层降级语义：返回空/[]/null）
const LLM_MAIN_TIMEOUT_MS = 25000;
const LLM_MAIN_RETRY_MS = 15000;
const LLM_AUX_TIMEOUT_MS = 15000;

async function llmChat(
  llmKey: string, llmBase: string, llmModel: string,
  messages: any[], opts: { temperature?: number; maxTokens?: number; frequencyPenalty?: number; presencePenalty?: number; thinking?: ThinkingMode; _stage?: string } = {}
): Promise<string> {
  const thinking = opts.thinking ?? 'off';
  const isV4 = /v4/.test(llmModel);
  const stage = (opts as any)._stage || 'llm';
  const isMain = stage === 'main_reply';
  const timeoutMs = isMain ? LLM_MAIN_TIMEOUT_MS : LLM_AUX_TIMEOUT_MS;
  const buildBody = (th: ThinkingMode): any => {
    const b: any = { model: llmModel, messages };
    if (isV4 && th !== 'off') {
      b.thinking = { type: 'enabled' };
      b.reasoning_effort = th;
      // 思考模式：temperature / top_p / presence_penalty / frequency_penalty 不生效（官方强制）
      b.max_tokens = Math.max(opts.maxTokens ?? 1200, THINKING_MAX_TOKENS);
    } else {
      if (isV4) b.thinking = { type: 'disabled' }; // V4 默认开思考，非思考档显式关闭
      b.temperature = opts.temperature ?? 0.4;
      b.max_tokens = opts.maxTokens ?? 1200;
      b.frequency_penalty = opts.frequencyPenalty ?? 0.5;
      b.presence_penalty = opts.presencePenalty ?? 0;
    }
    return b;
  };
  const url = `${llmBase.replace(/\/$/, '')}/chat/completions`;
  const doFetch = async (th: ThinkingMode, timeout: number): Promise<{ status: number; errText: string; data: any }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${llmKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody(th)),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return { status: resp.status, errText: errText.slice(0, 200), data: null };
      }
      return { status: 200, errText: '', data: await resp.json() };
    } catch (e: any) {
      return { status: 0, errText: e && e.name === 'AbortError' ? '__TIMEOUT__' : String((e && e.message) || e), data: null };
    } finally {
      clearTimeout(timer);
    }
  };

  // 首次请求
  let attempt = await doFetch(thinking, timeoutMs);
  // [v127] 主回复：超时/网络错误(status 0)/429/5xx → 重试一次；超时重试降 thinking off 提速
  if (!attempt.data && isMain && (attempt.status === 0 || attempt.status === 429 || attempt.status >= 500)) {
    const retryThinking: ThinkingMode = attempt.status === 0 ? 'off' : thinking;
    const retryTimeout = attempt.status === 0 ? LLM_MAIN_RETRY_MS : timeoutMs;
    attempt = await doFetch(retryThinking, retryTimeout);
    if (attempt.data) {
      console.warn(`[v127] LLM 主回复重试成功（首轮 ${attempt.status === 0 ? '超时/网络错误' : 'HTTP ' + attempt.status}，重试 ${retryThinking === 'off' ? '降档off' : '同档'}）`);
    }
  }
  if (!attempt.data) {
    if (attempt.status === 0) throw new Error(`LLM ${attempt.errText === '__TIMEOUT__' ? '超时' : '网络错误'}: ${attempt.errText}（已重试）`);
    throw new Error(`LLM HTTP ${attempt.status}: ${attempt.errText}`);
  }
  const data = attempt.data;
  const content = data?.choices?.[0]?.message?.content;
  // [v72 调试] 捕获思考链（thinking 档才有；辅助调用 thinking off 无 reasoning，不会覆盖主回复）
  const reasoning = data?.choices?.[0]?.message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) llmReasoning = reasoning;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM 返回内容为空');
  }
  // [vB] usage 采集（token 测量用，_debug 透传）
  // [v186] 补记 model/thinking → persistLlUsage 落库 llm_usage_log
  if (data?.usage) {
    llmUsageLog.push({ stage: (opts as any)._stage || 'llm', usage: data.usage, model: llmModel, thinking });
  }
  return content.trim();
}

// [vB] LLM usage 日志（token 测量；顶层声明防作用域事故）
// [v186] 扩展：补记 model/thinking；响应返回前由 persistLlUsage 批量写库 llm_usage_log
const llmUsageLog: { stage: string; usage: any; model?: string; thinking?: string }[] = [];
// [v186] 一轮一个 request_id（Edge Function 每请求独立沙箱，顶层变量安全）
let currentRequestId = '';

// [v186] 批量落库 LLM usage（在主流程返回前调用；写库失败只记日志，不影响回复）
async function persistLlUsage() {
  if (llmUsageLog.length === 0) return;
  const u = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!u || !key) return;
  const rows = llmUsageLog.map((e) => {
    const us = e.usage || {};
    const prompt = Number(us.prompt_tokens) || 0;
    const hit = Number(us.prompt_cache_hit_tokens) || 0;
    return {
      request_id: currentRequestId || 'unknown',
      stage: e.stage || 'llm',
      model: e.model || '',
      prompt_tokens: prompt,
      completion_tokens: Number(us.completion_tokens) || 0,
      cache_hit_tokens: hit,
      cache_miss_tokens: Math.max(Number(us.prompt_cache_miss_tokens) || 0, prompt - hit),
      thinking: e.thinking || '',
    };
  });
  try {
    const resp = await fetch(`${u}/rest/v1/llm_usage_log`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'apikey': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) console.warn(`[usage] 落库失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  } catch (e: any) {
    console.warn('[usage] 落库异常:', e.message);
  }
}

// ============================================================
// [v117b 归属标签清洗] 剥掉 LLM 输出里偶发复制的上下文归属标签
//   背景：v116 归属加固给 history 每条加【对方说】/【我发的】前缀后，
//   部分回复把前缀模仿进输出（如"【我发的】你哪来那么多哈哈哈"），
//   用户可见话术被污染 → 统一剥掉行首标签，保留话术本体
//   只删"行首 + 标签 + 尾部空白"，话术内容不动；长词在前防子串误删
// ============================================================
const ROLE_TAG_RE = /^[ \t]*【(?:我发的|我说过|我说的话|我发的话|我说的|我说|对方说|对方发来|对方的话|她说的|她发来|她发的话|她的话|她说|他说的|他发来|他的话|他说)】/gm;
function stripRoleTags(text: string): string {
  if (!text) return text;
  // 循环剥直到无残留：覆盖"【我发的】紧跟【我发的】"这类连续标签
  let prev: string;
  do {
    prev = text;
    text = text.replace(ROLE_TAG_RE, '');
  } while (text !== prev);
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
// [v129 保味替换] 原 v119 选句通道（pickBestLine/extractCandidateLines）已删除：
//   整句复制知识库原句与聊天场景格格不入。保味改由主回复 prompt 承担
//   （【措辞底线】动态注入 + 参考资料引导语保留直白度），此处仅保留
//   高危词表（riskHit 预检 + 消毒检测共用）与消毒检测函数
// ============================================================
// [v129] 高危词表（强信号、低误报）：参考弹药含这些词 → 本轮高风险消毒轮
//   （多义词/弱信号如"约/吻/抱/酒店/丑/胖"不入表，避免误报）
const RISK_WORDS = ['胸', '罩杯', '内衣', '内裤', '屁股', '臀', '身材', '摸', '开房', '床上', '接吻', '舔', '骚', '浪', '贱', '勾引', '女仆', '包养', '跪舔', '备胎', '妈的', '操'];

// [v129 消毒检测] 参考弹药含强敏感词、回复里这些词全部消失 → 判定消毒（返回消失词列表，无则 null）
//   只在参考句有敏感词时才有意义：没敏感词的轮次不存在"消毒"
function detectSanitize(reply: string | null | undefined, kbItems: any[]): string[] | null {
  const srcWords = new Set<string>();
  for (const it of (Array.isArray(kbItems) ? kbItems : [])) {
    const c = String((it && it.content) || '');
    for (const w of RISK_WORDS) if (c.includes(w)) srcWords.add(w);
  }
  if (srcWords.size === 0) return null;
  const r = String(reply || '');
  const gone = [...srcWords].filter((w) => !r.includes(w));
  return gone.length > 0 ? gone : null;
}

// [v129] 消毒观测（顶层声明防作用域事故）：riskHit=本轮参考弹药含敏感词；sanitizeHit=生成后检出消毒
let lastRiskHit = false;
let lastSanitizeHit = false;
// [v185 错字彩蛋] 观测：本轮是否命中"秒回错字"（_debug 透传，验证 20% 命中率）
let lastTypoHit = false;
// [v72 调试] 最近一次主回复的思考链原文（thinking 档才有；_debug 透传，辅助调用不覆盖）
let llmReasoning = '';

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
//   kb_blocks 表（[v79] 4551 块，语义切块）：bigrams GIN 粗筛 + 块内词频加权打分（RPC kb_blocks_recall）
//   [2026-08-06] 权重：语义词×2 / 规则词与原文×1.5（整句路已移除）
//   [v79] 块类型（话术/套路）写于 block_title 前缀 [话术]/[套路]
//   [2026-08-11] 套路机制移除：仅检索话术(弹药)块，套路块不再检索
//   返回 items 带 _fulltext 标记与 _ft_score；同文档最多 2 块（RPC 内去重）
//   失败/空缓存 → 返回 []，不影响主链路
// ============================================================
async function recallBlocks(
  supabaseUrl: string, serviceRoleKey: string,
  semanticKws: string[], extraQueries: string[],
  opts?: { pickCount?: number; hsFolder?: string | null; jxFolder?: string | null; type?: '话术'; phase?: 'attract' | 'comfort' | 'seduce' }
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
    // [v76] 教学/实战删库后仅剩 739 块（话术内容高度重叠）→ 候选池 24→12（target*3，覆盖 6 个文档足够）
    const target = opts?.pickCount || KB_REF_COUNT;
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/kb_blocks_recall`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_grams: [...grams].slice(0, 80),
        p_words: queries.slice(0, 20),
        p_weights: weights.slice(0, 20),
        p_limit: Math.max(target * 3, 12),
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

    // [v79] 类型过滤：block_title 前缀 [话术]（弹药检索只取话术块；套路块不检索）
    if (opts?.type) {
      const prefix = `[${opts.type}]`;
      items = items.filter((it) => (it.block_title || '').startsWith(prefix));
    }
    if (items.length === 0) return [];

    // [v53] 内存精排：算质量分 → 剔低质块 → 按 相关分+质量分×权重 重排
    //   全被剔光时退回原始列表（保证有弹药可用）；排序后 applyQuota 从精排池里挑
    // [v148 弹药阶段加权] 当前战术阶段 phase → 同阶段文档加权、异阶段降权、通用/防守不偏不倚
    //   实现：排序分 = 相关分 + 质量分×权重 + 阶段修正
    //   权重设计：同阶段 +3（显著优先）、异阶段 -2（降权不剔出，防候选池空/误伤）、general/defense 0
    const stageAdj = (it: any): number => {
      if (!opts?.phase) return 0;
      const st = titleStage(it.title || '');
      if (st === opts.phase) return 3;
      if (st === 'general' || st === 'defense') return 0;
      return -2;
    };
    const scored = items
      .map((it) => {
        const q = calcGemScore(it.content || '', it.block_title || '');
        return { ...it, _gem: q, _stageAdj: stageAdj(it) };
      })
      .filter((it) => it._gem >= GEM_MIN)
      .sort((a, b) => ((b._ft_score || 0) + (b._gem || 0) * GEM_WEIGHT + (b._stageAdj || 0)) - ((a._ft_score || 0) + (a._gem || 0) * GEM_WEIGHT + (a._stageAdj || 0)));
    // [v200 质量分定位] 质量分是"排序择优键"不是"绝对过滤阀"：
    //   GEM_MIN=-1 只剔极端口水块（正常话术 0.5~3 分几乎不触发）；择优靠排序。
    //   全被剔光（极端场景）→ 按相关分降序回退，绝不交付未排序列表（否则配额挑到最差块 = 知识库白干）
    if (scored.length > 0) {
      items = scored;
    } else {
      items = items.slice().sort((a, b) => (b._ft_score || 0) - (a._ft_score || 0));
    }

    // 4. 状态感知配额（仅剩恋爱话术一类；jx 空时 hs 吃满，见 applyQuota）
    return opts ? applyQuota(items, {
      hsFolder: opts.hsFolder,
      jxFolder: opts.jxFolder,
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
  query: string, opts?: { pickCount?: number; hsFolder?: string | null; jxFolder?: string | null }
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
// [v7] 状态感知配额：话术/教学两类内容分桶选取
//   [B方案] hs/jx 判定改用 folder_id（本地 kb_blocks：恋爱话术=hs，恋爱教学/聊天实战=jx）
//   [2026-08-06] 教学/实战已删库：jx 为空时 hs 直接吃满 pickCount
//     （否则上下文弹药从 5 条缩水到 2-3 条，务必保留 !jx 分支）
//   [2026-08-11] strategyActive 分桶已随套路机制移除
// ============================================================
function applyQuota(items: any[], opts: { hsFolder?: string | null; jxFolder?: string | null; pickCount?: number }): any[] {
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

  const hsQuota = !jx ? count : 3;
  const jxQuota = !jx ? 0 : 2;
  const picked = [
    ...hsList.slice(0, Math.min(hsQuota, count)),
    ...jxList.slice(0, Math.min(jxQuota, count)),
    ...otherList,
  ];
  return picked.slice(0, count);
}

// ============================================================
// 知识库内容拼装回复（无 LLM 时的降级路径）已移除：
// [v127] 用户明确要求 LLM 失败直接掉线提示，不做本地拼装糊弄（assembleKbReply 删除）

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
//   [v77] 后台仅保留思考模式默认档；采样参数（temperature/惩罚系数/max_tokens）
//   已由下方六阶段联动表接管，不再从后台读取。
//   llm_params 存 JSON 字符串：{"thinking_mode":"off","thinking_budget":"auto"}
//   [v20260812 思考预算三档] thinking_budget ∈ auto/on/off，默认 auto：
//     on 且思考档 → 始终注入【思考预算】指令压缩思考链；
//     off → 永不注入（自然思考）；
//     auto → 高峰时段（工作日 9:00-12:00 / 14:00-18:00，DeepSeek 价格翻倍）压缩，其余不压缩
//   （v78 方案，v81 因"变笨"回退；做成后台开关，auto 为默认：高峰省成本、闲时保质量）
// ============================================================
type LlmParams = {
  thinking_mode: ThinkingMode;
  thinking_budget?: 'auto' | 'on' | 'off';
};
const DEFAULT_LLM_PARAMS: LlmParams = { thinking_mode: 'off', thinking_budget: 'auto' };

// [v20260812 高峰判定] DeepSeek 高峰时段（价格翻倍）：工作日(周一~周五) 9:00-12:00 / 14:00-18:00
//   Asia/Shanghai 时间；auto 档用它决定是否压缩思考链
function isDeepSeekPeak(): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday')?.value || '';
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    if (wd === 'Sat' || wd === 'Sun') return false;
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  } catch {
    const h = new Date().getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }
}

// [v77→v182 三阶段统一] 三阶段 × 三采样参数联动（主回复/重生成按 memoryCard.profile.stage 取档）
//   设计依据：temperature=采样随机性（性格/冒险），presence=话题/词汇翻新，
//   frequency=高频重复压制。三参数同向但幅度不同：
//     恋爱三高（活跃多样、钩子不断）；舒适中段；吸引靠展示面/冷读，presence 给中高压口头禅
//   frequency 峰值 0.85 封顶：给【话题锚点】复用留空间，且与 presence 叠加避免过度换词
const STAGE_LLM_PARAMS: Record<string, { temperature: number; presence_penalty: number; frequency_penalty: number }> = {
  '吸引': { temperature: 0.58, presence_penalty: 0.35, frequency_penalty: 0.75 },
  '舒适': { temperature: 0.62, presence_penalty: 0.40, frequency_penalty: 0.70 },
  '恋爱': { temperature: 0.72, presence_penalty: 0.60, frequency_penalty: 0.80 },
};
// 无阶段/未识别阶段 → 吸引档（安全中间值，兼容旧记忆卡与窗口恢复场景）
const DEFAULT_STAGE_LLM = { temperature: 0.6, presence_penalty: 0.3, frequency_penalty: 0.7 };
// [v77] 主回复输出上限（原后台 max_tokens 默认值，固定；思考档由 llmChat 内部自动放宽到 2000+）
const MAIN_MAX_TOKENS = 1200;
function resolveStageLlmParams(stage?: string | null): { temperature: number; presence_penalty: number; frequency_penalty: number } {
  if (stage && STAGE_LLM_PARAMS[stage]) return STAGE_LLM_PARAMS[stage];
  return DEFAULT_STAGE_LLM;
}

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
    // [v10] thinking_mode：后台默认档（枚举校验，非法回退 off）
    // [v77] 其余字段（temperature/惩罚系数/max_tokens）不再读取，由 STAGE_LLM_PARAMS 接管
    const tm = (typeof raw.thinking_mode === 'string' && THINKING_MODES.has(raw.thinking_mode))
      ? raw.thinking_mode as ThinkingMode
      : DEFAULT_LLM_PARAMS.thinking_mode;
    // [v20260812 思考预算三档] auto/on/off 枚举校验，非法回退 auto（默认）
    const tb = (raw.thinking_budget === 'on' || raw.thinking_budget === 'auto')
      ? raw.thinking_budget as 'auto' | 'on'
      : 'off' as const;
    return {
      system_prompt: (typeof row.system_prompt === 'string') ? row.system_prompt : '',
      llm_params: { thinking_mode: tm, thinking_budget: tb },
    };
  } catch (e: any) {
    console.warn('fetchAppConfig failed:', e.message);
    return { system_prompt: '', llm_params: { ...DEFAULT_LLM_PARAMS } };
  }
}

