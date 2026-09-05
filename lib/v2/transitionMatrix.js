// KEGTRACK v2 — Transition Matrix
//
// Every row is one ALLOWED physical transition. If a transition isn't
// listed here, it's rejected - this table IS the enforcement, not a
// side note to it (spec Section 5: "If a transition is not explicitly
// in the allowed matrix, reject it").
//
// twoScan: true  -> two rows get written per use (an 'initiated' event
//   when the sender acts, a 'confirmed' event when the receiver
//   confirms) and pending_handover_* fields gate what the receiver is
//   allowed to confirm. current_location only changes on confirm;
//   current_condition may change at initiate time when the sender is
//   reporting a fact they already know (e.g. delivery failed) rather
//   than something that depends on the receiver's actions.
// twoScan: false -> a single actor's action writes one 'confirmed'
//   event immediately (e.g. Washer completing the wash itself, or
//   Driver picking up from Customer, who isn't an app user and so
//   can't be the second scan).

const TRANSITION_MATRIX = [
  // ===================================================================
  // CUSTOMER <-> DRIVER
  // ===================================================================
  {
    id: 'customer_to_driver_pickup',
    label: 'Confirm pickup from customer',
    sender: 'customer', receiver: 'driver', twoScan: false,
    from: { location: 'customer', condition: 'delivered' },
    to:   { location: 'driver',   condition: 'empty' },
  },
  {
    id: 'driver_to_customer_delivery',
    label: 'Confirm delivery to customer',
    sender: 'driver', receiver: 'customer', twoScan: false,
    from: { location: 'driver',   condition: 'to_be_delivered' },
    to:   { location: 'customer', condition: 'delivered' },
  },

  // ===================================================================
  // DRIVER <-> MOVER (empty return)
  // ===================================================================
  {
    id: 'driver_to_mover_empty',
    label: 'Hand over empty keg to Mover',
    sender: 'driver', receiver: 'mover', twoScan: true,
    from: { location: 'driver', condition: 'empty' },
    to:   { location: 'mover',  condition: 'empty' },
  },

  // ===================================================================
  // DRIVER <-> MOVER (failed / undelivered filled return)
  // ===================================================================
  {
    id: 'driver_to_mover_delivery_failed',
    label: 'Report failed delivery, return to Mover',
    sender: 'driver', receiver: 'mover', twoScan: true,
    from: { location: 'driver', condition: 'to_be_delivered' },
    // Condition becomes 'delivery_failed' at the moment Driver reports
    // it (initiate) - Driver knows this immediately, it doesn't depend
    // on Mover's confirmation. Location only moves to 'mover' on confirm.
    conditionAtInitiate: 'delivery_failed',
    to:   { location: 'mover',  condition: 'delivery_failed' },
    requiresReason: true,
    reasonOptions: ['forgot_to_deliver', 'damaged', 'customer_refused', 'customer_unavailable', 'shop_closed', 'other'],
    reasonOtherRequiresText: true,
  },
  // Resolving a delivery_failed keg is Mover's call, not automatic
  // (mirrors the spec's "do not automatically determine what happens
  // next" instruction for damaged kegs - the same principle applies
  // here: a failed delivery could mean "just retry" or "actually this
  // was damage, treat it as such"). Two explicit options:
  {
    id: 'mover_retry_dispatch_after_failed_delivery',
    label: 'Retry: re-assign to Driver',
    sender: 'mover', receiver: 'driver', twoScan: true,
    from: { location: 'mover', condition: 'delivery_failed' },
    to:   { location: 'driver', condition: 'to_be_delivered' },
  },
  {
    id: 'mover_reclassify_failed_delivery_as_damaged',
    label: 'Mark as damaged instead',
    sender: 'mover', receiver: 'mover', twoScan: false,
    from: { location: 'mover', condition: 'delivery_failed' },
    to:   { location: 'mover', condition: 'damaged' },
  },

  // ===================================================================
  // MOVER <-> WASHER
  // ===================================================================
  {
    id: 'mover_to_washer',
    label: 'Send to Washer',
    sender: 'mover', receiver: 'washer', twoScan: true,
    from: { location: 'mover',  condition: 'empty' },
    to:   { location: 'washer', condition: 'empty' },
  },
  // Washing modeled as two single-actor steps (not one), specifically
  // so Section 12's "Washing Started At"/"Washing Completed At" have
  // two genuine, separate timestamps to subtract - one combined event
  // would only give a single instant, no duration to measure.
  {
    id: 'washer_starts_wash',
    label: 'Start washing',
    sender: 'washer', receiver: 'washer', twoScan: false,
    from: { location: 'washer', condition: 'empty' },
    to:   { location: 'washer', condition: 'washing' },
  },
  {
    id: 'washer_completes_wash',
    label: 'Finish washing',
    sender: 'washer', receiver: 'washer', twoScan: false,
    from: { location: 'washer', condition: 'washing' },
    to:   { location: 'washer', condition: 'cleaned' },
  },
  {
    id: 'washer_to_mover_cleaned',
    label: 'Send clean keg to Mover',
    sender: 'washer', receiver: 'mover', twoScan: true,
    from: { location: 'washer', condition: 'cleaned' },
    to:   { location: 'mover',  condition: 'cleaned' },
  },
  {
    id: 'washer_to_filler_direct',
    label: 'Send clean keg to Filler',
    sender: 'washer', receiver: 'filler', twoScan: true,
    from: { location: 'washer', condition: 'cleaned' },
    to:   { location: 'filler', condition: 'cleaned' },
  },

  // ===================================================================
  // MOVER <-> WAREHOUSE / UNCLEANED STORAGE
  // (Mover's choice after receiving empty from Driver: Washer directly,
  // above, OR Uncleaned Storage, here - never automatic.)
  // ===================================================================
  {
    id: 'mover_to_warehouse_uncleaned',
    label: 'Store in Uncleaned Storage',
    sender: 'mover', receiver: 'warehouse', twoScan: true,
    from: { location: 'mover',     condition: 'empty' },
    to:   { location: 'warehouse', condition: 'empty', warehouseSublocation: 'uncleaned' },
  },
  {
    id: 'warehouse_uncleaned_to_mover',
    label: 'Retrieve from Uncleaned Storage',
    sender: 'warehouse', receiver: 'mover', twoScan: true,
    from: { location: 'warehouse', condition: 'empty', warehouseSublocation: 'uncleaned' },
    to:   { location: 'mover',     condition: 'empty' },
  },

  // ===================================================================
  // MOVER <-> FILLER
  // ===================================================================
  {
    id: 'mover_to_filler',
    label: 'Send to Filler',
    sender: 'mover', receiver: 'filler', twoScan: true,
    from: { location: 'mover',  condition: 'cleaned' },
    to:   { location: 'filler', condition: 'cleaned' },
  },
  // Filling modeled as two single-actor steps, same reasoning as
  // washing above (Section 12's "Filling Started At"/"Filling
  // Completed At").
  {
    id: 'filler_starts_fill',
    label: 'Start filling',
    sender: 'filler', receiver: 'filler', twoScan: false,
    from: { location: 'filler', condition: 'cleaned' },
    to:   { location: 'filler', condition: 'filling' },
  },
  {
    id: 'filler_completes_fill',
    label: 'Finish filling',
    sender: 'filler', receiver: 'filler', twoScan: false,
    from: { location: 'filler', condition: 'filling' },
    to:   { location: 'filler', condition: 'filled' },
  },
  {
    id: 'filler_to_mover',
    label: 'Send filled keg to Mover',
    sender: 'filler', receiver: 'mover', twoScan: true,
    from: { location: 'filler', condition: 'filled' },
    to:   { location: 'mover',  condition: 'filled' },
    // Filler MUST NOT send a filled keg directly to Driver (spec
    // Section 4) - enforced structurally: no transition exists with
    // sender:'filler', receiver:'driver' anywhere in this table.
  },

  // ===================================================================
  // MOVER <-> WAREHOUSE / CLEANED STORAGE
  // (Mover's choice after receiving cleaned from Washer: Filler
  // directly, above, OR Cleaned Storage, here.)
  // ===================================================================
  {
    id: 'mover_to_warehouse_cleaned',
    label: 'Store in Cleaned Storage',
    sender: 'mover', receiver: 'warehouse', twoScan: true,
    from: { location: 'mover',     condition: 'cleaned' },
    to:   { location: 'warehouse', condition: 'cleaned', warehouseSublocation: 'cleaned' },
  },
  {
    id: 'warehouse_cleaned_to_mover',
    label: 'Retrieve from Cleaned Storage',
    sender: 'warehouse', receiver: 'mover', twoScan: true,
    from: { location: 'warehouse', condition: 'cleaned', warehouseSublocation: 'cleaned' },
    to:   { location: 'mover',     condition: 'cleaned' },
  },

  // ===================================================================
  // MOVER <-> WAREHOUSE / FILLED STORAGE
  // (Mover's choice after receiving filled from Filler: Driver
  // directly, below, OR Filled Storage, here.)
  // ===================================================================
  {
    id: 'mover_to_warehouse_filled',
    label: 'Store in Filled Storage',
    sender: 'mover', receiver: 'warehouse', twoScan: true,
    from: { location: 'mover',     condition: 'filled' },
    to:   { location: 'warehouse', condition: 'filled', warehouseSublocation: 'filled' },
  },
  {
    id: 'warehouse_filled_to_mover',
    label: 'Retrieve from Filled Storage',
    sender: 'warehouse', receiver: 'mover', twoScan: true,
    from: { location: 'warehouse', condition: 'filled', warehouseSublocation: 'filled' },
    to:   { location: 'mover',     condition: 'filled' },
  },

  // ===================================================================
  // MOVER <-> DRIVER (dispatch)
  // ===================================================================
  {
    id: 'mover_to_driver_dispatch',
    label: 'Assign to Driver for delivery',
    sender: 'mover', receiver: 'driver', twoScan: true,
    from: { location: 'mover',  condition: 'filled' },
    to:   { location: 'driver', condition: 'to_be_delivered' },
    requiresCustomer: true, // must specify which customer this is headed to
  },

  // ===================================================================
  // DAMAGE - from any of Driver, Washer, Filler, Mover, always -> Mover
  // ===================================================================
  {
    id: 'driver_to_mover_damaged',
    label: 'Report damaged keg to Mover',
    sender: 'driver', receiver: 'mover', twoScan: true,
    from: { location: 'driver', condition: null }, // any condition while Driver holds it
    to:   { location: 'mover',  condition: 'damaged' },
  },
  {
    id: 'washer_to_mover_damaged',
    label: 'Report damaged keg to Mover',
    sender: 'washer', receiver: 'mover', twoScan: true,
    from: { location: 'washer', condition: null },
    to:   { location: 'mover',  condition: 'damaged' },
  },
  {
    id: 'filler_to_mover_damaged',
    label: 'Report damaged keg to Mover',
    sender: 'filler', receiver: 'mover', twoScan: true,
    from: { location: 'filler', condition: null },
    to:   { location: 'mover',  condition: 'damaged' },
  },
  {
    id: 'mover_to_warehouse_damaged',
    label: 'Store in Damaged Storage',
    sender: 'mover', receiver: 'warehouse', twoScan: true,
    from: { location: 'mover',     condition: 'damaged' },
    to:   { location: 'warehouse', condition: 'damaged', warehouseSublocation: 'damaged' },
  },
  {
    id: 'warehouse_damaged_to_mover',
    label: 'Retrieve from Damaged Storage',
    sender: 'warehouse', receiver: 'mover', twoScan: true,
    from: { location: 'warehouse', condition: 'damaged', warehouseSublocation: 'damaged' },
    // Spec: "Do not automatically determine what happens next" - this
    // transition only returns it to Mover's own hands, still condition
    // 'damaged'. What Mover does with it afterward (repair and
    // reintroduce as uncleaned, discard, etc.) is deliberately NOT
    // modeled as an automatic next step - it would need a distinct,
    // explicit action of its own (out of scope for this matrix until
    // that's specified), matching the spec's own "further authorized
    // action" phrasing rather than inventing a resolution now.
    to:   { location: 'mover', condition: 'damaged' },
  },
];

module.exports = { TRANSITION_MATRIX };
