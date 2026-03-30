/**
 * Enhanced Queue Controller with Smart Recommendations & Preference Management
 * 
 * Features:
 * - Smart auto-fill based on user preferences
 * - Recommendation-guided queue population
 * - User preference persistence
 * - Priority track management
 */

const createError = require('http-errors');
const { getRedisClient } = require('../../utils/redisClient');
const { supabase } = require('../../db/config');
const listeningHistoryController = require('../listeningHistoryController');

// Queue key patterns
const queueKey = (userId) => `user:queue:${userId}`;
const queuePrefsKey = (userId) => `user:queue:prefs:${userId}`;
const queueMetaKey = (trackId) => `track:meta:${trackId}`;

const DEFAULT_MIN_QUEUE_SIZE = Math.max(
  1,
  Number(process.env.QUEUE_MIN_SIZE || 30),
);

const DEFAULT_QUEUE_PREFS = {
  minQueueSize: DEFAULT_MIN_QUEUE_SIZE,
  smartFillThreshold: 10,
  preferredRecommendationType: 'discovery',
  allowRepeatTracks: false,
  prioritizeNewReleases: true,
  prioritizeLikedTracks: true,
  respectUserLanguagePreference: true,
  respectUserMoodPreference: true,
};

// ============================================================================
// QUEUE PREFERENCES MANAGEMENT
// ============================================================================

/**
 * Get user's queue preferences
 * GET /api/user/queue/preferences
 */
exports.getQueuePreferences = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const client = await getRedisClient();
    const prefs = await client.get(queuePrefsKey(userId));

    if (!prefs) {
      return res.json({ ...DEFAULT_QUEUE_PREFS, userId });
    }

    res.json(JSON.parse(prefs));
  } catch (error) {
    console.error('Error getting queue preferences:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
};

/**
 * Save user's queue preferences
 * POST /api/user/queue/preferences
 * 
 * @body {object} preferences
 */
exports.saveQueuePreferences = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const preferences = {
      ...DEFAULT_QUEUE_PREFS,
      ...req.body,
      userId, // Enforce user ID
    };

    const client = await getRedisClient();
    await client.set(
      queuePrefsKey(userId),
      JSON.stringify(preferences),
      { EX: 30 * 24 * 60 * 60 }, // 30 days
    );

    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving queue preferences:', error);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
};

// ============================================================================
// SMART QUEUE FILLING
// ============================================================================

/**
 * Smart fill queue with recommendations
 * POST /api/user/queue/smart-fill
 * 
 * @body {object} options
 *   @param {string} [type] - recommendation type ('discovery', 'similar_to_liked', 'trending', 'mood_based')
 *   @param {number} [limit] - how many tracks to add
 */
exports.smartFillQueue = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const { type = 'discovery', limit = 20, forceFill = false } = req.body || {};
    const client = await getRedisClient();

    // Get current queue
    const queueId = queueKey(userId);
    const currentQueue = await client.lRange(queueId, 0, -1);

    // Get user preferences
    const prefsData = await client.get(queuePrefsKey(userId));
    const prefs = prefsData ? JSON.parse(prefsData) : DEFAULT_QUEUE_PREFS;

    // If queue is healthy, don't fill
    if (!forceFill && currentQueue.length >= prefs.minQueueSize) {
      return res.json({
        success: true,
        message: 'Queue is already full',
        queueSize: currentQueue.length,
      });
    }

    // Get recommendations via database
    try {
      const { data: recommendationData } = await supabase
        .from('user_recommendations_cache')
        .select('recommended_track_ids')
        .eq('user_id', userId)
        .eq('recommendation_type', type)
        .gt('expires_at', new Date().toISOString())
        .single();

      let trackIds = [];

      if (recommendationData?.recommended_track_ids) {
        trackIds = recommendationData.recommended_track_ids;
      } else {
        // Cache miss - fallback to discovery
        console.log(`[QUEUE] Cache miss for ${type}, using discovery fallback`);
        trackIds = await getDiscoveryRecommendations(userId);
      }

      if (!trackIds.length) {
        return res.json({
          success: true,
          message: 'No recommendations available',
          queueSize: currentQueue.length,
        });
      }

      // Filter out already-queued tracks and liked dislikes
      const queueSet = new Set(currentQueue);
      const { data: disliked } = await supabase
        .from('user_track_preferences')
        .select('track_id')
        .eq('user_id', userId)
        .eq('preference', -1);

      const dislikedSet = new Set(disliked?.map(d => d.track_id) || []);

      const maxToAdd = forceFill
        ? Math.max(1, Number(limit) || 20)
        : Math.max(0, prefs.minQueueSize - currentQueue.length);

      let toAdd = trackIds
        .filter(id => !queueSet.has(id) && !dislikedSet.has(id))
        .slice(0, maxToAdd);

      if (!toAdd.length) {
        return res.json({
          success: true,
          message: 'All recommendations already in queue',
          queueSize: currentQueue.length,
        });
      }

      // Add to queue
      await client.rPush(queueId, toAdd);

      const newQueue = await client.lRange(queueId, 0, -1);

      res.json({
        success: true,
        message: `Added ${toAdd.length} tracks to queue`,
        added: toAdd.length,
        queueSize: newQueue.length,
      });
    } catch (dbError) {
      console.error('Error fetching recommendations:', dbError);
      res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
  } catch (error) {
    console.error('Error in smart fill:', error);
    res.status(500).json({ error: 'Failed to smart fill queue' });
  }
};

