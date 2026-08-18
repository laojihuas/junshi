// ============================================================
// 军师 - 聊天窗口模块
// ============================================================

const Chat = {
    currentSessionId: null,
    currentFriendName: '',
    messages: [],

    async open(sessionId, restoreContext = false, fromHistory = false) {
        this.currentSessionId = sessionId;
        Utils.dlog('chat.open', 'session=' + sessionId + ' restore=' + restoreContext);

        // 获取会话信息
        const sb = getSupabaseClient();
        const { data: session } = await sb
            .from('chat_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

        if (!session) {
            Utils.toast('会话不存在');
            // 记录失效（好友可能已被删除），清除残留恢复标记
            WindowSession.saveLastView('friends');
            Utils.dlog('chat.open', 'session NOT FOUND');
            return false;
        }

        this.currentFriendName = session.friend_name;
        document.getElementById('chat-title').textContent = session.friend_name;

        // [v20260818 自动取名] 新会话（占位名"新对话"）：首条消息发出时
        // 自动截取消息头部字词作为好友昵称（见 send），列表只显示该昵称
        this._needsAutoName = !session.friend_name || session.friend_name === '新对话';

        // [v20260805] 记忆：缓存 memory_card（记忆按钮弹层用；打开时已有，零额外请求）
        this.memoryCard = session.memory_card || null;
        // [v58] 阶段升级提示基线：记录打开时的 stage
        let mc = null;
        try {
            mc = this.memoryCard
                ? (typeof this.memoryCard === 'string' ? JSON.parse(this.memoryCard) : this.memoryCard)
                : null;
            this._prevStage = (mc && mc.profile && mc.profile.stage) || '';
        } catch (e) {
            this._prevStage = '';
        }

        // [多窗口会话] 记录当前窗口正在对话的好友，
        // 该好友在本窗口中的 AI 对话上下文（history）独立维护于 sessionStorage
        WindowSession.setActiveFriend(sessionId);

        // [杀进程恢复] 记录当前停留的聊天页（localStorage），
        // 切后台被浏览器回收后，回来自动恢复到本页面
        WindowSession.saveLastView('chat', sessionId, session.friend_name);

        // 加载消息
        this.messages = await DB.getMessages(sessionId);

        // [杀进程恢复] 仅在恢复路径（restoreContext=true）且窗口历史为空时，
        // 从数据库最近消息重建 AI 上下文：浏览器回收页面进程后 sessionStorage
        // 会丢失，导致 AI 不记得之前的对话；用数据库持久化消息补回最近 50 条。
        // 注意：正常点击进入好友不重建，保持"多窗口会话隔离"设计
        if (restoreContext) {
            const history = WindowSession.getHistory(sessionId);
            if (history.length === 0 && this.messages.length > 0) {
                const recent = this.messages
                    .slice(-50)
                    .map(m => ({ role: m.role, content: m.content }));
                WindowSession.setHistory(sessionId, recent);
            }
        }

        this.renderMessages();

        // 切换到聊天页面
        // [系统返回手势] 进入聊天写入一条浏览器历史记录：
        // 手机左边缘右滑 = 浏览器后退 = popstate → 应用内回到好友列表
        // fromHistory=true（popstate 前进/恢复触发）时不再 push，避免历史栈膨胀
        if (!fromHistory) {
            history.pushState({ page: 'chat', friendId: sessionId }, '');
        }
        App.navigate('chat');

        // [v20260805] 记忆按钮：聊天右上角，查看军师对她的记忆
        document.getElementById('chat-memory-btn').onclick = () => this.openMemoryModal();
        return true;
    },

    // [v20260805] 打开"关于她的记忆"弹层：实时拉最新 memory_card 再渲染
    async openMemoryModal() {
        const overlay = document.getElementById('modal-memory');
        const body = document.getElementById('memory-body');
        if (!overlay || !body || !this.currentSessionId) return;

        overlay.classList.add('active');
        body.innerHTML = '<div class="memory-loading">加载中...</div>';
        const closeBtn = document.getElementById('memory-close');
        closeBtn.onclick = () => overlay.classList.remove('active');
        overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('active'); };

        try {
            // 实时拉最新（会话中记忆一直在更新；一次轻量 GET，零成本）
            const sb = getSupabaseClient();
            const { data } = await sb
                .from('chat_sessions')
                .select('memory_card')
                .eq('id', this.currentSessionId)
                .single();
            this.memoryCard = (data && data.memory_card) ? data.memory_card : this.memoryCard;
        } catch (e) {
            console.warn('[军师] 拉取记忆失败，用缓存:', e.message);
        }
        try {
            body.innerHTML = this._renderMemory(this.memoryCard);
        } catch (e) {
            console.error('[军师] 渲染记忆失败:', e);
            body.innerHTML = '<div class="memory-empty">记忆数据解析失败，请稍后再试</div>';
        }
    },

    // [v20260805b] 渲染记忆面板
    _renderMemory(raw) {
        try {
            return this._renderMemoryInner(raw);
        } catch (e) {
            console.error('[军师] _renderMemory 异常:', e);
            return '<div class="memory-empty" style="color:#F09595">记忆面板渲染失败: ' + this._escapeHtml(String(e.message || e)) + '</div>';
        }
    },
    _renderMemoryInner(raw) {
        let mc = null;
        try {
            mc = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        } catch (e) {
            mc = null;
        }
        if (!mc) {
            return '<div class="memory-empty">还没有关于她的记忆。聊几轮之后，军师会自动记住她说过的话、性格和重要事情。</div>';
        }
        const p = mc.profile || {};
        const facts = Array.isArray(mc.facts) ? mc.facts : [];
        const goal = mc.goal || '';

        // [v190] 舒适 #993556(粉) → #C9971C(黄)：与好友列表头像一致
        const STAGE_COLORS = { '吸引': '#185FA5', '舒适': '#C9971C', '恋爱': '#A32D2D' };
        const stageColor = STAGE_COLORS[p.stage] || '#5F5E5A';
        const stageTag = (p.stage && p.stage !== '')
            ? `<span class="memory-tag" style="background:${stageColor}">${this._escapeHtml(p.stage)}</span>`
            : '';

        const sec = (title, dotColor, html) =>
            `<div class="memory-section"><div class="memory-sec-title"><span class="memory-dot" style="background:${dotColor}"></span>${title}</div>${html}</div>`;

        // [v58] 目标 + [v182] 三阶段推进链（吸引→舒适→恋爱；已过.done 小绿、进行中.on 加亮）
        const goalHtml = goal ? `<div class="memory-goal">目标：${this._escapeHtml(goal)}</div>` : '';
        const STAGE_CHAIN = ['吸引', '舒适', '恋爱'];
        let chainHtml = '';
        if (p.stage && STAGE_CHAIN.includes(p.stage)) {
            const idx = STAGE_CHAIN.indexOf(p.stage);
            chainHtml = '<div class="memory-chain">' + STAGE_CHAIN.map((st, i) =>
                `<span class="chain-node${i === idx ? ' on' : ''}${i < idx ? ' done' : ''}">${st}</span>${i < STAGE_CHAIN.length - 1 ? '<span class="chain-arrow">→</span>' : ''}`
            ).join('') + '</div>';
        }
        // [v20260805c 摘除关系词] 摘除 stageTag（关系阶段区色点旁大字），但保留目标+文字推进链
        const stageSec = sec('关系阶段', stageColor, goalHtml + (chainHtml || '<div class="memory-empty">暂无</div>'));

        const factsHtml = facts.length > 0
            ? `<ul class="memory-items">${facts.slice(0, 10).map(f => `<li>${this._escapeHtml(f.text || '')}</li>`).join('')}</ul>`
            : '<div class="memory-empty">暂无长期事实。对方提到生日/约定/偏好等关键信息时，军师会自动记住。</div>';

        const profileBits = [];
        if (p.anchor) profileBits.push(`共同梗：${this._escapeHtml(p.anchor)}`);
        if (p.personality) profileBits.push(`性格：${this._escapeHtml(p.personality)}`);
        if (p.relationship_note) profileBits.push(`关系背景：${this._escapeHtml(p.relationship_note)}`);
        if (p.recent_events) profileBits.push(`最近事件：${this._escapeHtml(p.recent_events)}`);
        const profileHtml = profileBits.length > 0
            ? `<ul class="memory-items">${profileBits.map(x => `<li>${x}</li>`).join('')}</ul>`
            : '<div class="memory-empty">暂无画像信息</div>';

        // [v20260811 话题] 已聊话题（记忆面板展示）已随话题清单机制整体移除（2026-08-15）
        return stageSec
            + sec('长期记忆', '#1D9E75', factsHtml)
            + sec('她的画像', '#378ADD', profileHtml);
    },

    renderMessages() {
        const container = document.getElementById('chat-messages');
        if (this.messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 40px 20px;">
                    <div class="empty-icon" style="font-size: 48px;">💬</div>
                    <p style="font-size: 14px;">开始对话吧<br>粘贴对方说的话，我来帮你回复</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.messages.map(m => {
            const time = this._formatTime(m.created_at);
            if (m.role === 'user') {
                return `
                    <div class="message user">
                        <div class="message-content">${this._escapeHtml(m.content)}</div>
                        <div class="message-time">${time}</div>
                    </div>
                `;
            } else {
                const reasoningHtml = (m.reasoning)
                    ? '<details class="reasoning"><summary>军师分析 ▾（内部推理，勿直接发出）</summary><div class="reasoning-body">' + this._escapeHtml(m.reasoning) + '</div></details>'
                    : '';
                return `
                    <div class="message assistant">
                        <div class="message-content">${this._escapeHtml(m.content)}</div>
                        ${reasoningHtml}
                        <div class="message-footer">
                            <span class="message-time">${time}</span>
                            <button class="message-regen-btn" data-msg-id="${m.id}">🔄 重生</button>
                            <button class="message-copy-btn" data-content="${this._escapeAttr(m.content)}">
                                📋 复制
                            </button>
                        </div>
                    </div>
                `;
            }
        }).join('');

        // 复制按钮事件
        container.querySelectorAll('.message-copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const content = btn.dataset.content;
                try {
                    await navigator.clipboard.writeText(content);
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => {
                        btn.textContent = '📋 复制';
                    }, 2000);
                } catch (e) {
                    // 降级方案
                    const ta = document.createElement('textarea');
                    ta.value = content;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => {
                        btn.textContent = '📋 复制';
                    }, 2000);
                }
            });
        });

        // [v20260809 重生] 重生按钮事件：对不满意的回复重新生成（覆盖旧回复）
        container.querySelectorAll('.message-regen-btn').forEach(btn => {
            btn.addEventListener('click', () => this.regenMessage(btn));
        });

        // [v20260803] 滚动到底部：首次打开聊天页时页面还处于 display:none（未切换 active），
        // 此时 scrollHeight 无效、直接赋值 scrollTop 不会生效（会停在最早记录），
        // 必须等页面切换显示后再滚动，双重 requestAnimationFrame 确保布局已完成
        this.scrollToBottom();
    },

    // [v20260803] 滚动到底部（延迟到页面显示后执行）
    scrollToBottom() {
        const container = document.getElementById('chat-messages');
        if (!container) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        });
    },

    // [v20260803] 消息时间显示：今天只显示时分（如 14:30）；
    // 非今天（昨天/更早）显示日期 + 时间（今年内：08-02 14:30，往年：2026-08-02 14:30）
    _formatTime(isoStr) {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return '';
        const now = new Date();
        const hm = d.toLocaleTimeString('zh-CN', {
            hour: '2-digit', minute: '2-digit'
        });
        const isToday = d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        if (isToday) return hm;
        const pad = n => String(n).padStart(2, '0');
        const datePart = d.getFullYear() === now.getFullYear()
            ? pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        return datePart + ' ' + hm;
    },

    // [v83 防连点] 输入区按钮统一锁定/恢复：发送/粘贴/换话题任一操作进行中，
    // 三个按钮全部禁用并变灰，结束后恢复，避免重复点击触发重复请求
    _setInputBusy(disabled) {
        ['chat-send-btn', 'chat-paste-btn', 'chat-switch-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        });
    },

    // 发送消息
    async send() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();

        if (!text) return;

        if (!this.currentSessionId) return;

        // 检查是否可调用
        if (!await this._checkCanUse()) {
            return;
        }

        // [v83] 锁定输入区全部按钮（发送/粘贴/换话题变灰不可再按），结束后恢复
        this._setInputBusy(true);
        input.value = '';

        // 1. 添加用户消息
        const userMsg = await DB.addMessage(this.currentSessionId, 'user', text);
        if (userMsg) {
            this.messages.push(userMsg);
            this.renderMessages();
        }

        // [v20260818 自动取名] 新会话首条消息：截取消息头部"第一组字词"作为好友昵称，
        // 外面列表只显示该昵称（= 新建会话 + 首条消息自动拆头作标题）
        if (this._needsAutoName) {
            const newName = this._extractFriendName(text);
            if (newName && newName !== this.currentFriendName) {
                const updated = await DB.updateSession(this.currentSessionId, { friend_name: newName });
                if (updated) {
                    this.currentFriendName = newName;
                    document.getElementById('chat-title').textContent = newName;
                    // 后台刷新好友列表（返回时展示新昵称）
                    Friends.load();
                    this._needsAutoName = false;
                }
                // 更新失败则保留待取名状态，下次发送再试
            }
        }

        // [多窗口会话] 将用户消息追加到本窗口（该好友）的对话历史
        //   [v184] 携带 created_at（后端话题健康度"响应速度"维度数据源；DB 消息有则用，无则当前时间）
        const userCreatedAt = (userMsg && userMsg.created_at) || new Date().toISOString();
        WindowSession.append(this.currentSessionId, 'user', text, userCreatedAt);

        // 2. 显示加载中
        const container = document.getElementById('chat-messages');
        const loadingEl = document.createElement('div');
        loadingEl.className = 'loading-dots';
        loadingEl.id = 'loading-dots';
        loadingEl.innerHTML = '<span></span><span></span><span></span> 思考中...';
        container.appendChild(loadingEl);
        container.scrollTop = container.scrollHeight;

        // 3. 调用 IMA API
        try {
            // [统一提示词] 每次发送前实时获取后台最新的统一 system_prompt
            //（提示词对前端用户完全隐藏：只作为请求体参数传递，不渲染、不存储）
            const systemPrompt = await this._getSystemPrompt();

            // [多窗口会话] 读取本窗口该好友的对话历史作为 AI 上下文
            const history = WindowSession.getHistory(this.currentSessionId);

            const reply = await this._callIMA(text, { history, system_prompt: systemPrompt });
            container.removeChild(loadingEl);

            // [v20260805] 配额受限：_callIMA 已按 reason 分层提示，直接结束本次发送
            if (reply === '__QUOTA__') {
                this._setInputBusy(false);
                return;
            }

            // [v20260810 掉线直连] LLM 服务不可用：后端不再本地拼装糊弄，
            // 统一返回"掉线了"——不落库不渲染为消息，只提示稍后再试
            if (reply === '掉线了') {
                Utils.toast('军师掉线了，稍后再试');
                this._setInputBusy(false);
                return;
            }

            if (reply) {
                // [收到回复振动提醒] 模式振动，区别于 friends.js 长按的 15ms 短震
                if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

                // 添加回复消息
                const assistantMsg = await DB.addMessage(this.currentSessionId, 'assistant', reply);
                if (assistantMsg) {
                    // [v196 思考链] 挂到消息对象（内存态，不落库；复制按钮仍只复制 content）
                    assistantMsg.reasoning = this.lastReasoning || null;
                    this.messages.push(assistantMsg);
                    this.renderMessages();
                }

                // [多窗口会话] 将助手回复追加到本窗口（该好友）的对话历史
                //   [v184] 携带 created_at（保持与用户消息一致的时间戳格式）
                const aiCreatedAt = (assistantMsg && assistantMsg.created_at) || new Date().toISOString();
                WindowSession.append(this.currentSessionId, 'assistant', reply, aiCreatedAt);

                // [v20260805] 配额已在服务端原子扣次，移除本地计数

                // 更新会话时间
                await DB.updateSessionTime(this.currentSessionId);
            } else {
                Utils.toast('获取回复失败，请重试');
            }
        } catch (e) {
            container.removeChild(loadingEl);
            Utils.toast('网络错误，请稍后重试');
            console.error('[军师] IMA API 调用失败:', e);
        }

        // [v83] 请求结束，恢复输入区按钮（发送/粘贴/换话题）
        this._setInputBusy(false);
        // 不再自动聚焦输入框：AI 回复后自动聚焦会弹出手机输入法，
        // 打断用户阅读回复；需要输入时用户自行点击输入框即可
        //（input.focus() 已移除）
    },

    // [粘贴并发送] 读取剪贴板 → 填入输入框 → 自动发送（无需再点发送）
    async paste() {
        if (!this.currentSessionId) {
            Utils.toast('请先进入一个好友会话');
            return;
        }
        // [v83] 已有请求进行中（按钮已禁用变灰）：忽略重复点击
        const pasteBtn = document.getElementById('chat-paste-btn');
        if (pasteBtn && pasteBtn.disabled) return;
        try {
            const text = await navigator.clipboard.readText();
            if (!text || !text.trim()) {
                Utils.toast('剪贴板为空');
                return;
            }
            const input = document.getElementById('chat-input');
            input.value = text;
            // 自动调整高度
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 100) + 'px';
            // 自动发送
            await this.send();
        } catch (e) {
            console.error('[军师] 读取剪贴板失败:', e);
            Utils.toast('无法读取剪贴板，请手动粘贴');
        }
    },

    // [v62 一键换话题] 军师聊偏/答非所问时，用户点按钮强制换新话题：
    //   不发 user 消息、不污染对话，直接让军师抛一句新话题开场
    async switchTopic() {
        if (!this.currentSessionId) {
            Utils.toast('请先进入一个好友会话');
            return;
        }
        if (!await this._checkCanUse()) {
            return;
        }
        // [v83] 锁定输入区全部按钮（换话题按钮变灰不可再按），结束后恢复
        this._setInputBusy(true);

        // 显示加载中
        const container = document.getElementById('chat-messages');
        const loadingEl = document.createElement('div');
        loadingEl.className = 'loading-dots';
        loadingEl.id = 'loading-dots';
        loadingEl.innerHTML = '<span></span><span></span><span></span> 想个新话题...';
        container.appendChild(loadingEl);
        container.scrollTop = container.scrollHeight;

        try {
            const systemPrompt = await this._getSystemPrompt();
            const history = WindowSession.getHistory(this.currentSessionId);
            // query 用 "/换话题" 指令（后端识别 → 注入【切换话题】），不落库为 user 消息
            const reply = await this._callIMA('/换话题', { history, system_prompt: systemPrompt });
            if (loadingEl.parentNode) container.removeChild(loadingEl);

            if (reply === '__QUOTA__') {
                return;
            }
            if (reply && reply !== '掉线了') {
                // 作为 assistant 建议落库 + 渲染（用户复制发给对方）
                const assistantMsg = await DB.addMessage(this.currentSessionId, 'assistant', reply);
                if (assistantMsg) {
                    this.messages.push(assistantMsg);
                    this.renderMessages();
                }
                // [v184] 携带 created_at（与用户消息时间戳格式一致）
                const swCreatedAt = (assistantMsg && assistantMsg.created_at) || new Date().toISOString();
                WindowSession.append(this.currentSessionId, 'assistant', reply, swCreatedAt);
                await DB.updateSessionTime(this.currentSessionId);
            } else {
                Utils.toast(reply === '掉线了' ? '军师掉线了，稍后再试' : '换话题失败，请重试');
            }
        } catch (e) {
            if (loadingEl.parentNode) container.removeChild(loadingEl);
            Utils.toast('网络错误，请稍后重试');
            console.error('[军师] 换话题失败:', e);
        } finally {
            // [v83] 请求结束（成功/失败/配额受限），恢复输入区按钮
            this._setInputBusy(false);
        }
    },

    // [v20260809 重生] 对不满意的回复重新生成：
    //   以该条回复之前最近一条用户消息为输入，用"去掉旧回复后的窗口历史"重新调用军师；
    //   成功后覆盖旧回复（数据库 + 内存 + 窗口历史 + 界面），不新增消息、不污染对话。
    async regenMessage(btn) {
        const msgId = btn.dataset.msgId;
        if (!msgId || !this.currentSessionId) return;

        // 找到该条 assistant 消息及其前的用户消息（重生输入）
        const idx = this.messages.findIndex(m => String(m.id) === String(msgId));
        if (idx < 0 || this.messages[idx].role !== 'assistant') return;
        const oldMsg = this.messages[idx];
        let userIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
            if (this.messages[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx < 0) {
            Utils.toast('没有可重生的对话');
            return;
        }
        if (!await this._checkCanUse()) return;

        // [v83 防连点] 锁输入区按钮 + 重生按钮变灰，防止重复点击并发请求
        this._setInputBusy(true);
        btn.disabled = true;
        const oldText = btn.innerHTML;
        btn.innerHTML = '⏳ 重生中...';

        try {
            const systemPrompt = await this._getSystemPrompt();
            // 窗口历史：从后往前找旧回复（内容匹配），去掉它及之后的内容作为重生上下文，
            // 让军师基于"用户消息 + 之前的历史"重新作答
            const history = WindowSession.getHistory(this.currentSessionId);
            let hIdx = -1;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === 'assistant' && history[i].content === oldMsg.content) { hIdx = i; break; }
            }
            const ctxHistory = hIdx > 0
                ? history.slice(0, hIdx)
                : history.filter(x => !(x.role === 'assistant' && x.content === oldMsg.content));

            const reply = await this._callIMA(this.messages[userIdx].content, {
                history: ctxHistory,
                system_prompt: systemPrompt
            });

            // [v20260805] 配额受限：_callIMA 已按 reason 分层提示，直接结束
            if (reply === '__QUOTA__') return;

            if (reply && reply !== '掉线了') {
                // 1) 数据库覆盖旧回复
                // [v20260810] 必须校验写入结果：若 UPDATE 被 RLS 拦截/失败而界面继续更新，
                // 会造成"界面是新内容、数据库是旧内容"，切走再回来（页面重载）就回退旧回复。
                // 写入失败立即回滚，不更新内存/历史/界面。
                const updated = await DB.updateMessage(msgId, reply);
                if (!updated) {
                    Utils.toast('保存失败，请重试');
                    console.error('[军师] 重生：数据库更新失败，已回滚（界面保持旧回复）');
                    return;
                }
                // 2) 内存替换
                oldMsg.content = reply;
                // [v196 思考链] 重生后同步更新思考链（内存态）
                oldMsg.reasoning = this.lastReasoning || null;
                // 3) 窗口历史：重生上下文 + 新回复（保持后续对话连贯）
                const nextHistory = ctxHistory.slice();
                nextHistory.push({ role: 'assistant', content: reply });
                WindowSession.setHistory(this.currentSessionId, nextHistory);
                // 4) 刷新界面 + 提醒
                this.renderMessages();
                if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
                Utils.toast('已重新生成');
                await DB.updateSessionTime(this.currentSessionId);
            } else {
                Utils.toast(reply === '掉线了' ? '军师掉线了，稍后再试' : '重生失败，请重试');
            }
        } catch (e) {
            Utils.toast('网络错误，请稍后重试');
            console.error('[军师] 重生失败:', e);
        } finally {
            // 成功路径 renderMessages 已重建按钮，此恢复对旧引用无害；失败/配额路径真正恢复
            btn.disabled = false;
            btn.innerHTML = oldText;
            this._setInputBusy(false);
        }
    },

    // 返回好友列表
    // [系统返回手势] 统一走浏览器后退：按钮点击和手机左边缘右滑都触发 popstate，
    // 由 App 的 popstate 监听切回好友列表；历史栈无可退时直接切换
    back() {
        // 回到好友列表：清除"最后查看"记录，下次启动默认进好友页
        WindowSession.saveLastView('friends');
        if (history.state && history.state.page === 'chat') {
            history.back();
        } else {
            Friends.load();
            App.navigate('friends');
        }
    },

    // [v20260805 用户机制重构] 检查是否可调用 API
    async _checkCanUse() {
        if (!Auth.currentUser) {
            Utils.toast('初始化中，请稍候');
            return false;
        }
        if (Auth.isAccount && Auth.account) {
            // 账号模式：无需设备注册（配额按账号扣次）
            return true;
        }
        if (!Auth.device || !Auth.device.device_id) {
            // 游客模式：设备未注册（异常兜底）重新走注册流程
            const ok = await Auth._registerDevice();
            if (!ok) {
                Utils.toast('设备注册失败，请稍后再试');
                return false;
            }
        }
        return true;
    },

    // [v20260805] 受限分层提示（不暴露真实阈值）
    //   guest_quota_exhausted → 游客 20 条用完 → 弹注册引导
    //   quota_exhausted       → 注册用户用完 → 弹付费墙（月卡/邀请）
    //   session_expired       → 账号已在其他设备登录 → 登出回游客
    //   vip_daily_limit       → VIP 当日满 500 → 服务过载
    //   ip_limit / ip_new_device_limit → IP 防刷 → 使用太频繁
    async _handleQuotaBlock(err) {
        const reason = err && err.error;
        const message = (err && err.message) || '';
        if (reason === 'guest_quota_exhausted') {
            // 游客用完：弹注册引导（注册后额度提升到 50/天）
            Utils.toast('今日免费次数已用完，注册登录继续畅聊');
            App.showRegisterModal();
        } else if (reason === 'quota_exhausted') {
            Paywall.show();
        } else if (reason === 'session_expired' || reason === 'account_required') {
            Utils.toast(message || '账号已在其他设备登录');
            if (Auth.isAccount) {
                await Auth.logout();
                await Friends.load();
                App.navigate('friends');
            }
        } else if (reason === 'vip_daily_limit') {
            Utils.toast('服务过载，请明天再试');
        } else if (reason === 'account_frozen') {
            // [v20260810] 管理员冻结：提示后退出登录（账号已无法使用）
            Utils.toast(message || '账号已被冻结，请联系管理员');
            if (Auth.isAccount) {
                await Auth.logout();
                await Friends.load();
                App.navigate('friends');
            }
        } else if (reason === 'device_frozen') {
            // [v20260810] 管理员封禁设备（游客身份）：提示后退出登录
            Utils.toast(message || '设备已被封禁，请联系管理员');
            if (!Auth.isAccount) {
                await Auth.logout();
                await Friends.load();
                App.navigate('friends');
            }
        } else if (reason === 'ip_limit' || reason === 'ip_new_device_limit') {
            Utils.toast('使用太频繁，请稍后再试');
        } else if (reason === 'device_not_found') {
            Utils.toast('设备未注册，正在重试');
            const ok = await Auth._registerDevice().catch(() => false);
            if (!ok) {
                Utils.toast('设备注册失败，请稍后再试');
            }
        } else {
            Utils.toast(message || '网络错误，请稍后重试');
        }
    },

    // 调用知识库代理（本地 kb_blocks 块级检索）
    // [多窗口会话] opts.history：本窗口的对话历史数组（[{role, content}]）
    // [统一提示词] opts.system_prompt：后台统一管理的系统提示词（用户不可见）
    async _callIMA(query, opts = {}) {
        const config = window.APP_CONFIG?.kb;
        if (!config || !config.proxyUrl) {
            // [v20260802] 未接入 AI（配置缺失）：直接提示掉线，不再返回模拟回复
            return '掉线了';
        }

        try {
            const body = {
                query: query,
                // [vB] 知识库已完全本地化（kb_blocks），不再传 knowledge_base_id
                // [v6 记忆卡] 会话 ID：后端据此读写该好友的对方画像记忆卡（跨窗口共享）
                session_id: this.currentSessionId
            };
            // 附带窗口对话历史（若存在）
            if (opts.history && opts.history.length > 0) {
                body.history = opts.history;
            }
            // 附带后台统一提示词（若获取成功）
            if (opts.system_prompt) {
                body.system_prompt = opts.system_prompt;
            }

            const response = await fetch(config.proxyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (await this._getSessionToken()),
                    // [v20260805 用户机制重构] 身份头：
                    //   账号模式 → X-Identity-Type: account + X-Session-Id（单点校验，按账号扣次）
                    //   游客模式 → X-Device-Id（按设备扣次 20/天）
                    ...(Auth.isAccount && Auth.account
                        ? { 'X-Identity-Type': 'account', 'X-Session-Id': Auth.account.session_id || '' }
                        : { 'X-Device-Id': Auth.device ? Auth.device.device_id : '' })
                },
                body: JSON.stringify(body)
            });

            // [v20260805] 配额受限（403）/ 会话失效（401，账号被踢）：分层提示，不把提示当回复发出
            if (response.status === 403 || response.status === 401) {
                const err = await response.json().catch(() => ({}));
                this._handleQuotaBlock(err);
                return '__QUOTA__';
            }

            if (!response.ok) {
                const errText = await response.text();
                console.error('[军师] IMA API 响应错误:', response.status, errText);
                throw new Error('API 返回 ' + response.status);
            }

            const data = await response.json();
            // [v20260805] 保存 _debug 供阶段提示渲染（后端零成本白送字段，非 LLM 内容）
            this.lastDebug = (data && typeof data === 'object' && data._debug) ? data._debug : null;
            // [v196 思考链展示] 保存 LLM 思考链（仅本窗口内存态，刷新后不显示；不落库）
            this.lastReasoning = (this.lastDebug && typeof this.lastDebug.llm_reasoning === 'string' && this.lastDebug.llm_reasoning.trim())
                ? this.lastDebug.llm_reasoning.trim()
                : null;
            if (this.lastDebug) {
                // [v182] 阶段升级提示：按正常顺序前进时 toast（回退/无阶段不提示）
                const ns = this.lastDebug.memory_stage;
                if (ns && ns !== '' && this._prevStage && ns !== this._prevStage) {
                    const ORDER = ['吸引', '舒适', '恋爱'];
                    const a = ORDER.indexOf(this._prevStage);
                    const b = ORDER.indexOf(ns);
                    if (a > -1 && b > -1 && b > a) {
                        Utils.toast('军师判断：关系进入「' + ns + '」阶段 🎉');
                    }
                }
                this._prevStage = ns || this._prevStage;
            }
            return data.reply || data.answer || data.response || JSON.stringify(data);
        } catch (e) {
            console.error('[军师] IMA API 调用失败，提示掉线:', e);
            // [v20260802] API 调用失败/未接入 AI：直接回复"掉线了"，不再返回模拟回复
            return '掉线了';
        }
    },

    // [统一提示词] 从后台获取当前统一的 system_prompt
    // 每次发送消息时实时调用，保证管理员修改后立即对所有用户生效。
    // 失败时返回空字符串（不阻塞对话，保持原有功能可用）。
    async _getSystemPrompt() {
        const config = window.APP_CONFIG?.prompt;
        if (!config || !config.getUrl) return '';

        try {
            const response = await fetch(config.getUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (await this._getSessionToken())
                },
                body: '{}'
            });
            if (!response.ok) {
                console.warn('[军师] 获取统一提示词失败:', response.status);
                return '';
            }
            const data = await response.json();
            return data.system_prompt || '';
        } catch (e) {
            console.warn('[军师] 获取统一提示词异常（降级为空提示词）:', e);
            return '';
        }
    },

    async _getSessionToken() {
        const sb = getSupabaseClient();
        if (!sb) return '';
        const { data: { session } } = await sb.auth.getSession();
        return session?.access_token || '';
    },

    // [v20260818 自动取名] 从首条消息截取头部"第一组字词"作为好友昵称：
    //   取开头连续无标点/空白的片段（第一组词），≤12 字防撑爆列表；整条太短用整条
    _extractFriendName(text) {
        const t = (text || '').trim();
        if (!t) return '新对话';
        const m = t.match(/^[^，。！？、；：,.!?;: \n\r\t]+/);
        let name = m ? m[0].trim() : '';
        if (!name) {
            // 开头就是标点/空白（异常）：直接取前 6 字兜底
            name = t.slice(0, 6);
        }
        return name.length > 12 ? name.slice(0, 12) : name;
    },

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, '<br>');
    },

    _escapeAttr(text) {
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
};
