/**
 * Import Routes - Jio Saavn integration endpoints
 * Base: /api/admin/import
 */

const express = require('express');
const router = express.Router();
const importController = require('../../controllers/admin/importController');
const authAdmin = require('../../middleware/authAdmin');

// All import endpoints require admin authentication
router.use(authAdmin);

/**
 * SEARCH ENDPOINTS - Get search results from Jio Saavn
 */

// Search tracks
router.get('/search/tracks', async (req, res) => {
  await importController.searchTracks(req, res);
});

// Search albums
router.get('/search/albums', async (req, res) => {
  await importController.searchAlbums(req, res);
});

// Search artists
router.get('/search/artists', async (req, res) => {
  await importController.searchArtists(req, res);
});

/**
 * DETAIL ENDPOINTS - Get full details for specific items
 */

// Get track details from Jio Saavn
router.get('/track/:trackId', async (req, res) => {
  await importController.getTrackDetails(req, res);
});

// Get album details from Jio Saavn with all tracks
router.get('/album/:albumId', async (req, res) => {
  await importController.getAlbumDetails(req, res);
});

// Get artist details from Jio Saavn
router.get('/artist/:artistId', async (req, res) => {
  await importController.getArtistDetails(req, res);
});

/**
 * IMPORT ENDPOINTS - Execute imports with rollback on failure
 */

// Import complete album with all tracks
// POST body:
// {
//   jioSaavnAlbumId: string,
//   artistName: string,
//   artistBio?: string,
//   regionId?: UUID,
//   isPublished?: boolean,
//   dryRun?: boolean
// }
router.post('/album-complete', async (req, res) => {
  await importController.importCompleteAlbum(req, res);
});

// Decrypt and process track (server-side)
// POST body:
// {
//   trackId: UUID,
//   encryptedUrl: string
// }
router.post('/decrypt-and-process', async (req, res) => {
  await importController.decryptAndProcessTrack(req, res);
});

module.exports = router;
