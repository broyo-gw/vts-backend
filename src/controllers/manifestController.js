const { query, withTransaction } = require('../config/database');

// GET /api/manifests - list semua manifest (admin)
async function getAllManifests(req, res, next) {
  try {
    const result = await query(
      `SELECT m.id, m.kode_manifest, m.tanggal_dibuat, m.status,
              u.nama AS dibuat_oleh,
              COUNT(mp.package_id) AS jumlah_paket
       FROM manifest m
       JOIN "user" u ON u.id = m.user_id
       LEFT JOIN manifest_package mp ON mp.manifest_id = m.id
       GROUP BY m.id, u.nama
       ORDER BY m.tanggal_dibuat DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/manifests/:id - detail manifest beserta daftar paket
async function getManifestById(req, res, next) {
  try {
    const { id } = req.params;

    const manifestRes = await query(
      `SELECT m.*, u.nama AS dibuat_oleh
       FROM manifest m JOIN "user" u ON u.id = m.user_id
       WHERE m.id = $1`,
      [id]
    );
    if (manifestRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Manifest tidak ditemukan' });
    }

    const packagesRes = await query(
      `SELECT p.id, p.rfid_tag_epc, p.kode_paket, p.nama_pengirim,
              p.nama_penerima, p.alamat_tujuan, p.berat_kg, p.status_paket
       FROM package p
       JOIN manifest_package mp ON mp.package_id = p.id
       WHERE mp.manifest_id = $1
       ORDER BY p.kode_paket`,
      [id]
    );

    // Armada terkait — trip yang ditugaskan ke manifest ini (status apa pun:
    // persiapan/berjalan/selesai). Diambil yang terbaru bila ada lebih dari satu.
    const armadaRes = await query(
      `SELECT t.id AS trip_id, t.status_trip, t.rute_asal, t.rute_tujuan,
              tr.kode_truk, tr.nomor_polisi, tr.jenis_kendaraan,
              u.nama AS nama_driver
       FROM trip t
       JOIN truck tr ON tr.id = t.truck_id
       JOIN driver d ON d.id = t.driver_id
       JOIN "user" u ON u.id = d.user_id
       WHERE t.manifest_id = $1
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...manifestRes.rows[0],
        packages: packagesRes.rows,
        armada: armadaRes.rows[0] || null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/manifests - buat manifest baru + import paket
// Body: { kode_manifest, packages: [{ rfid_tag_epc, kode_paket, nama_pengirim, nama_penerima, alamat_tujuan, berat_kg }] }
async function createManifest(req, res, next) {
  try {
    const { kode_manifest, packages } = req.body;
    const user_id = req.user.id;

    if (!packages || packages.length === 0) {
      return res.status(400).json({ success: false, message: 'Manifest harus memiliki minimal 1 paket' });
    }

    // Filter hanya paket yang punya rfid_tag_epc (paket RFID)
    const rfidPackages = packages.filter(p => p.rfid_tag_epc && p.rfid_tag_epc.trim() !== '');
    if (rfidPackages.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada paket dengan RFID tag yang valid' });
    }

    const result = await withTransaction(async (client) => {
      // 1. Buat manifest
      const manifestRes = await client.query(
        'INSERT INTO manifest (user_id, kode_manifest, status) VALUES ($1, $2, $3) RETURNING *',
        [user_id, kode_manifest, 'draft']
      );
      const manifest = manifestRes.rows[0];

      // 2. Insert paket RFID, skip jika sudah ada (upsert by rfid_tag_epc)
      const insertedPackages = [];
      for (const pkg of rfidPackages) {
        // Coba insert, kalau sudah ada ambil ID yang existing
        const pkgRes = await client.query(
          `INSERT INTO package (rfid_tag_epc, kode_paket, nama_pengirim, nama_penerima, alamat_tujuan, berat_kg)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (rfid_tag_epc) DO UPDATE SET
             kode_paket = EXCLUDED.kode_paket,
             nama_pengirim = EXCLUDED.nama_pengirim,
             nama_penerima = EXCLUDED.nama_penerima,
             alamat_tujuan = EXCLUDED.alamat_tujuan,
             berat_kg = EXCLUDED.berat_kg
           RETURNING id`,
          [pkg.rfid_tag_epc, pkg.kode_paket, pkg.nama_pengirim, pkg.nama_penerima, pkg.alamat_tujuan, pkg.berat_kg || null]
        );
        insertedPackages.push(pkgRes.rows[0].id);
      }

      // 3. Hubungkan paket ke manifest
      for (const packageId of insertedPackages) {
        await client.query(
          'INSERT INTO manifest_package (manifest_id, package_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [manifest.id, packageId]
        );
      }

      return { manifest, jumlah_paket_rfid: insertedPackages.length };
    });

    res.status(201).json({
      success: true,
      message: `Manifest terbuat berisi ${result.jumlah_paket_rfid} paket RFID (dari ${packages.length} total)`,
      data: result.manifest,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/manifests/:id/status
async function updateManifestStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Harus sinkron dengan CHECK constraint tabel manifest di migrations
    const ALLOWED_STATUS = ['draft', 'aktif', 'selesai'];
    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status tidak valid. Pilihan: ${ALLOWED_STATUS.join(', ')}`,
      });
    }

    const result = await query(
      'UPDATE manifest SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Manifest tidak ditemukan' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAllManifests, getManifestById, createManifest, updateManifestStatus };
