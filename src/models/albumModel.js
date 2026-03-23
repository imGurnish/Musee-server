const { supabase, supabaseAdmin } = require('../db/config');
const { isUUID, isNonEmptyString, } = require('../utils/validators');
const { toDateOnly, toNum } = require('../utils/typeConversions');
const table = 'albums';

function client() {
    // Fallback to public client if service role is not configured
    return supabaseAdmin || supabase;
}

function sanitizeAlbumInsert(payload = {}) {
    const out = {};
    // Allow creating an "empty" album with default title
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null;
    if (!title) throw new Error('title is required');
    out.title = title;

    if (payload.release_date !== undefined) out.release_date = toDateOnly(payload.release_date);
    if (payload.description !== undefined) out.description = typeof payload.description === 'string' ? payload.description.trim() : null;
    if (payload.cover_url !== undefined) out.cover_url = typeof payload.cover_url === 'string' ? payload.cover_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/albums/default_cover.png';

    if (payload.duration !== undefined) {
        const duration = toNum(payload.duration, null);
        if (duration === null || duration < 0) throw new Error('duration is invalid');
        out.duration = Math.trunc(duration);
    }

    if (payload.is_published !== undefined) out.is_published = Boolean(payload.is_published);

    return out;
}

function sanitizeAlbumUpdate(payload = {}) {
    const out = {};
    if (payload.title !== undefined) {
        if (!isNonEmptyString(payload.title)) throw new Error('title cannot be empty');
        out.title = payload.title.trim();
    }
    if (payload.release_date !== undefined) out.release_date = toDateOnly(payload.release_date);
    if (payload.description !== undefined) out.description = typeof payload.description === 'string' ? payload.description.trim() : payload.description;
    if (payload.cover_url !== undefined) out.cover_url = typeof payload.cover_url === 'string' ? payload.cover_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/albums/default_cover.png';

    // if (payload.total_tracks !== undefined) out.total_tracks = Math.max(0, Math.trunc(toNum(payload.total_tracks, 0)));
    // if (payload.likes_count !== undefined) out.likes_count = Math.max(0, Math.trunc(toNum(payload.likes_count, 0)));
    // if (payload.play_count !== undefined) out.play_count = Math.max(0, Math.trunc(toNum(payload.play_count, 0)));

    if (payload.duration !== undefined) {
        const duration = toNum(payload.duration, null);
        if (duration === null || duration < 0) throw new Error('duration is invalid');
        out.duration = Math.trunc(duration);
    }

    if (payload.is_published !== undefined) out.is_published = Boolean(payload.is_published);

    return out;
}

async function listAlbums({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    // Include artist info via album_artists -> artists -> users
    let qb = client()
        .from(table)
        .select(`
            album_id, title, description, cover_url, total_tracks, likes_count, created_at, updated_at, is_published, duration,
            album_artists:album_artists!album_artists_album_id_fkey(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        album_id: row.album_id,
        title: row.title,
        description: row.description,
        cover_url: row.cover_url,
        genres: [],
        total_tracks: row.total_tracks,
        likes_count: row.likes_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_published: row.is_published,
        duration: row.duration,
        artists: (row.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            role: a?.role || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
        }))
    }));
    return { items, total: count };
}

async function getAlbum(album_id) {
    const { data, error } = await client().from(table).select(`
        album_id, title, description, cover_url, total_tracks, likes_count, created_at, updated_at, is_published, duration,
        album_artists:album_artists!album_artists_album_id_fkey(
            role,
            artists:artists!album_artists_artist_id_fkey(
                artist_id,
                users:users!artists_artist_id_fkey(user_id, name, avatar_url)
            )
        )
    `).eq('album_id', album_id).maybeSingle();
    if (error) throw error;
    if (!data) return null;

    // Fetch tracks with their artists (admin can see all tracks)
    const { data: tracksData, error: tracksError } = await client()
        .from('tracks')
        .select(`
            track_id, title, duration, is_explicit, is_published, created_at,
            track_artists:track_artists!track_artists_track_id_fkey(
                role,
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            )
        `)
        .eq('album_id', album_id)
        .order('created_at', { ascending: false });
    if (tracksError) throw tracksError;

    const artists = (data.album_artists || []).map(a => ({
        artist_id: a?.artists?.artist_id || null,
        role: a?.role || null,
        name: a?.artists?.users?.name || null,
        avatar_url: a?.artists?.users?.avatar_url || null,
    }));

    const tracks = (tracksData || []).map(t => ({
        track_id: t.track_id,
        title: t.title,
        duration: t.duration,
        is_explicit: t.is_explicit,
        is_published: t.is_published,
        created_at: t.created_at,
        artists: (t.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            role: ta?.role || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        }))
    }));

    return {
        album_id: data.album_id,
        title: data.title,
        description: data.description,
        cover_url: data.cover_url,
        genres: [],
        total_tracks: data.total_tracks,
        likes_count: data.likes_count,
        created_at: data.created_at,
        updated_at: data.updated_at,
        is_published: data.is_published,
        duration: data.duration,
        artists,
        tracks,
    };
}

async function createAlbum(payload) {
    const input = sanitizeAlbumInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updateAlbum(album_id, payload) {
    const input = sanitizeAlbumUpdate(payload);
    const { data, error } = await client().from(table).update({ ...input, updated_at: new Date().toISOString() }).eq('album_id', album_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteAlbum(album_id) {
    const { error } = await client().from(table).delete().eq('album_id', album_id);
    if (error) throw error;
}

async function listAlbumsUser({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    // Public list: only published albums, return minimal fields and public artist profile
    let qb = client()
        .from(table)
        .select(`
            album_id, title, cover_url, duration, created_at,
            album_artists:album_artists!album_artists_album_id_fkey(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        album_id: row.album_id,
        title: row.title,
        cover_url: row.cover_url,
        duration: row.duration,
        created_at: row.created_at,
        artists: (row.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
            role: a?.role || null,
        }))
    }));
    return { items, total: count };
}

