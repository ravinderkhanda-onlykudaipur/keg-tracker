// routes/events.js
// This is the heart of the system: every QR scan submission lands here.
// It validates the role/transition against the state machine, writes an
// immutable event row, and updates the keg's current status/location.
//
// requireAuth ensures req.user comes from the server-side session, not
// from anything the client claims in the request body - so this endpoint
// can no longer be called pretending to be a different user.

const express = require('express');
const db = require('../db');
const { validateTransition } = require('../lib/stateMachine');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/:kegId/events', requireAuth, (req, res) => {
  const { kegId } = req.params;
  const { actionType, details } = req.body;
  const user = req.user; // trusted, from session - not from req.body

  const keg = db.prepare('SELECT * FROM kegs WHERE id = ?').get(kegId);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const result = validateTransition(actionType, user.role, keg.status);
  if (!result.ok) {
    return res.status(409).json({ error: result.error }); // 409 Conflict: illegal state transition
  }

  const insertEvent = db.prepare(`
    INSERT INTO events (keg_id, user_id, role, action_type, details)
    VALUES (?, ?, ?, ?, ?)
  `);

  const updateKeg = db.prepare(`
    UPDATE kegs SET status = ?, current_location = ? WHERE id = ?
  `);

  const tx = () => {
    insertEvent.run(kegId, user.id, user.role, actionType, JSON.stringify(details || {}));
    const nextStatus = result.nextStatus || keg.status; // warehouse_move: status unchanged
    const nextLocation = details?.location || keg.current_location;
    updateKeg.run(nextStatus, nextLocation, kegId);
  };
  db.withTransaction(tx);

  const updated = db.prepare('SELECT * FROM kegs WHERE id = ?').get(kegId);
  res.status(201).json(updated);
});

module.exports = router;
