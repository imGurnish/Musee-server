const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/user/dashboardController');

router.get('/made-for-you', ctrl.madeForYou);
router.get('/albums-for-you', ctrl.albumsForYou);
router.get('/trending', ctrl.trending);

module.exports = router;
