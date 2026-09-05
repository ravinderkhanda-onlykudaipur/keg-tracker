const { TRANSITION_MATRIX } = require('./transitionMatrix');
const { dbRoleCanActAsEntity } = require('./entityRoleMapping');

// Returns every transition currently available for a keg, given who's
// asking. This is the ONLY thing that ever gets shown as an "action" -
// there is deliberately no single predicted "next" here (spec Section
// 9). If two entries match, both come back, and the UI is expected to
// show both as separate buttons - the system never silently picks one.
//
// actingDbRole is the REAL logged-in role (washer/filler/driver/
// warehouse/manager) - checked against t.sender via
// dbRoleCanActAsEntity(), not compared to t.sender directly, since
// t.sender is a custody ENTITY (which can be 'customer', an entity no
// one logs in as, or 'mover'/'warehouse', both operated by the same
// 'warehouse'-role person) rather than a DB role itself. See
// entityRoleMapping.js for the full reasoning.
function getAvailableTransitions(keg, actingDbRole) {
  return TRANSITION_MATRIX.filter((t) => {
    if (!dbRoleCanActAsEntity(actingDbRole, t.sender)) return false;
    if (t.from.location !== keg.current_location) return false;
    if (t.from.warehouseSublocation && t.from.warehouseSublocation !== keg.warehouse_sublocation) return false;
    if (t.from.condition !== null && t.from.condition !== keg.current_condition) return false;
    return true;
  });
}

function initiateHandover(keg, transitionId, actingDbRole, actingUserId, details) {
  const t = TRANSITION_MATRIX.find((x) => x.id === transitionId);
  if (!t) return { ok: false, error: `Unknown transition: ${transitionId}` };
  if (!t.twoScan) return { ok: false, error: `${transitionId} is not a two-scan transition - use executeSingleActor instead` };
  if (!dbRoleCanActAsEntity(actingDbRole, t.sender)) {
    return { ok: false, error: `This action requires acting on behalf of '${t.sender}' - your role can't do that` };
  }
  if (t.from.location !== keg.current_location) {
    return { ok: false, error: `Keg is at '${keg.current_location}', not '${t.from.location}'` };
  }
  if (t.from.warehouseSublocation && t.from.warehouseSublocation !== keg.warehouse_sublocation) {
    return { ok: false, error: `Keg's warehouse sub-location doesn't match` };
  }
  if (t.from.condition !== null && t.from.condition !== keg.current_condition) {
    return { ok: false, error: `Keg's condition is '${keg.current_condition}', not '${t.from.condition}'` };
  }
  if (t.requiresReason && !details?.reason) {
    return { ok: false, error: 'A reason is required for this action' };
  }
  if (t.requiresReason && details.reason === 'other' && t.reasonOtherRequiresText && !details?.reasonText) {
    return { ok: false, error: 'A description is required when selecting "Other"' };
  }
  if (t.requiresCustomer && !details?.customerId) {
    return { ok: false, error: 'A destination customer is required' };
  }

  return {
    ok: true,
    kegUpdates: {
      current_condition: t.conditionAtInitiate || keg.current_condition,
      pending_handover_to: t.receiver,
      pending_handover_warehouse_sublocation: t.to.warehouseSublocation || null,
      pending_handover_initiated_at: new Date(),
      pending_handover_initiated_by: actingUserId,
      pending_handover_transition_id: t.id,
    },
    eventToLog: {
      action_type: t.id, phase: 'initiated',
      sender: t.sender, receiver: t.receiver,
      from_location: t.from.location, from_warehouse_sublocation: keg.warehouse_sublocation, from_condition: keg.current_condition,
      to_location: t.to.location, to_warehouse_sublocation: t.to.warehouseSublocation || null, to_condition: t.to.condition,
      details,
    },
  };
}

function confirmHandover(keg, actingDbRole, actingUserId) {
  if (!keg.pending_handover_to) {
    return { ok: false, error: 'This keg has no pending handover to confirm' };
  }
  if (!dbRoleCanActAsEntity(actingDbRole, keg.pending_handover_to)) {
    return { ok: false, error: `This handover is awaiting receipt by '${keg.pending_handover_to}' - your role can't confirm that` };
  }
  const t = TRANSITION_MATRIX.find((x) => x.id === keg.pending_handover_transition_id);
  if (!t) return { ok: false, error: 'Could not find the transition definition for this pending handover' };

  return {
    ok: true,
    kegUpdates: {
      current_location: t.to.location,
      warehouse_sublocation: t.to.warehouseSublocation || null,
      current_condition: t.to.condition,
      pending_handover_to: null,
      pending_handover_warehouse_sublocation: null,
      pending_handover_initiated_at: null,
      pending_handover_initiated_by: null,
      pending_handover_transition_id: null,
    },
    eventToLog: {
      action_type: t.id, phase: 'confirmed',
      sender: t.sender, receiver: t.receiver,
      from_location: keg.current_location, from_warehouse_sublocation: keg.warehouse_sublocation, from_condition: keg.current_condition,
      to_location: t.to.location, to_warehouse_sublocation: t.to.warehouseSublocation || null, to_condition: t.to.condition,
    },
  };
}

function executeSingleActor(keg, transitionId, actingDbRole) {
  const t = TRANSITION_MATRIX.find((x) => x.id === transitionId);
  if (!t) return { ok: false, error: `Unknown transition: ${transitionId}` };
  if (t.twoScan) return { ok: false, error: `${transitionId} is a two-scan transition - use initiateHandover/confirmHandover instead` };
  if (!dbRoleCanActAsEntity(actingDbRole, t.sender)) {
    return { ok: false, error: `This action requires acting on behalf of '${t.sender}' - your role can't do that` };
  }
  if (t.from.location !== keg.current_location || t.from.condition !== keg.current_condition) {
    return { ok: false, error: `Keg is not in the required state for '${transitionId}'` };
  }

  return {
    ok: true,
    kegUpdates: {
      current_location: t.to.location,
      current_condition: t.to.condition,
    },
    eventToLog: {
      action_type: t.id, phase: 'confirmed',
      sender: t.sender, receiver: t.receiver,
      from_location: t.from.location, from_condition: t.from.condition,
      to_location: t.to.location, to_condition: t.to.condition,
    },
  };
}

module.exports = { getAvailableTransitions, initiateHandover, confirmHandover, executeSingleActor };
