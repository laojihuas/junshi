// ============================================================
// 军师 - 认证模块
// ============================================================

const Auth = {
    currentUser: null,
    currentProfile: null,

    // 初始化：检查登录状态
    async init() {
        const sb = getSupabaseClient();
        if (!sb) return false;

        // 获取当前会话
        const { data: { session }, error } = await sb.auth.getSession();
        if (error || !session) {
            return false;
        }

        this.currentUser = session.user;

        // 获取 profile
        this.currentProfile = await DB.getProfile(session.user.id);

        // 监听认证状态变化
        sb.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                this.currentUser = session.user;
                this.currentProfile = await DB.getProfile(session.user.id);
                App.navigate('friends');
            } else if (event === 'SIGNED_OUT') {
                this.currentUser = null;
                this.currentProfile = null;
                App.navigate('auth');
            }
        });

        return true;
    },

    // 注册
    async register(email, password) {
        const sb = getSupabaseClient();
        if (!sb) return { success: false, message: '系统未配置' };

        try {
            const { data, error } = await sb.auth.signUp({
                email: email.trim(),
                password: password,
                options: {
                    data: { nickname: email.split('@')[0] }
                }
            });

            if (error) {
                return { success: false, message: this._friendlyError(error.message) };
            }

            if (data.user) {
                // 注册成功，记录设备指纹
                const deviceId = await this._getDeviceId();
                await DB.updateProfile(data.user.id, { device_id: deviceId });
                return { success: true, message: '注册成功！请查看邮箱确认链接后登录。' };
            }

            return { success: false, message: '注册失败，请重试' };
        } catch (e) {
            return { success: false, message: '网络错误，请检查连接' };
        }
    },

    // 登录
    async login(email, password) {
        const sb = getSupabaseClient();
        if (!sb) return { success: false, message: '系统未配置' };

        try {
            const { data, error } = await sb.auth.signInWithPassword({
                email: email.trim(),
                password: password
            });

            if (error) {
                return { success: false, message: this._friendlyError(error.message) };
            }

            if (data.user) {
                this.currentUser = data.user;
                this.currentProfile = await DB.getProfile(data.user.id);

                // 设备指纹校验
                const deviceId = await this._getDeviceId();
                if (this.currentProfile.device_id && this.currentProfile.device_id !== deviceId) {
                    // 设备不一致，记录但允许登录（软校验）
                    console.warn('[军师] 设备指纹不匹配，可能在其他设备登录');
                } else if (!this.currentProfile.device_id) {
                    // 首次记录设备指纹
                    await DB.updateProfile(data.user.id, { device_id: deviceId });
                }

                return { success: true, message: '登录成功' };
            }

            return { success: false, message: '登录失败' };
        } catch (e) {
            return { success: false, message: '网络错误，请检查连接' };
        }
    },

    // 退出登录
    async logout() {
        const sb = getSupabaseClient();
        if (!sb) return;
        await sb.auth.signOut();
        this.currentUser = null;
        this.currentProfile = null;
        // [多窗口会话] 退出登录时清空当前窗口的会话数据
        if (typeof WindowSession !== 'undefined') {
            WindowSession.clear();
        }
        App.navigate('auth');
    },

    // 获取设备指纹
    async _getDeviceId() {
        // 动态加载 FingerprintJS（避免 ESM 报错影响其他脚本）
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
        // 备用指纹方案（不依赖外部库）
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

    // 动态加载 FingerprintJS UMD
    _loadFingerprintJS() {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.umd.min.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => resolve(); // 加载失败也 resolve，让备用方案生效
            document.head.appendChild(script);
            // 5秒超时，避免等待太久
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

    _friendlyError(message) {
        const map = {
            'Invalid login credentials': '邮箱或密码错误',
            'Email not confirmed': '邮箱未验证，请先查看邮件确认',
            'User already registered': '该邮箱已注册',
            'Password should be at least 6 characters': '密码至少 6 位',
            'rate limit': '操作太频繁，请稍后再试',
        };
        for (const [key, val] of Object.entries(map)) {
            if (message.toLowerCase().includes(key.toLowerCase())) return val;
        }
        return message;
    }
};
