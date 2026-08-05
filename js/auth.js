// ============================================================
// 军师 - 身份模块（v20260805 用户机制重构：游客 + 账号双模式）
//
// 游客模式：Supabase 匿名登录（会话载体）+ 设备指纹 device_id（身份），
//           免费 20 条/天，用完弹注册引导。
// 账号模式：账号+密码（Supabase Auth 管理），注册绑定设备（一机一号），
//           任意设备可登录但同一时间仅一台在线（active_session 单点踢旧），
//           前 3 天 50 条/天、之后 20 条/天，用完弹付费墙（月卡/邀请）。
//
// 会话持久化：
//   Supabase session（access_token/refresh_token）→ SDK 自己存（junshi-auth）
//   账号元数据（account_name/session_id/邀请码/VIP）→ Cookie+localStorage 双写
//   （'junshi_account'，90 天滚动续期；清缓存不清 Cookie → 登录态不丢）
// ============================================================

const Auth = {
    currentUser: null,      // Supabase 登录 user（游客匿名 or 账号）
    currentProfile: null,   // profiles 行（bio 编辑等仍用）
    device: null,           // 游客设备状态 { device_id, free_daily }
    account: null,          // 账号会话 { account_name, user_id, session_id, invite_code, invite_bonus, is_vip, vip_days_left, vip_expires_at }
    isAccount: false,       // 是否账号模式（决定 ima-proxy 身份头与配额口径）

    // 初始化：优先恢复账号会话（校验单点）；否则游客模式（匿名登录+设备注册）
    async init() {
        const sb = getSupabaseClient();
        if (!sb) return false;

        // 1. 尝试恢复 Supabase 会话（SDK 持久化）
        let session = null;
        try {
            const { data: { session: s } } = await sb.auth.getSession();
            session = s;
        } catch (e) { /* 忽略 */ }

        if (session && session.user) {
            this.currentUser = session.user;
            const meta = session.user.user_metadata || {};
            // 账号登录的 user 带 account_name 标记 → 账号模式
            if (meta.account_name) {
                const ok = await this._initAccount(session);
                if (ok) return true;
                // 账号校验失败（被踢/失效）→ 清账号回退游客
                await this._resetToGuest();
            } else {
                // 匿名 user（游客）→ 直接游客模式
                return await this._initGuest();
            }
        }

        // 2. 游客模式：匿名登录
        return await this._initGuest();
    },

    // ---- 账号模式 ----
    async _initAccount(session) {
        const saved = this._getAccountStorage();
        if (!saved || !saved.session_id) return false;
        this.currentUser = session.user;
        this.currentProfile = await DB.getProfile(session.user.id);
        this.account = {
            account_name: saved.account_name || (session.user.user_metadata || {}).account_name || '',
            user_id: session.user.id,
            session_id: saved.session_id,
            invite_code: saved.invite_code || '',
            invite_bonus: saved.invite_bonus || 0,
            is_vip: !!saved.is_vip,
            vip_days_left: saved.vip_days_left || 0,
            vip_expires_at: saved.vip_expires_at || null,
        };
        this.isAccount = true;

        // 单点校验：session_id 与服务端 active_session 不匹配 → 已在其他设备登录
        const valid = await this._syncCheck();
        if (!valid) {
            Utils && Utils.toast('账号已在其他设备登录');
            await this._resetToGuest();
            return false;
        }
        // 刷新账号状态（邀请余额/VIP）
        await this.refreshAccountStatus();
        return true;
    },

    // 会话单点校验（account-auth/sync）
    async _syncCheck() {
        const cfg = window.APP_CONFIG?.account;
        if (!cfg || !cfg.authUrl || !this.account) return true;
        try {
            const token = await this._token();
            const resp = await fetch(cfg.authUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                body: JSON.stringify({ action: 'sync', session_id: this.account.session_id })
            });
            const r = await resp.json();
            return !!(r && r.valid === true);
        } catch (e) {
            return true; // 网络异常不误踢，下次再校验
        }
    },

    // 刷新账号配额状态（顶部导航用）
    async refreshAccountStatus() {
        const cfg = window.APP_CONFIG?.account;
        if (!cfg || !cfg.authUrl || !this.account) return;
        try {
            const token = await this._token();
            const resp = await fetch(cfg.authUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                body: JSON.stringify({ action: 'sync', session_id: this.account.session_id })
            });
            const r = await resp.json();
            if (r && r.valid === true && r.account) {
                this.account.invite_bonus = r.account.invite_bonus || 0;
                this.account.is_vip = !!r.account.is_vip;
                if (r.account.vip_expires_at) {
                    this.account.vip_expires_at = r.account.vip_expires_at;
                    this.account.vip_days_left = Math.max(1, Math.ceil((new Date(r.account.vip_expires_at) - Date.now()) / 86400000));
                }
                this._saveAccountStorage();
            }
        } catch (e) { /* 忽略 */ }
    },

    // ---- 游客模式 ----
    async _initGuest() {
        const sb = getSupabaseClient();
        if (!sb) return false;
        this.isAccount = false;
        this.account = null;

        // 匿名登录（无 session 则创建）
        let session = null;
        try {
            const { data: { session: s } } = await sb.auth.getSession();
            session = s;
        } catch (e) { /* 忽略 */ }
        if (session && session.user && (session.user.user_metadata || {}).account_name) {
            // 当前 session 是账号（登出未彻底）→ 强制登出重来
            await sb.auth.signOut();
            session = null;
        }
        if (session && session.user) {
            this.currentUser = session.user;
        } else {
            const { data, error } = await sb.auth.signInAnonymously();
            if (error || !data.user) {
                console.error('[军师] 匿名登录失败:', error);
                return false;
            }
            this.currentUser = data.user;
        }

        this.currentProfile = await DB.getProfile(this.currentUser.id);
        await this._registerDevice();
        return true;
    },

    // 清账号回退游客
    async _resetToGuest() {
        const sb = getSupabaseClient();
        if (sb) {
            try { await sb.auth.signOut(); } catch (e) { /* 忽略 */ }
        }
        this._clearAccountStorage();
        return await this._initGuest();
    },

    // ---- 账号注册 / 登录 / 登出 ----
    async register({ account_name, password, invite_code }) {
        const cfg = window.APP_CONFIG?.account;
        if (!cfg || !cfg.authUrl) {
            Utils.toast('账号服务未配置');
            return { success: false };
        }
        if (!this.device || !this.device.device_id) {
            await this._registerDevice();
        }
        if (!this.device || !this.device.device_id) {
            Utils.toast('设备初始化中，请重试');
            return { success: false };
        }
        try {
            const token = await this._token(); // 游客匿名 token（数据迁移用）
            const resp = await fetch(cfg.authUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                body: JSON.stringify({
                    action: 'register',
                    account_name: account_name.trim(),
                    password,
                    invite_code: invite_code ? invite_code.trim().toUpperCase() : '',
                    device_id: this.device.device_id
                })
            });
            const r = await resp.json();
            if (!r || r.success !== true) {
                return { success: false, message: (r && r.message) || '注册失败，请重试' };
            }
            // 切换到账号会话
            await this._applyAccountSession(r);
            Utils.toast(r.inviter_rewarded ? '注册成功！已与邀请人互相赠送额度' : '🎉 注册成功，额度已提升！');
            return { success: true };
        } catch (e) {
            console.error('[军师] 注册失败:', e);
            return { success: false, message: '网络错误，请重试' };
        }
    },

    async login(account_name, password) {
        const cfg = window.APP_CONFIG?.account;
        if (!cfg || !cfg.authUrl) {
            Utils.toast('账号服务未配置');
            return { success: false };
        }
        try {
            const resp = await fetch(cfg.authUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'login', account_name: account_name.trim(), password })
            });
            const r = await resp.json();
            if (!r || r.success !== true) {
                return { success: false, message: (r && r.message) || '登录失败' };
            }
            await this._applyAccountSession(r);
            Utils.toast('欢迎回来，' + r.account.account_name);
            return { success: true };
        } catch (e) {
            console.error('[军师] 登录失败:', e);
            return { success: false, message: '网络错误，请重试' };
        }
    },

    async logout() {
        await this._resetToGuest();
        Utils.toast('已退出登录');
    },

    // 应用账号会话（登录/注册成功后调用）
    async _applyAccountSession(r) {
        const sb = getSupabaseClient();
        if (sb && r.session) {
            await sb.auth.setSession({
                access_token: r.session.access_token,
                refresh_token: r.session.refresh_token
            });
            this.currentUser = r.session.user || null;
        }
        this.currentProfile = this.currentUser ? await DB.getProfile(this.currentUser.id) : null;
        this.account = {
            account_name: (r.account && r.account.account_name) || '',
            user_id: (r.account && r.account.user_id) || (this.currentUser && this.currentUser.id) || '',
            session_id: r.session_id || '',
            invite_code: (r.account && r.account.invite_code) || '',
            invite_bonus: (r.account && r.account.invite_bonus) || 0,
            is_vip: !!(r.account && r.account.is_vip),
            vip_days_left: 0,
            vip_expires_at: (r.account && r.account.vip_expires_at) || null,
        };
        if (this.account.vip_expires_at) {
            this.account.vip_days_left = Math.max(1, Math.ceil((new Date(this.account.vip_expires_at) - Date.now()) / 86400000));
        }
        this.isAccount = true;
        this._saveAccountStorage();
        this._updateAuthButton();
    },

    // ---- 账号本地持久化（Cookie+localStorage 双写）----
    _getAccountStorage() {
        const KEY = 'junshi_account';
        try {
            const raw = localStorage.getItem(KEY) || this._getCookie(KEY);
            if (raw) {
                const o = JSON.parse(raw);
                return (o && o.session_id) ? o : null;
            }
        } catch (e) { /* 忽略 */ }
        return null;
    },

    _saveAccountStorage() {
        if (!this.account) return;
        const KEY = 'junshi_account';
        const o = {
            account_name: this.account.account_name,
            session_id: this.account.session_id,
            invite_code: this.account.invite_code,
            invite_bonus: this.account.invite_bonus,
            is_vip: this.account.is_vip,
            vip_days_left: this.account.vip_days_left,
            vip_expires_at: this.account.vip_expires_at
        };
        const raw = JSON.stringify(o);
        try { localStorage.setItem(KEY, raw); } catch (e) { /* 忽略 */ }
        this._setCookie(KEY, raw);
    },

    _clearAccountStorage() {
        const KEY = 'junshi_account';
        try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
        try {
            document.cookie = KEY + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        } catch (e) { /* 忽略 */ }
    },

    // ---- 顶部导航"登入/退出"按钮 ----
    _updateAuthButton() {
        const btn = document.getElementById('auth-btn');
        const label = document.getElementById('auth-btn-label');
        if (!btn) return;
        if (this.isAccount && this.account) {
            btn.classList.add('logged-in');
            if (label) label.textContent = this.account.account_name.slice(0, 8);
            btn.title = '点击退出登录';
        } else {
            btn.classList.remove('logged-in');
            if (label) label.textContent = '登入';
            btn.title = '登录/注册账号，畅聊更多';
        }
    },

    // ============================================================
    // 以下为游客设备身份（保留原有逻辑：Cookie 兜底 + 指纹召回）
    // ============================================================

    // 设备注册（游客用；已存在则返回状态；新设备受"同 IP 每日新设备 ≤5"防刷）
    async _registerDevice() {
        let deviceId;
        try {
            deviceId = await this._getDeviceId();
        } catch (e) {
            console.warn('[军师] 设备指纹获取失败:', e);
            this.device = null;
            return false;
        }

        this.device = {
            device_id: deviceId,
            free_daily: 20,
            invite_bonus: 0,
            is_vip: false,
            vip_days_left: 0,
            vip_expires_at: null,
            invite_redeemed: false,
        };

        const gateUrl = window.APP_CONFIG?.device?.gateUrl;
        if (!gateUrl) {
            this.device = null;
            return false;
        }

        const invite = this._inviteFromUrl();
        try {
            const token = await this._token();
            const resp = await fetch(gateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                body: JSON.stringify({
                    action: 'register',
                    device_id: deviceId,
                    invite_code: invite,
                    // [方案C 召回信号]
                    fp_screen: (screen.width && screen.height) ? screen.width + 'x' + screen.height : '',
                    fp_tz: String(new Date().getTimezoneOffset()),
                    fp_lang: navigator.language || ''
                })
            });
            if (!resp.ok) {
                console.warn('[军师] 设备注册 HTTP 失败:', resp.status);
                this.device = null;
                return false;
            }
            const r = await resp.json();
            if (!r || r.success !== true) {
                console.warn('[军师] 设备注册被拒:', JSON.stringify(r || {}).slice(0, 200));
                this.device = null;
                return false;
            }
            // [方案C 召回] 换用老 ID（双写持久化）
            if (r.recalled && r.recalled_device_id) {
                deviceId = r.recalled_device_id;
                this.device.device_id = deviceId;
                try { localStorage.setItem('junshi_device_id', deviceId); } catch (e) { /* 忽略 */ }
                this._setCookie('junshi_device_id', deviceId);
            }
            this.device.free_daily = r.free_daily || 20;
            return true;
        } catch (e) {
            console.warn('[军师] 设备注册失败:', e);
            this.device = null;
            return false;
        }
    },

    // 刷新游客配额状态
    async refreshStatus() {
        const gateUrl = window.APP_CONFIG?.device?.gateUrl;
        if (!gateUrl || !this.device || this.isAccount) return;
        try {
            const resp = await fetch(gateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'status', device_id: this.device.device_id })
            });
            if (!resp.ok) return;
            const r = await resp.json();
            if (r && r.registered) {
                this.device.free_daily = r.free_daily || 20;
            }
        } catch (e) { /* 忽略 */ }
    },

    // URL ?invite=CODE（大写、去空格；非空返回）
    _inviteFromUrl() {
        try {
            const params = new URLSearchParams(location.search);
            const invite = (params.get('invite') || '').trim().toUpperCase();
            return invite || null;
        } catch (e) {
            return null;
        }
    },

    async _token() {
        const sb = getSupabaseClient();
        if (!sb) return '';
        try {
            const { data: { session } } = await sb.auth.getSession();
            return session?.access_token || '';
        } catch (e) {
            return '';
        }
    },

    // ---- 设备指纹（FingerprintJS，失败降级备用指纹；首次生成后 Cookie + localStorage 双持久化固定复用）----
    // [v20260805 方案A] Cookie 优先：清浏览器缓存（Cookie 默认不清）身份不丢；
    // [方案C] fp_ 前缀 = fallback 漂移 → 服务端多信号召回老设备
    async _getDeviceId() {
        const KEY = 'junshi_device_id';
        // 1. Cookie 优先（命中即滚动续期 90 天）
        try {
            const fromCookie = this._getCookie(KEY);
            if (fromCookie && /^[A-Za-z0-9_-]{8,64}$/.test(fromCookie)) {
                this._setCookie(KEY, fromCookie);
                return fromCookie;
            }
        } catch (e) { /* 忽略 */ }
        // 2. localStorage 兜底（回写 Cookie 一次性补位）
        try {
            const cached = localStorage.getItem(KEY);
            if (cached && /^[A-Za-z0-9_-]{8,64}$/.test(cached)) {
                this._setCookie(KEY, cached);
                return cached;
            }
        } catch (e) { /* 忽略 */ }
        // 3. 全新生成（FingerprintJS 优先；失败走备用指纹），双写
        const id = await this._generateDeviceId();
        try { localStorage.setItem(KEY, id); } catch (e) { /* 忽略 */ }
        this._setCookie(KEY, id);
        return id;
    },

    async _generateDeviceId() {
        try {
            if (typeof FingerprintJS === 'undefined' && !this._fpLoading) {
                this._fpLoading = true;
                await this._loadFingerprintJS();
            }
            if (typeof FingerprintJS !== 'undefined' && typeof FingerprintJS.load === 'function') {
                const fp = await FingerprintJS.load();
                const result = await fp.get();
                return result.visitorId;
            }
        } catch (e) {
            console.warn('[军师] FingerprintJS 加载失败，使用备用方案:', e.message || e);
        }
        const fallback = [
            navigator.userAgent || '',
            navigator.language || '',
            screen.width || '',
            screen.height || '',
            navigator.platform || '',
            new Date().getTimezoneOffset() || ''
        ].join('|');
        return 'fp_' + this._hashString(fallback);
    },

    _loadFingerprintJS() {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.umd.min.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => resolve();
            document.head.appendChild(script);
            setTimeout(resolve, 5000);
        });
    },

    _hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    },

    // Cookie 读取（带值编码；失效/不可用返回空串）
    _getCookie(name) {
        try {
            const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
            return m ? decodeURIComponent(m[1] || '') : '';
        } catch (e) {
            return '';
        }
    },

    // Cookie 写入（90 天过期；path=/ 全站可用；SameSite=Lax 防第三方上下文携带）
    _setCookie(name, value) {
        try {
            const expires = new Date(Date.now() + 90 * 86400000).toUTCString();
            document.cookie = name + '=' + encodeURIComponent(value) +
                '; expires=' + expires + '; path=/; SameSite=Lax';
        } catch (e) { /* Cookie 不可用（如 file:// 环境）则忽略 */ }
    },
};
