const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth, adminAuth } = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validation');
const { body } = require('express-validator');

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'dtu_campus_secret', {
    expiresIn: '30d',
  });
};

// Register (Admin-only)
// Public registration is disabled. Only an admin can create users.
router.post('/register', adminAuth, [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Please include a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], handleValidationErrors, async (req, res) => {
  try {
    const { username, email, password, preferredLanguage } = req.body;

    // Check if user exists
    let user = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (user) {
      return res.status(400).json({
        error: 'User already exists with this email or username'
      });
    }

    // Create user (default role: user)
    user = new User({
      username,
      email,
      password,
      preferredLanguage: preferredLanguage || 'en'
    });

    await user.save();

    res.status(201).json({
      message: 'User created successfully by admin',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        preferredLanguage: user.preferredLanguage
      }
    });
  } catch (error) {
    console.error('Registration (admin-only) error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Setup first admin (run only if no admin exists)
// Disabled by default in production. Enable by setting ALLOW_SETUP_ADMIN=true in `.env`.
router.post('/setup-admin', [
  body('username').isLength({ min: 3 }),
  body('email').isEmail(),
  body('password').isLength({ min: 6 })
], handleValidationErrors, async (req, res) => {
  try {
    if (process.env.ALLOW_SETUP_ADMIN !== 'true') {
      return res.status(403).json({ error: 'Admin setup endpoint is disabled. Enable ALLOW_SETUP_ADMIN in .env to use.' });
    }
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount > 0) {
      return res.status(403).json({ error: 'Admin already exists. Setup not allowed.' });
    }

    const { username, email, password } = req.body;

    let user = await User.findOne({ $or: [{ email }, { username }] });
    if (user) {
      return res.status(400).json({ error: 'User already exists with this email or username' });
    }

    user = new User({
      username,
      email,
      password,
      role: 'admin'
    });

    await user.save();

    const token = generateToken(user._id);

    res.status(201).json({ message: 'Initial admin created', token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ error: 'Server error during admin setup' });
  }
});

// Change password (admin only - change own password)
router.post('/change-password', auth, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], handleValidationErrors, async (req, res) => {
  try {
    // Only admins allowed to change via this route in this app
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    const { currentPassword, newPassword } = req.body;

    // Load full user (including hashed password)
    const fullUser = await User.findById(req.user._id);
    if (!fullUser) return res.status(404).json({ error: 'User not found' });

    const isMatch = await fullUser.comparePassword(currentPassword);
    if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect' });

    fullUser.password = newPassword;
    await fullUser.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Login
router.post('/login', [
  body('username').notEmpty().withMessage('Username or email is required'),
  body('password').notEmpty().withMessage('Password is required')
], handleValidationErrors, async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find user by username or email
    const user = await User.findOne({
      $or: [
        { username: username },
        { email: username }
      ]
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user._id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        preferredLanguage: user.preferredLanguage
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
      preferredLanguage: req.user.preferredLanguage
    }
  });
});

// Admin: list users
router.get('/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('username email role preferredLanguage createdAt');
    res.json({ users });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Admin: basic stats (total users / active users)
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({});
    const activeUsers = await User.countDocuments({ isActive: true });
    res.json({ totalUsers, activeUsers });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve admin stats' });
  }
});

// Admin: update user role
router.patch('/users/:id/role', adminAuth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.role = role;
    await user.save();

    res.json({ message: 'User role updated', user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

module.exports = router;