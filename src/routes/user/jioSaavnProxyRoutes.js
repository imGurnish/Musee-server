/**
 * JioSaavn Proxy Routes
 *
 * Exposes a single proxy endpoint for web clients to search/fetch
 * JioSaavn content through the server (which injects Indian locale
 * headers and cookies).
 *
 * Native clients (Android, Linux, Windows) should NOT use this proxy —
 * they call JioSaavn directly on-device, which already works because
 * the device is in India.
 *
 * Base: /api/user/jiosaavn
 */

const express = require('express');
const router = express.Router();
const { proxyJioSaavn } = require('../../controllers/user/jioSaavnProxyController');

/**
 * GET /api/user/jiosaavn/proxy
 *
 * Forwards all query params to JioSaavn's api.php endpoint with Indian
 * locale headers injected server-side. Auth is enforced by the parent
 * userRoutes router (authUser middleware).
 *
 * Intended for: Web clients only
 * Not needed for: Android, Linux, Windows (call JioSaavn on-device)
 */
router.get('/proxy', proxyJioSaavn);

module.exports = router;
