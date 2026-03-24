/**
 * Enhanced Queue Routes
 * 
 * Smart queue management with recommendations and preference-based filling
 */

const express = require('express');
const router = express.Router();
const enhancedQueueCtrl = require('../../controllers/user/enhancedQueueController');
const { authenticateToken } = require('../../middleware/authMiddleware');

// ============================================================================
// QUEUE PREFERENCES
// ============================================================================

/**
 * Get user's queue preferences
 * GET /api/user/queue/preferences
 */
router.get('/preferences', authenticateToken, enhancedQueueCtrl.getQueuePreferences);

/**
 * Save user's queue preferences
 * POST /api/user/queue/preferences
 */
router.post('/preferences', authenticateToken, enhancedQueueCtrl.saveQueuePreferences);

// ============================================================================
// SMART QUEUE OPERATIONS
// ============================================================================

/**
 * Smart fill queue with recommendations
 * POST /api/user/queue/smart-fill
 */
router.post('/smart-fill', authenticateToken, enhancedQueueCtrl.smartFillQueue);

/**
 * Prioritize a track (move to front)
 * POST /api/user/queue/prioritize
 */
router.post('/prioritize', authenticateToken, enhancedQueueCtrl.prioritizeTrack);

/**
 * Bulk add tracks to queue
 * POST /api/user/queue/bulk-add
 */
router.post('/bulk-add', authenticateToken, enhancedQueueCtrl.bulkAddToQueue);

// ============================================================================
// ANALYTICS & MONITORING
// ============================================================================

/**
 * Get queue analytics
 * GET /api/user/queue/analytics
 */
router.get('/analytics', authenticateToken, enhancedQueueCtrl.getQueueAnalytics);

module.exports = router;
