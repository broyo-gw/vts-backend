const { query, withTransaction } = require('../config/database');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// GET /api/trips - semua trip (admin), atau trip milik driver yang login
async function getAllTrips(req, res, next) {
  try {
    let sql = `
      SELECT t.id, t.rute_asal, t.rute_tujuan, t.waktu_berangkat, t.waktu_selesai,
             t.status_trip, t.created_at,
             tr.kode_truk, tr.nomor_polisi,
             u.nama AS nama_driver,
             m.kode_manifest,
             COUNT(DISTINCT mp.package_id) AS jumlah_paket
      FROM trip t
      JOIN truck tr ON tr.id = t.truck_id
      JOIN driver d ON d.id = t.driver_id
      JOIN "user" u ON u.id = d.user_id
      JOIN manifest m ON m.id = t.manifest_id
      LEFT JOIN manifest_package mp ON mp.manifest_id = m.id
    `;
    const params = [];

    if (req.user.role === 'driver') {
      // Driver hanya lihat trip miliknya
      const driverRes = await query('SELECT id FROM driver WHERE user_id = $1', [req.user.id]);
      if (driverRes.rows.length === 0) {
        return res.json({ success: true, data: [] });
      }
      params.push(driverRes.rows[0].id);
      sql += ` WHERE t.driver_id = $1`;
    }

    sql += ` GROUP BY t.id, tr.kode_truk, tr.nomor_polisi, u.nama, m.kode_manifest
             ORDER BY t.created_at DESC`;

    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/:id - detail trip + posisi terakhir + status muatan
async function getTripById(req, res, next) {
  try {
    const { id } = req.params;

    const tripRes = await query(
      `SELECT t.*, tr.kode_truk, tr.nomor_polisi, tr.jenis_kendaraan,
              u.nama AS nama_driver, d.no_telepon AS telepon_driver,
              m.kode_manifest, m.status AS status_manifest
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       JOIN driver d ON d.id = t.driver_id
       JOIN "user" u ON u.id = d.user_id
       JOIN manifest m ON m.id = t.manifest_id
       WHERE t.id = $1`,
      [id]
    );
    if (tripRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Trip tidak ditemukan' });
    }

    // Posisi GPS terakhir
    const lastGps = await query(
      `SELECT latitude, longitude, kecepatan_kmh, timestamp
       FROM gps_log WHERE trip_id = $1
       ORDER BY timestamp DESC LIMIT 1`,
      [id]
    );

    // Paket dalam manifest + status terdeteksi terakhir
    const packages = await query(
      `SELECT p.id, p.rfid_tag_epc, p.kode_paket, p.nama_pengirim, p.nama_penerima,
              p.alamat_tujuan, p.berat_kg, p.status_paket,
              re.is_detected AS terdeteksi_terakhir,
              re.timestamp AS waktu_cek_terakhir
       FROM package p
       JOIN manifest_package mp ON mp.package_id = p.id
       LEFT JOIN LATERAL (
         SELECT is_detected, timestamp
         FROM rfid_event
         WHERE package_id = p.id AND trip_id = $1
         ORDER BY timestamp DESC LIMIT 1
       ) re ON true
       WHERE mp.manifest_id = (SELECT manifest_id FROM trip WHERE id = $1)
       ORDER BY p.kode_paket`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...tripRes.rows[0],
        posisi_terakhir: lastGps.rows[0] || null,
        packages: packages.rows,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/trips - buat trip baru (admin)
async function createTrip(req, res, next) {
  try {
    const { truck_id, driver_id, manifest_id, rute_asal, rute_tujuan } = req.body;

    // Validasi: truck dan driver tidak sedang dalam trip aktif
    const activeTruck = await query(
      `SELECT id FROM trip WHERE truck_id = $1 AND status_trip = 'berjalan'`,
      [truck_id]
    );
    if (activeTruck.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Kendaraan sedang dalam perjalanan aktif' });
    }

    const result = await query(
      `INSERT INTO trip (truck_id, driver_id, manifest_id, rute_asal, rute_tujuan, status_trip)
       VALUES ($1, $2, $3, $4, $5, 'persiapan') RETURNING *`,
      [truck_id, driver_id, manifest_id, rute_asal, rute_tujuan]
    );

    // Update status manifest jadi aktif
    await query('UPDATE manifest SET status = $1 WHERE id = $2', ['aktif', manifest_id]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trips/:id/start - mulai perjalanan
async function startTrip(req, res, next) {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE trip SET status_trip = 'berjalan', waktu_berangkat = NOW()
       WHERE id = $1 AND status_trip = 'persiapan' RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Trip tidak bisa dimulai (status bukan persiapan)' });
    }
    // Update status truk
    await query('UPDATE truck SET status = $1 WHERE id = $2', ['aktif', result.rows[0].truck_id]);

    // Tandai semua paket dalam manifest sebagai dalam_perjalanan
    await query(
      `UPDATE package SET status_paket = 'dalam_perjalanan'
       WHERE status_paket = 'pending'
         AND id IN (
           SELECT mp.package_id FROM manifest_package mp
           WHERE mp.manifest_id = $1
         )`,
      [result.rows[0].manifest_id]
    );

    if (ioInstance) {
      ioInstance.to('admin_room').emit('trip_started', { trip_id: result.rows[0].id });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/trips/:id/finish - selesaikan perjalanan
async function finishTrip(req, res, next) {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE trip SET status_trip = 'selesai', waktu_selesai = NOW()
       WHERE id = $1 AND status_trip = 'berjalan' RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Trip tidak bisa diselesaikan' });
    }
    // Reset status truk dan manifest
    await query('UPDATE truck SET status = $1 WHERE id = $2', ['idle', result.rows[0].truck_id]);
    await query('UPDATE manifest SET status = $1 WHERE id = $2', ['selesai', result.rows[0].manifest_id]);

    // Paket yang masih dalam_perjalanan → 'terkirim'
    await query(
      `UPDATE package SET status_paket = 'terkirim'
       WHERE status_paket = 'dalam_perjalanan'
         AND id IN (
           SELECT mp.package_id FROM manifest_package mp
           WHERE mp.manifest_id = $1
         )`,
      [result.rows[0].manifest_id]
    );

    // Paket berstatus 'hilang' yang RFID event terakhirnya is_detected=true
    // (race condition: driver tekan "Sampai" sesaat sebelum recovery MQTT diproses)
    await query(
      `UPDATE package SET status_paket = 'terkirim'
       WHERE status_paket = 'hilang'
         AND id IN (
           SELECT mp.package_id FROM manifest_package mp
           WHERE mp.manifest_id = $1
         )
         AND id IN (
           SELECT r.package_id
           FROM (
             SELECT DISTINCT ON (package_id) package_id, is_detected
             FROM rfid_event
             WHERE trip_id = $2
             ORDER BY package_id, timestamp DESC
           ) r
           WHERE r.is_detected = true
         )`,
      [result.rows[0].manifest_id, parseInt(id)]
    );

    if (ioInstance) {
      ioInstance.to('admin_room').emit('trip_finished', { trip_id: parseInt(id) });

      // Beritahu customer tracking room bahwa trip sudah selesai
      const pkgsRes = await query(
        `SELECT p.kode_paket FROM package p
         JOIN manifest_package mp ON mp.package_id = p.id
         WHERE mp.manifest_id = $1`,
        [result.rows[0].manifest_id]
      );
      for (const pkg of pkgsRes.rows) {
        ioInstance.to(`pkg_${pkg.kode_paket}`).emit('trip_finished', { trip_id: parseInt(id) });
      }
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/:id/history - riwayat GPS dan event selama trip
async function getTripHistory(req, res, next) {
  try {
    const { id } = req.params;

    const gpsHistory = await query(
      `SELECT latitude, longitude, kecepatan_kmh, timestamp
       FROM gps_log WHERE trip_id = $1
       ORDER BY timestamp ASC`,
      [id]
    );

    // Alert + koordinat titik pertama paket tidak terdeteksi (untuk pin di peta)
    const alertHistory = await query(
      `SELECT a.jenis_alert, a.deskripsi, a.status_alert, a.timestamp,
              p.kode_paket, p.rfid_tag_epc,
              re.latitude  AS alert_lat,
              re.longitude AS alert_lon
       FROM alert a
       JOIN package p ON p.id = a.package_id
       LEFT JOIN LATERAL (
         SELECT latitude, longitude
         FROM rfid_event
         WHERE package_id = a.package_id
           AND trip_id    = a.trip_id
           AND is_detected = false
           AND timestamp <= a.timestamp
         ORDER BY timestamp DESC
         LIMIT 1
       ) re ON true
       WHERE a.trip_id = $1
       ORDER BY a.timestamp ASC`,
      [id]
    );

    // Timeline deteksi per paket (untuk detection strip)
    const detectionRows = await query(
      `SELECT re.package_id, p.kode_paket, re.is_detected, re.timestamp
       FROM rfid_event re
       JOIN package p ON p.id = re.package_id
       WHERE re.trip_id = $1
       ORDER BY re.package_id, re.timestamp ASC`,
      [id]
    );

    // Kelompokkan per paket
    const detectionMap = {};
    for (const row of detectionRows.rows) {
      if (!detectionMap[row.package_id]) {
        detectionMap[row.package_id] = {
          package_id: row.package_id,
          kode_paket: row.kode_paket,
          events: [],
        };
      }
      detectionMap[row.package_id].events.push({
        is_detected: row.is_detected,
        timestamp: row.timestamp,
      });
    }

    res.json({
      success: true,
      data: {
        gps_track:          gpsHistory.rows,
        alerts:             alertHistory.rows,
        package_detections: Object.values(detectionMap),
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/:id/packages/:pkg_id/trace - jejak satu paket (rfid_event)
async function getPackageTrace(req, res, next) {
  try {
    const { id: trip_id, pkg_id } = req.params;

    const pkgRes = await query(
      `SELECT id, kode_paket, rfid_tag_epc, nama_pengirim, nama_penerima, alamat_tujuan, berat_kg, status_paket
       FROM package WHERE id = $1`,
      [pkg_id]
    );
    if (pkgRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
    }

    const trace = await query(
      `SELECT latitude, longitude, is_detected, timestamp
       FROM rfid_event
       WHERE trip_id = $1 AND package_id = $2
       ORDER BY timestamp ASC`,
      [trip_id, pkg_id]
    );

    res.json({
      success: true,
      data: {
        package: pkgRes.rows[0],
        trace:   trace.rows,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAllTrips, getTripById, createTrip, startTrip, finishTrip, getTripHistory, getPackageTrace, setIo };
