/* eslint-disable no-console */
require('dotenv').config();

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../src/db/config');
const { getProviderId, findEntityIdByExternalId, upsertExternalRef } = require('../src/utils/externalRefs');

const DEFAULTS = {
  artistAvatar: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/avatars/users/default_avatar.png',
  artistCover: 'https://xvpputhovrhgowfkjhfv.supabase.co/storage/v1/object/public/covers/artists/default_cover.png'
};

const SAAVN_BASE = process.env.JIO_SAAVN_API_URL || 'https://www.jiosaavn.com/api.php';
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

if (!supabaseAdmin) {
  console.error(`${colors.red}[error]${colors.reset} SUPABASE_SERVICE_ROLE_KEY is required for this script`);
  process.exit(1);
}

function colorize(color, label) {
  return `${colors[color] || ''}${label}${colors.reset}`;
}

function logInfo(message, context) {
  const suffix = context ? ` ${JSON.stringify(context)}` : '';
  console.log(`${colorize('cyan', '[info]')} ${message}${suffix}`);
}

function logWarn(message, context) {
  const suffix = context ? ` ${JSON.stringify(context)}` : '';
  console.warn(`${colorize('yellow', '[warn]')} ${message}${suffix}`);
}

function logError(message, context) {
  const suffix = context ? ` ${JSON.stringify(context)}` : '';
  console.error(`${colorize('red', '[error]')} ${message}${suffix}`);
}

async function uploadImageFromUrlIfPossible({ bucket, path, imageUrl }) {
  if (!imageUrl || !supabaseAdmin?.storage) return null;

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const buffer = Buffer.from(response.data);

    // Try to determine a safe image MIME type. Some remote servers return
    // `application/octet-stream` or no content-type; detect common image
    // signatures or infer from the URL extension.
    const headerType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();

    function detectFromBuffer(buf, url) {
      if (!buf || buf.length < 4) return null;
      const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
      if (b0 === 0xff && b1 === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
      if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return { mime: 'image/png', ext: 'png' };
      if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return { mime: 'image/gif', ext: 'gif' };
      if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
        const sig = buf.toString('ascii', 8, 12);
        if (sig === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
      }
      // Try URL extension as last resort
      try {
        const m = String(url || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        if (m) {
          const ext = m[1].toLowerCase();
          const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
          if (map[ext]) return { mime: map[ext], ext };
        }
      } catch (_) {}
      return null;
    }

    let contentType = 'image/jpeg';
    const detected = detectFromBuffer(buffer, imageUrl);
    if (headerType && headerType.startsWith('image/')) {
      contentType = headerType;
    } else if (detected && detected.mime) {
      contentType = detected.mime;
    }

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, buffer, { upsert: true, contentType });

    if (uploadError) {
      logWarn('Avatar upload skipped', { bucket, path, reason: uploadError.message });
      return null;
    }

    const publicResp = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    const publicData = publicResp?.data || publicResp;
    return publicData?.publicUrl || publicData?.publicURL || null;
  } catch (error) {
    logWarn('Avatar fetch/upload skipped', { bucket, path, reason: error.message });
    return null;
  }
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
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }

  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const entityMap = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' '
  };

  const text = value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
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
  }).trim();

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

function buildSaavnUrl(callName, params = {}) {
  const query = new URLSearchParams({ __call: callName, _format: 'json', ...params });
  return `${SAAVN_BASE}?${query.toString()}`;
}

async function fetchTrackDetails(trackExternalId) {
  const url = buildSaavnUrl('song.getDetails', {
    cc: 'in',
    includeRelated: 'false',
    pids: trackExternalId
  });

  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  });

  return parseJsonMaybe(response.data) || response.data;
}

async function fetchArtistDetails(artistExternalId) {
  const url = buildSaavnUrl('artist.getArtistPageDetails', {
    cc: 'in',
    artistId: artistExternalId
  });

  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  });

  return parseJsonMaybe(response.data) || response.data;
}

function isUsableArtistImageUrl(imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) return false;
  return !imageUrl.includes('/_i/share-image-2.png');
}

function resolveArtistImageUrl(artistDetails) {
  const directImage = artistDetails?.image || null;
  if (isUsableArtistImageUrl(directImage)) return toLargeImage(directImage);

  const topSongs = artistDetails?.topSongs?.songs || artistDetails?.topSongs?.song || [];
  const firstSong = Array.isArray(topSongs) ? topSongs[0] : topSongs;
  const fallbackImage = firstSong?.image || null;
  if (isUsableArtistImageUrl(fallbackImage)) return toLargeImage(fallbackImage);

  return null;
}

