// setup-latensi.js — siapkan trip 'berjalan' untuk uji latensi (tanpa menimpa paket yang sudah ada)
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  try {
    // 1. Ambil trip TRUCK-001 terbaru yang belum selesai
    const t = await c.query(`
      SELECT t.id, t.manifest_id, t.status_trip
      FROM trip t JOIN truck tr ON tr.id = t.truck_id
      WHERE tr.kode_truk = 'TRUCK-001' AND t.status_trip <> 'selesai'
      ORDER BY t.id DESC LIMIT 1`);

    if (t.rows.length === 0) {
      console.log('❌ Tidak ada trip aktif untuk TRUCK-001. Buat trip dulu lewat aplikasi.');
      process.exit(1);
    }

    const trip = t.rows[0];

    // 2. Aktifkan trip
    await c.query(`UPDATE trip SET status_trip = 'berjalan' WHERE id = $1`, [trip.id]);

    // 3. Pastikan manifest punya paket (kalau kosong, hubungkan semua paket yang ada)
    let pk = await c.query(`SELECT COUNT(*) AS n FROM manifest_package WHERE manifest_id = $1`, [trip.manifest_id]);
    if (parseInt(pk.rows[0].n, 10) === 0) {
      await c.query(
        `INSERT INTO manifest_package (manifest_id, package_id)
         SELECT $1, id FROM package ON CONFLICT DO NOTHING`,
        [trip.manifest_id]
      );
      pk = await c.query(`SELECT COUNT(*) AS n FROM manifest_package WHERE manifest_id = $1`, [trip.manifest_id]);
      console.log('  (manifest kosong → semua paket dihubungkan)');
    }

    console.log(`\n✅ Trip id=${trip.id} (manifest ${trip.manifest_id}) → status: BERJALAN`);
    console.log(`   Jumlah paket di manifest: ${pk.rows[0].n}`);
    console.log(`\n>>> Buka test-latensi.js, set:  const TRIP_ID = ${trip.id};\n`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    c.release();
    await pool.end();
  }
})();
