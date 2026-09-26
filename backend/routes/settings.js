const express = require('express');
const router = express.Router();
const CampusSetting = require('../models/CampusSetting');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { adminAuth } = require('../middleware/auth');

// GET campus bounds
router.get('/campus-bounds', async (req, res) => {
  try {
    const setting = await CampusSetting.findOne({ key: 'campus' }).lean();
    if (!setting) return res.json({});
    res.json(setting);
  } catch (err) {
    console.error('Get campus bounds error', err);
    res.status(500).json({ error: 'Failed to load campus bounds' });
  }
});

// UPDATE campus bounds (admin only)
router.put('/campus-bounds', adminAuth, async (req, res) => {
  try {
    const { north, south, east, west } = req.body;
    if ([north, south, east, west].some(v => typeof v !== 'number')) {
      return res.status(400).json({ error: 'Bounds must be numbers' });
    }

    const centerLat = (north + south) / 2;
    const centerLng = (east + west) / 2;

    const updated = await CampusSetting.findOneAndUpdate(
      { key: 'campus' },
      { bounds: { north, south, east, west }, center: { lat: centerLat, lng: centerLng } },
      { new: true, upsert: true }
    );

    // emit settings-updated to all clients
    try {
      const io = req.app.get('io');
      if (io) io.emit('settings-updated', { campusGeo: updated.bounds, center: updated.center });

      // Also create a system notification for all users informing them of the campus map update
      try {
        const users = await User.find({}, { _id: 1 }).lean();
        if (users && users.length) {
          const title = 'Campus map updated';
          const message = 'The campus map / bounds have been updated by an administrator. Please refresh to see the changes.';
          const expiresAt = new Date(Date.now() + (24 * 3600 * 1000)); // expire in 24h by default

          const docs = users.map(u => ({
            user: u._id,
            title,
            message,
            type: 'system',
            priority: 'medium',
            expiresAt
          }));

          const created = await Notification.insertMany(docs, { ordered: false });

          // Emit per-user notifications and a broadcast admin-notify
          if (io) {
            created.forEach(n => {
              try { io.to(`user-${n.user}`).emit('new-notification', { notification: n }); } catch (e) { /* ignore */ }
            });
            io.emit('admin-notify', { title: title, message: message });
          }
        }
      } catch (notifyErr) {
        console.warn('Failed to persist/emit campus-bounds notifications', notifyErr);
      }
    } catch (e) { console.warn('Failed to emit settings-updated', e); }

    res.json({ message: 'Campus bounds updated', setting: updated });
  } catch (err) {
    console.error('Update campus bounds error', err);
    res.status(500).json({ error: 'Failed to update campus bounds' });
  }
});

module.exports = router;
