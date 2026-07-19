const { listAlbumsUser, listTrendingAlbumsUser } = require('../../models/albumModel');
const { listTracksUser, listTrendingTracksUser, listWindowedTrendingTracksUser, listUndiscoveredTracksUser, listTracksByIdsUser } = require('../../models/trackModel');
const { listRecommendedPlaylistsUser, listTrendingPlaylistsUser } = require('../../models/playlistModel');
const { getUserOnboardingPreferences, normalizeLanguageCodes } = require('../../utils/userPreferences');
const { getAffinityGenreTrackIds } = require('../../models/recommendationModel');
const { supabase, supabaseAdmin } = require('../../db/config');
const db = supabaseAdmin || supabase;

function parsePagination(query) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(0, Number(query.page) || 0);
    const offset = page * limit;
    return { limit, page, offset };
}

// Helper to shuffle array (Fisher-Yates)
function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex != 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
    }
    return array;
}

// Helper to boost recommendations by recent listening context
async function boostByRecentContext(userId, items) {
    try {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

        const { data: recentTracks } = await db
            .from('user_track_listening_history')
            .select('track_id')
            .eq('user_id', userId)
            .gt('played_at', threeHoursAgo)
            .limit(20);

        if (!recentTracks || recentTracks.length === 0) return items;

        const recentTrackIds = new Set(recentTracks.map(t => t.track_id));

        // Get genres and moods from recent tracks
        const { data: recentTracksFeatures } = await db
            .from('track_content_features')
            .select('genres, mood')
            .in('track_id', Array.from(recentTrackIds))
            .limit(20);

        if (!recentTracksFeatures || recentTracksFeatures.length === 0) return items;

        // Aggregate genres and moods
        const recentGenres = new Set();
        const recentMoods = new Set();
        for (const track of recentTracksFeatures) {
            if (Array.isArray(track.genres)) {
                track.genres.forEach(g => recentGenres.add(g));
            }
            if (Array.isArray(track.mood)) {
                track.mood.forEach(m => recentMoods.add(m));
            }
        }

        // Score items by genre/mood match
        const scored = items.map(item => {
            let score = 0;

            // Get genres/moods from item
            let itemGenres = [];
            let itemMoods = [];

            if (item.type === 'album' && item.genres) {
                itemGenres = Array.isArray(item.genres) ? item.genres : [];
            } else if (item.type === 'track' && item.genres) {
                itemGenres = Array.isArray(item.genres) ? item.genres : [];
            }

            if (item.type === 'track' && item.mood) {
                itemMoods = Array.isArray(item.mood) ? item.mood : [];
            }

            // Calculate match score
            for (const genre of itemGenres) {
                if (recentGenres.has(genre)) score += 2;
            }
            for (const mood of itemMoods) {
                if (recentMoods.has(mood)) score += 1;
            }

            return { item, score };
        });

        // Sort by context score (higher first), then stable sort preserves original order for ties
        scored.sort((a, b) => b.score - a.score);

        return scored.map(s => s.item);
    } catch (error) {
        console.error('Error boosting by recent context:', error);
        return items; // Fallback to original order if error
    }
}

async function getSuggestedTracksForUser(userId, limit, preferredLanguages, prefs, offset = 0) {
    if (offset > 0) {
        const { items } = await listTracksUser({ limit, offset, preferredLanguages });
        return items.map(i => ({ ...i, type: 'track' }));
    }

    try {
        const acceptList = [];
        const seenIds = new Set();

        // 1. Get genre affinity tracks if available
        if (userId) {
            const affinityIds = await getAffinityGenreTrackIds(userId, limit * 2, preferredLanguages);
            if (affinityIds && affinityIds.length > 0) {
                const items = await listTracksByIdsUser(affinityIds.slice(0, limit));
                items.forEach(t => {
                    if (t && t.track_id && !seenIds.has(t.track_id)) {
                        seenIds.add(t.track_id);
                        acceptList.push({ ...t, type: 'track' });
                    }
                });
            }
        }

        // 2. Get tracks matching onboarding favorite genres if we need more
        if (acceptList.length < limit && prefs) {
            const favGenres = prefs.favorite_genres || [];
            if (favGenres.length > 0) {
                const langs = normalizeLanguageCodes(preferredLanguages);
                let q = db
                    .from('track_content_features')
                    .select('track_id, popularity_score, tracks!inner(language_code, is_published)')
                    .overlaps('genres', favGenres)
                    .eq('tracks.is_published', true)
                    .limit(limit * 2);
                
                if (langs.length === 1) q = q.eq('tracks.language_code', langs[0]);
                else if (langs.length > 1) q = q.in('tracks.language_code', langs);

                const { data: featureRows } = await q;
                if (featureRows && featureRows.length > 0) {
                    const matchIds = featureRows.map(r => r.track_id);
                    const items = await listTracksByIdsUser(matchIds);
                    items.forEach(t => {
                        if (t && t.track_id && !seenIds.has(t.track_id)) {
                            seenIds.add(t.track_id);
                            acceptList.push({ ...t, type: 'track' });
                        }
                    });
                }
            }
        }

        // 3. Fallback to listTracksUser (shuffled)
        if (acceptList.length < limit) {
            const remaining = limit - acceptList.length;
            const { items } = await listTracksUser({ limit: remaining * 4, preferredLanguages });
            const shuffled = shuffle([...items]);
            shuffled.forEach(t => {
                if (t && t.track_id && !seenIds.has(t.track_id) && acceptList.length < limit) {
                    seenIds.add(t.track_id);
                    acceptList.push({ ...t, type: 'track' });
                }
            });
        }

        return shuffle(acceptList).slice(0, limit);
    } catch (e) {
        console.error('Error in getSuggestedTracksForUser:', e);
        const { items } = await listTracksUser({ limit, preferredLanguages });
        return items.map(t => ({ ...t, type: 'track' }));
    }
}

