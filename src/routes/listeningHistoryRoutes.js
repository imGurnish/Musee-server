/**
 * Listening History & Recommendations Routes
 * 
 * - POST /api/listening/log-play - Log a track play
 * - POST /api/listening/track/:trackId/like - Like a track
 * - POST /api/listening/track/:trackId/dislike - Dislike a track
 * - DELETE /api/listening/track/:trackId/preference - Clear preference
 * - GET /api/recommendations - Get personalized recommendations
 * - POST /api/admin/calculate-affinity/:userId - Recalculate affinity
 * - GET /api/admin/cache/cleanup - Clean expired caches
 */

const express = require('express');
const router = express.Router();
const listeningController = require('../controllers/listeningHistoryController');
const authUser = require('../middleware/authUser');
const authAdmin = require('../middleware/authAdmin');

// ============================================================================
// PUBLIC ROUTES (Authenticated Users)
// ============================================================================

/**
 * Log a track play
 * POST /api/listening/log-play
 */
router.post('/listening/log-play', authUser, listeningController.logTrackPlay);

/**
 * Like a track
 * POST /api/listening/track/:trackId/like
 */
router.post('/listening/track/:trackId/like', authUser, listeningController.likeTrack);

/**
 * Dislike a track
 * POST /api/listening/track/:trackId/dislike
 */
router.post('/listening/track/:trackId/dislike', authUser, listeningController.dislikeTrack);

/**
 * Clear preference for a track
 * DELETE /api/listening/track/:trackId/preference
 */
router.delete('/listening/track/:trackId/preference', authUser, listeningController.clearTrackPreference);

/**
 * Get personalized recommendations
 * GET /api/recommendations?limit=50&type=discovery&includeReasons=true
 */
router.get('/recommendations', authUser, listeningController.getRecommendations);
router.get('/listening/recommendations', authUser, listeningController.getRecommendations);

// ============================================================================
// ADMIN ROUTES
// ============================================================================

/**
 * Calculate/recalculate user's genre affinity
 * POST /api/admin/listening/calculate-affinity/:userId
 */
router.post('/admin/listening/calculate-affinity/:userId', authAdmin, listeningController.calculateGenreAffinity);

/**
 * Clean up expired recommendation caches
 * GET /api/admin/cache/cleanup
 */
router.get('/admin/cache/cleanup', authAdmin, listeningController.cleanupExpiredCaches);

module.exports = router;
