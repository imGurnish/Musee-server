const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/admin/tracksController');
const artistsCtrl = require('../../controllers/admin/trackArtistsController');
const uploadTrackFiles = require('../../middleware/uploadTrackFiles');
const normalizeArrayFields = require('../../middleware/normalizeArrayFields');

router.get('/', ctrl.list);
router.post('/bulk-delete', ctrl.removeMany);
router.get('/:id', ctrl.getOne);
router.post('/', uploadTrackFiles, normalizeArrayFields, ctrl.create);
router.patch('/:id', uploadTrackFiles, normalizeArrayFields, ctrl.update);
router.delete('/:id', ctrl.remove);

// Track artists management
router.post('/:id/artists', artistsCtrl.addArtist);
router.patch('/:id/artists/:artistId', artistsCtrl.updateArtist);
router.delete('/:id/artists/:artistId', artistsCtrl.removeArtist);

module.exports = router;
