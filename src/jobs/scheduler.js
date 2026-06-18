/**
 * Background scheduler for the recommendation engine.
 *
 * Dependency-free (setInterval based). Started from src/index.js and gated by
 * the ENABLE_SCHEDULER env var so it can be disabled per-instance (e.g. when
 * running multiple API replicas, enable it on exactly one).
 *
 * Jobs:
 *   - refreshActiveUserAffinity : recompute genre affinity for recently-active
 *                                 users so recommendations track today's taste.
 *   - refreshSimilarTracks      : populate track_content_features.similar_track_ids
 *                                 (powers "similar to liked" + auto-next).
 *   - cleanupExpiredCache       : drop stale recommendation cache rows.
 */
const { supabase, supabaseAdmin } = require('../db/config');
const { recomputeGenreAffinity } = require('../controllers/listeningHistoryController');

const db = supabaseAdmin || supabase;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Intervals (overridable via env, in minutes).
const AFFINITY_INTERVAL_MS = Math.max(5, Number(process.env.AFFINITY_REFRESH_MINUTES || 60)) * MIN;
const SIMILAR_INTERVAL_MS = Math.max(30, Number(process.env.SIMILAR_REFRESH_MINUTES || 360)) * MIN;
const CACHE_CLEANUP_INTERVAL_MS = Math.max(15, Number(process.env.CACHE_CLEANUP_MINUTES || 60)) * MIN;

// Simple per-job locks so a slow run never overlaps the next tick.
const running = { affinity: false, similar: false, cleanup: false };
const timers = [];

/**
 * Recompute genre affinity for users who listened in the last `lookbackHours`.
 */
async function refreshActiveUserAffinity(lookbackHours = 24) {
  if (running.affinity) return;
  running.affinity = true;
  try {
    const since = new Date(Date.now() - lookbackHours * HOUR).toISOString();
    const { data, error } = await db
      .from('user_track_listening_history')
      .select('user_id')
      .gt('played_at', since)
      .limit(5000);
    if (error) throw error;

    const userIds = Array.from(new Set((data || []).map(r => r.user_id).filter(Boolean)));
    if (!userIds.length) return;

    let ok = 0;
    for (const userId of userIds) {
      try {
        await recomputeGenreAffinity(userId);
        ok += 1;
      } catch (e) {
        console.error(`[SCHEDULER] affinity failed for ${userId}:`, e?.message || e);
      }
    }
    console.log(`[SCHEDULER] affinity refreshed for ${ok}/${userIds.length} active users`);
  } catch (e) {
    console.error('[SCHEDULER] refreshActiveUserAffinity error:', e?.message || e);
  } finally {
    running.affinity = false;
  }
}

/**
 * Recompute the similar-tracks graph used for content-based recs + auto-next.
 */
async function refreshSimilarTracks() {
  if (running.similar) return;
  running.similar = true;
  try {
    const { data, error } = await db.rpc('refresh_similar_tracks', { p_limit: 20 });
    if (error) throw error;
    console.log(`[SCHEDULER] refresh_similar_tracks updated ${data ?? '?'} tracks`);
  } catch (e) {
    console.error('[SCHEDULER] refreshSimilarTracks error (is migration 005 applied?):', e?.message || e);
  } finally {
    running.similar = false;
  }
}

/**
 * Delete expired recommendation cache rows.
 */
async function cleanupExpiredCache() {
  if (running.cleanup) return;
  running.cleanup = true;
  try {
    const { error } = await db
      .from('user_recommendations_cache')
      .delete()
      .lt('expires_at', new Date().toISOString());
    if (error) throw error;
  } catch (e) {
    console.error('[SCHEDULER] cleanupExpiredCache error:', e?.message || e);
  } finally {
    running.cleanup = false;
  }
}

/**
 * Start all background jobs. Safe to call once at boot.
 */
function startScheduler() {
  if (process.env.ENABLE_SCHEDULER === 'false') {
    console.log('[SCHEDULER] disabled via ENABLE_SCHEDULER=false');
    return;
  }

  console.log('[SCHEDULER] starting background recommendation jobs');

  // Kick off an initial similarity build shortly after boot (offset so it does
  // not compete with startup), then on a long interval.
  setTimeout(() => { refreshSimilarTracks(); }, 30 * 1000);

  timers.push(setInterval(refreshActiveUserAffinity, AFFINITY_INTERVAL_MS));
  timers.push(setInterval(refreshSimilarTracks, SIMILAR_INTERVAL_MS));
  timers.push(setInterval(cleanupExpiredCache, CACHE_CLEANUP_INTERVAL_MS));

  // Don't keep the event loop alive solely for these timers.
  timers.forEach(t => typeof t.unref === 'function' && t.unref());
}

function stopScheduler() {
  while (timers.length) clearInterval(timers.pop());
}

module.exports = {
  startScheduler,
  stopScheduler,
  refreshActiveUserAffinity,
  refreshSimilarTracks,
  cleanupExpiredCache,
};
