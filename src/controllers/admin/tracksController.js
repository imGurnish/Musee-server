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
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../../utils/externalRefs');

function parseJsonMaybe(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return value;
    }
}

const LANGUAGE_NAME_TO_CODE = {
    english: 'en',
    hindi: 'hi',
    punjabi: 'pa',
    bengali: 'bn',
    tamil: 'ta',
    telugu: 'te',
    marathi: 'mr',
    gujarati: 'gu',
    urdu: 'ur',
    malayalam: 'ml',
    kannada: 'kn',
};

const LANGUAGE_CODE_TO_NAME = {
    en: 'English',
    hi: 'Hindi',
    pa: 'Punjabi',
    bn: 'Bengali',
    ta: 'Tamil',
    te: 'Telugu',
    mr: 'Marathi',
    gu: 'Gujarati',
    ur: 'Urdu',
    ml: 'Malayalam',
    kn: 'Kannada',
};

function toTitleCase(input) {
    return String(input || '')
        .split(' ')
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function normalizeLanguage(input) {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw) return null;

    const lower = raw.toLowerCase();
    if (LANGUAGE_NAME_TO_CODE[lower]) {
        const code = LANGUAGE_NAME_TO_CODE[lower];
        return { code, name: LANGUAGE_CODE_TO_NAME[code] || toTitleCase(raw) };
    }

    if (/^[a-z]{2,3}(-[a-z]{2})?$/i.test(raw)) {
        const code = lower;
        return { code, name: LANGUAGE_CODE_TO_NAME[code] || toTitleCase(code) };
    }

    return { code: lower, name: toTitleCase(raw) };
}

async function ensureLanguageExists(languageCode, languageName) {
    if (!languageCode) return;
    const db = supabaseAdmin || supabase;
    const existing = await db
        .from('languages')
        .select('language_code')
        .eq('language_code', languageCode)
        .maybeSingle();

    if (existing.error) throw existing.error;
    if (existing.data) return;

    const insertRes = await db
        .from('languages')
        .insert({ language_code: languageCode, name: languageName || toTitleCase(languageCode) });

    if (insertRes.error) throw insertRes.error;
    console.log('Created missing language row:', languageCode);
}

function getFileFromReq(req, field) {
    if (!req.files) return null;
    const arr = req.files[field];
    if (!arr || !arr.length) return null;
    return arr[0];
}

function isTrackLanguageFkError(error) {
    if (!error) return false;
    const message = String(error.message || '').toLowerCase();
    const details = String(error.details || '').toLowerCase();
    return (
        error.code === '23503' &&
        (message.includes('tracks_language_code_fkey') || details.includes('tracks_language_code_fkey'))
    );
}

async function createTrackWithLanguageFallback(body) {
    try {
        return await createTrack(body);
    } catch (error) {
        if (body.language_code !== undefined && body.language_code !== null && isTrackLanguageFkError(error)) {
            console.warn('Invalid language_code for track create, retrying with null:', body.language_code);
            const retryBody = { ...body, language_code: null };
            return await createTrack(retryBody);
        }
        throw error;
    }
}

