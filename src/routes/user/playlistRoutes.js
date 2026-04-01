const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/user/playlistsController');
const uploadCover = require('../../middleware/uploadCover');

router.get('/', ctrl.list);
router.get('/list', ctrl.listAlias);
router.get('/search', ctrl.search);
router.get('/recommendations', ctrl.recommended);
router.get('/:id', ctrl.getOne);
router.post('/', uploadCover, ctrl.create);
router.patch('/:id', uploadCover, ctrl.update);
router.delete('/:id', ctrl.remove);

// Manage tracks within a playlist (owner only)
router.post('/:id/tracks', ctrl.addTrack);
router.delete('/:id/tracks/:trackId', ctrl.removeTrack);

module.exports = router;
