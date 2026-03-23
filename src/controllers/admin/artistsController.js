const createError = require('http-errors');
const { listArtists, getArtist, createArtist, updateArtist, deleteArtist, sanitizeArtistInsert } = require('../../models/artistModel');
const { updateUser, sanitizeUserInsert, getUserByEmail } = require('../../models/userModel');
const { uploadUserAvatarToStorage, uploadArtistCoverToStorage, deleteArtistCoverFromStorage } = require('../../utils/supabaseStorage');
const { createAuthUser } = require('../../models/authUserModel');
const { listTracksByArtist } = require('../../models/trackModel');
const { listAlbumsByArtist } = require('../../models/albumModel');
const { isUUID } = require('../../utils/validators');
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../../utils/externalRefs');

function parseJsonMaybe(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return value;
    }
}

function isEmailExistsError(error) {
    return error?.code === 'email_exists' || error?.status === 422;
}

function isDuplicateArtistError(error) {
    return error?.code === '23505' || /duplicate key|already exists|unique/i.test(String(error?.message || ''));
}

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listArtists({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const item = await getArtist(id);
    if (!item) throw createError(404, 'Artist not found');
    res.json(item);
}

async function create(req, res) {
    // Sanitize inputs BEFORE any DB operations
    const body = { ...req.body };
    body.external_payload = parseJsonMaybe(body.external_payload);
    const providerCode = body.source || 'jiosaavn';
    const extArtistId = body.ext_artist_id || body.external_id || null;
    let artist_id = req.body.artist_id;
    const avatarFile = req.files?.avatar?.[0];

    if (extArtistId) {
        const providerId = await getProviderId(providerCode);
        const existingArtistId = await findEntityIdByExternalId({
            refTable: 'artist_external_refs',
            entityIdColumn: 'artist_id',
            providerId,
            externalId: extArtistId,
        });

        if (existingArtistId) {
            const existingArtist = await getArtist(existingArtistId);
            await upsertExternalRef({
                refTable: 'artist_external_refs',
                entityIdColumn: 'artist_id',
                entityId: existingArtistId,
                providerId,
                externalId: extArtistId,
                externalUrl: body.artist_url || body.perma_url || body.external_url || null,
                imageUrl: body.image || body.avatar_url || body.cover_url || null,
                rawPayload: body.external_payload || null,
            });
            return res.status(200).json(existingArtist);
        }
    }

    if (!artist_id) {
        const userInput = sanitizeUserInsert(body);
        let user = null;
        try {
            const authUser = await createAuthUser(userInput.name, userInput.email, userInput.password);
            user = await updateUser(authUser.id, { ...userInput, user_type: 'artist' });
        } catch (err) {
            if (!isEmailExistsError(err)) throw err;
            const existingUser = await getUserByEmail(userInput.email);
            if (!existingUser?.user_id) {
                throw createError(422, 'A user with this email address has already been registered');
            }
            user = await updateUser(existingUser.user_id, { name: userInput.name, user_type: 'artist' });
        }

        artist_id = user.user_id;
        // 1a) If avatar file provided, upload and set on user
        if (avatarFile) {
            const avatarUrl = await uploadUserAvatarToStorage(artist_id, avatarFile);
            if (avatarUrl) {
                try { await updateUser(artist_id, { avatar_url: avatarUrl }); } catch { }
            }
        }
        body.artist_id = artist_id;
    } else {
        try { await updateUser(artist_id, { user_type: 'artist' }); } catch { }
        if (avatarFile) {
            const avatarUrl = await uploadUserAvatarToStorage(artist_id, avatarFile);
            if (avatarUrl) {
                try { await updateUser(artist_id, { avatar_url: avatarUrl }); } catch { }
            }
        }
    }
    console.log("Creating artist with data:", body);
    const artistInput = sanitizeArtistInsert(body);

    // Create artist with the new user id
    let artist;
    let created = true;
    try {
        artist = await createArtist({ ...artistInput });
    } catch (err) {
        if (!isDuplicateArtistError(err)) throw err;
        const existing = await getArtist(artistInput.artist_id);
        if (!existing) throw err;
        artist = existing;
        created = false;
    }

    if (extArtistId) {
        const providerId = await getProviderId(providerCode);
        await upsertExternalRef({
            refTable: 'artist_external_refs',
            entityIdColumn: 'artist_id',
            entityId: artist.artist_id,
            providerId,
            externalId: extArtistId,
            externalUrl: body.artist_url || body.perma_url || body.external_url || null,
            imageUrl: body.image || body.avatar_url || body.cover_url || null,
            rawPayload: body.external_payload || null,
        });
    }

    // Upload cover if provided and update
    const coverFile = req.files?.cover?.[0] || req.file;
    if (coverFile) {
        const coverUrl = await uploadArtistCoverToStorage(artist.artist_id, coverFile);
        if (coverUrl) {
            const updated = await updateArtist(artist.artist_id, { cover_url: coverUrl });
            return res.status(created ? 201 : 200).json(updated);
        }
    }

    return res.status(created ? 201 : 200).json(artist);
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const payload = { ...req.body };
    if (req.file) {
        const coverUrl = await uploadArtistCoverToStorage(id, req.file);
        if (coverUrl) payload.cover_url = coverUrl;
    }
    const item = await updateArtist(id, payload);
    res.json(item);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const artist = await getArtist(id);
    if (!artist) {
        return res.status(404).json({ message: 'Artist not found' });
    }
    await deleteArtistCoverFromStorage(id, artist.cover_url);
    await deleteArtist(id);
    // Optionally downgrade user_type to 'listener' -- leave as-is for now
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };
// GET /api/admin/artists/:id/tracks
async function listTracks(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listTracksByArtist({ artist_id: id, limit, offset, q });
    res.json({ items, total, page, limit });
}

// GET /api/admin/artists/:id/albums
async function listAlbums(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid artist id');
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listAlbumsByArtist({ artist_id: id, limit, offset, q });
    res.json({ items, total, page, limit });
}

module.exports.listTracks = listTracks;
module.exports.listAlbums = listAlbums;
