// Maps a transition-matrix ENTITY (customer/driver/mover/washer/
// filler/warehouse - what the spec calls Sender/Receiver, describing
// custody) to the actual DB role a logged-in user needs to operate on
// its behalf (spec Section 3's Sender vs Performed By distinction).
//
// Two entities don't map to themselves:
// - 'customer' isn't an app user at all - Driver is physically present
//   for every customer-facing handoff, so Driver performs it on the
//   customer's behalf.
// - 'warehouse' is a first-class custody entity (Section 3), but no
//   one logs in as "warehouse" - the existing users table's
//   'warehouse' role is the person the app already displays as
//   "Mover" (a display-only rename from earlier in the project), and
//   that same person physically carries out both their own actions
//   AND warehouse's, exactly as Section 3 describes ("Mover physically
//   performs warehouse movements on behalf of Warehouse").
const ENTITY_TO_DB_ROLE = {
  customer: 'driver',
  driver: 'driver',
  mover: 'warehouse',
  washer: 'washer',
  filler: 'filler',
  warehouse: 'warehouse',
};

// Manager is elevated to perform any action, on any entity's behalf -
// mirrors the exact same bypass already built into the v1 state
// machine (lib/stateMachine.js's validateTransition), kept consistent
// here rather than reinvented differently for v2. Admin gets no
// bypass - stays a pure observer, same as v1.
function dbRoleCanActAsEntity(dbRole, entity) {
  if (dbRole === 'manager') return true;
  return ENTITY_TO_DB_ROLE[entity] === dbRole;
}

module.exports = { ENTITY_TO_DB_ROLE, dbRoleCanActAsEntity };
