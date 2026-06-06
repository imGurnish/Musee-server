const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/user/artistsController');
const uploadCover = require('../../middleware/uploadCover');

router.get('/', ctrl.list);
router.get('/:id/similar', ctrl.getSimilar);
router.get('/:id', ctrl.getOne);
router.get('/:id/tracks', ctrl.listTracks);
router.get('/:id/albums', ctrl.listAlbums);
router.post('/', uploadCover, ctrl.create);
router.patch('/:id', uploadCover, ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;