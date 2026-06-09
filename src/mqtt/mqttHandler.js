// src/mqtt/mqttHandler.js
// Inti sistem: proses payload dari ESP32, hitung Ck, simpan ke DB, push alert via WebSocket

const mqtt = require('mqtt');
const { query, withTransaction } = require('../config/database');

// Threshold: paket dinyatakan "hilang" jika tidak terbaca dalam N siklus berturut-turut
const MISSING_THRESHOLD_CYCLES = 1;

let ioInstance = null; // Socket.io instance
let isProcessing = false; // lock agar tidak ada dua siklus berjalan bersamaan

function initMqtt(io) {
  ioInstance = io;

  const clientOptions = {
    clientId: `vts-backend-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000, // reconnect tiap 5 detik jika putus
  };

  if (process.env.MQTT_USERNAME) {
    clientOptions.username = process.env.MQTT_USERNAME;
    clientOptions.password = process.env.MQTT_PASSWORD;
  }

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, clientOptions);

  client.on('connect', () => {
    console.log('[MQTT] Terhubung ke broker:', process.env.MQTT_BROKER_URL);
    // Subscribe ke semua telemetri: vts/telemetry/#
    // ESP32 publish ke: vts/telemetry/TRUCK-001
    client.subscribe(process.env.MQTT_TOPIC_TELEMETRY, { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Gagal subscribe:', err.message);
      else console.log('[MQTT] Subscribe ke:', process.env.MQTT_TOPIC_TELEMETRY);
    });
  });

  client.on('message', async (topic, message) => {
    if (isProcessing) {
      console.log('[MQTT] Skip: masih memproses siklus sebelumnya');
      return;
    }
    isProcessing = true;
    try {
      const payload = JSON.parse(message.toString());
      await processTelemetry(payload);
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error('[MQTT] Payload bukan JSON valid:', message.toString().substring(0, 100));
      } else {
        console.error('[MQTT] Error proses telemetry:', err.message);
      }
    } finally {
      isProcessing = false;
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Koneksi error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Mencoba reconnect...');
  });

  client.on('disconnect', () => {
    console.log('[MQTT] Terputus dari broker');
  });

  return client;
}

/**
 * Proses satu siklus telemetry dari ESP32
 * Payload format:
 * {
 *   "timestamp": "2026-05-20T10:30:00Z",
 *   "id": "TRUCK-001",
 *   "gps": { "lat": -6.9175, "lon": 107.6191 },
 *   "detected_packages": ["TAG-001", "TAG-002"]
 * }
 */
async function processTelemetry(payload) {
  const { timestamp, id: kode_truk, gps, detected_packages } = payload;

  // Validasi field wajib
  if (!kode_truk || !gps || !Array.isArray(detected_packages)) {
    console.warn('[MQTT] Payload tidak lengkap:', JSON.stringify(payload).substring(0, 100));
    return;
  }

  // 1. Cari trip aktif untuk truk ini
  const tripRes = await query(
    `SELECT t.id AS trip_id, t.manifest_id
     FROM trip t
     JOIN truck tr ON tr.id = t.truck_id
     WHERE tr.kode_truk = $1 AND t.status_trip = 'berjalan'
     LIMIT 1`,
    [kode_truk]
  );

  if (tripRes.rows.length === 0) {
    // Truk tidak sedang dalam perjalanan aktif, abaikan
    return;
  }

  const { trip_id, manifest_id } = tripRes.rows[0];
  const tsDate = timestamp ? new Date(timestamp) : new Date();

  // 2. Ambil semua paket RFID dalam manifest trip ini
  const manifestPackagesRes = await query(
    `SELECT p.id AS package_id, p.rfid_tag_epc, p.kode_paket
     FROM package p
     JOIN manifest_package mp ON mp.package_id = p.id
     WHERE mp.manifest_id = $1`,
    [manifest_id]
  );
  const manifestPackages = manifestPackagesRes.rows;
  const totalPaket = manifestPackages.length;

  if (totalPaket === 0) return;

  // 3. Hitung Ck (completeness) — Persamaan 3.1 dari dokumen CD-3
  // Ck = (jumlah tag manifest yang terbaca / N) × 100%
  const detectedSet = new Set(detected_packages.map(tag => tag.toUpperCase()));
  const terdeteksi = manifestPackages.filter(p => detectedSet.has(p.rfid_tag_epc.toUpperCase())).length;
  const completeness_pct = parseFloat(((terdeteksi / totalPaket) * 100).toFixed(2));

  // 4. Simpan semua data dalam satu transaksi
  const newAlerts = [];
  const recoveredAlerts = [];

  await withTransaction(async (client) => {
    // Insert TELEMETRY (induk siklus)
    const telRes = await client.query(
      `INSERT INTO telemetry (trip_id, timestamp, completeness_pct)
       VALUES ($1, $2, $3) RETURNING id`,
      [trip_id, tsDate, completeness_pct]
    );
    const telemetry_id = telRes.rows[0].id;

    // Insert GPS_LOG (speed dikirim oleh SIM7600G/GPS module langsung dalam km/h)
    await client.query(
      `INSERT INTO gps_log (trip_id, telemetry_id, latitude, longitude, kecepatan_kmh, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [trip_id, telemetry_id, gps.lat, gps.lon, gps.speed ?? null, tsDate]
    );

    // Insert RFID_EVENT per paket + cek anomali
    for (const pkg of manifestPackages) {
      const is_detected = detectedSet.has(pkg.rfid_tag_epc.toUpperCase());

      await client.query(
        `INSERT INTO rfid_event (trip_id, telemetry_id, package_id, is_detected, latitude, longitude, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [trip_id, telemetry_id, pkg.package_id, is_detected, gps.lat, gps.lon, tsDate]
      );

      // Cek apakah paket ini hilang berdasarkan threshold
      // Persamaan 3.2: Hilang jika tidak terdeteksi dalam N siklus berturut-turut
      if (!is_detected) {
        const missedCycles = await client.query(
          `SELECT COUNT(*) AS count
           FROM (
             SELECT is_detected FROM rfid_event
             WHERE trip_id = $1 AND package_id = $2
             ORDER BY timestamp DESC
             LIMIT $3
           ) recent
           WHERE is_detected = false`,
          [trip_id, pkg.package_id, MISSING_THRESHOLD_CYCLES]
        );

        const missedCount = parseInt(missedCycles.rows[0].count, 10);

        if (missedCount >= MISSING_THRESHOLD_CYCLES) {
          // Pastikan belum ada alert aktif untuk paket ini
          const existingAlert = await client.query(
            `SELECT id FROM alert
             WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
            [trip_id, pkg.package_id]
          );

          if (existingAlert.rows.length === 0) {
            // Buat alert baru
            const alertRes = await client.query(
              `INSERT INTO alert (trip_id, package_id, jenis_alert, deskripsi, status_alert)
               VALUES ($1, $2, 'PAKET_HILANG', $3, 'baru') RETURNING *`,
              [
                trip_id,
                pkg.package_id,
                `Paket ${pkg.rfid_tag_epc} tidak terdeteksi pada siklus terakhir. Lokasi terakhir: ${gps.lat}, ${gps.lon}`,
              ]
            );

            // Update status paket jadi hilang
            await client.query(
              `UPDATE package SET status_paket = 'hilang' WHERE id = $1`,
              [pkg.package_id]
            );

            newAlerts.push({
              ...alertRes.rows[0],
              rfid_tag_epc: pkg.rfid_tag_epc,
              lokasi: { lat: gps.lat, lon: gps.lon },
            });
          }
        }
      } else {
        // Paket terdeteksi kembali — selesaikan alert aktif dan pulihkan status
        const activeAlert = await client.query(
          `SELECT id FROM alert
           WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
          [trip_id, pkg.package_id]
        );
        if (activeAlert.rows.length > 0) {
          await client.query(
            `UPDATE alert SET status_alert = 'selesai'
             WHERE trip_id = $1 AND package_id = $2 AND status_alert = 'baru'`,
            [trip_id, pkg.package_id]
          );
          await client.query(
            `UPDATE package SET status_paket = 'dalam_perjalanan' WHERE id = $1`,
            [pkg.package_id]
          );
          recoveredAlerts.push({
            alert_id: activeAlert.rows[0].id,
            kode_paket: pkg.kode_paket,
          });
        }
      }
    }
  });

  // 5. Push update real-time ke dashboard via WebSocket
  if (ioInstance) {
    const telemetryPayload = {
      trip_id,
      kode_truk,
      timestamp: tsDate,
      gps: { lat: gps.lat, lon: gps.lon },
      completeness_pct,
      terdeteksi,
      total_paket: totalPaket,
    };

    // Emit ke room admin + room monitoring trip
    ioInstance.to(`trip_${trip_id}`).to('admin_room').emit('telemetry_update', telemetryPayload);

    // Emit ke room tracking pelanggan per paket (pkg_PKT-CIM-001, dst)
    for (const pkg of manifestPackages) {
      ioInstance.to(`pkg_${pkg.kode_paket}`).emit('telemetry_update', telemetryPayload);
    }

    // Push alert ke admin room
    for (const alert of newAlerts) {
      ioInstance.to('admin_room').emit('paket_hilang', {
        trip_id,
        kode_truk,
        alert,
      });
      console.log(`[MQTT] ⚠️ ALERT: Paket ${alert.rfid_tag_epc} hilang di ${gps.lat},${gps.lon}`);
    }

    // Broadcast recovery ke admin, trip room, dan customer tracking room
    for (const recovered of recoveredAlerts) {
      const recoveryPayload = {
        trip_id,
        kode_truk,
        alert_id: recovered.alert_id,
        kode_paket: recovered.kode_paket,
      };
      ioInstance.to('admin_room').to(`trip_${trip_id}`).emit('paket_ditemukan', recoveryPayload);
      ioInstance.to(`pkg_${recovered.kode_paket}`).emit('paket_ditemukan', recoveryPayload);
      console.log(`[MQTT] ✅ RECOVERED: Paket ${recovered.kode_paket} terdeteksi kembali`);
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`[MQTT] ${kode_truk} | Ck=${completeness_pct}% (${terdeteksi}/${totalPaket}) | GPS: ${gps.lat},${gps.lon}`);
  }
}

module.exports = { initMqtt };
