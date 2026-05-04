const express = require('express');
const router = express.Router();

const { getUsage, getEngagementMetrics, refreshTrending } = require('../../controllers/admin/metricsController');

router.get('/', getUsage);
router.get('/engagement', getEngagementMetrics);
router.post('/refresh-trending', refreshTrending);

module.exports = router;
