const { supabase, supabaseAdmin } = require('../db/config');
const { getBlobSasUrl, getBlobSasUrlWithExpiry, isAbsoluteUrl, getBlobPublicUrl } = require('../utils/azureSas');
const { isUUID } = require('../utils/validators');
const { toNum } = require('../utils/typeConversions');

const table = 'tracks';

function client() {
    return supabaseAdmin || supabase;
}

function toSignedAudioFromAsset(asset) {
    if (!asset || asset.asset_type !== 'audio_progressive') return null;
    const rawPath = asset.file_path;
    try {
        const url = isAbsoluteUrl(rawPath) ? rawPath : getBlobSasUrl(rawPath);
        return {
            id: asset.track_asset_id,
            ext: asset.ext,
            bitrate: asset.bitrate_kbps,
            path: url,
            created_at: asset.created_at,
        };
    } catch (e) {
        return {
            id: asset.track_asset_id,
            ext: asset.ext,
            bitrate: asset.bitrate_kbps,
            path: rawPath,
            created_at: asset.created_at,
        };
    }
}

function mapRowAudios(row) {
    return (row.track_assets || []).map(toSignedAudioFromAsset).filter(Boolean);
}

function buildHlsPayload(trackId) {
    try {
        const master = getBlobSasUrlWithExpiry(`hls/track_${trackId}/master.m3u8`);
        const variants = [96, 160, 320].map((kb) => {
            const signed = getBlobSasUrlWithExpiry(`hls/track_${trackId}/v${kb}/index.m3u8`);
            return {
                bitrate: kb,
                url: signed.url,
                expires_at: signed.expiresAt,
            };
        });

        return {
            master: master.url,
            master_expires_at: master.expiresAt,
            variants,
        };
    } catch (_) {
        return {
            master: getBlobPublicUrl(`hls/track_${trackId}/master.m3u8`),
            master_expires_at: null,
            variants: [96, 160, 320].map((kb) => ({
                bitrate: kb,
                url: getBlobPublicUrl(`hls/track_${trackId}/v${kb}/index.m3u8`),
                expires_at: null,
            })),
        };
    }
}

// helpers are imported from validators/typeConversions

function sanitizeInsert(payload = {}) {
    const out = {};

    const title = typeof payload.title === 'string' ? payload.title.trim() : null;
    if (!title) throw new Error('title is required');
    out.title = title;

    // album_id required (UUID)
    if (!isUUID(payload.album_id)) throw new Error('album_id (UUID) is required');
    out.album_id = payload.album_id;

    if (payload.subtitle !== undefined) out.subtitle = typeof payload.subtitle === 'string' ? payload.subtitle.trim() : null;
    if (payload.track_number !== undefined) {
        const trackNumber = toNum(payload.track_number, null);
        if (trackNumber === null || trackNumber <= 0) throw new Error('track_number must be a positive integer');
        out.track_number = Math.trunc(trackNumber);
    }
    if (payload.disc_number !== undefined) {
        const discNumber = toNum(payload.disc_number, null);
        if (discNumber === null || discNumber <= 0) throw new Error('disc_number must be a positive integer');
        out.disc_number = Math.trunc(discNumber);
    }
    if (payload.language_code !== undefined) out.language_code = typeof payload.language_code === 'string' ? payload.language_code.trim() : null;

    out.video_url = typeof payload.video_url === 'string' && payload.video_url.trim() ? payload.video_url.trim() : null;

    out.lyrics_url = typeof payload.lyrics_url === 'string' && payload.lyrics_url.trim() ? payload.lyrics_url.trim() : null;
    if (payload.lyrics_snippet !== undefined) out.lyrics_snippet = typeof payload.lyrics_snippet === 'string' ? payload.lyrics_snippet.trim() : null;

    // duration required integer >= 0
    const duration = toNum(payload.duration, null);
    if (duration === null || duration < 0) throw new Error('duration is required and must be a non-negative integer');
    out.duration = Math.trunc(duration);

    out.play_count = Math.max(0, Math.trunc(toNum(payload.play_count, 0)));

    out.is_explicit = typeof payload.is_explicit === 'boolean' ? payload.is_explicit : !!payload.is_explicit;

    out.likes_count = Math.max(0, Math.trunc(toNum(payload.likes_count, 0)));

    out.popularity_score = toNum(payload.popularity_score) || 0;
    if (payload.copyright_text !== undefined) out.copyright_text = typeof payload.copyright_text === 'string' ? payload.copyright_text.trim() : null;
    if (payload.label_id !== undefined) {
        if (payload.label_id !== null && !isUUID(payload.label_id)) throw new Error('label_id must be a valid UUID');
        out.label_id = payload.label_id;
    }
    if (payload.hls_master_path !== undefined) out.hls_master_path = typeof payload.hls_master_path === 'string' ? payload.hls_master_path.trim() : null;

    out.is_published = !!payload.is_published;

    out.created_at = new Date().toISOString();
    out.updated_at = new Date().toISOString();

    return out;
}

