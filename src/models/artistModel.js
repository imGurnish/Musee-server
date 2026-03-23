const { supabase, supabaseAdmin } = require('../db/config');
const { toNum, toDateOnly, toTextArray } = require('../utils/typeConversions');
const { isUUID } = require('../utils/validators');
const table = 'artists';

function client() {
    return supabaseAdmin || supabase;
}

function toBoolean(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t === 'true' || t === '1') return true;
        if (t === 'false' || t === '0') return false;
    }
    return Boolean(v);
}

function normalizeGenres(val) {
    if (val === undefined) return undefined;
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (!Array.isArray(parsed)) throw new Error('genres must be an array');
                return parsed.map(String);
            } catch {
                throw new Error('genres must be an array');
            }
        }
        return toTextArray(trimmed);
    }
    throw new Error('genres must be an array');
}

function sanitizeArtistInsert(payload = {}) {
    const out = {};
    // artist_id required (references users.user_id)
    if (!isUUID(payload.artist_id)) throw new Error('artist_id (UUID) is required');
    out.artist_id = payload.artist_id;

    const bio = typeof payload.bio === 'string' ? payload.bio.trim() : null;
    if (bio == null) throw new Error('bio is required');
    out.bio = bio;

    out.cover_url = typeof payload.cover_url === 'string' && payload.cover_url.trim() ? payload.cover_url.trim() : 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/artists/default_cover.png';

    if (payload.genres !== undefined) out.genres = normalizeGenres(payload.genres);

    // debut_year is optional; validate if provided
    if (payload.debut_year !== undefined) {
        const debut_year = toNum(payload.debut_year, null);
        if (debut_year === null) throw new Error('debut_year must be a valid number');
        if (!(debut_year >= 1900 && debut_year <= new Date().getFullYear())) throw new Error('debut_year must be a valid year');
        out.debut_year = debut_year;
    }

    if (payload.is_verified !== undefined) out.is_verified = toBoolean(payload.is_verified);

    if (payload.monthly_listeners !== undefined) {
        out.monthly_listeners = toNum(payload.monthly_listeners, null);
        if (out.monthly_listeners === null) throw new Error('monthly_listeners must be a valid number');
    }

    // region_id is optional; DB has a default if omitted
    if (payload.region_id !== undefined) {
        if (payload.region_id !== null && !isUUID(payload.region_id)) throw new Error('region_id is invalid');
        out.region_id = payload.region_id;
    }

    // date_of_birth stored as DATE
    if (payload.date_of_birth !== undefined) out.date_of_birth = toDateOnly(payload.date_of_birth);

    if (payload.social_links !== undefined) {
        if (!(payload.social_links && typeof payload.social_links === 'object')) throw new Error('social_links must be an object');
        out.social_links = payload.social_links;
    }

    out.created_at = new Date().toISOString();
    out.updated_at = new Date().toISOString();

    return out;
}

function sanitizeArtistUpdate(payload = {}) {
    const out = {};
    if (payload.bio !== undefined) out.bio = typeof payload.bio === 'string' ? payload.bio.trim() : null;
    if (payload.cover_url !== undefined) out.cover_url = typeof payload.cover_url === 'string' ? payload.cover_url.trim() : null;

    if (payload.genres !== undefined) out.genres = normalizeGenres(payload.genres);

    if (payload.debut_year !== undefined) {
        const debut_year = toNum(payload.debut_year, null);
        if (!(debut_year >= 1900 && debut_year <= new Date().getFullYear())) throw new Error('debut_year must be a valid year');
        out.debut_year = debut_year;
    }

    if (payload.is_verified !== undefined) out.is_verified = toBoolean(payload.is_verified);

    if (payload.monthly_listeners !== undefined) {
        out.monthly_listeners = toNum(payload.monthly_listeners, null);
        if (out.monthly_listeners === null) throw new Error('monthly_listeners must be a valid number');
    }

    if (payload.region_id !== undefined) {
        if (payload.region_id !== null && !isUUID(payload.region_id)) throw new Error('region_id must be a UUID or null');
        out.region_id = payload.region_id;
    }

    if (payload.date_of_birth !== undefined) {
        out.date_of_birth = toDateOnly(payload.date_of_birth);
    }

    if (payload.social_links !== undefined) {
        if (!(payload.social_links && typeof payload.social_links === 'object')) throw new Error('social_links must be an object');
        out.social_links = payload.social_links;
    }
    return out;
}

