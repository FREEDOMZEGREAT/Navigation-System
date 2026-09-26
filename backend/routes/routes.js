const express = require('express');
const Route = require('../models/Route');
const { auth, adminAuth } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validation');
const { body } = require('express-validator');

const router = express.Router();

// Get all public routes
router.get('/', async (req, res) => {
  try {
    const routes = await Route.find({ isPublic: true })
      .populate('startPOI', 'name')
      .populate('endPOI', 'name')
      .populate('createdBy', 'username')
      .sort({ saveCount: -1 });
    res.json(routes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get route by ID
router.get('/:id', async (req, res) => {
  try {
    const route = await Route.findById(req.params.id)
      .populate('startPOI')
      .populate('endPOI')
      .populate('createdBy', 'username');
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new route (authenticated users)
router.post('/', auth, [
  body('startPOI').isMongoId().withMessage('Valid start POI ID required'),
  body('endPOI').isMongoId().withMessage('Valid end POI ID required'),
  body('distance').isNumeric().withMessage('Distance must be a number'),
  body('estimated_time').isNumeric().withMessage('Estimated time must be a number'),
  body('route_type').optional().isIn(['walking', 'wheelchair', 'shortest', 'scenic']),
  body('path_data.coordinates').optional().isArray(),
  body('isPublic').optional().isBoolean(),
  handleValidationErrors
], async (req, res) => {
  try {
    const routeData = {
      ...req.body,
      createdBy: req.user.id
    };
    const route = new Route(routeData);
    await route.save();
    await route.populate('startPOI', 'name');
    await route.populate('endPOI', 'name');
    res.status(201).json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update route (only creator or admin)
router.put('/:id', auth, [
  body('distance').optional().isNumeric(),
  body('estimated_time').optional().isNumeric(),
  body('route_type').optional().isIn(['walking', 'wheelchair', 'shortest', 'scenic']),
  body('path_data.coordinates').optional().isArray(),
  body('isPublic').optional().isBoolean(),
  handleValidationErrors
], async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    if (route.createdBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this route' });
    }
    Object.assign(route, req.body);
    await route.save();
    await route.populate('startPOI', 'name');
    await route.populate('endPOI', 'name');
    res.json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete route (only creator or admin)
router.delete('/:id', auth, async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    if (route.createdBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this route' });
    }
    await Route.findByIdAndDelete(req.params.id);
    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Increment save count (for popular routes)
router.post('/:id/save', auth, async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }
    route.saveCount += 1;
    await route.save();
    res.json({ message: 'Route save count incremented' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;