async function getSuggestedAlbumsForUser(userId, limit, preferredLanguages, prefs, offset = 0) {
    if (offset > 0) {
        const { items } = await listAlbumsUser({ limit, offset, preferredLanguages });
        return items.map(i => ({ ...i, id: i.album_id, type: 'album' }));
    }

    try {
        const acceptList = [];
        const seenIds = new Set();

        // 1. Onboarding genres
        if (prefs) {
            const favGenres = prefs.favorite_genres || [];
            if (favGenres.length > 0) {
                const { data: genreAlbums } = await db
                    .from('album_genres')
                    .select('album_id, genres!inner(slug, name)')
                    .in('genres.name', favGenres)
                    .limit(limit * 2);
                
                if (genreAlbums && genreAlbums.length > 0) {
                    const matchIds = Array.from(new Set(genreAlbums.map(r => r.album_id)));
                    const { data: detailedAlbums } = await db
                        .from('albums')
                        .select(`
                            album_id, title, cover_url, total_tracks, duration, created_at,
                            album_artists:album_artists!album_artists_album_id_fkey(
                                role,
                                artists:artists!album_artists_artist_id_fkey(
                                    artist_id,
                                    users:users!artists_artist_id_fkey(name, avatar_url)
                                )
                            )
                        `)
                        .in('album_id', matchIds)
                        .eq('is_published', true)
                        .gt('total_tracks', 1);

                    if (detailedAlbums) {
                        detailedAlbums.forEach(row => {
                            if (row && row.album_id && !seenIds.has(row.album_id)) {
                                seenIds.add(row.album_id);
                                acceptList.push({
                                    album_id: row.album_id,
                                    id: row.album_id,
                                    title: row.title,
                                    cover_url: row.cover_url,
                                    total_tracks: row.total_tracks,
                                    duration: row.duration,
                                    created_at: row.created_at,
                                    artists: (row.album_artists || []).map(aa => ({
                                        artist_id: aa?.artists?.artist_id || null,
                                        name: aa?.artists?.users?.name || null,
                                        avatar_url: aa?.artists?.users?.avatar_url || null,
                                    })),
                                    type: 'album'
                                });
                            }
                        });
                    }
                }
            }
        }

        // 2. Fetch default albums with a larger range, shuffle and fill
        const remaining = limit - acceptList.length;
        if (remaining > 0) {
            const { items } = await listAlbumsUser({ limit: limit * 4, preferredLanguages });
            const shuffled = shuffle([...items]);
            shuffled.forEach(item => {
                if (item && item.album_id && !seenIds.has(item.album_id) && acceptList.length < limit) {
                    seenIds.add(item.album_id);
                    acceptList.push({
                        ...item,
                        id: item.album_id,
                        type: 'album'
                    });
                }
            });
        }

        return shuffle(acceptList).slice(0, limit);
    } catch (e) {
        console.error('Error in getSuggestedAlbumsForUser:', e);
        const { items } = await listAlbumsUser({ limit, preferredLanguages });
        return items.map(i => ({ ...i, id: i.album_id, type: 'album' }));
    }
}

