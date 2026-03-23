const createError = require('http-errors');
const { listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist } = require('../../models/playlistModel');
const { addPlaylistTrack, removePlaylistTrack } = require('../../models/playlistTracksModel');
const { uploadPlaylistCoverToStorage, deletePlaylistCoverFromStorage } = require('../../utils/supabaseStorage');

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listPlaylists({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    const item = await getPlaylist(id);
    if (!item) throw createError(404, 'Playlist not found');
    res.json(item);
}

async function create(req, res) {
    const payload = { ...req.body };
    const playlist = await createPlaylist(payload);
    if (req.file) {
        const coverUrl = await uploadPlaylistCoverToStorage(playlist.playlist_id, req.file);
        if (coverUrl) {
            const updated = await updatePlaylist(playlist.playlist_id, { cover_url: coverUrl });
            return res.status(201).json(updated);
        }
    }
    res.status(201).json(playlist);
}

async function update(req, res) {
    const { id } = req.params;
    const payload = { ...req.body };
    if (req.file) {
        const coverUrl = await uploadPlaylistCoverToStorage(id, req.file);
        if (coverUrl) payload.cover_url = coverUrl;
    }
    const item = await updatePlaylist(id, payload);
    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    const playlist = await getPlaylist(id);
    if (!playlist) throw createError(404, 'Playlist not found');
    await deletePlaylistCoverFromStorage(playlist.playlist_id, playlist.cover_url);
    await deletePlaylist(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };

// Add a track to a playlist (admin)
async function addTrack(req, res) {
    const { id } = req.params; // playlist_id
    const { track_id } = req.body;
    if (!track_id) return res.status(400).json({ error: 'track_id is required' });
    await addPlaylistTrack(id, track_id, req.user?.id || null);
    const updated = await getPlaylist(id);
    res.status(200).json(updated);
}

// Remove a track from a playlist (admin)
async function removeTrack(req, res) {
    const { id, trackId } = req.params; // playlist_id and trackId
    await removePlaylistTrack(id, trackId);
    res.status(204).send();
}

module.exports.addTrack = addTrack;
module.exports.removeTrack = removeTrack;
