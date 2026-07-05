// src/routes/auth.js
const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { login, register, getMe } = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/auth');
const { validateRequest } = require('../middleware/errorHandler');

// Anti brute-force: maksimal 10 percobaan login / 15 menit per IP.
// Percobaan yang berhasil tidak dihitung.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
});

router.post('/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Email tidak valid'),
    body('password').notEmpty().withMessage('Password wajib diisi'),
  ],
  validateRequest,
  login
);

router.post('/register',
  authenticate,
  authorize('admin'),
  [
    body('nama').notEmpty().withMessage('Nama wajib diisi'),
    body('email').isEmail().withMessage('Email tidak valid'),
    body('password').isLength({ min: 8 }).withMessage('Password minimal 8 karakter'),
    body('role').isIn(['admin', 'driver']).withMessage('Role harus admin atau driver'),
  ],
  validateRequest,
  register
);

router.get('/me', authenticate, getMe);

module.exports = router;
