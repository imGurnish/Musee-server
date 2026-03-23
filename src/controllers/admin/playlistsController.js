const createError = require('http-errors');
const { listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist } = require('../../models/playlistModel');
const { addPlaylistTrack, removePlaylistTrack } = require('../../models/playlistTracksModel');
const { uploadPlaylistCoverToStorage, deletePlaylistCoverFromStorage } = require('../../utils/supabaseStorage');
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
    if (!isUUID(id)) throw createError(400, 'invalid playlist id');
    const item = await getPlaylist(id);
    if (!item) throw createError(404, 'Playlist not found');
    res.json(item);
}

async function create(req, res) {
    const payload = { ...req.body };
    payload.external_payload = parseJsonMaybe(payload.external_payload);
    const providerCode = payload.source || 'jiosaavn';
    const extPlaylistId = payload.ext_playlist_id || payload.external_id || null;

    if (extPlaylistId) {
        const providerId = await getProviderId(providerCode);
        const existingPlaylistId = await findEntityIdByExternalId({
            refTable: 'playlist_external_refs',
            entityIdColumn: 'playlist_id',
            providerId,
            externalId: extPlaylistId,
        });

        if (existingPlaylistId) {
            const existingPlaylist = await getPlaylist(existingPlaylistId);
            await upsertExternalRef({
                refTable: 'playlist_external_refs',
                entityIdColumn: 'playlist_id',
                entityId: existingPlaylistId,
                providerId,
                externalId: extPlaylistId,
                externalUrl: payload.playlist_url || payload.perma_url || payload.external_url || null,
                imageUrl: payload.image || payload.cover_url || null,
                rawPayload: payload.external_payload || null,
            });
            return res.status(200).json(existingPlaylist);
        }
    }

    const playlist = await createPlaylist(payload);

    if (extPlaylistId) {
        const providerId = await getProviderId(providerCode);
        await upsertExternalRef({
            refTable: 'playlist_external_refs',
            entityIdColumn: 'playlist_id',
            entityId: playlist.playlist_id,
            providerId,
            externalId: extPlaylistId,
            externalUrl: payload.playlist_url || payload.perma_url || payload.external_url || null,
            imageUrl: payload.image || payload.cover_url || null,
            rawPayload: payload.external_payload || null,
        });
    }

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
    if (!isUUID(id)) throw createError(400, 'invalid playlist id');
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
    if (!isUUID(id)) throw createError(400, 'invalid playlist id');
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
    if (!isUUID(id)) throw createError(400, 'invalid playlist id');
    if (!isUUID(track_id)) throw createError(400, 'invalid track id');
    if (!track_id) return res.status(400).json({ error: 'track_id is required' });
    await addPlaylistTrack(id, track_id, req.user?.id || null);
    const updated = await getPlaylist(id);
    res.status(200).json(updated);
}

// Remove a track from a playlist (admin)
async function removeTrack(req, res) {
    const { id, trackId } = req.params; // playlist_id and trackId
    if (!isUUID(id)) throw createError(400, 'invalid playlist id');
    if (!isUUID(trackId)) throw createError(400, 'invalid track id');
    await removePlaylistTrack(id, trackId);
    res.status(204).send();
}

module.exports.addTrack = addTrack;
module.exports.removeTrack = removeTrack;
