/**
 * Import Controller - Queue-based JioSaavn importer
 * Order: artist -> album -> track -> playlist
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const { supabaseAdmin } = require('../../db/config');
const { executeTransaction, createAndTrack, updateAndTrack } = require('../../utils/transaction');
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../../utils/externalRefs');
const { processAudioBuffer } = require('../../utils/processAudio');
const { addTrackAudio } = require('../../models/trackAudiosModel');

const DEFAULTS = {
  artistAvatar: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/avatars/users/default_avatar.png',
  artistCover: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/artists/default_cover.png',
  albumCover: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/albums/default_cover.png',
  playlistCover: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/playlists/default_cover.png'
};

const SAAVN_BASE = 'https://www.jiosaavn.com/api.php';
const TRACK_IMPORT_CONCURRENCY = Math.max(
  1,
  Math.min(100, Number.parseInt(process.env.IMPORT_TRACK_CONCURRENCY || '20', 10) || 20)
);

const importJobs = new Map();
const albumImportInFlight = new Map();

function importLog(level, message, context = null) {
  const payload = context ? `${message} | ${JSON.stringify(context)}` : message;
  const prefix = '[ImportController]';

  if (level === 'error') {
    logger.error(`${prefix} ${payload}`);
    console.error(`${prefix} ${payload}`);
    return;
  }

  if (level === 'warn') {
    logger.warn(`${prefix} ${payload}`);
    console.warn(`${prefix} ${payload}`);
    return;
  }

  logger.info(`${prefix} ${payload}`);
  console.log(`${prefix} ${payload}`);
}

async function createImportAuthUser(displayName) {
  if (!supabaseAdmin?.auth?.admin) {
    throw new Error('Supabase admin auth API is not configured');
  }

  const email = `import_artist_${uuidv4()}@musee.local`;
  const password = `${uuidv4()}${uuidv4()}`;

  const result = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      name: displayName || 'Imported Artist',
      import_source: 'jiosaavn'
    }
  });

  if (result.error || !result.data?.user?.id) {
    throw new Error(result.error?.message || 'Failed to create auth user for imported artist');
  }

  importLog('info', 'Created import auth user', { authUserId: result.data.user.id, email });
  return { authUserId: result.data.user.id, email };
}

async function deleteImportAuthUser(authUserId) {
  if (!authUserId || !supabaseAdmin?.auth?.admin) return;

  const result = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (result.error) {
    importLog('warn', 'Failed to cleanup import auth user', { authUserId, reason: result.error.message });
    return;
  }

  importLog('info', 'Cleaned up import auth user', { authUserId });
}

const LANGUAGE_NAME_TO_CODE = {
  english: 'en',
  hindi: 'hi',
  punjabi: 'pa',
  gujarati: 'gj',
  haryanvi: 'hn',
  marathi: 'mr'
};

const SUPPORTED_LANGUAGE_CODES = new Set(['en', 'gj', 'hi', 'hn', 'mr', 'pa']);

function normalizeLanguageCode(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (SUPPORTED_LANGUAGE_CODES.has(value)) return value;
  const mapped = LANGUAGE_NAME_TO_CODE[value] || null;
  return mapped && SUPPORTED_LANGUAGE_CODES.has(mapped) ? mapped : null;
}

function languageNameFromCodeOrInput(code, input) {
  const codeToName = {
    en: 'English', gj: 'Gujarati', hi: 'Hindi', hn: 'Haryanvi', mr: 'Marathi', pa: 'Punjabi'
  };
  if (codeToName[code]) return codeToName[code];
  if (typeof input === 'string' && input.trim()) {
    const v = input.trim();
    return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  }
  return 'Unknown';
}

function resolveTrackLanguage(rawSong) {
  const candidates = [
    rawSong?.language,
    rawSong?.more_info?.language,
    rawSong?.language_code,
    rawSong?.more_info?.language_code
  ];

  for (const candidate of candidates) {
    const languageCode = normalizeLanguageCode(candidate);
    if (languageCode) {
      return {
        languageCode,
        languageName: languageNameFromCodeOrInput(languageCode, candidate)
      };
    }
  }

  return {
    languageCode: null,
    languageName: null,
    rawLanguage: candidates.find((candidate) => typeof candidate === 'string' && candidate.trim()) || null
  };
}

async function ensureLanguageExists(languageCode, languageName) {
  if (!languageCode) return;
  const existing = await supabaseAdmin
    .from('languages')
    .select('language_code')
    .eq('language_code', languageCode)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) return;

  const inserted = await supabaseAdmin
    .from('languages')
    .insert({ language_code: languageCode, name: languageName || 'Unknown' });

  if (inserted.error) throw inserted.error;
}

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function splitCsv(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }

  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || !value) return value;

  const entityMap = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' '
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);

      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch (_) {
          return match;
        }
      }

      return match;
    }

    return Object.prototype.hasOwnProperty.call(entityMap, entity)
      ? entityMap[entity]
      : match;
  });
}

function safeText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const text = decodeHtmlEntities(value).trim();
  return text || fallback;
}

function toLargeImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  return imageUrl.replace(/50x50/g, '500x500').replace(/150x150/g, '500x500');
}

function normalizeArtistCandidate(externalId, name) {
  const normalizedName = safeText(name, null);
  const normalizedExternalId = String(externalId || '').trim() || null;

  if (!normalizedExternalId && !normalizedName) return null;

  return {
    externalId: normalizedExternalId,
    name: normalizedName
  };
}

function extractTrackArtistCandidates(rawTrack) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (externalId, name) => {
    const candidate = normalizeArtistCandidate(externalId, name);
    if (!candidate) return;

    const key = candidate.externalId || (candidate.name || '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const primaryNames = splitCsv(
    rawTrack?.primary_artists ||
    rawTrack?.more_info?.primary_artists ||
    rawTrack?.singers ||
    rawTrack?.more_info?.singers
  );
  const primaryIds = splitCsv(
    rawTrack?.primary_artists_id ||
    rawTrack?.more_info?.primary_artists_id
  );

  primaryNames.forEach((name, index) => {
    addCandidate(index < primaryIds.length ? primaryIds[index] : null, name);
  });

  const artistMapRaw = parseJsonMaybe(
    rawTrack?.more_info?.artistMap ||
    rawTrack?.artistMap ||
    rawTrack?.artist_map
  );

  const mappedCandidates = asArray(
    artistMapRaw?.primary_artists ||
    artistMapRaw?.featured_artists ||
    artistMapRaw?.artists ||
    artistMapRaw
  );

  for (const artist of mappedCandidates) {
    if (artist && typeof artist === 'object') {
      addCandidate(artist.id || artist.artistId || null, artist.name || artist.title || null);
    }
  }

  if (artistMapRaw && typeof artistMapRaw === 'object' && !Array.isArray(artistMapRaw)) {
    for (const [name, id] of Object.entries(artistMapRaw)) {
      addCandidate(id, name);
    }
  }

  return candidates;
}

async function runWithConcurrency(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];

  const workerCount = Math.max(1, Math.min(concurrency || 1, source.length));
  const results = new Array(source.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= source.length) return;
      results[currentIndex] = await worker(source[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function getCompletedAlbumImportSet(options = {}) {
  const maybeSet = options?.importContext?.completedAlbumExternalIds;
  return maybeSet instanceof Set ? maybeSet : null;
}

async function runAlbumImportOnce(albumExternalId, options = {}) {
  const key = String(albumExternalId || '').trim();
  if (!key) {
    throw new Error('albumExternalId is required for album expansion import');
  }

  const existing = albumImportInFlight.get(key);
  if (existing) {
    importLog('info', 'Awaiting in-flight full album import', { albumExternalId: key });
    return existing;
  }

  const promise = importAlbumById(key, {
    ...options,
    skipFullAlbumExpansion: true
  })
    .finally(() => {
      albumImportInFlight.delete(key);
    });

  albumImportInFlight.set(key, promise);
  return promise;
}

function buildSaavnUrl(callName, params = {}) {
  const query = new URLSearchParams({ __call: callName, _format: 'json', ...params });
  return `${SAAVN_BASE}?${query.toString()}`;
}

async function fetchSaavn(callName, params = {}) {
  const url = buildSaavnUrl(callName, params);
  importLog('info', 'Calling JioSaavn API', { callName, url });
  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  });

  const data = parseJsonMaybe(response.data) || response.data;
  importLog('info', 'JioSaavn API response received', {
    callName,
    status: response.status,
    dataType: typeof data
  });
  return { url, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;

  const asNumber = Number.parseInt(String(retryAfterHeader), 10);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000;

  const asDate = Date.parse(String(retryAfterHeader));
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : null;
  }

  return null;
}

function isRetryableMediaError(error) {
  const status = error?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return Boolean(error?.code);
}

async function fetchMediaWithRetry(url, { maxAttempts = 5 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          Accept: 'audio/*,*/*;q=0.8',
          Referer: 'https://www.jiosaavn.com/',
          Origin: 'https://www.jiosaavn.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
    } catch (error) {
      lastError = error;

      if (!isRetryableMediaError(error) || attempt >= maxAttempts) {
        break;
      }

      const retryAfter = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
      const backoffMs = retryAfter || Math.min(15000, 1000 * (2 ** (attempt - 1)));

      importLog('warn', 'Media fetch rate-limited/retryable failure, retrying', {
        attempt,
        maxAttempts,
        status: error?.response?.status || null,
        waitMs: backoffMs
      });

      await sleep(backoffMs);
    }
  }

  throw lastError || new Error('Failed to fetch media');
}

