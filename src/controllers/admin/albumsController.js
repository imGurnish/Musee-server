const createError = require('http-errors');
const { listAlbums, getAlbum, createAlbum, updateAlbum, deleteAlbum } = require('../../models/albumModel');
const { createAlbumArtist, updateAlbumArtistByPair, deleteAlbumArtistByPair } = require('../../models/albumArtistsModel');
const { uploadAlbumCoverToStorage, deleteAlbumCoverFromStorage } = require('../../utils/supabaseStorage');
const { cleanupAlbumTrackBlobs } = require('../../utils/trackBlobCleanup');
const { isUUID, validateArtistRoles } = require('../../utils/validators');
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../../utils/externalRefs');

function parseJsonMaybe(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return value;
    }
}

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
    payload.external_payload = parseJsonMaybe(payload.external_payload);
    const providerCode = payload.source || 'jiosaavn';
    const extAlbumId = payload.ext_album_id || payload.external_id || null;
    const artist_id = payload.artist_id;
    if (!artist_id) {
        return res.status(400).json({ message: 'artist_id is required' });
    }

    if (extAlbumId) {
        const providerId = await getProviderId(providerCode);
        const existingAlbumId = await findEntityIdByExternalId({
            refTable: 'album_external_refs',
            entityIdColumn: 'album_id',
            providerId,
            externalId: extAlbumId,
        });

        if (existingAlbumId) {
            const existingAlbum = await getAlbum(existingAlbumId);
            await upsertExternalRef({
                refTable: 'album_external_refs',
                entityIdColumn: 'album_id',
                entityId: existingAlbumId,
                providerId,
                externalId: extAlbumId,
                externalUrl: payload.album_url || payload.perma_url || payload.external_url || null,
                imageUrl: payload.image || payload.cover_url || null,
                rawPayload: payload.external_payload || null,
            });
            return res.status(200).json(existingAlbum);
        }
    }

    let album;
    try {
        album = await createAlbum(payload);
        // Link required owner
        await createAlbumArtist(album.album_id, artist_id, 'owner');
    } catch (error) {
        if (album?.album_id) {
            try { await deleteAlbum(album.album_id); } catch (_) { }
        }
        throw error;
    }

    if (extAlbumId) {
        const providerId = await getProviderId(providerCode);
        await upsertExternalRef({
            refTable: 'album_external_refs',
            entityIdColumn: 'album_id',
            entityId: album.album_id,
            providerId,
            externalId: extAlbumId,
            externalUrl: payload.album_url || payload.perma_url || payload.external_url || null,
            imageUrl: payload.image || payload.cover_url || null,
            rawPayload: payload.external_payload || null,
        });
    }

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

    await cleanupAlbumTrackBlobs(id);
    if (album.cover_url) {
        const removed = await deleteAlbumCoverFromStorage(id, album.cover_url);
        if (!removed) throw createError(500, 'Failed to delete album cover from storage');
    }

    await deleteAlbum(id);
    res.status(204).send();
}

async function removeMany(req, res) {
    const idsInput = req.body?.ids;
    if (!Array.isArray(idsInput) || idsInput.length === 0) {
        throw createError(400, 'ids array is required');
    }

    const ids = [...new Set(idsInput.map((v) => String(v).trim()).filter(Boolean))];
    if (!ids.every(isUUID)) {
        throw createError(400, 'all ids must be valid UUIDs');
    }

    let deleted = 0;
    const notFound = [];

    for (const id of ids) {
        const album = await getAlbum(id);
        if (!album) {
            notFound.push(id);
            continue;
        }

        await cleanupAlbumTrackBlobs(id);
        if (album.cover_url) {
            const removed = await deleteAlbumCoverFromStorage(id, album.cover_url);
            if (!removed) throw createError(500, `Failed to delete album cover from storage for album ${id}`);
        }

        await deleteAlbum(id);
        deleted += 1;
    }

    res.json({ deleted, notFound });
}

module.exports = { list, getOne, create, update, remove, removeMany, addArtist, updateArtist, removeArtist };
