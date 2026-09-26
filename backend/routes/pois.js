const express = require('express');
const POI = require('../models/POI');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { auth, adminAuth } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validation');
const { body } = require('express-validator');

const router = express.Router();

// Fallback POIs loaded from file for offline or initial mode
let fallbackPOIs = [];
try {
  fallbackPOIs = require('../data/all_pois');
} catch (e) {
  console.warn('Could not load fallback POIs file', e && e.message);
}

function mapFallbackToPoi(p) {
  if (!p) return null;
  return {
    _id: p._id || `fallback-${p.id || (p.name && p.name.replace(/\s+/g,'_').toLowerCase())}`,
    name: p.name || p.id,
    description: p.description || '',
    building: p.building || p.name || '',
    category: (p.category && String(p.category).toLowerCase()) || 'services',
    latitude: Number(p.latitude) || 0,
    longitude: Number(p.longitude) || 0,
    floor: p.floor || p.room || undefined,
    room: p.room || undefined,
    opening_hours: p.opening_hours || undefined,
    tags: Array.isArray(p.tags) ? p.tags : [],
    isActive: p.isActive !== undefined ? p.isActive : true,
    translations: p.translations || {},
    location: { type: 'Point', coordinates: [Number(p.longitude) || 0, Number(p.latitude) || 0] }
  };
}

// Get all POIs
router.get('/', async (req, res) => {
  try {
    const { category, search, limit = 50 } = req.query;
    
    let filter = { isActive: true };
    
    if (category && category !== 'all') {
      filter.category = category;
    }
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { building: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    try {
      const pois = await POI.find(filter)
        .limit(parseInt(limit))
        .sort({ name: 1 });

      if (pois && pois.length) return res.json(pois);
    } catch (dbErr) {
      console.warn('Database POI fetch failed, falling back to file list', dbErr && dbErr.message);
    }

    // Fallback to file-provided POIs when DB empty or unavailable
    const results = (fallbackPOIs || []).filter(p => p && (p.isActive !== false));
    // apply category/search/limit filters manually
    let filtered = results;
    if (category && category !== 'all') filtered = filtered.filter(p => String((p.category||'')).toLowerCase() === String(category).toLowerCase());
    if (search) {
      const s = String(search).toLowerCase();
      filtered = filtered.filter(p => (p.name||'').toLowerCase().includes(s) || (p.building||'').toLowerCase().includes(s) || (p.description||'').toLowerCase().includes(s));
    }

    filtered = filtered.slice(0, Math.max(0, parseInt(limit)));
    return res.json(filtered.map(mapFallbackToPoi));
  } catch (error) {
    console.error('Get POIs error:', error);
    res.status(500).json({ error: 'Failed to fetch POIs' });
  }
});

// Get POI by ID
router.get('/:id', async (req, res) => {
  try {
    try {
      const poi = await POI.findById(req.params.id);
      if (poi) return res.json(poi);
    } catch (dbErr) {
      console.warn('DB lookup for POI by id failed, trying file fallback', dbErr && dbErr.message);
    }

    // Fallback: try to match by id or name in the fallback file
    const param = req.params.id;
    const found = (fallbackPOIs || []).find(p => String(p.id) === String(param) || String(p.name).toLowerCase() === String(param).toLowerCase());
    if (found) return res.json(mapFallbackToPoi(found));

    return res.status(404).json({ error: 'POI not found' });
  } catch (error) {
    console.error('Get POI error:', error);
    res.status(500).json({ error: 'Failed to fetch POI' });
  }
});

// Get POI by name (case-insensitive) - helpful for frontend name->id mapping
router.get('/by-name', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Missing name query parameter' });

    try {
      const poi = await POI.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
      if (poi) return res.json(poi);
    } catch (dbErr) {
      console.warn('DB lookup for POI by name failed, trying file fallback', dbErr && dbErr.message);
    }

    const found = (fallbackPOIs || []).find(p => String(p.name).toLowerCase() === String(name).toLowerCase());
    if (found) return res.json(mapFallbackToPoi(found));

    return res.status(404).json({ error: 'POI not found' });
  } catch (error) {
    console.error('Get POI by name error:', error);
    res.status(500).json({ error: 'Failed to fetch POI' });
  }
});

