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

## Keeping v1 and v2 in sync while they coexist

`routes/events.js` (the v1 action handler, used by scan.html) now
updates the v2 fields on every single action, not just once at
migration time - using the exact same mapping
(`lib/v2/statusMapping.js`) that `db.js`'s one-time migration uses,
imported from one shared module rather than duplicated.

This was a real bug, not a hypothetical: without it, a keg acted on
through scan.html would correctly advance its legacy `status`, but
`current_location`/`current_condition` stayed frozen at whatever the
one-time migration had set them to - making scan-v2.html look like
kegs never moved, even though v1 itself was working correctly. The
report that surfaced this ("scan.html works, scan-v2.html doesn't,
kegs stay in the same position") pointed straight at this once the
Safari-caching explanation (a real, separate bug fixed the round
before) was ruled out.

A second, related bug surfaced while fixing this: `routes/kegs.js`,
`seed.js`, and `public/index.html` still referenced `current_location`
for its *original* free-text meaning (a GPS/zone note) after that
column was renamed to `location_note` for the v2 rebuild - one of them
(new keg creation) happened to still pass the new CHECK constraint by
coincidence (the literal string `'warehouse'` is also a valid v2
entity value), which is exactly the kind of silent, semantically-wrong
success that's easy to miss. All three fixed to use `location_note`
correctly, and new kegs now get explicit, correct v2 field values
(`mover`/`empty`, matching what `empty_returned` maps to) instead of
inheriting the schema's raw defaults by accident.

## Caching (Safari specifically)

Every `fetch()` call in `scan-v2.html` uses `cache: 'no-store'`, and
every route in `routes/v2Kegs.js` sets a `Cache-Control: no-store`
response header via a router-level middleware. Found this from a real
bug report: Safari caches GET `fetch()` responses more aggressively
than Chrome by default, so without this, a genuinely successful action
could reload the same keg's page and show its *old* state - looking
exactly like the action had silently failed, when the backend had
already updated correctly. Both the request-side and response-side
fixes are kept in place together (not just one or the other), covering
the browser's own cache and any caching layer in between it and this
server.

## Resolving a damaged keg (closing a real dead end)

`warehouse_damaged_to_mover` used to be a genuine dead end - it
returned a damaged keg to Mover's own hands with no further transition
defined from `{location: mover, condition: damaged}` at all, so once
retrieved, a damaged keg could never move again. Added
`mover_repairs_damaged_keg`: a single-actor action (Mover's own
judgment call, no second party to confirm) that reintroduces the keg
to the normal cycle at exactly the same location/condition a routinely
-returned empty keg has, so it goes through a full wash + inspection
again rather than skipping a step just because it was previously
damaged.

This is genuinely Mover's explicit choice, not an automatic
resolution - at `{mover, damaged}`, Mover now sees two real options:
store it again (`mover_to_warehouse_damaged`) or mark it repaired.
Verified with a full lifecycle test (report -> store -> retrieve ->
repair -> back in the cycle) and confirmed the main end-to-end cycle
still passes unchanged.

Deliberately NOT modeled here: permanently retiring a keg instead of
repairing it. That's a distinct, larger decision needing its own
lifecycle concept (active/inactive) separate from location+condition,
which doesn't exist in this schema yet - left for a dedicated
follow-up rather than folded into this transition.

## Clean cutover: v1 and v2 are now independent systems

After the sync bridge caused two real bugs in a row with no actual
benefit (nothing ever needed scan.html and scan-v2.html to run keg
actions simultaneously), `routes/events.js` no longer touches any v2
field at all - it reverted to updating only `status`,
`location_note`, and the destination columns, exactly as it did before
v2 existed. v2 owns `current_location`/`warehouse_sublocation`/
`current_condition`/`pending_handover_*` completely on its own now,
through `routes/v2Kegs.js` exclusively.

This closed the real gap the sync bridge had been covering for
dispatch: v2 needed its own way to record which customer a keg is
headed to, rather than relying on v1's `customer_id` column (which v2
no longer touches). Added `current_customer_id`, populated by
`initiateHandover()` whenever a transition has `requiresCustomer` set
(currently just `mover_to_driver_dispatch`), and resolved to a display
name via a join in the single-keg GET route.

`index.html`'s Keg ID links now point to `scan-v2.html` instead of
`scan.html`, since that's genuinely where actions happen now - Admin/
Manager oversight itself (Reports, Users, Devices, Customers, Products)
stays on `index.html` unchanged, since none of it touches keg custody
directly.

