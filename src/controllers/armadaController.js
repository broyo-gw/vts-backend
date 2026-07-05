const { query } = require('../config/database');
const { assertTripAccess } = require('./tripController');

// GET /api/armada - semua truk aktif + posisi terakhir + status muatan
async function getArmadaAktif(req, res, next) {
  try {
    const result = await query(
      `SELECT t.id AS trip_id, t.rute_asal, t.rute_tujuan, t.waktu_berangkat, t.status_trip,
              tr.id AS truck_id, tr.kode_truk, tr.nomor_polisi, tr.jenis_kendaraan,
              u.nama AS nama_driver, d.no_telepon,
              m.kode_manifest,
              COUNT(DISTINCT mp.package_id) AS total_paket,
              gl.latitude, gl.longitude, gl.kecepatan_kmh, gl.timestamp AS waktu_posisi,
              tel.completeness_pct
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       JOIN driver d ON d.id = t.driver_id
       JOIN "user" u ON u.id = d.user_id
       JOIN manifest m ON m.id = t.manifest_id
       LEFT JOIN manifest_package mp ON mp.manifest_id = m.id
       -- GPS terakhir via LATERAL
       LEFT JOIN LATERAL (
         SELECT latitude, longitude, kecepatan_kmh, timestamp
         FROM gps_log WHERE trip_id = t.id
         ORDER BY timestamp DESC LIMIT 1
       ) gl ON true
       -- Telemetry terakhir via LATERAL
       LEFT JOIN LATERAL (
         SELECT completeness_pct
         FROM telemetry WHERE trip_id = t.id
         ORDER BY timestamp DESC LIMIT 1
       ) tel ON true
       WHERE t.status_trip = 'berjalan'
       GROUP BY t.id, tr.id, u.nama, d.no_telepon, m.kode_manifest,
                gl.latitude, gl.longitude, gl.kecepatan_kmh, gl.timestamp,
                tel.completeness_pct
       ORDER BY t.waktu_berangkat DESC`
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/armada/:trip_id/detail - detail muatan satu truk
async function getDetailMuatan(req, res, next) {
  try {
    const { trip_id } = req.params;
    // Driver hanya boleh melihat detail muatan trip miliknya sendiri
    if (!(await assertTripAccess(req, res, trip_id))) return;

    // Info trip
    const tripRes = await query(
      `SELECT t.*, tr.kode_truk, tr.nomor_polisi, u.nama AS nama_driver,
              m.kode_manifest, tel.completeness_pct,
              gl.latitude, gl.longitude, gl.timestamp AS waktu_posisi
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       JOIN driver d ON d.id = t.driver_id
       JOIN "user" u ON u.id = d.user_id
       JOIN manifest m ON m.id = t.manifest_id
       LEFT JOIN LATERAL (
         SELECT completeness_pct FROM telemetry WHERE trip_id = t.id ORDER BY timestamp DESC LIMIT 1
       ) tel ON true
       LEFT JOIN LATERAL (
         SELECT latitude, longitude, timestamp FROM gps_log WHERE trip_id = t.id ORDER BY timestamp DESC LIMIT 1
       ) gl ON true
       WHERE t.id = $1`,
      [trip_id]
    );

    if (tripRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Trip tidak ditemukan' });
    }

    // Daftar semua paket + status terdeteksi terakhir
    const packagesRes = await query(
      `SELECT p.id, p.rfid_tag_epc, p.kode_paket, p.nama_penerima, p.alamat_tujuan,
              p.berat_kg, p.status_paket,
              re.is_detected,
              re.timestamp AS waktu_cek
       FROM package p
       JOIN manifest_package mp ON mp.package_id = p.id
       LEFT JOIN LATERAL (
         SELECT is_detected, timestamp
         FROM rfid_event
         WHERE package_id = p.id AND trip_id = $1
         ORDER BY timestamp DESC LIMIT 1
       ) re ON true
       WHERE mp.manifest_id = (SELECT manifest_id FROM trip WHERE id = $1)
       ORDER BY re.is_detected ASC NULLS LAST, p.kode_paket ASC`,
      [trip_id]
    );

    // Statistik ringkas
    const totalPaket = packagesRes.rows.length;
    const terdeteksi = packagesRes.rows.filter(p => p.is_detected === true).length;
    const hilang = packagesRes.rows.filter(p => p.is_detected === false).length;

    // Alert aktif untuk trip ini
    const alertRes = await query(
      `SELECT a.id, a.jenis_alert, a.deskripsi, a.status_alert, a.timestamp,
              p.kode_paket
       FROM alert a JOIN package p ON p.id = a.package_id
       WHERE a.trip_id = $1 AND a.status_alert = 'baru'
       ORDER BY a.timestamp DESC`,
      [trip_id]
    );

    res.json({
      success: true,
      data: {
        ...tripRes.rows[0],
        ringkasan: { total_paket: totalPaket, terdeteksi, hilang },
        packages: packagesRes.rows,
        alerts_aktif: alertRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getArmadaAktif, getDetailMuatan };
