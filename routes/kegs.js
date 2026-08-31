// routes/kegs.js
const express = require('express');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// Create a new keg and generate its QR code. Requires login - the admin
// page will prompt for that. (Read endpoints below stay open since
// scanning/viewing a keg is the first thing that happens before a worker
// logs in on the scan page.)
router.post('/', requireAuth, (req, res) => {
  const { size_liters, material } = req.body;
  const id = 'KEG-' + nanoid(8).toUpperCase();

  db.prepare(`
    INSERT INTO kegs (id, size_liters, material, status, current_location)
    VALUES (?, ?, ?, 'empty_returned', 'warehouse')
  `).run(id, size_liters || null, material || null);

  res.status(201).json({ id });
});

// Fetch a keg's current state + full event history (the audit trail).
router.get('/:id', (req, res) => {
  const keg = db.prepare('SELECT * FROM kegs WHERE id = ?').get(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const events = db.prepare(`
    SELECT e.id, e.action_type, e.role, e.details, e.created_at, u.name AS user_name
    FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.keg_id = ?
    ORDER BY e.created_at ASC
  `).all(req.params.id);

  res.json({
    ...keg,
    history: events.map((e) => ({ ...e, details: JSON.parse(e.details) })),
  });
});

// Generate a scannable QR code image (PNG) for a keg. Point a label
// printer at this URL, or embed it in a batch-print PDF later.
router.get('/:id/qrcode.png', async (req, res) => {
  const keg = db.prepare('SELECT id FROM kegs WHERE id = ?').get(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  // The QR encodes a URL so scanning it on any phone camera opens the
  // scan page directly - no app required.
  const scanUrl = `${req.protocol}://${req.get('host')}/scan.html?keg=${keg.id}`;
  res.type('png');
  QRCode.toFileStream(res, scanUrl, { width: 400, margin: 2 });
});

// Search/list kegs by status and/or free-text id match.
router.get('/', (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM kegs WHERE 1=1';
  const params = [];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (q) {
    sql += ' AND id LIKE ?';
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