**Known limitation worth being explicit about**: `index.html`'s
existing Alerts feature is built entirely on v1's `status` field and
how long a keg has sat in a given status. Once real actions move to
v2 and stop advancing `status`, every keg will eventually look
"stuck" in whatever status it last had under v1, and the Alerts
feature will start producing alerts that don't reflect reality. A v2-
native equivalent (built on `current_location`/`current_condition`
and the `initiated`/`confirmed` event timestamps already being
captured) is a real, separate piece of work - deliberately not
attempted as part of this cutover, called out here rather than left
as a silent surprise.

## Visual design rebuild

`scan-v2.html` was rebuilt to reuse scan.html's actual visual assets
- the full CSS palette, the illustrated top banner (SVG, unchanged),
the uploaded role icon files in `public/icons/`, and the same card/
button/typography system - rather than the smaller, plain styling it
launched with. The custody card now shows the relevant location icon
(a new `locationIcon()` function, mapping both `mover` and `warehouse`
location values to the same uploaded 'mover' icon file, since Mover is
the person who physically operates on Warehouse's behalf either way -
see the Entity vs. DB role section above).

`manifest.json`'s `start_url` now points to `scan-v2.html` instead of
`scan.html`, since that's genuinely the app's home now - and
`scan-v2.html` picked up the same Admin-redirects-to-index.html logic
`scan.html` already had, for the same reason: Admin is a pure observer
with nothing to act on here.

Verified before considering this done: all 17 JS functions (16 carried
over untouched, 1 new) present and accounted for; all 25 element IDs
referenced by JS actually exist in the rebuilt HTML; the SVG banner's
tags balance (15 opening `<g>`, 15 closing); every referenced icon
file (`washer-green.svg`, `filler-green.svg`, `driver-green.svg`,
`mover-green.svg`) confirmed to actually exist; and every label map
re-audited against the transition matrix's actual values, same
discipline as every previous round - nothing skipped just because
this round's work was primarily visual rather than logical.

`scan.html` and `index.html` remain completely untouched, kept as
reference only, per the direction to start clean on v2 rather than
keep modifying v1 files going forward.

## Fill details (closing the product/batch/ABV gap)

`filler_completes_fill` now requires `requiresProductDetails`, mirroring
`requiresReason`/`requiresCustomer`'s pattern - `executeSingleActor()`
validates a product, batch number, and ABV are all present before
allowing the fill to complete, and includes them in `kegUpdates` as
v2's own `current_product_id`/`current_batch_number`/`current_abv`
fields (same reasoning as `current_customer_id` for dispatch - separate
from anything v1 owns). `routes/v2Kegs.js`'s `/execute` route needed a
fix too: it wasn't passing `details` through to the engine at all,
which would have made this validation unreachable regardless of the
engine-level work.

The frontend gained a genuine inline "add new beer" flow, matching
v1's own UX rather than just a bare dropdown - selecting "Add new
beer" reveals a small form, saves via the existing (unmodified)
`routes/products.js`, and refreshes the dropdown with the new entry
pre-selected. A guard rail blocks submission if that placeholder is
still selected but never actually saved.

Verified with actual runtime execution, not just syntax checks or
reference audits: simulated the complete fill flow end to end (open
the action, confirm the product dropdown populates from a mocked
`/api/products`, fill in batch/ABV, submit, and inspect the exact JSON
body that reaches the server) and separately confirmed the guard rail
blocks a submission before it ever reaches the network. Two of these
test runs hit bugs in the test scaffolding itself (a mock element
never initialized, and a Node `eval()` scoping quirk with top-level
`let`) rather than the page - both diagnosed and fixed in the test
before trusting the result, rather than assumed to be page bugs.

## File consolidation: there is no more scan-v2.html

Having two similarly-named files (`scan.html` for the old model,
`scan-v2.html` for this one) made local testing and file management
genuinely confusing in practice, not just in theory - correctly
identified as a real problem, not a preference. `scan-v2.html`'s
content now lives directly at `scan.html` - there is exactly one file
with that name, containing the custody model described throughout
this document. `scan-v2.html` no longer exists.

Updated everywhere this needed to reach: `manifest.json`'s
`start_url`, the QR code generator in `routes/kegs.js` (the most
consequential one - this is what's embedded in an actual printed QR
code), the service worker's offline cache list (also dropped the
now-redundant duplicate entry), `index.html`'s links and its
operational-role redirect, and the dev-server startup message. Also
went through and reworded every comment inside the file itself that
referred to "scan.html" as if it were a separate file, since the file
now describing its own design origin that way would be misleading.

