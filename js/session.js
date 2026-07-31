// ============================================================
// 军师 - 多窗口独立会话管理模块
//
// 功能说明：
//   每个浏览器窗口/标签页拥有完全独立的对话上下文（Chat History），
//   互不干扰。数据保存在浏览器 sessionStorage 中：
//     - 刷新页面    → 会话数据保留（sessionStorage 特性）
//     - 关闭窗口    → 会话数据自动清除（sessionStorage 生命周期）
//     - 复制标签页  → 新标签页生成新的会话 ID，不与原窗口共享数据
//   （复制标签页会连带复制 sessionStorage，因此通过
//     PerformanceNavigationTiming.type 区分"刷新"与"新开页面"，
//     新开页面一律重新生成窗口会话 ID 并清空历史）
//
// 存储结构（sessionStorage key: junshi_window_session）：
//   {
//     windowSessionId: 'uuid-v4',          // 当前窗口唯一会话 ID
//     conversations: {                     // 按好友（数据库会话）隔离的对话历史
//       '<friendSessionId>': [             //   history 数组，格式与 IMA API 对齐
//         { role: 'user', content: '...' },
//         { role: 'assistant', content: '...' }
//       ]
//     },
//     activeFriend: '<friendSessionId>'    // 当前打开的好友
//   }
//
// 说明：提示词（system_prompt）不在此存储，也不在界面显示；
//       由后台统一管理，前端每次发送消息时实时获取。
// ============================================================

