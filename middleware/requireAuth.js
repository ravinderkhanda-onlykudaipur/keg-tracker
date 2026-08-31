// middleware/requireAuth.js
// Attaches req.user from the session if logged in. requireAuth() rejects
// unauthenticated requests outright; requireRole(...) additionally checks
// the logged-in user's role matches what the action needs - this is what
// stops someone hitting the API directly and claiming to be a role they
// aren't logged in as.

function attachUser(req, res, next) {
  req.user = req.session.user || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { attachUser, requireAuth, requireRole };