The old v1 custody model's backend code (`lib/stateMachine.js`,
`routes/events.js`) still exists and still works - nothing about this
consolidation touches it. It's just backend code nothing calls from
the new `scan.html` anymore, not something that needs to be deleted
for the renaming to make sense.

Verified with the same discipline as every other round: confirmed
`scan-v2.html` is genuinely gone from disk, searched for (and found
zero) remaining functional references anywhere in the codebase, ran
the full syntax sweep across every file, and ran an actual runtime
simulation of the consolidated `scan.html` (login, dashboard load)
rather than trusting a syntax check alone.

## Fixed: migrated kegs stuck on confirm ("Could not find the transition definition")

The original v1-to-v2 migration set `pending_handover_to` for several
statuses (`allotted_washer`, `washed`, `clean_storage`, `filled`,
`dispatched`, `returned_to_warehouse`) but never set the matching
`pending_handover_transition_id` - so any keg migrated while in one of
those pending states could never actually be confirmed, regardless of
who tried. Not specific to any one role - just never triggered for
freshly-created kegs, since `initiateHandover()` always sets both
fields together correctly.

Fixed in two parts: `lib/v2/statusMapping.js` now includes the correct
transition ID for each of those six statuses, so a *fresh* migration
run produces correct data from the start. But the migration itself is
one-time-only (guarded by an `app_settings` flag) and had already run
on any existing database, so fixing the mapping alone wouldn't repair
already-broken rows - and simply re-running the same migration isn't
safe either, since it keys off the v1 `status` column, which stays
frozen once v1 actions stop (per the clean cutover) while a keg's real
v2 state can keep moving - re-applying it could incorrectly reset a
keg that has since progressed. Instead, added a small, targeted,
self-healing repair that runs on every boot: for any keg with
`pending_handover_to` set but `pending_handover_transition_id` still
NULL, it matches directly against that keg's *current*
location/condition/sub-location rather than its stale v1 status.
Confirmed safe to match this way by checking there's no ambiguity -
no two two-scan transitions share the same from-state + receiver
combination - and confirmed the three damage-report transitions
(which use `condition: null`) are never ones the migration could have
produced in the first place, so they're correctly never touched by
this repair.

Verified with three separate tests: the repair actually fixes a
simulated broken keg, an already-healthy keg is left completely
untouched by the same repair pass, and - the actual end-to-end
scenario - confirming the repaired keg as Manager now succeeds and
moves it to the correct next location. One of these tests initially
failed due to a mistake in the test itself (a placeholder SQL string
that didn't match the mock's expected text), caught and fixed before
trusting the result.

## Alerts rebuilt for v2 (lib/v2/alerts.js)

Replaced the flagged limitation from earlier: v1's `lib/alerts.js` keys
entirely off the `status` column, which stays frozen once real actions
move to v2, so every alert would eventually become a false positive.
`lib/v2/alerts.js` keys off the actual live fields instead -
`current_location`/`current_condition`/`warehouse_sublocation` for
"holding, hasn't progressed" states, and the real
`pending_handover_initiated_at` timestamp (not an inferred one) for
"awaiting receipt" states.

Verified exhaustively rather than assumed correct from having written
the rules carefully: every resting state reachable via the transition
matrix has a matching rule (18/18, after finding and fixing 4
originally-uncovered warehouse-storage states - genuinely new
alerting v1 could never do, since it never modeled storage as a
distinct state), and every possible `pending_handover_to` receiver
value maps to a rule (5/5). Also verified rule ORDER matters and
works as intended: a keg with a pending handover always matches the
"awaiting receipt" rule first, never double-counted against the
"holding, not yet routed" rule for the same location - tested directly
rather than assumed from the list's ordering alone.

New endpoint `GET /api/v2/kegs/alerts` (placed before `/:id` in the
router - Express matches definition order, and `/:id` would otherwise
swallow a request for `/alerts` by treating it as a keg ID). Same
access rule as v1: `manufacturingNumber` stripped for non-Admin/
Manager requesters.

Frontend: `scan.html` shows an alerts block filtered to the logged-in
user's own role (Manager sees everything). `index.html`'s existing
grouped Alerts view was updated in place - same three pipeline-stage
groups as before, just regrouped by `current_location` instead of the
old status-list membership. Ran full simulations of both (not just
syntax checks): confirmed a Washer-logged-in user sees their own
overdue keg and not a Filler-only one, and confirmed all three of
Admin's stage groups populate correctly from mixed v2 alert data.

## Alerts redesigned again: keyed directly by transition ID

