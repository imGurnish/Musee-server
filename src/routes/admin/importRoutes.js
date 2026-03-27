/**
 * Import Routes - Queue-based JioSaavn import endpoints
 * Base: /api/admin/import
 */

const express = require('express');
const router = express.Router();
const importController = require('../../controllers/admin/importController');
const authAdmin = require('../../middleware/authAdmin');

router.use(authAdmin);

// Four core import routes
router.post('/artist/:artistId', importController.importArtist);
router.post('/album/:albumId', importController.importAlbum);
router.post('/track/:trackId', importController.importTrack);
router.post('/playlist/:playlistId', importController.importPlaylist);

// Queue + status endpoints
router.post('/queue', importController.enqueueImportByApi);
router.get('/status/:jobId', importController.getImportStatus);

module.exports = router;