function sanitizeUpdate(payload = {}) {
    const out = {};
    if (payload.title !== undefined) {
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (!title) throw new Error('title cannot be empty');
        out.title = title;
    }
    if (payload.album_id !== undefined) {
        if (!isUUID(payload.album_id)) throw new Error('album_id must be a valid UUID');
        out.album_id = payload.album_id;
    }
    if (payload.subtitle !== undefined) out.subtitle = typeof payload.subtitle === 'string' ? payload.subtitle.trim() : null;
    if (payload.track_number !== undefined) {
        const trackNumber = toNum(payload.track_number, null);
        if (trackNumber === null || trackNumber <= 0) throw new Error('track_number must be a positive integer');
        out.track_number = Math.trunc(trackNumber);
    }
    if (payload.disc_number !== undefined) {
        const discNumber = toNum(payload.disc_number, null);
        if (discNumber === null || discNumber <= 0) throw new Error('disc_number must be a positive integer');
        out.disc_number = Math.trunc(discNumber);
    }
    if (payload.language_code !== undefined) out.language_code = typeof payload.language_code === 'string' ? payload.language_code.trim() : null;
    if (payload.lyrics_url !== undefined) out.lyrics_url = typeof payload.lyrics_url === 'string' ? payload.lyrics_url.trim() : null;
    if (payload.lyrics_snippet !== undefined) out.lyrics_snippet = typeof payload.lyrics_snippet === 'string' ? payload.lyrics_snippet.trim() : null;
    if (payload.video_url !== undefined) out.video_url = typeof payload.video_url === 'string' ? payload.video_url.trim() : null;
    if (payload.duration !== undefined) {
        const d = toNum(payload.duration, null);
        if (d === null || d < 0) throw new Error('duration is invalid');
        out.duration = Math.trunc(d);
    }
    if (payload.play_count !== undefined) out.play_count = Math.max(0, Math.trunc(toNum(payload.play_count, 0)));
    if (payload.is_explicit !== undefined) out.is_explicit = !!payload.is_explicit;
    if (payload.likes_count !== undefined) out.likes_count = Math.max(0, Math.trunc(toNum(payload.likes_count, 0)));
    if (payload.popularity_score !== undefined) out.popularity_score = toNum(payload.popularity_score) || 0;
    if (payload.copyright_text !== undefined) out.copyright_text = typeof payload.copyright_text === 'string' ? payload.copyright_text.trim() : null;
    if (payload.label_id !== undefined) {
        if (payload.label_id !== null && !isUUID(payload.label_id)) throw new Error('label_id must be a valid UUID');
        out.label_id = payload.label_id;
    }
    if (payload.hls_master_path !== undefined) out.hls_master_path = typeof payload.hls_master_path === 'string' ? payload.hls_master_path.trim() : null;
    if (payload.is_published !== undefined) out.is_published = !!payload.is_published;

    return out;
}

