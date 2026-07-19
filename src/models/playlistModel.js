const { supabase, supabaseAdmin } = require('../db/config');
const { normalizeLanguageCodes } = require('../utils/userPreferences');

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

function toBool(v, def = false) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
        const normalized = v.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return Boolean(v);
}

function mapPlaylistArtistFromUser(userRow, fallbackCreatorId = null) {
    if (!userRow && !fallbackCreatorId) return [];
    return [{
        artist_id: userRow?.user_id || fallbackCreatorId,
        name: userRow?.name || 'Unknown Creator',
        avatar_url: userRow?.avatar_url || null,
    }];
}

function mapTrackArtists(trackArtists = []) {
    return (trackArtists || []).map((ta) => ({
        artist_id: ta?.artists?.artist_id || null,
        name: ta?.artists?.users?.name || 'Unknown Artist',
        avatar_url: ta?.artists?.users?.avatar_url || null,
        role: ta?.role || null,
    })).filter((a) => !!a.artist_id || !!a.name);
}

function mapPlaylistTracks(playlistTracks = []) {
    return (playlistTracks || [])
        .slice()
        .sort((a, b) => (a?.position || 0) - (b?.position || 0))
        .map((pt) => {
            const t = pt?.tracks;
            if (!t) return null;
            return {
                track_id: t.track_id,
                title: t.title,
                duration: t.duration,
                is_explicit: !!t.is_explicit,
                created_at: t.created_at,
                cover_url: t.albums?.cover_url || null,
                artists: mapTrackArtists(t.track_artists),
            };
        })
        .filter(Boolean);
}

function mapPlaylistSummary(row) {
    const artists = mapPlaylistArtistFromUser(row?.users, row?.creator_id);
    return {
        playlist_id: row.playlist_id,
        name: row.name,
        creator_id: row.creator_id,
        creator_name: row?.users?.name || null,
        is_collaborative: !!row.is_collaborative,
        cover_url: row.cover_url,
        language_code: row.language_code,
        duration: row.duration,
        total_tracks: row.total_tracks,
        likes_count: row.likes_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
        artists,
    };
}

function mapPlaylistDetail(row) {
    if (!row) return null;
    const artists = mapPlaylistArtistFromUser(row?.users, row?.creator_id);
    const tracks = mapPlaylistTracks(row.playlist_tracks);
    
    const collaborators = (row.playlist_users || []).map((pu) => ({
        artist_id: pu.user?.user_id || null,
        name: pu.user?.name || 'Unknown Collaborator',
        avatar_url: pu.user?.avatar_url || null,
        role: pu.role || 'collaborator',
    })).filter((c) => !!c.artist_id);

    return {
        playlist_id: row.playlist_id,
        name: row.name,
        creator_id: row.creator_id,
        creator_name: row?.users?.name || null,
        is_public: !!row.is_public,
        is_collaborative: !!row.is_collaborative,
        description: row.description,
        cover_url: row.cover_url,
        language_code: row.language_code,
        likes_count: row.likes_count,
        total_tracks: row.total_tracks,
        duration: row.duration,
        created_at: row.created_at,
        updated_at: row.updated_at,
        artists,
        tracks,
        collaborators,
    };
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

    out.is_public = payload.is_public === undefined ? false : toBool(payload.is_public, false);
    out.is_collaborative = payload.is_collaborative === undefined ? false : toBool(payload.is_collaborative, false);
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
    if (payload.is_public !== undefined) out.is_public = toBool(payload.is_public, false);
    if (payload.is_collaborative !== undefined) out.is_collaborative = toBool(payload.is_collaborative, false);
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
            playlist_id, name, creator_id, is_public, is_collaborative, description, cover_url, language_code, likes_count, total_tracks, duration, created_at, updated_at,
            users:users!playlists_creator_id_fkey(user_id, name, avatar_url),
            playlist_users:playlist_users(
                role,
                user:users(user_id, name, avatar_url)
            ),
            playlist_tracks:playlist_tracks!playlist_tracks_playlist_id_fkey(
                position,
                tracks:tracks!playlist_tracks_track_id_fkey(
                    track_id, title, duration, is_explicit, created_at,
                    albums:albums!tracks_album_id_fkey(cover_url),
                    track_artists:track_artists!track_artists_track_id_fkey(
                        role,
                        artists:artists!track_artists_artist_id_fkey(
                            artist_id,
                            users:users!artists_artist_id_fkey(name, avatar_url)
                        )
                    )
                )
            )
        `)
        .eq('playlist_id', playlist_id)
        .maybeSingle();
    if (error) throw error;
    return mapPlaylistDetail(data);
}

async function createPlaylist(payload) {
    const input = sanitizeInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;

    if (data && data.creator_id) {
        await client().from('playlist_users').insert({
            playlist_id: data.playlist_id,
            user_id: data.creator_id,
            role: 'creator',
        });
    }
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

    if (q) {
        // Step 1: Use fuzzy trigram RPC to fetch matching playlist IDs and total count
        const { data: matched, error: rpcError } = await client().rpc('search_playlist_ids', {
            search_term: q,
            limit_val: l,
            offset_val: start
        });
        if (rpcError) throw rpcError;

        if (!matched || matched.length === 0) {
            return { items: [], total: 0 };
        }

        const playlistIds = matched.map(m => m.playlist_id);
        const total = Number(matched[0].total_count || 0);

        // Step 2: Fetch detailed playlist records for matched IDs
        const { data: rows, error: fetchError } = await client()
            .from(table)
            .select(`
                playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
                users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
            `)
            .in('playlist_id', playlistIds);
        if (fetchError) throw fetchError;

        // Sort rows to match the similarity order returned by the RPC
        const sortedRows = (rows || []).sort((a, b) => {
            return playlistIds.indexOf(a.playlist_id) - playlistIds.indexOf(b.playlist_id);
        });

        return { items: sortedRows.map(mapPlaylistSummary), total };
    }

    // Default regular listings (when no search query is specified)
    const end = start + l - 1;
    const { data, error, count } = await client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
            users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
        `, { count: 'exact' })
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .range(start, end);
    if (error) throw error;
    return { items: (data || []).map(mapPlaylistSummary), total: count || 0 };
}

