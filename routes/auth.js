// routes/auth.js
// Real auth: hashed passwords (bcrypt) + server-side sessions. The session
// cookie, not anything the client claims in a request body, is what
// determines who's logged in - see middleware/requireAuth.js.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT id, name, role, password_hash FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Invalid user or password' });

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid user or password' });

  // Regenerate the session on login to avoid session fixation, then store
  // the minimal identity we need on every later request.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed, try again' });
    req.session.user = { id: user.id, name: user.name, role: user.role };
    res.json(req.session.user);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json(req.session.user || null);
});

router.get('/users', (req, res) => {
  // Lets the frontend populate a "who are you" login dropdown. Only
  // exposes id/name/role - never the password hash.
  const users = db.prepare('SELECT id, name, role FROM users ORDER BY role').all();
  res.json(users);
});

module.exports = router;
