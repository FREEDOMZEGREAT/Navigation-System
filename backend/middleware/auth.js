const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token, authorization denied' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dtu_campus_secret');
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) return res.status(401).json({ error: 'Token is not valid' });

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Token is not valid' });
  }
};

// adminAuth checks auth and ensures the user has admin role
const adminAuth = async (req, res, next) => {
  try {
    // Use auth middleware first to populate req.user
    await new Promise((resolve, reject) => {
      auth(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

module.exports = { auth, adminAuth };