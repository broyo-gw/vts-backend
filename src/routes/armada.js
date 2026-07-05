// src/routes/armada.js
const router = require('express').Router();
const { param } = require('express-validator');
const ctrl = require('../controllers/armadaController');
const { authenticate, authorize } = require('../middleware/auth');
const { validateRequest } = require('../middleware/errorHandler');

router.get('/', authenticate, authorize('admin'), ctrl.getArmadaAktif);
router.get('/:trip_id/detail',
  authenticate,
  authorize('admin', 'driver'),
  [param('trip_id').isInt().withMessage('ID trip harus angka')],
  validateRequest,
  ctrl.getDetailMuatan
);

module.exports = router;