async function resolveAuthMediaUrlFromEncrypted(encryptedMediaUrl) {
  if (!encryptedMediaUrl) return null;

  const bitrates = ['320', '160', '96'];
  for (const bitrate of bitrates) {
    try {
      const { data } = await fetchSaavn('song.generateAuthToken', {
        url: encryptedMediaUrl,
        bitrate
      });

      const authUrl = safeText(
        data?.auth_url || data?.authUrl || data?.url,
        null
      );

      if (authUrl) {
        importLog('info', 'Resolved auth media URL from encrypted media', { bitrate });
        return authUrl;
      }
    } catch (error) {
      importLog('warn', 'Failed to resolve auth media URL for bitrate', {
        bitrate,
        reason: error?.message || 'unknown error'
      });
    }
  }

  return null;
}

function decryptSaavnMediaUrl(encryptedMediaUrl) {
  if (!encryptedMediaUrl || typeof encryptedMediaUrl !== 'string') return null;

  try {
    const normalized = encryptedMediaUrl.trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const encryptedBuffer = Buffer.from(padded, 'base64');

    const decipher = crypto.createDecipheriv('des-ecb', Buffer.from('38346591', 'utf8'), null);
    decipher.setAutoPadding(true);

    const decrypted = Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final()
    ]).toString('utf8').trim();

    if (!decrypted) return null;
    return decrypted.startsWith('http') ? decrypted : `https://${decrypted}`;
  } catch (_) {
    return null;
  }
}

function buildBitrateVariantUrls(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return [];

  const variants = [];
  const bitrates = ['320', '160', '96'];

  for (const bitrate of bitrates) {
    const replaced = baseUrl.replace(/_(\d{2,3})\.mp4(\?.*)?$/i, `_${bitrate}.mp4$2`);
    variants.push(replaced);
  }

  return Array.from(new Set(variants));
}

async function fetchTrackMediaForIngest({ encryptedMediaUrl }) {
  const candidates = [];

  const decryptedUrl = decryptSaavnMediaUrl(encryptedMediaUrl);
  if (decryptedUrl) {
    for (const url of buildBitrateVariantUrls(decryptedUrl)) {
      candidates.push({ source: 'encrypted_des_url', url, maxAttempts: 3 });
    }
  }

  const authUrl = await resolveAuthMediaUrlFromEncrypted(encryptedMediaUrl);
  if (authUrl) {
    candidates.push({ source: 'encrypted_auth_url', url: authUrl, maxAttempts: 3 });
  }

  if (candidates.length === 0) {
    throw new Error('No media URL resolved from encrypted media');
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      importLog('info', 'Attempting media fetch candidate', {
        source: candidate.source,
        maxAttempts: candidate.maxAttempts
      });

      const response = await fetchMediaWithRetry(candidate.url, {
        maxAttempts: candidate.maxAttempts
      });

      importLog('info', 'Media fetch candidate succeeded', { source: candidate.source });
      return response;
    } catch (error) {
      lastError = error;
      importLog('warn', 'Media fetch candidate failed', {
        source: candidate.source,
        reason: error?.message || 'unknown error'
      });
    }
  }

  throw lastError || new Error('Unable to fetch media from all candidates');
}

function firstArtistFromTrack(rawTrack) {
  return extractTrackArtistCandidates(rawTrack)[0] || { externalId: null, name: null };
}

function normalizeTrackPayload(rawData, trackId) {
  const rawSong = rawData?.[trackId] || rawData?.songs?.[trackId] || rawData;
  const artist = firstArtistFromTrack(rawSong || {});
  const artistCandidates = extractTrackArtistCandidates(rawSong || {});
  const trackLanguage = resolveTrackLanguage(rawSong || {});

  const albumId = String(
    rawSong?.albumid ||
    rawSong?.album_id ||
    rawSong?.more_info?.album_id ||
    ''
  ).trim() || null;

  const title = safeText(rawSong?.song || rawSong?.title, 'Untitled Track');

  return {
    rawSong,
    id: String(rawSong?.id || trackId || '').trim(),
    title,
    duration: toInt(rawSong?.duration, 0),
    languageCode: trackLanguage.languageCode,
    languageName: trackLanguage.languageName,
    isExplicit: rawSong?.explicit_content === 1 || rawSong?.explicit_content === '1',
    trackNumber: toInt(rawSong?.more_info?.label_id || rawSong?.position || rawSong?.track_number, 0) || null,
    albumId,
    albumTitle: safeText(rawSong?.album, null),
    image: toLargeImage(safeText(rawSong?.image || rawSong?.more_info?.image, null)),
    artistExternalId: artist.externalId,
    artistName: artist.name,
    artistCandidates,
    downloadUrl: safeText(rawSong?.encrypted_media_url || rawSong?.more_info?.encrypted_media_url, null),
    previewUrl: safeText(rawSong?.media_preview_url || rawSong?.more_info?.media_preview_url, null),
    permaUrl: safeText(rawSong?.perma_url || rawSong?.more_info?.perma_url, null),
    playCount: 0,
    copyrightText: safeText(rawSong?.copyright_text, null)
  };
}

function normalizeArtistPayload(rawData, artistId) {
  const artist = rawData?.artist || rawData?.data || rawData;
  return {
    id: String(artist?.artistId || artist?.id || artistId || '').trim(),
    name: safeText(artist?.name, 'Unknown Artist'),
    image: toLargeImage(safeText(artist?.image, null)),
    bio: safeText(artist?.bio || artist?.dominantLanguage, 'Imported from JioSaavn')
  };
}

function normalizeAlbumPayload(rawData, albumId) {
  const album = rawData?.album || rawData;
  const songs = asArray(album?.songs || album?.list || album?.tracks);

  const trackIds = songs
    .map((song) => String(song?.id || '').trim())
    .filter(Boolean);

  const firstSong = songs[0] || {};
  const artist = firstArtistFromTrack(firstSong);

  return {
    rawAlbum: album,
    id: String(album?.id || album?.albumid || albumId || '').trim(),
    title: safeText(album?.title || album?.name, 'Untitled Album'),
    description: safeText(album?.description, 'Imported from JioSaavn'),
    image: toLargeImage(safeText(album?.image, null)),
    releaseDate: safeText(album?.release_date, null),
    language: safeText(album?.language, null),
    year: toInt(album?.year, null),
    songCount: toInt(album?.song_count || album?.songCount || songs.length, songs.length),
    permaUrl: safeText(album?.perma_url, null),
    artistExternalId: artist.externalId,
    artistName: artist.name,
    trackIds,
    songs
  };
}