/**
 * Fallback: Get discovery recommendations
 * @private
 */
async function getDiscoveryRecommendations(userId) {
  // Query user's favorite genres from onboarding
  const { data: prefs } = await supabase
    .from('user_onboarding_preferences')
    .select('favorite_genres')
    .eq('user_id', userId)
    .single();

  if (!prefs?.favorite_genres?.length) {
    // No preferences, get popular tracks
    const { data: popular } = await supabase
      .from('tracks')
      .select('track_id')
      .eq('is_published', true)
      .order('popularity_score', { ascending: false })
      .limit(50);

    return popular?.map(t => t.track_id) || [];
  }

  // Get tracks in user's favorite genres
  const { data: tracks } = await supabase
    .from('track_content_features')
    .select('track_id')
    .contains('genres', prefs.favorite_genres)
    .order('popularity_score', { ascending: false })
    .limit(50);

  return tracks?.map(t => t.track_id) || [];
}

// ============================================================================
// PRIORITY TRACK MANAGEMENT
// ============================================================================

/**
 * Add track to priority queue (moves near front)
 * POST /api/user/queue/prioritize
 * 
 * @body {object}
 *   @param {string} track_id - Track to prioritize
 *   @param {number} [position] - Position to move to (default: 1)
 */
exports.prioritizeTrack = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const { track_id, position = 1 } = req.body || {};
    if (!track_id) throw createError(400, 'track_id is required');

    const client = await getRedisClient();
    const key = queueKey(userId);
    const queue = await client.lRange(key, 0, -1);

    // Find current position
    const currentIdx = queue.indexOf(String(track_id));
    if (currentIdx === -1) {
      throw createError(404, 'Track not in queue');
    }

    // Remove and reinsert at position
    if (currentIdx !== position) {
      const [removed] = queue.splice(currentIdx, 1);
      queue.splice(position, 0, removed);

      await client.del(key);
      if (queue.length) await client.rPush(key, queue);
    }

    res.json({ success: true, queue });
  } catch (error) {
    console.error('Error prioritizing track:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to prioritize' });
  }
};

// ============================================================================
// BATCH QUEUE OPERATIONS
// ============================================================================

/**
 * Bulk add tracks to queue
 * POST /api/user/queue/bulk-add
 * 
 * @body {object}
 *   @param {string[]} track_ids - Array of track IDs
 *   @param {number} [position] - Insert position
 */
exports.bulkAddToQueue = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const { track_ids, position } = req.body || {};
    if (!Array.isArray(track_ids) || !track_ids.length) {
      throw createError(400, 'track_ids array required');
    }

    const client = await getRedisClient();
    const key = queueKey(userId);

    if (position === undefined) {
      // Append
      await client.rPush(key, track_ids.map(String));
    } else {
      // Insert at position
      const queue = await client.lRange(key, 0, -1);
      track_ids.reverse().forEach((id, idx) => {
        queue.splice(position + idx, 0, String(id));
      });

      await client.del(key);
      if (queue.length) await client.rPush(key, queue);
    }

    const newLen = await client.lLen(key);
    res.status(201).json({
      success: true,
      added: track_ids.length,
      total: newLen,
    });
  } catch (error) {
    console.error('Error in bulk add:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Bulk add failed' });
  }
};

/**
 * Get queue analytics
 * GET /api/user/queue/analytics
 * 
 * Returns: queue health, recommendation coverage, user preferences impact
 */
exports.getQueueAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw createError(401, 'Unauthorized');

    const client = await getRedisClient();
    const queue = await client.lRange(queueKey(userId), 0, -1);
    const prefs = await client.get(queuePrefsKey(userId));
    const preferences = prefs ? JSON.parse(prefs) : DEFAULT_QUEUE_PREFS;

    // Get recommendation coverage (how many tracks from recommendations)
    const { data: recentPlays } = await supabase
      .from('user_track_listening_history')
      .select('track_id, listening_context')
      .eq('user_id', userId)
      .order('played_at', { ascending: false })
      .limit(100);

    const recommendationTracks = recentPlays
      ?.filter(p => p.listening_context === 'recommendation')
      .map(p => p.track_id) || [];

    const recommendationCoverage = recommendationTracks.length / (recentPlays?.length || 1);

    res.json({
      queueSize: queue.length,
      isHealthy: queue.length >= preferences.minQueueSize,
      preferences,
      analytics: {
        totalQueueSize: queue.length,
        recommendationCoverage: (recommendationCoverage * 100).toFixed(2) + '%',
        needsSmartFill: queue.length < preferences.smartFillThreshold,
        estimatedPlaytime: (queue.length * 3.5).toFixed(1) + ' minutes', // avg ~3.5 min per track
      },
    });
  } catch (error) {
    console.error('Error getting analytics:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
};

module.exports = exports;
