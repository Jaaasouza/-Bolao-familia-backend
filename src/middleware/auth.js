const jwt = require('jsonwebtoken');

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  // 30d by default so a token comfortably outlives the ~5-week tournament — an
  // admin (or player) shouldn't get silently logged out mid-Cup. Override with
  // JWT_TTL if a shorter session is ever wanted.
  return jwt.sign(payload, secret, { expiresIn: process.env.JWT_TTL || '30d' });
}

// requireRole('admin') — gate a mutating endpoint behind a JWT bearer token.
// Use on EVERY mutating endpoint (see CLAUDE.md).
function requireRole(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured' });

    try {
      const payload = jwt.verify(token, secret);
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      req.auth = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// Best-effort: if a valid bearer token is present, attach req.auth; otherwise
// just continue unauthenticated. Use to reveal extra fields to admins on an
// otherwise-public endpoint (never to gate access).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const secret = process.env.JWT_SECRET;
  if (token && secret) {
    try { req.auth = jwt.verify(token, secret); } catch { /* ignore — stays public */ }
  }
  next();
}

module.exports = { signToken, requireRole, optionalAuth };
