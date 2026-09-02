// routes/devices.js
// Lets Admin see and act on device registration for the operational
// roles - approve a pending request, revoke an already-approved device,
// or dismiss a request without approving it. Manager can view but not act
// on anything here (same read-only split as the rest of the admin page).
//
// Keyed by user_id now (not role) - see lib/deviceAuth.js for why. Each
// row is joined to users to show who it actually belongs to.

const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { DEVICE_GATED_ROLES } = require('../lib/deviceAuth');

const router = express.Router();

router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  const { rows: registered } = await pool.query(`
    SELECT dr.id, dr.user_id, dr.device_id, dr.device_label, dr.registered_at,
           u.name AS user_name, u.role AS user_role
    FROM device_registrations dr
    JOIN users u ON u.id = dr.user_id
    ORDER BY dr.registered_at DESC
  `);
  const { rows: pending } = await pool.query(`
    SELECT r.id, r.user_id, r.device_id, r.requested_at,
           u.name AS user_name, u.role AS user_role
    FROM device_approval_requests r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.requested_at DESC
  `);
  res.json({ registered, pending, gatedRoles: DEVICE_GATED_ROLES });
});

router.post('/approve', requireRole('admin'), async (req, res) => {
  const { userId, deviceId, label } = req.body || {};
  if (typeof userId !== 'string' || typeof deviceId !== 'string' || !userId || !deviceId) {
    return res.status(400).json({ error: 'userId and deviceId are required' });
  }
  await pool.query(`
    INSERT INTO device_registrations (user_id, device_id, device_label) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, device_id) DO NOTHING
  `, [userId, deviceId, (typeof label === 'string' && label.trim()) ? label.trim() : null]);
  await pool.query('DELETE FROM device_approval_requests WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  res.json({ ok: true });
});

router.post('/revoke', requireRole('admin'), async (req, res) => {
  const { userId, deviceId } = req.body || {};
  if (typeof userId !== 'string' || typeof deviceId !== 'string' || !userId || !deviceId) {
    return res.status(400).json({ error: 'userId and deviceId are required' });
  }
  await pool.query('DELETE FROM device_registrations WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  res.json({ ok: true });
});

router.post('/dismiss', requireRole('admin'), async (req, res) => {
  const { userId, deviceId } = req.body || {};
  if (typeof userId !== 'string' || typeof deviceId !== 'string' || !userId || !deviceId) {
    return res.status(400).json({ error: 'userId and deviceId are required' });
  }
  await pool.query('DELETE FROM device_approval_requests WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  res.json({ ok: true });
});

// Clears every pending request at once - useful after a burst of stale
// attempts. Optionally scoped to one user via { userId } in the body;
// omitting it clears pending requests for everyone.
router.post('/dismiss-all', requireRole('admin'), async (req, res) => {
  const { userId } = req.body || {};
  if (userId && typeof userId === 'string') {
    const result = await pool.query('DELETE FROM device_approval_requests WHERE user_id = $1', [userId]);
    return res.json({ ok: true, cleared: result.rowCount });
  }
  const result = await pool.query('DELETE FROM device_approval_requests');
  res.json({ ok: true, cleared: result.rowCount });
});

module.exports = router;
