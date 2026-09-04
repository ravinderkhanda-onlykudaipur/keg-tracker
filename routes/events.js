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
const { pool, withTransaction } = require('../db');
const { validateTransition, resolveNextStatus } = require('../lib/stateMachine');
const { requireAuth, requireRole } = require('../middleware/requireAuth');
const { checkCooldown } = require('../lib/cooldown');

const router = express.Router();

router.post('/:kegId/events', requireAuth, async (req, res) => {
  const { kegId } = req.params;
  const { actionType, details } = req.body;
  const user = req.user; // trusted, from session - not from req.body

  const { rows: kegRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  const keg = kegRows[0];
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const result = validateTransition(actionType, user.role, keg.status, details);
  if (!result.ok) {
    return res.status(409).json({ error: result.error }); // 409 Conflict: illegal state transition
  }

  // A minimum time gap before certain actions can repeat on this keg -
  // see lib/cooldown.js for why (e.g. a keg can't realistically be
  // "empty at customer" moments after being delivered full). Duration
  // is set via ACTION_COOLDOWN_MS - short for testing, longer for real use.
  const cooldown = await checkCooldown(pool, kegId, actionType);
  if (cooldown.blocked) {
    return res.status(429).json({ error: cooldown.error }); // 429 Too Many Requests
  }

  // Location is required (not optional) for a driver confirming delivery
  // and for Warehouse receiving an empty keg back - both are meant to
  // record where the keg physically is at that exact moment, so a blank
  // submission would silently lose that. Same pattern as the
  // manufacturing-number and destination guards below/above: the
  // frontend also marks these fields required, but this is the real
  // enforcement, not just a UI nicety.
  const LOCATION_REQUIRED_ACTIONS = ['deliver', 'receive_empty'];
  if (LOCATION_REQUIRED_ACTIONS.includes(actionType) && !(details?.location || '').trim()) {
    return res.status(400).json({ error: 'Location is required.' });
  }

  // Guard against an empty/blank destination being "assigned" - without
  // this, submitting the form blank would silently succeed (a logged
  // event with no actual effect) while ALSO moving the keg to
  // 'dispatched' with no real destination attached to it, since this
  // action drives the status transition too now. The frontend now sends
  // a customer_id (picked from a dropdown, see routes/customers.js)
  // rather than free text - this resolves it to a real customer record's
  // name, address, AND phone for display, and rejects an id that doesn't
  // actually exist. Storing these alongside the name means the driver
  // sees exactly where to go and who to call, not just who - typing
  // this fresh every time would just reintroduce the typo problem
  // customer management was built to fix.
  let resolvedDestination = null;
  let resolvedDestinationAddress = null;
  let resolvedDestinationPhone = null;
  let resolvedCustomerId = null;
  if (actionType === 'assign_destination') {
    const customerId = details?.customer_id;
    if (!customerId) {
      return res.status(400).json({ error: 'A delivery destination (customer) is required.' });
    }
    const { rows: custRows } = await pool.query('SELECT id, name, address, phone FROM customers WHERE id = $1', [customerId]);
    const customer = custRows[0];
    if (!customer) {
      return res.status(400).json({ error: 'Selected customer was not found.' });
    }
    resolvedDestination = customer.name;
    resolvedDestinationAddress = customer.address;
    resolvedDestinationPhone = customer.phone;
    resolvedCustomerId = customer.id;
  }

  const nextStatus = result.nextStatus || keg.status; // falls back if an action's rule has no status change (none currently do, but keeps this safe if one's added later)

  // 'assign_destination' updates keg.destination + address + phone +
  // customer_id together; every other action updates keg.current_location
  // as before. Kept as separate columns since they mean different things
  // - "where the keg physically is right now" vs "which customer it's
  // assigned to".
  const nextLocation = actionType === 'assign_destination'
    ? keg.current_location
    : (details?.location || keg.current_location);
  const nextDestination = actionType === 'assign_destination' ? resolvedDestination : keg.destination;
  const nextDestinationAddress = actionType === 'assign_destination' ? resolvedDestinationAddress : keg.destination_address;
  const nextDestinationPhone = actionType === 'assign_destination' ? resolvedDestinationPhone : keg.destination_phone;
  const nextCustomerId = actionType === 'assign_destination' ? resolvedCustomerId : keg.customer_id;

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO events (keg_id, user_id, role, action_type, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [kegId, user.id, user.role, actionType, JSON.stringify(details || {})]);

    await client.query(`
      UPDATE kegs SET status = $1, current_location = $2, destination = $3, destination_address = $4, destination_phone = $5, customer_id = $6 WHERE id = $7
    `, [nextStatus, nextLocation, nextDestination, nextDestinationAddress, nextDestinationPhone, nextCustomerId, kegId]);
  });

  const { rows: updatedRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  res.status(201).json(updatedRows[0]);
});

// Lets Mover (or Admin) undo the single most recent action on a keg,
// but only when that action was performed by Washer, Filler, or
// Driver - matches the explicit scope of this feature: it's for
// correcting an operational mistake, not a general-purpose undo for
// any action by anyone. Rolls the keg's status back to whatever it was
// immediately before that event, by replaying every earlier event
// through the same resolveNextStatus logic lib/reports.js already uses
// for turnover-time stats - there's no separate "previous status"
// column to just read back, so this is the correct way to derive it
// rather than assuming a single hardcoded fallback for every action.
// The original event is never deleted or altered - a new 'revert'
// event is added on top, preserving a genuine, complete audit trail of
// what happened and who corrected it, not just what the keg's state
// ended up being.
router.post('/:kegId/revert', requireRole('admin', 'warehouse'), async (req, res) => {
  const { kegId } = req.params;
  const user = req.user;

  const { rows: kegRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  const keg = kegRows[0];
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const { rows: events } = await pool.query(
    'SELECT * FROM events WHERE keg_id = $1 ORDER BY created_at ASC, id ASC',
    [kegId]
  );
  if (events.length === 0) {
    return res.status(409).json({ error: 'This keg has no logged actions to revert.' });
  }

  const lastEvent = events[events.length - 1];
  if (!['washer', 'filler', 'driver'].includes(lastEvent.role)) {
    return res.status(409).json({
      error: `The most recent action was performed by ${lastEvent.role}, not Washer/Filler/Driver - reverting it isn't supported here.`,
    });
  }
  if (lastEvent.action_type === 'revert') {
    return res.status(409).json({ error: 'The most recent event on this keg is already a revert - nothing further to undo.' });
  }

  let statusBeforeLastEvent = 'empty_returned'; // every keg starts here if it had no earlier events at all
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i];
    let details = {};
    try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }
    const next = resolveNextStatus(ev.action_type, details);
    if (next) statusBeforeLastEvent = next;
  }

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO events (keg_id, user_id, role, action_type, details)
      VALUES ($1, $2, $3, 'revert', $4)
    `, [kegId, user.id, user.role, JSON.stringify({
      reverted_action_type: lastEvent.action_type,
      reverted_role: lastEvent.role,
      status_before_revert: keg.status,
      status_restored_to: statusBeforeLastEvent,
    })]);

    await client.query('UPDATE kegs SET status = $1 WHERE id = $2', [statusBeforeLastEvent, kegId]);
  });

  const { rows: revertedRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  res.status(201).json(revertedRows[0]);
});

module.exports = router;