function getTrackPayload(rawData, trackExternalId) {
  return rawData?.[trackExternalId] || rawData?.songs?.[trackExternalId] || rawData?.songs?.[0] || rawData?.song || rawData?.data || rawData;
}

function getArtistPayload(rawData, artistExternalId) {
  return rawData?.artist || rawData?.data || rawData?.[artistExternalId] || rawData;
}

function parseArgs(argv) {
  const result = {
    limit: null,
    offset: 0,
    trackId: null,
    dryRun: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--limit' && next) {
      result.limit = Math.max(1, Number.parseInt(next, 10) || 0) || null;
      index += 1;
      continue;
    }

    if (token === '--offset' && next) {
      result.offset = Math.max(0, Number.parseInt(next, 10) || 0);
      index += 1;
      continue;
    }

    if (token === '--track-id' && next) {
      result.trackId = String(next || '').trim() || null;
      index += 1;
      continue;
    }

    if (token === '--dry-run') {
      result.dryRun = true;
    }
  }

  return result;
}

async function loadTrackArtistSet(trackId, cache) {
  if (cache.has(trackId)) return cache.get(trackId);

  const { data, error } = await supabaseAdmin
    .from('track_artists')
    .select('artist_id')
    .eq('track_id', trackId);

  if (error) throw error;

  const artistSet = new Set((data || []).map((row) => row.artist_id).filter(Boolean));
  cache.set(trackId, artistSet);
  return artistSet;
}

async function ensureTrackArtistLink(trackId, artistId, cache, dryRun = false) {
  const artistSet = await loadTrackArtistSet(trackId, cache);
  if (artistSet.has(artistId)) {
    return { linked: false, reason: 'already-linked' };
  }

  if (dryRun) {
    artistSet.add(artistId);
    return { linked: true, dryRun: true };
  }

  const { error } = await supabaseAdmin
    .from('track_artists')
    .insert({ track_id: trackId, artist_id: artistId, role: 'viewer' });

  if (error && String(error.code) !== '23505') {
    throw error;
  }

  artistSet.add(artistId);
  return { linked: true, inserted: !error };
}

async function verifyArtistSync({ trackId, trackExternalId, artistId, artistExternalId, trackTitle }) {
  const [userRow, artistRow, externalRefRow, trackArtistRow] = await Promise.all([
    supabaseAdmin.from('users').select('user_id, avatar_url, user_type').eq('user_id', artistId).maybeSingle(),
    supabaseAdmin.from('artists').select('artist_id').eq('artist_id', artistId).maybeSingle(),
    artistExternalId
      ? supabaseAdmin
          .from('artist_external_refs')
          .select('artist_external_ref_id, artist_id, provider_id, external_id')
          .eq('artist_id', artistId)
          .eq('external_id', String(artistExternalId))
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseAdmin
      .from('track_artists')
      .select('track_artist_id, track_id, artist_id, role')
      .eq('track_id', trackId)
      .eq('artist_id', artistId)
      .maybeSingle()
  ]);

  if (userRow.error) throw userRow.error;
  if (artistRow.error) throw artistRow.error;
  if (externalRefRow.error) throw externalRefRow.error;
  if (trackArtistRow.error) throw trackArtistRow.error;

  const checks = {
    userExists: Boolean(userRow.data?.user_id),
    artistExists: Boolean(artistRow.data?.artist_id),
    trackArtistLinked: Boolean(trackArtistRow.data?.track_artist_id),
    externalRefLinked: artistExternalId ? Boolean(externalRefRow.data?.artist_external_ref_id) : true
  };

  if (!checks.userExists || !checks.artistExists || !checks.trackArtistLinked || !checks.externalRefLinked) {
    throw new Error(`verification failed for track ${trackExternalId}${trackTitle ? ` (${trackTitle})` : ''}`);
  }

  return {
    avatarUrl: userRow.data?.avatar_url || null,
    ...checks
  };
}

async function getTrackArtistLinkState(trackId, artistId) {
  const { data, error } = await supabaseAdmin
    .from('track_artists')
    .select('track_artist_id, track_id, artist_id, role')
    .eq('track_id', trackId)
    .eq('artist_id', artistId)
    .maybeSingle();

  if (error) throw error;

  return {
    linked: Boolean(data?.track_artist_id),
    role: data?.role || null,
    record: data || null
  };
}

