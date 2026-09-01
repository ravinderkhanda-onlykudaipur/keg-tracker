// routes/kegs.js
const express = require('express');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { requireRole } = require('../middleware/requireAuth');

const router = express.Router();

// Only admins can create kegs now - previously any logged-in role could,
// which didn't match "admin can make changes, manager/everyone else can
// only view."
router.post('/', requireRole('admin'), async (req, res) => {
  const { size_liters, material, manufacturing_number } = req.body;
  const id = 'KEG-' + nanoid(8).toUpperCase();
  const mfgNumber = typeof manufacturing_number === 'string' && manufacturing_number.trim()
    ? manufacturing_number.trim()
    : null;

  await pool.query(`
    INSERT INTO kegs (id, manufacturing_number, size_liters, material, status, current_location)
    VALUES ($1, $2, $3, $4, 'empty_returned', 'warehouse')
  `, [id, mfgNumber, size_liters || null, material || null]);

  res.status(201).json({ id, manufacturing_number: mfgNumber });
});

router.get('/:id', async (req, res) => {
  const { rows: kegRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [req.params.id]);
  const keg = kegRows[0];
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const { rows: events } = await pool.query(`
    SELECT e.id, e.action_type, e.role, e.details, e.created_at, u.name AS user_name
    FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.keg_id = $1
    ORDER BY e.created_at ASC
  `, [req.params.id]);

  res.json({
    ...keg,
    history: events.map((e) => ({ ...e, details: JSON.parse(e.details) })),
  });
});

router.get('/:id/qrcode.png', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM kegs WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Keg not found' });

    const scanUrl = `${req.protocol}://${req.get('host')}/scan.html?keg=${rows[0].id}`;
    res.type('png');
    QRCode.toFileStream(res, scanUrl, { width: 400, margin: 2 });
  } catch (err) {
    console.error('QR code generation error:', err);
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

router.get('/', async (req, res) => {
  const { status, q } = req.query;
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    // ILIKE for case-insensitive matching, same behavior SQLite's LIKE
    // gave us by default for ASCII text.
    conditions.push(`id ILIKE $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM kegs ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

module.exports = router;
