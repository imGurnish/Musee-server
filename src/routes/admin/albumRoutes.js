const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/admin/albumsController');
const uploadCover = require('../../middleware/uploadCover');

router.get('/', ctrl.list);
router.post('/bulk-delete', ctrl.removeMany);
router.get('/:id', ctrl.getOne);
router.post('/', uploadCover, ctrl.create);
router.patch('/:id', uploadCover, ctrl.update);
router.delete('/:id', ctrl.remove);

// Manage artists on an album
router.post('/:id/artists', ctrl.addArtist);
router.patch('/:id/artists/:artistId', ctrl.updateArtist);
router.delete('/:id/artists/:artistId', ctrl.removeArtist);

module.exports = router;
