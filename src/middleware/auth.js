// JWT check on protected routes + role check (SRS 4.2)
const jwt = require('jsonwebtoken');
const config = require('../config');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.id, role: payload.role, name: payload.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Token is invalid or has expired' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Only ${roles.join(' / ')} can do this` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
