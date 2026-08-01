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
        return true;
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
            const time = new Date(m.created_at).toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit'
            });
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

        // 滚动到底部
        container.scrollTop = container.scrollHeight;
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

            if (reply) {
                // 添加回复消息
                const assistantMsg = await DB.addMessage(this.currentSessionId, 'assistant', reply);
                if (assistantMsg) {
                    this.messages.push(assistantMsg);
                    this.renderMessages();
                }

                // [多窗口会话] 将助手回复追加到本窗口（该好友）的对话历史
                WindowSession.append(this.currentSessionId, 'assistant', reply);

                // 记录使用次数
                await this._incrementUsage();

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

    // 检查是否可调用 API
    async _checkCanUse() {
        const profile = Auth.currentProfile;
        if (!profile) {
            Utils.toast('请先登录');
            return false;
        }

        // VIP 用户无限使用
        if (profile.is_vip) {
            // 检查是否过期
            if (profile.vip_expires_at && new Date(profile.vip_expires_at) < new Date()) {
                // VIP 过期了
                await DB.updateProfile(Auth.currentUser.id, { is_vip: false, vip_expires_at: null });
                Auth.currentProfile.is_vip = false;
                Auth.currentProfile.vip_expires_at = null;
                // 继续走免费次数判断
            } else {
                return true;
            }
        }

        const freeTries = window.APP_CONFIG?.product?.freeTries || 50;
        if ((profile.usage_count || 0) >= freeTries) {
            Paywall.show();
            return false;
        }

        return true;
    },

    // 增加使用次数
    async _incrementUsage() {
        if (!Auth.currentUser || !Auth.currentProfile) return;

        // 非 VIP 才计数
        if (Auth.currentProfile.is_vip) return;

        const newCount = (Auth.currentProfile.usage_count || 0) + 1;
        const updated = await DB.updateProfile(Auth.currentUser.id, { usage_count: newCount });
        if (updated) {
            Auth.currentProfile.usage_count = newCount;
        }
    },

    // 调用 IMA API
    // [多窗口会话] opts.history：本窗口的对话历史数组（[{role, content}]）
    // [统一提示词] opts.system_prompt：后台统一管理的系统提示词（用户不可见）
    async _callIMA(query, opts = {}) {
        const config = window.APP_CONFIG?.ima;
        if (!config || !config.proxyUrl) {
            // 降级：返回模拟回复（开发调试用）
            return this._mockReply(query);
        }

        try {
            const body = {
                query: query,
                knowledge_base_id: config.knowledgeBaseId,
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
                    'Authorization': 'Bearer ' + (await this._getSessionToken())
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('[军师] IMA API 响应错误:', response.status, errText);
                throw new Error('API 返回 ' + response.status);
            }

            const data = await response.json();
            return data.reply || data.answer || data.response || JSON.stringify(data);
        } catch (e) {
            console.error('[军师] IMA API 调用失败，使用降级回复:', e);
            return this._mockReply(query);
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

    // 模拟回复（开发调试 / API 不可用时降级）
    _mockReply(query) {
        const replies = [
            `关于"${query}"，我建议你可以这样回：\n\n"哈哈，你说得对，我也有同感。不过换个角度想想，也许对方并不是那个意思呢？"\n\n然后顺势问问对方最近有什么新鲜事，把话题带向更轻松的方向。`,
            `针对"${query}"的情况，建议回复：\n\n"嗯嗯，我明白你的想法。其实我最近也在思考类似的问题，有机会我们可以深入聊聊~"\n\n这样的回应既表达了理解，又为后续对话埋下了伏笔。`,
            `你的聊天对象说了"${query}"，你可以考虑这样回应：\n\n"哈哈哈，你这么说让我想起一件事…（分享一个相关的有趣经历）"\n\n用故事回应故事，能让对话更有温度。`,
            `建议回复：\n\n"你说的这个角度很有意思，我之前都没想过。那你觉得……（追问一个开放性问题）"\n\n展示好奇心和对对方观点的认可能有效拉近距离。`,
            `关于"${query}"，我的建议：\n\n先表示理解："我懂你的感受"\n然后表达自己的看法："不过我觉得……（你的真实想法）"\n最后抛出问题："你觉得呢？"\n\n三步法：共情→表达→邀请对话，是最自然的聊天节奏。`
        ];
        return replies[Math.floor(Math.random() * replies.length)];
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