// Create POI (Admin only)
router.post('/', [
  adminAuth,
  body('name').notEmpty().withMessage('Name is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('building').notEmpty().withMessage('Building is required'),
  body('category').notEmpty().withMessage('Category is required'),
  body('latitude').isNumeric().withMessage('Valid latitude is required'),
  body('longitude').isNumeric().withMessage('Valid longitude is required')
], handleValidationErrors, async (req, res) => {
  try {
    const poi = new POI({
      ...req.body,
      createdBy: req.user._id
    });

    await poi.save();

    // Notify via socket.io about new POI (admins)
    const io = req.app.get('io');
    if (io) io.to('admin-room').emit('poi-updated', { action: 'created', poi: poi });

    // Create a system notification for all users about the new POI
    try {
      const users = await User.find({}, { _id: 1 }).lean();
      if (users && users.length) {
        const docs = users.map(u => ({
          user: u._id,
          title: `New place added: ${poi.name}`,
          message: `${poi.name} was added to the campus map. Check it out!`,
          type: 'system',
          priority: 'low',
          relatedEntity: poi._id,
          entityModel: 'POI'
        }));

        const created = await Notification.insertMany(docs, { ordered: false });

        // Emit per-user notifications (best-effort)
        created.forEach(n => {
          try { if (io) io.to(`user-${n.user}`).emit('new-notification', { notification: n }); } catch (e) {}
        });

        // Also broadcast a short admin-notify message
        if (io) io.emit('admin-notify', { title: `New place: ${poi.name}`, message: `${poi.name} added to map` });
      }
    } catch (err) {
      console.warn('Failed to create broadcast notifications for new POI', err);
    }

    res.status(201).json(poi);
  } catch (error) {
    console.error('Create POI error:', error);
    res.status(500).json({ error: 'Failed to create POI' });
  }
});

// Update POI (Admin only)
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const poi = await POI.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!poi) {
      return res.status(404).json({ error: 'POI not found' });
    }

    // Notify via socket.io about updated POI
    const io = req.app.get('io');
    if (io) io.emit('poi-updated', { action: 'updated', poi: poi });

    // Notify users about the updated POI (create notifications + emit)
    try {
      const users = await User.find({}, { _id: 1 }).lean();
      if (users && users.length) {
        const docs = users.map(u => ({
          user: u._id,
          title: `Place updated: ${poi.name}`,
          message: `${poi.name} information was updated by admin.`,
          type: 'system',
          priority: 'low',
          relatedEntity: poi._id,
          entityModel: 'POI'
        }));

        const created = await Notification.insertMany(docs, { ordered: false });
        created.forEach(n => { try { if (io) io.to(`user-${n.user}`).emit('new-notification', { notification: n }); } catch (e) {} });
        if (io) io.emit('admin-notify', { title: `Place updated: ${poi.name}`, message: `${poi.name} was updated` });
      }
    } catch (err) {
      console.warn('Failed to create broadcast notifications for updated POI', err);
    }

    res.json(poi);
  } catch (error) {
    console.error('Update POI error:', error);
    res.status(500).json({ error: 'Failed to update POI' });
  }
});

// Delete POI (Admin only)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const poi = await POI.findByIdAndDelete(req.params.id);

    if (!poi) {
      return res.status(404).json({ error: 'POI not found' });
    }

    // Notify via socket.io about deleted POI
    const io = req.app.get('io');
    if (io) io.emit('poi-updated', { action: 'deleted', poiId: req.params.id, poiName: poi.name });

    // Notify users about the deleted POI
    try {
      const users = await User.find({}, { _id: 1 }).lean();
      if (users && users.length) {
        const docs = users.map(u => ({
          user: u._id,
          title: `Place removed: ${poi.name}`,
          message: `${poi.name} has been removed from the campus map.`,
          type: 'system',
          priority: 'low',
          relatedEntity: req.params.id,
          entityModel: 'POI'
        }));

        const created = await Notification.insertMany(docs, { ordered: false });
        created.forEach(n => { try { if (io) io.to(`user-${n.user}`).emit('new-notification', { notification: n }); } catch (e) {} });
        if (io) io.emit('admin-notify', { title: `Place removed: ${poi.name}`, message: `${poi.name} was deleted from map` });
      }
    } catch (err) {
      console.warn('Failed to create broadcast notifications for deleted POI', err);
    }

    res.json({ message: 'POI deleted successfully', poiId: req.params.id });
  } catch (error) {
    console.error('Delete POI error:', error);
    res.status(500).json({ error: 'Failed to delete POI' });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const categories = await POI.distinct('category', { isActive: true });
    res.json(categories);
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

module.exports = router;