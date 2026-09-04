// lib/alerts.js
// Flags kegs that have been sitting in a given status too long without
// the next expected action happening - e.g. not washed within 2 days of
// being returned empty. A keg's "time in its current status" is taken as
// the time since its most recent event (since every status change
// happens via an event, that's exactly when it entered the status it's
// in now) - or the keg's own created_at if it has no events yet.
//
// Each threshold is configurable via its own environment variable, in
// HOURS (easy to set to something small like "0.1" for testing without
// touching code), defaulting to a realistic production value if unset -
// same pattern as ACTION_COOLDOWN_MS in lib/cooldown.js.

const { toDate } = require('./cooldown');

function getHoursEnv(name, defaultHours) {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (raw && !isNaN(parsed) && parsed >= 0) return parsed;
  return defaultHours;
}

// Maps a status to: how many hours a keg may sit in it before being
// flagged, which role should be alerted, and a short human label.
const ALERT_RULES = {
  // Mover is now the central hub - empty_returned means "returned, but
  // not yet allotted to Washer", so the alert for sitting too long here
  // targets Mover, not Washer (who can't act on it until it's
  // allotted).
  empty_returned:       { hours: () => getHoursEnv('ALERT_ALLOT_WASH_HOURS', 24),  role: 'warehouse', label: 'not allotted to washer yet' },
  // Each operational role now has a separate "receive" step before
  // their actual work (confirming physical custody of a keg is a
  // different thing from being notified about it - see
  // lib/stateMachine.js) - so the "hasn't done their job yet" alerts
  // below now split into two: a short-fuse one for "hasn't even
  // scanned to receive it", and the original-style one for "received
  // it but hasn't actually done the work".
  allotted_washer:      { hours: () => getHoursEnv('ALERT_RECEIVE_WASH_HOURS', 6), role: 'washer',    label: 'not received yet' },
  received_washer:      { hours: () => getHoursEnv('ALERT_WASH_HOURS', 48),        role: 'washer',    label: 'not washed yet' },
  washed:                { hours: () => getHoursEnv('ALERT_RECEIVE_FILL_HOURS', 6), role: 'filler',    label: 'not received yet' },
  received_filler:       { hours: () => getHoursEnv('ALERT_FILL_HOURS', 48),        role: 'filler',    label: 'not filled yet' },
  // Mirrors empty_returned above, for the clean-stock side: Mover is
  // holding a washed keg and hasn't released it to Filler yet.
  clean_storage:         { hours: () => getHoursEnv('ALERT_ALLOT_FILL_HOURS', 24),  role: 'warehouse', label: 'not allotted to filler yet' },
  filled:                { hours: () => getHoursEnv('ALERT_DISPATCH_HOURS', 120),   role: 'warehouse', label: 'not dispatched yet' },
  dispatched:            { hours: () => getHoursEnv('ALERT_RECEIVE_DELIVERY_HOURS', 6), role: 'driver', label: 'not received yet' },
  received_driver:       { hours: () => getHoursEnv('ALERT_DELIVERY_HOURS', 12),    role: 'driver',    label: 'not delivered yet' },
  // These two didn't have rules at all before - the exact gap that
  // prompted this: a keg sitting at a customer has no staff member
  // actively holding it, so without a rule here, an overlooked keg
  // could sit indefinitely with no signal at all. Defaults are a
  // starting guess (a week for a normal in-use rental, a day for an
  // already-empty keg waiting on pickup) - worth tuning via the env
  // vars to whatever a normal rental period actually looks like for
  // this business.
  delivered:             { hours: () => getHoursEnv('ALERT_CUSTOMER_HOURS', 168),   role: 'driver',    label: 'still with customer' },
  // Targets Driver, not Warehouse - Driver is the one who carries the
  // empty keg back and hands it to Mover now (rather than Mover going
  // out to collect it), so Driver is who's actually responsible for
  // this phase taking too long.
  empty_at_customer:     { hours: () => getHoursEnv('ALERT_PICKUP_HOURS', 24),      role: 'driver',    label: 'pending at driver, not yet returned' },
  // Mover has confirmed receipt of the empty keg from Driver, but
  // hasn't yet decided where it goes (Uncleaned storage vs. straight
  // to Washer) - the same short-fuse pattern as the other receive
  // steps, since this decision should be quick once they're physically
  // holding it.
  received_from_driver:  { hours: () => getHoursEnv('ALERT_ROUTE_RETURN_HOURS', 6), role: 'warehouse', label: 'received, not yet routed' },
  needs_repair:          { hours: () => getHoursEnv('ALERT_REPAIR_HOURS', 24),      role: 'warehouse', label: 'awaiting repair' },
};

// Returns an array of overdue kegs: [{ kegId, manufacturingNumber,
// status, role, label, statusSince, hoursInStatus, hoursOverdue },
// ...]. `db` is the pg Pool, passed in (not required here) to keep this
// easy to unit test. manufacturingNumber is included here regardless of
// caller - routes/alerts.js is responsible for stripping it out for
// non-Admin/Manager requesters, same access rule as routes/kegs.js.
//
// The GROUP BY k.id here is valid Postgres even though k.status and
// k.created_at aren't aggregated - since k.id is kegs' primary key,
// Postgres allows selecting other columns from the same table via
// functional dependency (SQL:2003), no need to list every column.
async function getOverdueKegs(db) {
  const { rows } = await db.query(`
    SELECT k.id, k.manufacturing_number, k.status, k.created_at AS keg_created_at,
           MAX(e.created_at) AS last_event_at
    FROM kegs k
    LEFT JOIN events e ON e.keg_id = k.id
    GROUP BY k.id
  `);

  const now = Date.now();
  const overdue = [];

  for (const row of rows) {
    const rule = ALERT_RULES[row.status];
    if (!rule) continue;

    const statusSinceVal = row.last_event_at || row.keg_created_at;
    const hoursInStatus = (now - toDate(statusSinceVal).getTime()) / (1000 * 60 * 60);
    const thresholdHours = rule.hours();

    if (hoursInStatus >= thresholdHours) {
      overdue.push({
        kegId: row.id,
        manufacturingNumber: row.manufacturing_number,
        status: row.status,
        role: rule.role,
        label: rule.label,
        statusSince: statusSinceVal,
        hoursInStatus: Math.round(hoursInStatus * 10) / 10,
        hoursOverdue: Math.round((hoursInStatus - thresholdHours) * 10) / 10,
      });
    }
  }

  return overdue;
}

module.exports = { getOverdueKegs, ALERT_RULES, getHoursEnv };
