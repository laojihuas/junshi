// ============================================================
// 军师 - Supabase 客户端
// ============================================================

const SUPABASE_CONFIG = (window.APP_CONFIG && window.APP_CONFIG.supabase)
    ? window.APP_CONFIG.supabase
    : { url: '', anonKey: '' };

let supabaseClient = null;

function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;

    if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
        console.warn('[军师] Supabase 未配置，请在 config.js 中填写配置');
        return null;
    }

    // 使用全局 supabase 库
    if (typeof supabase !== 'undefined' && supabase.createClient) {
        supabaseClient = supabase.createClient(
            SUPABASE_CONFIG.url,
            SUPABASE_CONFIG.anonKey,
            {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    storageKey: 'junshi-auth'
                }
            }
        );
        return supabaseClient;
    }

    console.error('[军师] Supabase SDK 未加载');
    return null;
}

// ============================================================
// 数据库操作封装
// ============================================================

const DB = {
    // ---- 用户 Profile ----
    async getProfile(userId) {
        const sb = getSupabaseClient();
        if (!sb) return null;
        const { data, error } = await sb
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        if (error) {
            // 区分"记录不存在"和真正的错误
            if (error.code === 'PGRST116') {
                console.warn('[DB] 用户 profile 不存在:', userId);
                return null;
            }
            console.error('[DB] getProfile error:', error.code, error.message, error.details);
            return null;
        }
        return data;
    },

    async updateProfile(userId, updates) {
        const sb = getSupabaseClient();
        if (!sb) return null;
        const { data, error } = await sb
            .from('profiles')
            .update(updates)
            .eq('id', userId)
            .select()
            .single();
        if (error) {
            console.error('[DB] updateProfile error:', error);
            return null;
        }
        return data;
    },

    // ---- 聊天会话 ----
    async getSessions(userId) {
        const sb = getSupabaseClient();
        if (!sb) return [];
        const { data, error } = await sb
            .from('chat_sessions')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false });
        if (error) {
            console.error('[DB] getSessions error:', error.code, error.message, error.details);
            return [];
        }
        return data || [];
    },

    async createSession(userId, friendName) {
        const sb = getSupabaseClient();
        if (!sb) return null;
        const colors = ['#07C160', '#E53935', '#1E88E5', '#FB8C00', '#8E24AA', '#00ACC1', '#F4511E', '#43A047'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];
        const { data, error } = await sb
            .from('chat_sessions')
            .insert({
                user_id: userId,
                friend_name: friendName,
                avatar_color: avatarColor
            })
            .select()
            .single();
        if (error) {
            console.error('[DB] createSession error:', error.code, error.message, error.details);
            // 给出更友好的错误提示
            if (error.code === '42501') {
                console.error('[DB] RLS 策略拒绝了创建会话，请检查 Supabase 权限配置');
            } else if (error.code === '23503') {
                console.error('[DB] 用户 profile 不存在，无法创建会话');
            }
            return null;
        }
        return data;
    },

    async deleteSession(sessionId) {
        const sb = getSupabaseClient();
        if (!sb) return false;
        const { error } = await sb
            .from('chat_sessions')
            .delete()
            .eq('id', sessionId);
        if (error) {
            console.error('[DB] deleteSession error:', error);
            return false;
        }
        return true;
    },

    // ---- 聊天消息 ----
    async getMessages(sessionId) {
        const sb = getSupabaseClient();
        if (!sb) return [];
        const { data, error } = await sb
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });
        if (error) {
            console.error('[DB] getMessages error:', error);
            return [];
        }
        return data || [];
    },

    async addMessage(sessionId, role, content) {
        const sb = getSupabaseClient();
        if (!sb) return null;
        const { data, error } = await sb
            .from('chat_messages')
            .insert({
                session_id: sessionId,
                role: role,
                content: content
            })
            .select()
            .single();
        if (error) {
            console.error('[DB] addMessage error:', error);
            return null;
        }
        return data;
    },

    async updateSessionTime(sessionId) {
        const sb = getSupabaseClient();
        if (!sb) return;
        await sb
            .from('chat_sessions')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', sessionId);
    },

    // ---- 激活码 ----
    async verifyActivationCode(code) {
        const sb = getSupabaseClient();
        if (!sb) return null;
        const { data, error } = await sb
            .from('activation_codes')
            .select('*')
            .eq('code', code.trim().toUpperCase())
            .single();
        if (error) return null;
        return data;
    }
};