async function updateTrackWithLanguageFallback(trackId, body) {
    try {
        return await updateTrack(trackId, body);
    } catch (error) {
        if (body.language_code !== undefined && body.language_code !== null && isTrackLanguageFkError(error)) {
            console.warn('Invalid language_code for track update, retrying with null:', body.language_code);
            const retryBody = { ...body, language_code: null };
            return await updateTrack(trackId, retryBody);
        }
        throw error;
    }
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
    body.external_payload = parseJsonMaybe(body.external_payload);
    body.rights = parseJsonMaybe(body.rights);
    const providerCode = body.source || 'jiosaavn';
    const extTrackId = body.ext_track_id || body.external_id || null;

    if (extTrackId) {
        const providerId = await getProviderId(providerCode);
        const existingTrackId = await findEntityIdByExternalId({
            refTable: 'track_external_refs',
            entityIdColumn: 'track_id',
            providerId,
            externalId: extTrackId,
        });

        if (existingTrackId) {
            const existingTrack = await getTrack(existingTrackId);
            await upsertExternalRef({
                refTable: 'track_external_refs',
                entityIdColumn: 'track_id',
                entityId: existingTrackId,
                providerId,
                externalId: extTrackId,
                externalUrl: body.perma_url || body.external_url || null,
                imageUrl: body.image || body.cover_url || null,
                rawPayload: body.external_payload || null,
                extra: {
                    external_album_id: body.ext_album_id || body.external_album_id || body.album_external_id || null,
                    language: body.language || null,
                    release_date: body.release_date || null,
                    has_lyrics: body.has_lyrics === undefined ? null : !!body.has_lyrics,
                    is_drm: body.is_drm === undefined ? null : !!body.is_drm,
                    is_dolby_content: body.is_dolby_content === undefined ? null : !!body.is_dolby_content,
                    has_320kbps: body.has_320kbps === undefined ? null : !!body.has_320kbps,
                    encrypted_media_url: body.encrypted_media_url || null,
                    encrypted_drm_media_url: body.encrypted_drm_media_url || null,
                    encrypted_media_path: body.encrypted_media_path || null,
                    media_preview_url: body.media_preview_url || null,
                    rights: body.rights || null,
                },
            });
            return res.status(200).json(existingTrack);
        }
    }

    const normalizedLanguage = normalizeLanguage(body.language_code);
    if (normalizedLanguage) {
        await ensureLanguageExists(normalizedLanguage.code, normalizedLanguage.name);
        body.language_code = normalizedLanguage.code;
    }

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
    const created = await createTrackWithLanguageFallback(body);

    result = created;

    if (extTrackId) {
        const providerId = await getProviderId(providerCode);
        await upsertExternalRef({
            refTable: 'track_external_refs',
            entityIdColumn: 'track_id',
            entityId: created.track_id,
            providerId,
            externalId: extTrackId,
            externalUrl: body.perma_url || body.external_url || null,
            imageUrl: body.image || body.cover_url || null,
            rawPayload: body.external_payload || null,
            extra: {
                external_album_id: body.ext_album_id || body.external_album_id || body.album_external_id || null,
                language: body.language || null,
                release_date: body.release_date || null,
                has_lyrics: body.has_lyrics === undefined ? null : !!body.has_lyrics,
                is_drm: body.is_drm === undefined ? null : !!body.is_drm,
                is_dolby_content: body.is_dolby_content === undefined ? null : !!body.is_dolby_content,
                has_320kbps: body.has_320kbps === undefined ? null : !!body.has_320kbps,
                encrypted_media_url: body.encrypted_media_url || null,
                encrypted_drm_media_url: body.encrypted_drm_media_url || null,
                encrypted_media_path: body.encrypted_media_path || null,
                media_preview_url: body.media_preview_url || null,
                rights: body.rights || null,
            },
        });
    }

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
            // rollback created track to avoid half-data
            try { await deleteTrack(created.track_id); } catch (_) { }
            return res.status(500).json({
                error: 'Audio processing failed',
                rolled_back: true,
                track_id: created.track_id,
            });
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

    const normalizedLanguage = normalizeLanguage(body.language_code);
    if (normalizedLanguage) {
        await ensureLanguageExists(normalizedLanguage.code, normalizedLanguage.name);
        body.language_code = normalizedLanguage.code;
    }

    var result;

    result = await updateTrackWithLanguageFallback(id, body);

    // if audio file present, process it now and update track_audios
    const audioFile = getFileFromReq(req, 'audio');
    if (audioFile) {
        const db = supabaseAdmin || supabase;
        const previousAudiosRes = await db.from('track_audios').select('*').eq('track_id', id);
        const previousAudios = previousAudiosRes.error ? [] : (previousAudiosRes.data || []);
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
            // restore previous audios to avoid corrupted state
            try {
                await deleteAudiosForTrack(id);
                for (const a of previousAudios) {
                    await addTrackAudio(id, a.ext, a.bitrate, a.path);
                }
            } catch (_) { }
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
