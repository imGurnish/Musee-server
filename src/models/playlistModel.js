const { supabase, supabaseAdmin } = require('../db/config');

const table = 'playlists';

function client() {
    return supabaseAdmin || supabase;
}

// helpers
function isUUID(v) {
    return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v);
}

function toNum(v, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// no dates to coerce here

// normalized schema uses playlist_tracks; no track_ids array on playlists

function sanitizeInsert(payload = {}) {
    const out = {};
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
    if (!name) throw new Error('name is required');
    out.name = name;

    if (payload.creator_id !== undefined && payload.creator_id !== null) {
        if (!isUUID(payload.creator_id)) throw new Error('creator_id must be a UUID');
        out.creator_id = payload.creator_id;
    }

    if (payload.is_public !== undefined) out.is_public = Boolean(payload.is_public);
    if (payload.description !== undefined) out.description = typeof payload.description === 'string' ? payload.description.trim() : null;
    if (payload.language_code !== undefined) out.language_code = typeof payload.language_code === 'string' ? payload.language_code.trim() : null;

    out.cover_url = typeof payload.cover_url === 'string' && payload.cover_url.trim() ? payload.cover_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/playlists/default_cover.png';

    out.likes_count = Math.max(0, Math.trunc(toNum(payload.likes_count, 0)));
    out.total_tracks = Math.max(0, Math.trunc(toNum(payload.total_tracks, 0)));

    if (payload.duration !== undefined) out.duration = toNum(payload.duration);

    out.created_at = new Date().toISOString();
    out.updated_at = new Date().toISOString();

    return out;
}

function sanitizeUpdate(payload = {}) {
    const out = {};
    if (payload.name !== undefined) {
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (!name) throw new Error('name cannot be empty');
        out.name = name;
    }
    if (payload.creator_id !== undefined) {
        if (payload.creator_id !== null && !isUUID(payload.creator_id)) throw new Error('creator_id must be a UUID or null');
        out.creator_id = payload.creator_id;
    }
    if (payload.is_public !== undefined) out.is_public = Boolean(payload.is_public);
    if (payload.description !== undefined) out.description = typeof payload.description === 'string' ? payload.description.trim() : payload.description;
    if (payload.language_code !== undefined) out.language_code = typeof payload.language_code === 'string' ? payload.language_code.trim() : payload.language_code;

    if (payload.cover_url !== undefined) out.cover_url = typeof payload.cover_url === 'string' ? payload.cover_url.trim() : null;

    if (payload.likes_count !== undefined) out.likes_count = Math.max(0, Math.trunc(toNum(payload.likes_count, 0)));
    if (payload.total_tracks !== undefined) out.total_tracks = Math.max(0, Math.trunc(toNum(payload.total_tracks, 0)));

    if (payload.duration !== undefined) out.duration = toNum(payload.duration);

    return out;
}

async function listPlaylists({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    let qb = client().from(table).select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (q) qb = qb.ilike('name', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    return { items: data, total: count };
}

async function getPlaylist(playlist_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, is_public, description, cover_url, language_code, likes_count, total_tracks, duration, created_at, updated_at,
            playlist_tracks:playlist_tracks!playlist_tracks_playlist_id_fkey(
                tracks:tracks!playlist_tracks_track_id_fkey(
                    track_id, title, duration, created_at
                )
            )
        `)
        .eq('playlist_id', playlist_id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const tracks = (data.playlist_tracks || []).map(pt => pt?.tracks).filter(Boolean);
    const { playlist_tracks, ...rest } = data;
    return { ...rest, tracks };
}

async function createPlaylist(payload) {
    const input = sanitizeInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updatePlaylist(playlist_id, payload) {
    const input = sanitizeUpdate(payload);
    const { data, error } = await client().from(table).update({ ...input, updated_at: new Date().toISOString() }).eq('playlist_id', playlist_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deletePlaylist(playlist_id) {
    const { error } = await client().from(table).delete().eq('playlist_id', playlist_id);
    if (error) throw error;
}

async function listPlaylistsUser({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    let qb = client().from(table).select('playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks', { count: 'exact' }).eq('is_public', true).order('created_at', { ascending: false });
    if (q) qb = qb.ilike('name', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    return { items: data, total: count };
}

async function getPlaylistUser(playlist_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks,
            playlist_tracks:playlist_tracks!playlist_tracks_playlist_id_fkey(
                tracks:tracks!playlist_tracks_track_id_fkey(
                    track_id, title, duration, created_at
                )
            )
        `)
        .eq('playlist_id', playlist_id)
        .eq('is_public', true)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const tracks = (data.playlist_tracks || []).map(pt => pt?.tracks).filter(Boolean);
    const { playlist_tracks, ...rest } = data;
    return { ...rest, tracks };
}

module.exports = { listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, getPlaylistUser, listPlaylistsUser };
