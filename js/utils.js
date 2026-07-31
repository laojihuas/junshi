// ============================================================
// 军师 - 工具函数
// ============================================================

const Utils = {
    toast(message, duration = 2000) {
        let toast = document.getElementById('toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    },

    showLoading() {
        document.getElementById('loading-overlay').classList.add('active');
    },

    hideLoading() {
        document.getElementById('loading-overlay').classList.remove('active');
    },

    // ----------------------------------------------------------
    // 诊断日志（localStorage 环形日志 + console）
    // 用途：排查"聊天页被秒切回好友列表"等页面跳转问题。
    // 查看：在网址后加 #debug 打开调试面板，或 DevTools Console。
    // 不含任何敏感信息（不记录 token / 凭证）。
    // ----------------------------------------------------------
    dlog(tag, msg) {
        try {
            const key = 'junshi_debug_log';
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            arr.push(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' [' + tag + '] ' + msg);
            if (arr.length > 100) arr.splice(0, arr.length - 100);
            localStorage.setItem(key, JSON.stringify(arr));
        } catch (e) { /* 存储不可用忽略 */ }
        try { console.log('[dlog] ' + tag, msg); } catch (e) {}
    }
};
