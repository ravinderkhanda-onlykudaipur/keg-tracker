// routes/tasks.js
// Personal to-do list, scoped to the logged-in user's own tasks only -
// every query below filters by req.user.id, not just the frontend
// hiding other users' tasks, so this is a real guarantee, not a UI nicety.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, text, completed, created_at FROM tasks WHERE user_id = $1 ORDER BY completed ASC, created_at DESC',
    [req.user.id]
  );
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Task text is required.' });

  const { rows } = await pool.query(
    'INSERT INTO tasks (user_id, text) VALUES ($1, $2) RETURNING id, text, completed, created_at',
    [req.user.id, text]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const { completed } = req.body || {};
  if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed (boolean) is required.' });

  const { rows } = await pool.query(
    'UPDATE tasks SET completed = $1 WHERE id = $2 AND user_id = $3 RETURNING id, text, completed, created_at',
    [completed, req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  res.json(rows[0]);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM tasks WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Task not found.' });
  res.status(204).send();
});

module.exports = router;
