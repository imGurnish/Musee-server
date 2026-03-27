const express = require('express');
const router = express.Router();

const authAdmin = require('../middleware/authAdmin');
const plansRoutes = require('./admin/planRoutes');
const usersRoutes = require('./admin/usersRoutes');
const artistsRoutes = require('./admin/artistRoutes');
const tracksRoutes = require('./admin/trackRoutes');
const albumsRoutes = require('./admin/albumRoutes');
const playlistsRoutes = require('./admin/playlistRoutes');
const countriesRoutes = require('./admin/countryRoutes');
const regionsRoutes = require('./admin/regionRoutes');
const metricsRoutes = require('./admin/metricsRoutes');

router.use(authAdmin);
router.use('/plans', plansRoutes);
// Includes: POST /api/admin/users/bulk-delete
router.use('/users', usersRoutes);
router.use('/artists', artistsRoutes);
router.use('/tracks', tracksRoutes);
router.use('/albums', albumsRoutes);
router.use('/playlists', playlistsRoutes);
router.use('/countries', countriesRoutes);
router.use('/regions', regionsRoutes);
router.use('/metrics', metricsRoutes);

try {
	const importRoutes = require('./admin/importRoutes');
	router.use('/import', importRoutes);
} catch (error) {
	console.warn('Import routes not mounted:', error?.message || error);
}

module.exports = router;
