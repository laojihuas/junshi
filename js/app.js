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

        // [v20260805] 设备身份：匿名登录（打开即用，无注册页）
        // URL 携带 ?invite=CODE 时由 auth.js 自动暂存，首次新建好友后兑现
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

    _checkConfig() {
        if (!window.APP_CONFIG || !window.APP_CONFIG.supabase || !window.APP_CONFIG.supabase.url) {
            console.warn(
                '%c[军师] 配置文件未设置！请复制 config.example.js 为 config.js 并填写配置',
                'color: red; font-weight: bold; font-size: 14px;'
            );
        }
    },

    // [v20260805] 已剔除邮箱登录：URL ?invite=CODE 由 auth.js 自动暂存（首次建好友后兑现）

    _bindEvents() {
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

        // [v20260805] 已剔除登录：无退出登录按钮

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
