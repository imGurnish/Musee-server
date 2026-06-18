/**
 * Recommendation helpers shared by the queue (auto-next) and recommendation
 * endpoints. These produce ordered arrays of internal track UUIDs; callers
 * resolve them to full track payloads as needed.
 */
const { supabase, supabaseAdmin } = require('../db/config');
const { normalizeLanguageCodes } = require('../utils/userPreferences');

const db = supabaseAdmin || supabase;

/**
 * Similar tracks for one or more seed tracks, read from the precomputed
 * track_content_features.similar_track_ids (populated by refresh_similar_tracks).
 * Returns a de-duplicated, interleaved list so multiple seeds contribute fairly.
 */
async function getSimilarTrackIds(seedTrackIds = [], limit = 50) {
  const seeds = Array.from(new Set((seedTrackIds || []).filter(Boolean)));
  if (!seeds.length) return [];

  const { data, error } = await db
    .from('track_content_features')
    .select('track_id, similar_track_ids')
    .in('track_id', seeds);
  if (error) {
    console.error('[REC] getSimilarTrackIds failed:', error.message);
    return [];
  }

  // Round-robin interleave each seed's similar list for variety.
  const lists = (data || [])
    .map(r => (Array.isArray(r.similar_track_ids) ? r.similar_track_ids : []))
    .filter(l => l.length);
  const out = [];
  const seen = new Set(seeds);
  let i = 0;
  while (out.length < limit) {
    let progressed = false;
    for (const list of lists) {
      const id = list[i];
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
        progressed = true;
        if (out.length >= limit) break;
      }
    }
    if (!progressed) break;
    i += 1;
  }
  return out;
}

/**
 * Tracks in the user's highest-affinity genres that they have not yet heard.
 * This is the "matches your taste" discovery signal driven by listening history.
 */
async function getAffinityGenreTrackIds(userId, limit = 50, preferredLanguages = []) {
  if (!userId) return [];

  const { data: affinity, error: affErr } = await db
    .from('user_genre_affinity')
    .select('genre, affinity_score')
    .eq('user_id', userId)
    .gt('affinity_score', 0.3)
    .order('affinity_score', { ascending: false })
    .limit(5);
  if (affErr || !affinity || !affinity.length) return [];

  const topGenres = affinity.map(a => a.genre);
  const langs = normalizeLanguageCodes(preferredLanguages);

  let q = db
    .from('track_content_features')
    .select('track_id, popularity_score, tracks!inner(language_code, is_published)')
    .overlaps('genres', topGenres)
    .eq('tracks.is_published', true)
    .order('popularity_score', { ascending: false })
    .limit(limit * 3);
  if (langs.length === 1) q = q.eq('tracks.language_code', langs[0]);
  else if (langs.length > 1) q = q.in('tracks.language_code', langs);

  const { data, error } = await q;
  if (error) {
    console.error('[REC] getAffinityGenreTrackIds failed:', error.message);
    return [];
  }
  return (data || []).map(r => r.track_id);
}

/**
 * Track ids the user has disliked (to always exclude from auto-fill).
 */
async function getDislikedTrackIds(userId) {
  if (!userId) return new Set();
  const { data } = await db
    .from('user_track_preferences')
    .select('track_id')
    .eq('user_id', userId)
    .eq('preference', -1);
  return new Set((data || []).map(d => d.track_id));
}

/**
 * Recently played track ids (to avoid immediately repeating).
 */
async function getRecentlyPlayedTrackIds(userId, limit = 100) {
  if (!userId) return new Set();
  const { data } = await db
    .from('user_track_listening_history')
    .select('track_id')
    .eq('user_id', userId)
    .order('played_at', { ascending: false })
    .limit(limit);
  return new Set((data || []).map(d => d.track_id));
}

/**
 * Build an ordered, personalized list of "what to play next" track ids.
 *
 * Priority order:
 *   1. Tracks similar to the seed (current/last) track.
 *   2. Tracks in the user's top affinity genres.
 * Then filtered against: explicit dislikes, exclude set (current queue),
 * and recently-played history. Returns [] if no personalized signal exists so
 * the caller can fall back to its own random/popular fill.
 *
 * @param {object}   opts
 * @param {string}   opts.userId
 * @param {string}   [opts.seedTrackId]   currently playing / last queued track
 * @param {number}   [opts.limit]
 * @param {string[]} [opts.excludeIds]    ids already in the queue
 * @param {string[]} [opts.preferredLanguages]
 */
async function getAutoNextTrackIds({ userId, seedTrackId, limit = 30, excludeIds = [], preferredLanguages = [] } = {}) {
  const exclude = new Set((excludeIds || []).filter(Boolean));
  if (seedTrackId) exclude.add(seedTrackId);

  const [disliked, recent] = await Promise.all([
    getDislikedTrackIds(userId),
    getRecentlyPlayedTrackIds(userId),
  ]);

  const accept = (id) => id && !exclude.has(id) && !disliked.has(id) && !recent.has(id);

  const result = [];
  const pushUnique = (ids) => {
    for (const id of ids) {
      if (accept(id) && !exclude.has(id)) {
        exclude.add(id);
        result.push(id);
        if (result.length >= limit) return true;
      }
    }
    return false;
  };

  // 1. Similar to the seed track.
  if (seedTrackId) {
    const similar = await getSimilarTrackIds([seedTrackId], limit * 2);
    if (pushUnique(similar)) return result;
  }

  // 2. Affinity-genre discovery.
  const affinity = await getAffinityGenreTrackIds(userId, limit * 2, preferredLanguages);
  pushUnique(affinity);

  return result;
}

module.exports = {
  getSimilarTrackIds,
  getAffinityGenreTrackIds,
  getDislikedTrackIds,
  getRecentlyPlayedTrackIds,
  getAutoNextTrackIds,
};
