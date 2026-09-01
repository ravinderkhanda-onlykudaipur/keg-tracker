// routes/users.js
// Real user account management - replaces the "everyone shares
// demo1234" setup from testing with individual accounts. Deactivating
// (not deleting) is the only way to remove someone's access: events.
// user_id references users.id, so deleting a user with any history
// would either fail (foreign key) or, worse, corrupt the audit trail's
// attribution. Deactivating blocks login while preserving history.

const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { requireRole } = require('../middleware/requireAuth');

const router = express.Router();

const VALID_ROLES = ['filler', 'washer', 'driver', 'warehouse', 'admin', 'manager'];

router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, role, active FROM users ORDER BY role, name');
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { name, role, password } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (typeof role !== 'string' || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'A valid role is required.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const id = 'u-' + nanoid(8).toLowerCase();
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (id, name, role, password_hash, active) VALUES ($1, $2, $3, $4, true)',
    [id, name.trim(), role, hash]
  );
  res.status(201).json({ id, name: name.trim(), role, active: true });
});

router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  const { newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
  const { rows: targetRows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
  const target = targetRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  // Same lockout-avoidance principle as device registration's exemption
  // for admin/manager: never allow deactivating the last active admin,
  // since that would leave nobody able to reactivate anyone, ever.
  if (target.role === 'admin') {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = true"
    );
    if (Number(countRows[0].c) <= 1) {
      return res.status(400).json({
        error: 'Cannot deactivate the last active admin - this would lock everyone out of admin access.',
      });
    }
  }

  await pool.query('UPDATE users SET active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/reactivate', requireRole('admin'), async (req, res) => {
  const result = await pool.query('UPDATE users SET active = true WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

module.exports = router;