async function ensureArtistEntity(candidate, context, providerId, caches, dryRun = false) {
  const nameKey = candidate.name ? candidate.name.trim().toLowerCase() : null;

  if (candidate.externalId && caches.byExternalId.has(candidate.externalId)) {
    return { artistId: caches.byExternalId.get(candidate.externalId), created: false, source: 'cache-external' };
  }

  if (!candidate.externalId && nameKey && caches.byName.has(nameKey)) {
    return { artistId: caches.byName.get(nameKey), created: false, source: 'cache-name' };
  }

  let artistId = null;
  let artistImageUrl = null;
  let artistDetails = null;

  if (candidate.externalId) {
    try {
      const artistRaw = await fetchArtistDetails(candidate.externalId);
      artistDetails = getArtistPayload(artistRaw, candidate.externalId);
      artistImageUrl = resolveArtistImageUrl(artistDetails);
    } catch (error) {
      logWarn('Artist detail fetch failed, continuing without avatar', {
        artistExternalId: candidate.externalId,
        reason: error.message
      });
    }

    artistId = await findEntityIdByExternalId({
      refTable: 'artist_external_refs',
      entityIdColumn: 'artist_id',
      providerId,
      externalId: candidate.externalId
    });
  }

  // Allow falling back to the track image when no artist-specific image was found
  if (!artistImageUrl && context && context.trackImage) {
    artistImageUrl = toLargeImage(context.trackImage);
  }

  if (!artistId && nameKey) {
    const existingByName = await supabaseAdmin
      .from('users')
      .select('user_id')
      .eq('user_type', 'artist')
      .ilike('name', candidate.name.trim())
      .maybeSingle();

    if (existingByName.error) throw existingByName.error;
    if (existingByName.data?.user_id) {
      artistId = existingByName.data.user_id;
    }
  }

  if (artistId) {
    const userRow = await supabaseAdmin
      .from('users')
      .select('user_id, name, user_type')
      .eq('user_id', artistId)
      .maybeSingle();

    if (userRow.error) throw userRow.error;

    if (!userRow.data && !dryRun) {
      const userPayload = {
        user_id: artistId,
        name: candidate.name || `Imported Artist ${artistId.slice(0, 8)}`,
        email: `import_artist_${artistId.replace(/-/g, '').slice(0, 12)}@musee.local`,
        user_type: 'artist',
        avatar_url: DEFAULTS.artistAvatar,
        settings: {
          import_source: 'jiosaavn',
          external_artist_id: candidate.externalId || null,
          imported_from_track: context.trackExternalId || null
        }
      };

      const insertUser = await supabaseAdmin.from('users').insert(userPayload);
      if (insertUser.error && String(insertUser.error.code) !== '23505') {
        throw insertUser.error;
      }
    }

    if (!dryRun && artistImageUrl) {
      const ext = 'jpg';
      const avatarPath = `users/${artistId}.${ext}`;
      const uploadedAvatarUrl = await uploadImageFromUrlIfPossible({
        bucket: process.env.SUPABASE_AVATAR_BUCKET || 'avatars',
        path: avatarPath,
        imageUrl: artistImageUrl
      });

      if (uploadedAvatarUrl) {
        const updateAvatar = await supabaseAdmin
          .from('users')
          .update({ avatar_url: uploadedAvatarUrl })
          .eq('user_id', artistId);

        if (updateAvatar.error) throw updateAvatar.error;
        logInfo('Artist avatar uploaded', { artistId, avatarUrl: uploadedAvatarUrl });
      }
    } else if (!dryRun) {
      logWarn('No artist avatar image resolved', { artistId, trackExternalId: context.trackExternalId });
    }

    if (!dryRun && userRow.data?.user_type !== 'artist') {
      const updateUser = await supabaseAdmin
        .from('users')
        .update({ user_type: 'artist', name: candidate.name || userRow.data.name })
        .eq('user_id', artistId);
      if (updateUser.error) throw updateUser.error;
    }

    const artistRow = await supabaseAdmin
      .from('artists')
      .select('artist_id')
      .eq('artist_id', artistId)
      .maybeSingle();

    if (artistRow.error) throw artistRow.error;

    const trackLinkState = await getTrackArtistLinkState(context.trackId, artistId);

    if (!artistRow.data && !dryRun) {
      const insertArtist = await supabaseAdmin.from('artists').insert({
        artist_id: artistId,
        bio: `Imported from JioSaavn${context.trackTitle ? ` via ${context.trackTitle}` : ''}`,
        cover_url: DEFAULTS.artistCover,
        debut_year: null,
        is_verified: false,
        social_links: {},
        monthly_listeners: 0,
        region_id: null,
        date_of_birth: null
      });

      if (insertArtist.error && String(insertArtist.error.code) !== '23505') {
        throw insertArtist.error;
      }
    }

    if (candidate.externalId) {
      caches.byExternalId.set(candidate.externalId, artistId);
    }
    if (nameKey) {
      caches.byName.set(nameKey, artistId);
    }

    if (!dryRun) {
      if (trackLinkState.linked) {
        logInfo('Artist already linked to track', {
          artistId,
          trackId: context.trackId,
          role: trackLinkState.role
        });
      } else {
        logWarn('Artist exists but track link is missing', {
          artistId,
          trackId: context.trackId,
          trackExternalId: context.trackExternalId
        });
      }
    }

    if (candidate.externalId && !dryRun) {
      const externalRef = await upsertExternalRef({
        refTable: 'artist_external_refs',
        entityIdColumn: 'artist_id',
        entityId: artistId,
        providerId,
        externalId: candidate.externalId,
        externalUrl: null,
        imageUrl: null,
        rawPayload: {
          track_external_id: context.trackExternalId || null,
          track_title: context.trackTitle || null,
          artist_name: candidate.name || null
        }
      });

      if (!externalRef?.artist_external_ref_id) {
        throw new Error(`artist external ref was not persisted for ${candidate.externalId}`);
      }
    }

    return { artistId, created: false, source: 'existing' };
  }

  if (dryRun) {
    artistId = uuidv4();
    if (candidate.externalId) caches.byExternalId.set(candidate.externalId, artistId);
    if (nameKey) caches.byName.set(nameKey, artistId);
    return { artistId, created: true, source: 'dry-run-create' };
  }

  artistId = uuidv4();
  const userPayload = {
    user_id: artistId,
    name: candidate.name || `Imported Artist ${artistId.slice(0, 8)}`,
    email: `import_artist_${artistId.replace(/-/g, '').slice(0, 12)}@musee.local`,
    user_type: 'artist',
    avatar_url: DEFAULTS.artistAvatar,
    settings: {
      import_source: 'jiosaavn',
      external_artist_id: candidate.externalId || null,
      imported_from_track: context.trackExternalId || null
    }
  };

  const insertUser = await supabaseAdmin.from('users').insert(userPayload);
  if (insertUser.error) throw insertUser.error;

  let uploadedAvatarUrl = null;
  if (artistImageUrl) {
    const ext = 'jpg';
    const avatarPath = `users/${artistId}.${ext}`;
    uploadedAvatarUrl = await uploadImageFromUrlIfPossible({
      bucket: process.env.SUPABASE_AVATAR_BUCKET || 'avatars',
      path: avatarPath,
      imageUrl: artistImageUrl
    });
  }

  if (uploadedAvatarUrl) {
    const updateAvatar = await supabaseAdmin
      .from('users')
      .update({ avatar_url: uploadedAvatarUrl })
      .eq('user_id', artistId);

    if (updateAvatar.error) throw updateAvatar.error;
    logInfo('Artist avatar uploaded', { artistId, avatarUrl: uploadedAvatarUrl });
  } else {
    logWarn('No artist avatar image resolved', { artistId, trackExternalId: context.trackExternalId });
  }

  const insertArtist = await supabaseAdmin.from('artists').insert({
    artist_id: artistId,
    bio: `Imported from JioSaavn${context.trackTitle ? ` via ${context.trackTitle}` : ''}`,
    cover_url: DEFAULTS.artistCover,
    debut_year: null,
    is_verified: false,
    social_links: {},
    monthly_listeners: 0,
    region_id: null,
    date_of_birth: null
  });

  if (insertArtist.error) throw insertArtist.error;

  if (candidate.externalId) caches.byExternalId.set(candidate.externalId, artistId);
  if (nameKey) caches.byName.set(nameKey, artistId);

  const externalRef = await upsertExternalRef({
    refTable: 'artist_external_refs',
    entityIdColumn: 'artist_id',
    entityId: artistId,
    providerId,
    externalId: candidate.externalId,
    externalUrl: null,
    imageUrl: null,
    rawPayload: {
      track_external_id: context.trackExternalId || null,
      track_title: context.trackTitle || null,
      artist_name: candidate.name || null
    }
  });

  if (!externalRef?.artist_external_ref_id) {
    throw new Error(`artist external ref was not persisted for ${candidate.externalId || candidate.name || artistId}`);
  }

  return { artistId, created: true, source: 'created' };
}

