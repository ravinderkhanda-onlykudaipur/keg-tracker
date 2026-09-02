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
// Statuses not listed here (delivered, empty_at_customer) have no alert
// defined yet - easy to add later by following the same shape.
const ALERT_RULES = {
  empty_returned: { hours: () => getHoursEnv('ALERT_WASH_HOURS', 48),     role: 'washer',    label: 'not washed yet' },
  washed:         { hours: () => getHoursEnv('ALERT_FILL_HOURS', 48),      role: 'filler',    label: 'not filled yet' },
  filled:         { hours: () => getHoursEnv('ALERT_DISPATCH_HOURS', 120), role: 'warehouse', label: 'not dispatched yet' },
  dispatched:     { hours: () => getHoursEnv('ALERT_DELIVERY_HOURS', 12),  role: 'driver',    label: 'not delivered yet' },
  needs_repair:   { hours: () => getHoursEnv('ALERT_REPAIR_HOURS', 24),    role: 'warehouse', label: 'awaiting repair' },
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
