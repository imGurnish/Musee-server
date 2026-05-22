const { listTracksUser } = require('../../models/trackModel');
const { listAlbumsUser } = require('../../models/albumModel');
const { listArtistsUser } = require('../../models/artistModel');
const { listPlaylistsUser } = require('../../models/playlistModel');

async function searchAll(req, res) {
    const rawQ = (req.query.q || req.query.query || '').trim();

    if (!rawQ) {
        return res.json({
            tracks: [],
            albums: [],
            artists: [],
            playlists: []
        });
    }

    const q = rawQ;
    const type = (req.query.type || 'all').toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    try {
        if (type === 'track' || type === 'song') {
            const result = await listTracksUser({ limit, offset, q, skipHls: true }).catch(err => {
                console.error('Unified search - tracks type failed:', err.message || err);
                return { items: [], total: 0 };
            });
            return res.json({
                tracks: result.items || [],
                albums: [],
                artists: [],
                playlists: [],
                totalTracks: result.total || 0
            });
        }

        if (type === 'album') {
            const result = await listAlbumsUser({ limit, offset, q }).catch(err => {
                console.error('Unified search - albums type failed:', err.message || err);
                return { items: [], total: 0 };
            });
            return res.json({
                tracks: [],
                albums: result.items || [],
                artists: [],
                playlists: [],
                totalAlbums: result.total || 0
            });
        }

        if (type === 'artist') {
            const result = await listArtistsUser({ limit, offset, q }).catch(err => {
                console.error('Unified search - artists type failed:', err.message || err);
                return { items: [], total: 0 };
            });
            return res.json({
                tracks: [],
                albums: [],
                artists: result.items || [],
                playlists: [],
                totalArtists: result.total || 0
            });
        }

        if (type === 'playlist') {
            const result = await listPlaylistsUser({ limit, offset, q }).catch(err => {
                console.error('Unified search - playlists type failed:', err.message || err);
                return { items: [], total: 0 };
            });
            return res.json({
                tracks: [],
                albums: [],
                artists: [],
                playlists: result.items || [],
                totalPlaylists: result.total || 0
            });
        }

        // If 'all' (or no type specified), fetch top 5 of each concurrently
        const limitTracks = Math.min(100, Math.max(1, Number(req.query.limitTracks) || Number(req.query.limit) || 5));
        const limitAlbums = Math.min(100, Math.max(1, Number(req.query.limitAlbums) || Number(req.query.limit) || 5));
        const limitArtists = Math.min(100, Math.max(1, Number(req.query.limitArtists) || Number(req.query.limit) || 5));
        const limitPlaylists = Math.min(100, Math.max(1, Number(req.query.limitPlaylists) || Number(req.query.limit) || 5));

        const [tracksResult, albumsResult, artistsResult, playlistsResult] = await Promise.all([
            listTracksUser({ limit: limitTracks, offset: 0, q, skipHls: true }).catch(err => {
                console.error('Unified search - tracks failed:', err.message || err);
                return { items: [], total: 0 };
            }),
            listAlbumsUser({ limit: limitAlbums, offset: 0, q }).catch(err => {
                console.error('Unified search - albums failed:', err.message || err);
                return { items: [], total: 0 };
            }),
            listArtistsUser({ limit: limitArtists, offset: 0, q }).catch(err => {
                console.error('Unified search - artists failed:', err.message || err);
                return { items: [], total: 0 };
            }),
            listPlaylistsUser({ limit: limitPlaylists, offset: 0, q }).catch(err => {
                console.error('Unified search - playlists failed:', err.message || err);
                return { items: [], total: 0 };
            })
        ]);

        return res.json({
            tracks: tracksResult.items || [],
            albums: albumsResult.items || [],
            artists: artistsResult.items || [],
            playlists: playlistsResult.items || [],
            totalTracks: tracksResult.total || 0,
            totalAlbums: albumsResult.total || 0,
            totalArtists: artistsResult.total || 0,
            totalPlaylists: playlistsResult.total || 0
        });
    } catch (error) {
        console.error('Unified search failed:', error.message || error);
        return res.status(500).json({ error: 'Search failed' });
    }
}

module.exports = {
    searchAll
};
