// lib/v2/alerts.js
// Every alert is keyed directly to one or more of the 28 transition
// IDs in lib/v2/transitionMatrix.js, rather than matched against a
// keg's raw (location, condition) tuple as the first version of this
// module did. Two kinds of alert per transition:
//
// - "notInitiated": the keg sits at this transition's `from` state,
//   nothing pending, and this transition hasn't been started yet.
//   Several transitions can share the same `from` state on purpose
//   (e.g. mover_to_washer and mover_to_warehouse_uncleaned both start
//   from {mover, empty} - Mover has two genuine options). When a keg
//   matches more than one such transition, ALL of them are reported
//   together on a single alert entry for that keg - never picked down
//   to just one, same "never auto-pick" principle as the transition
//   engine itself, and never duplicated into multiple rows either.
// - "awaitingReceipt": the keg has this exact transition pending
//   (pending_handover_transition_id matches), measured from the real
//   pending_handover_initiated_at timestamp - only ever one of these
//   can apply to a keg at a time, since a keg can only have one
//   pending handover at once.
//
// Damage-report transitions (driver/washer/filler_to_mover_damaged)
// have no notInitiated entry - their `from.condition` is null
// (matches any condition), so there's no specific "waiting" duration
// to detect; damage can be reported at any time, not after some
// threshold. They still have an awaitingReceipt entry once reported.

const { toDate } = require('../cooldown');
const { TRANSITION_MATRIX } = require('./transitionMatrix');

function getHoursEnv(name, defaultHours) {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (raw && !isNaN(parsed) && parsed >= 0) return parsed;
  return defaultHours;
}

