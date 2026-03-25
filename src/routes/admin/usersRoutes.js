const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/admin/usersController');
const uploadAvatar = require('../../middleware/uploadAvatar');

router.get('/', ctrl.list);
router.post('/bulk-delete', ctrl.removeMany);
router.get('/:id', ctrl.getOne);
router.post('/', uploadAvatar, ctrl.create);
router.patch('/:id', uploadAvatar, ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
