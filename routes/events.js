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
const { validateTransition } = require('../lib/stateMachine');
const { requireAuth } = require('../middleware/requireAuth');
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

  // Guard against an empty/blank destination being "assigned" - without
  // this, submitting the form blank would silently succeed (a logged
  // event with no actual effect) while ALSO moving the keg to
  // 'dispatched' with no real destination attached to it, since this
  // action drives the status transition too now. The frontend now sends
  // a customer_id (picked from a dropdown, see routes/customers.js)
  // rather than free text - this resolves it to a real customer record's
  // name AND address for display, and rejects an id that doesn't
  // actually exist. Storing the address alongside the name means the
  // driver sees exactly where to go, not just who - typing the address
  // fresh every time would just reintroduce the typo problem customer
  // management was built to fix.
  let resolvedDestination = null;
  let resolvedDestinationAddress = null;
  let resolvedCustomerId = null;
  if (actionType === 'assign_destination') {
    const customerId = details?.customer_id;
    if (!customerId) {
      return res.status(400).json({ error: 'A delivery destination (customer) is required.' });
    }
    const { rows: custRows } = await pool.query('SELECT id, name, address FROM customers WHERE id = $1', [customerId]);
    const customer = custRows[0];
    if (!customer) {
      return res.status(400).json({ error: 'Selected customer was not found.' });
    }
    resolvedDestination = customer.name;
    resolvedDestinationAddress = customer.address;
    resolvedCustomerId = customer.id;
  }

  const nextStatus = result.nextStatus || keg.status; // falls back if an action's rule has no status change (none currently do, but keeps this safe if one's added later)

  // 'assign_destination' updates keg.destination + address + customer_id
  // together; every other action updates keg.current_location as before.
  // Kept as separate columns since they mean different things - "where
  // the keg physically is right now" vs "which customer it's assigned to".
  const nextLocation = actionType === 'assign_destination'
    ? keg.current_location
    : (details?.location || keg.current_location);
  const nextDestination = actionType === 'assign_destination' ? resolvedDestination : keg.destination;
  const nextDestinationAddress = actionType === 'assign_destination' ? resolvedDestinationAddress : keg.destination_address;
  const nextCustomerId = actionType === 'assign_destination' ? resolvedCustomerId : keg.customer_id;

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO events (keg_id, user_id, role, action_type, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [kegId, user.id, user.role, actionType, JSON.stringify(details || {})]);

    await client.query(`
      UPDATE kegs SET status = $1, current_location = $2, destination = $3, destination_address = $4, customer_id = $5 WHERE id = $6
    `, [nextStatus, nextLocation, nextDestination, nextDestinationAddress, nextCustomerId, kegId]);
  });

  const { rows: updatedRows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  res.status(201).json(updatedRows[0]);
});

module.exports = router;
