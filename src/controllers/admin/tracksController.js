const createError = require('http-errors');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const { supabase, supabaseAdmin } = require('../../db/config');
const { processAudioBuffer } = require('../../utils/processAudio');
const { listTracks, getTrack, createTrack, updateTrack, deleteTrack } = require('../../models/trackModel');
const { addTrackAudio, deleteAudiosForTrack } = require('../../models/trackAudiosModel');
const { addTrackArtist } = require('../../models/trackArtistsModel');
const { getAlbum } = require('../../models/albumModel');
const { uploadTrackVideoToStorage, deleteTrackVideoFromStorage } = require('../../utils/supabaseStorage');
const { isUUID } = require('../../utils/validators');

function getFileFromReq(req, field) {
    if (!req.files) return null;
    const arr = req.files[field];
    if (!arr || !arr.length) return null;
    return arr[0];
}

async function list(req, res) {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const page = Math.max(0, Number(req.query.page) || 0);
    const q = req.query.q || undefined;
    const offset = page * limit;
    const { items, total } = await listTracks({ limit, offset, q });
    res.json({ items, total, page, limit });
}

async function getOne(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid track id');
    const item = await getTrack(id);
    if (!item) throw createError(404, 'Track not found');
    res.json(item);
}

async function create(req, res) {
    // expect form-data fields and files
    const body = { ...req.body };

    // Validate required files
    const audioFileRequired = getFileFromReq(req, 'audio');
    if (!audioFileRequired) {
        return res.status(400).json({ error: 'audio file is required' });
    }

    // Validate mandatory album association
    if (!body.album_id) {
        return res.status(400).json({ error: 'album_id is required for all tracks' });
    }

    // initially create track without audio and is_published=false
    body.is_published = false;
    var result;
    const created = await createTrack(body);

    result = created;

    // Auto-link album owners as track owners
    try {
        const album = await getAlbum(body.album_id);
        const owners = (album?.artists || []).filter(a => a.role === 'owner');
        for (const o of owners) {
            try { await addTrackArtist(created.track_id, o.artist_id, 'owner'); } catch (_) { /* ignore duplicates or errors */ }
        }
    } catch (_) { /* ignore album lookup issues for artist linking */ }

    // Optionally accept extra artists from payload: artists=[{artist_id, role}]
    const rawArtists = req.body?.artists;
    if (rawArtists) {
        let extras = [];
        if (typeof rawArtists === 'string') {
            try { extras = JSON.parse(rawArtists); } catch (_) { extras = []; }
        } else if (Array.isArray(rawArtists)) {
            extras = rawArtists;
        }
        for (const a of extras) {
            const artist_id = a?.artist_id;
            const role = (a?.role || 'viewer').toString();
            if (artist_id) {
                try { await addTrackArtist(created.track_id, artist_id, role); } catch (_) { /* ignore duplicates or invalid */ }
            }
        }
    }

    // if audio file present, process it now using the canonical created.track_id
    const audioFile = audioFileRequired;
    if (audioFile) {
        try {
            const audioResult = await processAudioBuffer(audioFile, created.track_id);
            // persist audio variants into track_audios
            for (const [key, url] of Object.entries(audioResult.files || {})) {
                // key format like '320k_mp3' or '96k_ogg'
                const [kbPart, extPart] = key.split('_');
                const bitrate = Number.parseInt(kbPart.replace('k', ''), 10);
                const ext = extPart.toLowerCase();
                await addTrackAudio(created.track_id, ext, bitrate, url);
            }
            const updated = await updateTrack(created.track_id, { is_published: true });
            result = updated;
        } catch (e) {
            console.error('Audio processing failed after track creation:', e?.message || e);
            // return created record but indicate processing failed
            return res.status(500).json({ error: 'Audio processing failed', track: created });
        }
    }

    // if video is present, upload it
    const video = getFileFromReq(req, 'video');
    if (video) {
        const videoUrl = await uploadTrackVideoToStorage(created.track_id, video);
        if (videoUrl) {
            result = await updateTrack(created.track_id, { video_url: videoUrl });
        }
    }

    // no audio to process — return created (not published)
    res.status(201).json(result);
}

async function update(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid track id');
    const body = { ...req.body };

    var result;

    result = await updateTrack(id, body);

    // if audio file present, process it now and update track_audios
    const audioFile = getFileFromReq(req, 'audio');
    if (audioFile) {
        try {
            const audioResult = await processAudioBuffer(audioFile, id);
            // replace existing audios
            await deleteAudiosForTrack(id);
            for (const [key, url] of Object.entries(audioResult.files || {})) {
                const [kbPart, extPart] = key.split('_');
                const bitrate = Number.parseInt(kbPart.replace('k', ''), 10);
                const ext = extPart.toLowerCase();
                await addTrackAudio(id, ext, bitrate, url);
            }
            const updated = await updateTrack(id, { is_published: true });
            result = updated;
        } catch (e) {
            console.error('Audio processing failed after track creation:', e?.message || e);
            // return created record but indicate processing failed
            return res.status(500).json({ error: 'Audio processing failed', track_id: id });
        }
    }

    // if video is present, upload it
    const video = getFileFromReq(req, 'video');
    if (video) {
        const videoUrl = await uploadTrackVideoToStorage(id, video);
        if (videoUrl) {
            result = await updateTrack(id, { video_url: videoUrl });
        }
    }

    res.json(result);
}

async function remove(req, res) {
    const { id } = req.params;
    if (!isUUID(id)) throw createError(400, 'invalid track id');
    const track = await getTrack(id);
    if (!track) throw createError(404, 'Track not found');
    await deleteTrackVideoFromStorage(track.track_id, track.video_url)
    // delete audio DB rows; blob deletion is managed by storage lifecycle if any
    await deleteAudiosForTrack(id);
    await deleteTrack(id);
    res.status(204).send();
}

module.exports = { list, getOne, create, update, remove };
