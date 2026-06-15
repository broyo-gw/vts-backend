// inspect-db.js — cek isi DB untuk persiapan uji latensi
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  try {
    const trucks = await c.query(`SELECT id, kode_truk, status FROM truck ORDER BY id`);
    console.log('\n=== TRUCK ===');
    console.table(trucks.rows);

    const trips = await c.query(`
      SELECT t.id, tr.kode_truk, t.manifest_id, t.status_trip
      FROM trip t JOIN truck tr ON tr.id = t.truck_id
      ORDER BY t.id DESC LIMIT 10`);
    console.log('=== TRIP (10 terbaru) ===');
    console.table(trips.rows);

    const pkgCount = await c.query(`SELECT COUNT(*) AS total FROM package`);
    console.log('=== PACKAGE total:', pkgCount.rows[0].total, '===');
    const pkgSample = await c.query(`SELECT id, kode_paket, rfid_tag_epc FROM package ORDER BY id LIMIT 5`);
    console.table(pkgSample.rows);

    const manifests = await c.query(`SELECT id, kode_manifest, status FROM manifest ORDER BY id`);
    console.log('=== MANIFEST ===');
    console.table(manifests.rows);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    c.release();
    await pool.end();
  }
})();