function normalizePlaylistPayload(rawData, playlistId) {
  const playlist =
    rawData?.list ||
    rawData?.playlist ||
    rawData?.data?.list ||
    rawData?.data?.playlist ||
    rawData?.data ||
    rawData;
  const songs = asArray(playlist?.list || playlist?.songs);
  const trackIds = songs
    .map((song) => String(song?.id || '').trim())
    .filter(Boolean);

  const resolvedName = safeText(
    playlist?.title ||
    playlist?.name ||
    playlist?.listname ||
    playlist?.list_name ||
    playlist?.header_desc ||
    rawData?.title ||
    rawData?.name ||
    rawData?.listname,
    'Untitled Playlist'
  );

  return {
    rawPlaylist: playlist,
    id: String(playlist?.listid || playlist?.id || playlistId || '').trim(),
    name: resolvedName,
    description: safeText(playlist?.subtitle || playlist?.description, 'Imported from JioSaavn'),
    image: toLargeImage(safeText(playlist?.image, null)),
    language: safeText(playlist?.language, null),
    totalTracks: toInt(playlist?.list_count || playlist?.song_count || songs.length, songs.length),
    duration: toInt(playlist?.duration, 0),
    permaUrl: safeText(playlist?.perma_url, null),
    trackIds,
    songs
  };
}

async function createJob({ type, sourceId, requestedBy }) {
  const { data, error } = await supabaseAdmin
    .from('import_jobs')
    .insert({
      type,
      source_id: sourceId,
      requested_by: requestedBy || null,
      status: 'queued',
      progress: 0
    })
    .select('*')
    .single();

  if (error) throw error;
  
  importLog('info', 'Created import job in DB', { jobId: data.job_id, type, sourceId });
  return {
    jobId: data.job_id,
    type: data.type,
    sourceId: data.source_id,
    requestedBy: data.requested_by,
    status: data.status,
    progress: data.progress,
    createdAt: data.created_at
  };
}

async function updateJob(jobId, patch) {
  const dbPatch = {};
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.progress !== undefined) dbPatch.progress = patch.progress;
  if (patch.error !== undefined) dbPatch.error = patch.error;
  if (patch.finishedAt !== undefined) dbPatch.finished_at = patch.finishedAt;

  const { error } = await supabaseAdmin
    .from('import_jobs')
    .update(dbPatch)
    .eq('job_id', jobId);

  if (error) {
    importLog('error', 'Failed to update job in DB', { jobId, error: error.message });
  } else {
    importLog('info', 'Updated import job in DB', { jobId, patch });
  }
}

function jobLog(jobId, message) {
  importLog('info', `Job log [${jobId}]: ${message}`);
}

async function uploadImageFromUrlIfPossible({ bucket, path, imageUrl }) {
  if (!imageUrl || !supabaseAdmin?.storage) return null;
  importLog('info', 'Attempting image upload', { bucket, path, imageUrl });
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const buffer = Buffer.from(response.data);

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, buffer, { upsert: true, contentType });

    if (uploadError) {
      importLog('warn', 'Image upload skipped', { bucket, path, reason: uploadError.message });
      return null;
    }

    const publicResp = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    const publicData = publicResp?.data || publicResp;
    importLog('info', 'Image upload successful', { bucket, path });
    return publicData?.publicUrl || publicData?.publicURL || null;
  } catch (error) {
    importLog('warn', 'Image fetch/upload skipped', { bucket, path, reason: error.message });
    return null;
  }
}

async function ensureArtistImported(artistExternalId, fallbackName, context = {}) {
  importLog('info', 'ensureArtistImported started', { artistExternalId, fallbackName });
  const providerId = await getProviderId('jiosaavn');

  if (artistExternalId) {
    const existingArtistId = await findEntityIdByExternalId({
      refTable: 'artist_external_refs',
      entityIdColumn: 'artist_id',
      providerId,
      externalId: artistExternalId
    });

    if (existingArtistId) {
      const existingArtist = await supabaseAdmin
        .from('artists')
        .select('artist_id')
        .eq('artist_id', existingArtistId)
        .maybeSingle();
      if (existingArtist.error) throw existingArtist.error;
      if (existingArtist.data) {
        importLog('info', 'Artist already exists via external ref', { artistExternalId, artistId: existingArtist.data.artist_id });
        return { artistId: existingArtist.data.artist_id, created: false };
      }
    }
  }

  if (!artistExternalId && fallbackName) {
    const existingByName = await supabaseAdmin
      .from('users')
      .select('user_id')
      .eq('user_type', 'artist')
      .ilike('name', fallbackName)
      .maybeSingle();

    if (existingByName.error) throw existingByName.error;
    if (existingByName.data?.user_id) {
      importLog('info', 'Artist already exists via name match', { fallbackName, artistId: existingByName.data.user_id });
      return { artistId: existingByName.data.user_id, created: false };
    }
  }

  const { data: remote, url } = artistExternalId
    ? await fetchSaavn('artist.getArtistPageDetails', { artistId: artistExternalId })
    : { data: null, url: null };

  const normalized = normalizeArtistPayload(remote, artistExternalId);
  const artistName = fallbackName || normalized.name;
  const authUser = await createImportAuthUser(artistName);

  const tx = await executeTransaction(async (tracker) => {
    importLog('info', 'Creating artist user + artist rows', { artistExternalId, artistName });
    const userPayload = {
      name: artistName,
      email: authUser.email,
      user_type: 'artist',
      subscription_type: 'free',
      avatar_url: normalized.image || DEFAULTS.artistAvatar,
      settings: {
        import_source: 'jiosaavn',
        external_artist_id: artistExternalId || null
      }
    };

    const existingUser = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('user_id', authUser.authUserId)
      .maybeSingle();

    if (existingUser.error) throw existingUser.error;

    const user = existingUser.data
      ? await updateAndTrack(tracker, 'users', userPayload, 'user_id', authUser.authUserId)
      : await createAndTrack(tracker, 'users', { user_id: authUser.authUserId, ...userPayload }, 'user_id');

    const artist = await createAndTrack(tracker, 'artists', {
      artist_id: user.user_id,
      bio: normalized.bio,
      cover_url: normalized.image || DEFAULTS.artistCover,
      is_verified: false,
      monthly_listeners: 0,
      region_id: context.regionId || null,
      debut_year: null,
      social_links: {}
    }, 'artist_id');

    if (artistExternalId) {
      await upsertExternalRef({
        refTable: 'artist_external_refs',
        entityIdColumn: 'artist_id',
        entityId: artist.artist_id,
        providerId,
        externalId: artistExternalId,
        externalUrl: null,
        imageUrl: normalized.image,
        rawPayload: remote
      });
    }

    return { artistId: artist.artist_id, image: normalized.image, remoteUrl: url };
  }, { operationName: `Import artist ${artistExternalId || artistName}` });

  if (!tx.success) {
    await deleteImportAuthUser(authUser.authUserId);
    throw new Error(tx.error || 'Artist import failed');
  }
  importLog('info', 'Artist core transaction complete', { artistExternalId, artistId: tx.data.artistId });

  const artistId = tx.data.artistId;

  if (tx.data.image) {
    const [avatarUrl, coverUrl] = await Promise.all([
      uploadImageFromUrlIfPossible({
        bucket: process.env.SUPABASE_AVATAR_BUCKET || 'avatars',
        path: `users/${artistId}.jpg`,
        imageUrl: tx.data.image
      }),
      uploadImageFromUrlIfPossible({
        bucket: process.env.SUPABASE_COVERS_BUCKET || 'covers',
        path: `artists/${artistId}.jpg`,
        imageUrl: tx.data.image
      })
    ]);

    if (avatarUrl || coverUrl) {
      await executeTransaction(async (tracker) => {
        if (avatarUrl) {
          await updateAndTrack(tracker, 'users', { avatar_url: avatarUrl }, 'user_id', artistId);
        }
        if (coverUrl) {
          await updateAndTrack(tracker, 'artists', { cover_url: coverUrl }, 'artist_id', artistId);
        }
      }, { operationName: `Update artist images ${artistId}` });
    }
  }

  return { artistId, created: true };
}

