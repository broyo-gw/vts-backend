// src/socket/socketHandler.js
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

function initSocket(io) {
  // Middleware autentikasi WebSocket
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;

    // Pelanggan boleh connect tanpa token (untuk tracking publik)
    if (!token) {
      socket.user = { role: 'pelanggan' };
      return next();
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload;
      next();
    } catch (err) {
      next(new Error('Token tidak valid'));
    }
  });

  io.on('connection', (socket) => {
    const role = socket.user?.role || 'pelanggan';
    console.log(`[Socket] Client terhubung: ${socket.id} (${role})`);

    // Admin join room khusus admin untuk terima semua alert
    if (role === 'admin') {
      socket.join('admin_room');
      console.log(`[Socket] Admin ${socket.user.nama} join admin_room`);
    }

    // Join room monitoring trip tertentu
    // Client kirim: socket.emit('join_trip', { trip_id: 42 })
    // Hanya admin & driver (pemilik trip) — pelanggan anonim tidak boleh
    // menerima telemetry GPS live truk; mereka pakai track_package.
    socket.on('join_trip', async (payload) => {
      const trip_id = Number(payload?.trip_id);
      if (!Number.isInteger(trip_id)) return;

      if (role === 'admin') {
        socket.join(`trip_${trip_id}`);
        console.log(`[Socket] ${socket.id} join trip_${trip_id} (admin)`);
        return;
      }

      if (role === 'driver') {
        try {
          const res = await query(
            `SELECT 1 FROM trip t
             JOIN driver d ON d.id = t.driver_id
             WHERE t.id = $1 AND d.user_id = $2`,
            [trip_id, socket.user.id]
          );
          if (res.rows.length > 0) {
            socket.join(`trip_${trip_id}`);
            console.log(`[Socket] ${socket.id} join trip_${trip_id} (driver)`);
          }
        } catch (err) {
          console.error('[Socket] Gagal verifikasi kepemilikan trip:', err.message);
        }
      }
      // role pelanggan: diabaikan
    });

    socket.on('leave_trip', (payload) => {
      const trip_id = Number(payload?.trip_id);
      if (!Number.isInteger(trip_id)) return;
      socket.leave(`trip_${trip_id}`);
    });

    // Pelanggan tracking - join room paket spesifik
    // Client kirim: socket.emit('track_package', { kode_paket: 'PKG-001' })
    socket.on('track_package', (payload) => {
      const kode_paket = payload?.kode_paket;
      // Validasi format kode paket agar tidak bisa membuat room sembarangan
      if (typeof kode_paket !== 'string' || !/^[\w-]{1,50}$/.test(kode_paket)) return;
      socket.join(`pkg_${kode_paket}`);
      console.log(`[Socket] ${socket.id} tracking paket: ${kode_paket}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnect: ${socket.id}`);
    });
  });

  return io;
}

module.exports = { initSocket };
