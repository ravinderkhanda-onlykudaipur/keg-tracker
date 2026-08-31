// routes/events.js
// This is the heart of the system: every QR scan submission lands here.
// It validates the role/transition against the state machine, writes an
// immutable event row, and updates the keg's current status/location (or,
// for 'assign_destination', its destination instead - see below).
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

  // A driver can't dispatch a keg Warehouse hasn't assigned a delivery
  // destination for yet - the destination has to come from Warehouse,
  // not be typed in by the driver.
  if (actionType === 'dispatch' && !keg.destination) {
    return res.status(409).json({
      error: 'No delivery destination assigned yet - ask Warehouse to assign one before dispatching.',
    });
  }

  // Guard against an empty/blank destination being "assigned" - without
  // this, submitting the form blank would silently succeed (a logged
  // event with no actual effect), leaving the keg still un-assigned but
  // looking like someone already handled it. The frontend also validates
  // this (see checkRequiredFields() in scan.html), but the server is the
  // real authority here, not just a UI nicety.
  if (actionType === 'assign_destination' && !(details?.destination || '').trim()) {
    return res.status(400).json({ error: 'A delivery destination is required.' });
  }

  const insertEvent = db.prepare(`
    INSERT INTO events (keg_id, user_id, role, action_type, details)
    VALUES (?, ?, ?, ?, ?)
  `);

  const updateKeg = db.prepare(`
    UPDATE kegs SET status = ?, current_location = ?, destination = ? WHERE id = ?
  `);

  const tx = () => {
    insertEvent.run(kegId, user.id, user.role, actionType, JSON.stringify(details || {}));
    const nextStatus = result.nextStatus || keg.status; // warehouse_move: status unchanged

    // 'assign_destination' updates keg.destination; every other action
    // updates keg.current_location as before. Kept as two separate
    // columns since they mean different things - "where the keg
    // physically is right now" vs "where Warehouse has assigned it to go".
    const nextLocation = actionType === 'assign_destination'
      ? keg.current_location
      : (details?.location || keg.current_location);
    const nextDestination = actionType === 'assign_destination'
      ? (details?.destination || keg.destination)
      : keg.destination;

    updateKeg.run(nextStatus, nextLocation, nextDestination, kegId);
  };
  db.withTransaction(tx);

  const updated = db.prepare('SELECT * FROM kegs WHERE id = ?').get(kegId);
  res.status(201).json(updated);
});

module.exports = router;
