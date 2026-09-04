// lib/stateMachine.js
// Single source of truth for "who can move a keg from what state to what state".
// This is what stops a keg being dispatched before it was ever filled, etc.

const TRANSITIONS = {
  // Mover explicitly releases a returned/stored keg to Washer, rather
  // than Washer being able to act on anything sitting in
  // 'empty_returned' - this is the new "Mover as central hub" step.
  allot_washer:        { role: 'warehouse', from: ['empty_returned'],                    to: 'allotted_washer' },
  // 'to' can be a plain status string, or a function of the submitted
  // details that picks the status dynamically - used here for two
  // independent reasons: a failed wash inspection routes to
  // 'needs_repair' instead of 'washed' (which is what actually stops a
  // damaged/failed keg from being fillable - fill only accepts a keg
  // that's 'washed', see below); and Washer's choice of where a
  // successfully-washed keg goes next - straight to Filler ('washed',
  // unchanged from before) or back to Mover to hold as clean stock
  // ('clean_storage') until Mover decides to release it onward.
  wash:                { role: 'washer',    from: ['allotted_washer'],
                          to: (details) => {
                            if (details?.inspection === 'fail') return 'needs_repair';
                            return details?.next_stop === 'mover' ? 'clean_storage' : 'washed';
                          } },
  // Mirrors allot_washer above, for the clean-stock side of the cycle:
  // Mover releases a washed keg it's been holding to Filler, on
  // whatever schedule Mover chooses, rather than that decision being
  // forced the moment Washer finishes.
  allot_filler:        { role: 'warehouse', from: ['clean_storage'],                     to: 'washed' },
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
  // rather than skipping straight to washed. From there it needs a
  // fresh allot_washer from Mover like any other returned keg.
  mark_repaired:       { role: 'warehouse', from: ['needs_repair'],                    to: 'empty_returned' },
  // No generic "warehouse_move" (log location with no status change)
  // anymore - it had no natural stopping point and was redundant right
  // after receive_empty (which already captures a storage zone). Every
  // status transition Warehouse is responsible for now happens through
  // allot_washer, allot_filler, assign_destination, receive_empty, or
  // mark_repaired, each of which captures something real, not as a
  // free-floating log entry.
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
