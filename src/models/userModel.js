const { supabase, supabaseAdmin } = require('../db/config');
const { toNum, toDate } = require('../utils/typeConversions');
const { isUUID, validateSubscriptionType, validateUserType } = require('../utils/validators');
const table = 'users';

function client() {
    // Fallback to public client if service role is not configured
    return supabaseAdmin || supabase;
}

function sanitizeUserInsert(payload = {}) {
    const out = {};
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) throw new Error('name is required');
    out.name = name;

    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email) throw new Error('email is required');
    out.email = email;

    if (payload.subscription_type !== undefined) {
        const subscription_type = typeof payload.subscription_type === 'string' ? payload.subscription_type.trim() : null;
        if (subscription_type && !validateSubscriptionType(subscription_type)) throw new Error('Invalid subscription type');
        out.subscription_type = subscription_type;
    }
    if (payload.plan_id !== undefined) {
        if (payload.plan_id !== null && !isUUID(payload.plan_id)) throw new Error('plan_id must be a UUID or null');
        out.plan_id = payload.plan_id;
    }
    if (payload.avatar_url !== undefined) {
        out.avatar_url = typeof payload.avatar_url === 'string' ? payload.avatar_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/avatars/users/default_avatar.png';
    }
    if (payload.playlists !== undefined) {
        if (!Array.isArray(payload.playlists)) throw new Error('playlists must be an array');
        out.playlists = payload.playlists.map(String);
    }
    if (payload.favorites !== undefined) {
        if (!(payload.favorites && typeof payload.favorites === 'object')) throw new Error('favorites must be an object');
        out.favorites = payload.favorites;
    }
    if (payload.followers_count !== undefined) {
        const followers_count = toNum(payload.followers_count);
        if (followers_count === null) throw new Error('followers_count must be a valid number');
        out.followers_count = Math.max(0, Math.trunc(followers_count));
    }
    if (payload.followings_count !== undefined) {
        const followings_count = toNum(payload.followings_count);
        if (followings_count === null) throw new Error('followings_count must be a valid number');
        out.followings_count = Math.max(0, Math.trunc(followings_count));
    }
    if (payload.last_login_at !== undefined) {
        const last_login_at = toDate(payload.last_login_at);
        if (!last_login_at) throw new Error('last_login_at must be a valid timestamp');
        out.last_login_at = last_login_at;
    }
    if (payload.settings !== undefined) {
        if (!(payload.settings && typeof payload.settings === 'object')) throw new Error('settings must be an object');
        out.settings = payload.settings;
    }
    if (payload.user_type !== undefined) {
        const user_type = typeof payload.user_type === 'string' ? payload.user_type.trim() : null;
        if (user_type && !validateUserType(user_type)) throw new Error('Invalid user type');
        out.user_type = user_type;
    }
    return out;
}

function sanitizeUserUpdate(payload = {}) {
    const out = {};
    if (payload.name !== undefined) {
        const name = typeof payload.name === 'string' ? payload.name.trim() : null;
        if (!name) throw new Error('name cannot be empty');
        out.name = name;
    }
    if (payload.email !== undefined) {
        const email = typeof payload.email === 'string' ? payload.email.trim() : null;
        if (!email) throw new Error('email cannot be empty');
        out.email = email;
    }
    if (payload.subscription_type !== undefined) {
        const subscription_type = typeof payload.subscription_type === 'string' ? payload.subscription_type.trim() : null;
        if (!validateSubscriptionType(subscription_type)) throw new Error('Invalid subscription type');
        out.subscription_type = subscription_type;
    }
    if (payload.plan_id !== undefined) {
        if (payload.plan_id !== null && !isUUID(payload.plan_id)) throw new Error('plan_id must be a UUID or null');
        out.plan_id = payload.plan_id;
    }
    if (payload.avatar_url !== undefined) {
        out.avatar_url = typeof payload.avatar_url === 'string' ? payload.avatar_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/avatars/users/default_avatar.png';
    }
    if (payload.playlists !== undefined) {
        if (!Array.isArray(payload.playlists)) throw new Error('playlists must be an array');
        out.playlists = payload.playlists.map(String);
    }
    if (payload.favorites !== undefined) {
        if (!(payload.favorites && typeof payload.favorites === 'object')) throw new Error('favorites must be an object');
        out.favorites = payload.favorites;
    }
    if (payload.followers_count !== undefined) {
        const followers_count = toNum(payload.followers_count);
        if (followers_count === null) throw new Error('followers_count must be a valid number');
        out.followers_count = Math.max(0, Math.trunc(followers_count));
    }
    if (payload.followings_count !== undefined) {
        const followings_count = toNum(payload.followings_count);
        if (followings_count === null) throw new Error('followings_count must be a valid number');
        out.followings_count = Math.max(0, Math.trunc(followings_count));
    }
    if (payload.last_login_at !== undefined) {
        const last_login_at = toDate(payload.last_login_at);
        if (!last_login_at) throw new Error('last_login_at must be a valid timestamp');
        out.last_login_at = last_login_at;
    }
    if (payload.settings !== undefined) {
        if (!(payload.settings && typeof payload.settings === 'object')) throw new Error('settings must be an object');
        out.settings = payload.settings;
    }
    if (payload.user_type !== undefined) {
        const user_type = typeof payload.user_type === 'string' ? payload.user_type.trim() : null;
        if (!validateUserType(user_type)) throw new Error('Invalid user type');
        out.user_type = user_type;
    }
    return out;
}

async function listUsers({ limit = 20, offset = 0, q } = {}) {
    // Supabase/PostgREST v2 uses range(start, end) for pagination instead of offset()
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    // Build base query
    let qb = client().from(table).select('*', { count: 'exact' }).order('created_at', { ascending: false });

    if (q) {
        // simple text search on name
        qb = qb.ilike('name', `%${q}%`);
    }
    const { data, error, count } = await qb.range(start, end);

    if (error) throw error;
    return { items: data, total: count };
}

async function getUser(user_id) {
    const { data, error } = await client().from(table).select('*').eq('user_id', user_id).maybeSingle();
    if (error) throw error;
    return data;
}

async function getUserByEmail(email) {
    const normalized = typeof email === 'string' ? email.trim() : '';
    if (!normalized) return null;
    const { data, error } = await client().from(table).select('*').eq('email', normalized).maybeSingle();
    if (error) throw error;
    return data;
}

async function createUser(payload) {
    const input = sanitizeUserInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updateUser(user_id, payload) {
    const input = sanitizeUserUpdate(payload);
    const { data, error } = await client().from(table).update({ ...input, updated_at: new Date().toISOString() }).eq('user_id', user_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteUser(user_id) {
    const { error } = await client().from(table).delete().eq('user_id', user_id);
    if (error) throw error;
}

//user functions
async function listUsersPublic({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    // Only return public/basic fields for user-facing endpoints
    let qb = client().from(table).select('user_id, name, avatar_url', { count: 'exact' }).order('created_at', { ascending: false });
    if (q) qb = qb.ilike('name', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    return { items: data, total: count };
}

async function getUserPublic(user_id) {
    // followings_count column per schema
    const { data, error } = await client().from(table).select('user_id, name, followers_count, followings_count, avatar_url, playlists').eq('user_id', user_id).maybeSingle();
    if (error) throw error;
    return data;
}

module.exports = { listUsers, listUsersPublic, getUser, getUserByEmail, getUserPublic, createUser, updateUser, deleteUser, sanitizeUserInsert, sanitizeUserUpdate };
