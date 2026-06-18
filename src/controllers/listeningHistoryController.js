/**
 * Listening History & Recommendations Controller
 * 
 * Handles:
 * - Track play logging
 * - User preferences (likes/dislikes)
 * - Recommendation serving
 * - Affinity calculation
 * 
 * @requires supabase
 * @requires crypto
 */

const { supabase, supabaseAdmin } = require('../db/config');
const db = supabaseAdmin || supabase;

function isUuid(value) {
  if (!value || typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeExternalTrackId(trackId) {
  if (!trackId || typeof trackId !== 'string') return '';
  const raw = trackId.trim();
  if (raw.includes(':')) {
    const parts = raw
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[parts.length - 1]}`;
    }
    return parts[0] || raw;
  }
  return raw;
}

async function resolveTrackIdForHistory(trackId) {
  if (isUuid(trackId)) return trackId;

  const rawExternalId = typeof trackId === 'string' ? trackId.trim() : '';
  const normalizedExternalId = normalizeExternalTrackId(trackId);
  if (!normalizedExternalId && !rawExternalId) return null;

  const candidates = [
    rawExternalId,
    normalizedExternalId,
    rawExternalId.includes(':')
      ? rawExternalId.split(':').pop()?.trim()
      : rawExternalId,
  ].filter(Boolean);

  try {
    const { data: mapped } = await db
      .from('track_external_refs')
      .select('track_id')
      .in('external_id', candidates)
      .limit(1)
      .maybeSingle();

    return mapped?.track_id || null;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// 1. TRACK PLAY LOGGING
// ============================================================================

/**
 * Log a track play with engagement metrics
 * 
 * POST /api/listening/log-play
 * 
 * @body {object} payload
 *   @param {string} userId - User ID
 *   @param {string} trackId - Track ID
 *   @param {number} timeListenedSeconds - How long user listened
 *   @param {number} totalDurationSeconds - Track total duration
 *   @param {number} completionPercentage - % of track heard (0-100)
 *   @param {boolean} wasSkipped - Whether user skipped
 *   @param {number} [skipAtSeconds] - Where user skipped (if skipped)
 *   @param {string} [listeningContext] - 'playlist','album','search','recommendation','radio'
 *   @param {string} [contextId] - playlist_id or album_id
 *   @param {string} [deviceType] - 'mobile','web','desktop','tv'
 */
exports.logTrackPlay = async (req, res) => {
  try {
    const {
      trackId,
      timeListenedSeconds,
      totalDurationSeconds,
      completionPercentage,
      wasSkipped = false,
      skipAtSeconds = null,
      listeningContext = 'library',
      contextId = null,
      deviceType = 'mobile'
    } = req.body;
    const userId = req.user?.id || req.body?.userId;

    // Validate input
    if (!userId || !trackId || completionPercentage === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (completionPercentage < 0 || completionPercentage > 100) {
      return res.status(400).json({ error: 'Completion percentage must be 0-100' });
    }

    const resolvedTrackId = await resolveTrackIdForHistory(trackId);
    if (!resolvedTrackId) {
      return res.status(404).json({
        success: false,
        code: 'TRACK_NOT_MAPPED',
        message: 'Track is not mapped to internal catalog',
      });
    }

    // Insert into listening history
    const { data, error } = await db
      .from('user_track_listening_history')
      .insert({
        user_id: userId,
        track_id: resolvedTrackId,
        time_listened_seconds: timeListenedSeconds,
        total_duration_seconds: totalDurationSeconds,
        completion_percentage: completionPercentage,
        was_skipped: wasSkipped,
        skip_at_seconds: skipAtSeconds,
        listening_context: listeningContext,
        context_id: contextId,
        device_type: deviceType
      })
      .select();

    if (error) throw error;

    // Update artist/album/playlist listening history (aggregate)
    await updateAggregateListeningStats(userId, resolvedTrackId, timeListenedSeconds, listeningContext, contextId);

    // Count this as a real play (not a quick skip) and bump the global play
    // counter that powers trending. Without this, trending stayed frozen on
    // import-time values.
    const isRealPlay = !wasSkipped
      && (completionPercentage >= 30 || (timeListenedSeconds || 0) >= 30);
    if (isRealPlay) {
      const { error: pcErr } = await db.rpc('increment_track_play_count', {
        p_track_id: resolvedTrackId,
        p_increment: 1,
      });
      if (pcErr) console.error('Error incrementing play_count:', pcErr.message);
    }

    // Invalidate recommendation cache for strong positive or negative signals.
    if (completionPercentage > 70 || wasSkipped || completionPercentage < 50) {
      await invalidateUserRecommendationCache(userId);
    }

    res.status(201).json({
      success: true,
      message: 'Play logged successfully',
      data: data[0]
    });
  } catch (error) {
    console.error('Error logging track play:', error);
    res.status(500).json({ error: 'Failed to log play' });
  }
};

/**
 * Update aggregate listening stats (artist/album/playlist level)
 * Uses atomic RPC upserts to avoid race conditions
 * @private
 */
async function updateAggregateListeningStats(userId, trackId, timeListenedSeconds, listeningContext, contextId) {
  try {
    // Get track details (album_id)
    const { data: trackData, error: trackError } = await db
      .from('tracks')
      .select('album_id')
      .eq('track_id', trackId)
      .single();

    if (trackError) throw trackError;

    // Get artists for this track
    const { data: artistData } = await db
      .from('track_artists')
      .select('artist_id')
      .eq('track_id', trackId);

    // Update album stats via atomic RPC
    if (trackData.album_id) {
      const { error: albumErr } = await db.rpc('upsert_user_album_listening', {
        p_user_id: userId,
        p_album_id: trackData.album_id,
        p_time_seconds: timeListenedSeconds || 0
      });
      if (albumErr) console.error('Error updating album listening stats:', albumErr);
    }

    // Update artist stats via atomic RPC
    if (artistData && artistData.length > 0) {
      for (const artist of artistData) {
        const { error: artistErr } = await db.rpc('upsert_user_artist_listening', {
          p_user_id: userId,
          p_artist_id: artist.artist_id,
          p_time_seconds: timeListenedSeconds || 0
        });
        if (artistErr) console.error('Error updating artist listening stats:', artistErr);
      }
    }

    // Update playlist stats if listening context is playlist
    if (listeningContext === 'playlist' && contextId && isUuid(contextId)) {
      const { error: playlistErr } = await db.rpc('upsert_user_playlist_listening', {
        p_user_id: userId,
        p_playlist_id: contextId,
        p_time_seconds: timeListenedSeconds || 0
      });
      if (playlistErr) console.error('Error updating playlist listening stats:', playlistErr);
    }
  } catch (error) {
    console.error('Error updating aggregate stats:', error);
    // Don't throw - this is secondary operation
  }
}

// ============================================================================
// 2. USER PREFERENCES (LIKES/DISLIKES)
// ============================================================================

/**
 * Set like preference for a track
 * POST /api/listening/track/:trackId/like
 */
exports.likeTrack = async (req, res) => {
  try {
    const { trackId } = req.params;
    const userId = req.user.id;
    const { mood } = req.body;

    const { data, error } = await db
      .from('user_track_preferences')
      .upsert({
        user_id: userId,
        track_id: trackId,
        preference: 1, // Like
        mood: mood || null
      }, {
        onConflict: 'user_id,track_id'
      })
      .select();

    if (error) throw error;

    // Invalidate recommendation cache
    await invalidateUserRecommendationCache(userId);

    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error liking track:', error);
    res.status(500).json({ error: 'Failed to like track' });
  }
};

/**
 * Set dislike preference for a track
 * POST /api/listening/track/:trackId/dislike
 */
exports.dislikeTrack = async (req, res) => {
  try {
    const { trackId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_track_preferences')
      .upsert({
        user_id: userId,
        track_id: trackId,
        preference: -1 // Dislike
      }, {
        onConflict: 'user_id,track_id'
      })
      .select();

    if (error) throw error;

    // Invalidate recommendation cache
    await invalidateUserRecommendationCache(userId);

    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error disliking track:', error);
    res.status(500).json({ error: 'Failed to dislike track' });
  }
};

/**
 * Clear preference for a track
 * DELETE /api/listening/track/:trackId/preference
 */
exports.clearTrackPreference = async (req, res) => {
  try {
    const { trackId } = req.params;
    const userId = req.user.id;

    const { error } = await db
      .from('user_track_preferences')
      .delete()
      .eq('user_id', userId)
      .eq('track_id', trackId);

    if (error) throw error;

    await invalidateUserRecommendationCache(userId);

    res.json({ success: true, message: 'Preference cleared' });
  } catch (error) {
    console.error('Error clearing preference:', error);
    res.status(500).json({ error: 'Failed to clear preference' });
  }
};

/**
 * Get preference for a track
 * GET /api/listening/track/:trackId/preference
 */
exports.getTrackPreference = async (req, res) => {
  try {
    const { trackId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_track_preferences')
      .select('preference')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      success: true,
      track_id: trackId,
      preference: data?.preference ?? 0,
    });
  } catch (error) {
    console.error('Error getting track preference:', error);
    return res.status(500).json({ error: 'Failed to get track preference' });
  }
};

/**
 * Get all liked tracks for the authenticated user with full metadata
 * GET /api/listening/liked-tracks
 */
exports.getLikedTracks = async (req, res) => {
  try {
    const userId = req.user.id;

    // Use supabaseAdmin so RLS doesn't block the query
    const { data: prefs, error } = await db
      .from('user_track_preferences')
      .select('track_id')
      .eq('user_id', userId)
      .eq('preference', 1)
      .order('preferred_at', { ascending: false });

    if (error) throw error;
    if (!prefs || prefs.length === 0) {
      return res.json({ success: true, tracks: [] });
    }

    const trackIds = prefs.map(p => p.track_id).filter(Boolean);
    const { listTracksByIdsUser } = require('../models/trackModel');
    const tracks = await listTracksByIdsUser(trackIds);

    return res.json({ success: true, tracks });
  } catch (error) {
    console.error('Error getting liked tracks:', error);
    return res.status(500).json({ error: 'Failed to get liked tracks' });
  }
};

// ============================================================================
// 3. RECOMMENDATION ENDPOINTS
// ============================================================================

/**
 * Get personalized recommendations for user
 * GET /api/recommendations?limit=50&type=discovery&includeReasons=true
 * 
 * @query {number} limit - Number of recommendations (default: 50)
 * @query {string} type - Type: 'discovery','similar_to_liked','trending','artist_top_tracks','mood_based'
 * @query {boolean} includeReasons - Include reasons for each recommendation
 */
exports.getRecommendations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, type = 'discovery', includeReasons = false, resolve = 'false' } = req.query;
    const shouldResolve = resolve === 'true';

    // Check cache first
    const { data: cached } = await db
      .from('user_recommendations_cache')
      .select('*')
      .eq('user_id', userId)
      .eq('recommendation_type', type)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (cached) {
      console.log(`[CACHE HIT] Serving cached recommendations for user ${userId}`);
      const slicedIds = cached.recommended_track_ids.slice(0, limit);
      if (shouldResolve) {
        const { listTracksByIdsUser } = require('../models/trackModel');
        const tracks = await listTracksByIdsUser(slicedIds);
        return res.json({
          success: true,
          from_cache: true,
          recommendation_type: type,
          tracks: tracks,
          reasons: includeReasons ? cached.reasons : undefined
        });
      }
      return res.json({
        success: true,
        from_cache: true,
        recommendation_type: type,
        track_ids: slicedIds,
        reasons: includeReasons ? cached.reasons : undefined
      });
    }

    // Cache miss - generate fresh recommendations
    console.log(`[CACHE MISS] Computing recommendations for user ${userId}`);
    let trackIds = [];

    switch (type) {
      case 'similar_to_liked':
        trackIds = await getContentBasedRecommendations(userId, limit);
        break;
      case 'discovery':
        trackIds = await getDiscoveryRecommendations(userId, limit);
        break;
      case 'trending':
        trackIds = await getTrendingRecommendations(userId, limit);
        break;
      case 'mood_based':
        trackIds = await getMoodBasedRecommendations(userId, limit);
        break;
      default:
        trackIds = await getDiscoveryRecommendations(userId, limit);
    }

    // Inject randomness per user preferences
    trackIds = await injectRandomness(userId, trackIds);

    // Cache the recommendations
    await cacheRecommendations(userId, type, trackIds, type);

    const slicedIds = trackIds.slice(0, limit);
    if (shouldResolve) {
      const { listTracksByIdsUser } = require('../models/trackModel');
      const tracks = await listTracksByIdsUser(slicedIds);
      return res.json({
        success: true,
        from_cache: false,
        recommendation_type: type,
        tracks: tracks,
        cached_until: new Date(Date.now() + 6 * 60 * 60 * 1000)
      });
    }

    res.json({
      success: true,
      from_cache: false,
      recommendation_type: type,
      track_ids: slicedIds,
      cached_until: new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 hours
    });
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
};

/**
 * Content-based: Find tracks similar to what user likes
 * @private
 */
async function getContentBasedRecommendations(userId, limit) {
  const { data: likedTracks } = await db
    .from('user_track_preferences')
    .select('track_id')
    .eq('user_id', userId)
    .eq('preference', 1)
    .limit(20); // Use top 20 liked tracks as seed

  if (!likedTracks || likedTracks.length === 0) {
    return [];
  }

  const trackIds = likedTracks.map(t => t.track_id);

  // Get similar tracks from content features
  const { data: similarTracks } = await db
    .from('track_content_features')
    .select('similar_track_ids')
    .in('track_id', trackIds)
    .limit(100);

  if (!similarTracks) return [];

  // Flatten and deduplicate
  const allSimilar = new Set();
  for (const row of similarTracks) {
    if (row.similar_track_ids) {
      row.similar_track_ids.forEach(id => allSimilar.add(id));
    }
  }

  // Remove already liked tracks
  trackIds.forEach(id => allSimilar.delete(id));

  return Array.from(allSimilar).slice(0, limit);
}

/**
 * Discovery: Recommend based on user's genre affinity
 * @private
 */
async function getDiscoveryRecommendations(userId, limit) {
  const { data: affinity } = await db
    .rpc('get_user_genre_affinity_profile', { user_id_param: userId });

  if (!affinity || affinity.length === 0) {
    // Cold start: use onboarding genres
    return getColdStartRecommendations(userId, limit);
  }

  // Get top genres
  const topGenres = affinity
    .filter(a => a.affinity_score > 0.3)
    .slice(0, 5)
    .map(a => a.genre);

  // Find tracks in those genres that user hasn't heard.
  // overlaps() = share ANY of the top genres (contains() would require ALL,
  // which matched almost nothing and starved discovery).
  const { data: recommendedTracks } = await db
    .from('track_content_features')
    .select('track_id')
    .overlaps('genres', topGenres)
    .limit(limit * 2); // Get more, will filter

  if (!recommendedTracks) return [];

  // Filter out already listened
  const listened = await db
    .from('user_track_listening_history')
    .select('track_id')
    .eq('user_id', userId);

  const listenedIds = new Set(listened.data?.map(t => t.track_id) || []);

  return recommendedTracks
    .filter(t => !listenedIds.has(t.track_id))
    .map(t => t.track_id)
    .slice(0, limit);
}

/**
 * Trending in user's taste
 * @private
 */
async function getTrendingRecommendations(userId, limit) {
  // What's trending in genres user likes?
  const { data } = await db
    .rpc('get_trending_in_user_genres', {
      user_id_param: userId,
      days: 7,
      min_affinity: 0.4
    });

  return (data || []).slice(0, limit).map(t => t.track_id);
}

/**
 * Mood-based recommendations
 * @private
 */
async function getMoodBasedRecommendations(userId, limit) {
  const { data: moodAffinity } = await db
    .from('user_mood_affinity')
    .select('mood')
    .eq('user_id', userId)
    .gt('affinity_score', 0.3)
    .limit(3);

  if (!moodAffinity || moodAffinity.length === 0) return [];

  const moods = moodAffinity.map(m => m.mood);

  const { data: tracks } = await db
    .from('track_content_features')
    .select('track_id')
    .overlaps('mood', moods)
    .limit(limit);

  return tracks?.map(t => t.track_id) || [];
}

/**
 * Cold start recommendations (new user)
 * @private
 */
async function getColdStartRecommendations(userId, limit) {
  // Use onboarding preferences
  const { data: prefs } = await db
    .from('user_onboarding_preferences')
    .select('favorite_genres, favorite_moods')
    .eq('user_id', userId)
    .single();

  if (!prefs) return [];

  const genres = prefs.favorite_genres || [];
  const moods = prefs.favorite_moods || [];

  // Match any onboarding genre OR mood (overlaps = array intersection).
  let query = db.from('track_content_features').select('track_id');
  if (genres.length && moods.length) {
    query = query.or(`genres.ov.{${genres.join(',')}},mood.ov.{${moods.join(',')}}`);
  } else if (genres.length) {
    query = query.overlaps('genres', genres);
  } else if (moods.length) {
    query = query.overlaps('mood', moods);
  } else {
    return [];
  }

  const { data: tracks } = await query.limit(limit);

  return tracks?.map(t => t.track_id) || [];
}

/**
 * Inject randomness into recommendations per user preference
 * @private
 */
async function injectRandomness(userId, trackIds) {
  const { data: prefs } = await db
    .from('user_onboarding_preferences')
    .select('randomness_percentage')
    .eq('user_id', userId)
    .single();

  const randomPercent = prefs?.randomness_percentage || 0.15;
  const randomCount = Math.floor(trackIds.length * randomPercent);

  if (randomCount === 0) return trackIds;

  // Get random tracks
  const { data: randomTracks } = await db
    .from('tracks')
    .select('track_id')
    .order('created_at', { ascending: false })
    .limit(randomCount * 3) // Get more to filter
    .range(0, randomCount * 3 - 1);

  if (!randomTracks) return trackIds;

  // Replace last N items with random
  const result = trackIds.slice(0, -randomCount);
  const currentSet = new Set(result);

  for (const track of randomTracks) {
    if (!currentSet.has(track.track_id)) {
      result.push(track.track_id);
      if (result.length >= trackIds.length) break;
    }
  }

  return result;
}

// ============================================================================
// 4. AFFINITY CALCULATION & MAINTENANCE
// ============================================================================

/**
 * Recalculate user's genre affinity (call daily or on preference change)
 * USAGE: app.post('/api/admin/calculate-affinity/:userId', exports.calculateGenreAffinity)
 * 
 * @private
 */
/**
 * Core: recompute a user's genre affinity from listening history + preferences.
 * Reusable by both the admin endpoint and the background scheduler.
 * @param {string} userId
 * @returns {Promise<number>} number of genres scored
 */
async function recomputeGenreAffinity(userId) {
  if (!isUuid(userId)) return 0;

  // Get all genres user has listened to (with engagement stats)
  const { data: listeningData, error: statsErr } = await db
    .rpc('get_user_genres_with_stats', { user_id_param: userId });

  if (statsErr) {
    console.error(`[AFFINITY] get_user_genres_with_stats failed for ${userId}:`, statsErr.message);
    return 0;
  }
  if (!listeningData || listeningData.length === 0) return 0;

  // Build the new affinity rows.
  const rows = listeningData.map((genre) => {
    const likes = Number(genre.likes) || 0;
    const dislikes = Number(genre.dislikes) || 0;
    const avgCompletion = Number(genre.avg_completion_percentage) || 0;
    const trackCount = Number(genre.track_count) || 0;

    let affinityScore =
      ((likes - dislikes) / (likes + dislikes + 1)) * 0.6 +
      ((avgCompletion - 50) / 100) * 0.3 +
      Math.min(trackCount / 50, 1) * 0.1;

    // Clamp to the column range (-1.0 .. 1.0)
    affinityScore = Math.max(-1, Math.min(1, affinityScore));

    return {
      user_id: userId,
      genre: genre.genre,
      affinity_score: Number(affinityScore.toFixed(2)),
      track_count: trackCount,
      total_listen_time_seconds: Number(genre.total_listen_time_seconds) || 0,
    };
  });

  // Replace existing affinity for this user atomically-ish:
  // delete then upsert in one batch (cheaper than per-row inserts).
  await db.from('user_genre_affinity').delete().eq('user_id', userId);
  const { error: upErr } = await db
    .from('user_genre_affinity')
    .upsert(rows, { onConflict: 'user_id,genre' });
  if (upErr) {
    console.error(`[AFFINITY] upsert failed for ${userId}:`, upErr.message);
    return 0;
  }

  // Invalidate cached recommendations so the fresh profile is used.
  await invalidateUserRecommendationCache(userId);

  return rows.length;
}
exports.recomputeGenreAffinity = recomputeGenreAffinity;

exports.calculateGenreAffinity = async (req, res) => {
  try {
    const { userId } = req.params;
    const count = await recomputeGenreAffinity(userId);
    res.json({
      success: true,
      message: `Calculated affinity for ${count} genres`,
      count,
    });
  } catch (error) {
    console.error('Error calculating affinity:', error);
    res.status(500).json({ error: 'Failed to calculate affinity' });
  }
};

// ============================================================================
// 5. CACHE MANAGEMENT
// ============================================================================

/**
 * Cache recommendations
 * @private
 */
const RECOMMENDATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function cacheRecommendations(userId, type, trackIds, reasons = []) {
  const expiresAt = new Date(Date.now() + RECOMMENDATION_CACHE_TTL_MS);

  await db
    .from('user_recommendations_cache')
    .upsert({
      user_id: userId,
      recommendation_type: type,
      recommended_track_ids: trackIds,
      reasons: reasons,
      expires_at: expiresAt
    }, {
      onConflict: 'user_id,recommendation_type'
    });
}

/**
 * Invalidate recommendation cache for user
 * @private
 */
async function invalidateUserRecommendationCache(userId) {
  await db
    .from('user_recommendations_cache')
    .delete()
    .eq('user_id', userId);
}

/**
 * Admin endpoint: Clear all expired caches
 * GET /api/admin/cache/cleanup
 */
exports.cleanupExpiredCaches = async (req, res) => {
  try {
    const { error } = await db
      .from('user_recommendations_cache')
      .delete()
      .lt('expires_at', new Date().toISOString());

    if (error) throw error;

    res.json({ success: true, message: 'Cleanup completed' });
  } catch (error) {
    console.error('Cache cleanup error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
};

// ============================================================================
// 6. ALBUM & PLAYLIST LIKES
// ============================================================================

/**
 * Like an album
 * POST /api/listening/album/:albumId/like
 */
exports.likeAlbum = async (req, res) => {
  try {
    const { albumId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_album_preferences')
      .upsert({
        user_id: userId,
        album_id: albumId,
        preference: 1
      }, { onConflict: 'user_id,album_id' })
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error liking album:', error);
    res.status(500).json({ error: 'Failed to like album' });
  }
};

/**
 * Dislike an album
 * POST /api/listening/album/:albumId/dislike
 */
exports.dislikeAlbum = async (req, res) => {
  try {
    const { albumId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_album_preferences')
      .upsert({
        user_id: userId,
        album_id: albumId,
        preference: -1
      }, { onConflict: 'user_id,album_id' })
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error disliking album:', error);
    res.status(500).json({ error: 'Failed to dislike album' });
  }
};

/**
 * Clear album preference
 * DELETE /api/listening/album/:albumId/preference
 */
exports.clearAlbumPreference = async (req, res) => {
  try {
    const { albumId } = req.params;
    const userId = req.user.id;

    const { error } = await db
      .from('user_album_preferences')
      .delete()
      .eq('user_id', userId)
      .eq('album_id', albumId);

    if (error) throw error;
    res.json({ success: true, message: 'Album preference cleared' });
  } catch (error) {
    console.error('Error clearing album preference:', error);
    res.status(500).json({ error: 'Failed to clear album preference' });
  }
};

/**
 * Get album preference
 * GET /api/listening/album/:albumId/preference
 */
exports.getAlbumPreference = async (req, res) => {
  try {
    const { albumId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_album_preferences')
      .select('preference')
      .eq('user_id', userId)
      .eq('album_id', albumId)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      success: true,
      album_id: albumId,
      preference: data?.preference ?? 0,
    });
  } catch (error) {
    console.error('Error getting album preference:', error);
    return res.status(500).json({ error: 'Failed to get album preference' });
  }
};

/**
 * Like a playlist
 * POST /api/listening/playlist/:playlistId/like
 */
exports.likePlaylist = async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_playlist_preferences')
      .upsert({
        user_id: userId,
        playlist_id: playlistId,
        preference: 1
      }, { onConflict: 'user_id,playlist_id' })
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error liking playlist:', error);
    res.status(500).json({ error: 'Failed to like playlist' });
  }
};

/**
 * Dislike a playlist
 * POST /api/listening/playlist/:playlistId/dislike
 */
exports.dislikePlaylist = async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_playlist_preferences')
      .upsert({
        user_id: userId,
        playlist_id: playlistId,
        preference: -1
      }, { onConflict: 'user_id,playlist_id' })
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Error disliking playlist:', error);
    res.status(500).json({ error: 'Failed to dislike playlist' });
  }
};

/**
 * Clear playlist preference
 * DELETE /api/listening/playlist/:playlistId/preference
 */
exports.clearPlaylistPreference = async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const { error } = await db
      .from('user_playlist_preferences')
      .delete()
      .eq('user_id', userId)
      .eq('playlist_id', playlistId);

    if (error) throw error;
    res.json({ success: true, message: 'Playlist preference cleared' });
  } catch (error) {
    console.error('Error clearing playlist preference:', error);
    res.status(500).json({ error: 'Failed to clear playlist preference' });
  }
};

/**
 * Get playlist preference
 * GET /api/listening/playlist/:playlistId/preference
 */
exports.getPlaylistPreference = async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const { data, error } = await db
      .from('user_playlist_preferences')
      .select('preference')
      .eq('user_id', userId)
      .eq('playlist_id', playlistId)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      success: true,
      playlist_id: playlistId,
      preference: data?.preference ?? 0,
    });
  } catch (error) {
    console.error('Error getting playlist preference:', error);
    return res.status(500).json({ error: 'Failed to get playlist preference' });
  }
};

module.exports = exports;
