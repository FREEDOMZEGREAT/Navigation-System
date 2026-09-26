const express = require('express');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Broadcast = require('../models/Broadcast');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// Get user notifications
// Filters out expired notifications (if expiresAt is set)
router.get('/', auth, async (req, res) => {
  try {
    const { limit = 20, unreadOnly } = req.query;
    
    const now = new Date();
    let filter = { user: req.user._id, $or: [ { expiresAt: null }, { expiresAt: { $gt: now } } ] };
    if (unreadOnly === 'true') {
      filter.isRead = false;
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json(notifications);
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.patch('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ message: 'Notification marked as read', notification });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.post('/mark-all-read', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user._id, isRead: false },
      { isRead: true }
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// Get unread notification count
router.get('/unread/count', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user._id,
      isRead: false
    });

    res.json({ count });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Create notification (Admin only)
router.post('/', adminAuth, async (req, res) => {
  try {
    const { title, message, type = 'system', priority = 'low', userId, expiresHours } = req.body;

    const io = req.app.get('io');

    if (userId) {
      // Send to specific user
      const notification = new Notification({
        user: userId,
        title,
        message,
        type,
        priority
      });

      // apply expiry when provided (hours)
      if (expiresHours && Number(expiresHours) > 0) {
        notification.expiresAt = new Date(Date.now() + Number(expiresHours) * 3600 * 1000);
      }

      await notification.save();

      // Send real-time notification via socket.io
      if (io) io.to(`user-${userId}`).emit('new-notification', { notification });

      return res.status(201).json({ message: 'Notification created successfully', notification });
    }

    // Broadcast to all users: load user ids and create notifications in bulk
    const users = await User.find({}, { _id: 1 }).lean();
    if (!users || users.length === 0) {
      return res.status(400).json({ error: 'No users found to broadcast' });
    }

    // Prepare notification docs (set expiresAt default to 24 hours unless expiresHours provided)
    const expiresAt = (expiresHours && Number(expiresHours) > 0) ? new Date(Date.now() + Number(expiresHours) * 3600 * 1000) : new Date(Date.now() + 24 * 3600 * 1000);
    const docs = users.map(u => ({
      user: u._id,
      title,
      message,
      type,
      priority,
      expiresAt
    }));

    // InsertMany for efficiency
    const created = await Notification.insertMany(docs, { ordered: false });

    // Emit each notification to the corresponding user room (best-effort)
    if (io) {
      created.forEach((notif) => {
        try {
          io.to(`user-${notif.user}`).emit('new-notification', { notification: notif });
        } catch (emitErr) {
          console.warn('Emit to user room failed for', notif.user, emitErr);
        }
      });
      // Also emit a broadcast event for any listeners
      io.emit('broadcast-notification', { title, message, type, priority });
    }

    // Persist a single Broadcast document for public retrieval (so unauthenticated visitors can see recent broadcasts)
    try {
      await Broadcast.create({ title, message, type, priority, expiresAt });
    } catch (bErr) {
      console.warn('Failed to persist broadcast summary', bErr);
    }

    res.status(201).json({ message: `Broadcast sent to ${created.length} users` });
  } catch (error) {
    console.error('Create notification error:', error);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

// Public: get recent broadcasts (no auth required)
router.get('/public/broadcasts', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const now = new Date();
    const broadcasts = await Broadcast.find({ $or: [ { expiresAt: null }, { expiresAt: { $gt: now } } ] })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(broadcasts.map(b => ({ id: b._id, title: b.title, message: b.message, createdAt: b.createdAt })));
  } catch (err) {
    console.error('Get public broadcasts error', err);
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

// Admin: list broadcasts (paginated)
router.get('/admin/broadcasts', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;
    const now = new Date();

    const [total, items] = await Promise.all([
      Broadcast.countDocuments({}),
      Broadcast.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

    res.json({ page, limit, total, items });
  } catch (err) {
    console.error('Admin list broadcasts error', err);
    res.status(500).json({ error: 'Failed to load broadcasts' });
  }
});

// Admin: update a broadcast
router.put('/admin/broadcasts/:id', adminAuth, async (req, res) => {
  try {
    const { title, message, priority, expiresHours } = req.body;
    const update = { };
    if (title) update.title = title;
    if (message) update.message = message;
    if (priority) update.priority = priority;
    if (expiresHours && Number(expiresHours) > 0) update.expiresAt = new Date(Date.now() + Number(expiresHours) * 3600 * 1000);

    const updated = await Broadcast.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!updated) return res.status(404).json({ error: 'Broadcast not found' });

    // Emit update to clients
    try { const io = req.app.get('io'); if (io) io.emit('broadcast-notification', { title: updated.title, message: updated.message, id: updated._id }); } catch (e) {}

    res.json({ message: 'Broadcast updated', broadcast: updated });
  } catch (err) {
    console.error('Update broadcast error', err);
    res.status(500).json({ error: 'Failed to update broadcast' });
  }
});

// Admin: delete a broadcast
router.delete('/admin/broadcasts/:id', adminAuth, async (req, res) => {
  try {
    const removed = await Broadcast.findByIdAndDelete(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Broadcast not found' });
    try { const io = req.app.get('io'); if (io) io.emit('broadcast-deleted', { id: removed._id }); } catch (e) {}
    res.json({ message: 'Broadcast deleted' });
  } catch (err) {
    console.error('Delete broadcast error', err);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// Admin: Send notification with countdown (enhanced endpoint)
router.post('/send', adminAuth, async (req, res) => {
  try {
    const { title, message, duration = 60, type = 'broadcast', priority = 'high' } = req.body;

    // Validate input
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    const io = req.app.get('io');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + duration * 1000);

    // Create broadcast notification
    const broadcast = await Broadcast.create({
      title,
      message,
      type,
      priority,
      expiresAt,
      duration,
      adminId: req.user._id
    });

    // Get all users and create notifications
    const users = await User.find({}, { _id: 1 }).lean();
    
    if (users && users.length > 0) {
      const docs = users.map(u => ({
        user: u._id,
        title,
        message,
        type,
        priority,
        expiresAt,
        duration
      }));

      await Notification.insertMany(docs, { ordered: false });

      // Emit to all connected clients
      if (io) {
        io.emit('broadcast-notification', {
          id: broadcast._id,
          title,
          message,
          type,
          priority,
          duration,
          expiresAt: expiresAt.toISOString()
        });
      }
    }

    res.status(201).json({
      message: 'Notification sent successfully',
      broadcast: {
        id: broadcast._id,
        title,
        message,
        duration,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Admin: Get single broadcast details
router.get('/admin/broadcasts/:id', adminAuth, async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'Broadcast not found' });
    res.json(broadcast);
  } catch (err) {
    console.error('Get broadcast error', err);
    res.status(500).json({ error: 'Failed to get broadcast' });
  }
});

// Admin: Get notification statistics
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalBroadcasts = await Broadcast.countDocuments({});
    const totalNotifications = await Notification.countDocuments({});
    const unreadNotifications = await Notification.countDocuments({ isRead: false });
    
    // Get read statistics for each broadcast
    const broadcasts = await Broadcast.find({}).lean();
    const stats = await Promise.all(broadcasts.map(async (b) => {
      const totalUsers = await User.countDocuments({});
      const readCount = await Notification.countDocuments({ 
        title: b.title, 
        isRead: true 
      });
      return {
        broadcastId: b._id,
        title: b.title,
        totalUsers,
        readCount,
        readPercentage: totalUsers > 0 ? Math.round((readCount / totalUsers) * 100) : 0,
        createdAt: b.createdAt
      };
    }));

    res.json({
      totalBroadcasts,
      totalNotifications,
      unreadNotifications,
      stats
    });
  } catch (err) {
    console.error('Get stats error', err);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

module.exports = router;
