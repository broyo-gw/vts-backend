const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const result = await query(
      'SELECT id, nama, email, password_hash, role FROM "user" WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Email atau password salah' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Email atau password salah' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, nama: user.nama },
      process.env.JWT_SECRET,
      // Fallback 24h agar token tetap punya masa berlaku walau env tidak diset
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, nama: user.nama, email: user.email, role: user.role },
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/register  (hanya admin yang bisa membuat akun baru)
async function register(req, res, next) {
  try {
    const { nama, email, password, role, nomor_sim, no_telepon } = req.body;

    // Cek email duplikat
    const existing = await query('SELECT id FROM "user" WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Email sudah terdaftar' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    // Buat user baru dalam transaksi (kalau role driver, buat juga row di tabel driver)
    const { withTransaction } = require('../config/database');
    const newUser = await withTransaction(async (client) => {
      const userRes = await client.query(
        'INSERT INTO "user" (nama, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, nama, email, role',
        [nama, email, password_hash, role]
      );
      const user = userRes.rows[0];

      if (role === 'driver') {
        await client.query(
          'INSERT INTO driver (user_id, nomor_sim, no_telepon) VALUES ($1, $2, $3)',
          [user.id, nomor_sim || null, no_telepon || null]
        );
      }
      return user;
    });

    res.status(201).json({ success: true, data: newUser });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me
async function getMe(req, res, next) {
  try {
    const result = await query(
      `SELECT u.id, u.nama, u.email, u.role,
              d.nomor_sim, d.no_telepon
       FROM "user" u
       LEFT JOIN driver d ON d.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, register, getMe };
