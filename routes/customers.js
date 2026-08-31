// routes/customers.js
// Turns the previously-unused `customers` table into a real feature.
// Any logged-in role can read the list (Warehouse needs it for the
// destination dropdown when assigning a keg); creating a new customer is
// allowed for Admin (general management) and Warehouse (so they aren't
// blocked mid-workflow the first time they need to deliver somewhere
// new - see the inline "add new customer" flow in scan.html).

const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY name').all());
});

router.post('/', requireRole('admin', 'warehouse'), (req, res) => {
  const { name, address } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }

  const id = 'CUST-' + nanoid(8).toUpperCase();
  const trimmedName = name.trim();
  const trimmedAddress = typeof address === 'string' && address.trim() ? address.trim() : null;

  db.prepare('INSERT INTO customers (id, name, address) VALUES (?, ?, ?)').run(id, trimmedName, trimmedAddress);

  res.status(201).json({ id, name: trimmedName, address: trimmedAddress });
});

module.exports = router;
