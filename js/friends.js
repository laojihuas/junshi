// ============================================================
// 军师 - 好友列表模块
// ============================================================

const Friends = {
    sessions: [],

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
                const remaining = Math.max(0, (window.APP_CONFIG?.product?.freeTries || 50) - (p.usage_count || 0));
                headerStatus.textContent = '免费剩余 ' + remaining + ' 次';
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
            return `
                <div class="friend-item" data-session-id="${s.id}">
                    <div class="friend-avatar" style="background: ${s.avatar_color || '#07C160'}">
                        ${initial}
                    </div>
                    <div class="friend-info">
                        <div class="friend-name">${this._escapeHtml(s.friend_name)}</div>
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

            // 长按删除
            let longPressTimer = null;
            el.addEventListener('touchstart', () => {
                longPressTimer = setTimeout(() => {
                    const sessionId = el.dataset.sessionId;
                    this._confirmDelete(sessionId);
                }, 800);
            });
            el.addEventListener('touchend', () => {
                clearTimeout(longPressTimer);
            });
            el.addEventListener('touchmove', () => {
                clearTimeout(longPressTimer);
            });
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
            closeModal();
            const session = await DB.createSession(Auth.currentUser.id, name);
            if (session) {
                Utils.toast('已添加 ' + name);
                await this.load();
            } else {
                Utils.toast('添加失败，请重试');
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
    }
};
