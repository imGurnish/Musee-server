const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/user/searchController');

router.get('/', ctrl.searchAll);

module.exports = router;
