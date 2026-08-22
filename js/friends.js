// ============================================================
// 军师 - 好友列表模块
// ============================================================

const Friends = {
    sessions: [],
    // [长按管理] 当前选中的 session（Action Sheet 用）
    _currentSession: null,
    // [批量删除] 多选模式状态
    _batchMode: false,
    _selectedIds: new Set(),

    async load() {
        if (!Auth.currentUser) return;
        // [批量删除] 列表刷新时兜底退出多选模式（登录态切换等场景防残留）
        if (this._batchMode) {
            this._batchMode = false;
            this._selectedIds = new Set();
            const bar = document.getElementById('batch-bar');
            if (bar) bar.style.display = 'none';
            const fab = document.getElementById('fab-add-friend');
            if (fab) fab.style.display = '';
        }
        // [v20260805] 刷新配额状态：账号模式刷新账号状态；游客模式刷新设备状态
        if (Auth.isAccount && typeof Auth.refreshAccountStatus === 'function') {
            await Auth.refreshAccountStatus();
        } else if (typeof Auth.refreshStatus === 'function') {
            await Auth.refreshStatus();
        }
        this.sessions = await DB.getSessions(Auth.currentUser.id);
        this.render();
    },

    render() {
        const container = document.getElementById('friends-list');
        const headerStatus = document.getElementById('header-status');

        // [v20260805] 顶部导航：账号模式显示 VIP 剩余天数/邀请赠送次数；
        // 游客不显示任何额度（登入按钮引导注册）
        if (headerStatus) {
            if (Auth.isAccount && Auth.account) {
                const acc = Auth.account;
                if (acc.is_vip) {
                    const days = acc.vip_days_left || 0;
                    // [v20260805] 浓缩为 VIP+天数（去 👑 图标，避免撑宽顶栏挤压其他按钮；保留金色底色）
                    headerStatus.textContent = 'VIP' + days + '天';
                    headerStatus.style.background = 'rgba(255, 215, 0, 0.25)';
                    headerStatus.style.display = '';
                } else if ((acc.invite_bonus || 0) > 0) {
                    headerStatus.textContent = '邀请赠送 ' + acc.invite_bonus + ' 次';
                    headerStatus.style.background = 'rgba(255,255,255,0.2)';
                    headerStatus.style.display = '';
                } else {
                    headerStatus.style.display = 'none';
                }
            } else {
                headerStatus.style.display = 'none';
            }
        }
        // 登入/退出按钮状态
        if (typeof Auth._updateAuthButton === 'function') {
            Auth._updateAuthButton();
        }

        if (!this.sessions || this.sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💬</div>
                    <p>还没有好友<br>点击右下角 "+" 按钮添加吧</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.sessions.map(s => {
            const initial = s.friend_name ? s.friend_name.charAt(0).toUpperCase() : '?';
            const timeAgo = this._timeAgo(s.updated_at || s.created_at);
            // [v83] 年龄/地区标签：话题"年龄""住哪"聊出结果时提取的具体值，显示在备注前
            let ageHtml = '';
            let regionHtml = '';
            try {
                const mc = s.memory_card
                    ? (typeof s.memory_card === 'string' ? JSON.parse(s.memory_card) : s.memory_card)
                    : null;
                if (mc && mc.profile) {
                    if (mc.profile.age) {
                        ageHtml = `<span class="friend-tag friend-tag-age">${this._escapeHtml(mc.profile.age)}</span>`;
                    }
                    if (mc.profile.region) {
                        regionHtml = `<span class="friend-tag friend-tag-region">${this._escapeHtml(mc.profile.region)}</span>`;
                    }
                }
            } catch (e) {}
            const noteHtml = s.note
                ? `<span class="friend-note" title="${this._escapeHtml(s.note)}">${this._escapeHtml(s.note)}</span>`
                : '';
            // [v20260805] A方案：头像底色随关系阶段变色（陌生保持原 avatar_color）
            const st = this._stageInfo(s);
            const avatarBg = st ? st.color : (s.avatar_color || '#07C160');
            const avatarTitle = st ? ` title="关系阶段：${this._escapeHtml(st.stage)}"` : '';
            // [批量删除] 多选模式：左侧选择圈 + 选中态
            const batchChecked = this._batchMode && this._selectedIds.has(s.id);
            return `
                <div class="friend-item ${this._batchMode ? 'batch-mode' : ''} ${batchChecked ? 'checked' : ''}" data-session-id="${s.id}">
                    ${this._batchMode ? `<div class="batch-check${batchChecked ? ' checked' : ''}"></div>` : ''}
                    <div class="friend-avatar" style="background: ${avatarBg}"${avatarTitle}>
                        ${initial}
                    </div>
                    <div class="friend-info">
                        <div class="friend-name">${this._escapeHtml(s.friend_name)}${ageHtml}${regionHtml}${noteHtml}</div>
                        <div class="friend-preview">${s.last_message || '点击开始对话'}</div>
                    </div>
                    <div class="friend-time">${timeAgo}</div>
                </div>
            `;
        }).join('');

        // 点击进入聊天 / 批量模式下切换选中
        container.querySelectorAll('.friend-item').forEach(el => {
            const sessionId = el.dataset.sessionId;
            el.addEventListener('click', () => {
                if (this._batchMode) {
                    this.toggleSelect(sessionId);
                    return;
                }
                Chat.open(sessionId);
            });

            // [批量删除] 多选模式下不做长按菜单
            if (this._batchMode) return;

            // [长按管理] 桌面端用 mousedown 计时，移动端用 touchstart
            let longPressTimer = null;
            let longPressed = false;
            const startPress = () => {
                longPressed = false;
                longPressTimer = setTimeout(() => {
                    longPressed = true;
                    this._showActionSheet(sessionId);
                    // 触觉反馈（支持的设备）
                    if (navigator.vibrate) navigator.vibrate(15);
                }, 600);
            };
            const cancelPress = () => {
                clearTimeout(longPressTimer);
            };
            const endPress = (e) => {
                clearTimeout(longPressTimer);
                // 如果触发了长按，阻止 click 进入聊天
                if (longPressed) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            };

            el.addEventListener('touchstart', startPress, { passive: true });
            el.addEventListener('touchend', endPress);
            el.addEventListener('touchmove', cancelPress);
            el.addEventListener('mousedown', startPress);
            el.addEventListener('mouseup', endPress);
            el.addEventListener('mouseleave', cancelPress);
        });
    },

    // [批量删除] 进入多选模式（长按菜单"批量删除"入口）
    enterBatchMode() {
        if (!this.sessions || this.sessions.length === 0) {
            Utils.toast('暂无好友可管理');
            return;
        }
        this._batchMode = true;
        this._selectedIds = new Set();
        const bar = document.getElementById('batch-bar');
        if (bar) bar.style.display = '';
        const fab = document.getElementById('fab-add-friend');
        if (fab) fab.style.display = 'none';
        this._updateBatchCount();
        this.render();
    },

    // [批量删除] 退出多选模式
    exitBatchMode() {
        this._batchMode = false;
        this._selectedIds = new Set();
        const bar = document.getElementById('batch-bar');
        if (bar) bar.style.display = 'none';
        const fab = document.getElementById('fab-add-friend');
        if (fab) fab.style.display = '';
        this.render();
    },

    // [批量删除] 切换单项选中
    toggleSelect(sessionId) {
        if (!this._batchMode) return;
        if (this._selectedIds.has(sessionId)) {
            this._selectedIds.delete(sessionId);
        } else {
            this._selectedIds.add(sessionId);
        }
        const el = document.querySelector(`.friend-item[data-session-id="${sessionId}"]`);
        if (el) {
            el.classList.toggle('checked', this._selectedIds.has(sessionId));
            const chk = el.querySelector('.batch-check');
            if (chk) chk.classList.toggle('checked', this._selectedIds.has(sessionId));
        }
        this._updateBatchCount();
    },

    // [批量删除] 全选 / 取消全选
    toggleSelectAll() {
        if (this._selectedIds.size === this.sessions.length) {
            this._selectedIds.clear();
        } else {
            this.sessions.forEach(s => this._selectedIds.add(s.id));
        }
        this._updateBatchCount();
        this.render();
    },

    // [批量删除] 更新底部操作栏计数与全选文字
    _updateBatchCount() {
        const n = this._selectedIds.size;
        const countEl = document.getElementById('batch-del-count');
        if (countEl) countEl.textContent = '(' + n + ')';
        const allBtn = document.getElementById('batch-select-all');
        if (allBtn) allBtn.textContent = n === this.sessions.length ? '取消全选' : '全选';
    },

    // [批量删除] 确认并批量删除
    async confirmBatchDelete() {
        const n = this._selectedIds.size;
        if (n === 0) {
            Utils.toast('请先选择要删除的好友');
            return;
        }
        if (!confirm(`确定删除选中的 ${n} 个好友及所有聊天记录？此操作不可恢复`)) return;
        const ids = [...this._selectedIds];
        Utils.showLoading();
        const ok = await DB.deleteSessions(ids);
        Utils.hideLoading();
        if (ok) {
            // 清理窗口历史缓存，防止残留
            ids.forEach(id => {
                try { WindowSession.removeFriend(id); } catch (e) {}
            });
            Utils.toast('已删除 ' + n + ' 个好友');
            this.exitBatchMode();
            await this.load();
        } else {
            Utils.toast('删除失败，请重试');
        }
    },

    // [v20260818 直接进聊天] 新建会话：不再弹输入昵称框，
    // 直接创建占位会话并进入聊天页；首条消息发出时自动截取头部字词作为昵称（chat.js 处理）
    async createNew() {
        if (!Auth.currentUser) {
            Utils.toast('请先登录');
            return;
        }
        Utils.showLoading();
        try {
            const session = await DB.createSession(Auth.currentUser.id, '新对话');
            if (session) {
                Utils.hideLoading();
                // 直接进入聊天页（首条消息自动取名逻辑见 Chat.send）
                await Chat.open(session.id);
                await this.load();
            } else {
                Utils.hideLoading();
                Utils.toast('创建失败，请重试');
            }
        } catch (e) {
            Utils.hideLoading();
            console.error('[军师] 创建会话失败:', e);
            Utils.toast('创建失败，请重试');
        }
    },

    // 新建好友
    showCreateModal() {
        const overlay = document.getElementById('modal-new-friend');
        const input = document.getElementById('new-friend-input');
        const confirmBtn = document.getElementById('new-friend-confirm');
        const cancelBtn = document.getElementById('new-friend-cancel');

        input.value = '';
        overlay.classList.add('active');
        setTimeout(() => input.focus(), 100);

        const closeModal = () => overlay.classList.remove('active');

        confirmBtn.onclick = async () => {
            const name = input.value.trim();
            if (!name) {
                Utils.toast('请输入好友昵称');
                return;
            }

            // 检查登录状态
            if (!Auth.currentUser) {
                Utils.toast('请先登录');
                return;
            }

            closeModal();
            Utils.showLoading();

            try {
                const session = await DB.createSession(Auth.currentUser.id, name);
                if (session) {
                    // [v20260805 用户机制重构] 邀请改在注册时兑现（register_account），
                    // 不再"首次新建好友"触发；此处仅提示添加成功
                    Utils.toast('已添加 ' + name);
                    await this.load();
                } else {
                    Utils.toast('添加失败，请重试');
                }
            } catch (e) {
                console.error('[军师] 创建好友失败:', e);
                Utils.toast('添加失败，请重试');
            } finally {
                Utils.hideLoading();
            }
        };

        cancelBtn.onclick = closeModal;
        overlay.onclick = (e) => {
            if (e.target === overlay) closeModal();
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') confirmBtn.click();
        };
    },

    // [长按管理] 弹出底部 Action Sheet
    _showActionSheet(sessionId) {
        const session = this.sessions.find(s => s.id === sessionId);
        if (!session) return;

        this._currentSession = session;
        const overlay = document.getElementById('action-sheet');
        const nameEl = document.getElementById('sheet-friend-name');
        nameEl.textContent = session.friend_name + (session.note ? ' · ' + session.note : '');
        // [v20260805] 显示当前关系阶段
        const st = this._stageInfo(session);
        const stageEl = document.getElementById('sheet-stage-current');
        if (st) {
            stageEl.textContent = st.stage;
            stageEl.style.color = st.color;
        } else {
            stageEl.textContent = '';
        }
        overlay.classList.add('active');
    },

    // [长按管理] 关闭 Action Sheet
    _hideActionSheet() {
        document.getElementById('action-sheet').classList.remove('active');
        this._currentSession = null;
    },

    // [长按管理] Action Sheet 按钮分发
    handleSheetAction(action) {
        const session = this._currentSession;
        if (!session) return;

        switch (action) {
            case 'rename':
                this._hideActionSheet();
                setTimeout(() => this.showEditModal(session), 200);
                break;
            case 'stage':
                this._hideActionSheet();
                setTimeout(() => this.showStageModal(session), 200);
                break;
            case 'delete':
                this._hideActionSheet();
                setTimeout(() => this._confirmDelete(session.id), 200);
                break;
            case 'batch-delete':
                this._hideActionSheet();
                setTimeout(() => this.enterBatchMode(), 200);
                break;
            case 'cancel':
            default:
                this._hideActionSheet();
        }
    },

    // [v20260805] 设置关系阶段弹层（手动标注，覆盖 AI 判断）+ [v58] 关系目标
    showStageModal(session) {
        const overlay = document.getElementById('modal-stage');
        const opts = document.getElementById('stage-options');
        const goalOpts = document.getElementById('goal-options');
        const cancelBtn = document.getElementById('stage-cancel');

        // 当前 stage（三阶段：吸引/舒适/恋爱；无则空）
        const st = this._stageInfo(session);
        let current = st && (st.stage === '吸引' || st.stage === '舒适' || st.stage === '恋爱') ? st.stage : '';

        // 高亮当前 stage
        opts.querySelectorAll('.stage-option').forEach(btn => {
            const val = btn.dataset.stage;
            btn.classList.toggle('selected', val === current);
        });

        // [v58] 高亮当前目标
        const mc = this._parseMemoryCard(session) || {};
        const curGoal = mc.goal || '';
        if (goalOpts) {
            goalOpts.querySelectorAll('.stage-option').forEach(btn => {
                const val = btn.dataset.goal;
                btn.classList.toggle('selected', val === curGoal);
            });
        }

        overlay.classList.add('active');

        const close = () => overlay.classList.remove('active');
        cancelBtn.onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        // 阶段选项点击 → 写回 memory_card
        opts.querySelectorAll('.stage-option').forEach(btn => {
            btn.onclick = async () => {
                close();
                const val = btn.dataset.stage;
                Utils.showLoading();
                const ok = await this._setStage(session, val);
                Utils.hideLoading();
                if (ok) {
                    Utils.toast(val === '__auto__' ? '已设为自动（随对话升级）' : '已固定为「' + val + '」');
                    await this.load();
                } else {
                    Utils.toast('保存失败，请重试');
                }
            };
        });

        // [v58] 目标选项点击 → 写回 memory_card.goal
        if (goalOpts) {
            goalOpts.querySelectorAll('.stage-option').forEach(btn => {
                btn.onclick = async () => {
                    close();
                    const val = btn.dataset.goal;
                    Utils.showLoading();
                    const ok = await this._setGoal(session, val);
                    Utils.hideLoading();
                    if (ok) {
                        Utils.toast(val === '__none__' ? '已设为默认推进' : '目标已设为「' + val + '」');
                        await this.load();
                    } else {
                        Utils.toast('保存失败，请重试');
                    }
                };
            });
        }
    },

    // [v58] 写回关系目标：memory_card.goal（__none__ = 清除）
    async _setGoal(session, goal) {
        const mc = this._parseMemoryCard(session) || { profile: {} };
        if (!mc.profile) mc.profile = {};
        if (goal === '__none__') {
            delete mc.goal;
        } else {
            mc.goal = goal;
        }
        const updated = await DB.updateSession(session.id, {
            memory_card: JSON.stringify(mc)
        });
        return !!updated;
    },

    // [v20260805] 解析 memory_card（text 列 JSON 字符串，兼容已 parse 对象）
    _parseMemoryCard(session) {
        if (!session || !session.memory_card) return null;
        return typeof session.memory_card === 'string'
            ? JSON.parse(session.memory_card)
            : session.memory_card;
    },

    // [v20260805] 写回关系阶段：合并进 memory_card.profile
    //   __auto__ = 恢复 AI 判断（清除 manual 标记）；其他 = 手动标注（stage_source: manual）
    async _setStage(session, stage) {
        const mc = this._parseMemoryCard(session) || { profile: {} };
        if (!mc.profile) mc.profile = {};
        if (stage === '__auto__') {
            if (mc.profile.stage_source === 'manual') {
                delete mc.profile.stage_source;
                // 手动值留给 AI 重新推断（保留现有 stage 但去掉手动锁）
            }
        } else {
            mc.profile.stage = stage;
            mc.profile.stage_source = 'manual';
        }
        const updated = await DB.updateSession(session.id, {
            memory_card: JSON.stringify(mc)
        });
        return !!updated;
    },

    // [长按管理] 编辑好友（改名 + 备注）
    showEditModal(session) {
        const overlay = document.getElementById('modal-edit-friend');
        const nameInput = document.getElementById('edit-friend-name');
        const noteInput = document.getElementById('edit-friend-note');
        const saveBtn = document.getElementById('edit-friend-save');
        const cancelBtn = document.getElementById('edit-friend-cancel');

        nameInput.value = session.friend_name || '';
        noteInput.value = session.note || '';
        overlay.classList.add('active');
        setTimeout(() => nameInput.focus(), 100);

        const closeModal = () => overlay.classList.remove('active');

        const onSave = async () => {
            const name = nameInput.value.trim();
            const note = noteInput.value.trim();

            if (!name) {
                Utils.toast('昵称不能为空');
                nameInput.focus();
                return;
            }
            if (name.length > 20) {
                Utils.toast('昵称不能超过 20 字');
                return;
            }
            if (note.length > 30) {
                Utils.toast('备注不能超过 30 字');
                return;
            }

            // 检查是否实际修改
            if (name === session.friend_name && note === (session.note || '')) {
                closeModal();
                return;
            }

            closeModal();
            Utils.showLoading();

            const updated = await DB.updateSession(session.id, {
                friend_name: name,
                note: note
            });
            Utils.hideLoading();

            if (updated) {
                Utils.toast('已保存');
                await this.load();
            } else {
                Utils.toast('保存失败，请重试');
            }
        };

        saveBtn.onclick = onSave;
        cancelBtn.onclick = closeModal;
        overlay.onclick = (e) => {
            if (e.target === overlay) closeModal();
        };
        // 回车保存
        const onKey = (e) => {
            if (e.key === 'Enter' && e.target === nameInput) {
                e.preventDefault();
                noteInput.focus();
            } else if (e.key === 'Enter' && e.target === noteInput) {
                e.preventDefault();
                onSave();
            }
        };
        nameInput.onkeydown = onKey;
        noteInput.onkeydown = onKey;
    },

    async _confirmDelete(sessionId) {
        if (!confirm('确定删除这个好友及所有聊天记录？')) return;
        const ok = await DB.deleteSession(sessionId);
        if (ok) {
            Utils.toast('已删除');
            await this.load();
        } else {
            Utils.toast('删除失败');
        }
    },

    // [我的简介] 打开编辑弹窗（加载当前简介到文本域）
    showBioModal() {
        const overlay = document.getElementById('modal-bio');
        const input = document.getElementById('bio-input');
        const count = document.getElementById('bio-count');

        // 从当前 profile 加载已有简介
        input.value = (Auth.currentProfile && Auth.currentProfile.bio) || '';
        count.textContent = input.value.length + ' / 300';
        overlay.classList.add('active');
        setTimeout(() => input.focus(), 100);

        // [v209 直连 API] 打开弹窗时同步加载 API Key（仅注册账号）
        this._loadApiKey();
    },

    // [v209 直连 API] 获取/展示 API Key（脚本直连令牌）
    async _loadApiKey() {
        const valueEl = document.getElementById('api-key-value');
        const copyBtn = document.getElementById('api-key-copy');
        const genBtn = document.getElementById('api-key-gen');
        if (!valueEl || !genBtn) return;

        if (!Auth.isAccount || !Auth.account) {
            valueEl.style.display = 'none';
            copyBtn.style.display = 'none';
            genBtn.textContent = '登录账号后可用';
            genBtn.disabled = true;
            return;
        }

        // 绑定事件（只绑一次）
        if (!this._apiKeyBound) {
            this._apiKeyBound = true;
            genBtn.onclick = async () => {
                if (!Auth.isAccount) {
                    Utils.toast('请先登录账号');
                    return;
                }
                const existing = valueEl.textContent.trim();
                if (existing && !confirm('重新生成将令旧 Key 立即失效，确定？')) return;
                await this._fetchApiKey(true);
            };
            copyBtn.onclick = async () => {
                const text = valueEl.textContent.trim();
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                } catch (e) {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                Utils.toast('已复制 API Key');
            };
        }

        await this._fetchApiKey(false);
    },

    async _fetchApiKey(regenerate) {
        const valueEl = document.getElementById('api-key-value');
        const copyBtn = document.getElementById('api-key-copy');
        const genBtn = document.getElementById('api-key-gen');
        if (!valueEl || !genBtn) return;
        try {
            const sb = getSupabaseClient();
            if (!sb) return;
            const { data, error } = await sb.rpc('api_key_mgmt', { p_regenerate: !!regenerate });
            if (error) {
                console.error('[API Key] rpc error:', error.message);
                Utils.toast('获取失败，请重试');
                return;
            }
            if (data && typeof data === 'string' && data.startsWith('jk_')) {
                valueEl.textContent = data;
                valueEl.style.display = '';
                copyBtn.style.display = '';
                genBtn.textContent = '重新生成';
            } else {
                Utils.toast('获取失败，请重试');
            }
        } catch (e) {
            console.error('[API Key] 获取异常:', e);
            Utils.toast('获取失败，请重试');
        }
    },

    // [我的简介] 保存简介（写 profiles.bio，服务端对话时自动注入）
    async saveBio() {
        const overlay = document.getElementById('modal-bio');
        const input = document.getElementById('bio-input');
        const text = input.value.trim();

        if (!Auth.currentUser) {
            Utils.toast('请先登录');
            return;
        }
        if (text.length > 300) {
            Utils.toast('简介不能超过 300 字');
            return;
        }

        Utils.showLoading();
        const updated = await DB.updateProfile(Auth.currentUser.id, { bio: text });
        Utils.hideLoading();

        if (updated) {
            // 同步内存中的 profile，后续发送消息时由 ima-proxy 服务端读取注入
            Auth.currentProfile.bio = text;
            overlay.classList.remove('active');
            Utils.toast(text ? '简介已保存，对话会自动引用' : '已清空简介');
        } else {
            Utils.toast('保存失败，请重试');
        }
    },

    _timeAgo(dateStr) {
        if (!dateStr) return '';
        const now = Date.now();
        const date = new Date(dateStr).getTime();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        if (minutes < 1) return '刚刚';
        if (minutes < 60) return minutes + '分钟前';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + '小时前';
        const days = Math.floor(hours / 24);
        if (days < 7) return days + '天前';
        return new Date(dateStr).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    },

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // [v182 三阶段统一] 关系阶段 → 头像底色（吸引蓝/舒适黄/恋爱红）
    //   [v190] 舒适 #993556(粉) → #C9971C(黄)：用户指定
    _STAGE_COLORS: {
        '吸引': '#185FA5',
        '舒适': '#C9971C',
        '恋爱': '#A32D2D',
    },
    _DEFAULT_GRAY: '#5F5E5A',
    // [v182] 旧六阶段（陌生/朋友/追求/暧昧/恋爱/挽回）→ 三阶段换算（与后端 normalizeStage 一致）
    _normalizeStage(stage) {
        if (stage === '吸引' || stage === '舒适' || stage === '恋爱') return stage;
        if (stage === '陌生' || stage === '朋友') return '吸引';
        if (stage === '追求' || stage === '挽回') return '舒适';
        if (stage === '暧昧') return '恋爱';
        return '';
    },

    _stageInfo(s) {
        let stage = '';
        let msgCount = 0;
        try {
            if (s && s.memory_card) {
                const mc = typeof s.memory_card === 'string' ? JSON.parse(s.memory_card) : s.memory_card;
                stage = this._normalizeStage((mc && mc.profile && mc.profile.stage) || '');
            }
            // [v182] 消息数（列表查询已带 chat_messages(count) 聚合）
            if (s && Array.isArray(s.chat_messages) && s.chat_messages[0] && typeof s.chat_messages[0].count === 'number') {
                msgCount = s.chat_messages[0].count;
            }
        } catch (e) {
            stage = '';
        }
        // 聊天 ≤5 条 → 灰色（还没到判定阶段）；超过后按阶段上色；无阶段 → 灰兜底
        if (msgCount <= 5 || !stage) {
            return { stage: stage || '', color: this._DEFAULT_GRAY };
        }
        return { stage, color: this._STAGE_COLORS[stage] || this._DEFAULT_GRAY };
    }
};
