// routes/auth.js
// Real auth: hashed passwords (bcrypt) + server-side sessions. The session
// cookie, not anything the client claims in a request body, is what
// determines who's logged in - see middleware/requireAuth.js. Also where
// device registration (lib/deviceAuth.js) is checked, after the password
// - only for the four operational roles, see that file for why.
//
// Password changes are Admin-only now (routes/users.js's reset-password) -
// self-service change-password was removed on request; users tell an
// Admin if they need a new one.

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { checkAndRegisterDevice } = require('../lib/deviceAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { userId, password, deviceId } = req.body || {};

    // Validate input shape before it ever reaches the database - this is
    // exactly the gap that let a malformed request (e.g. an empty body)
    // crash the whole server: passing `undefined` to a SQLite bind
    // parameter throws, and an unawaited throw inside an async handler
    // becomes an unhandled promise rejection, which kills the Node
    // process. Rejecting bad input cleanly here, plus the try/catch
    // wrapping this whole handler, closes that off for good.
    if (typeof userId !== 'string' || typeof password !== 'string' || !userId) {
      return res.status(400).json({ error: 'userId and password are required' });
    }

    const { rows } = await pool.query(
      'SELECT id, name, role, password_hash, active FROM users WHERE id = $1', [userId]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid user or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid user or password' });

    // Checked only after a correct password - this way a random
    // unauthenticated request can't confirm an account exists (and its
    // active/inactive status) just by guessing usernames.
    if (!user.active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact an Admin.' });
    }

    // Device check also runs only after a correct password - same
    // reasoning: don't let guessing usernames probe which roles are
    // device-gated or spam pending-approval log entries.
    const deviceCheck = await checkAndRegisterDevice(pool, user.role, deviceId, user.id);
    if (!deviceCheck.allowed) {
      return res.status(403).json({
        error: deviceCheck.pending
          ? `This device isn't approved for the ${user.role} role yet. An Admin needs to approve it from the Devices section on the admin page.`
          : `Could not identify this device - try reloading the page and logging in again.`,
      });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed, try again' });
      req.session.user = { id: user.id, name: user.name, role: user.role };
      res.json(req.session.user);
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in - try again' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json(req.session.user || null);
});

router.get('/users', async (req, res) => {
  // Only active users show in the login dropdown - a deactivated
  // account shouldn't even look selectable.
  const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active = true ORDER BY role');
  res.json(rows);
});

module.exports = router;
