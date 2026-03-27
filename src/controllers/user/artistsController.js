const createError = require('http-errors');
const {
    getArtist,
    createArtist,
    updateArtist,
    deleteArtist,
    listArtistsUser,
    getArtistUser,
} = require('../../models/artistModel');
const { listTracksByArtistUser } = require('../../models/trackModel');
const { listAlbumsByArtistUser } = require('../../models/albumModel');
const { updateUser } = require('../../models/userModel');
const { uploadArtistCoverToStorage } = require('../../utils/supabaseStorage');
const { isUUID } = require('../../utils/validators');

function filterAllowedFields(payload) {
    // Whitelist fields that users can update about themselves
    const allowed = new Set(['bio', 'cover_url', 'social_links', 'region_id', 'date_of_birth', 'debut_year']);
    const out = {};
    for (const key of Object.keys(payload || {})) {
        if (allowed.has(key)) out[key] = payload[key];
        else throw createError(403, 'invalid field ' + key);
    }
    return out;
}

// GET /api/user/artists?limit=&page=&q=
async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listArtistsUser({ limit, offset, q });
    res.json({ items, total, page, limit });
}

// GET /api/user/artists/:id
async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const item = await getArtistUser(id);
    if (!item) throw createError(404, 'Artist not found');
    res.json(item);
}

// POST /api/user/artists  -> current user becomes artist
async function create(req, res) {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    // Prevent duplicate creation
    const existing = await getArtist(userId);
    if (existing) throw createError(409, 'Artist profile already exists');

    // Sanitize artist inputs BEFORE any DB calls
    const body = filterAllowedFields({ ...req.body });
    // Ensure artist_id references the authenticated user
    body.artist_id = userId;

    // Create artist referencing current user
    let artist = await createArtist(body);

    // Upload cover if provided and update
    if (req.file) {
        const coverUrl = await uploadArtistCoverToStorage(userId, req.file);
        if (coverUrl) {
            artist = await updateArtist(userId, { cover_url: coverUrl });
        }
    }

    // Update user_type -> 'artist' 
    try { await updateUser(userId, { user_type: 'artist' }); } catch { }

    return res.status(201).json(artist);
}

// PATCH /api/user/artists/:id  -> only own id
async function update(req, res) {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    if (!userId) throw createError(401, 'Unauthorized');
    if (id !== userId) throw createError(403, 'Forbidden');

    const body = filterAllowedFields({ ...req.body });
    const item = await updateArtist(userId, body);
    if (req.file) {
        const coverUrl = await uploadArtistCoverToStorage(userId, req.file);
        if (coverUrl) item.cover_url = coverUrl;
    }
    res.json(item);
}

// DELETE /api/user/artists/:id  -> only own id; set user_type back to listener
async function remove(req, res) {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    if (!userId) throw createError(401, 'Unauthorized');
    if (id !== userId) throw createError(403, 'Forbidden');

    await deleteArtist(userId);
    try { await updateUser(userId, { user_type: 'listener' }); } catch { }
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };
// GET /api/user/artists/:id/tracks
async function listTracks(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listTracksByArtistUser({ artist_id: id, limit, offset, q });
    res.json({ items, total, page, limit });
}

// GET /api/user/artists/:id/albums
async function listAlbums(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listAlbumsByArtistUser({ artist_id: id, limit, offset, q });
    res.json({ items, total, page, limit });
}

module.exports.listTracks = listTracks;
module.exports.listAlbums = listAlbums;
