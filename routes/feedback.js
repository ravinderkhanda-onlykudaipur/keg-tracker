// routes/feedback.js
// Anonymous feedback to Admin. Submission never receives, logs, or
// stores req.user's identity anywhere - not in the feedback table
// (see db.js - it has no user_id column at all), not in a log line
// here, nothing. This is permanent and intentional: once submitted,
// there is no way for anyone, including Admin, to trace it back to a
// specific person.
//
// Any logged-in user can submit (requireAuth only, not role-gated) -
// only Admin can read the list back (requireRole('admin') - not
// Manager, per explicit direction: "given directly to admin", unlike
// every other oversight feature in this app which is Admin/Manager).

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Feedback text is required.' });

  await pool.query('INSERT INTO feedback (text) VALUES ($1)', [text]);
  res.status(201).json({ ok: true });
});

router.get('/', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, text, created_at FROM feedback ORDER BY created_at DESC');
  res.json(rows);
});

module.exports = router;
