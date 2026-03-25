/**
 * Import Controller - Queue-based JioSaavn importer
 * Order: artist -> album -> track -> playlist
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
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

const importJobs = new Map();

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
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  marathi: 'mr',
  gujarati: 'gu',
  urdu: 'ur',
  malayalam: 'ml',
  kannada: 'kn'
};

function normalizeLanguageCode(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (/^[a-z]{2,3}(-[a-z]{2})?$/.test(value)) return value;
  return LANGUAGE_NAME_TO_CODE[value] || null;
}

function languageNameFromCodeOrInput(code, input) {
  const codeToName = {
    en: 'English', hi: 'Hindi', pa: 'Punjabi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
    mr: 'Marathi', gu: 'Gujarati', ur: 'Urdu', ml: 'Malayalam', kn: 'Kannada'
  };
  if (codeToName[code]) return codeToName[code];
  if (typeof input === 'string' && input.trim()) {
    const v = input.trim();
    return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  }
  return 'Unknown';
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

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text || fallback;
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

function firstArtistFromTrack(rawTrack) {
  const artistMap = rawTrack?.more_info?.artistMap || rawTrack?.artistMap || rawTrack?.artist_map;
  const candidates = asArray(artistMap?.primary_artists || artistMap?.artists || artistMap);
  if (candidates.length > 0) {
    const first = candidates[0] || {};
    return {
      externalId: String(first.id || first.artistId || '').trim() || null,
      name: safeText(first.name, null)
    };
  }

  const names = safeText(rawTrack?.primary_artists || rawTrack?.singers || rawTrack?.more_info?.singers, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return {
    externalId: null,
    name: names[0] || null
  };
}

function normalizeTrackPayload(rawData, trackId) {
  const rawSong = rawData?.[trackId] || rawData?.songs?.[trackId] || rawData;
  const artist = firstArtistFromTrack(rawSong || {});

  const albumId = String(
    rawSong?.albumid ||
    rawSong?.album_id ||
    rawSong?.more_info?.album_id ||
    ''
  ).trim() || null;

  return {
    rawSong,
    id: String(rawSong?.id || trackId || '').trim(),
    title: safeText(rawSong?.song || rawSong?.title, 'Untitled Track'),
    duration: toInt(rawSong?.duration, 0),
    language: safeText(rawSong?.language, null),
    isExplicit: rawSong?.explicit_content === 1 || rawSong?.explicit_content === '1',
    trackNumber: toInt(rawSong?.more_info?.label_id || rawSong?.position || rawSong?.track_number, 0) || null,
    albumId,
    albumTitle: safeText(rawSong?.album, null),
    image: safeText(rawSong?.image || rawSong?.more_info?.image, null),
    artistExternalId: artist.externalId,
    artistName: artist.name,
    downloadUrl: safeText(rawSong?.encrypted_media_url || rawSong?.more_info?.encrypted_media_url, null),
    previewUrl: safeText(rawSong?.media_preview_url || rawSong?.more_info?.media_preview_url, null),
    permaUrl: safeText(rawSong?.perma_url || rawSong?.more_info?.perma_url, null),
    playCount: toInt(rawSong?.play_count, 0),
    copyrightText: safeText(rawSong?.copyright_text, null)
  };
}

function normalizeArtistPayload(rawData, artistId) {
  const artist = rawData?.artist || rawData?.data || rawData;
  return {
    id: String(artist?.artistId || artist?.id || artistId || '').trim(),
    name: safeText(artist?.name, 'Unknown Artist'),
    image: safeText(artist?.image, null),
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
    description: safeText(album?.subtitle || album?.description, 'Imported from JioSaavn'),
    image: safeText(album?.image, null),
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
  const playlist = rawData?.list || rawData?.playlist || rawData;
  const songs = asArray(playlist?.list || playlist?.songs);
  const trackIds = songs
    .map((song) => String(song?.id || '').trim())
    .filter(Boolean);

  return {
    rawPlaylist: playlist,
    id: String(playlist?.listid || playlist?.id || playlistId || '').trim(),
    name: safeText(playlist?.title || playlist?.name, 'Untitled Playlist'),
    description: safeText(playlist?.subtitle || playlist?.description, 'Imported from JioSaavn'),
    image: safeText(playlist?.image, null),
    language: safeText(playlist?.language, null),
    totalTracks: toInt(playlist?.list_count || playlist?.song_count || songs.length, songs.length),
    duration: toInt(playlist?.duration, 0),
    permaUrl: safeText(playlist?.perma_url, null),
    trackIds,
    songs
  };
}

function createJob({ type, sourceId, trackDownload, requestedBy }) {
  const jobId = uuidv4();
  const now = new Date().toISOString();
  const job = {
    jobId,
    type,
    sourceId,
    trackDownload,
    requestedBy: requestedBy || null,
    status: 'queued',
    progress: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    logs: []
  };

  importJobs.set(jobId, job);
  importLog('info', 'Created import job', { jobId, type, sourceId, trackDownload, requestedBy: requestedBy || null });
  return job;
}

function updateJob(jobId, patch) {
  const job = importJobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  importLog('info', 'Updated import job', { jobId, patch });
}

function jobLog(jobId, message) {
  const job = importJobs.get(jobId);
  if (!job) return;
  job.logs.push({ at: new Date().toISOString(), message });
  if (job.logs.length > 100) job.logs = job.logs.slice(-100);
  importLog('info', 'Job log event', { jobId, message });
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
    importLog('info', 'Album already exists via external ref', { albumExternalId, albumId: existingAlbumId });
    return { albumId: existingAlbumId, created: false, trackIds: [] };
  }

  const { data: remoteAlbum } = await fetchSaavn('content.getAlbumDetails', { albumid: albumExternalId });
  const normalized = normalizeAlbumPayload(remoteAlbum, albumExternalId);

  const artistImport = await ensureArtistImported(normalized.artistExternalId, normalized.artistName, options);

  const tx = await executeTransaction(async (tracker) => {
    const languageCode = normalizeLanguageCode(normalized.language);
    await ensureLanguageExists(languageCode, languageNameFromCodeOrInput(languageCode, normalized.language));

    const album = await createAndTrack(tracker, 'albums', {
      title: normalized.title,
      description: normalized.description,
      cover_url: normalized.image || DEFAULTS.albumCover,
      release_date: normalized.releaseDate || null,
      duration: normalized.songs.reduce((sum, song) => sum + toInt(song?.duration, 0), 0),
      is_published: false
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

async function importTrackById(trackId, options = {}) {
  importLog('info', 'importTrackById started', { trackId, forcedAlbumId: options.forcedAlbumId || null, trackDownload: options.trackDownload === true });
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

  const artistImport = await ensureArtistImported(normalized.artistExternalId, normalized.artistName, options);

  if (existingTrackId) {
    const existingTrack = await supabaseAdmin
      .from('tracks')
      .select('track_id, album_id')
      .eq('track_id', existingTrackId)
      .maybeSingle();

    if (existingTrack.error) throw existingTrack.error;

    const linkedTrackArtist = await ensureTrackArtistLink(existingTrackId, artistImport.artistId, 'owner');
    const targetAlbumId = options.forcedAlbumId || existingTrack.data?.album_id || null;
    const linkedAlbumArtist = targetAlbumId
      ? await ensureAlbumArtistLink(targetAlbumId, artistImport.artistId, 'owner')
      : false;

    importLog('info', 'Track already exists via external ref (reconciled links)', {
      trackId,
      existingTrackId,
      artistId: artistImport.artistId,
      linkedTrackArtist,
      linkedAlbumArtist,
      targetAlbumId
    });

    return { trackId: existingTrackId, created: false, downloaded: false };
  }

  let albumId = options.forcedAlbumId || null;
  if (!albumId) {
    if (normalized.albumId) {
      const albumImport = await ensureAlbumImportedShell(normalized.albumId, options);
      albumId = albumImport.albumId;
    } else {
      const fallbackAlbumTx = await executeTransaction(async (tracker) => {
        const album = await createAndTrack(tracker, 'albums', {
          title: normalized.albumTitle || `${normalized.title} - Single`,
          description: 'Auto-created from track import',
          cover_url: normalized.image || DEFAULTS.albumCover,
          release_date: null,
          is_published: false,
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
    const languageCode = normalizeLanguageCode(normalized.language);
    await ensureLanguageExists(languageCode, languageNameFromCodeOrInput(languageCode, normalized.language));

    const track = await createAndTrack(tracker, 'tracks', {
      album_id: albumId,
      title: normalized.title,
      duration: normalized.duration,
      language_code: languageCode,
      is_explicit: normalized.isExplicit,
      is_published: false,
      track_number: normalized.trackNumber,
      subtitle: null,
      lyrics_url: null,
      lyrics_snippet: null,
      play_count: normalized.playCount,
      likes_count: 0,
      popularity_score: 0,
      copyright_text: normalized.copyrightText,
      video_url: null,
      hls_master_path: null
    }, 'track_id');

    const dbTrackId = track.track_id || track.id;

    await ensureTrackArtistLink(dbTrackId, artistImport.artistId, 'owner');

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
        language: normalized.language,
        encrypted_media_url: normalized.downloadUrl,
        media_preview_url: normalized.previewUrl
      }
    });

    return {
      trackId: dbTrackId,
      previewUrl: normalized.previewUrl
    };
  }, { operationName: `Import track ${trackId}` });

  if (!tx.success) throw new Error(tx.error || 'Track import failed');
  importLog('info', 'Track core transaction complete', { trackId, dbTrackId: tx.data.trackId, hasPreview: Boolean(tx.data.previewUrl) });

  if (options.trackDownload === true && tx.data.previewUrl) {
    try {
      const mediaResp = await axios.get(tx.data.previewUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const contentType = mediaResp.headers['content-type'] || 'audio/mp4';
      const extension = contentType.includes('mpeg') ? 'mp3' : contentType.includes('mp4') ? 'm4a' : 'bin';

      const processResult = await processAudioBuffer({
        originalname: `track_${tx.data.trackId}.${extension}`,
        mimetype: contentType,
        buffer: Buffer.from(mediaResp.data)
      }, tx.data.trackId);

      await executeTransaction(async (tracker) => {
        const fileEntries = Object.values(processResult.files || {});
        for (const filePath of fileEntries) {
          const fileName = String(filePath).split('/').pop() || '';
          const bitrateMatch = fileName.match(/_(\d+)k\./);
          const bitrate = bitrateMatch ? Number.parseInt(bitrateMatch[1], 10) : processResult.bitrate || 128;
          const ext = (fileName.split('.').pop() || 'mp3').toLowerCase();
          await addTrackAudio(tx.data.trackId, ext, bitrate, filePath);
        }

        if (processResult.hls?.master) {
          await updateAndTrack(
            tracker,
            'tracks',
            { hls_master_path: processResult.hls.master },
            'track_id',
            tx.data.trackId
          );
        }
      }, { operationName: `Track asset ingest ${tx.data.trackId}` });

      return { trackId: tx.data.trackId, created: true, downloaded: true };
    } catch (assetError) {
      importLog('warn', 'Track asset download/process skipped', { trackId, reason: assetError.message });
      return { trackId: tx.data.trackId, created: true, downloaded: false, warning: assetError.message };
    }
  }

  return { trackId: tx.data.trackId, created: true, downloaded: false };
}

async function importAlbumById(albumId, options = {}) {
  importLog('info', 'importAlbumById started', { albumId, trackDownload: options.trackDownload === true });
  const albumShell = await ensureAlbumImportedShell(albumId, options);

  const { data: remoteAlbum } = await fetchSaavn('content.getAlbumDetails', { albumid: albumId });
  const normalized = normalizeAlbumPayload(remoteAlbum, albumId);
  const uniqueTrackIds = Array.from(new Set(normalized.trackIds));

  const importedTracks = [];
  for (let index = 0; index < uniqueTrackIds.length; index += 1) {
    const tid = uniqueTrackIds[index];
    importLog('info', 'Importing album track', { albumId, trackId: tid, index: index + 1, total: uniqueTrackIds.length });
    const imported = await importTrackById(tid, { ...options, forcedAlbumId: albumShell.albumId });
    importedTracks.push(imported);

    if (options.jobId) {
      updateJob(options.jobId, {
        progress: Math.min(95, Math.round(((index + 1) / Math.max(uniqueTrackIds.length, 1)) * 95))
      });
    }
  }

  return {
    albumId: albumShell.albumId,
    albumCreated: albumShell.created,
    tracksImported: importedTracks.length,
    trackResults: importedTracks
  };
}

async function importPlaylistById(playlistId, options = {}) {
  importLog('info', 'importPlaylistById started', { playlistId, trackDownload: options.trackDownload === true });
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
        language_code: normalizeLanguageCode(normalized.language),
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
  const importedTracks = [];

  for (let index = 0; index < uniqueTrackIds.length; index += 1) {
    const tid = uniqueTrackIds[index];
    importLog('info', 'Importing playlist track', { playlistId, trackId: tid, index: index + 1, total: uniqueTrackIds.length });
    const trackResult = await importTrackById(tid, options);
    importedTracks.push(trackResult);

    const linkTx = await executeTransaction(async () => {
      const result = await supabaseAdmin
        .from('playlist_tracks')
        .insert({ playlist_id: playlistDbId, track_id: trackResult.trackId, position: index + 1 });

      if (result.error && result.error.code !== '23505') {
        throw result.error;
      }
    }, { operationName: `Link track ${trackResult.trackId} to playlist ${playlistDbId}` });

    if (!linkTx.success) throw new Error(linkTx.error || 'Failed to link playlist track');

    if (options.jobId) {
      updateJob(options.jobId, {
        progress: Math.min(95, Math.round(((index + 1) / Math.max(uniqueTrackIds.length, 1)) * 95))
      });
    }
  }

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
  importLog('info', 'runImportJob invoked', { jobId: job.jobId, type: job.type, sourceId: job.sourceId, trackDownload: job.trackDownload });
  updateJob(job.jobId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: 1
  });

  jobLog(job.jobId, `Started ${job.type} import for ${job.sourceId}`);

  try {
    let result;
    if (job.type === 'artist') {
      result = await importArtistById(job.sourceId, { jobId: job.jobId });
    } else if (job.type === 'album') {
      result = await importAlbumById(job.sourceId, {
        jobId: job.jobId,
        trackDownload: job.trackDownload
      });
    } else if (job.type === 'track') {
      result = await importTrackById(job.sourceId, {
        jobId: job.jobId,
        trackDownload: job.trackDownload
      });
    } else if (job.type === 'playlist') {
      result = await importPlaylistById(job.sourceId, {
        jobId: job.jobId,
        trackDownload: job.trackDownload,
        adminId: job.requestedBy
      });
    } else {
      throw new Error(`Unsupported import type: ${job.type}`);
    }

    updateJob(job.jobId, {
      status: 'success',
      progress: 100,
      finishedAt: new Date().toISOString(),
      result
    });
    jobLog(job.jobId, `Completed ${job.type} import`);
    importLog('info', 'Job completed successfully', { jobId: job.jobId, type: job.type });
  } catch (error) {
    updateJob(job.jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message,
      progress: 100
    });
    jobLog(job.jobId, `Failed: ${error.message}`);
    importLog('error', 'Job failed', { jobId: job.jobId, type: job.type, error: error.message });
  }
}

function parseTrackDownloadFlag(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return false;
}

function enqueueImport(req, res, type, sourceId) {
  if (!sourceId || String(sourceId).trim().length === 0) {
    return res.status(400).json({ error: `${type} id is required` });
  }

  const trackDownload = parseTrackDownloadFlag(req.query.track_download ?? req.query.trackDownload ?? req.body?.track_download ?? req.body?.trackDownload);
  const job = createJob({
    type,
    sourceId: String(sourceId).trim(),
    trackDownload,
    requestedBy: req.user?.id || null
  });

  setImmediate(() => runImportJob(job));

  importLog('info', 'Queued import request from API', {
    routeType: type,
    sourceId: String(sourceId).trim(),
    trackDownload,
    requestedBy: req.user?.id || null,
    jobId: job.jobId
  });

  return res.status(202).json({
    success: true,
    message: 'Import job queued',
    jobId: job.jobId,
    type: job.type,
    sourceId: job.sourceId,
    trackDownload: job.trackDownload,
    status: job.status
  });
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
  const job = importJobs.get(jobId);

  if (!job) {
    importLog('warn', 'Status requested for unknown job', { jobId });
    return res.status(200).json({
      jobId,
      status: 'not_found',
      progress: 100,
      error: 'job not found in in-memory queue (possibly process restart)',
      result: null,
      logs: []
    });
  }

  importLog('info', 'Status requested for job', { jobId, status: job.status, progress: job.progress });
  return res.status(200).json(job);
}

module.exports = {
  importArtist,
  importAlbum,
  importTrack,
  importPlaylist,
  enqueueImportByApi,
  getImportStatus
};