async function madeForYou(req, res) {
    const { limit, page, offset } = parsePagination(req.query);

    const perTypeLimit = Math.ceil(limit / 3) + 2;
    const prefs = await getUserOnboardingPreferences(req.user?.id);
    const preferredLanguages = prefs?.preferred_languages || (prefs?.preferred_language ? [prefs.preferred_language] : []);

    const subOffset = Math.floor(offset / 3);
    const emptyResult = { items: [], total: 0 };
    const [albumsSettled, tracksSettled, playlistsSettled] = await Promise.allSettled([
        getSuggestedAlbumsForUser(req.user?.id, perTypeLimit, preferredLanguages, prefs, subOffset),
        getSuggestedTracksForUser(req.user?.id, perTypeLimit, preferredLanguages, prefs, subOffset),
        listRecommendedPlaylistsUser({
            userId: req.user?.id,
            limit: perTypeLimit,
            offset: subOffset,
            preferredLanguages,
        }),
    ]);

    const albumsRes = albumsSettled.status === 'fulfilled' ? albumsSettled.value : [];
    const tracksRes = tracksSettled.status === 'fulfilled' ? tracksSettled.value : [];
    const playlistsRes = playlistsSettled.status === 'fulfilled' ? playlistsSettled.value : emptyResult;

    const albums = albumsRes.map(i => ({ ...i, type: i.type || 'album' }));
    const tracks = tracksRes.map(i => ({ ...i, type: 'track' }));
    const playlists = (playlistsRes.items || playlistsRes).map(i => ({
        ...i,
        id: i.playlist_id,
        type: 'playlist',
        title: i.name,
    }));

    let combined = [];
    const len = Math.max(albums.length, tracks.length, playlists.length);
    for (let i = 0; i < len; i++) {
        if (i < albums.length) combined.push(albums[i]);
        if (i < tracks.length) combined.push(tracks[i]);
        if (i < playlists.length) combined.push(playlists[i]);
    }

    combined = combined.map(item => {
        if (item.type === 'track') {
            if (!item.cover_url && item.album) {
                item.cover_url = item.album.cover_url;
            }
        }
        return item;
    });

    const items = combined.slice(0, limit);
    const contextBoostedItems = await boostByRecentContext(req.user?.id, items);
    const total = (albumsRes.length || 0) + (tracksRes.length || 0) + (playlistsRes.total || playlistsRes.length || 0);

    res.json({ items: contextBoostedItems, total, page, limit });
}

async function albumsForYou(req, res) {
    const { limit, page, offset } = parsePagination(req.query);
    const prefs = await getUserOnboardingPreferences(req.user?.id);
    const preferredLanguages = prefs?.preferred_languages || (prefs?.preferred_language ? [prefs.preferred_language] : []);

    const items = await getSuggestedAlbumsForUser(req.user?.id, limit, preferredLanguages, prefs, offset);

    res.json({
        items: items.map(item => ({ ...item, type: item.type || 'album' })),
        total: items.length < limit && offset === 0 ? items.length : 100,
        page,
        limit,
    });
}

async function trending(req, res) {
    const { limit, page, offset } = parsePagination(req.query);
    const prefs = await getUserOnboardingPreferences(req.user?.id);
    const preferredLanguages = prefs?.preferred_languages || (prefs?.preferred_language ? [prefs.preferred_language] : []);

    // Fetch Trending Albums (by likes) and Trending Tracks (by plays)
    // We fetch more than needed to mix
    const fetchLimit = limit;

    // We use Math.floor(offset/2) because we are combining two lists approximately equal size.
    // If user asks for page 0 (offset 0), we want 0 from both.
    // If page 1 (offset 20), we want roughly offset 10 from both.
    const subOffset = Math.floor(offset / 2);

    // Use allSettled so one source running out of rows doesn't crash the whole endpoint
    const emptyResult = { items: [], total: 0 };
    const [albumsSettled, tracksSettled, playlistsSettled] = await Promise.allSettled([
        listTrendingAlbumsUser({ limit: fetchLimit, offset: subOffset, preferredLanguages }),
        listWindowedTrendingTracksUser({ limit: fetchLimit, offset: subOffset, preferredLanguages }),
        listTrendingPlaylistsUser({ limit: fetchLimit, offset: subOffset, preferredLanguages }),
    ]);

    const albumsRes = albumsSettled.status === 'fulfilled' ? albumsSettled.value : emptyResult;
    const tracksRes = tracksSettled.status === 'fulfilled' ? tracksSettled.value : emptyResult;
    const playlistsRes = playlistsSettled.status === 'fulfilled' ? playlistsSettled.value : emptyResult;

    // items from models already have 'type' set in our new listTrending* functions
    const albums = albumsRes.items;
    const tracks = tracksRes.items;
    const playlists = playlistsRes.items.map(i => ({
        ...i,
        id: i.playlist_id,
        type: 'playlist',
        title: i.name,
    }));

    // Ensure track covers are accessible at top level for convenience
    tracks.forEach(t => {
        if (!t.cover_url && t.album) t.cover_url = t.album.cover_url;
    });

    // Interleave
    let combined = [];
    const len = Math.max(albums.length, tracks.length, playlists.length);
    for (let i = 0; i < len; i++) {
        if (i < albums.length) combined.push(albums[i]);
        if (i < tracks.length) combined.push(tracks[i]);
        if (i < playlists.length) combined.push(playlists[i]);
    }

    const items = combined.slice(0, limit);
    const total = (albumsRes.total || 0) + (tracksRes.total || 0) + (playlistsRes.total || 0);

    res.json({ items, total, page, limit });
}

async function undiscoveredGems(req, res) {
    const { limit, page, offset } = parsePagination(req.query);
    const prefs = await getUserOnboardingPreferences(req.user?.id);
    const preferredLanguages = prefs?.preferred_languages || (prefs?.preferred_language ? [prefs.preferred_language] : []);

    const { items, total } = await listUndiscoveredTracksUser({ userId: req.user?.id, limit, offset, preferredLanguages });

    // Ensure track covers are accessible at top level
    items.forEach(t => {
        if (!t.cover_url && t.album) t.cover_url = t.album.cover_url;
    });

    res.json({ items, total, page, limit });
}

module.exports = { madeForYou, albumsForYou, trending, undiscoveredGems };