async function listLibraryPlaylistsUser({ userId, limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    if (!isUUID(userId)) {
        return { items: [], total: 0 };
    }

    const { data: memberships, error: membershipsErr } = await client()
        .from('playlist_users')
        .select('playlist_id')
        .eq('user_id', userId);
    if (membershipsErr) throw membershipsErr;

    const playlistIds = Array.from(
        new Set((memberships || []).map((row) => row?.playlist_id).filter((playlistId) => isUUID(playlistId)))
    );

    if (playlistIds.length === 0) {
        return { items: [], total: 0 };
    }

    let qb = client()
        .from(table)
        .select(
            `
                playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
                users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
            `,
            { count: 'exact' }
        )
        .in('playlist_id', playlistIds)
        .order('updated_at', { ascending: false });

    if (q) qb = qb.ilike('name', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    return { items: (data || []).map(mapPlaylistSummary), total: count || 0 };
}

async function getPlaylistUser(playlist_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, is_public, is_collaborative, description, cover_url, language_code, likes_count, duration, total_tracks, created_at, updated_at,
            users:users!playlists_creator_id_fkey(user_id, name, avatar_url),
            playlist_users:playlist_users(
                role,
                user:users(user_id, name, avatar_url)
            ),
            playlist_tracks:playlist_tracks!playlist_tracks_playlist_id_fkey(
                position,
                tracks:tracks!playlist_tracks_track_id_fkey(
                    track_id, title, duration, is_explicit, created_at,
                    albums:albums!tracks_album_id_fkey(cover_url),
                    track_artists:track_artists!track_artists_track_id_fkey(
                        role,
                        artists:artists!track_artists_artist_id_fkey(
                            artist_id,
                            users:users!artists_artist_id_fkey(name, avatar_url)
                        )
                    )
                )
            )
        `)
        .eq('playlist_id', playlist_id)
        .eq('is_public', true)
        .maybeSingle();
    if (error) throw error;
    return mapPlaylistDetail(data);
}

async function listTrendingPlaylistsUser({ limit = 20, offset = 0, q, preferredLanguages } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;
    const languageCodes = normalizeLanguageCodes(preferredLanguages);

    let qb = client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
            users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
        `, { count: 'exact' })
        .eq('is_public', true)
        .order('likes_count', { ascending: false })
        .order('updated_at', { ascending: false });
    if (languageCodes.length === 1) qb = qb.eq('language_code', languageCodes[0]);
    else if (languageCodes.length > 1) qb = qb.in('language_code', languageCodes);

    if (q) qb = qb.ilike('name', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    return { items: (data || []).map(mapPlaylistSummary), total: count || 0 };
}

async function listRecommendedPlaylistsUser({ userId, limit = 20, offset = 0, q, preferredLanguages } = {}) {
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const candidateCap = Math.max(100, safeOffset + cappedLimit + 60);
    const languageCodes = normalizeLanguageCodes(preferredLanguages);

    if (!userId || !isUUID(userId)) {
        return listTrendingPlaylistsUser({ limit: cappedLimit, offset: safeOffset, q, preferredLanguages: languageCodes });
    }

    const recommendedIds = [];
    const seen = new Set();

    const { data: historyRows, error: historyErr } = await client()
        .from('user_track_listening_history')
        .select('context_id, track_id')
        .eq('user_id', userId)
        .limit(400);
    if (historyErr) throw historyErr;

    // 1) Playlist-context history gets highest weight
    const directScores = new Map();
    for (const row of historyRows || []) {
        if (!row?.context_id || !isUUID(row.context_id)) continue;
        const score = directScores.get(row.context_id) || 0;
        directScores.set(row.context_id, score + 3);
    }

    // 2) Track overlap between recent listens and playlists
    const recentTrackIds = Array.from(
        new Set((historyRows || []).map((r) => r?.track_id).filter((id) => isUUID(id)))
    ).slice(0, 120);

    const overlapScores = new Map();
    if (recentTrackIds.length > 0) {
        const { data: playlistTrackRows, error: ptErr } = await client()
            .from('playlist_tracks')
            .select('playlist_id, track_id')
            .in('track_id', recentTrackIds)
            .limit(8000);
        if (ptErr) throw ptErr;

        for (const row of playlistTrackRows || []) {
            if (!isUUID(row?.playlist_id)) continue;
            const score = overlapScores.get(row.playlist_id) || 0;
            overlapScores.set(row.playlist_id, score + 1);
        }
    }

    const combined = new Map();
    for (const [pid, score] of directScores.entries()) {
        combined.set(pid, (combined.get(pid) || 0) + score);
    }
    for (const [pid, score] of overlapScores.entries()) {
        combined.set(pid, (combined.get(pid) || 0) + score);
    }

    const rankedIds = Array.from(combined.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([pid]) => pid)
        .slice(0, candidateCap);

    if (rankedIds.length > 0) {
        let recQuery = client()
            .from(table)
            .select(`
                playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
                users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
            `)
            .eq('is_public', true)
            .in('playlist_id', rankedIds)
            .limit(candidateCap);
        if (languageCodes.length === 1) recQuery = recQuery.eq('language_code', languageCodes[0]);
        else if (languageCodes.length > 1) recQuery = recQuery.in('language_code', languageCodes);

        if (q) recQuery = recQuery.ilike('name', `%${q}%`);

        const { data: recRows, error: recErr } = await recQuery;
        if (recErr) throw recErr;

        const recById = new Map((recRows || []).map((row) => [row.playlist_id, row]));
        for (const pid of rankedIds) {
            const row = recById.get(pid);
            if (row && !seen.has(pid)) {
                recommendedIds.push(pid);
                seen.add(pid);
            }
        }
    }

    // 3) Fill with trending playlists if personalized candidates are not enough
    if (recommendedIds.length < safeOffset + cappedLimit) {
        const { items: trendingItems } = await listTrendingPlaylistsUser({
            limit: candidateCap,
            offset: 0,
            q,
            preferredLanguages: languageCodes,
        });
        for (const item of trendingItems) {
            if (!seen.has(item.playlist_id)) {
                recommendedIds.push(item.playlist_id);
                seen.add(item.playlist_id);
            }
            if (recommendedIds.length >= safeOffset + cappedLimit) break;
        }
    }

    const pagedIds = recommendedIds.slice(safeOffset, safeOffset + cappedLimit);
    if (pagedIds.length === 0) {
        return { items: [], total: recommendedIds.length };
    }

    const { data: rows, error: rowsErr } = await client()
        .from(table)
        .select(`
            playlist_id, name, creator_id, cover_url, language_code, duration, total_tracks, likes_count, created_at, updated_at,
            users:users!playlists_creator_id_fkey(user_id, name, avatar_url)
        `)
        .in('playlist_id', pagedIds)
        .eq('is_public', true)
        .limit(cappedLimit);
    if (rowsErr) throw rowsErr;

    const byId = new Map((rows || []).map((row) => [row.playlist_id, mapPlaylistSummary(row)]));
    const orderedItems = pagedIds.map((pid) => byId.get(pid)).filter(Boolean);

    return {
        items: orderedItems,
        total: recommendedIds.length,
    };
}

async function joinPlaylist(playlist_id, user_id) {
    const { data, error } = await client()
        .from('playlist_users')
        .upsert({
            playlist_id,
            user_id,
            role: 'collaborator'
        }, { onConflict: 'playlist_id,user_id' })
        .select('*')
        .single();
    if (error) throw error;
    return data;
}

module.exports = {
    listPlaylists,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    getPlaylistUser,
    listPlaylistsUser,
    listLibraryPlaylistsUser,
    listTrendingPlaylistsUser,
    listRecommendedPlaylistsUser,
    joinPlaylist,
};
