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

        // 检查登录状态
        const loggedIn = await Auth.init();

        if (loggedIn) {
            await Friends.load();
            this.navigate('friends');
        } else {
            this.navigate('auth');
        }

        console.log('[军师] 初始化完成');
    },

    navigate(page) {
        // 隐藏所有页面
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const target = document.getElementById('page-' + page);
        if (target) {
            target.classList.add('active');
            this.currentPage = page;
        }
    },

    _checkConfig() {
        if (!window.APP_CONFIG || !window.APP_CONFIG.supabase || !window.APP_CONFIG.supabase.url) {
            console.warn(
                '%c[军师] 配置文件未设置！请复制 config.example.js 为 config.js 并填写配置',
                'color: red; font-weight: bold; font-size: 14px;'
            );
        }
    },

    _bindEvents() {
        // 登录/注册切换 tab
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('form-' + tab.dataset.form).classList.add('active');
            });
        });

        // 登录按钮
        document.getElementById('login-btn').addEventListener('click', async () => {
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            if (!email || !password) {
                Utils.toast('请填写邮箱和密码');
                return;
            }
            Utils.showLoading();
            const result = await Auth.login(email, password);
            Utils.hideLoading();
            if (result.success) {
                Utils.toast('登录成功');
                await Friends.load();
                App.navigate('friends');
            } else {
                Utils.toast(result.message);
            }
        });

        // 登录回车键
        document.getElementById('login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('login-btn').click();
        });

        // 注册按钮
        document.getElementById('register-btn').addEventListener('click', async () => {
            const email = document.getElementById('register-email').value.trim();
            const password = document.getElementById('register-password').value;
            const confirm = document.getElementById('register-confirm').value;
            if (!email || !password || !confirm) {
                Utils.toast('请填写完整信息');
                return;
            }
            if (password !== confirm) {
                Utils.toast('两次密码不一致');
                return;
            }
            if (password.length < 6) {
                Utils.toast('密码至少 6 位');
                return;
            }
            Utils.showLoading();
            const result = await Auth.register(email, password);
            Utils.hideLoading();
            Utils.toast(result.message);
            if (result.success) {
                // 清空注册表单
                document.getElementById('register-email').value = '';
                document.getElementById('register-password').value = '';
                document.getElementById('register-confirm').value = '';
            }
        });

        // 注册回车键
        document.getElementById('register-confirm').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('register-btn').click();
        });

        // 新建好友按钮
        document.getElementById('fab-add-friend').addEventListener('click', () => {
            Friends.showCreateModal();
        });

        // [我的简介] 打开编辑弹窗
        document.getElementById('bio-btn').addEventListener('click', () => {
            Friends.showBioModal();
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
            document.getElementById('bio-count').textContent = len + ' / 200';
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

        // 聊天发送按钮
        document.getElementById('chat-send-btn').addEventListener('click', () => {
            Chat.send();
        });

        // 聊天粘贴按钮
        document.getElementById('chat-paste-btn').addEventListener('click', () => {
            Chat.paste();
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

        // 退出登录
        document.getElementById('logout-btn').addEventListener('click', async () => {
            if (confirm('确定退出登录？')) {
                await Auth.logout();
            }
        });

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
