// ============================================================
// 军师 - 设备身份模块（v20260805 剔除邮箱登录）
//
// 架构：Supabase 匿名登录（会话载体）+ 设备指纹 device_id（业务身份）。
//   device_id 决定：免费档位/邀请余额/VIP/配额归属。
//   匿名 user 只是 JWT 通行证，保住现有 chat 表 RLS 与前端直查。
// ============================================================

const Auth = {
    currentUser: null,      // 匿名登录 user（会话载体）
    currentProfile: null,   // profiles 行（bio 编辑等仍用）
    device: null,           // { device_id, invite_bonus, is_vip, vip_days_left, free_daily, vip_expires_at }
    pendingInvite: null,    // URL 携带的邀请码（首次新建好友成功后兑现）

    // 初始化：匿名登录 → 设备注册（幂等）
    async init() {
        const sb = getSupabaseClient();
        if (!sb) return false;

        // 1. 匿名登录（无 session 则创建；匿名登录失败视为网络异常）
        const { data: { session } } = await sb.auth.getSession();
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

        // 2. 加载 profile（bio 等；匿名用户注册时 ensure_profile 已建行）
        this.currentProfile = await DB.getProfile(this.currentUser.id);

        // 3. 设备注册（指纹 → devices 表，幂等；URL 邀请码一并暂存）
        await this._registerDevice();

        return true;
    },

    // 设备注册（已存在则返回状态；新设备受"同 IP 每日新设备 ≤5"防刷）
    async _registerDevice() {
        this.device = {
            device_id: await this._getDeviceId(),
            invite_bonus: 0,
            is_vip: false,
            vip_days_left: 0,
            vip_expires_at: null,
            free_daily: 50,
            invite_redeemed: false,
        };

        const gateUrl = window.APP_CONFIG?.device?.gateUrl;
        if (!gateUrl) return;

        const invite = this._inviteFromUrl();
        try {
            const token = await this._token();
            const resp = await fetch(gateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                body: JSON.stringify({ action: 'register', device_id: this.device.device_id, invite_code: invite })
            });
            if (!resp.ok) return;
            const r = await resp.json();
            if (r && r.success) {
                this.device.invite_bonus = r.invite_bonus || 0;
                this.device.is_vip = !!r.is_vip;
                this.device.vip_expires_at = r.vip_expires_at || null;
                this.device.free_daily = r.free_daily || 50;
                this.device.invite_redeemed = !!r.invite_redeemed;
                // 带邀请码且未绑定 → 记待兑现（首次新建好友成功后调用 redeem）
                if (invite && !r.invite_redeemed) {
                    this.pendingInvite = invite;
                }
                if (r.vip_expires_at) {
                    this.device.vip_days_left = Math.max(1, Math.ceil((new Date(r.vip_expires_at) - Date.now()) / 86400000));
                }
            }
        } catch (e) {
            console.warn('[军师] 设备注册失败:', e);
        }
    },

    // 刷新配额状态（顶部导航用：只显示邀请赠送次数 + VIP 剩余天数）
    async refreshStatus() {
        const gateUrl = window.APP_CONFIG?.device?.gateUrl;
        if (!gateUrl || !this.device) return;
        try {
            const resp = await fetch(gateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'status', device_id: this.device.device_id })
            });
            if (!resp.ok) return;
            const r = await resp.json();
            if (r && r.registered) {
                this.device.invite_bonus = r.invite_bonus || 0;
                this.device.is_vip = !!r.is_vip;
                this.device.vip_days_left = r.vip_days_left || 0;
                this.device.vip_expires_at = r.vip_expires_at || null;
                this.device.free_daily = r.free_daily || this.device.free_daily;
            }
        } catch (e) {
            console.warn('[军师] 配额状态刷新失败:', e);
        }
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

    // ---- 设备指纹（FingerprintJS，失败降级备用指纹）----
    async _getDeviceId() {
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
    }
};
