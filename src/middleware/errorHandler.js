const { validationResult } = require('express-validator');

// Tangkap error validasi dari express-validator
function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validasi gagal',
      errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

// Global error handler (pasang di app.js paling bawah)
function errorHandler(err, req, res, next) {
  console.error('[Error]', err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // Error dari PostgreSQL
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'Data sudah ada (duplikat)' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'Referensi data tidak ditemukan' });
  }

  const status = err.status || 500;
  // Di production jangan bocorkan pesan error internal (nama tabel, query, dsb)
  const message =
    status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Terjadi kesalahan pada server'
      : err.message || 'Terjadi kesalahan pada server';

  res.status(status).json({ success: false, message });
}

module.exports = { validateRequest, errorHandler };
