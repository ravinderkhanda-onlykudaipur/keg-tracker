// routes/events.js
// This is the heart of the system: every QR scan submission lands here.
// It validates the role/transition against the state machine, checks any
// cooldown rule (lib/cooldown.js), and writes an immutable event row,
// updating the keg's current status/location (and, for
// 'assign_destination', its destination too - see below. That action
// also moves the keg straight to 'dispatched': Warehouse assigning a
// destination IS the dispatch, there's no separate driver-initiated step).
//
// requireAuth ensures req.user comes from the server-side session, not
// from anything the client claims in the request body - so this endpoint
// can no longer be called pretending to be a different user.

const express = require('express');
const db = require('../db');
const { validateTransition } = require('../lib/stateMachine');
const { requireAuth } = require('../middleware/requireAuth');
const { checkCooldown } = require('../lib/cooldown');

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

  // A minimum time gap before certain actions can repeat on this keg -
  // see lib/cooldown.js for why (e.g. a keg can't realistically be
  // "empty at customer" moments after being delivered full; Warehouse's
  // location log shouldn't be spammable in an unbounded loop). Duration
  // is set via ACTION_COOLDOWN_MS - short for testing, longer for real use.
  const cooldown = checkCooldown(db, kegId, actionType);
  if (cooldown.blocked) {
    return res.status(429).json({ error: cooldown.error }); // 429 Too Many Requests
  }

  // Guard against an empty/blank destination being "assigned" - without
  // this, submitting the form blank would silently succeed (a logged
  // event with no actual effect) while ALSO moving the keg to
  // 'dispatched' with no real destination attached to it, since this
  // action drives the status transition too now. The frontend also
  // validates this (see checkRequiredFields() in scan.html), but the
  // server is the real authority here, not just a UI nicety.
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
    const nextStatus = result.nextStatus || keg.status; // falls back if an action's rule has no status change (none currently do, but keeps this safe if one's added later)

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