async function ensureAlbumImportedShell(albumExternalId, options = {}) {
  importLog('info', 'ensureAlbumImportedShell started', { albumExternalId });
  const providerId = await getProviderId('jiosaavn');

  const existingAlbumId = await findEntityIdByExternalId({
    refTable: 'album_external_refs',
    entityIdColumn: 'album_id',
    providerId,
    externalId: albumExternalId
  });

  if (existingAlbumId) {
    await supabaseAdmin
      .from('albums')
      .update({ is_published: true, updated_at: new Date().toISOString() })
      .eq('album_id', existingAlbumId);

    importLog('info', 'Album already exists via external ref', { albumExternalId, albumId: existingAlbumId });
    return { albumId: existingAlbumId, created: false, trackIds: [] };
  }

  const { data: remoteAlbum } = await fetchSaavn('content.getAlbumDetails', { albumid: albumExternalId });
  const normalized = normalizeAlbumPayload(remoteAlbum, albumExternalId);

  const resolvedArtistExternalId = normalized.artistExternalId || options.preferredArtistExternalId || null;
  const resolvedArtistName = normalized.artistName || options.preferredArtistName || null;

  const artistImport = options.preferredArtistId
    ? { artistId: options.preferredArtistId, created: false }
    : await ensureArtistImported(resolvedArtistExternalId, resolvedArtistName, options);

  const tx = await executeTransaction(async (tracker) => {
    const languageCode = normalized.languageCode;
    await ensureLanguageExists(languageCode, normalized.languageName);

    const album = await createAndTrack(tracker, 'albums', {
      title: normalized.title,
      description: normalized.description,
      cover_url: normalized.image || DEFAULTS.albumCover,
      release_date: normalized.releaseDate || null,
      duration: normalized.songs.reduce((sum, song) => sum + toInt(song?.duration, 0), 0),
      is_published: true
    }, 'album_id');

    const albumId = album.album_id || album.id;

    const linkResult = await supabaseAdmin
      .from('album_artists')
      .insert({
        album_id: albumId,
        artist_id: artistImport.artistId,
        role: 'owner'
      });

    if (linkResult.error && linkResult.error.code !== '23505') {
      throw linkResult.error;
    }

    await upsertExternalRef({
      refTable: 'album_external_refs',
      entityIdColumn: 'album_id',
      entityId: albumId,
      providerId,
      externalId: albumExternalId,
      externalUrl: normalized.permaUrl,
      imageUrl: normalized.image,
      rawPayload: remoteAlbum
    });

    return {
      albumId,
      trackIds: normalized.trackIds,
      image: normalized.image
    };
  }, { operationName: `Import album shell ${albumExternalId}` });

  if (!tx.success) throw new Error(tx.error || 'Album import failed');
  importLog('info', 'Album shell transaction complete', { albumExternalId, albumId: tx.data.albumId, trackCount: tx.data.trackIds.length });

  if (tx.data.image) {
    const albumCoverUrl = await uploadImageFromUrlIfPossible({
      bucket: process.env.SUPABASE_COVERS_BUCKET || 'covers',
      path: `albums/${tx.data.albumId}.jpg`,
      imageUrl: tx.data.image
    });

    if (albumCoverUrl) {
      await executeTransaction(async (tracker) => {
        await updateAndTrack(tracker, 'albums', { cover_url: albumCoverUrl }, 'album_id', tx.data.albumId);
      }, { operationName: `Update album image ${tx.data.albumId}` });
    }
  }

  return { albumId: tx.data.albumId, created: true, trackIds: tx.data.trackIds };
}

async function ensureAlbumArtistLink(albumId, artistId, role = 'owner') {
  if (!albumId || !artistId) return false;

  const existingLink = await supabaseAdmin
    .from('album_artists')
    .select('album_artist_id')
    .eq('album_id', albumId)
    .eq('artist_id', artistId)
    .maybeSingle();

  if (existingLink.error) throw existingLink.error;
  if (existingLink.data) return false;

  const insertResult = await supabaseAdmin
    .from('album_artists')
    .insert({ album_id: albumId, artist_id: artistId, role });

  if (insertResult.error && insertResult.error.code !== '23505') {
    throw insertResult.error;
  }

  return true;
}

async function ensureTrackArtistLink(trackId, artistId, role = 'owner') {
  if (!trackId || !artistId) return false;

  const existingLink = await supabaseAdmin
    .from('track_artists')
    .select('track_artist_id')
    .eq('track_id', trackId)
    .eq('artist_id', artistId)
    .maybeSingle();

  if (existingLink.error) throw existingLink.error;
  if (existingLink.data) return false;

  const insertResult = await supabaseAdmin
    .from('track_artists')
    .insert({ track_id: trackId, artist_id: artistId, role });

  if (insertResult.error && insertResult.error.code !== '23505') {
    throw insertResult.error;
  }

  return true;
}

/**
 * Import genre data from JioSaavn payload into track_genres junction table.
 * Creates genres in the genres table if they don't exist.
 * The DB trigger trg_sync_genres_to_content_features will auto-sync to track_content_features.
 * @private
 */