const ALERT_DEFS = {
  customer_to_driver_pickup:      { notInitiated: { hours: () => getHoursEnv('ALERT_CUSTOMER_HOURS', 168), role: 'driver', label: 'still with customer' } },
  driver_to_customer_delivery:    { notInitiated: { hours: () => getHoursEnv('ALERT_DELIVERY_HOURS', 12), role: 'driver', label: 'not delivered yet' } },

  driver_to_mover_empty: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_PICKUP_HOURS', 24), role: 'driver', label: 'pending at driver, not yet returned' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' },
  },
  driver_to_mover_delivery_failed: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_DELIVERY_HOURS', 12), role: 'driver', label: 'not delivered yet' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' },
  },
  mover_retry_dispatch_after_failed_delivery: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_DELIVERY_FAILED_HOURS', 12), role: 'warehouse', label: 'failed delivery awaiting decision' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_DELIVERY_HOURS', 6), role: 'driver', label: 'not received yet' },
  },
  mover_reclassify_failed_delivery_as_damaged: {
    notInitiated: { hours: () => getHoursEnv('ALERT_DELIVERY_FAILED_HOURS', 12), role: 'warehouse', label: 'failed delivery awaiting decision' },
  },

  mover_to_washer: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_ALLOT_WASH_HOURS', 24), role: 'warehouse', label: 'not routed to washer/storage yet' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_WASH_HOURS', 6), role: 'washer', label: 'not received yet' },
  },
  washer_starts_wash:    { notInitiated: { hours: () => getHoursEnv('ALERT_WASH_HOURS', 48), role: 'washer', label: 'not washed yet' } },
  washer_completes_wash: { notInitiated: { hours: () => getHoursEnv('ALERT_WASH_IN_PROGRESS_HOURS', 6), role: 'washer', label: 'wash in progress too long' } },
  washer_to_mover_cleaned: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_SEND_CLEAN_HOURS', 6), role: 'washer', label: 'cleaned, not yet sent on' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' },
  },
  washer_to_filler_direct: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_SEND_CLEAN_HOURS', 6), role: 'washer', label: 'cleaned, not yet sent on' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_FILL_HOURS', 6), role: 'filler', label: 'not received yet' },
  },

  // Mover<->Warehouse transitions are single-actor now (see
  // transitionMatrix.js's comment on why), so there's no
  // awaitingReceipt rule here anymore - no pending state is ever
  // created for these, so such a rule would be dead code that could
  // never actually fire.
  mover_to_warehouse_uncleaned: {
    notInitiated: { hours: () => getHoursEnv('ALERT_ALLOT_WASH_HOURS', 24), role: 'warehouse', label: 'not routed to washer/storage yet' },
  },
  warehouse_uncleaned_to_mover: {
    notInitiated: { hours: () => getHoursEnv('ALERT_UNCLEANED_STORAGE_HOURS', 72), role: 'warehouse', label: 'sitting in Uncleaned Storage' },
  },

  mover_to_filler: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_ALLOT_FILL_HOURS', 24), role: 'warehouse', label: 'not allotted to filler yet' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_FILL_HOURS', 6), role: 'filler', label: 'not received yet' },
  },
  filler_starts_fill:    { notInitiated: { hours: () => getHoursEnv('ALERT_FILL_HOURS', 48), role: 'filler', label: 'not filled yet' } },
  filler_completes_fill: { notInitiated: { hours: () => getHoursEnv('ALERT_FILL_IN_PROGRESS_HOURS', 6), role: 'filler', label: 'fill in progress too long' } },
  filler_to_mover: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_SEND_FILLED_HOURS', 6), role: 'filler', label: 'filled, not yet sent on' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' },
  },

  mover_to_warehouse_cleaned: {
    notInitiated: { hours: () => getHoursEnv('ALERT_ALLOT_FILL_HOURS', 24), role: 'warehouse', label: 'not allotted to filler yet' },
  },
  warehouse_cleaned_to_mover: {
    notInitiated: { hours: () => getHoursEnv('ALERT_CLEANED_STORAGE_HOURS', 168), role: 'warehouse', label: 'sitting in Cleaned Storage' },
  },

  mover_to_warehouse_filled: {
    notInitiated: { hours: () => getHoursEnv('ALERT_DISPATCH_HOURS', 120), role: 'warehouse', label: 'not dispatched yet' },
  },
  warehouse_filled_to_mover: {
    notInitiated: { hours: () => getHoursEnv('ALERT_FILLED_STORAGE_HOURS', 168), role: 'warehouse', label: 'sitting in Filled Storage' },
  },
  mover_to_driver_dispatch: {
    notInitiated:    { hours: () => getHoursEnv('ALERT_DISPATCH_HOURS', 120), role: 'warehouse', label: 'not dispatched yet' },
    awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_DELIVERY_HOURS', 6), role: 'driver', label: 'not received yet' },
  },

  // No notInitiated - see file header on why damage reports don't have one.
  driver_to_mover_damaged: { awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' } },
  washer_to_mover_damaged: { awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' } },
  filler_to_mover_damaged: { awaitingReceipt: { hours: () => getHoursEnv('ALERT_RECEIVE_MOVER_HOURS', 6), role: 'warehouse', label: 'not received yet' } },

  mover_to_warehouse_damaged: {
    notInitiated: { hours: () => getHoursEnv('ALERT_REPAIR_HOURS', 24), role: 'warehouse', label: 'awaiting repair decision' },
  },
  warehouse_damaged_to_mover: {
    notInitiated: { hours: () => getHoursEnv('ALERT_DAMAGED_STORAGE_HOURS', 72), role: 'warehouse', label: 'sitting in Damaged Storage, unresolved' },
  },
  mover_repairs_damaged_keg: { notInitiated: { hours: () => getHoursEnv('ALERT_REPAIR_HOURS', 24), role: 'warehouse', label: 'awaiting repair decision' } },
};

// Precomputed once at module load: every transition ID whose
// notInitiated rule applies to a given (location, condition,
// warehouse_sublocation), matched the same way the transition engine
// itself matches - null condition means "any", matching the damage-
// report transitions' own from.condition:null convention.
function matchesFromState(t, keg) {
  if (t.from.location !== keg.current_location) return false;
  if (t.from.warehouseSublocation && t.from.warehouseSublocation !== keg.warehouse_sublocation) return false;
  if (t.from.condition !== null && t.from.condition !== keg.current_condition) return false;
  return true;
}

async function getOverdueKegsV2(db) {
  const { rows } = await db.query(`
    SELECT k.id, k.manufacturing_number, k.current_location, k.current_condition,
           k.warehouse_sublocation, k.pending_handover_to, k.pending_handover_transition_id,
           k.pending_handover_initiated_at,
           k.created_at AS keg_created_at, MAX(e.created_at) AS last_event_at
    FROM kegs k
    LEFT JOIN events e ON e.keg_id = k.id AND e.phase IS NOT NULL
    GROUP BY k.id
  `);

  const now = Date.now();
  const overdue = [];

  for (const row of rows) {
    if (row.pending_handover_to) {
      // Awaiting-receipt: exactly one transition can apply, the one
      // actually stored on the keg - looked up directly, not
      // re-derived from current state (same reasoning as
      // confirmHandover() itself - see transitionEngine.js).
      const transitionId = row.pending_handover_transition_id;
      const def = ALERT_DEFS[transitionId]?.awaitingReceipt;
      if (!def || !row.pending_handover_initiated_at) continue;

      const hoursInState = (now - toDate(row.pending_handover_initiated_at).getTime()) / (1000 * 60 * 60);
      const thresholdHours = def.hours();
      if (hoursInState < thresholdHours) continue;

      overdue.push({
        kegId: row.id, manufacturingNumber: row.manufacturing_number,
        transitionIds: [transitionId], currentLocation: row.current_location, currentCondition: row.current_condition,
        role: def.role, label: def.label,
        stateSince: row.pending_handover_initiated_at,
        hoursInState: Math.round(hoursInState * 10) / 10,
        hoursOverdue: Math.round((hoursInState - thresholdHours) * 10) / 10,
      });
      continue;
    }

    // Not-initiated: every transition whose from-state matches, then
    // grouped into ONE alert entry - never one row per matching
    // transition, since that would duplicate the same physical keg
    // across multiple list entries. All matching transitions share
    // the same underlying wait, so the same threshold/role/label
    // apply regardless of which one is listed first; every ID that
    // matched is still reported, in transitionIds.
    const matching = TRANSITION_MATRIX.filter((t) => ALERT_DEFS[t.id]?.notInitiated && matchesFromState(t, row));
    if (!matching.length) continue;

    const def = ALERT_DEFS[matching[0].id].notInitiated;
    const sinceVal = row.last_event_at || row.keg_created_at;
    if (!sinceVal) continue;

    const hoursInState = (now - toDate(sinceVal).getTime()) / (1000 * 60 * 60);
    const thresholdHours = def.hours();
    if (hoursInState < thresholdHours) continue;

    overdue.push({
      kegId: row.id, manufacturingNumber: row.manufacturing_number,
      transitionIds: matching.map((t) => t.id), currentLocation: row.current_location, currentCondition: row.current_condition,
      role: def.role, label: def.label,
      stateSince: sinceVal,
      hoursInState: Math.round(hoursInState * 10) / 10,
      hoursOverdue: Math.round((hoursInState - thresholdHours) * 10) / 10,
    });
  }

  return overdue;
}

module.exports = { getOverdueKegsV2, ALERT_DEFS, getHoursEnv };