async function listTracks({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    // include artists and audio variants
    let qb = client()
        .from(table)
        .select(`
            track_id, title, subtitle, album_id, track_number, disc_number, duration, language_code, lyrics_url, lyrics_snippet, play_count, is_explicit, likes_count, popularity_score, copyright_text, label_id, hls_master_path, created_at, updated_at, video_url, is_published,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                role,
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            ),
            track_assets:track_assets!track_assets_track_id_fkey(
                track_asset_id, ext, bitrate_kbps, file_path, created_at, asset_type
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `, { count: 'exact' })
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    const items = (data || []).map(row => ({
        track_id: row.track_id,
        title: row.title,
        subtitle: row.subtitle,
        album_id: row.album_id,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        track_number: row.track_number,
        disc_number: row.disc_number,
        language_code: row.language_code,
        lyrics_url: row.lyrics_url,
        lyrics_snippet: row.lyrics_snippet,
        duration: row.duration,
        play_count: row.play_count,
        is_explicit: row.is_explicit,
        likes_count: row.likes_count,
        popularity_score: row.popularity_score,
        copyright_text: row.copyright_text,
        label_id: row.label_id,
        hls_master_path: row.hls_master_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
        video_url: row.video_url,
        is_published: row.is_published,
        hls: buildHlsPayload(row.track_id),
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            role: ta?.role || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        audios: mapRowAudios(row),
        external_refs: row.track_external_refs || null,
    }));
    return { items, total: count };
}

async function getTrack(track_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            track_id, title, subtitle, album_id, track_number, disc_number, duration, language_code, lyrics_url, lyrics_snippet, play_count, is_explicit, likes_count, popularity_score, copyright_text, label_id, hls_master_path, created_at, updated_at, video_url, is_published,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                role,
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            ),
            track_assets:track_assets!track_assets_track_id_fkey(
                track_asset_id, ext, bitrate_kbps, file_path, created_at, asset_type
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `)
        .eq('track_id', track_id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
        track_id: data.track_id,
        title: data.title,
        subtitle: data.subtitle,
        album_id: data.album_id,
        album: {
            title: data.albums?.title,
            cover_url: data.albums?.cover_url,
        },
        track_number: data.track_number,
        disc_number: data.disc_number,
        language_code: data.language_code,
        lyrics_url: data.lyrics_url,
        lyrics_snippet: data.lyrics_snippet,
        duration: data.duration,
        play_count: data.play_count,
        is_explicit: data.is_explicit,
        likes_count: data.likes_count,
        popularity_score: data.popularity_score,
        copyright_text: data.copyright_text,
        label_id: data.label_id,
        hls_master_path: data.hls_master_path,
        created_at: data.created_at,
        updated_at: data.updated_at,
        video_url: data.video_url,
        is_published: data.is_published,
        hls: buildHlsPayload(data.track_id),
        artists: (data.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            role: ta?.role || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        audios: mapRowAudios(data),
        external_refs: data.track_external_refs || null
    };
}

async function createTrack(payload) {
    const input = sanitizeInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updateTrack(track_id, payload) {
    const input = sanitizeUpdate(payload);
    const { data, error } = await client().from(table).update({ ...input, updated_at: new Date().toISOString() }).eq('track_id', track_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteTrack(track_id) {
    const { error } = await client().from(table).delete().eq('track_id', track_id);
    if (error) throw error;
}

async function listTracksUser({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            track_id, title, duration, created_at, album_id,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        track_id: row.track_id,
        title: row.title,
        duration: row.duration,
        created_at: row.created_at,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        hls: buildHlsPayload(row.track_id),
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        external_refs: row.track_external_refs || null
    }));
    return { items, total: count };
}

async function getTrackUser(track_id) {
    const { data, error } = await client()
        .from(table)
        .select(`
            track_id, title, album_id, duration, play_count, is_explicit, likes_count, created_at,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            ),
            track_assets:track_assets!track_assets_track_id_fkey(
                track_asset_id, ext, bitrate_kbps, file_path, asset_type
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `)
        .eq('track_id', track_id)
        .eq('is_published', true)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
        track_id: data.track_id,
        title: data.title,
        album_id: data.album_id,
        album: {
            title: data.albums?.title,
            cover_url: data.albums?.cover_url,
        },
        duration: data.duration,
        play_count: data.play_count,
        is_explicit: data.is_explicit,
        likes_count: data.likes_count,
        created_at: data.created_at,
        hls: buildHlsPayload(data.track_id),
        artists: (data.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        audios: mapRowAudios(data).map(a => ({ ext: a.ext, bitrate: a.bitrate, path: a.path })),
        external_refs: data.track_external_refs || null
    };
}

async function listTracksByArtist({ artist_id, limit = 20, offset = 0, q } = {}) {
    if (!isUUID(artist_id)) throw new Error('artist_id is invalid');
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            track_id, title, subtitle, album_id, track_number, disc_number, duration, language_code, lyrics_url, lyrics_snippet, play_count, is_explicit, likes_count, popularity_score, copyright_text, label_id, hls_master_path, created_at, updated_at, video_url, is_published,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!inner(
                role,
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(user_id, name, avatar_url)
                )
            ),
            track_assets:track_assets!track_assets_track_id_fkey(
                track_asset_id, ext, bitrate_kbps, file_path, created_at, asset_type
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `, { count: 'exact' })
        .eq('track_artists.artist_id', artist_id)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    const items = (data || []).map(row => ({
        track_id: row.track_id,
        title: row.title,
        subtitle: row.subtitle,
        album_id: row.album_id,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        track_number: row.track_number,
        disc_number: row.disc_number,
        language_code: row.language_code,
        lyrics_url: row.lyrics_url,
        lyrics_snippet: row.lyrics_snippet,
        duration: row.duration,
        play_count: row.play_count,
        is_explicit: row.is_explicit,
        likes_count: row.likes_count,
        popularity_score: row.popularity_score,
        copyright_text: row.copyright_text,
        label_id: row.label_id,
        hls_master_path: row.hls_master_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
        video_url: row.video_url,
        is_published: row.is_published,
        hls: buildHlsPayload(row.track_id),
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            role: ta?.role || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        audios: mapRowAudios(row),
        external_refs: row.track_external_refs || null,
    }));
    return { items, total: count };
}

