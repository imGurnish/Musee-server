const { listAlbumsUser, listTrendingAlbumsUser } = require('../../models/albumModel');
const { listTracksUser, listTrendingTracksUser } = require('../../models/trackModel');

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

async function madeForYou(req, res) {
    // "Made For You" - Currently serving as "New Releases" / Discovery
    // Fetch recent albums and recent tracks
    const { limit, page, offset } = parsePagination(req.query);

    // Split limit to get a mix
    const halfLimit = Math.ceil(limit / 2) + 2; // fetch a bit more

    // We pass same offset/limit to both for pagination consistency, 
    // although mixing pagination across two tables is tricky. 
    // For simplicity, we just fetch top N new items from both based on page.

    const [albumsRes, tracksRes] = await Promise.all([
        listAlbumsUser({ limit: halfLimit, offset: Math.floor(offset / 2) }),
        listTracksUser({ limit: halfLimit, offset: Math.floor(offset / 2) })
    ]);

    // Tag them with type if not already (listTracksUser might not have it)
    const albums = albumsRes.items.map(i => ({ ...i, type: 'album' }));
    const tracks = tracksRes.items.map(i => ({ ...i, type: 'track' }));

    // Interleave or Shuffle
    // Since it's "Received freshly", let's interleave to ensure variety
    let combined = [];
    const len = Math.max(albums.length, tracks.length);
    for (let i = 0; i < len; i++) {
        if (i < albums.length) combined.push(albums[i]);
        if (i < tracks.length) combined.push(tracks[i]);
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

    // Total is estimate
    const total = albumsRes.total + tracksRes.total;

    res.json({ items, total, page, limit });
}

async function trending(req, res) {
    const { limit, page, offset } = parsePagination(req.query);

    // Fetch Trending Albums (by likes) and Trending Tracks (by plays)
    // We fetch more than needed to mix
    const fetchLimit = limit;

    // We use Math.floor(offset/2) because we are combining two lists approximately equal size.
    // If user asks for page 0 (offset 0), we want 0 from both.
    // If page 1 (offset 20), we want roughly offset 10 from both.
    const subOffset = Math.floor(offset / 2);

    const [albumsRes, tracksRes] = await Promise.all([
        listTrendingAlbumsUser({ limit: fetchLimit, offset: subOffset }),
        listTrendingTracksUser({ limit: fetchLimit, offset: subOffset })
    ]);

    // items from models already have 'type' set in our new listTrending* functions
    const albums = albumsRes.items;
    const tracks = tracksRes.items;

    // Ensure track covers are accessible at top level for convenience
    tracks.forEach(t => {
        if (!t.cover_url && t.album) t.cover_url = t.album.cover_url;
    });

    // Interleave
    let combined = [];
    const len = Math.max(albums.length, tracks.length);
    for (let i = 0; i < len; i++) {
        if (i < albums.length) combined.push(albums[i]);
        if (i < tracks.length) combined.push(tracks[i]);
    }

    const items = combined.slice(0, limit);
    const total = albumsRes.total + tracksRes.total;

    res.json({ items, total, page, limit });
}

module.exports = { madeForYou, trending };
