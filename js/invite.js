// ============================================================
// 军师 - 邀请功能模块（v20260801）
//
// 1. 获取我的邀请码：调 invite-code Edge Function（没有则自动生成）
// 2. 兑现邀请：注册成功后调 invite-redeem，给邀请人 +50 次额度
// 3. 一键复制：复制"链接 + 邀请码"完整文案发给朋友
// ============================================================

const Invite = {
    _myCode: null,          // 当前用户邀请码（内存缓存）
    _loading: false,        // 防止并发加载

    // 站点地址：优先 config.siteUrl，回退当前域名
    _siteUrl() {
        const cfg = window.APP_CONFIG?.invite;
        let base = (cfg && cfg.siteUrl) ? cfg.siteUrl : (location.origin || '');
        base = base.replace(/\/+$/, ''); // 去掉尾部斜杠
        return base;
    },

    // 完整邀请链接
    inviteUrl(code) {
        const base = this._siteUrl();
        return base ? base + '?invite=' + code : '?invite=' + code;
    },

    // 单次赠送次数
    rewardTries() {
        return window.APP_CONFIG?.invite?.rewardTries || 50;
    },

    // 获取我的邀请码（Edge Function，无则生成；X-Device-Id 标识设备）
    async getMyCode(force = false) {
        if (this._myCode && !force) return this._myCode;
        if (this._loading) return this._myCode;
        this._loading = true;

        const cfg = window.APP_CONFIG?.invite;
        if (!cfg || !cfg.getUrl) {
            this._loading = false;
            return null;
        }

        try {
            const deviceId = (Auth.device && Auth.device.device_id) || '';
            const resp = await fetch(cfg.getUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-Id': deviceId
                },
                body: '{}'
            });
            if (!resp.ok) return null;
            const result = await resp.json();
            if (result && result.success && result.invite_code) {
                this._myCode = result.invite_code;
            }
            return this._myCode;
        } catch (e) {
            console.error('[军师] 获取邀请码失败:', e);
            return null;
        } finally {
            this._loading = false;
        }
    },

    // 兑现邀请：首次新建好友成功后调用，给邀请人 +50 次（封顶 300，不暴露上限）
    // 返回 { success, message }
    async redeem(code, deviceId) {
        const cfg = window.APP_CONFIG?.invite;
        if (!cfg || !cfg.redeemUrl || !code) {
            return { success: false, message: '邀请码无效' };
        }
        try {
            const resp = await fetch(cfg.redeemUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invite_code: code.trim().toUpperCase(),
                    device_id: deviceId
                })
            });
            if (!resp.ok) return { success: false, message: '兑换失败，请重试' };
            const result = await resp.json();
            return {
                success: !!result.success,
                message: result.message || (result.success ? '邀请成功' : '兑换失败')
            };
        } catch (e) {
            console.error('[军师] 兑现邀请失败:', e);
            return { success: false, message: '网络错误' };
        }
    },

    // 一键复制文案（链接 + 邀请码）
    async copy() {
        const code = await this.getMyCode();
        if (!code) {
            Utils.toast('邀请码获取失败，请重试');
            return;
        }
        const reward = this.rewardTries();
        const text =
`【军师】送你 ${reward} 次免费使用额度！
我在用「军师」聊天指导工具，邀请你注册，双方都能获得 ${reward} 次使用额度：
🔗 ${this.inviteUrl(code)}
🎫 邀请码：${code}
打开链接注册时填上邀请码即可生效~`;

        try {
            await navigator.clipboard.writeText(text);
            Utils.toast('✅ 已复制，快去发给朋友吧');
        } catch (e) {
            // 降级方案（兼容旧浏览器/非 HTTPS）
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            Utils.toast('✅ 已复制，快去发给朋友吧');
        }
    },

    // 加载并渲染到付费墙邀请卡片（幂等）
    async load() {
        const code = await this.getMyCode();
        const linkEl = document.getElementById('invite-link');
        const codeEl = document.getElementById('invite-code');
        if (!linkEl || !codeEl) return;

        if (code) {
            linkEl.value = this.inviteUrl(code);
            codeEl.textContent = code;
        } else {
            linkEl.value = '';
            codeEl.textContent = '加载失败';
        }
    }
};
