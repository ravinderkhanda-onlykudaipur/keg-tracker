// lib/stateMachine.js
// Single source of truth for "who can move a keg from what state to what state".
// This is what stops a keg being dispatched before it was ever filled, etc.

const TRANSITIONS = {
  // Mover explicitly releases a returned/stored keg to Washer, rather
  // than Washer being able to act on anything sitting in
  // 'empty_returned' - this is the "Mover as central hub" step.
  allot_washer:        { role: 'warehouse', from: ['empty_returned'],                    to: 'allotted_washer' },
  // Washer scans to confirm they actually have the keg in hand, before
  // washing it - decouples "Mover told Washer about this keg" from
  // "Washer is holding it right now", so someone can scan through a
  // whole batch of allotted kegs first (confirming custody of each)
  // and come back to actually wash them one at a time whenever they're
  // ready, rather than the allotment and the work being forced into
  // one single action.
  receive_washer:      { role: 'washer',    from: ['allotted_washer'],                   to: 'received_washer' },
  // 'to' can be a plain status string, or a function of the submitted
  // details that picks the status dynamically - used here for two
  // independent reasons: a failed wash inspection routes to
  // 'needs_repair' instead of 'washed' (which is what actually stops a
  // damaged/failed keg from being fillable - fill only accepts a keg
  // that's 'received_filler', see below); and Washer's choice of where
  // a successfully-washed keg goes next - straight to Filler ('washed',
  // unchanged from before) or back to Mover to hold as clean stock
  // ('clean_storage') until Mover decides to release it onward.
  wash:                { role: 'washer',    from: ['received_washer'],
                          to: (details) => {
                            if (details?.inspection === 'fail') return 'needs_repair';
                            return details?.next_stop === 'mover' ? 'clean_storage' : 'washed';
                          } },
  // Mover confirms they're physically holding the clean keg Washer
  // sent their way (instead of straight to Filler), before deciding
  // when to release it onward - mirrors the same notified/received
  // split used at every other handoff into Mover's hands.
  receive_from_washer: { role: 'warehouse', from: ['clean_storage'],                     to: 'received_from_washer' },
  // Mirrors allot_washer above, for the clean-stock side of the cycle:
  // Mover releases a washed keg it's been holding to Filler, on
  // whatever schedule Mover chooses, rather than that decision being
  // forced the moment Washer finishes.
  allot_filler:        { role: 'warehouse', from: ['received_from_washer'],              to: 'washed' },
  // Mirrors receive_washer above - Filler confirms custody before
  // filling, whether the keg reached 'washed' via Washer's direct
  // handoff or Mover's allot_filler release from clean stock.
  receive_filler:      { role: 'filler',    from: ['washed'],                            to: 'received_filler' },
  fill:                { role: 'filler',    from: ['received_filler'],                   to: 'filled' },
  // Mover confirms they're physically holding the filled keg Filler
  // completed, as its own step separate from actually dispatching it
  // (see assign_destination below) - mirrors the same notified/
  // received split used at every other handoff into Mover's hands.
  receive_from_filler: { role: 'warehouse', from: ['filled'],                            to: 'received_from_filler' },
  // Warehouse assigning a destination IS the dispatch - there's no
  // separate driver-initiated "dispatch" step anymore.
  assign_destination:  { role: 'warehouse', from: ['received_from_filler'],              to: 'dispatched' },
  // Lets Mover correct a wrong customer after dispatching, without
  // touching the keg's status or requiring a full revert - `to: null`
  // means "no status change" (same pattern validateTransition already
  // supports for exactly this case). Available up until delivery
  // actually happens - once delivered, changing the destination
  // wouldn't reflect where the keg genuinely went.
  edit_destination:    { role: 'warehouse', from: ['dispatched', 'received_driver'],      to: null },
  // Mirrors receive_washer/receive_filler above - Driver confirms
  // they're actually holding the keg before setting off to deliver it,
  // rather than "assigned" and "in the vehicle" being the same moment.
  receive_driver:      { role: 'driver',    from: ['dispatched'],                        to: 'received_driver' },
  deliver:             { role: 'driver',    from: ['received_driver'],                   to: 'delivered' },
  // Displayed to the user as "Received from Customer" (see scan.html) -
  // the underlying action name stays mark_empty, but this is really
  // Driver confirming they've picked the empty keg back up, not just
  // noting that it's empty while still at the customer's premises.
  mark_empty:          { role: 'driver',    from: ['delivered'],                         to: 'empty_at_customer' },
  // Lets a driver flag a keg as damaged at any point while they
  // actually have physical custody of it - after receiving it and
  // before or after handing it to the customer - without needing to
  // complete the normal delivery flow first. Routes straight to
  // needs_repair, same destination a failed wash inspection leads to,
  // so it goes through the same Warehouse mark_repaired resolution.
  // Deliberately doesn't include plain 'dispatched' - that means
  // assigned but not yet actually in Driver's hands (see
  // receive_driver above), so there's nothing physical yet to report as damaged.
  report_damage:       { role: 'driver',    from: ['received_driver', 'delivered'],      to: 'needs_repair' },
  // Driver's own scan confirming they've physically brought the empty
  // keg to the warehouse (a "receipt" for Mover, in the same sense as
  // every other handoff needing a scan from both sides) - without
  // this, the driver-to-mover handoff was the only one missing its
  // sender-side scan, jumping straight from Driver marking it empty at
  // the customer to Mover being able to confirm receipt, with no
  // record of Driver actually delivering it to the warehouse gate in
  // between.
  return_to_warehouse: { role: 'driver',    from: ['empty_at_customer'],                 to: 'returned_to_warehouse' },
  // Mover confirms they're physically holding the keg Driver brought
  // back, as its own step separate from deciding what happens to it
  // next (see receive_empty below) - mirrors the same
  // notified/received split used for the other three roles above.
  receive_from_driver: { role: 'warehouse', from: ['returned_to_warehouse'],             to: 'received_from_driver' },
  // Mover's choice, now made once they've actually confirmed receipt:
  // put the keg in Uncleaned storage (the default), or send it
  // straight to Washer, skipping the storage stop entirely. Mirrors
  // the wash action's next_stop branch above.
  receive_empty:       { role: 'warehouse', from: ['received_from_driver'],
                          to: (details) => (details?.next_stop === 'washer' ? 'allotted_washer' : 'empty_returned') },
  // Resolves a needs_repair keg back into the normal cycle - sent back
  // to empty_returned so it goes through a full wash + inspection again
  // rather than skipping straight to washed. From there it needs a
  // fresh allot_washer from Mover like any other returned keg.
  mark_repaired:       { role: 'warehouse', from: ['needs_repair'],                      to: 'empty_returned' },
  // No generic "warehouse_move" (log location with no status change)
  // anymore - it had no natural stopping point and was redundant right
  // after receive_empty (which already captures a storage zone). Every
  // status transition Warehouse is responsible for now happens through
  // allot_washer, receive_from_washer, allot_filler, receive_from_filler,
  // assign_destination, receive_from_driver, receive_empty, or
  // mark_repaired, each of which captures something real, not as a
  // free-floating log entry.
};

function validateTransition(actionType, userRole, currentStatus, details) {
  const rule = TRANSITIONS[actionType];
  if (!rule) {
    return { ok: false, error: `Unknown action type: ${actionType}` };
  }
  // Manager is elevated to perform ANY operational action, not just
  // Mover's - the role check below is bypassed specifically for
  // Manager, everyone else (including Mover themselves) still needs
  // their role to match the rule exactly. This is the one deliberate
  // exception in an otherwise strict role-per-action system - Admin
  // stays a pure observer with no bypass at all.
  if (rule.role !== userRole && userRole !== 'manager') {
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

// What status a given action+details resolves to, independent of
// whether it's actually legal from any particular current status (that
// check is validateTransition's job, above - this is just "what does
// this action type produce"). Used by lib/reports.js to replay a keg's
// full event history for turnover-time stats, and by routes/events.js's
// revert endpoint to work out what a keg's status was immediately
// before its most recent event, by replaying every earlier event.
function resolveNextStatus(actionType, details) {
  const rule = TRANSITIONS[actionType];
  if (!rule) return null;
  return typeof rule.to === 'function' ? rule.to(details) : rule.to;
}

module.exports = { TRANSITIONS, validateTransition, resolveNextStatus };
