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
const { mapStatusToV2 } = require('../lib/v2/statusMapping');

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
  // edit_destination reuses the exact same customer-lookup logic as
  // assign_destination - it's Mover correcting a wrong customer on a
  // keg that's already dispatched, not a new assignment, but the
  // fields being set are identical either way.
  if (actionType === 'assign_destination' || actionType === 'edit_destination') {
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

  const nextStatus = result.nextStatus || keg.status; // falls back if an action's rule has no status change (edit_destination is exactly this case - see lib/stateMachine.js)

  // 'assign_destination'/'edit_destination' update keg.destination +
  // address + phone + customer_id together; every other action updates
  // keg.location_note as before. Kept as separate columns since they
  // mean different things - "where the keg physically is right now" vs
  // "which customer it's assigned to". Renamed from current_location to
  // location_note when the v2 custody model needed that name for its
  // own entity field (see db.js) - this free-text note (GPS
  // coordinates, "Zone A", etc.) is a different concept entirely.
  const destinationActions = ['assign_destination', 'edit_destination'];
  const nextLocationNote = destinationActions.includes(actionType)
    ? keg.location_note
    : (details?.location || keg.location_note);
  const nextDestination = destinationActions.includes(actionType) ? resolvedDestination : keg.destination;
  const nextDestinationAddress = destinationActions.includes(actionType) ? resolvedDestinationAddress : keg.destination_address;
  const nextDestinationPhone = destinationActions.includes(actionType) ? resolvedDestinationPhone : keg.destination_phone;
  const nextCustomerId = destinationActions.includes(actionType) ? resolvedCustomerId : keg.customer_id;

  // Keeps the v2 custody model in sync with every v1 action, for as
  // long as both coexist - without this, v1 actions (from scan.html)
  // would keep moving `status` forward while `current_location`/
  // `current_condition` stayed frozen at whatever the one-time
  // migration set them to, making scan-v2.html look like kegs never
  // move even though scan.html itself was working correctly. Reuses
  // the exact same status->v2 mapping the migration in db.js uses,
  // imported from a shared module rather than duplicated in both places.
  const v2Fields = mapStatusToV2(nextStatus);

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO events (keg_id, user_id, role, action_type, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [kegId, user.id, user.role, actionType, JSON.stringify(details || {})]);

    await client.query(`
      UPDATE kegs SET
        status = $1, location_note = $2, destination = $3, destination_address = $4, destination_phone = $5, customer_id = $6,
        current_location = $7, warehouse_sublocation = $8, current_condition = $9, pending_handover_to = $10
      WHERE id = $11
    `, [
      nextStatus, nextLocationNote, nextDestination, nextDestinationAddress, nextDestinationPhone, nextCustomerId,
      v2Fields.current_location, v2Fields.warehouse_sublocation || null, v2Fields.current_condition, v2Fields.pending_handover_to || null,
      kegId,
    ]);
  });

  const { rows: updatedRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  res.status(201).json(updatedRows[0]);
});

// Lets Mover (or Admin/Manager) undo the single most recent action on
// a keg, but only when that action was performed by Washer, Filler, or
// Driver - matches the explicit scope of this feature: it's for
// correcting an operational mistake, not a general-purpose undo for
// any action by anyone. Manager gets one further elevation beyond
// Mover: they can also revert Mover's (Warehouse role's) own actions,
// not just Washer/Filler/Driver's - matches Manager's broader
// "everything Mover can do, plus more" role. Rolls the keg's status
// back to whatever it was immediately before that event, by replaying
// every earlier event through the same resolveNextStatus logic
// lib/reports.js already uses for turnover-time stats - there's no
// separate "previous status" column to just read back, so this is the
// correct way to derive it rather than assuming a single hardcoded
// fallback for every action. The original event is never deleted or
// altered - a new 'revert' event is added on top, preserving a
// genuine, complete audit trail of what happened and who corrected
// it, not just what the keg's state ended up being.
router.post('/:kegId/revert', requireRole('admin', 'warehouse', 'manager'), async (req, res) => {
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
  // Manager can additionally revert Warehouse's (Mover's) own actions;
  // everyone else (Mover included, reverting via their own account)
  // stays limited to Washer/Filler/Driver, same as before.
  const revertableRoles = user.role === 'manager'
    ? ['washer', 'filler', 'driver', 'warehouse']
    : ['washer', 'filler', 'driver'];
  if (!revertableRoles.includes(lastEvent.role)) {
    return res.status(409).json({
      error: `The most recent action was performed by ${lastEvent.role} - reverting it isn't supported here.`,
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
