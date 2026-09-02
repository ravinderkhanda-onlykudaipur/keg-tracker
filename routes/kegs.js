// routes/kegs.js
const express = require('express');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { requireRole } = require('../middleware/requireAuth');

const router = express.Router();

// Manufacturing number is Admin/Manager only - stripped out for every
// other role, including anyone not logged in at all. Enforced here, not
// just hidden in the UI, since GET /:id and GET / are intentionally left
// open (no requireAuth) for the QR-scan flow - the real guarantee has to
// live server-side or it's not a guarantee.
function canSeeManufacturingNumber(req) {
  return !!req.user && (req.user.role === 'admin' || req.user.role === 'manager');
}
function stripManufacturingNumber(keg) {
  const { manufacturing_number, ...rest } = keg;
  return rest;
}

// Only admins can create kegs now - previously any logged-in role could,
// which didn't match "admin can make changes, manager/everyone else can
// only view."
router.post('/', requireRole('admin'), async (req, res) => {
  const { size_liters, material, manufacturing_number } = req.body;

  // Every physical keg has a manufacturer-stamped serial number - this
  // is required, not optional, so it's always recorded at the moment
  // the system ID and QR code are generated (never added later as an
  // afterthought). Rejecting a blank submission here is the actual
  // enforcement; the frontend also checks this before submitting, but
  // that's just a UI nicety - this is the real guarantee.
  const mfgNumber = typeof manufacturing_number === 'string' ? manufacturing_number.trim() : '';
  if (!mfgNumber) {
    return res.status(400).json({ error: 'Manufacturing keg number is required.' });
  }

  const id = 'KEG-' + nanoid(8).toUpperCase();

  await pool.query(`
    INSERT INTO kegs (id, manufacturing_number, size_liters, material, status, current_location)
    VALUES ($1, $2, $3, $4, 'empty_returned', 'warehouse')
  `, [id, mfgNumber, size_liters || null, material || null]);

  res.status(201).json({ id, manufacturing_number: mfgNumber });
});

// CSV data export - Admin/Manager only, matches the other oversight-level
// features (Reports, Devices, Users). Registered before GET /:id so
// Express doesn't try to match "export.csv" as a keg id.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
router.get('/export.csv', requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM kegs ORDER BY created_at DESC');
  const headers = [
    'id', 'manufacturing_number', 'size_liters', 'material', 'status',
    'current_location', 'destination', 'destination_address', 'destination_phone',
    'customer_id', 'created_at',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kegs-export.csv"');
  res.send(lines.join('\n'));
});

router.get('/:id', async (req, res) => {
  const { rows: kegRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [req.params.id]);
  let keg = kegRows[0];
  if (!keg) return res.status(404).json({ error: 'Keg not found' });
  if (!canSeeManufacturingNumber(req)) keg = stripManufacturingNumber(keg);

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

  const result = canSeeManufacturingNumber(req) ? rows : rows.map(stripManufacturingNumber);
  res.json(result);
});

module.exports = router;