async function getAlbumUser(album_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            album_id, title, cover_url, release_date, duration, created_at,
            album_artists:album_artists!album_artists_album_id_fkey(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `)
        .eq('album_id', album_id)
        .eq('is_published', true)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    // fetch published tracks with their artists
    const { data: tracksData, error: tracksError } = await client()
        .from('tracks')
        .select(`
            track_id, title, duration, is_explicit, created_at,
            track_artists:track_artists!track_artists_track_id_fkey(
                role,
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `)
        .eq('album_id', album_id)
        .eq('is_published', true)
        .order('created_at', { ascending: false });
    if (tracksError) throw tracksError;

    return {
        album_id: data.album_id,
        title: data.title,
        cover_url: data.cover_url,
        release_date: data.release_date,
        duration: data.duration,
        created_at: data.created_at,
        artists: (data.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
            role: a?.role || null,
        })),
        tracks: (tracksData || []).map(t => ({
            track_id: t.track_id,
            title: t.title,
            duration: t.duration,
            is_explicit: t.is_explicit,
            created_at: t.created_at,
            artists: (t.track_artists || []).map(ta => ({
                artist_id: ta?.artists?.artist_id || null,
                name: ta?.artists?.users?.name || null,
                avatar_url: ta?.artists?.users?.avatar_url || null,
                role: ta?.role || null,
            }))
        }))
    };
}

module.exports = { listAlbums, getAlbum, createAlbum, updateAlbum, deleteAlbum, listAlbumsUser, getAlbumUser, sanitizeAlbumInsert, sanitizeAlbumUpdate };
async function listAlbumsByArtist({ artist_id, limit = 20, offset = 0, q } = {}) {
    const { isUUID } = require('../utils/validators');
    if (!isUUID(artist_id)) throw new Error('artist_id is invalid');
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            album_id, title, description, cover_url, total_tracks, likes_count, created_at, updated_at, is_published, duration,
            album_artists:album_artists!inner(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .eq('album_artists.artist_id', artist_id)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        album_id: row.album_id,
        title: row.title,
        description: row.description,
        cover_url: row.cover_url,
        genres: [],
        total_tracks: row.total_tracks,
        likes_count: row.likes_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_published: row.is_published,
        duration: row.duration,
        artists: (row.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            role: a?.role || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
        }))
    }));
    return { items, total: count };
}

async function listAlbumsByArtistUser({ artist_id, limit = 20, offset = 0, q } = {}) {
    const { isUUID } = require('../utils/validators');
    if (!isUUID(artist_id)) throw new Error('artist_id is invalid');
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            album_id, title, cover_url, duration, created_at,
            album_artists:album_artists!inner(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .eq('album_artists.artist_id', artist_id)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);
    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        album_id: row.album_id,
        title: row.title,
        cover_url: row.cover_url,
        duration: row.duration,
        created_at: row.created_at,
        artists: (row.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
            role: a?.role || null,
        }))
    }));
    return { items, total: count };
}

module.exports.listAlbumsByArtist = listAlbumsByArtist;
module.exports.listAlbumsByArtistUser = listAlbumsByArtistUser;

async function listTrendingAlbumsUser({ limit = 20, offset = 0 } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            album_id, title, cover_url, duration, created_at, likes_count,
            album_artists:album_artists!album_artists_album_id_fkey(
                role,
                artists:artists!album_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .order('likes_count', { ascending: false })
        .order('created_at', { ascending: false });

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        type: 'album', // Explicit type
        album_id: row.album_id,
        title: row.title,
        cover_url: row.cover_url,
        duration: row.duration,
        created_at: row.created_at,
        artists: (row.album_artists || []).map(a => ({
            artist_id: a?.artists?.artist_id || null,
            name: a?.artists?.users?.name || null,
            avatar_url: a?.artists?.users?.avatar_url || null,
            role: a?.role || null,
        }))
    }));
    return { items, total: count };
}

module.exports.listTrendingAlbumsUser = listTrendingAlbumsUser;