async function getTracksToProcess(providerId, options) {
  if (options.trackId) {
    const { data, error } = await supabaseAdmin
      .from('track_external_refs')
      .select('track_id, external_id, tracks:tracks!track_external_refs_track_id_fkey(track_id, title)')
      .eq('provider_id', providerId)
      .eq('external_id', options.trackId)
      .maybeSingle();

    if (error) throw error;
    return data ? [data] : [];
  }

  let query = supabaseAdmin
    .from('track_external_refs')
    .select('track_id, external_id, tracks:tracks!track_external_refs_track_id_fkey(track_id, title)')
    .eq('provider_id', providerId)
    .order('created_at', { ascending: true });

  if (typeof options.limit === 'number' && options.limit > 0) {
    const start = Math.max(0, options.offset || 0);
    query = query.range(start, start + options.limit - 1);
  } else if (typeof options.offset === 'number' && options.offset > 0) {
    query = query.range(options.offset, options.offset + 999999);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function run() {
  const options = parseArgs(process.argv);
  const providerId = await getProviderId('jiosaavn');
  const trackRows = await getTracksToProcess(providerId, options);
  const trackArtistSetCache = new Map();
  const artistCaches = {
    byExternalId: new Map(),
    byName: new Map()
  };

  logInfo('Starting JioSaavn track-artist sync', {
    providerId,
    tracks: trackRows.length,
    dryRun: options.dryRun
  });

  let processedTracks = 0;
  let linkedArtists = 0;
  let createdArtists = 0;
  let skippedTracks = 0;

  for (const row of trackRows) {
    const trackId = row.track_id;
    const trackExternalId = row.external_id;
    const trackTitle = row.tracks?.title || null;

    try {
      if (!trackId || !trackExternalId) {
        skippedTracks += 1;
        logWarn('Skipping track without external reference', { trackId, trackExternalId });
        continue;
      }

      logInfo('Fetching JioSaavn track', { trackId, trackExternalId, trackTitle });
      const rawData = await fetchTrackDetails(trackExternalId);
      const rawTrack = getTrackPayload(rawData, trackExternalId);
      const candidates = extractTrackArtistCandidates(rawTrack);

      if (candidates.length === 0) {
        skippedTracks += 1;
        logWarn('No artists found for track', { trackId, trackExternalId, trackTitle });
        continue;
      }

      logInfo('Resolved track artists', { trackId, trackExternalId, artists: candidates.length });

      for (const candidate of candidates) {
        const trackImage = rawTrack?.image || null;
        const artistResult = await ensureArtistEntity(
          candidate,
          { trackId, trackExternalId, trackTitle, trackImage },
          providerId,
          artistCaches,
          options.dryRun
        );

        if (artistResult.created) {
          createdArtists += 1;
          logInfo('Artist created or staged', {
            trackId,
            trackExternalId,
            artistId: artistResult.artistId,
            name: candidate.name || null
          });
        }

        const linkResult = await ensureTrackArtistLink(trackId, artistResult.artistId, trackArtistSetCache, options.dryRun);
        if (linkResult.linked) {
          linkedArtists += 1;
          logInfo('Linked artist to track', {
            trackId,
            trackExternalId,
            artistId: artistResult.artistId,
            role: 'viewer',
            dryRun: Boolean(linkResult.dryRun)
          });
        }

        if (!options.dryRun) {
          const verification = await verifyArtistSync({
            trackId,
            trackExternalId,
            artistId: artistResult.artistId,
            artistExternalId: candidate.externalId,
            trackTitle
          });

          logInfo('Verified artist sync', {
            trackId,
            trackExternalId,
            artistId: artistResult.artistId,
            userExists: verification.userExists,
            artistExists: verification.artistExists,
            externalRefLinked: verification.externalRefLinked,
            trackArtistLinked: verification.trackArtistLinked
          });
        } else {
          logInfo('Dry-run artist sync staged', {
            trackId,
            trackExternalId,
            artistId: artistResult.artistId,
            source: artistResult.source
          });
        }
      }

      processedTracks += 1;
    } catch (error) {
      skippedTracks += 1;
      logError('Track sync failed', {
        trackId,
        trackExternalId,
        trackTitle,
        reason: error.message
      });
    }
  }

  console.log(`${colorize('green', '[done]')} processed=${processedTracks} linked=${linkedArtists} createdArtists=${createdArtists} skipped=${skippedTracks}`);
}

run().catch((error) => {
  logError('Fatal sync failure', { reason: error.message });
  process.exitCode = 1;
});