const express = require('express');
const router = express.Router();

const playlistsController = require('../controllers/user/playlistsController');

// Public discovery/search endpoints for playlists.
router.get('/playlists', playlistsController.list);
router.get('/playlists/list', playlistsController.listAlias);
router.get('/playlists/search', playlistsController.search);
router.get('/playlists/recommendations', playlistsController.recommended);

module.exports = router;
