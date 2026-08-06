// ============================================================
// 军师 - 恋爱聊天指导工具 · 主应用
// ============================================================

const App = {
    currentPage: null,

    async init() {
        console.log('[军师] 初始化中...');

        // 检查配置
        this._checkConfig();

        // [多窗口会话] 初始化窗口级会话（生成/恢复窗口会话ID与对话历史）
        // 必须最先执行：刷新保留会话，新开/复制标签页生成新会话
        WindowSession.init();

        // 初始化 Supabase 客户端
        getSupabaseClient();

        // 绑定事件
        this._bindEvents();

        // [v20260805 账号体系] 身份初始化：
        //   优先恢复账号会话（校验单点）；否则游客模式（匿名登录+设备注册）
        //   URL ?invite=CODE 由注册弹窗自动填入
        const ok = await Auth.init();

        if (!ok) {
            // 匿名登录失败（网络/服务异常）：提示后重试，不进入页面
            Utils.toast('网络异常，请重试');
            this.navigate('auth');
            return;
        }

        await Friends.load();

        // [杀进程恢复] 上次停留在聊天页（切后台被浏览器回收后重新加载）→
        // 自动恢复到该聊天会话，不再每次都回到好友列表
        const lastView = WindowSession.getLastView();
        if (lastView && lastView.friendId) {
            let restored = false;
            try {
                // restoreContext=true：杀进程后 sessionStorage 丢失，
                // 从数据库重建最近 50 条对话作为 AI 上下文
                restored = await Chat.open(lastView.friendId, true);
            } catch (e) {
                // 恢复异常（网络/查询失败等）绝不能中断初始化，
                // 更不能再把用户卡在半路，安全回退好友列表
                console.error('[军师] 恢复会话异常:', e);
                Utils.dlog('init', 'restore chat FAILED: ' + (e && e.message));
            }
            if (!restored) {
                this.navigate('friends');
            }
        } else {
            this.navigate('friends');
        }

        // [PWA] 进入首页 2 秒后，弹出"添加到桌面"引导（4 道防打扰：standalone/已安装/冷却/未登录；
            // 仅好友列表页弹出，恢复聊天页时 currentPage 非 friends 不会触发）
        PWAInstall.maybeShow();

        Utils.dlog('init', 'done currentPage=' + this.currentPage);

        console.log('[军师] 初始化完成');
    },

    navigate(page) {
        const from = this.currentPage;
        // 隐藏所有页面
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('page-' + page);
        if (target) {
            target.classList.add('active');
            this.currentPage = page;
        }
        // 诊断日志：记录每次页面切换（排查"秒切回好友列表"问题）
        try { Utils.dlog('nav', (from || '?') + ' -> ' + page); } catch (e) {}
    },

    // [v20260805 账号体系] 登录 / 注册弹窗
    showLoginModal() {
        document.getElementById('modal-register').classList.remove('active');
        document.getElementById('modal-login').classList.add('active');
        document.getElementById('login-account').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error').style.display = 'none';
        setTimeout(() => document.getElementById('login-account').focus(), 100);
    },

    showRegisterModal() {
        document.getElementById('modal-login').classList.remove('active');
        document.getElementById('modal-register').classList.add('active');
        document.getElementById('reg-account').value = '';
        document.getElementById('reg-password').value = '';
        document.getElementById('reg-confirm').value = '';
        document.getElementById('reg-error').style.display = 'none';
        // URL ?invite=CODE 自动填入邀请码框
        const invite = Auth._inviteFromUrl();
        document.getElementById('reg-invite').value = invite || '';
        setTimeout(() => document.getElementById('reg-account').focus(), 100);
    },

    _closeAuthModals() {
        document.getElementById('modal-login').classList.remove('active');
        document.getElementById('modal-register').classList.remove('active');
    },

    _checkConfig() {
        if (!window.APP_CONFIG || !window.APP_CONFIG.supabase || !window.APP_CONFIG.supabase.url) {
            console.warn(
                '%c[军师] 配置文件未设置！请复制 config.example.js 为 config.js 并填写配置',
                'color: red; font-weight: bold; font-size: 14px;'
            );
        }
    },

    // [v20260805 账号体系] URL ?invite=CODE 在注册弹窗自动填入（注册时兑现邀请）

    _bindEvents() {
        // 新建好友按钮
        document.getElementById('fab-add-friend').addEventListener('click', () => {
            Friends.showCreateModal();
        });

        // [v20260805 账号体系] 右上角"登入/退出"按钮
        const authBtn = document.getElementById('auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', () => {
                if (Auth.isAccount && Auth.account) {
                    // 已登录 → 退出
                    if (confirm('确定退出登录吗？')) {
                        Auth.logout().then(() => {
                            Friends.load();
                            App.navigate('friends');
                        });
                    }
                } else {
                    // 游客 → 登录弹窗
                    this.showLoginModal();
                }
            });
        }

        // [v20260805 账号体系] 登录弹窗
        document.getElementById('login-submit-btn').addEventListener('click', async () => {
            const name = document.getElementById('login-account').value.trim();
            const pwd = document.getElementById('login-password').value;
            const errEl = document.getElementById('login-error');
            errEl.style.display = 'none';
            if (!name || !pwd) {
                errEl.textContent = '请输入账号和密码';
                errEl.style.display = '';
                return;
            }
            const btn = document.getElementById('login-submit-btn');
            btn.disabled = true;
            btn.textContent = '登录中...';
            const r = await Auth.login(name, pwd);
            btn.disabled = false;
            btn.textContent = '登录';
            if (r.success) {
                this._closeAuthModals();
                await Friends.load();
                this.navigate('friends');
            } else {
                errEl.textContent = r.message || '登录失败';
                errEl.style.display = '';
            }
        });
        document.getElementById('login-to-register-btn').addEventListener('click', () => {
            this._closeAuthModals();
            this.showRegisterModal();
        });
        document.getElementById('login-cancel-btn').addEventListener('click', () => {
            document.getElementById('modal-login').classList.remove('active');
        });
        // 登录框回车
        document.getElementById('login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('login-submit-btn').click();
        });

        // [v20260805 账号体系] 注册弹窗
        document.getElementById('reg-submit-btn').addEventListener('click', async () => {
            const name = document.getElementById('reg-account').value.trim();
            const pwd = document.getElementById('reg-password').value;
            const confirmPwd = document.getElementById('reg-confirm').value;
            const invite = document.getElementById('reg-invite').value.trim();
            const errEl = document.getElementById('reg-error');
            errEl.style.display = 'none';
            if (!name || !pwd || !confirmPwd) {
                errEl.textContent = '请填写完整信息';
                errEl.style.display = '';
                return;
            }
            if (pwd !== confirmPwd) {
                errEl.textContent = '两次密码不一致';
                errEl.style.display = '';
                return;
            }
            const btn = document.getElementById('reg-submit-btn');
            btn.disabled = true;
            btn.textContent = '注册中...';
            const r = await Auth.register({ account_name: name, password: pwd, invite_code: invite });
            btn.disabled = false;
            btn.textContent = '注册';
            if (r.success) {
                this._closeAuthModals();
                await Friends.load();
                this.navigate('friends');
            } else {
                errEl.textContent = r.message || '注册失败';
                errEl.style.display = '';
            }
        });
        document.getElementById('reg-to-login-btn').addEventListener('click', () => {
            this._closeAuthModals();
            this.showLoginModal();
        });
        document.getElementById('reg-cancel-btn').addEventListener('click', () => {
            document.getElementById('modal-register').classList.remove('active');
        });
        // 注册框回车
        document.getElementById('reg-confirm').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('reg-submit-btn').click();
        });

        // [我的简介] 打开编辑弹窗
        document.getElementById('bio-btn').addEventListener('click', () => {
            Friends.showBioModal();
        });

        // [使用指导] 打开指导页（同源跳转，PWA 全屏内打开）
        document.getElementById('guide-btn').addEventListener('click', () => {
            location.href = 'guide.html';
        });

        // [我的简介] 保存 / 取消 / 字数实时计数 / 点击遮罩关闭
        document.getElementById('bio-save').addEventListener('click', () => {
            Friends.saveBio();
        });
        document.getElementById('bio-cancel').addEventListener('click', () => {
            document.getElementById('modal-bio').classList.remove('active');
        });
        document.getElementById('bio-input').addEventListener('input', (e) => {
            const len = e.target.value.length;
            document.getElementById('bio-count').textContent = len + ' / 300';
        });
        document.getElementById('modal-bio').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.classList.remove('active');
            }
        });

        // 新建好友弹窗 - 事件处理移至 Friends.showCreateModal()

        // 聊天返回按钮
        document.getElementById('chat-back').addEventListener('click', () => {
            Chat.back();
        });

        // [系统返回手势] 手机左边缘右滑 / 顶部返回键 = 浏览器后退 → popstate
        // 后退：state 非 chat → 回好友列表；前进：state 是 chat → 重新打开对应会话
        window.addEventListener('popstate', (e) => {
            const state = e.state;
            if (state && state.page === 'chat' && state.friendId) {
                // 前进手势（极少出现）：恢复之前打开的聊天会话，不再 push 避免栈膨胀
                Chat.open(state.friendId, false, true).catch(err => {
                    console.error('[军师] popstate 恢复会话失败:', err);
                    Friends.load();
                    App.navigate('friends');
                });
            } else {
                // 后退手势：从聊天页回到好友列表
                Chat.back();
            }
        });

        // 聊天发送按钮
        document.getElementById('chat-send-btn').addEventListener('click', () => {
            Chat.send();
        });

        // 聊天粘贴按钮
        document.getElementById('chat-paste-btn').addEventListener('click', () => {
            Chat.paste();
        });

        // [v62 一键换话题] 军师聊偏/答非所问 → 换新话题
        document.getElementById('chat-switch-btn').addEventListener('click', () => {
            Chat.switchTopic();
        });

        // 聊天输入框回车发送（Shift+回车换行）
        document.getElementById('chat-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                Chat.send();
            }
        });

        // 聊天输入框自动调整高度
        document.getElementById('chat-input').addEventListener('input', (e) => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
        });

        // 付费弹窗相关
        document.getElementById('activate-btn').addEventListener('click', () => {
            Paywall.activate();
        });
        document.getElementById('paywall-buy-link').addEventListener('click', (e) => {
            e.preventDefault();
            Paywall.goPurchase();
        });
        document.getElementById('paywall-close-btn').addEventListener('click', () => {
            Paywall.hide();
        });

        // 激活码输入框回车
        document.getElementById('activation-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') Paywall.activate();
        });

        // [邀请功能] 一键复制（链接 + 邀请码）
        document.getElementById('invite-copy-btn').addEventListener('click', () => {
            Invite.copy();
        });

        // [v20260805 账号体系] 登入/退出按钮已在 _bindEvents 顶部绑定

        // [长按管理] Action Sheet - 按钮点击分发
        document.getElementById('action-sheet').addEventListener('click', (e) => {
            const item = e.target.closest('.sheet-item');
            if (!item) return;
            Friends.handleSheetAction(item.dataset.action);
        });
        // 点击遮罩关闭
        document.getElementById('action-sheet').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                Friends._hideActionSheet();
            }
        });
    }
};

// ============================================================
// DOM 就绪后启动
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
