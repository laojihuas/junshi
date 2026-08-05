// ============================================================
// 军师 - 好友列表模块
// ============================================================

const Friends = {
    sessions: [],
    // [长按管理] 当前选中的 session（Action Sheet 用）
    _currentSession: null,

    async load() {
        if (!Auth.currentUser) return;
        this.sessions = await DB.getSessions(Auth.currentUser.id);
        this.render();
    },

    render() {
        const container = document.getElementById('friends-list');
        const headerStatus = document.getElementById('header-status');

        // 更新头部状态
        if (Auth.currentProfile) {
            const p = Auth.currentProfile;
            if (p.is_vip) {
                const expires = p.vip_expires_at
                    ? '到期 ' + new Date(p.vip_expires_at).toLocaleDateString()
                    : '永久会员';
                headerStatus.textContent = '👑 VIP · ' + expires;
                headerStatus.style.background = 'rgba(255, 215, 0, 0.25)';
            } else {
                headerStatus.textContent = '免费用户';
                headerStatus.style.background = 'rgba(255,255,255,0.2)';
            }
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
            const noteHtml = s.note
                ? `<span class="friend-note" title="${this._escapeHtml(s.note)}">${this._escapeHtml(s.note)}</span>`
                : '';
            // [v20260805] A方案：头像底色随关系阶段变色（未知保持原 avatar_color）
            const st = this._stageInfo(s);
            const avatarBg = st ? st.color : (s.avatar_color || '#07C160');
            const avatarTitle = st ? ` title="关系阶段：${this._escapeHtml(st.stage)}"` : '';
            return `
                <div class="friend-item" data-session-id="${s.id}">
                    <div class="friend-avatar" style="background: ${avatarBg}"${avatarTitle}>
                        ${initial}
                    </div>
                    <div class="friend-info">
                        <div class="friend-name">${this._escapeHtml(s.friend_name)}${noteHtml}</div>
                        <div class="friend-preview">${s.last_message || '点击开始对话'}</div>
                    </div>
                    <div class="friend-time">${timeAgo}</div>
                </div>
            `;
        }).join('');

        // 点击进入聊天
        container.querySelectorAll('.friend-item').forEach(el => {
            el.addEventListener('click', () => {
                const sessionId = el.dataset.sessionId;
                Chat.open(sessionId);
            });

            // [长按管理] 桌面端用 mousedown 计时，移动端用 touchstart
            let longPressTimer = null;
            let longPressed = false;
            const startPress = () => {
                longPressed = false;
                longPressTimer = setTimeout(() => {
                    longPressed = true;
                    const sessionId = el.dataset.sessionId;
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
            case 'delete':
                this._hideActionSheet();
                setTimeout(() => this._confirmDelete(session.id), 200);
                break;
            case 'cancel':
            default:
                this._hideActionSheet();
        }
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

    // [v20260805] A方案：关系阶段 → 头像底色（追求蓝/暧昧粉/恋爱红/挽回琥珀/普通灰）
    // 未知/无画像 → 一律灰色（与普通朋友同色；title 显示"未知"）
    _STAGE_COLORS: {
        '追求': '#185FA5',
        '暧昧': '#993556',
        '恋爱': '#A32D2D',
        '挽回': '#854F0B',
        '普通朋友': '#5F5E5A',
    },
    _DEFAULT_GRAY: '#5F5E5A',

    _stageInfo(s) {
        let stage = '';
        try {
            if (s && s.memory_card) {
                // memory_card 为 text 列存 JSON 字符串（兼容已 parse 的对象）
                const mc = typeof s.memory_card === 'string' ? JSON.parse(s.memory_card) : s.memory_card;
                stage = (mc && mc.profile && mc.profile.stage) || '';
            }
        } catch (e) {
            stage = '';
        }
        const color = this._STAGE_COLORS[stage];
        if (color) return { stage, color };
        // [v20260805b] 没聊天/未知：一律灰色，不显示随机底色
        return { stage: stage || '未知', color: this._DEFAULT_GRAY };
    }
};