async function listTracksByArtistUser({ artist_id, limit = 20, offset = 0, q } = {}) {
    if (!isUUID(artist_id)) throw new Error('artist_id is invalid');
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            track_id, title, duration, created_at, album_id,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!inner(
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            ),
            track_external_refs!track_external_refs_track_id_fkey(
                external_id,
                provider_id
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .eq('track_artists.artist_id', artist_id)
        .order('created_at', { ascending: false });
    if (q) qb = qb.ilike('title', `%${q}%`);

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        track_id: row.track_id,
        title: row.title,
        duration: row.duration,
        created_at: row.created_at,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        hls: buildHlsPayload(row.track_id),
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
        external_refs: row.track_external_refs || null
    }));
    return { items, total: count };
}

module.exports = { listTracks, getTrack, createTrack, updateTrack, deleteTrack, listTracksUser, getTrackUser, listTracksByArtist, listTracksByArtistUser };
async function listTracksByIdsUser(trackIds = []) {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return [];
    // Only query UUIDs to avoid PostgreSQL errors
    const ids = trackIds.filter(id => id && isUUID(id));
    if (ids.length === 0) return [];
    const { data, error } = await client()
        .from(table)
        .select(`
            track_id, title, duration, created_at, album_id,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `)
        .in('track_id', ids)
        .eq('is_published', true);
    if (error) throw error;
    const map = new Map((data || []).map(row => [row.track_id, {
        track_id: row.track_id,
        title: row.title,
        duration: row.duration,
        created_at: row.created_at,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        hls: buildHlsPayload(row.track_id),
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        }))
    }]));
    // preserve order
    return ids.map(id => map.get(id)).filter(Boolean);
}

module.exports.listTracksByIdsUser = listTracksByIdsUser;

async function listTrendingTracksUser({ limit = 20, offset = 0 } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    let qb = client()
        .from(table)
        .select(`
            track_id, title, duration, created_at, album_id, play_count,
            albums:albums!tracks_album_id_fkey(title, cover_url),
            track_artists:track_artists!track_artists_track_id_fkey(
                artists:artists!track_artists_artist_id_fkey(
                    artist_id,
                    users:users!artists_artist_id_fkey(name, avatar_url)
                )
            )
        `, { count: 'exact' })
        .eq('is_published', true)
        .order('play_count', { ascending: false })
        .order('created_at', { ascending: false }); // secondary sort

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;
    const items = (data || []).map(row => ({
        type: 'track', // Explicit type
        track_id: row.track_id,
        title: row.title,
        duration: row.duration,
        created_at: row.created_at,
        album: {
            title: row.albums?.title,
            cover_url: row.albums?.cover_url,
        },
        artists: (row.track_artists || []).map(ta => ({
            artist_id: ta?.artists?.artist_id || null,
            name: ta?.artists?.users?.name || null,
            avatar_url: ta?.artists?.users?.avatar_url || null,
        })),
    }));
    return { items, total: count };
}

module.exports.listTrendingTracksUser = listTrendingTracksUser;