async function listArtists({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    // Base admin query — join from users to artists (1:1 PK→FK)
    let qb = client()
        .from("users")
        .select(`
            user_id,
            name,
            email,
            avatar_url,
            subscription_type,
            plan_id,
            playlists,
            favorites,
            followers_count,
            followings_count,
            last_login_at,
            settings,
            user_type,
            created_at,
            updated_at,
            artists:artists!artists_artist_id_fkey (
                artist_id,
                bio,
                cover_url,
                genres,
                debut_year,
                is_verified,
                social_links,
                monthly_listeners,
                created_at,
                updated_at,
                region_id,
                date_of_birth
            )
        `, { count: "exact" })
        .eq("user_type", "artist") // Admin: only artist users
        .order("created_at", { ascending: false });

    // Search by user.name OR artists.bio
    if (q) {
        qb = qb.or(`name.ilike.%${q}%,artists.bio.ilike.%${q}%`);
    }

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    // Convert to Admin API format
    const items = data.map(row => ({
        artist_id: row.artists?.artist_id,
        bio: row.artists?.bio,
        cover_url: row.artists?.cover_url,
        genres: row.artists?.genres || [],
        debut_year: row.artists?.debut_year,
        is_verified: row.artists?.is_verified,
        social_links: row.artists?.social_links || null,
        monthly_listeners: row.artists?.monthly_listeners || 0,
        created_at: row.artists?.created_at,
        updated_at: row.artists?.updated_at,
        region_id: row.artists?.region_id,
        date_of_birth: row.artists?.date_of_birth,

        // full nested user object
        users: {
            user_id: row.user_id,
            name: row.name,
            email: row.email,
            avatar_url: row.avatar_url,
            subscription_type: row.subscription_type,
            plan_id: row.plan_id,
            playlists: row.playlists,
            favorites: row.favorites,
            followers_count: row.followers_count,
            followings_count: row.followings_count,
            last_login_at: row.last_login_at,
            settings: row.settings,
            user_type: row.user_type,
            created_at: row.created_at,
            updated_at: row.updated_at
        }
    }));

    return { items, total: count };
}



async function getArtist(artist_id) {
    const { data, error } = await client()
        .from(table)
        .select('*, users:users!artists_artist_id_fkey(*)')
        .eq('artist_id', artist_id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function createArtist(payload) {
    const input = sanitizeArtistInsert(payload);
    const { data, error } = await client().from(table).insert(input).select('*').single();
    if (error) throw error;
    return data;
}

async function updateArtist(artist_id, payload) {
    const input = sanitizeArtistUpdate(payload);
    const { data, error } = await client().from(table).update({ ...input, updated_at: new Date().toISOString() }).eq('artist_id', artist_id).select('*').single();
    if (error) throw error;
    return data;
}

async function deleteArtist(artist_id) {
    const { error } = await client().from(table).delete().eq('artist_id', artist_id);
    if (error) throw error;
}

async function listArtistsUser({ limit = 20, offset = 0, q } = {}) {
    const start = Math.max(0, Number(offset) || 0);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    const end = start + l - 1;

    // Search users first (because name lives in users table)
    let qb = client()
        .from("users")
        .select(`
      user_id,
      name,
      avatar_url,
      artists:artists!artists_artist_id_fkey (
        bio,
        cover_url,
        genres,
        debut_year,
        is_verified,
        monthly_listeners
      )
    `, { count: "exact" })
        .eq("user_type", "artist") // Only artist users
        .order("created_at", { ascending: false });

    // Search by user name
    if (q) {
        qb = qb.ilike("name", `%${q}%`);
    }

    const { data, error, count } = await qb.range(start, end);
    if (error) throw error;

    // Build final artist response
    const items = data.map(row => ({
        artist_id: row.user_id, // same as artist_id in artists table
        name: row.name,
        avatar_url: row.avatar_url,
        cover_url: row.artists?.cover_url ?? null,
        bio: row.artists?.bio ?? null,
        genres: row.artists?.genres ?? [],
        debut_year: row.artists?.debut_year ?? null,
        is_verified: row.artists?.is_verified ?? false,
        monthly_listeners: row.artists?.monthly_listeners ?? 0,
    }));

    return { items, total: count };
}

async function getArtistUser(artist_id) {
    const { data, error } = await client()
        .from(table)
        .select(
            `artist_id, cover_url, bio, genres, debut_year, is_verified, monthly_listeners,
             users:users!artists_artist_id_fkey(name, avatar_url)`
        )
        .eq('artist_id', artist_id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
        artist_id: data.artist_id,
        name: data.users?.name || null,
        avatar_url: data.users?.avatar_url || null,
        cover_url: data.cover_url,
        bio: data.bio,
        genres: data.genres,
        debut_year: data.debut_year,
        is_verified: data.is_verified,
        monthly_listeners: data.monthly_listeners,
    };
}

module.exports = { listArtists, getArtist, createArtist, updateArtist, deleteArtist, listArtistsUser, getArtistUser, sanitizeArtistInsert, sanitizeArtistUpdate };