async function importTrackGenres(trackId, rawSong) {
  try {
    const genreNames = new Set();

    // JioSaavn uses language as a genre proxy (e.g. "Hindi", "Punjabi")
    const language = rawSong?.language || rawSong?.more_info?.language;
    if (language && typeof language === 'string') {
      const name = language.trim();
      if (name) genreNames.add(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
    }

    // Check for explicit genre fields in the payload
    const genreField = rawSong?.genre || rawSong?.more_info?.genre || rawSong?.more_info?.song_pids;
    if (genreField) {
      splitCsv(genreField).forEach(g => {
        const name = g.trim();
        if (name) genreNames.add(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
      });
    }

    // Some payloads have a "type" that can indicate genre (e.g. "Pop", "Rock")
    const typeField = rawSong?.type || rawSong?.more_info?.music;
    if (typeField && typeof typeField === 'string' && typeField.trim() && typeField.trim().toLowerCase() !== 'song') {
      genreNames.add(typeField.trim().charAt(0).toUpperCase() + typeField.trim().slice(1).toLowerCase());
    }

    for (const genreName of genreNames) {
      const slug = genreName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) continue;

      // Upsert genre
      const { data: existing } = await supabaseAdmin
        .from('genres')
        .select('genre_id')
        .eq('slug', slug)
        .maybeSingle();

      let genreId = existing?.genre_id;
      if (!genreId) {
        const { data: created, error: createErr } = await supabaseAdmin
          .from('genres')
          .insert({ slug, name: genreName })
          .select('genre_id')
          .single();

        if (createErr && createErr.code === '23505') {
          // Race condition: genre already exists
          const { data: reFetch } = await supabaseAdmin
            .from('genres')
            .select('genre_id')
            .eq('slug', slug)
            .single();
          genreId = reFetch?.genre_id;
        } else if (createErr) {
          importLog('warn', 'Failed to create genre', { genreName, slug, reason: createErr.message });
          continue;
        } else {
          genreId = created?.genre_id;
        }
      }

      if (genreId) {
        const { error: linkErr } = await supabaseAdmin
          .from('track_genres')
          .upsert({ track_id: trackId, genre_id: genreId }, { onConflict: 'track_id,genre_id' });
        if (linkErr && linkErr.code !== '23505') {
          importLog('warn', 'Failed to link track genre', { trackId, genreId, reason: linkErr.message });
        }
      }
    }
  } catch (error) {
    importLog('warn', 'importTrackGenres failed (non-fatal)', { trackId, reason: error?.message });
  }
}

/**
 * Import credits (singer, composer, lyricist, etc.) from JioSaavn artistMap into track_credits.
 * Also attempts to link credits to internal artist_ids where possible.
 * @private
 */
async function importTrackCredits(trackId, rawSong) {
  try {
    const artistMap = parseJsonMaybe(
      rawSong?.more_info?.artistMap ||
      rawSong?.artistMap ||
      rawSong?.artist_map
    );
    if (!artistMap || typeof artistMap !== 'object') return;

    const providerId = await getProviderId('jiosaavn');

    const roleMapping = {
      primary_artists: 'primary',
      featured_artists: 'featured',
      singers: 'singer',
      composers: 'composer',
      lyricists: 'lyricist',
      actors: 'actor',
      producers: 'producer'
    };

    let sortOrder = 0;

    for (const [mapKey, creditType] of Object.entries(roleMapping)) {
      const artists = asArray(artistMap[mapKey] || []);

      for (const artist of artists) {
        if (!artist || typeof artist !== 'object') continue;

        const displayName = safeText(artist.name, null);
        if (!displayName) continue;

        const externalArtistId = String(artist.id || '').trim() || null;

        // Try to find matching internal artist
        let internalArtistId = null;
        if (externalArtistId) {
          try {
            internalArtistId = await findEntityIdByExternalId({
              refTable: 'artist_external_refs',
              entityIdColumn: 'artist_id',
              providerId,
              externalId: externalArtistId
            });
          } catch (_) {
            // Non-fatal: artist may not be imported yet
          }
        }

        const { error: creditErr } = await supabaseAdmin
          .from('track_credits')
          .upsert({
            track_id: trackId,
            artist_id: internalArtistId,
            credit_type: creditType,
            display_name: displayName,
            external_artist_id: externalArtistId,
            sort_order: sortOrder++
          }, { onConflict: 'track_id,credit_type,display_name' });

        if (creditErr && creditErr.code !== '23505') {
          importLog('warn', 'Failed to upsert track credit', {
            trackId, displayName, creditType, reason: creditErr.message
          });
        }
      }
    }
  } catch (error) {
    importLog('warn', 'importTrackCredits failed (non-fatal)', { trackId, reason: error?.message });
  }
}

async function trackHasIngestedAudio(trackId) {
  const trackRow = await supabaseAdmin
    .from('tracks')
    .select('hls_master_path')
    .eq('track_id', trackId)
    .maybeSingle();

  if (trackRow.error) throw trackRow.error;

  const hasHls = Boolean(trackRow.data?.hls_master_path);
  return hasHls;
}

async function ingestTrackAudioAssets({ trackId, encryptedMediaUrl, sourceTrackId, jobId, jobTrackId }) {
  if (!encryptedMediaUrl) {
    throw new Error(`Missing encrypted media URL for track ${sourceTrackId || trackId}`);
  }

  if (jobTrackId) {
    await supabaseAdmin
      .from('import_job_tracks')
      .update({ status: 'downloading', updated_at: new Date().toISOString() })
      .eq('id', jobTrackId);
  }

  importLog('info', 'Downloading track audio on main server', {
    trackId: sourceTrackId || trackId,
    dbTrackId: trackId
  });

  // Download the track audio locally to server buffer using the working IP/APIs
  const mediaResp = await fetchTrackMediaForIngest({ encryptedMediaUrl });
  if (!mediaResp || !mediaResp.data) {
    throw new Error(`Failed to download audio content on server for track ${sourceTrackId || trackId}`);
  }

  const audioBase64 = Buffer.from(mediaResp.data).toString('base64');
  importLog('info', 'Audio downloaded, uploading to Azure Function for transcoding', {
    trackId: sourceTrackId || trackId,
    sizeBytes: mediaResp.data.length
  });

  const functionUrl = process.env.AZURE_TRANSCODER_URL;
  const functionKey = process.env.AZURE_TRANSCODER_CODE;

  if (!functionUrl) {
    throw new Error('Azure Transcoder function URL is not configured (AZURE_TRANSCODER_URL)');
  }

  const urlWithCode = functionKey 
    ? `${functionUrl}${functionUrl.includes('?') ? '&' : '?'}code=${functionKey}` 
    : functionUrl;

  if (jobTrackId) {
    await supabaseAdmin
      .from('import_job_tracks')
      .update({ status: 'transcoding', updated_at: new Date().toISOString() })
      .eq('id', jobTrackId);
  }

  let response;
  try {
    response = await axios.post(urlWithCode, {
      trackId,
      audioBase64
    }, {
      headers: { 'Content-Type': 'application/json' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 180000 // 3 minutes timeout for Azure Function to transcode and upload
    });
  } catch (axiosErr) {
    const errorDetails = axiosErr.response?.data?.error || axiosErr.response?.data || axiosErr.message;
    throw new Error(`Azure Function error: ${errorDetails}`);
  }

  if (!response.data || !response.data.success) {
    throw new Error(response.data?.error || 'Azure Function transcoding failed');
  }

  const { hlsMasterPath } = response.data;

  importLog('info', 'Azure Function transcoding completed successfully', {
    trackId: sourceTrackId || trackId,
    dbTrackId: trackId,
    hlsMasterPath
  });

  const assetTx = await executeTransaction(async (tracker) => {
    await updateAndTrack(
      tracker,
      'tracks',
      { hls_master_path: hlsMasterPath, is_published: true },
      'track_id',
      trackId
    );
  }, { operationName: `Track asset ingest ${trackId}` });

  if (!assetTx.success) {
    throw new Error(assetTx.error || 'Track asset database write transaction failed');
  }

  if (jobTrackId) {
    await supabaseAdmin
      .from('import_job_tracks')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', jobTrackId);
  }
}

async function importTrackById(trackId, options = {}) {
  importLog('info', 'importTrackById started', { trackId, forcedAlbumId: options.forcedAlbumId || null, trackDownload: true });
  const providerId = await getProviderId('jiosaavn');

  const existingTrackId = await findEntityIdByExternalId({
    refTable: 'track_external_refs',
    entityIdColumn: 'track_id',
    providerId,
    externalId: trackId
  });

  const { data: remoteTrack } = await fetchSaavn('song.getDetails', { pids: trackId });
  const normalized = normalizeTrackPayload(remoteTrack, trackId);
  importLog('info', 'Resolved track artist from payload', {
    trackId,
    artistExternalId: normalized.artistExternalId,
    artistName: normalized.artistName,
    albumExternalId: normalized.albumId
  });

  if (!normalized.languageCode) {
    throw new Error(
      `Unsupported JioSaavn track language "${normalized.rawLanguage || 'unknown'}". ` +
      'Supported languages are English, Gujarati, Hindi, Haryanvi, Marathi, and Punjabi.'
    );
  }

  // --- JOB TRACK RESOLUTION ---
  let jobTrackId = options.jobTrackId;
  if (!jobTrackId && options.jobId) {
    const { data: existingJobTrack } = await supabaseAdmin
      .from('import_job_tracks')
      .select('id')
      .eq('job_id', options.jobId)
      .eq('track_external_id', trackId)
      .maybeSingle();

    if (existingJobTrack) {
      jobTrackId = existingJobTrack.id;
    } else {
      const { data: newJobTrack } = await supabaseAdmin
        .from('import_job_tracks')
        .insert({
          job_id: options.jobId,
          track_external_id: trackId,
          title: safeText(normalized.title || normalized.song || 'Unknown Track'),
          status: 'queued'
        })
        .select('id')
        .single();
      jobTrackId = newJobTrack?.id;
    }
  }

  const shouldExpandAlbum = !options.skipFullAlbumExpansion && Boolean(normalized.albumId);
  if (shouldExpandAlbum) {
    const completedAlbumImports = getCompletedAlbumImportSet(options);
    const alreadyExpanded = completedAlbumImports?.has(normalized.albumId) || false;

    if (!alreadyExpanded) {
      importLog('info', 'Expanding track import to full album import', {
        trackId,
        albumExternalId: normalized.albumId
      });

      await runAlbumImportOnce(normalized.albumId, options);
      if (completedAlbumImports) completedAlbumImports.add(normalized.albumId);
    }

    const importedTrackId = await findEntityIdByExternalId({
      refTable: 'track_external_refs',
      entityIdColumn: 'track_id',
      providerId,
      externalId: trackId
    });

    if (!importedTrackId) {
      throw new Error(`Track ${trackId} was not found after full album import ${normalized.albumId}`);
    }

    // Since the album was expanded, we should update our job track status if it exists
    if (jobTrackId) {
      const alreadyIngested = await trackHasIngestedAudio(importedTrackId);
      if (alreadyIngested) {
        await supabaseAdmin
          .from('import_job_tracks')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', jobTrackId);
      }
    }

    return {
      trackId: importedTrackId,
      created: false,
      downloaded: true,
      importedViaAlbum: true,
      albumExternalId: normalized.albumId
    };
  }

  const artistImport = await ensureArtistImported(normalized.artistExternalId, normalized.artistName, options);
  const trackArtistCandidates = Array.isArray(normalized.artistCandidates) && normalized.artistCandidates.length > 0
    ? normalized.artistCandidates
    : [
        {
          externalId: normalized.artistExternalId,
          name: normalized.artistName
        }
      ];

  if (existingTrackId) {
    const existingTrack = await supabaseAdmin
      .from('tracks')
      .select('track_id, album_id')
      .eq('track_id', existingTrackId)
      .maybeSingle();

    if (existingTrack.error) throw existingTrack.error;

    const linkedTrackArtist = await ensureTrackArtistLink(existingTrackId, artistImport.artistId, 'owner');
    const additionalTrackArtistLinks = [];
    for (const candidate of trackArtistCandidates.slice(1)) {
      const importedArtist = await ensureArtistImported(candidate.externalId, candidate.name, options);
      const linked = await ensureTrackArtistLink(existingTrackId, importedArtist.artistId, 'viewer');
      additionalTrackArtistLinks.push({ artistId: importedArtist.artistId, linked });
    }
    const targetAlbumId = options.forcedAlbumId || existingTrack.data?.album_id || null;
    const linkedAlbumArtist = targetAlbumId
      ? await ensureAlbumArtistLink(targetAlbumId, artistImport.artistId, 'owner')
      : false;

    await supabaseAdmin
      .from('tracks')
      .update({ is_published: true, updated_at: new Date().toISOString() })
      .eq('track_id', existingTrackId);

    if (targetAlbumId) {
      await supabaseAdmin
        .from('albums')
        .update({ is_published: true, updated_at: new Date().toISOString() })
        .eq('album_id', targetAlbumId);
    }

    importLog('info', 'Track already exists via external ref (reconciled links)', {
      trackId,
      existingTrackId,
      artistId: artistImport.artistId,
      linkedTrackArtist,
      additionalTrackArtistLinks,
      linkedAlbumArtist,
      targetAlbumId
    });

    const alreadyIngested = await trackHasIngestedAudio(existingTrackId);
    if (!alreadyIngested) {
      await ingestTrackAudioAssets({
        trackId: existingTrackId,
        encryptedMediaUrl: normalized.downloadUrl,
        sourceTrackId: trackId,
        jobId: options.jobId,
        jobTrackId
      });
    } else if (jobTrackId) {
      await supabaseAdmin
        .from('import_job_tracks')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', jobTrackId);
    }

    return {
      trackId: existingTrackId,
      created: false,
      downloaded: true,
      audioAlreadyPresent: alreadyIngested
    };
  }

  let albumId = options.forcedAlbumId || null;
  if (!albumId) {
    if (normalized.albumId) {
      const albumImport = await ensureAlbumImportedShell(normalized.albumId, {
        ...options,
        preferredArtistId: artistImport.artistId,
        preferredArtistExternalId: normalized.artistExternalId,
        preferredArtistName: normalized.artistName
      });
      albumId = albumImport.albumId;
    } else {
      const fallbackAlbumTx = await executeTransaction(async (tracker) => {
        const album = await createAndTrack(tracker, 'albums', {
          title: normalized.albumTitle || `${normalized.title} - Single`,
          description: 'Auto-created from track import',
          cover_url: normalized.image || DEFAULTS.albumCover,
          release_date: null,
          is_published: true,
          duration: normalized.duration
        }, 'album_id');

        const createdAlbumId = album.album_id || album.id;
        const linkResult = await supabaseAdmin
          .from('album_artists')
          .insert({ album_id: createdAlbumId, artist_id: artistImport.artistId, role: 'owner' });
        if (linkResult.error && linkResult.error.code !== '23505') throw linkResult.error;

        return { albumId: createdAlbumId };
      }, { operationName: `Create fallback album for track ${trackId}` });

      if (!fallbackAlbumTx.success) throw new Error(fallbackAlbumTx.error || 'Failed to create fallback album');
      albumId = fallbackAlbumTx.data.albumId;
      importLog('info', 'Created fallback album for track', { trackId, albumId });
    }
  }

  const tx = await executeTransaction(async (tracker) => {
    const languageCode = normalized.languageCode;
    await ensureLanguageExists(languageCode, normalized.languageName);

    if (!languageCode) {
      throw new Error(
        `Unsupported JioSaavn track language "${normalized.rawLanguage || 'unknown'}". ` +
        'Supported languages are English, Gujarati, Hindi, Haryanvi, Marathi, and Punjabi.'
      );
    }

    const track = await createAndTrack(tracker, 'tracks', {
      album_id: albumId,
      title: normalized.title,
      duration: normalized.duration,
      language_code: languageCode,
      is_explicit: normalized.isExplicit,
      is_published: true,
      track_number: normalized.trackNumber,
      lyrics_url: null,
      lyrics_snippet: null,
      play_count: 0,
      likes_count: 0,
      popularity_score: 0,
      copyright_text: normalized.copyrightText,
      video_url: null,
      hls_master_path: null
    }, 'track_id');

    const dbTrackId = track.track_id || track.id;

    await ensureTrackArtistLink(dbTrackId, artistImport.artistId, 'owner');
    const additionalTrackArtistLinks = [];
    for (const candidate of trackArtistCandidates.slice(1)) {
      const importedArtist = await ensureArtistImported(candidate.externalId, candidate.name, options);
      const linked = await ensureTrackArtistLink(dbTrackId, importedArtist.artistId, 'viewer');
      additionalTrackArtistLinks.push({ artistId: importedArtist.artistId, linked });
    }

    await upsertExternalRef({
      refTable: 'track_external_refs',
      entityIdColumn: 'track_id',
      entityId: dbTrackId,
      providerId,
      externalId: normalized.id,
      externalUrl: normalized.permaUrl,
      imageUrl: normalized.image,
      rawPayload: remoteTrack,
      extra: {
        external_album_id: normalized.albumId,
        language: normalized.languageCode,
        encrypted_media_url: normalized.downloadUrl,
        media_preview_url: normalized.previewUrl
      }
    });

    return {
      trackId: dbTrackId,
      encryptedMediaUrl: normalized.downloadUrl,
      additionalTrackArtistLinks
    };
  }, { operationName: `Import track ${trackId}` });

  if (!tx.success) throw new Error(tx.error || 'Track import failed');

  if (albumId) {
    await supabaseAdmin
      .from('albums')
      .update({ is_published: true, updated_at: new Date().toISOString() })
      .eq('album_id', albumId);
  }

  importLog('info', 'Track core transaction complete', {
    trackId,
    dbTrackId: tx.data.trackId,
    hasEncryptedMedia: Boolean(tx.data.encryptedMediaUrl),
    additionalTrackArtistLinks: tx.data.additionalTrackArtistLinks?.length || 0
  });

  // Import genres and credits from JioSaavn payload (non-fatal)
  await importTrackGenres(tx.data.trackId, normalized.rawSong);
  await importTrackCredits(tx.data.trackId, normalized.rawSong);

  await ingestTrackAudioAssets({
    trackId: tx.data.trackId,
    encryptedMediaUrl: tx.data.encryptedMediaUrl,
    sourceTrackId: trackId,
    jobId: options.jobId,
    jobTrackId
  });

  return { trackId: tx.data.trackId, created: true, downloaded: true };
}

async function importAlbumById(albumId, options = {}) {
  importLog('info', 'importAlbumById started', { albumId, trackDownload: true });
  const albumShell = await ensureAlbumImportedShell(albumId, options);

  const { data: remoteAlbum } = await fetchSaavn('content.getAlbumDetails', { albumid: albumId });
  const normalized = normalizeAlbumPayload(remoteAlbum, albumId);
  const uniqueTrackIds = Array.from(new Set(normalized.trackIds));
  let completedTracks = 0;

  // Pre-populate track status records in DB for the job (deduplicating already existing ones)
  if (options.jobId) {
    const { data: existing } = await supabaseAdmin
      .from('import_job_tracks')
      .select('track_external_id')
      .eq('job_id', options.jobId);
    
    const existingSet = new Set((existing || []).map(t => t.track_external_id));

    const trackInserts = (normalized.songs || [])
      .filter(song => !existingSet.has(String(song.id).trim()))
      .map(song => ({
        job_id: options.jobId,
        track_external_id: String(song.id).trim(),
        title: safeText(song.title || song.song, 'Unknown Track'),
        status: 'queued'
      }));

    if (trackInserts.length > 0) {
      await supabaseAdmin.from('import_job_tracks').insert(trackInserts);
    }
  }

  importLog('info', 'Importing album tracks with bounded concurrency', {
    albumId,
    totalTracks: uniqueTrackIds.length,
    concurrency: TRACK_IMPORT_CONCURRENCY
  });

  const importedTracks = await runWithConcurrency(
    uniqueTrackIds,
    TRACK_IMPORT_CONCURRENCY,
    async (tid, index) => {
      importLog('info', 'Importing album track', {
        albumId,
        trackId: tid,
        index: index + 1,
        total: uniqueTrackIds.length
      });

      let jobTrackId;
      if (options.jobId) {
        const { data: jobTrack } = await supabaseAdmin
          .from('import_job_tracks')
          .select('id')
          .eq('job_id', options.jobId)
          .eq('track_external_id', tid)
          .maybeSingle();
        jobTrackId = jobTrack?.id;
      }

      let imported = null;
      try {
        imported = await importTrackById(tid, {
          ...options,
          forcedAlbumId: albumShell.albumId,
          skipFullAlbumExpansion: true,
          jobTrackId
        });
      } catch (err) {
        importLog('error', `Track import failed for tid ${tid}`, { error: err.message });
        if (jobTrackId) {
          await supabaseAdmin
            .from('import_job_tracks')
            .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
            .eq('id', jobTrackId);
        }
      }

      completedTracks += 1;
      if (options.jobId) {
        await updateJob(options.jobId, {
          progress: Math.min(89, Math.round((completedTracks / Math.max(uniqueTrackIds.length, 1)) * 89))
        });
      }

      return imported;
    }
  );

  return {
    albumId: albumShell.albumId,
    albumCreated: albumShell.created,
    tracksImported: importedTracks.length,
    trackResults: importedTracks
  };
}

async function importPlaylistById(playlistId, options = {}) {
  importLog('info', 'importPlaylistById started', { playlistId, trackDownload: true });
  const providerId = await getProviderId('jiosaavn');

  const existingPlaylistId = await findEntityIdByExternalId({
    refTable: 'playlist_external_refs',
    entityIdColumn: 'playlist_id',
    providerId,
    externalId: playlistId
  });

  const { data: remotePlaylist } = await fetchSaavn('playlist.getDetails', { listid: playlistId });
  const normalized = normalizePlaylistPayload(remotePlaylist, playlistId);

  let playlistDbId = existingPlaylistId;

  if (!playlistDbId) {
    const tx = await executeTransaction(async (tracker) => {
      const playlist = await createAndTrack(tracker, 'playlists', {
        name: normalized.name,
        description: normalized.description,
        cover_url: normalized.image || DEFAULTS.playlistCover,
        total_tracks: normalized.totalTracks,
        likes_count: 0,
        is_public: false,
        duration: normalized.duration,
        creator_id: options.adminId || null
      }, 'playlist_id');

      const dbPlaylistId = playlist.playlist_id || playlist.id;

      await upsertExternalRef({
        refTable: 'playlist_external_refs',
        entityIdColumn: 'playlist_id',
        entityId: dbPlaylistId,
        providerId,
        externalId: normalized.id,
        externalUrl: normalized.permaUrl,
        imageUrl: normalized.image,
        rawPayload: remotePlaylist
      });

      return { playlistId: dbPlaylistId };
    }, { operationName: `Import playlist ${playlistId}` });

    if (!tx.success) throw new Error(tx.error || 'Playlist import failed');
    playlistDbId = tx.data.playlistId;

    if (normalized.image) {
      const playlistCoverUrl = await uploadImageFromUrlIfPossible({
        bucket: process.env.SUPABASE_COVERS_BUCKET || 'covers',
        path: `playlists/${playlistDbId}.jpg`,
        imageUrl: normalized.image
      });

      if (playlistCoverUrl) {
        await executeTransaction(async (tracker) => {
          await updateAndTrack(tracker, 'playlists', { cover_url: playlistCoverUrl }, 'playlist_id', playlistDbId);
        }, { operationName: `Update playlist image ${playlistDbId}` });
      }
    }
  }

  const uniqueTrackIds = Array.from(new Set(normalized.trackIds));
  let completedTracks = 0;

  // Pre-populate track status records in DB for the job (deduplicating already existing ones)
  if (options.jobId) {
    const { data: existing } = await supabaseAdmin
      .from('import_job_tracks')
      .select('track_external_id')
      .eq('job_id', options.jobId);
    
    const existingSet = new Set((existing || []).map(t => t.track_external_id));

    const trackInserts = (normalized.songs || [])
      .filter(song => !existingSet.has(String(song.id).trim()))
      .map(song => ({
        job_id: options.jobId,
        track_external_id: String(song.id).trim(),
        title: safeText(song.title || song.song, 'Unknown Track'),
        status: 'queued'
      }));

    if (trackInserts.length > 0) {
      await supabaseAdmin.from('import_job_tracks').insert(trackInserts);
    }
  }

  importLog('info', 'Importing playlist tracks with bounded concurrency', {
    playlistId,
    totalTracks: uniqueTrackIds.length,
    concurrency: TRACK_IMPORT_CONCURRENCY
  });

  const importedTracks = await runWithConcurrency(
    uniqueTrackIds,
    TRACK_IMPORT_CONCURRENCY,
    async (tid, index) => {
      importLog('info', 'Importing playlist track', {
        playlistId,
        trackId: tid,
        index: index + 1,
        total: uniqueTrackIds.length
      });

      let jobTrackId;
      if (options.jobId) {
        const { data: jobTrack } = await supabaseAdmin
          .from('import_job_tracks')
          .select('id')
          .eq('job_id', options.jobId)
          .eq('track_external_id', tid)
          .maybeSingle();
        jobTrackId = jobTrack?.id;
      }

      try {
        const trackResult = await importTrackById(tid, {
          ...options,
          jobTrackId
        });

        const linkTx = await executeTransaction(async () => {
          const result = await supabaseAdmin
            .from('playlist_tracks')
            .insert({ playlist_id: playlistDbId, track_id: trackResult.trackId, position: index + 1 });

          if (result.error && result.error.code !== '23505') {
            throw result.error;
          }
        }, { operationName: `Link track ${trackResult.trackId} to playlist ${playlistDbId}` });

        if (!linkTx.success) throw new Error(linkTx.error || 'Failed to link playlist track');
      } catch (err) {
        importLog('error', `Track import failed for tid ${tid} in playlist ${playlistDbId}`, { error: err.message });
        if (jobTrackId) {
          await supabaseAdmin
            .from('import_job_tracks')
            .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
            .eq('id', jobTrackId);
        }
      }

      completedTracks += 1;
      if (options.jobId) {
        await updateJob(options.jobId, {
          progress: Math.min(89, Math.round((completedTracks / Math.max(uniqueTrackIds.length, 1)) * 89))
        });
      }

      return trackResult;
    }
  );

  return {
    playlistId: playlistDbId,
    tracksImported: importedTracks.length,
    trackResults: importedTracks
  };
}

async function importArtistById(artistId, options = {}) {
  importLog('info', 'importArtistById started', { artistId });
  const artistResult = await ensureArtistImported(artistId, null, options);
  return {
    artistId: artistResult.artistId,
    created: artistResult.created
  };
}

async function runImportJob(job) {
  importLog('info', 'runImportJob invoked', { jobId: job.jobId, type: job.type, sourceId: job.sourceId });
  await updateJob(job.jobId, {
    status: 'processing',
    progress: 1
  });

  jobLog(job.jobId, `Started ${job.type} import for ${job.sourceId}`);

  try {
    let result;
    const importContext = {
      completedAlbumExternalIds: new Set()
    };

    if (job.type === 'artist') {
      result = await importArtistById(job.sourceId, { jobId: job.jobId, importContext });
    } else if (job.type === 'album') {
      result = await importAlbumById(job.sourceId, {
        jobId: job.jobId,
        importContext
      });
    } else if (job.type === 'track') {
      result = await importTrackById(job.sourceId, {
        jobId: job.jobId,
        importContext
      });
    } else if (job.type === 'playlist') {
      result = await importPlaylistById(job.sourceId, {
        jobId: job.jobId,
        adminId: job.requestedBy,
        importContext
      });
    } else {
      throw new Error(`Unsupported import type: ${job.type}`);
    }

    if (job.type === 'artist') {
      await updateJob(job.jobId, {
        status: 'completed',
        progress: 100,
        finishedAt: new Date().toISOString()
      });
      jobLog(job.jobId, `Completed ${job.type} import`);
    } else {
      // For album/playlist/track, triggering phase is done. Callback webhook will mark it 'completed'/'failed'.
      await updateJob(job.jobId, {
        status: 'processing',
        progress: 90
      });
      jobLog(job.jobId, `Finished triggering parallel audio transcodes. Processing HLS in background.`);
      
      // If all tracks are already completed (e.g., skipped because they already have ingested audio), finalize immediately.
      await checkAndUpdateParentJobStatus(job.jobId);
    }

    importLog('info', 'Job processing trigger phase completed successfully', { jobId: job.jobId, type: job.type });
  } catch (error) {
    await updateJob(job.jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message,
      progress: 100
    });
    jobLog(job.jobId, `Failed: ${error.message}`);
    importLog('error', 'Job failed', { jobId: job.jobId, type: job.type, error: error.message });
  }
}

const isUUIDVal = (val) => typeof val === 'string' && /^[0-9a-fA-F-]{36}$/.test(val);

async function enqueueImport(req, res, type, sourceId) {
  if (!sourceId || String(sourceId).trim().length === 0) {
    return res.status(400).json({ error: `${type} id is required` });
  }

  try {
    const job = await createJob({
      type,
      sourceId: String(sourceId).trim(),
      requestedBy: req.user?.id || null
    });

    setImmediate(() => runImportJob(job));

    importLog('info', 'Queued import request from API', {
      routeType: type,
      sourceId: String(sourceId).trim(),
      requestedBy: req.user?.id || null,
      jobId: job.jobId
    });

    return res.status(202).json({
      success: true,
      message: 'Import job queued',
      jobId: job.jobId,
      type: job.type,
      sourceId: job.sourceId,
      status: job.status
    });
  } catch (err) {
    importLog('error', 'Failed to enqueue import', { type, sourceId, error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

async function importArtist(req, res) {
  return enqueueImport(req, res, 'artist', req.params.artistId);
}

async function importAlbum(req, res) {
  return enqueueImport(req, res, 'album', req.params.albumId);
}

async function importTrack(req, res) {
  return enqueueImport(req, res, 'track', req.params.trackId);
}

async function importPlaylist(req, res) {
  return enqueueImport(req, res, 'playlist', req.params.playlistId);
}

function parseTypeAndIdFromApiUrl(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    const callName = parsed.searchParams.get('__call');

    if (callName === 'artist.getArtistPageDetails') {
      return { type: 'artist', id: parsed.searchParams.get('artistId') };
    }
    if (callName === 'content.getAlbumDetails') {
      return { type: 'album', id: parsed.searchParams.get('albumid') };
    }
    if (callName === 'song.getDetails') {
      return { type: 'track', id: parsed.searchParams.get('pids') };
    }
    if (callName === 'playlist.getDetails') {
      return { type: 'playlist', id: parsed.searchParams.get('listid') };
    }

    return null;
  } catch (_) {
    return null;
  }
}

async function enqueueImportByApi(req, res) {
  const apiUrl = req.body?.apiUrl || req.query?.apiUrl;
  if (!apiUrl) {
    return res.status(400).json({ error: 'apiUrl is required' });
  }

  const parsed = parseTypeAndIdFromApiUrl(apiUrl);
  importLog('info', 'enqueueImportByApi parsed URL', { apiUrl, parsed });
  if (!parsed || !parsed.id) {
    return res.status(400).json({
      error: 'Unsupported apiUrl. Allowed calls: artist.getArtistPageDetails, content.getAlbumDetails, song.getDetails, playlist.getDetails'
    });
  }

  return enqueueImport(req, res, parsed.type, parsed.id);
}

async function getImportStatus(req, res) {
  const { jobId } = req.params;

  if (!isUUIDVal(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format' });
  }

  try {
    const { data: job, error } = await supabaseAdmin
      .from('import_jobs')
      .select(`
        *,
        tracks:import_job_tracks(*)
      `)
      .eq('job_id', jobId)
      .maybeSingle();

    if (error) {
      importLog('error', 'Status request failed', { jobId, error: error.message });
      return res.status(500).json({ error: error.message });
    }

    if (!job) {
      importLog('warn', 'Status requested for unknown job', { jobId });
      return res.status(404).json({ error: 'Job not found' });
    }

    const formatted = {
      jobId: job.job_id,
      type: job.type,
      sourceId: job.source_id,
      requestedBy: job.requested_by,
      status: job.status,
      progress: job.progress,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      error: job.error,
      tracks: (job.tracks || []).map(t => ({
        id: t.id,
        trackExternalId: t.track_external_id,
        title: t.title,
        status: t.status,
        error: t.error,
        updatedAt: t.updated_at
      }))
    };

    importLog('info', 'Status requested for job', { jobId, status: job.status, progress: job.progress });
    return res.status(200).json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function checkAndUpdateParentJobStatus(jobId) {
  const { data: tracks, error } = await supabaseAdmin
    .from('import_job_tracks')
    .select('status')
    .eq('job_id', jobId);

  if (error || !tracks || tracks.length === 0) return;

  const total = tracks.length;
  const finished = tracks.filter(t => t.status === 'completed' || t.status === 'failed').length;
  const progress = Math.min(100, Math.max(90, Math.round((finished / total) * 10) + 90));

  const isCompleted = finished === total;
  const anyFailed = tracks.some(t => t.status === 'failed');

  let finalStatus = 'processing';
  if (isCompleted) {
    finalStatus = anyFailed ? 'failed' : 'completed';
  }

  await supabaseAdmin
    .from('import_jobs')
    .update({
      progress: isCompleted ? 100 : progress,
      status: finalStatus,
      finished_at: isCompleted ? new Date().toISOString() : null
    })
    .eq('job_id', jobId);
}

async function handleTranscodeCallback(req, res) {
  const signature = req.headers['x-callback-signature'];
  const payload = req.body;
  const { status, trackId, jobId, jobTrackId, hlsMasterPath, bitrates, error } = payload;

  const secret = process.env.AZURE_TRANSCODER_SECRET || '';
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  if (signature !== expectedSignature) {
    importLog('warn', 'Callback verification failed', { received: signature, expected: expectedSignature });
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  importLog('info', 'Received signed Azure callback', { trackId, jobId, jobTrackId, status });

  try {
    if (status === 'success') {
      // 1. Database transactions to save HLS path
      const assetTx = await executeTransaction(async (tracker) => {
        // HLS playlists are stored relative, so no addTrackAudio progressive paths are needed for HLS variants.
        // We update the tracks table directly.
        await updateAndTrack(
          tracker,
          'tracks',
          { hls_master_path: hlsMasterPath, is_published: true },
          'track_id',
          trackId
        );
      }, { operationName: `Callback ingest ${trackId}` });

      if (!assetTx.success) {
        throw new Error(assetTx.error || 'Failed to update track table');
      }

      // 2. Update child track status in database (Supabase realtime will broadcast this)
      if (jobTrackId) {
        await supabaseAdmin
          .from('import_job_tracks')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', jobTrackId);
      }
    } else {
      // Transcode failed
      if (jobTrackId) {
        await supabaseAdmin
          .from('import_job_tracks')
          .update({ status: 'failed', error: error || 'Unknown transcoding error', updated_at: new Date().toISOString() })
          .eq('id', jobTrackId);
      }
    }

    // 3. Update parent job progress/status
    if (jobId) {
      await checkAndUpdateParentJobStatus(jobId);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    importLog('error', 'Callback execution failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

async function proxyJioSaavn(req, res) {
  try {
    const params = req.query;
    const url = 'https://www.jiosaavn.com/api.php';
    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Origin': 'https://www.jiosaavn.com',
        'Referer': 'https://www.jiosaavn.com/',
        'Cookie': 'L=english',
      }
    });

    let data = response.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {
        // Keep original string
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    importLog('error', 'Proxy request failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  importArtist,
  importAlbum,
  importTrack,
  importPlaylist,
  enqueueImportByApi,
  getImportStatus,
  handleTranscodeCallback,
  proxyJioSaavn
};