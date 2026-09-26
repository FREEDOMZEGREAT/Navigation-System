const express = require('express');
const Feedback = require('../models/Feedback');
const POI = require('../models/POI');
const Notification = require('../models/Notification');
const { auth, adminAuth } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validation');
const { body } = require('express-validator');

const router = express.Router();

// Simple in-memory rate limiter for public feedback submissions (per IP)
const publicRateLimit = new Map();
const RATE_LIMIT_MAX = 5; // max submissions
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Submit feedback
router.post('/', [
  auth,
  body('type').isIn(['general', 'bug', 'suggestion', 'complaint', 'praise']).withMessage('Valid type is required'),
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required')
], handleValidationErrors, async (req, res) => {
  try {
    let { type, title, message, rating, relatedPOI, isPublic } = req.body;

    // If relatedPOI is provided as a string name (e.g. 'auditorium'), try to resolve to POI._id
    if (relatedPOI && typeof relatedPOI === 'string') {
      // try find by exact _id first
      try {
        const possible = await POI.findById(relatedPOI).select('_id').lean();
        if (possible && possible._id) {
          relatedPOI = possible._id;
        } else {
          // fallback: find by name (case-insensitive)
          const byName = await POI.findOne({ name: { $regex: `^${relatedPOI}$`, $options: 'i' } }).select('_id').lean();
          if (byName && byName._id) relatedPOI = byName._id;
          else relatedPOI = undefined; // not resolvable
        }
      } catch (e) {
        relatedPOI = undefined;
      }
    }

    const feedback = new Feedback({
      user: req.user._id,
      type,
      title,
      message,
      rating: rating || undefined,
      relatedPOI: relatedPOI || undefined,
      isPublic: isPublic || false
    });

    await feedback.save();

    // Populate user details for response
    await feedback.populate('user', 'username');
    if (relatedPOI) {
      await feedback.populate('relatedPOI', 'name building');
    }

    // Notify admins via socket.io
    const io = req.app.get('io');
    io.to('admin-room').emit('new-feedback', {
      feedback: feedback
    });

    // Send a thank-you notification to the submitting user (if authenticated)
    try {
      if (req.user && req.user._id) {
        const Notification = require('../models/Notification');
        const thank = new Notification({
          user: req.user._id,
          title: 'Thank you for your feedback',
          message: `We received your feedback titled "${title}". Thank you for helping us improve.`,
          type: 'feedback',
          priority: 'low'
        });
        await thank.save();
        if (io) {
          try { io.to(`user-${req.user._id}`).emit('new-notification', { notification: thank }); } catch (e) {}
        }
      }
    } catch (notifyErr) {
      console.warn('Failed to create thank-you notification', notifyErr);
    }

    res.status(201).json({
      message: 'Feedback submitted successfully',
      feedback
    });
  } catch (error) {
    console.error('Submit feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Public feedback submission (no auth required) - allows anonymous feedback
router.post('/public', [
  body('type').isIn(['general', 'bug', 'suggestion', 'complaint', 'praise']).withMessage('Valid type is required'),
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required')
], handleValidationErrors, async (req, res) => {
  try {
    let { type, title, message, rating, relatedPOI, isPublic, name, email } = req.body;

    // Rate limiting per IP
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = publicRateLimit.get(ip) || { timestamps: [] };
    // remove old timestamps
    entry.timestamps = entry.timestamps.filter(ts => (now - ts) < RATE_LIMIT_WINDOW_MS);
    if (entry.timestamps.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many feedback submissions from this IP. Please try later.' });
    }
    entry.timestamps.push(now);
    publicRateLimit.set(ip, entry);

    // Resolve relatedPOI if provided as name
    if (relatedPOI && typeof relatedPOI === 'string') {
      try {
        const possible = await POI.findById(relatedPOI).select('_id').lean();
        if (possible && possible._id) {
          relatedPOI = possible._id;
        } else {
          const byName = await POI.findOne({ name: { $regex: `^${relatedPOI}$`, $options: 'i' } }).select('_id').lean();
          if (byName && byName._id) relatedPOI = byName._id;
          else relatedPOI = undefined;
        }
      } catch (e) {
        relatedPOI = undefined;
      }
    }

    const feedback = new Feedback({
      user: null,
      type,
      title,
      message,
      rating: rating || undefined,
      relatedPOI: relatedPOI || undefined,
      isPublic: isPublic || false,
      senderName: name || undefined,
      senderEmail: email || undefined
    });

    await feedback.save();

    // Populate for response
    if (relatedPOI) await feedback.populate('relatedPOI', 'name building');

    // Notify admins
    const io = req.app.get('io');
    if (io) io.to('admin-room').emit('new-feedback', { feedback });

    // For anonymous submissions we still return a helpful message; we cannot send a per-user notification.

    res.status(201).json({ message: 'Feedback submitted successfully', feedback });
  } catch (error) {
    console.error('Submit public feedback error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Get user's feedback
router.get('/my-feedback', auth, async (req, res) => {
  try {
    const feedback = await Feedback.find({ user: req.user._id })
      .populate('relatedPOI', 'name building')
      .sort({ createdAt: -1 });

    res.json(feedback);
  } catch (error) {
    console.error('Get user feedback error:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// Get all feedback (Admin only)
router.get('/', adminAuth, async (req, res) => {
  try {
    const { status, type } = req.query;
    
    let filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    const feedback = await Feedback.find(filter)
      .populate('user', 'username email')
      .populate('relatedPOI', 'name building')
      .populate('adminResponse.respondedBy', 'username')
      .sort({ createdAt: -1 });

    res.json(feedback);
  } catch (error) {
    console.error('Get feedback error:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// Update feedback status (Admin only)
router.patch('/:id/status', adminAuth, async (req, res) => {
  try {
    const { status, response } = req.body;

    const updateData = { status };
    
    if (response) {
      updateData.adminResponse = {
        message: response,
        respondedBy: req.user._id,
        respondedAt: new Date()
      };
    }

    const feedback = await Feedback.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('user', 'username email')
     .populate('relatedPOI', 'name building');

    if (!feedback) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    // Send a notification to the feedback owner if authenticated; otherwise store adminResponse and broadcast admin-notify
    try {
      const io = req.app.get('io');
      if (feedback.user) {
        const notif = new Notification({
          user: feedback.user._id || feedback.user,
          title: `Feedback ${feedback.status}`,
          message: response ? `Admin responded: ${response}` : `Your feedback status changed to ${status}`,
          type: 'feedback',
          priority: 'low',
          relatedEntity: feedback._id,
          entityModel: 'Feedback'
        });
        await notif.save();
        if (io) {
          try { io.to(`user-${notif.user}`).emit('new-notification', { notification: notif }); } catch (e) {}
        }
      }

      // also broadcast an admin notify for visibility to admins / users
      if (io) {
        try { io.emit('admin-notify', { title: 'Feedback updated', message: `Feedback "${feedback.title}" status: ${feedback.status}` }); } catch (e) {}
      }
    } catch (err) {
      console.warn('Failed to send feedback notification', err);
    }

    res.json({
      message: 'Feedback status updated successfully',
      feedback
    });
  } catch (error) {
    console.error('Update feedback error:', error);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
});

module.exports = router;