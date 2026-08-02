const express = require('express');
const router = express.Router();

const authUser = require('../middleware/authUser');
const plansRoutes = require('./user/planRoutes');
const usersRoutes = require('./user/userRoutes');
const artistsRoutes = require('./user/artistRoutes');
const countriesRoutes = require('./user/countryRoutes');
const regionsRoutes = require('./user/regionRoutes');
const albumsRoutes = require('./user/albumRoutes');
const tracksRoutes = require('./user/trackRoutes');
const playlistsRoutes = require('./user/playlistRoutes');
const followRoutes = require('./user/followRoutes');
const dashboardRoutes = require('./user/dashboardRoutes');
const queueRoutes = require('./user/queueRoutes');
const searchRoutes = require('./user/searchRoutes');
const jioSaavnProxyRoutes = require('./user/jioSaavnProxyRoutes');


router.use(authUser);
router.use('/plans', plansRoutes);
router.use('/users', usersRoutes);
router.use('/artists', artistsRoutes);
router.use('/countries', countriesRoutes);
router.use('/regions', regionsRoutes);
router.use('/albums', albumsRoutes);
router.use('/tracks', tracksRoutes);
router.use('/playlists', playlistsRoutes);
router.use('/follows', followRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/queue', queueRoutes);
router.use('/search', searchRoutes);
// JioSaavn proxy — for web clients only.
// Native clients (Android/Linux/Windows) call JioSaavn on-device.
router.use('/jiosaavn', jioSaavnProxyRoutes);

module.exports = router;
