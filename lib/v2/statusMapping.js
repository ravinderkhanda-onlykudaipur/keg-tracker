// lib/v2/statusMapping.js
// Maps a legacy v1 status value to its v2 custody-model equivalent.
// Shared between db.js's one-time migration (for kegs that already
// existed when v2 was introduced) and routes/events.js (which needs
// the exact same mapping on every subsequent v1 action, to keep the
// v2 fields from freezing at whatever they were during that one-time
// migration - see routes/events.js's mapStatusToV2 usage for why this
// sync matters).

const STATUS_TO_V2 = {
  empty_returned:        { current_location: 'mover',     current_condition: 'empty' },
  allotted_washer:       { current_location: 'mover',     current_condition: 'empty',  pending_handover_to: 'washer' },
  received_washer:       { current_location: 'washer',    current_condition: 'empty' },
  washed:                { current_location: 'washer',    current_condition: 'cleaned', pending_handover_to: 'filler' },
  clean_storage:         { current_location: 'washer',    current_condition: 'cleaned', pending_handover_to: 'mover' },
  received_from_washer:  { current_location: 'mover',     current_condition: 'cleaned' },
  received_filler:       { current_location: 'filler',    current_condition: 'cleaned' },
  filled:                { current_location: 'filler',    current_condition: 'filled', pending_handover_to: 'mover' },
  received_from_filler:  { current_location: 'mover',     current_condition: 'filled' },
  dispatched:            { current_location: 'mover',     current_condition: 'filled', pending_handover_to: 'driver' },
  received_driver:       { current_location: 'driver',    current_condition: 'to_be_delivered' },
  delivered:             { current_location: 'customer',  current_condition: 'delivered' },
  empty_at_customer:     { current_location: 'driver',    current_condition: 'empty' },
  returned_to_warehouse: { current_location: 'driver',    current_condition: 'empty',  pending_handover_to: 'mover' },
  received_from_driver:  { current_location: 'mover',     current_condition: 'empty' },
  needs_repair:          { current_location: 'mover',     current_condition: 'damaged' },
};

function mapStatusToV2(status) {
  return STATUS_TO_V2[status] || { current_location: 'mover', current_condition: 'empty' };
}

module.exports = { STATUS_TO_V2, mapStatusToV2 };
