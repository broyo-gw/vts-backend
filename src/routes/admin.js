// src/routes/admin.js
// Endpoint admin-only: data referensi truk & driver untuk form assignment trip

const router = require('express').Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/admin/trucks - semua truk beserta status
router.get('/trucks', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.id, t.kode_truk, t.nomor_polisi, t.jenis_kendaraan, t.status,
              (SELECT COUNT(*) FROM trip tr WHERE tr.truck_id = t.id AND tr.status_trip IN ('persiapan','berjalan')) AS trip_aktif
       FROM truck t
       ORDER BY t.kode_truk`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/admin/drivers - semua driver
router.get('/drivers', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT d.id, u.nama, u.email, d.no_telepon,
              (SELECT COUNT(*) FROM trip tr WHERE tr.driver_id = d.id AND tr.status_trip IN ('persiapan','berjalan')) AS trip_aktif
       FROM driver d
       JOIN "user" u ON u.id = d.user_id
       ORDER BY u.nama`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
