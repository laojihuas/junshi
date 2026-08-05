// ============================================================
// 军师 - 邀请功能模块（v20260805 用户机制重构：账号版）
//
// 邀请码在账号注册时自动生成（accounts.invite_code，8 位去混淆字符）。
// 邀请兑现：好友注册时填邀请码 → 邀请人 +50（封顶 300，注册即兑现），
// 不再需要独立 redeem 接口（旧 invite-redeem 已删除）。
// 游客没有邀请码（引导先注册）。
// ============================================================

const Invite = {
    // 站点地址：优先 config.siteUrl，回退当前域名
    _siteUrl() {
        const cfg = window.APP_CONFIG?.invite;
        let base = (cfg && cfg.siteUrl) ? cfg.siteUrl : (location.origin || '');
        base = base.replace(/\/+$/, '');
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

    // 我的邀请码（账号模式才有；游客返回 null）
    getMyCode() {
        if (Auth.isAccount && Auth.account && Auth.account.invite_code) {
            return Auth.account.invite_code;
        }
        return null;
    },

    // 一键复制文案（链接 + 邀请码）
    async copy() {
        const code = this.getMyCode();
        if (!code) {
            Utils.toast('注册账号后可获得专属邀请码');
            App.showRegisterModal();
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
    load() {
        const code = this.getMyCode();
        const linkEl = document.getElementById('invite-link');
        const codeEl = document.getElementById('invite-code');
        if (!linkEl || !codeEl) return;

        if (code) {
            linkEl.value = this.inviteUrl(code);
            codeEl.textContent = code;
        } else {
            linkEl.value = '';
            codeEl.textContent = '注册后可获取';
        }
    }
};