Per explicit request: every alert now names the specific transition
ID(s) it's about, rather than only a generic (location, condition)
match. `ALERT_DEFS` in `lib/v2/alerts.js` has one entry per transition
ID (all 28, verified), each with an optional `notInitiated` rule
(keg sits at this transition's `from` state, nothing pending, hasn't
happened yet) and, for the 20 two-scan transitions, an
`awaitingReceipt` rule (matched directly against the keg's own stored
`pending_handover_transition_id`, not re-derived from current state -
same reasoning as `confirmHandover()` itself).

Several transitions share the same `from` state on purpose (Mover
genuinely has two options in several places). Rather than produce a
duplicate alert row per matching transition for the same physical
keg, `getOverdueKegsV2()` groups all matching transition IDs into one
alert entry's `transitionIds` array. Verified directly: a keg at
{mover, empty} with nothing pending produces exactly one alert entry
naming both `mover_to_washer` and `mover_to_warehouse_uncleaned`, not
two separate rows.

Damage-report transitions (`driver/washer/filler_to_mover_damaged`)
deliberately have no `notInitiated` rule - their `from.condition` is
`null` (matches any condition, same convention as the transition
matrix itself), so there's no specific waiting duration to detect;
they still have `awaitingReceipt` once actually reported.

Both frontend displays (`scan.html`'s alerts block, `index.html`'s
grouped Alerts view) now show the transition ID(s) alongside the
existing label - re-verified with the same runtime-simulation
approach as before, including the multi-option case rendering both
IDs together as "mover_to_washer or mover_to_warehouse_uncleaned".

## New CSV export for v2 transition data

`GET /api/v2/kegs/export-events.csv` (Admin/Manager only, placed
before `/:id` for the same routing reason as `/alerts`) - one row per
scan (a two-scan handover produces two rows: `initiated` and
`confirmed`), including the transition ID, phase, sender, receiver,
and full from/to state. Kept as a genuinely separate export from v1's
`export-history.csv` rather than merged into it, per explicit
direction.

`csvEscape`/`formatForExcel` (the exact YYYY-MM-DD HH:MM:SS IST format
that sorts correctly as plain text in Excel) were previously defined
only inside `routes/kegs.js` - moved to a new shared
`lib/csvHelpers.js` so both v1's and v2's exports use one definition,
not two that could quietly drift apart. Verified the formatting
directly: two timestamps an hour apart format as expected and sort
correctly as plain strings, and a full simulated 2-row export (an
initiated + confirmed pair) produces correctly escaped, chronologically
sorted CSV output.

## Undo (revert) added for v2

`POST /api/v2/kegs/:id/revert` - Mover (warehouse role), Admin, and
Manager only, same scope as v1's own revert. Limited to the single
most recent event, per explicit direction (not full history).

Unlike v1's revert (which had to replay every earlier event through
resolveNextStatus() to derive the previous status, since v1 never
stored a "before" state on the event itself), v2 events already record
from_location/from_warehouse_sublocation/from_condition directly - so
undoing is just restoring those values and clearing any pending
handover fields, no replay needed. Works correctly for both a
'confirmed' event (fully reverses the location/condition change) and
an 'initiated' event (cancels the pending handover; location was never
actually touched at initiate time, but from_condition correctly
reverts a conditionAtInitiate change, like a failed-delivery report).
The revert is logged as a new 'confirmed'-phase event (not deleted or
altered original), which correctly resets the alert-timing clock
rather than leaving the keg looking instantly overdue again.

Frontend: an "Undo last action" button on scan.html's keg view, shown
only to admin/warehouse/manager. Verified via full runtime simulation
(not just syntax checks) that it renders for warehouse and stays
hidden for washer, and that clicking it genuinely calls the revert
endpoint.

## Mover<->Warehouse transitions no longer require confirmation

Per explicit direction: the 8 Mover<->Warehouse transitions
(store/retrieve for each of the 4 storage areas) changed from
`twoScan: true` to `twoScan: false` - both entities are operated by
the same physical person (the 'warehouse' DB role, displayed as
"Mover"), so a second confirming scan for someone to confirm their own
internal movement was pure friction with no real custody-verification
value. Two-scan transitions dropped from 20 to 12; the overall
transition count is unchanged at 28.

This surfaced two real bugs in `executeSingleActor()`, neither of
which mattered before since no single-actor transition had ever
touched a warehouse sub-location: it never set `warehouse_sublocation`
in its result at all (so a keg stored via the new single-scan path
would land with the wrong, stale sub-location), and it never validated
`from.warehouseSublocation` either (so `warehouse_uncleaned_to_mover`
could have incorrectly succeeded on a keg actually sitting in Cleaned
Storage). Both fixed, and both verified directly - a keg correctly
lands with the right sub-location after the single-scan store, and an
attempt to retrieve from the wrong sub-location is now correctly
rejected.

