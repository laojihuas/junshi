// ============================================================
// 军师 - 付费墙模块
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
        const config = window.APP_CONFIG?.product || { priceDisplay: '88 元/月', price: 88 };
        document.getElementById('paywall-price').innerHTML =
            `¥${config.price}<small>/月</small>`;
        document.getElementById('paywall-tries-desc').textContent =
            `50 次免费试用已用完，升级 VIP 无限使用`;
        // [邀请功能] 展示单次邀请赠送次数
        const rewardEl = document.getElementById('invite-reward-tries');
        if (rewardEl) {
            rewardEl.textContent = window.APP_CONFIG?.invite?.rewardTries || 50;
        }
    },

    // 激活码验证
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
            // 优先尝试通过 Edge Function 验证
            const config = window.APP_CONFIG?.activation;
            let success = false;

            if (config && config.verifyUrl) {
                const sb = getSupabaseClient();
                const { data: { session } } = await sb.auth.getSession();
                const token = session?.access_token;

                const resp = await fetch(config.verifyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': token ? 'Bearer ' + token : ''
                    },
                    body: JSON.stringify({
                        code: code,
                        user_id: Auth.currentUser?.id
                    })
                });

                if (resp.ok) {
                    const result = await resp.json();
                    success = result.success;
                    if (!success) {
                        Utils.toast(result.message || '激活码无效或已使用');
                    }
                } else {
                    throw new Error('API error');
                }
            } else {
                // 降级：客户端直接验证（开发调试用）
                const codeRecord = await DB.verifyActivationCode(code);
                if (codeRecord && !codeRecord.used) {
                    const sb = getSupabaseClient();
                    // 标记激活码已使用
                    await sb.from('activation_codes')
                        .update({
                            used: true,
                            used_by: Auth.currentUser.id,
                            used_at: new Date().toISOString()
                        })
                        .eq('id', codeRecord.id);

                    // 更新用户 VIP 状态
                    await DB.updateProfile(Auth.currentUser.id, {
                        is_vip: true,
                        vip_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                    });

                    success = true;
                } else if (codeRecord && codeRecord.used) {
                    Utils.toast('该激活码已被使用');
                } else {
                    Utils.toast('无效的激活码');
                }
            }

            if (success) {
                // 更新本地 profile
                if (Auth.currentProfile) {
                    Auth.currentProfile.is_vip = true;
                    Auth.currentProfile.vip_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
                }
                Utils.toast('🎉 激活成功！已升级为 VIP');
                this.hide();
                // 刷新好友列表头部状态
                Friends.render();
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
