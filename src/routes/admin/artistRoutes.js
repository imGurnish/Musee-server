const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/admin/artistsController');
const uploadCover = require('../../middleware/uploadCover');
const uploadAvatar = require('../../middleware/uploadAvatar');
const uploadAvatarAndCover = require('../../middleware/uploadAvatarAndCover');

router.get('/', ctrl.list);
router.post('/bulk-delete', ctrl.removeMany);
router.get('/:id', ctrl.getOne);
router.get('/:id/tracks', ctrl.listTracks);
router.get('/:id/albums', ctrl.listAlbums);
router.post('/', uploadAvatarAndCover, ctrl.create);
router.patch('/:id', uploadCover, ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;