// lib/stateMachine.js
// Single source of truth for "who can move a keg from what state to what state".
// This is what stops a keg being dispatched before it was ever filled, etc.

const TRANSITIONS = {
  // 'to' can be a plain status string, or a function of the submitted
  // details that picks the status dynamically - used here so a failed
  // wash inspection routes to 'needs_repair' instead of 'washed', which
  // is what actually stops a damaged/failed keg from being fillable
  // (fill only accepts a keg that's 'washed' - see below). Previously
  // the wash action always moved to 'washed' regardless of the
  // inspection result, so a failed inspection had no real consequence.
  wash:                { role: 'washer',    from: ['empty_returned'],
                          to: (details) => (details?.inspection === 'fail' ? 'needs_repair' : 'washed') },
  fill:                { role: 'filler',    from: ['washed'],                         to: 'filled' },
  // Warehouse assigning a destination IS the dispatch - there's no
  // separate driver-initiated "dispatch" step anymore. The driver's
  // first involvement is confirming delivery once it's already dispatched.
  assign_destination:  { role: 'warehouse', from: ['filled'],                         to: 'dispatched' },
  deliver:             { role: 'driver',    from: ['dispatched'],                     to: 'delivered' },
  mark_empty:          { role: 'driver',    from: ['delivered'],                      to: 'empty_at_customer' },
  // Lets a driver flag a keg as damaged at any point while they have
  // it - before or after handing it to the customer - without needing
  // to complete the normal delivery flow first. Routes straight to
  // needs_repair, same destination a failed wash inspection leads to,
  // so it goes through the same Warehouse mark_repaired resolution.
  report_damage:       { role: 'driver',    from: ['dispatched', 'delivered'],        to: 'needs_repair' },
  receive_empty:       { role: 'warehouse', from: ['empty_at_customer'],               to: 'empty_returned' },
  // Resolves a needs_repair keg back into the normal cycle - sent back
  // to empty_returned so it goes through a full wash + inspection again
  // rather than skipping straight to washed.
  mark_repaired:       { role: 'warehouse', from: ['needs_repair'],                    to: 'empty_returned' },
  // No generic "warehouse_move" (log location with no status change)
  // anymore - it had no natural stopping point and was redundant right
  // after receive_empty (which already captures a storage zone). Every
  // status transition Warehouse is responsible for now happens through
  // assign_destination, receive_empty, or mark_repaired, each of which
  // captures something real, not as a free-floating log entry.
};

function validateTransition(actionType, userRole, currentStatus, details) {
  const rule = TRANSITIONS[actionType];
  if (!rule) {
    return { ok: false, error: `Unknown action type: ${actionType}` };
  }
  if (rule.role !== userRole) {
    return { ok: false, error: `Action '${actionType}' requires role '${rule.role}', got '${userRole}'` };
  }
  if (!rule.from.includes(currentStatus)) {
    return {
      ok: false,
      error: `Cannot '${actionType}' a keg in status '${currentStatus}'. Valid prior states: ${rule.from.join(', ')}`,
    };
  }
  const nextStatus = typeof rule.to === 'function' ? rule.to(details) : rule.to;
  return { ok: true, nextStatus }; // nextStatus null means "no status change, location update only"
}

module.exports = { TRANSITIONS, validateTransition };
