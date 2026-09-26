const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const morgan = require('morgan');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
// Configure CORS more explicitly; allow local frontend override via env
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(morgan('combined'));

// Usage logging middleware: record incoming API requests
try {
  const usageLogger = require('./middleware/usageLogger');
  app.use('/api', usageLogger);
} catch (e) {
  console.warn('Could not attach usageLogger middleware', e && e.message);
}

// Serve frontend static files from the `frontend` folder
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Database connection (use centralized connector which logs and exits on failure)
const connectDB = require('./config/database');

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/pois', require('./routes/pois'));
app.use('/api/routes', require('./routes/routes'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/usage', require('./routes/usage'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'DTU Campus Navigation Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Static POI data endpoint (MUST be before SPA fallback)
app.get('/all_pois.json', (req, res) => {
  try {
    const pois = require('./data/all_pois');
    res.json(pois);
  } catch (e) {
    console.error('Failed to load POIs from file', e);
    res.status(500).json({ error: 'Failed to load POIs' });
  }
});

// Fallback: serve frontend index for any non-API route (SPA support)
// (MUST be after all API routes and static endpoints)
app.get(/^((?!\/api).)*$/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Socket.io for real-time features
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-user', (userId) => {
    socket.join(`user-${userId}`);
    console.log(`User ${userId} joined their room`);
  });

  socket.on('join-admin', () => {
    socket.join('admin-room');
    console.log('Admin joined admin room');
  });

  socket.on('join-broadcast', () => {
    socket.join('broadcast-room');
    console.log(`User ${socket.id} joined broadcast room`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Make io available to routes
app.set('io', io);

const PORT = parseInt(process.env.PORT, 10) || 5000;

// Start server
(async () => {
  try {
    await connectDB();
  } catch (err) {
    console.warn('DB connection failed, proceeding with file fallbacks', err && err.message);
  }

  server.listen(PORT);

  server.on('listening', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Socket.IO server ready for real-time connections`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Try changing PORT or stop the process using it.`);
      process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
  });
})();

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down server');
  server.close(() => {
    mongoose.disconnect().finally(() => process.exit(0));
  });
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down server');
  server.close(() => {
    mongoose.disconnect().finally(() => process.exit(0));
  });
});