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

        // [v20260805] 记忆：缓存 memory_card（记忆按钮弹层用；打开时已有，零额外请求）
        this.memoryCard = session.memory_card || null;
        // [v20260805] 策略徽标：打开会话时从 memory_card 读初始套路状态（已 select *，零额外请求）
        this._updateStrategyBadge(session.memory_card || null);

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
        body.innerHTML = this._renderMemory(this.memoryCard);
    },

    // [v20260805] 渲染记忆面板
    _renderMemory(raw) {
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

        const STAGE_COLORS = { '追求': '#185FA5', '暧昧': '#993556', '恋爱': '#A32D2D', '挽回': '#854F0B', '普通朋友': '#5F5E5A' };
        const stageColor = STAGE_COLORS[p.stage] || '#5F5E5A';
        const stageTag = (p.stage && p.stage !== '未知')
            ? `<span class="memory-tag" style="background:${stageColor}">${this._escapeHtml(p.stage)}</span>`
            : '';

        const sec = (title, dotColor, html) =>
            `<div class="memory-section"><div class="memory-sec-title"><span class="memory-dot" style="background:${dotColor}"></span>${title}</div>${html}</div>`;
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

        // [v20260805b] 去掉"她说过的话/我说过的话"：聊天会话里本来就能看到，不重复展示
        return sec('关系阶段', stageColor, stageTag || '<div class="memory-empty">未知（聊过或手动设置后更新）</div>')
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
                return `
                    <div class="message assistant">
                        <div class="message-content">${this._escapeHtml(m.content)}</div>
                        <div class="message-footer">
                            <button class="message-copy-btn" data-content="${this._escapeAttr(m.content)}">
                                📋 复制
                            </button>
                            <span class="message-time">${time}</span>
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

    // 发送消息
    async send() {
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('chat-send-btn');
        const text = input.value.trim();

        if (!text) return;

        if (!this.currentSessionId) return;

        // 检查是否可调用
        if (!await this._checkCanUse()) {
            return;
        }

        // 禁用按钮
        sendBtn.disabled = true;
        input.value = '';

        // 1. 添加用户消息
        const userMsg = await DB.addMessage(this.currentSessionId, 'user', text);
        if (userMsg) {
            this.messages.push(userMsg);
            this.renderMessages();
        }

        // [多窗口会话] 将用户消息追加到本窗口（该好友）的对话历史
        WindowSession.append(this.currentSessionId, 'user', text);

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
                sendBtn.disabled = false;
                return;
            }

            if (reply) {
                // [收到回复振动提醒] 模式振动，区别于 friends.js 长按的 15ms 短震
                if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

                // 添加回复消息
                const assistantMsg = await DB.addMessage(this.currentSessionId, 'assistant', reply);
                if (assistantMsg) {
                    this.messages.push(assistantMsg);
                    this.renderMessages();
                }

                // [多窗口会话] 将助手回复追加到本窗口（该好友）的对话历史
                WindowSession.append(this.currentSessionId, 'assistant', reply);

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

        sendBtn.disabled = false;
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

    // [v20260805] 检查是否可调用 API：服务端配额引擎为准（原子扣次 + 分层拦截）
    async _checkCanUse() {
        if (!Auth.currentUser) {
            Utils.toast('初始化中，请稍候');
            return false;
        }
        if (!Auth.device || !Auth.device.device_id) {
            // 设备未注册（异常兜底）：重新走注册流程；注册失败必须拦截，
            // 否则拿"服务端不存在的 device_id"调用 ima-proxy 会一直 device_not_found
            const ok = await Auth._registerDevice();
            if (!ok) {
                Utils.toast('设备注册失败，请稍后再试');
                return false;
            }
        }
        return true;
    },

    // [v20260805] 受限分层提示（不暴露真实阈值）
    //   quota_exhausted  → 免费档用完 → 弹付费墙
    //   vip_daily_limit  → VIP 当日满 500 → 服务过载
    //   ip_limit / ip_new_device_limit → IP 防刷 → 使用太频繁
    async _handleQuotaBlock(err) {
        const reason = err && err.error;
        const message = (err && err.message) || '';
        if (reason === 'quota_exhausted') {
            Paywall.show();
        } else if (reason === 'vip_daily_limit') {
            Utils.toast('服务过载，请明天再试');
        } else if (reason === 'ip_limit' || reason === 'ip_new_device_limit') {
            Utils.toast('使用太频繁，请稍后再试');
        } else if (reason === 'device_not_found') {
            // 服务端查不到该设备：尝试重新注册（幂等）；
            // 注册成功则提示重试；失败（如同 IP 新设备防刷）给明确提示，不再无限静默重试
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
                    // [v20260805] 设备指纹：服务端按 device_id 配额扣次/分层拦截
                    'X-Device-Id': Auth.device ? Auth.device.device_id : ''
                },
                body: JSON.stringify(body)
            });

            // [v20260805] 配额受限（403）：按 reason 分层提示，不把提示当回复发出
            if (response.status === 403) {
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
            // [v20260805] 保存 _debug 供策略徽标渲染（后端零成本白送字段，非 LLM 内容）
            this.lastDebug = (data && typeof data === 'object' && data._debug) ? data._debug : null;
            if (this.lastDebug) {
                this._updateStrategyBadge(this.lastDebug);
            }
            return data.reply || data.answer || data.response || JSON.stringify(data);
        } catch (e) {
            console.error('[军师] IMA API 调用失败，提示掉线:', e);
            // [v20260802] API 调用失败/未接入 AI：直接回复"掉线了"，不再返回模拟回复
            return '掉线了';
        }
    },

    // [v20260805] 策略徽标：好友名下方显示当前执行套路/关系阶段（仅用户可见，纯前端 UI）
    // 兼容两种输入：
    //   memory_card 对象（打开会话时）：{ profile:{stage}, strategy:{name,rounds_used,max_rounds} }
    //   _debug 对象（每次回复后）：{ strategy_name, strategy_rounds, strategy_max_rounds, strategy_clear, memory_stage }
    _updateStrategyBadge(src) {
        const el = document.getElementById('chat-strategy');
        if (!el) return;
        try {
            let name = '', rounds = null, max = null, cleared = false, stage = '';
            if (src && src.strategy_name !== undefined) {
                // _debug 形态
                name = src.strategy_name || '';
                rounds = src.strategy_rounds;
                max = src.strategy_max_rounds;
                cleared = !!src.strategy_clear;
                stage = src.memory_stage || '';
            } else if (src && src.strategy) {
                // memory_card 形态
                const st = src.strategy;
                if (st && st.name) {
                    name = st.name;
                    rounds = st.rounds_used;
                    max = st.max_rounds;
                }
                const p = src.profile || {};
                stage = p.stage || '';
            }
            if (cleared || !name) {
                el.classList.remove('show');
                el.innerHTML = '';
                return;
            }
            const stageHtml = (stage && stage !== '未知')
                ? `<span class="cs-stage">${this._escapeHtml(stage)}</span> · `
                : '';
            const prog = (typeof rounds === 'number' && typeof max === 'number')
                ? `（${rounds}/${max}）`
                : (typeof rounds === 'number' ? `（第${rounds}轮）` : '');
            el.innerHTML = stageHtml + '策略「' + this._escapeHtml(name) + '」' + prog;
            el.classList.add('show');
        } catch (e) {
            console.error('[军师] 策略徽标渲染失败:', e);
            el.classList.remove('show');
            el.innerHTML = '';
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

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, '<br>');
    },

    _escapeAttr(text) {
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
};
