# KEGTRACK Data Model (v2)

Replaces the single `status` enum with four separate fields on `kegs`,
matching the authoritative spec's Section 7/8/6 requirements.

## Fields on `kegs`

| Column | Type | Meaning |
|---|---|---|
| `current_location` | TEXT | One of: `customer`, `driver`, `mover`, `washer`, `filler`, `warehouse` |
| `warehouse_sublocation` | TEXT, nullable | Only meaningful when `current_location = 'warehouse'`. One of: `uncleaned`, `cleaned`, `filled`, `damaged` |
| `current_condition` | TEXT | One of: `empty`, `uncleaned`, `washing`, `cleaned`, `filling`, `filled`, `to_be_delivered`, `delivered`, `delivery_failed`, `returning`, `damaged`, `awaiting_receipt` |
| `pending_handover_to` | TEXT, nullable | NULL = no handover in progress. Otherwise the **receiver** entity: `driver`, `mover`, `washer`, `filler`, or `warehouse` |
| `pending_handover_warehouse_sublocation` | TEXT, nullable | Only set when `pending_handover_to = 'warehouse'` |
| `pending_handover_initiated_at` | TIMESTAMPTZ, nullable | When the sender scanned and hit "Hand Over" |
| `pending_handover_initiated_by` | TEXT, nullable | user_id of the sender |
| `pending_handover_transition_id` | TEXT, nullable | Which exact row of TRANSITION_MATRIX was initiated - looked up directly on confirm rather than re-derived from current state, which breaks for any transition that changes `current_condition` at initiate time (see TRANSITION_MATRIX.js's comment on `conditionAtInitiate` for the specific bug this caused and fixed) |

**Location and Condition are genuinely independent** (Section 8) - e.g.
`location=driver, condition=filled` (en route to deliver) is a different
state from `location=driver, condition=delivery_failed` (attempted,
couldn't complete) - same location, different condition, and both are
real states a keg can be in.

**`pending_handover_to` is the two-scan mechanism itself** (Section 6):
while it's set, `current_location`/`current_condition` have **not**
changed yet - they still reflect the sender's last confirmed state.
Only when the receiver scans and confirms does the system:
1. Set `current_location` (and `warehouse_sublocation` if applicable) to
   the pending receiver
2. Set `current_condition` to whatever that handover's resulting
   condition is
3. Clear all four `pending_handover_*` fields
4. Write the completed-handover audit event (see EVENTS below)

## `events` table (unchanged shape, stricter meaning)

Still one row per transaction, but now records the full custody
transfer rather than a single status jump:

| Column | Meaning |
|---|---|
| `keg_id`, `user_id`, `created_at` | unchanged |
| `action_type` | Matches an entry's `id` in the transition matrix (see TRANSITION_MATRIX.js) |
| `sender` | Entity that initiated (may differ from `performed_by`'s role - e.g. Mover retrieving from Warehouse/Cleaned Storage: sender=`warehouse`, performed_by=the Mover user) |
| `receiver` | Entity that will hold custody once confirmed |
| `from_location`, `from_warehouse_sublocation`, `from_condition` | State immediately before this transaction |
| `to_location`, `to_warehouse_sublocation`, `to_condition` | State this transaction moves toward |
| `phase` | `'initiated'` (sender's scan) or `'confirmed'` (receiver's scan) - two rows per two-scan handover, exactly one row for a single-actor transaction (e.g. Washer completing the actual wash, which doesn't involve a second party) |
| `details` | JSON - reason codes (delivery failure, damage), notes, product/batch/ABV for fill, customer_id for dispatch, etc. |

Two rows per handover (initiated + confirmed) is what makes
`pending_handover_*` reconstructable purely by replaying events, and
what gives Section 12's duration metrics (e.g. "Awaiting Receipt Time")
a real pair of timestamps to subtract.

## Entity vs. DB role (Section 3's Sender vs. Performed By)

The transition matrix's `sender`/`receiver` fields are custody
**entities** (`customer`, `driver`, `mover`, `washer`, `filler`,
`warehouse`) - not the same thing as the actual logged-in role
allowed to act on an entity's behalf. Two entities don't map to
themselves directly:

- **`customer`** isn't an app user at all - Driver is physically
  present for every customer-facing handoff, so the `driver` DB role
  performs it on the customer's behalf (e.g. `customer_to_driver_pickup`).
- **`warehouse`** is a first-class custody entity (Section 3), but no
  one logs in as "warehouse" - the existing `warehouse` DB role is the
  person the app already displays as "Mover", and that same person
  physically carries out both their own (`mover`) actions and
  `warehouse`'s, exactly as Section 3 describes ("Mover physically
  performs warehouse movements on behalf of Warehouse").

This mapping lives in `entityRoleMapping.js` and is applied to every
permission check in `transitionEngine.js` - none of the engine
functions compare a logged-in role against `sender`/`receiver`
directly. Manager keeps the same full bypass as the v1 state machine
(can act as any entity); Admin gets none (stays a pure observer).

## Dashboard (scan-v2.html, no keg in the URL)

Shown as 9 collapsible groups, one per valid combination of
`current_location` + `warehouse_sublocation` - At Washer, At Filler,
With Mover, the four Warehouse sub-locations, With Driver, With
Customer. Backed by a single `GET /api/v2/kegs` call returning every
keg's v2 state at once, rather than one request per category (unlike
v1's dashboard lists, which queried one status at a time since there
were only a handful of fixed statuses to ask for individually - v2's
richer state space made that approach impractical here).

Verified the 9 groups are an exhaustive, non-overlapping partition by
testing every location against every warehouse sub-location the schema
allows (including "no sub-location", valid everywhere except
`warehouse`) - not just asserted from having written the match
functions carefully.

A keg with a pending handover shows a distinct visual treatment
(warning color, "- pending" suffix) within whichever group its
*current* (not pending) location puts it in - a handover in progress
doesn't move a keg to a new group until it's actually confirmed, same
principle as the custody model itself never changing
`current_location` until confirmation.

## Why this replaces Now/Next entirely (Section 9)

There is no "next" field anywhere in this model. A keg's page shows:

- **Current custody card**: `current_location` (+ `warehouse_sublocation`
  if applicable) and `current_condition` - a plain fact, not a
  prediction
- **Pending handover banner**, only if `pending_handover_to` is set:
  "Awaiting receipt by {pending_handover_to}"
- **Available actions**: computed live from TRANSITION_MATRIX by
  filtering for entries whose `fromLocation`/`fromCondition` (and
  `fromWarehouseSublocation` where relevant) match the keg's current
  state, and whose `sender` matches the logged-in user's role. If two
  entries match (e.g. Mover holding an empty keg can send to Washer OR
  to Warehouse/Uncleaned Storage), **both actions show as buttons** -
  the system never picks one for the user.
