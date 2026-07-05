// src/routes/trip.js
const router = require('express').Router();
const { body, param } = require('express-validator');
const ctrl = require('../controllers/tripController');
const { authenticate, authorize } = require('../middleware/auth');
const { validateRequest } = require('../middleware/errorHandler');

// Validasi :id numerik agar tidak jadi error 500 dari PostgreSQL
const idParam = [param('id').isInt().withMessage('ID trip harus angka'), validateRequest];

router.get('/', authenticate, ctrl.getAllTrips);
router.get('/:id', authenticate, idParam, ctrl.getTripById);
router.get('/:id/history', authenticate, idParam, ctrl.getTripHistory);
router.get('/:id/packages/:pkg_id/trace',
  authenticate,
  [param('id').isInt(), param('pkg_id').isInt().withMessage('ID paket harus angka')],
  validateRequest,
  ctrl.getPackageTrace
);
router.post('/',
  authenticate,
  authorize('admin'),
  [
    body('truck_id').isInt().withMessage('truck_id harus integer'),
    body('driver_id').isInt().withMessage('driver_id harus integer'),
    body('manifest_id').isInt().withMessage('manifest_id harus integer'),
  ],
  validateRequest,
  ctrl.createTrip
);
router.patch('/:id/start', authenticate, authorize('admin', 'driver'), idParam, ctrl.startTrip);
router.patch('/:id/finish', authenticate, authorize('admin', 'driver'), idParam, ctrl.finishTrip);

module.exports = router;
