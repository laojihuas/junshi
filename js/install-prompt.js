// ============================================================
// 军师 - PWA 安装引导
// 4 道防打扰：
//   1. 已从桌面打开（standalone）→ 不弹
//   2. 已安装成功（appinstalled）→ 永久不弹
//   3. 拒绝过 → 递增冷却（7天 / 30天 / 永久）
//   4. 不在好友首页 / 未登录 / 浏览器不支持 → 不弹
//
// 调用：App.init() 登录成功进入 friends 页后调用 PWAInstall.maybeShow()
// 弹窗在 2 秒后出现，可点「立即添加」或「暂不」
// ============================================================

const PWAInstall = {
    deferredPrompt: null,    // Android Chrome 系统安装事件
    isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream,
    isStandalone: window.matchMedia('(display-mode: standalone)').matches
               || window.navigator.standalone === true,
    _inflight: false,        // 防止重复弹窗
    _modal: null,            // 已插入的弹窗 DOM

    // ---------- 持久化 ----------
    _setInstalled() {
        try { localStorage.setItem('pwa_installed', '1'); } catch (e) {}
    },
    _isInstalled() {
        try { return localStorage.getItem('pwa_installed') === '1'; }
        catch (e) { return false; }
    },
    _recordDismiss() {
        try {
            localStorage.setItem('pwa_prompt_dismissed_at', String(Date.now()));
            const c = parseInt(localStorage.getItem('pwa_prompt_dismiss_count') || '0', 10) + 1;
            localStorage.setItem('pwa_prompt_dismiss_count', String(c));
        } catch (e) {}
    },
    _inCooldown() {
        try {
            const at = parseInt(localStorage.getItem('pwa_prompt_dismissed_at') || '0', 10);
            const cnt = parseInt(localStorage.getItem('pwa_prompt_dismiss_count') || '0', 10);
            if (!at) return false;
            // 递增冷却：第 1 次 7 天，第 2 次 30 天，第 3 次起永久
            const days = cnt >= 3 ? 99999 : (cnt === 2 ? 30 : 7);
            const ms = days * 24 * 60 * 60 * 1000;
            return Date.now() - at < ms;
        } catch (e) { return false; }
    },

    // ---------- 初始化（脚本加载时自动执行） ----------
    init() {
        // 注册 Service Worker
        if ('serviceWorker' in navigator) {
            // 不阻塞首屏
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').catch(() => {});
            });
        }

        // 拦截 Android Chrome 系统安装条
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            PWAInstall.deferredPrompt = e;
        });

        // 安装成功写入永久标记
        window.addEventListener('appinstalled', () => {
            PWAInstall._setInstalled();
            PWAInstall._hideModal();
        });
    },

    // ---------- 入口：登录成功进入好友页后调用 ----------
    maybeShow() {
        if (this._inflight) return;
        this._inflight = true;
        setTimeout(() => {
            this._inflight = false;
            this._tryShow();
        }, 2000);
    },

    _tryShow() {
        // 防线 1：已从桌面打开
        if (this.isStandalone) return;
        // 防线 2：已安装成功
        if (this._isInstalled()) return;
        // 防线 3：冷却期
        if (this._inCooldown()) return;
        // 防线 4：必须在好友首页 + 已登录
        if (!window.Auth || !window.Auth.currentUser) return;
        if (!window.App || window.App.currentPage !== 'friends') return;

        // 全部通过 → 弹窗
        this._showModal();
    },

    // ---------- 弹窗 ----------
    _showModal() {
        if (this._modal) return;
        const canNative = !!this.deferredPrompt;
        const o = document.createElement('div');
        o.id = 'pwa-install-modal';
        o.className = 'modal-overlay active';
        o.innerHTML = `
            <div class="modal-content pwa-install-card">
                <div class="pwa-install-icon">
                    <img src="icons/icon-192.png" alt="军师">
                </div>
                <div class="modal-title">把「军师」放到桌面</div>
                <div class="modal-body">
                    <div class="pwa-install-desc">添加到桌面后，从图标一键打开，不用再翻浏览器，更快更方便。</div>
                    ${canNative ? this._renderAndroid() : this._renderManual()}
                </div>
                <div class="modal-footer">
                    <button id="pwa-install-cancel" class="btn btn-outline">暂不</button>
                    ${canNative ? '<button id="pwa-install-go" class="btn btn-primary">立即添加</button>' : ''}
                </div>
            </div>
        `;
        document.body.appendChild(o);
        this._modal = o;

        // 事件
        o.addEventListener('click', (e) => {
            if (e.target === o) this._dismiss();
        });
        document.getElementById('pwa-install-cancel').addEventListener('click', () => this._dismiss());
        const go = document.getElementById('pwa-install-go');
        if (go) go.addEventListener('click', () => this._triggerNative());
    },

    _renderAndroid() {
        return '';  // 系统弹窗接管主行动；这里只显示描述
    },

    _renderManual() {
        // iOS / 浏览器不支持原生安装：手动步骤图文
        const steps = this.isIOS
            ? [
                ['点击底部', '分享按钮', '⬆'],
                ['滑动找到', '「添加到主屏幕」', '➕'],
                ['点击右上角', '「添加」', '✓']
              ]
            : [
                ['点击右上角浏览器菜单', '「⋮」或「⋮⋮」', '⋯'],
                ['找到', '「添加到主屏幕」或「安装应用」', '➕'],
                ['点击', '「添加」完成', '✓']
              ];
        return `
            <div class="pwa-install-steps">
                ${steps.map((s, i) => `
                    <div class="pwa-step">
                        <span class="pwa-step-num">${i + 1}</span>
                        <span class="pwa-step-text">${s[0]} <b>${s[1]}</b></span>
                        <span class="pwa-step-icon">${s[2]}</span>
                    </div>
                `).join('')}
            </div>
        `;
    },

    async _triggerNative() {
        const btn = document.getElementById('pwa-install-go');
        if (btn) btn.disabled = true;
        try {
            this.deferredPrompt.prompt();
            const choice = await this.deferredPrompt.userChoice;
            if (choice && choice.outcome === 'accepted') {
                // 用户接受 → appinstalled 事件会触发置永久标记
                this._hideModal();
            } else {
                // 用户拒绝 → 走冷却
                this._dismiss();
            }
        } catch (e) {
            this._dismiss();
        } finally {
            this.deferredPrompt = null;
        }
    },

    _dismiss() {
        this._recordDismiss();
        this._hideModal();
    },

    _hideModal() {
        if (this._modal && this._modal.parentNode) {
            this._modal.parentNode.removeChild(this._modal);
        }
        this._modal = null;
    }
};

// 脚本加载即自动初始化（监听事件 + 注册 SW）
PWAInstall.init();
