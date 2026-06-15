// test-latensi.js — Pengujian Latensi End-to-End (NFR-02)
// Skrip ini berperan SEKALIGUS sebagai:
//   - ESP32  : publish telemetri ke MQTT broker (HiveMQ)
//   - Dashboard : subscribe telemetry_update via WebSocket ke backend (Railway)
// Karena publish & terima di SATU mesin/SATU jam, Δt Total akurat tanpa sinkronisasi NTP.
//
// Prasyarat: jalankan dulu seed agar ada trip 'berjalan':
//   node seeds/seed_esp32_test.js   (arahkan ke DB Railway via DATABASE_URL)
//
// Jalankan: node test-latensi.js
require('dotenv').config();
const mqtt = require('mqtt');
const { io } = require('socket.io-client');

// ─── Konfigurasi ──────────────────────────────────────────────
const WS_URL       = 'https://vts-backend-testing.up.railway.app';
const BROKER_URL   = process.env.MQTT_BROKER_URL;       // dari .env
const TRUCK_ID     = 'TRUCK-001';
const TOPIC        = `vts/telemetry/${TRUCK_ID}`;
const TRIP_ID      = 14;            // ← samakan dengan output setup-latensi.js
const JUMLAH_UJI   = 5;             // sesuai tabel: 5 pengukuran
const JEDA_MS      = 2000;          // jeda antar pengukuran

// 20 EPC sesuai seed (semua dikirim "terdeteksi" → Ck 100%, tidak memicu alert)
const ALL_EPC = [
  'E28069150000700F0CA6BA45','E28069150000600F0CA6D245','E28069150000600F0CA6C645',
  'E28069150000600F0CA6E245','E28069150000700F0CA6C245','E28069150000600F0CA6DE45',
  'E28069150000700F0CA6EA45','E28069150000700F0CA6D645','E28069150000700F0CA6CE45',
  'E28069150000600F0CA6BE45','E28069150000600F0CA6CA45','E28069150000700F0CA6DA45',
  'E28069150000600F0CA6EE45','E28069150000700F0CA6E645','E28069150000600F0CA6F645',
  'E28069150000700F0CA6F245','E28069150000600F0CA6FA45','E28069150000700F0CA6FE45',
  'E28069150000700F0CA70645','E28069150000600F0CA70245',
];

const hasil = []; // simpan {col1, col2, total}
let pending = null; // resolver untuk pengukuran yang sedang berjalan

// ─── 1. Koneksi WebSocket (peran: Dashboard) ─────────────────
const socket = io(WS_URL, { transports: ['websocket'], reconnection: false });

socket.on('connect', () => {
  console.log('[WS] Dashboard terhubung:', socket.id);
  socket.emit('join_trip', { trip_id: TRIP_ID });
});

socket.on('telemetry_update', (payload) => {
  const t2 = Date.now(); // browser terima
  if (!pending || payload.sent_ms == null) return; // abaikan pesan yg bukan dari uji ini
  const t0 = payload.sent_ms;
  const t1 = payload.server_received_ms;
  const r = {
    col1: t1 - t0,   // Δt ESP32 → MQTT Broker (sampai backend)
    col2: t2 - t1,   // Δt MQTT → Dashboard Browser
    total: t2 - t0,  // Δt Total
  };
  const done = pending; pending = null;
  done(r);
});

socket.on('connect_error', (e) => {
  console.error('[WS] Gagal konek:', e.message);
  process.exit(1);
});

// ─── 2. Koneksi MQTT (peran: ESP32) ──────────────────────────
const mqttClient = mqtt.connect(BROKER_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `vts-latensi-test-${Date.now()}`,
});

mqttClient.on('error', (e) => { console.error('[MQTT] Error:', e.message); process.exit(1); });

// ─── 3. Satu siklus pengukuran ───────────────────────────────
function ukurSekali(no) {
  return new Promise((resolve) => {
    const sent_ms = Date.now(); // t0
    const payload = {
      id: TRUCK_ID,
      timestamp: new Date(sent_ms).toISOString(),
      sent_ms,
      gps: { lat: -6.9175, lon: 107.6191, speed: 40 },
      detected_packages: ALL_EPC,
    };

    const timeout = setTimeout(() => {
      if (pending) { pending = null; console.log(`  #${no}  ⏱️ TIMEOUT (tidak ada balasan dalam 10s)`); resolve(); }
    }, 10000);

    pending = (r) => {
      clearTimeout(timeout);
      hasil.push(r);
      console.log(`  #${no}  ESP32→Broker: ${r.col1} ms | Broker→Dashboard: ${r.col2} ms | TOTAL: ${r.total} ms`);
      resolve();
    };

    mqttClient.publish(TOPIC, JSON.stringify(payload), { qos: 1 });
  });
}

// ─── 4. Jalankan 5x lalu cetak ringkasan ─────────────────────
async function jalankan() {
  console.log(`\n=== Uji Latensi End-to-End (NFR-02) — ${JUMLAH_UJI}x ===`);
  console.log(`Broker : ${BROKER_URL}`);
  console.log(`Backend: ${WS_URL}\n`);

  for (let i = 1; i <= JUMLAH_UJI; i++) {
    await ukurSekali(i);
    if (i < JUMLAH_UJI) await new Promise((r) => setTimeout(r, JEDA_MS));
  }

  if (hasil.length === 0) {
    console.log('\n⚠️ Tidak ada data. Pastikan ada trip "berjalan" (jalankan seed) & paket PKT-01 ada di manifest.');
    process.exit(1);
  }

  const avg = (key) => Math.round(hasil.reduce((s, r) => s + r[key], 0) / hasil.length);
  console.log('\n──────────────────────────────────────────────');
  console.log('RATA-RATA:');
  console.log(`  Δt ESP32→MQTT Broker   : ${avg('col1')} ms`);
  console.log(`  Δt MQTT→Dashboard      : ${avg('col2')} ms`);
  console.log(`  Δt TOTAL               : ${avg('total')} ms`);
  const lulus = avg('total') <= 2000;
  console.log(`\n  Kriteria (≤ 2000 ms)   : ${lulus ? '✅ LULUS' : '❌ GAGAL'} (${avg('total')} ms)`);
  console.log('──────────────────────────────────────────────\n');

  mqttClient.end();
  socket.disconnect();
  process.exit(0);
}

// Mulai setelah kedua koneksi siap (warmup 1.5s agar join room selesai)
let ready = 0;
const start = () => { if (++ready === 2) setTimeout(jalankan, 1500); };
socket.on('connect', start);
mqttClient.on('connect', () => { console.log('[MQTT] ESP32-sim terhubung ke broker'); start(); });