The corresponding `awaitingReceipt` alert rules for these 8
transitions were removed from `lib/v2/alerts.js` as dead code - they
could never fire now that no pending state is ever created for them.
Re-verified full alert coverage afterward: all 28 transitions still
have an entry, all 12 remaining two-scan transitions still have a
working `awaitingReceipt` rule.

Re-ran the full end-to-end lifecycle test with the corrected mixed
two-scan/single-actor sequence (had to fix a sequencing mistake in the
test itself - a skipped `filler_to_mover` handover - before it passed)
and confirmed the whole cycle, plus the fill-details capture,
survives correctly end to end.

## Overview rebuilt: Resting/Pending alert split, plus pie charts

`getOverdueKegsV2()` now tags every alert with `phaseType` ('resting'
or 'pending'). Pending alerts also carry `receivingUserName`, looked
up from the `users` table by role - the business runs one person per
operational role, so this is a simple lookup, not a real assignment
mechanism (confirmed with the person building this before doing it
this way, rather than building a heavier per-handover assignment
feature that wasn't actually needed).

`index.html`'s Overview tab now shows two separate alert sections:
Resting Phase (grouped by location, sub-grouped by condition only when
a location currently has more than one) and Pending Phase (grouped by
receiving location, sub-grouped by receiving user only when more than
one appears - with one person per role this usually collapses to a
single sub-group, but the structure holds if that changes).

New endpoint `GET /api/v2/kegs/overview-stats` (Admin/Manager only)
backs two new pie charts - kegs by customer, kegs by product. Both
correctly filter to only genuinely-current data:
`current_customer_id`/`current_product_id` are never cleared once a
keg moves on, so an unfiltered count would include stale kegs no
longer actually with that customer or containing that product.
Verified directly with mixed test data including exactly this stale
case, confirming it's excluded.

No external charting library - `renderPieChart()` is a small,
self-contained SVG function, consistent with the app's existing
"only external script is device-id.js" footprint.

Verified with full runtime simulation, not just syntax checks:
constructed realistic mixed alert data (two conditions at one
location, a pending alert with a receiving user) and confirmed the
resting alerts correctly nest into two condition sub-groups, the
pending alert correctly shows the receiving user's name, and the pie
chart renders real SVG with the correct legend data. Two of my own
initial test assertions were themselves wrong (checking for `>Empty<`
literally, when the real markup has a count badge immediately after)
- caught by printing and inspecting the actual rendered HTML directly
rather than trusting the automated check alone.

## Task tab, Feedback tab, and in-app QR scanner

**Task**: a personal to-do list per user, on their own profile
(`scan.html`, new "Task" home tab). New `tasks` table and
`routes/tasks.js` - every query scoped to `req.user.id` server-side
(not just hidden in the UI), verified directly: a mocked cross-user
delete attempt affects 0 rows.

Found and fixed a real bug while building this: `addTask()`,
`toggleTask()`, and `deleteTask()` all called `loadTasks()` without
`await`, creating a race condition where the list could still show
stale data by the time the calling function's own promise resolved.
Fixed to `await loadTasks()` in all three, then re-verified the full
add/toggle/delete flow end to end.

**Feedback**: sent directly to Admin, genuinely anonymous - the
`feedback` table has no user-identifying column at all, not even for
Admin's own view, not encrypted or hashed, nothing. Confirmed directly
that no request-logging middleware exists in `server.js` that could
leak identity at the infrastructure level either. Worth restating
here since it's a real caveat, not a formality: this guarantee is at
the application level only - the hosting platform's own infrastructure
logs (IP address, etc.) are outside this application's control.
Admin-only read access (`requireRole('admin')`, not Manager, per
explicit direction - unlike every other oversight feature in this app).

**QR scanner**: `jsQR` added via CDN - the one exception to the app's
otherwise dependency-free footprint (no browser-native API for QR
decoding, and hand-rolling it isn't practical). Opens the rear camera,
decodes video frames in a loop, and navigates to the matched keg's
page. Never trusts scanned content beyond extracting a keg ID from
it - no `eval()` or code execution from decoded text. Verified the
core extraction logic with 3 cases (a full printed-QR-code URL, a bare
keg ID, and an irrelevant QR code that correctly gets rejected rather
than navigating anywhere) - actual camera access and live video frame
decoding couldn't be tested in this environment and would need
real-device verification.