const WindowSession = {
    STORAGE_KEY: 'junshi_window_session',

    // 当前窗口会话数据（内存缓存，避免频繁解析 sessionStorage）
    _data: null,

    // ----------------------------------------------------------
    // 初始化：页面加载时调用一次
    // 规则：刷新/前进后退 → 保留会话；新开页面/复制标签页 → 生成新会话
    // ----------------------------------------------------------
    init() {
        const navType = this._getNavigationType();
        const existing = this._load();

        // 仅当页面属于"刷新 / 前进后退"时保留旧会话；
        // 其余情况（首次打开、复制标签页、通过链接新开标签页）
        // 一律生成新的窗口会话 ID，避免多窗口共享上下文。
        if (existing && (navType === 'reload' || navType === 'back_forward')) {
            this._data = existing;
        } else {
            this._data = {
                windowSessionId: this._generateId(),
                conversations: {},
                activeFriend: null
            };
            this._save();
        }

        console.log('[军师] 窗口会话已初始化: ' + this.getId() + ' (navigation: ' + navType + ')');
        // 诊断日志（排查"秒切回好友列表"问题：区分 reload / 杀进程 / 新开页面）
        try { Utils.dlog('ws', 'init navType=' + navType + ' kept=' + (existing ? (navType === 'reload' || navType === 'back_forward') : false)); } catch (e) {}
        return this._data;
    },

    // 获取当前窗口会话 ID（UUID）
    getId() {
        this._ensureInit();
        return this._data.windowSessionId;
    },

    // 设置当前打开的好友（数据库会话 ID）
    setActiveFriend(friendSessionId) {
        this._ensureInit();
        if (friendSessionId) {
            this._data.activeFriend = friendSessionId;
            // 惰性初始化该好友的历史数组
            if (!this._data.conversations[friendSessionId]) {
                this._data.conversations[friendSessionId] = [];
            }
            this._save();
        }
    },

    // 获取指定好友的对话历史（JSON 数组，无则返回空数组）
    getHistory(friendSessionId) {
        this._ensureInit();
        const fid = friendSessionId || this._data.activeFriend;
        if (!fid) return [];
        return this._data.conversations[fid] || [];
    },

    // 追加一条对话记录（role: 'user' | 'assistant'）
    append(friendSessionId, role, content) {
        this._ensureInit();
        const fid = friendSessionId || this._data.activeFriend;
        if (!fid || !content) return;
        if (!this._data.conversations[fid]) {
            this._data.conversations[fid] = [];
        }
        // 限制单好友历史长度，防止 sessionStorage 溢出（保留最近 50 条）
        const history = this._data.conversations[fid];
        history.push({ role: role, content: content });
        if (history.length > 50) {
            history.splice(0, history.length - 50);
        }
        this._save();
    },

    // 清空当前窗口全部会话数据（退出登录时调用）
    clear() {
        try {
            sessionStorage.removeItem(this.STORAGE_KEY);
        } catch (e) { /* sessionStorage 不可用时忽略 */ }
        this._data = null;
    },

    // ----------------------------------------------------------
    // 最后查看页面（localStorage 持久化，用于杀进程后恢复）
    // 场景：聊天页切到其他 App，浏览器回收页面进程，回来时页面
    //       重新加载。sessionStorage 会丢失，但 localStorage 保留，
    //       据此自动恢复到原聊天页。
    // ----------------------------------------------------------
    STORAGE_VIEW_KEY: 'junshi_last_view',

    // 记录当前停留页面：page='chat' 需带好友信息；page='friends' 清除记录
    saveLastView(page, friendId, friendName) {
        try {
            if (page === 'chat' && friendId) {
                localStorage.setItem(this.STORAGE_VIEW_KEY, JSON.stringify({
                    page: 'chat',
                    friendId: friendId,
                    friendName: friendName || ''
                }));
            } else {
                localStorage.removeItem(this.STORAGE_VIEW_KEY);
            }
        } catch (e) { /* localStorage 不可用时忽略 */ }
    },

    // 读取上次停留页面（无记录 / 记录无效返回 null）
    getLastView() {
        try {
            const raw = localStorage.getItem(this.STORAGE_VIEW_KEY);
            if (!raw) return null;
            const v = JSON.parse(raw);
            if (!v || v.page !== 'chat' || !v.friendId) return null;
            return v;
        } catch (e) {
            return null;
        }
    },

    // 清除最后查看记录（退出登录时调用）
    clearLastView() {
        try {
            localStorage.removeItem(this.STORAGE_VIEW_KEY);
        } catch (e) { /* 忽略 */ }
    },

    // 批量导入某好友的对话历史（杀进程后 sessionStorage 丢失，
    // 从数据库最近消息重建 AI 上下文时使用）
    setHistory(friendSessionId, history) {
        this._ensureInit();
        const fid = friendSessionId || this._data.activeFriend;
        if (!fid) return;
        this._data.conversations[fid] = Array.isArray(history) ? history.slice(0, 50) : [];
        this._save();
    },

    // ----------------------------------------------------------
    // 内部方法
    // ----------------------------------------------------------
    _ensureInit() {
        if (!this._data) this.init();
    },

    _load() {
        try {
            const raw = sessionStorage.getItem(this.STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            // 校验结构完整性
            if (!parsed || typeof parsed !== 'object' || !parsed.windowSessionId) return null;
            if (!parsed.conversations || typeof parsed.conversations !== 'object') {
                parsed.conversations = {};
            }
            return parsed;
        } catch (e) {
            return null;
        }
    },

    _save() {
        try {
            sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._data));
        } catch (e) {
            // 存储满等异常不影响核心功能
            console.warn('[军师] 窗口会话保存失败:', e);
        }
    },

    // 页面导航类型：
    //   navigate      → 首次加载 / 新开标签页 / 复制标签页
    //   reload        → 用户刷新
    //   back_forward  → 前进/后退（bfcache 恢复）
    _getNavigationType() {
        try {
            const entries = performance.getEntriesByType('navigation');
            if (entries && entries.length > 0 && entries[0].type) {
                return entries[0].type;
            }
        } catch (e) { /* 忽略 */ }
        return 'navigate';
    },

    // 生成 UUID（优先 crypto.randomUUID，带降级方案）
    _generateId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // 降级：基于随机数拼装
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
};
