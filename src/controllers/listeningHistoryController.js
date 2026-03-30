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

const { supabase } = require('../db/config');

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
    const { data: mapped } = await supabase
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
    const { data, error } = await supabase
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

    // Update artist/album listening history (aggregate)
    await updateAggregateListeningStats(userId, resolvedTrackId, timeListenedSeconds);

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
 * Update aggregate listening stats (artist/album level)
 * @private
 */
async function updateAggregateListeningStats(userId, trackId, timeListenedSeconds) {
  try {
    // Get track details (artist_id, album_id)
    const { data: trackData, error: trackError } = await supabase
      .from('tracks')
      .select('album_id')
      .eq('track_id', trackId)
      .single();

    if (trackError) throw trackError;

    // Get artists for this track
    const { data: artistData } = await supabase
      .from('track_artists')
      .select('artist_id')
      .eq('track_id', trackId);

    // Update album stats
    if (trackData.album_id) {
      await supabase
        .from('user_album_listening_history')
        .upsert({
          user_id: userId,
          album_id: trackData.album_id,
          play_count: 1,
          total_time_listened_seconds: timeListenedSeconds,
          unique_tracks_played: 1,
          last_played_at: new Date()
        }, {
          onConflict: 'user_id,album_id'
        })
        .then(({ data, error }) => {
          if (error) throw error;
          // Increment existing record
          return supabase
            .from('user_album_listening_history')
            .update({
              play_count: supabase.rpc('increment', { x: 1 }),
              total_time_listened_seconds: supabase.rpc('add_time', { seconds: timeListenedSeconds }),
              last_played_at: new Date()
            })
            .eq('user_id', userId)
            .eq('album_id', trackData.album_id);
        });
    }

    // Update artist stats
    if (artistData && artistData.length > 0) {
      for (const artist of artistData) {
        await supabase
          .from('user_artist_listening_history')
          .upsert({
            user_id: userId,
            artist_id: artist.artist_id,
            play_count: 1,
            total_time_listened_seconds: timeListenedSeconds,
            unique_tracks_played: 1,
            last_played_at: new Date()
          }, {
            onConflict: 'user_id,artist_id'
          });
      }
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

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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

    const { error } = await supabase
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
    const { limit = 50, type = 'discovery', includeReasons = false } = req.query;

    // Check cache first
    const { data: cached } = await supabase
      .from('user_recommendations_cache')
      .select('*')
      .eq('user_id', userId)
      .eq('recommendation_type', type)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (cached) {
      console.log(`[CACHE HIT] Serving cached recommendations for user ${userId}`);
      return res.json({
        success: true,
        from_cache: true,
        recommendation_type: type,
        track_ids: cached.recommended_track_ids.slice(0, limit),
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

    res.json({
      success: true,
      from_cache: false,
      recommendation_type: type,
      track_ids: trackIds.slice(0, limit),
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
  const { data: likedTracks } = await supabase
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
  const { data: similarTracks } = await supabase
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
  const { data: affinity } = await supabase
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

  // Find tracks in those genres that user hasn't heard
  const { data: recommendedTracks } = await supabase
    .from('track_content_features')
    .select('track_id')
    .contains('genres', topGenres)
    .limit(limit * 2); // Get more, will filter

  if (!recommendedTracks) return [];

  // Filter out already listened
  const listened = await supabase
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
  const { data } = await supabase
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
  const { data: moodAffinity } = await supabase
    .from('user_mood_affinity')
    .select('mood')
    .eq('user_id', userId)
    .gt('affinity_score', 0.3)
    .limit(3);

  if (!moodAffinity || moodAffinity.length === 0) return [];

  const moods = moodAffinity.map(m => m.mood);

  const { data: tracks } = await supabase
    .from('track_content_features')
    .select('track_id')
    .contains('mood', moods)
    .limit(limit);

  return tracks?.map(t => t.track_id) || [];
}

/**
 * Cold start recommendations (new user)
 * @private
 */
async function getColdStartRecommendations(userId, limit) {
  // Use onboarding preferences
  const { data: prefs } = await supabase
    .from('user_onboarding_preferences')
    .select('favorite_genres, favorite_moods')
    .eq('user_id', userId)
    .single();

  if (!prefs) return [];

  const genres = prefs.favorite_genres || [];
  const moods = prefs.favorite_moods || [];

  const { data: tracks } = await supabase
    .from('track_content_features')
    .select('track_id')
    .or(`genres.contains.${genres},mood.contains.${moods}`)
    .limit(limit);

  return tracks?.map(t => t.track_id) || [];
}

/**
 * Inject randomness into recommendations per user preference
 * @private
 */
async function injectRandomness(userId, trackIds) {
  const { data: prefs } = await supabase
    .from('user_onboarding_preferences')
    .select('randomness_percentage')
    .eq('user_id', userId)
    .single();

  const randomPercent = prefs?.randomness_percentage || 0.15;
  const randomCount = Math.floor(trackIds.length * randomPercent);

  if (randomCount === 0) return trackIds;

  // Get random tracks
  const { data: randomTracks } = await supabase
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
exports.calculateGenreAffinity = async (req, res) => {
  try {
    const { userId } = req.params;

    // Clear existing
    await supabase
      .from('user_genre_affinity')
      .delete()
      .eq('user_id', userId);

    // Get all genres user has listened to
    const { data: listeningData } = await supabase
      .rpc('get_user_genres_with_stats', { user_id_param: userId });

    if (!listeningData) {
      return res.json({ success: true, count: 0 });
    }

    // Calculate affinity for each genre
    for (const genre of listeningData) {
      const affinityScore =
        ((genre.likes - genre.dislikes) / (genre.likes + genre.dislikes + 1)) * 0.6 +
        ((genre.avg_completion_percentage - 50) / 100) * 0.3 +
        Math.min(genre.track_count / 50, 1) * 0.1;

      await supabase
        .from('user_genre_affinity')
        .insert({
          user_id: userId,
          genre: genre.genre,
          affinity_score: affinityScore,
          track_count: genre.track_count,
          total_listen_time_seconds: genre.total_listen_time_seconds
        });
    }

    res.json({
      success: true,
      message: `Calculated affinity for ${listeningData.length} genres`,
      count: listeningData.length
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
async function cacheRecommendations(userId, type, trackIds, reasons = []) {
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours

  await supabase
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
  await supabase
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
    const { error } = await supabase
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

module.exports = exports;
