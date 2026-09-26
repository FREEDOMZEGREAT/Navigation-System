const express = require('express');
const router = express.Router();
const UsageEvent = require('../models/UsageEvent');
const { auth } = require('../middleware/auth');

// Public endpoint to track usage events from the frontend
// Example payload: { eventType: 'page_view', path: '/home', meta: { ref: 'hero' } }
router.post('/track', async (req, res) => {
  try {
    const { eventType, path, meta } = req.body || {};
    if (!eventType) return res.status(400).json({ error: 'eventType is required' });

    const ev = new UsageEvent({
      eventType,
      path: path || req.path,
      meta: meta || {},
      ip: req.ip || req.connection?.remoteAddress || 'unknown',
      userAgent: req.get('User-Agent') || '',
      user: (req.user && req.user._id) || null
    });

    await ev.save();
    res.status(201).json({ message: 'Event recorded' });
  } catch (err) {
    console.error('Usage track error', err);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

module.exports = router;
