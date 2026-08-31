// lib/stateMachine.js
// Single source of truth for "who can move a keg from what state to what state".
// This is what stops a keg being dispatched before it was ever filled, etc.

const TRANSITIONS = {
  wash:            { role: 'washer',    from: ['empty_returned'],                 to: 'washed' },
  fill:            { role: 'filler',    from: ['washed'],                         to: 'filled' },
  dispatch:        { role: 'driver',    from: ['filled'],                         to: 'dispatched' },
  deliver:         { role: 'driver',    from: ['dispatched'],                     to: 'delivered' },
  mark_empty:      { role: 'driver',    from: ['delivered'],                      to: 'empty_at_customer' },
  warehouse_move:  { role: 'warehouse', from: ['empty_at_customer', 'delivered', 'filled', 'washed', 'empty_returned'], to: null }, // location update only, no status change
  receive_empty:   { role: 'warehouse', from: ['empty_at_customer'],               to: 'empty_returned' },
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
