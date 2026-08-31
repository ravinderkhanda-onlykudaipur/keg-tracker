// lib/stateMachine.js
// Single source of truth for "who can move a keg from what state to what state".
// This is what stops a keg being dispatched before it was ever filled, etc.

const TRANSITIONS = {
  wash:                { role: 'washer',    from: ['empty_returned'],                 to: 'washed' },
  fill:                { role: 'filler',    from: ['washed'],                         to: 'filled' },
  // Warehouse assigning a destination IS the dispatch - there's no
  // separate driver-initiated "dispatch" step anymore. The driver's
  // first involvement is confirming delivery once it's already dispatched.
  assign_destination:  { role: 'warehouse', from: ['filled'],                         to: 'dispatched' },
  deliver:             { role: 'driver',    from: ['dispatched'],                     to: 'delivered' },
  mark_empty:          { role: 'driver',    from: ['delivered'],                      to: 'empty_at_customer' },
  receive_empty:       { role: 'warehouse', from: ['empty_at_customer'],               to: 'empty_returned' },
  // No generic "warehouse_move" (log location with no status change)
  // anymore - it had no natural stopping point and was redundant right
  // after receive_empty (which already captures a storage zone). Every
  // status transition Warehouse is responsible for now happens through
  // assign_destination or receive_empty, each of which captures location
  // as part of doing something real, not as a free-floating log entry.
};

function validateTransition(actionType, userRole, currentStatus) {
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
  return { ok: true, nextStatus: rule.to }; // nextStatus null means "no status change, location update only"
}

module.exports = { TRANSITIONS, validateTransition };
