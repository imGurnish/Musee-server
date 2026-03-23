const createError = require('http-errors');
const { listAlbumsUser, getAlbumUser, createAlbum, updateAlbum, deleteAlbum, getAlbum } = require('../../models/albumModel');
const { createAlbumArtist, updateAlbumArtistByPair, deleteAlbumArtistByPair } = require('../../models/albumArtistsModel');
const { getArtist } = require('../../models/artistModel');
const { isUUID, validateArtistRoles } = require('../../utils/validators');
const { uploadAlbumCoverToStorage, deleteAlbumCoverFromStorage } = require('../../utils/supabaseStorage');

function filterAllowedFields(payload) {
    // Whitelist fields that users can update about themselves
    const allowed = new Set(['title', 'subtitle', 'description', 'release_date', 'release_year', 'language_code', 'label_id', 'copyright_text', 'is_published']);
    const out = {};
    for (const key of Object.keys(payload || {})) {
        if (allowed.has(key)) out[key] = payload[key];
        else throw createError(403, 'invalid field ' + key);
    }

    return out;
}

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listAlbumsUser({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    const item = await getAlbumUser(id);
    if (!item) throw createError(404, 'Album not found');
    res.json(item);
}

async function create(req, res) {
    // Create first to get album_id, then upload cover if present
    const payload = filterAllowedFields({ ...req.body });
    // Only allow artists to create albums; verify user has an artist profile
    const artist = await getArtist(req.user.id);
    if (!artist) throw createError(403, 'Only artists can create albums');

    const album = await createAlbum(payload);
    // Link the creating artist as owner of the album
    await createAlbumArtist(album.album_id, req.user.id, 'owner');
    if (req.file) {
        const coverUrl = await uploadAlbumCoverToStorage(album.album_id, req.file);
        if (coverUrl) {
            const updated = await updateAlbum(album.album_id, { cover_url: coverUrl });
            // Return with joined data
            const enriched = await getAlbum(updated.album_id);
            return res.status(201).json(enriched || updated);
        }
    }
    const enriched = await getAlbum(album.album_id);
    res.status(201).json(enriched || album);
}

async function update(req, res) {
    const { id } = req.params;
    const payload = filterAllowedFields({ ...req.body });

    const album = await getAlbum(id);
    if (!album) throw createError(404, 'Album not found');

    const userIsOwner = (album.artists || []).some(a => a.artist_id === req.user.id && a.role === 'owner');
    if (!userIsOwner) throw createError(403, 'Forbidden');

    if (req.file) {
        const coverUrl = await uploadAlbumCoverToStorage(id, req.file);
        if (coverUrl) payload.cover_url = coverUrl;
    }
    const item = await updateAlbum(id, payload);
    const enriched = await getAlbum(item.album_id);
    res.json(enriched || item);
}

async function remove(req, res) {
    const { id } = req.params;

    const album = await getAlbum(id);
    if (!album) throw createError(404, 'Album not found');

    const userIsOwner = (album.artists || []).some(a => a.artist_id === req.user.id && a.role === 'owner');
    if (!userIsOwner) throw createError(403, 'Forbidden');

    await deleteAlbumCoverFromStorage(album.album_id, album.cover_url);

    await deleteAlbum(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };

// Owner-only management of album artists
async function ensureOwner(req, albumId) {
    const album = await getAlbum(albumId);
    if (!album) throw createError(404, 'Album not found');
    const userIsOwner = (album.artists || []).some(a => a.artist_id === req.user.id && a.role === 'owner');
    if (!userIsOwner) throw createError(403, 'Forbidden');
    return album;
}

async function addArtist(req, res) {
    const { id: album_id } = req.params;
    const { artist_id, role = 'viewer' } = req.body || {};
    await ensureOwner(req, album_id);
    if (!isUUID(artist_id)) throw createError(400, 'invalid artist_id');
    if (!validateArtistRoles(role)) throw createError(400, 'invalid role');
    const row = await createAlbumArtist(album_id, artist_id, role);
    res.status(201).json(row);
}

async function updateArtist(req, res) {
    const { id: album_id, artistId } = req.params;
    const { role } = req.body || {};
    await ensureOwner(req, album_id);
    if (!isUUID(artistId)) throw createError(400, 'invalid artist_id');
    if (!validateArtistRoles(role)) throw createError(400, 'invalid role');
    const updated = await updateAlbumArtistByPair(album_id, artistId, role);
    if (!updated) throw createError(404, 'Album artist link not found');
    res.json(updated);
}

async function removeArtist(req, res) {
    const { id: album_id, artistId } = req.params;
    await ensureOwner(req, album_id);
    if (!isUUID(artistId)) throw createError(400, 'invalid artist_id');
    const removed = await deleteAlbumArtistByPair(album_id, artistId);
    if (!removed) throw createError(404, 'Album artist link not found');
    res.status(204).send();
}

module.exports.addArtist = addArtist;
module.exports.updateArtist = updateArtist;
module.exports.removeArtist = removeArtist;
