require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

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

// Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

// ────────────────────────────────
//  Middleware global
// ────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
