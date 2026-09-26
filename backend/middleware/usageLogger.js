const UsageEvent = require('../models/UsageEvent');
const jwt = require('jsonwebtoken');

// Lightweight middleware to log API requests to UsageEvent.
// If Authorization header contains a valid JWT, attempt to attach user id to the event.
// Non-blocking: errors are logged but do not affect the response.
module.exports = async function usageLogger(req, res, next) {
  try {
    const ev = {
      eventType: 'api_call',
      path: req.originalUrl || req.url,
      ip: req.ip || req.connection?.remoteAddress || 'unknown',
      userAgent: req.get('User-Agent') || '',
      meta: {
        method: req.method,
        query: req.query || {},
        bodyPresent: req.body && Object.keys(req.body).length > 0
      }
    };

    // Try to decode token and attach user id (best-effort)
    try {
      const auth = req.header('Authorization') || req.headers.authorization;
      if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
        const token = auth.replace('Bearer ', '').trim();
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dtu_campus_secret');
          if (decoded && (decoded.userId || decoded.id || decoded._id)) {
            ev.user = decoded.userId || decoded.id || decoded._id;
          }
        } catch (e) {
          // invalid token - ignore
        }
      }
    } catch (e) {
      // ignore token decode errors
    }

    // Create record but do not await to avoid delaying response
    UsageEvent.create(ev).catch(err => {
      console.warn('usageLogger failed to save event', err && err.message);
    });
  } catch (e) {
    console.warn('usageLogger internal error', e && e.message);
  }

  return next();
};
