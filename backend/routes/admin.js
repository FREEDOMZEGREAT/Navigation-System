const express = require('express');
const router = express.Router();
const { adminAuth } = require('../middleware/auth');
const Notification = require('../models/Notification');
const User = require('../models/User');
const UsageEvent = require('../models/UsageEvent');

// Demo endpoint to send a broadcast notification (Admin only)
router.post('/demo-notify', adminAuth, async (req, res) => {
  try {
    const { title = 'Demo Broadcast', message = 'This is a demo notification from admin.' } = req.body || {};
    const io = req.app.get('io');

    // create notifications for all users
    const users = await User.find({}, { _id: 1 }).lean();
    if (!users || users.length === 0) return res.status(400).json({ error: 'No users to notify' });

    const docs = users.map(u => ({
      user: u._id,
      title,
      message,
      type: 'system',
      priority: 'low'
    }));

    const created = await Notification.insertMany(docs, { ordered: false });

    // Emit per-user notifications and broadcast an admin-notify
    if (io) {
      created.forEach(n => {
        try { io.to(`user-${n.user}`).emit('new-notification', { notification: n }); } catch (e) { /* ignore */ }
      });
      io.emit('admin-notify', { title, message, demo: true });
    }

    res.status(201).json({ message: `Demo notification broadcasted to ${created.length} users` });
  } catch (err) {
    console.error('Demo notify error', err);
    res.status(500).json({ error: 'Failed to send demo notification' });
  }
});

// Admin usage analytics: aggregated counts for ranges
router.get('/usage', adminAuth, async (req, res) => {
  try {
    const range = req.query.range || 'today'; // today|week|month|year|all
    const now = new Date();

    let start;
    switch (range) {
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        start = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
        break;
      case 'month':
        start = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        break;
      case 'year':
        start = new Date(now.getTime() - (365 * 24 * 60 * 60 * 1000));
        break;
      default:
        start = new Date(0);
    }

    const match = { createdAt: { $gte: start } };

    // total events in range
    const total = await UsageEvent.countDocuments(match);

    // unique users in range
    const uniqueUsersAgg = await UsageEvent.aggregate([
      { $match: match },
      { $group: { _id: '$user' } },
      { $match: { _id: { $ne: null } } },
      { $count: 'uniqueUsers' }
    ]);
    const uniqueUsers = (uniqueUsersAgg[0] && uniqueUsersAgg[0].uniqueUsers) || 0;

    // breakdown by eventType (top 10)
    const breakdown = await UsageEvent.aggregate([
      { $match: match },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);

    res.json({ range, start, total, uniqueUsers, breakdown });
  } catch (err) {
    console.error('Admin usage error', err);
    res.status(500).json({ error: 'Failed to fetch usage analytics' });
  }
});

// Admin timeseries: counts per day for the last N days (default 30)
router.get('/usage/timeseries', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

    const agg = await UsageEvent.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    // Build a continuous array for the last N days (fill zeros)
    const seriesMap = {};
    agg.forEach(item => { seriesMap[item._id] = item.count; });

    const series = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + (i * 24 * 60 * 60 * 1000));
      const key = d.toISOString().slice(0, 10);
      series.push({ date: key, count: seriesMap[key] || 0 });
    }

    res.json({ days, series });
  } catch (err) {
    console.error('usage timeseries error', err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

// Admin: paginated usage events viewer
router.get('/events', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 25);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.eventType) filter.eventType = req.query.eventType;
    if (req.query.user) filter.user = req.query.user;

    const [total, items] = await Promise.all([
      UsageEvent.countDocuments(filter),
      UsageEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'username').lean()
    ]);

    res.json({ page, limit, total, items });
  } catch (err) {
    console.error('admin events error', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Admin stats: total and active users
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({});
    const activeUsers = await User.countDocuments({ isActive: true });
    res.json({ totalUsers, activeUsers });
  } catch (err) {
    console.error('Admin stats (admin router) error', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// Admin metrics: top API routes in last N days
router.get('/metrics', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const start = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));

    const agg = await UsageEvent.aggregate([
      { $match: { createdAt: { $gte: start }, eventType: 'api_call' } },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 }
    ]);

    res.json({ days, top: agg });
  } catch (err) {
    console.error('admin metrics error', err);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

module.exports = router;

