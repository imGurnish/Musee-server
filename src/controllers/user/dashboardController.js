const { listAlbumsUser, listTrendingAlbumsUser } = require('../../models/albumModel');
const { listTracksUser, listTrendingTracksUser } = require('../../models/trackModel');
const { listRecommendedPlaylistsUser, listTrendingPlaylistsUser } = require('../../models/playlistModel');
const { getUserOnboardingPreferences } = require('../../utils/userPreferences');
const db = require('../../utils/supabaseClient');

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

async function madeForYou(req, res) {
    // "Made For You" - Currently serving as "New Releases" / Discovery
    // Fetch recent albums and recent tracks
    const { limit, page, offset } = parsePagination(req.query);

    // Split limit to get a mix
    const perTypeLimit = Math.ceil(limit / 3) + 2; // fetch a bit more per type
    const prefs = await getUserOnboardingPreferences(req.user?.id);
    const preferredLanguages = prefs?.preferred_languages || (prefs?.preferred_language ? [prefs.preferred_language] : []);

    // We pass same offset/limit to both for pagination consistency, 
    // although mixing pagination across two tables is tricky. 
    // For simplicity, we just fetch top N new items from both based on page.

    const subOffset = Math.floor(offset / 3);
    const emptyResult = { items: [], total: 0 };
    const [albumsSettled, tracksSettled, playlistsSettled] = await Promise.allSettled([
        listAlbumsUser({ limit: perTypeLimit, offset: subOffset, preferredLanguages }),
        listTracksUser({ limit: perTypeLimit, offset: subOffset, preferredLanguages }),
        listRecommendedPlaylistsUser({
            userId: req.user?.id,
            limit: perTypeLimit,
            offset: subOffset,
            preferredLanguages,
        }),
    ]);

    const albumsRes = albumsSettled.status === 'fulfilled' ? albumsSettled.value : emptyResult;
    const tracksRes = tracksSettled.status === 'fulfilled' ? tracksSettled.value : emptyResult;
    const playlistsRes = playlistsSettled.status === 'fulfilled' ? playlistsSettled.value : emptyResult;

    // Tag them with type if not already (listTracksUser might not have it)
    const albums = albumsRes.items.map(i => ({ ...i, type: 'album' }));
    const tracks = tracksRes.items.map(i => ({ ...i, type: 'track' }));
    const playlists = playlistsRes.items.map(i => ({
        ...i,
        id: i.playlist_id,
        type: 'playlist',
        title: i.name,
    }));

    // Interleave or Shuffle
    // Since it's "Received freshly", let's interleave to ensure variety
    let combined = [];
    const len = Math.max(albums.length, tracks.length, playlists.length);
    for (let i = 0; i < len; i++) {
        if (i < albums.length) combined.push(albums[i]);
        if (i < tracks.length) combined.push(tracks[i]);
        if (i < playlists.length) combined.push(playlists[i]);
    }

    // Helper to get image URL for generic item
    // Tracks use album.cover_url, Albums use cover_url
    combined = combined.map(item => {
        if (item.type === 'track') {
            // Ensure top-level cover_url exists for frontend convenience if it's missing (it's in item.album.cover_url)
            if (!item.cover_url && item.album) {
                item.cover_url = item.album.cover_url;
            }
        }
        return item;
    });

    // Slice to limit
    const items = combined.slice(0, limit);

    // Boost by recent listening context for better relevance
    const contextBoostedItems = await boostByRecentContext(req.user?.id, items);

    // Total is estimate
    const total = (albumsRes.total || 0) + (tracksRes.total || 0) + (playlistsRes.total || 0);

    res.json({ items: contextBoostedItems, total, page, limit });
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
        listTrendingTracksUser({ limit: fetchLimit, offset: subOffset, preferredLanguages }),
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

module.exports = { madeForYou, trending };
