// ============================================================
// 军师 - 付费墙模块（v20260805 设备版）
// ============================================================

const Paywall = {
    show() {
        const overlay = document.getElementById('paywall-overlay');
        overlay.classList.add('active');
        this._updateUI();
        // [邀请功能] 打开时异步加载我的邀请链接 + 邀请码
        Invite.load();
    },

    hide() {
        document.getElementById('paywall-overlay').classList.remove('active');
        document.getElementById('activation-input').value = '';
    },

    _updateUI() {
        const config = window.APP_CONFIG?.product || { priceDisplay: '68 元/月', price: 68 };
        document.getElementById('paywall-price').innerHTML =
            `¥${config.price}<small>/月</small>`;
        // [v20260805] 不暴露免费档位数字（50/30/15），只做引导
        document.getElementById('paywall-tries-desc').textContent =
            `今日次数已用完，开通 VIP 继续畅聊`;
        // [邀请功能] 展示单次邀请赠送次数（不显示 300 上限）
        const rewardEl = document.getElementById('invite-reward-tries');
        if (rewardEl) {
            rewardEl.textContent = window.APP_CONFIG?.invite?.rewardTries || 50;
        }
    },

    // 激活码验证（服务端绑设备指纹，X-Device-Id 头携带）
    async activate() {
        const input = document.getElementById('activation-input');
        const btn = document.getElementById('activate-btn');
        const code = input.value.trim().toUpperCase();

        if (!code) {
            Utils.toast('请输入激活码');
            return;
        }

        btn.disabled = true;
        btn.textContent = '验证中...';

        try {
            const config = window.APP_CONFIG?.activation;
            const verifyUrl = config && config.verifyUrl;
            if (!verifyUrl) {
                Utils.toast('激活服务未配置，请联系客服');
                btn.disabled = false;
                btn.textContent = '激活';
                return;
            }

            const deviceId = (Auth.device && Auth.device.device_id) || '';
            if (!deviceId) {
                Utils.toast('设备初始化中，请重试');
                btn.disabled = false;
                btn.textContent = '激活';
                return;
            }

            const resp = await fetch(verifyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-Id': deviceId
                },
                body: JSON.stringify({ code: code })
            });

            const result = await resp.json().catch(() => ({}));
            if (resp.ok && result.success) {
                // 更新本地设备状态（VIP 剩余天数）
                if (Auth.device) {
                    Auth.device.is_vip = true;
                    Auth.device.vip_days_left = result.vip_days_left || 30;
                    Auth.device.vip_expires_at = result.vip_expires_at || null;
                }
                Utils.toast('🎉 激活成功！已升级为 VIP');
                this.hide();
                // 刷新好友列表头部状态
                Friends.render();
            } else {
                Utils.toast(result.message || '激活码无效或已使用');
            }
        } catch (e) {
            Utils.toast('验证失败，请检查网络后重试');
            console.error('[军师] 激活码验证错误:', e);
        }

        btn.disabled = false;
        btn.textContent = '激活';
    },

    // 跳转到购买页面
    goPurchase() {
        const url = window.APP_CONFIG?.store?.purchaseUrl;
        if (url) {
            window.open(url, '_blank');
        } else {
            Utils.toast('购买链接未配置，请联系客服');
        }
    }
};
