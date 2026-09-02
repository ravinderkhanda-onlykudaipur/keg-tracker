// routes/products.js
// Turns Filler's free-text "Beer Name" into a managed list, same
// reasoning as customer management: fewer typos, consistent naming
// (matters for lib/reports.js's getFillStats(), which groups fills by
// exact product name string - "IPA" and "ipa" would otherwise show as
// two different products). Any logged-in role can read the list;
// creating a new product is Admin or Filler (so Filler isn't blocked
// mid-workflow the first time they need a product that doesn't exist
// yet - same inline "add new" pattern as customers).

const express = require('express');
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
  res.json(rows);
});

router.post('/', requireRole('admin', 'filler'), async (req, res) => {
  const { name, default_abv } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required.' });
  }

  let abv = null;
  if (default_abv !== undefined && default_abv !== null && default_abv !== '') {
    const parsed = Number(default_abv);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      return res.status(400).json({ error: 'ABV must be a number between 0 and 100.' });
    }
    abv = parsed;
  }

  const id = 'PROD-' + nanoid(8).toUpperCase();
  const trimmedName = name.trim();
  await pool.query('INSERT INTO products (id, name, default_abv) VALUES ($1, $2, $3)', [id, trimmedName, abv]);

  res.status(201).json({ id, name: trimmedName, default_abv: abv });
});

// Editing is Admin only - same reasoning as customers.js: creating is
// operational (Filler adds a beer they need mid-workflow), correcting
// an existing one is management-level.
router.put('/:id', requireRole('admin'), async (req, res) => {
  const { name, default_abv } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required.' });
  }

  let abv = null;
  if (default_abv !== undefined && default_abv !== null && default_abv !== '') {
    const parsed = Number(default_abv);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      return res.status(400).json({ error: 'ABV must be a number between 0 and 100.' });
    }
    abv = parsed;
  }

  const trimmedName = name.trim();
  const result = await pool.query(
    'UPDATE products SET name = $1, default_abv = $2 WHERE id = $3',
    [trimmedName, abv, req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found.' });

  res.json({ id: req.params.id, name: trimmedName, default_abv: abv });
});

module.exports = router;
