// src/routes/trip.js
const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/tripController');
const { authenticate, authorize } = require('../middleware/auth');
const { validateRequest } = require('../middleware/errorHandler');

router.get('/', authenticate, ctrl.getAllTrips);
router.get('/:id', authenticate, ctrl.getTripById);
router.get('/:id/history', authenticate, ctrl.getTripHistory);
router.get('/:id/packages/:pkg_id/trace', authenticate, ctrl.getPackageTrace);
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
router.patch('/:id/start', authenticate, ctrl.startTrip);
router.patch('/:id/finish', authenticate, ctrl.finishTrip);

module.exports = router;
