require('dotenv').config();

// Fail fast: tanpa JWT_SECRET semua verifikasi token tidak aman/error
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET belum diset atau terlalu pendek (min 16 karakter). Periksa file .env');
  process.exit(1);
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');
const { initSocket } = require('./socket/socketHandler');
const { initMqtt } = require('./mqtt/mqttHandler');
const { setIo: setTripIo } = require('./controllers/tripController');
const { initRetentionJob } = require('./jobs/retentionJob');

// Routes
const authRoutes = require('./routes/auth');
const manifestRoutes = require('./routes/manifest');
const tripRoutes = require('./routes/trip');
const armadaRoutes = require('./routes/armada');
const trackingRoutes  = require('./routes/tracking');
const resourceRoutes  = require('./routes/resources');
const adminRoutes     = require('./routes/admin');

const app = express();
const server = http.createServer(app);

// ────────────────────────────────
//  CORS: whitelist + pola devtunnels (untuk testing dari HP via VSCode port forward)
// ────────────────────────────────
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  // izinkan request tanpa origin (Postman, curl, server-to-server)
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    // izinkan semua subdomain VSCode dev tunnels (*.devtunnels.ms)
    if (/\.devtunnels\.ms$/.test(hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    callback(new Error(`Not allowed by CORS: ${origin}`));
  },
};

// Socket.io
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    methods: ['GET', 'POST'],
  },
});

// ────────────────────────────────
//  Middleware global
// ────────────────────────────────
// Di belakang reverse proxy (Railway/devtunnels) — perlu agar rate limiter
// membaca IP asli klien dari X-Forwarded-For, bukan IP proxy
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit global: 300 request / 15 menit per IP untuk semua endpoint API
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak request. Coba lagi beberapa saat.' },
}));

// ────────────────────────────────
//  Routes
// ────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/manifests', manifestRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/armada', armadaRoutes);
app.use('/api/tracking',  trackingRoutes);  // publik
app.use('/api/resources', resourceRoutes); // admin only
app.use('/api/admin', adminRoutes);        // admin only

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// Global error handler (harus paling bawah)
app.use(errorHandler);

// ────────────────────────────────
//  Inisialisasi WebSocket & MQTT
// ────────────────────────────────
initSocket(io);
initMqtt(io);
setTripIo(io);
initRetentionJob();

// ────────────────────────────────
//  Jalankan server
// ────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 VTS Backend berjalan di http://localhost:${PORT}`);
  console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database    : ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log(`   MQTT Broker : ${process.env.MQTT_BROKER_URL}`);
});

module.exports = { app, server };
