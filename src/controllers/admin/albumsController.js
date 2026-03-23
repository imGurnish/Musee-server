const createError = require('http-errors');
const { listAlbums, getAlbum, createAlbum, updateAlbum, deleteAlbum } = require('../../models/albumModel');
const { createAlbumArtist, updateAlbumArtistByPair, deleteAlbumArtistByPair } = require('../../models/albumArtistsModel');
const { uploadAlbumCoverToStorage, deleteAlbumCoverFromStorage } = require('../../utils/supabaseStorage');
const { isUUID, validateArtistRoles } = require('../../utils/validators');

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listAlbums({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid album id');
    const item = await getAlbum(id);
    if (!item) throw createError(404, 'Album not found');
    res.json(item);
}

async function create(req, res) {
    // Admin must provide artist_id for album ownership
    const payload = { ...req.body };
    const artist_id = payload.artist_id;
    if (!artist_id) {
        return res.status(400).json({ message: 'artist_id is required' });
    }

    const album = await createAlbum(payload);
    // Link required owner
    await createAlbumArtist(album.album_id, artist_id, 'owner');

    if (req.file) {
        const coverUrl = await uploadAlbumCoverToStorage(album.album_id, req.file);
        if (coverUrl) {
            const updated = await updateAlbum(album.album_id, { cover_url: coverUrl });
            return res.status(201).json(updated);
        }
    }
    res.status(201).json(album);
}

// Manage album artists (admin)
async function addArtist(req, res) {
    const { id: album_id } = req.params;
    const { artist_id, role = 'viewer' } = req.body || {};
    if (!isUUID(album_id) || !isUUID(artist_id)) return res.status(400).json({ message: 'invalid album_id or artist_id' });
    if (!validateArtistRoles(role)) return res.status(400).json({ message: 'invalid role' });
    const row = await createAlbumArtist(album_id, artist_id, role);
    res.status(201).json(row);
}

async function updateArtist(req, res) {
    const { id: album_id, artistId } = req.params;
    const { role } = req.body || {};
    if (!isUUID(album_id) || !isUUID(artistId)) return res.status(400).json({ message: 'invalid album_id or artist_id' });
    if (!validateArtistRoles(role)) return res.status(400).json({ message: 'invalid role' });

    // Update by album+artist pair using model's update (which uses id)
    const updated = await updateAlbumArtistByPair(album_id, artistId, role);
    if (!updated) return res.status(404).json({ message: 'Album artist link not found' });
    res.json(updated);
}

async function removeArtist(req, res) {
    const { id: album_id, artistId } = req.params;
    if (!isUUID(album_id) || !isUUID(artistId)) return res.status(400).json({ message: 'invalid album_id or artist_id' });
    const removed = await deleteAlbumArtistByPair(album_id, artistId);
    if (!removed) return res.status(404).json({ message: 'Album artist link not found' });
    res.status(204).send();
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid album id');
    const payload = { ...req.body };
    if (req.file) {
        const coverUrl = await uploadAlbumCoverToStorage(id, req.file);
        if (coverUrl) payload.cover_url = coverUrl;
    }
    const item = await updateAlbum(id, payload);
    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid album id');
    const album = await getAlbum(id);
    if (!album) {
        return res.status(404).json({ message: 'Album not found' });
    }
    await deleteAlbumCoverFromStorage(id, album.cover_url);
    await deleteAlbum(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove, addArtist, updateArtist, removeArtist };
