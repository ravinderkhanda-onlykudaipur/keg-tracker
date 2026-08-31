// routes/devices.js
// Lets Admin see and act on device registration for the operational
// roles - approve a pending request, revoke an already-approved device,
// or dismiss a request without approving it. Manager can view but not act
// on anything here (same read-only split as the rest of the admin page).

const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { DEVICE_GATED_ROLES } = require('../lib/deviceAuth');

const router = express.Router();

router.get('/', requireRole('admin', 'manager'), (req, res) => {
  const registered = db.prepare(
    'SELECT * FROM device_registrations ORDER BY role, registered_at DESC'
  ).all();
  const pending = db.prepare(`
    SELECT r.*, u.name AS requested_by_name
    FROM device_approval_requests r
    LEFT JOIN users u ON u.id = r.requested_by_user_id
    ORDER BY r.requested_at DESC
  `).all();
  res.json({ registered, pending, gatedRoles: DEVICE_GATED_ROLES });
});

router.post('/approve', requireRole('admin'), (req, res) => {
  const { role, deviceId, label } = req.body || {};
  if (typeof role !== 'string' || typeof deviceId !== 'string' || !role || !deviceId) {
    return res.status(400).json({ error: 'role and deviceId are required' });
  }
  db.prepare(`
    INSERT OR IGNORE INTO device_registrations (role, device_id, device_label) VALUES (?, ?, ?)
  `).run(role, deviceId, (typeof label === 'string' && label.trim()) ? label.trim() : null);
  db.prepare('DELETE FROM device_approval_requests WHERE role = ? AND device_id = ?').run(role, deviceId);
  res.json({ ok: true });
});

router.post('/revoke', requireRole('admin'), (req, res) => {
  const { role, deviceId } = req.body || {};
  if (typeof role !== 'string' || typeof deviceId !== 'string' || !role || !deviceId) {
    return res.status(400).json({ error: 'role and deviceId are required' });
  }
  db.prepare('DELETE FROM device_registrations WHERE role = ? AND device_id = ?').run(role, deviceId);
  res.json({ ok: true });
});

router.post('/dismiss', requireRole('admin'), (req, res) => {
  const { role, deviceId } = req.body || {};
  if (typeof role !== 'string' || typeof deviceId !== 'string' || !role || !deviceId) {
    return res.status(400).json({ error: 'role and deviceId are required' });
  }
  db.prepare('DELETE FROM device_approval_requests WHERE role = ? AND device_id = ?').run(role, deviceId);
  res.json({ ok: true });
});

module.exports = router;
