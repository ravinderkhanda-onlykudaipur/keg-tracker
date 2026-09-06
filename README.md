# Keg Tracker (MVP)

A working implementation of the QR-code keg tracking system: scan a keg's
QR code, log a role-specific event (Filler, Washer, Driver, Warehouse),
and see the keg's full history. Admin and Manager roles oversee the
whole operation from the admin page. Built to match the requirements doc
discussed earlier. Deployed live at Render.

## What's here

- `server.js` — Express app entry point; runs `db.init()` then
  auto-seeds demo data on boot
- `db.js` — PostgreSQL connection pool + schema (Keg, User, Event/Log,
  Customer, Device tables), using the `pg` package - see "Deploying"
  below for how to get a free database (Neon)
- `lib/stateMachine.js` — the rules for which role can move a keg from
  which status to which status (this is what stops a keg being dispatched
  before it's ever filled - dispatch and destination-assignment now
  happen together, see "Data model recap" below)
- `lib/cooldown.js` — minimum time gap required before certain actions
  can repeat on the same keg (e.g. can't mark a keg empty moments after
  delivering it) — see the gap list below for why, and how to tune the
  duration via `ACTION_COOLDOWN_MS`
- `lib/alerts.js` — flags kegs stuck too long in a status (not washed,
  not dispatched, not delivered in time, etc.) — see the gap list below
  for the full list of rules and how to tune each threshold
- `lib/reports.js` — turnover time, per-stage duration, and fill/wash
  stats, computed live from the events/kegs tables (see "Reports" below)
- `lib/sessionSecret.js` — persists the session-signing secret across
  local restarts; on Render, `SESSION_SECRET` is set as an environment
  variable instead (see "Deploying"), since Render's free tier has no
  persistent disk for this file to survive redeploys on
- `routes/auth.js` — bcrypt-hashed passwords + server-side sessions
- `routes/kegs.js` — create kegs (Admin only), generate QR codes, search/list
- `routes/events.js` — the scan-to-action endpoint every form submits to;
  also where the "destination can't be left blank" and cooldown rules live
- `routes/alerts.js` — the overdue-kegs API, used by both the admin
  dashboard and the in-app banner on the scan page
- `routes/reports.js` — the reports API (Admin/Manager only)
- `routes/customers.js` — customer CRUD (Admin/Warehouse can create,
  anyone logged in can list); feeds the destination dropdown in
  `public/scan.html` and the "Customers" section on the admin page
- `lib/deviceAuth.js` — device registration for the four operational
  roles (see "Device registration" below)
- `routes/devices.js` — Admin approves/revokes devices, Manager can view
- `routes/users.js` — Admin creates accounts and manages passwords; see
  "User accounts" below
- `routes/products.js` — the beers Filler picks from when logging a
  fill (Admin/Filler can add new ones); mirrors `routes/customers.js`
- `public/device-id.js` — generates and persists this browser's random
  device ID, used by both `scan.html` and `index.html` at login
- `public/index.html` — admin page: log in, create kegs (Admin only),
  view QR codes, browse all kegs, see the full alerts, reports, and
  device-approval dashboards (Admin/Manager)
- `public/scan.html` — the mobile page a worker sees after scanning a QR
  code; the form fields change based on their role and the keg's status;
  also shows a banner if other kegs are overdue for that person's role
- `public/sw.js`, `public/offline-queue.js` — offline support: caches the
  scan page for zero-signal loading, queues actions locally when offline
  and syncs them once back online

## Roles

- **Filler, Washer, Driver, Warehouse** — the four operational roles;
  each only sees the form for their own job at the keg's current status
  (see `public/scan.html`)
- **Admin** — can do everything Manager can, plus create new kegs (the
  only role that can)
- **Manager** — read-only: sees the same kegs list, QR codes, and alerts
  dashboard as Admin, but the "Create a new keg" form doesn't appear for
  them, and the backend rejects a create-keg request from any non-admin
  role even if attempted directly against the API

## Device registration

The four operational roles are also restricted to approved devices - see
`lib/deviceAuth.js`. **Approval is per individual user, not per role** -
a device approved for one washer does not automatically work for a
different washer sharing that role. **Each person's first successful
login auto-registers that device for them**, since otherwise nobody
could ever log in the first time; every device after that for that same
person needs Admin approval from the "Devices" section on the admin
page. Blocked attempts aren't just rejected - they're logged as a
pending request Admin can review and approve without needing anyone to
read out a device ID over the phone.

Deliberately **not** applied to Admin or Manager: gating those risks an
unrecoverable lockout (if the only Admin's device ever changed, nobody
would be left to approve a fix), and they legitimately might check things
from a home computer or office desktop without that being suspicious.

**In practice, if you've been testing one user from one phone**, that
first login auto-bootstrapped it for that person - you won't see any
rejection there. You'd hit the "not approved" message either by logging
in as that same person from a *second* device, or by logging in as a
*different* person (even sharing the same role) from a device that was
only ever approved for someone else - both are exactly the scenarios
this is meant to catch.

The device identifier itself (`public/device-id.js`) is a random ID
generated once and stored in that browser's local storage - not
fingerprinting, nothing derived from the device's actual hardware. It's
also reset if someone clears their browser data or reinstalls the app,
so this is a real but soft signal, not a hard security guarantee.

## Run it locally

You'll need [Node.js](https://nodejs.org) 18+ and a Postgres database.
The free option we use is [Neon](https://neon.tech) — permanent free
tier, no credit card. Sign up, create a project, and copy its connection
string (shown right on the dashboard, looks like
`postgresql://user:pass@ep-xxxxx.region.aws.neon.tech/dbname?sslmode=require`).

```bash
npm install
DATABASE_URL="<your Neon connection string>" npm start
```

On startup the app creates its tables (if they don't exist) and
auto-seeds 6 demo users, 3 demo customers, and a demo keg (if the
`users` table is empty).

Then open **http://localhost:3000** — that's the admin page. Log in as
**"Alex Admin"** (password `demo1234`) to create kegs, or **"Mona
Manager"** to see the same view read-only. All 6 seeded demo users share
password `demo1234`.

To try the scan flow: open
**http://localhost:3000/scan.html?keg=DEMO-KEG-1**, log in as "Wes Washer"
(password `demo1234`), submit a wash. Then log in as "Fiona Filler" and
fill it (Beer Name, Batch Number, and ABV are all required). Then log in
as "Wally Warehouse" and assign a delivery destination — this both sets
the destination **and** dispatches the keg in the same step. Then log in
as "Dana Driver" to confirm delivery. Try filling before washing, or
submitting an assignment with a blank destination — the state machine and
the server both reject these with a clear error.

On an actual phone: visit `/api/kegs/DEMO-KEG-1/qrcode.png`, print or
display it, and scan it with any camera app — it opens the scan page
directly.

**Trying offline mode:** open the scan page once while connected (this
primes the cache), then turn on Airplane Mode and submit an action — it
queues locally instead of failing, and syncs automatically once
connectivity returns (or tap "Sync now").

## Alerts

`lib/alerts.js` flags any keg that's been sitting in a status too long
without the next step happening. Each rule has its own environment
variable (in **hours**), so thresholds can be tuned without touching
code — set one small (e.g. `1` or even `0.1`) on Render for testing:

| Status | Env var | Default | Alerts |
|---|---|---|---|
| `empty_returned` (not washed) | `ALERT_WASH_HOURS` | 48 (2 days) | Washer |
| `washed` (not filled) | `ALERT_FILL_HOURS` | 48 (2 days) | Filler |
| `filled` (not dispatched) | `ALERT_DISPATCH_HOURS` | 120 (5 days) | Warehouse |
| `dispatched` (not delivered) | `ALERT_DELIVERY_HOURS` | 12 | Driver |
| `needs_repair` (not resolved) | `ALERT_REPAIR_HOURS` | 24 | Warehouse |

A keg's "time in its current status" is the time since its most recent
event (or its creation time, if it has none yet) — exactly when it
entered that status, no separate tracking column needed.

Two places surface this:
- **Admin/Manager dashboard** (`public/index.html`) — the full breakdown
  across every category, for anyone with oversight
- **In-app banner** (`public/scan.html`) — after logging in, an
  operational role sees a count of *other* kegs overdue for their own
  role (e.g. a washer sees "3 other kegs are overdue for your role"),
  filtered client-side from the same `/api/alerts` endpoint

No push notifications or SMS/email yet — see the gap list below for what
that would take.

## Reports

`lib/reports.js` computes turnover time and utilization stats live from
the events/kegs tables — no separate reporting table needed, since the
full audit trail already has everything. Restricted to Admin and
Manager (`routes/reports.js`), same as the rest of the oversight-level
admin page.

- **Current inventory** — how many kegs sit in each status right now
- **Average time per stage** — how long kegs typically spend in each
  status before moving on (based on completed stays only; a keg's
  current, still-ongoing stay is deliberately excluded here since
  that's what Alerts already covers)
- **Full-cycle turnover time** — average time between consecutive
  washes on the same keg, i.e. one full trip through the whole pipeline
- **Fill stats** — total fills, total liters (fixed at 20L/fill), and a
  breakdown by product name
- **Wash inspection results** — pass/fail counts and fail rate
- **Customers holding kegs longest** — average time each customer holds
  a keg (counting both `delivered`, full, and `empty_at_customer`,
  empty-but-not-picked-up time), ranked longest-first - the report
  customer management was specifically built to enable

Shown as simple horizontal bar charts on the admin page, built with
plain CSS (no charting library dependency).

**Trying GPS location:** on the driver's pickup field, and the
warehouse's zone/storage fields, tap "Use my location" to auto-fill real
GPS coordinates (requires HTTPS and location permission — works on the
Render deployment, not on plain `http://localhost`).

## Deploying (currently: Render, free tier, + Neon Postgres)

1. **Database:** create a free Neon (neon.tech) project, copy its
   connection string.
2. Push this repo to GitHub.
3. Create a Render Web Service connected to the `main` branch.
   Build command: `npm install`. Start command: `npm start`.
4. Set two environment variables in Render's dashboard:
   - `DATABASE_URL` → the Neon connection string
   - `SESSION_SECRET` → a fixed random value
     (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
     — without this, everyone gets logged out on every redeploy (see the
     note below on why this alone isn't the full picture, though).
5. Push to `main` → Render auto-deploys.

**On schema changes now that the database persists:** since data no
longer resets on every redeploy, adding a new column to an existing
table needs an explicit migration, not just editing the `CREATE TABLE
IF NOT EXISTS` in `db.js` (that's a no-op once the table already
exists). `db.init()` in `db.js` runs any needed `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS` statements after the `CREATE TABLE` block, safe
to run on every boot since `IF NOT EXISTS` makes them a no-op once
already applied. Follow this same pattern for any future schema change.

**What moving to Postgres actually fixed:** previously (SQLite on
Render's local disk), kegs/events/customers/device approvals — all of
it — reset on every redeploy, since Render's free tier wipes local disk
on every restart. Now that data lives in Neon, independent of the app's
own deploys, it persists properly. This was worth doing specifically
because of how much real functionality had accumulated by this point
(customers, alerts, reports, device approvals) — none of which was
actually sticking around before this.

**About `SESSION_SECRET` and staying logged in — resolved:** setting
this environment variable is still the right thing to do (it keeps the
cookie-signing secret stable and unguessable), but on its own it never
stopped people from being logged out on redeploy/restart/sleep-wake -
that required session *data* (who's actually logged in) to live
somewhere persistent too, not just the signing secret. It now does:
sessions are stored in the same Postgres database via
`connect-pg-simple` (see `server.js`), instead of Express's default
in-memory store. Logins should now survive Render's redeploys, restarts,
and sleep-wake cycles - not just keg/event/customer data.

Also: the free web service sleeps after 15 minutes of no traffic (first
visit after that takes ~1 minute to wake up).

## Known gaps (by design — this is the MVP, not the finished system)

Roughly in priority order:

1. ~~**Real authentication.**~~ Done: bcrypt-hashed passwords + server-side
   sessions, with individual per-user accounts and password management
   (see "User accounts" below - was gap #19, now closed). Still worth
   doing eventually: account lockout after repeated failed login
   attempts (not implemented - not urgent for an internal tool, but
   worth knowing it's missing).
2. ~~**Offline support.**~~ Done for the core case (see `public/sw.js` and
   `public/offline-queue.js` above). Scoped to **one pending action per
   keg at a time** — see the comment at the top of `offline-queue.js` for
   why. Known limits: history/status shown while offline are a
   locally-cached snapshot, not live; and a device's very first visit
   still needs one successful connection before offline mode works on it.
3. ~~**GPS location capture.**~~ Done — "Use my location" button on
   relevant fields, via the browser's Geolocation API.
4. ~~**Destination assigned by Warehouse, not typed by the driver.**~~
   Done — see `assign_destination` in `lib/stateMachine.js` and
   `routes/events.js`. Superseded by gap #8 below: this action now also
   dispatches the keg directly, rather than just setting the destination
   and waiting for a separate driver step.
5. ~~**Required explanation on failed wash inspection.**~~ Done — the
   washer's damage notes field becomes required, with a 30-character
   minimum, when inspection is marked "fail" (`requiredWhen` in
   `ROLE_ACTIONS`, checked in `checkRequiredFields()`,
   `public/scan.html`). A photo requirement was considered and
   deliberately dropped - storing images as base64 in SQLite doesn't
   scale well; a detailed text explanation covers the need without that
   overhead.
6. ~~**Prevent duplicate submissions.**~~ Done — `submitEvent()` disables
   the submit button and ignores repeat clicks while a submission is in
   flight (`isSubmitting` guard in `public/scan.html`).
7. ~~**Required filler fields; simplified fill fields.**~~ Done — Beer
   Name, Batch Number, and ABV are now required (`required: true` in
   `ROLE_ACTIONS.filler`). Fill volume is fixed at 20L, recorded
   automatically rather than asked as a field (`fixedDetails` on the
   filler config); best-before date was removed entirely.
8. ~~**Simplified dispatch: Warehouse assigning a destination now
   dispatches directly.**~~ Done — `assign_destination` moves the keg
   straight from `filled` to `dispatched` in one step
   (`lib/stateMachine.js`), instead of Warehouse setting a destination
   and then waiting for a separate driver-initiated "dispatch" step. The
   driver's first involvement is now confirming delivery once it's
   already dispatched. This also resolved an earlier version of this
   flow where Warehouse could get stuck being asked for "Log location /
   status" repeatedly after assigning a destination, with no way to move
   the keg forward.
9. ~~**Only the correct role can fill in details for a given status.**~~
   Done — `getActionConfig()` in `public/scan.html` now checks the keg's
   status for every role (previously only Driver and Warehouse did;
   Washer and Filler would show their form regardless of status, only
   getting rejected by the server after submitting). Verified against
   every possible role × status combination to confirm the frontend
   never shows a form the backend would reject. When it's not someone's
   turn, they now see a clear red warning ("No details need to be filled
   by you right now") instead of a plain gray note, and it names which
   role the keg is actually waiting on (`STATUS_EXPECTED_ROLE` lookup).
10. ~~**Cooldown between certain actions on the same keg.**~~ Done —
    `lib/cooldown.js`. A driver could log delivery and immediately mark
    the same keg empty in one sitting, even though "empty" is really a
    separate, later real-world moment. Requires a minimum time gap since
    the prior `deliver` event, enforced server-side (429 response with a
    clear "time remaining" message). Duration is set via the
    `ACTION_COOLDOWN_MS` environment variable — defaults to 1 day
    (`86400000`) if unset; set it to something short like `60000` (1
    minute) on Render for testing, and back to a day (or remove it) for
    real use. No code change needed to adjust it.
11. ~~**Removed the generic "Log location/status" step for Warehouse
    entirely.**~~ Done — this used to be offered as a catch-all for
    several statuses, but had no natural stopping point (nothing to move
    it forward) and was redundant right after receiving an empty keg
    (which already asks for a storage zone). Warehouse now has exactly
    two jobs, each tied to one specific status: assign a destination
    (`filled`, which also dispatches) and receive an empty keg
    (`empty_at_customer`). Every other status correctly shows the "not
    your turn" warning instead. Verified this leaves all 6 statuses each
    owned by exactly one role, with zero gaps or overlaps.
12. ~~**A failed wash inspection had no real consequence.**~~ Done — a
    failed inspection now routes the keg to a new `needs_repair` status
    instead of `washed` (`lib/stateMachine.js`'s `wash` rule, now a
    function of the submitted `inspection` value rather than a fixed
    status). A `needs_repair` keg can't be filled — `fill` only accepts
    `washed` — until Warehouse runs the new `mark_repaired` action,
    which sends it back to `empty_returned` for a full wash + inspection
    cycle again, not straight to `washed`. Verified the whole
    fail → blocked-from-filling → repaired → re-washed → fillable cycle
    end to end against a real database, plus that this still leaves
    every status owned by exactly one role (now 7 statuses, still zero
    gaps or overlaps).
13. ~~**Move off SQLite to a real hosted database.**~~ Done — moved to
    Postgres via Neon's free tier. Every query across the whole app
    (auth, kegs, events, customers, alerts, reports, device approvals)
    converted from SQLite's synchronous API to Postgres's async one.
    Caught and fixed three real bugs in the process, worth knowing:
    (1) `COUNT(*)` comes back as a string in Postgres (a bigint), not a
    number - fixed everywhere it's used; (2) a `GROUP BY` query needed
    verifying against Postgres's stricter rules (confirmed correct via
    functional dependency on the primary key); (3) the IST timestamp
    formatter in `scan.html` was hardcoded for SQLite's old
    space-separated text format - Postgres serializes timestamps as full
    ISO strings instead, which would have silently broken date display
    ("Invalid Date") without a fix - now handles both formats, tested
    against each. See "Deploying" above for the current setup.
14. ~~**Persistent session storage.**~~ Done — turns out we didn't need
    a separate Redis service after all: since the database is now a real
    persistent Postgres instance (Neon) rather than ephemeral SQLite,
    sessions can live right there too. `connect-pg-simple`
    (`server.js`) manages its own `user_sessions` table (auto-created on
    first run, expired rows pruned automatically) - a pure-JS package,
    same reasoning as choosing `node:sqlite` and `pg` earlier: no native
    compilation, no repeat of the `better-sqlite3` crash. Verified the
    exact wiring pattern (Store construction, session() factory) against
    a stub matching the real package's API. This was genuinely the
    **last** "state doesn't stick around" gap — logins should now
    survive Render's redeploys/restarts/sleep-wake cycles, not just keg
    data.
15. ~~**Alerts.**~~ Done — see the "Alerts" section above. Computed live
    on request (`lib/alerts.js`), not a scheduled/cached job, which is
    fine at this scale but worth revisiting if the kegs/events tables
    grow large. Surfaced via an admin dashboard and an in-app banner;
    real push notifications or SMS/email would need external services
    (not done, matches the same tradeoff as gap #14 above).
16. ~~**Admin and Manager roles.**~~ Done — `admin` can create kegs (the
    only role that can, enforced server-side via `requireRole('admin')`
    in `routes/kegs.js`, not just hidden in the UI); `manager` sees
    everything Admin sees (kegs list, QR codes, alerts dashboard) but
    the create-keg form doesn't render for them and the backend rejects
    the request even if attempted directly. Verified with mocked
    request/response objects that admin passes through, manager and
    every operational role get a 403, and an unauthenticated request
    gets a 401.
17. ~~**Reporting dashboards.**~~ Done — see the "Reports" section below.
    Computed live on request (`lib/reports.js`), same tradeoff noted for
    Alerts above. Simple bar charts via plain CSS - no charting library
    dependency. Tested against a hand-built scenario with known,
    controlled durations to confirm every number (stage averages,
    turnover time, fill/wash stats) matches exactly.
18. ~~**Customer management.**~~ Done — the `customers` table existed in
    the schema from the start but was never actually used; destination
    was just free text. Now a real feature: `routes/customers.js`
    (Admin and Warehouse can create customers, anyone logged in can
    list them), a dropdown on Warehouse's "Assign destination" form
    (`type: 'customer_select'` in `public/scan.html`) instead of typing,
    with an inline "+ Add new customer" option so Warehouse isn't
    blocked the first time they need a customer that doesn't exist yet.
    Kegs now link to a real `customer_id`, which powers a new "who holds
    kegs longest" report (`getCustomerHoldStats()` in `lib/reports.js`,
    tested against a two-customer scenario with known hold durations).
19. ~~**Device registration for operational roles.**~~ Done — see
    "Device registration" above. Restricts login as Filler, Washer,
    Driver, or Warehouse to Admin-approved devices, after a
    trust-on-first-use bootstrap. Tested extensively given the
    security-sensitive nature: bootstrap on first login, same device
    allowed again, a genuinely different device blocked and logged as
    pending (not silently dropped), Admin/Manager confirmed exempt even
    across wildly different devices, a missing device ID rejected
    cleanly without logging a bogus request, repeat attempts from the
    same blocked device confirmed not to spam duplicate pending rows,
    and the full approve → now-allowed and revoke → blocked-again
    round trips both confirmed against a real database. Route-level
    permissions also verified: Admin can approve/revoke, Manager can
    view only, operational roles can't reach this API at all. Known
    limitation, stated plainly: the device ID lives in that browser's
    local storage, so it resets if someone clears their data or
    reinstalls - a real signal for casual/accidental cases, not a hard
    guarantee against someone deliberately spoofing it.
20. ~~**Individual user accounts.**~~ Done — see "User accounts" below.
    `routes/users.js`: Admin creates real accounts with their own
    passwords, resets anyone's password, and deactivates (never
    deletes) an account. Self-service password change for any logged-in
    user via `routes/auth.js`'s `/change-password`. Tested seven
    scenarios directly: a new account's own password works and the old
    shared one doesn't apply to it; resetting a password invalidates
    the old one and the new one works; a deactivated account is
    rejected even with the correct password; reactivating restores
    login; deactivated accounts are excluded from the login dropdown;
    and - the one requiring real care - deactivating the **last**
    active admin is blocked outright (same lockout-avoidance principle
    as device registration's admin exemption), while a second admin
    account can still be deactivated normally. Route permissions
    verified too: listing is Admin/Manager, everything else
    (create/reset/deactivate/reactivate) is Admin only.
22. ~~**UI polish: font size, color theme, product dropdown, clearer
    optional fields, destination address, manufacturing number.**~~
    Done, several distinct fixes bundled together:
    - **Font size and color theme** — both `scan.html` and `index.html`
      rebuilt with a larger base font (16px, which also avoids iOS
      Safari's auto-zoom-on-focus for small inputs) and a warm
      cream/copper palette instead of the earlier stark white/gray, via
      CSS custom properties for consistency.
    - **Filler's Beer Name is now a dropdown** (`type: 'product_select'`
      in `ROLE_ACTIONS.filler`, backed by a new `products` table -
      `routes/products.js`, mirrors the customer-dropdown pattern
      exactly, including an inline "+ Add new beer"). Selecting a
      product auto-fills its typical ABV, still editable. Deliberately
      submits the beer's **name** as the value (not a database id) -
      keeps `details.product` exactly the string `lib/reports.js`'s
      `getFillStats()` already expects, so existing fill history and
      reports keep working unchanged.
    - **Location fields clarified as optional** — turned out these
      were never actually required in the code (checked directly
      before making any change); the confusion was a labeling gap, now
      fixed by showing "(optional)" next to Warehouse's storage-zone
      and Driver's delivery-location fields.
    - **Driver sees the customer's address, not just their name** — a
      new `destination_address` column on `kegs`, resolved from the
      customer record at the same time as the name in
      `routes/events.js`, shown together on the scan page.
    - **Manufacturing keg number** — a new `manufacturing_number`
      column, captured on the admin page's "Create a new keg" form,
      shown next to the keg's system ID on both the scan page and the
      admin kegs table.
    - **A real bug caught before shipping**: switching the "add new
      customer/beer" box from an inline style to a CSS class would have
      broken its show/hide toggle (checking `element.style.display`
      directly no longer reflects the actual rendered state once
      visibility comes from a class) - traced through the exact
      before/after behavior to confirm the fix, rather than just
      assuming it worked.
24. ~~**Dark mode, larger fonts, restructured header, manufacturing
    number restricted to Admin/Manager.**~~ Done:
    - **Dark theme + larger fonts** on both pages, via the same CSS
      custom-property approach as before (a dark warm-brown palette,
      18px base font). History intentionally kept at its smaller,
      original size on request - a dense past-events list reads better
      compact and doesn't need the same emphasis as the action someone's
      actually taking right now.
    - **Restructured `scan.html` header**: a keg-shaped SVG logo
      centered at the top, "logged in as X" on the left with "log out"
      on the right below it, then the keg's status in bold capitals
      (via `text-transform: uppercase` on `.status-pill`, so no JS
      string manipulation needed - the underlying data stays normal
      case).
    - **The "wrong turn" warning banner is now bold and fully capitalized.**
    - **Manufacturing number restricted to Admin/Manager** - this is a
      real backend access-control fix, not just hiding it in the UI:
      `routes/kegs.js` strips `manufacturing_number` out of the API
      response entirely for every other role, including anyone not
      logged in. Verified across all 4 operational roles plus
      logged-out - all correctly see it stripped, only Admin/Manager
      see it. **Caught a real bug while implementing this**: neither
      `scan.html`'s nor `index.html`'s keg-fetching `fetch()` calls were
      sending `credentials: 'include'`, meaning the session cookie
      never reached the server on those specific requests - so even
      Admin/Manager would never have actually seen the number, despite
      the backend logic being correct. Fixed both.
25. ~~**Customer phone number; destination shows name+address+phone;
    removed self-service password change; removed keg ID after
    scanning; show all kegs to Admin (no 7-item cap).**~~ Done:
    - **Customers now have a phone number** alongside name and address
      - new `customers.phone` column, both add-customer forms updated
      (scan.html's inline one and the admin Customers card), the
      Customers table shows it too.
    - **Driver's destination display shows name, address, AND phone**
      - `routes/events.js` resolves and stores all three
      (`destination`, `destination_address`, `destination_phone`) from
      the customer record when Warehouse assigns a destination.
    - **Self-service password change removed** from both pages -
      Admin's "Reset password" is now the only way a password changes.
      The now-unused `/api/auth/change-password` backend route was
      removed too, not just hidden in the UI.
    - **Keg ID no longer shown after scanning** - the whole title
      display and its supporting function were removed from
      `scan.html`, not just hidden.
    - **Admin's kegs table shows everything now**, no 7-item display
      cap (that cap remains on Alerts and Devices, which weren't part
      of this request). The backend's own `LIMIT 200` in
      `routes/kegs.js` is still there as a sane upper bound - worth
      raising if the business ever exceeds that many kegs.
26. ~~**Proper installable mobile app (PWA manifest + icons).**~~ Done —
    previously "Add to Home Screen" just created a bookmark that still
    opened with the browser's address bar visible. Now: a real app icon
    (generated from the same keg-shaped SVG logo used in the header,
    `public/icon-192.png`/`icon-512.png`/`apple-touch-icon.png`), a web
    app manifest (`public/manifest.json`) for Android/Chrome, and the
    matching `apple-mobile-web-app-*` meta tags for iOS Safari (which
    doesn't fully honor the manifest on its own). Installed this way,
    the app opens full-screen with no browser chrome, like a native app.
    Service worker cache bumped to include these new files.
27. ~~**Tabbed admin layout with an Overview dashboard.**~~ Done - the
    admin page was one long scroll through Alerts, Reports, Devices,
    Users, Products, Customers, and the kegs table. Now organized into
    tabs (Overview, Kegs, Customers, Products, Reports, Users, Devices),
    same data and functions as before, just reachable directly instead
    of scrolled past. Reports/Users/Devices tab buttons are hidden
    entirely for non-Admin/Manager roles, matching the same access
    restriction those sections already had. The new Overview tab adds a
    simple KPI row (total kegs, with customers, in transit, needs
    repair) computed client-side from the kegs list already being
    fetched - no new endpoint needed - plus the existing Alerts list.
    Tested the KPI counting logic and the tab-panel/button wiring
    directly before shipping.
28. ~~**Light theme with a specific design system (colors + type
    scale).**~~ Done - replaced dark mode with a provided palette and
    typography spec (see "Design system" below). Verified with a direct
    sweep afterward that zero heavy font-weights (600+) or uppercase
    text-transforms remained anywhere in either page - the spec called
    for exactly two weights (400/500) and sentence case throughout, and
    both pages previously had several of each from the dark-mode round.
    Regenerated all three app icons and the PWA manifest colors to
    match, since the old ones were designed for the dark palette.
29. ~~**Per-user device authentication, editing, damage reporting, data
    export, personalized home screen, zoom restriction, Only K logo.**~~
    Done, several distinct changes bundled together:
    - **Device approval moved from per-role to per-user** - a device
      approved for one washer no longer automatically works for a
      different washer sharing that role; each individual needs their
      own device approved. Real schema change (`device_registrations`/
      `device_approval_requests` now keyed by `user_id`, not `role`),
      with a careful non-destructive migration for the existing
      database - old role-keyed rows can't be attributed to a specific
      person under the new model, so they're removed (everyone's device
      needs approving once more under the new system) rather than kept
      as meaningless data. Tested 5 scenarios directly against a real
      in-memory store, including the critical one: a device already
      approved for one washer is correctly rejected for a different
      washer.
    - **Editing** for Customers, Products, and Users (name/role) -
      Admin only, via simple prompt-based dialogs. **Caught and fixed a
      real bug before shipping**: the first version embedded each row's
      data directly into an inline `onclick` attribute via
      `JSON.stringify()`, which breaks the HTML if any name contains an
      apostrophe (e.g. "O'Brien's Pub") - fixed by caching the fetched
      list client-side and looking up by ID instead.
    - **Driver damage reporting** - a new `report_damage` action
      (`lib/stateMachine.js`), available from `dispatched` or
      `delivered`, routing to `needs_repair` (same resolution path as a
      failed wash inspection). Tested 5 scenarios including the full
      repair cycle end-to-end.
    - **CSV export** of all kegs - Admin/Manager only, a plain download
      link on the Kegs tab. Tested the CSV-escaping logic directly
      (commas, quotes, null values).
    - **Personalized home screen** - opening the scan page without a
      keg in the URL (e.g. from an installed home-screen icon) now
      shows a time-of-day greeting instead of erroring out trying to
      fetch a keg that was never specified.
    - **Zoom restricted to zoom-in only** - `minimum-scale=1.0` in the
      viewport meta tag blocks zooming out past the default view,
      `maximum-scale=5.0` still allows zooming in for readability.
    - **Only K logo** replaces the placeholder keg icon everywhere - the
      PWA icons, and the in-app header/login logos on both pages.
      Extracted from the provided PDF at high resolution, precisely
      cropped to just the circular mark (excluding the wordmark, which
      doesn't read well at icon sizes), verified legible at actual
      home-screen size before finalizing.
30. ~~**Full history CSV export, History restricted to Admin/Manager,
    Fill Details for everyone else, simplified warning banner, header
    redesign, in-app camera QR scanner.**~~ Done:
    - **Full event-history CSV export** - a genuine audit trail
      (`GET /api/kegs/export-history.csv`, Admin/Manager only), one row
      per event with timestamps, alongside the existing current-status
      snapshot export (kept, since it serves a different purpose).
      Tested the CSV-escaping directly, including the tricky case of a
      comma embedded inside the JSON details field.
    - **History card is Admin/Manager only** on the scan page - every
      other role sees a "Fill details" card instead (beer, batch
      number, ABV from the most recent fill event), which is what
      they'd realistically need day-to-day rather than the full audit
      trail. Tested the fill-event lookup logic directly, including the
      not-yet-filled case.
    - **Warning banner simplified** to "Keg is pending on: [role]" -
      down from a longer explanation.
    - **Header redesigned**: "Logged in as" text removed, the user's
      name and the Log Out button are now matching pill-style chips
      sitting next to each other, instead of one being plain text and
      the other a distinct red button.
    - **In-app camera QR scanner** - a fixed bottom-middle "Scan"
      button, available to every role (not just the four operational
      ones - it's just navigation, not a permission-sensitive action).
      Uses `getUserMedia` + jsQR (a small dependency-free decoder
      loaded via CDN, cached by the service worker after first use so
      it keeps working offline once it's been loaded once). Tested the
      QR-content parsing logic directly against 4 cases (a real
      generated URL, a local-dev URL, a raw keg ID fallback, and an
      unrelated/malformed QR correctly producing an error instead of
      navigating somewhere wrong) - **the camera/video integration
      itself could not be tested in this environment** (no camera
      hardware here) and needs real on-device verification. Requires
      HTTPS (or localhost), same as the GPS buttons elsewhere on this
      page.
31. ~~**Warning banner layout bug, header chip positioning, status pill
    removed, scan button restyled, alerts show serial number.**~~ Done:
    - **Fixed a real layout bug**: the warning banner had its own
      background/border, nested inside `#formCard` which already had
      identical card styling - this produced the visible "two cards
      stacked" effect reported. Fixed by stripping the banner's own
      card-like styling so it just renders as text within the single
      existing card.
    - Warning simplified further: the ⚠ sign removed, now reads "Keg is
      pending on: **ROLE**" with the role in green, uppercase (matches
      the existing `.status-pill` pattern of applying caps via CSS
      `text-transform`, not by mutating the underlying string).
    - Header chips (user name / Log Out) moved back to opposite ends
      (`justify-content: space-between`) - the prior round had them
      adjacent based on an earlier, more ambiguous phrasing of the same
      request.
    - **Status pill removed** from the scan page entirely, per explicit
      request (described as "the location of the keg card" showing
      values like "dispatched"/"returned") - Destination and Alerts
      banners are unaffected. **Worth knowing**: this was the more
      genuinely ambiguous part of the request, interpreted as literally
      as possible; flagged clearly at the time in case it wasn't the
      intended scope, since the original UI-spec discussion earlier in
      this project explicitly listed "always show status prominently"
      as a rule worth keeping.
    - Scan button restyled as an icon-only circular button (an SVG
      viewfinder-bracket icon, the same visual language as iOS's scan
      icon) instead of a text-and-emoji pill.
    - Fill Details card now shows the keg's ID, centered, above the
      beer/batch/ABV details - the one place Keg ID still appears,
      since it was otherwise removed page-wide per an earlier request.
    - Admin's Alerts list now also shows each keg's manufacturing
      number (labeled "Serial") alongside the already-clickable Keg ID
      link. This required a real access-control fix: `/api/alerts` is
      also used by operational roles' own alert banners on the scan
      page, so manufacturing number is stripped for non-Admin/Manager
      requesters there too - same rule as `routes/kegs.js`, verified
      with a direct test of both cases.
32. ~~**Tap-to-call phone number, alert banner shows actual overdue Keg
    IDs with links, Fill Details header removed and Keg ID bolded.**~~
    Done:
    - Destination card's phone number is now a real `tel:` link, not
      plain text.
    - The overdue-alert banner (`loadMyAlerts()` in `scan.html`) now
      lists each actual overdue Keg ID as a clickable link to that
      keg's own page, instead of just a count - tapping one is how you
      check its status. Tested the link-generation logic directly
      against multiple overdue kegs and the singular/plural, on-a-keg
      vs on-the-home-screen phrasing variants.
    - Fill Details card's "Fill details" header text removed; the Keg
      ID shown in that card is now genuinely bold (font-weight 700).
      **Worth noting**: this is a deliberate, explicitly-requested
      exception to the "two weights only, 400/500" typography rule from
      the design-system spec a few rounds back - flagging it here so
      it's not mistaken for an inconsistency later.
33. ~~**Removed Keg ID/links from the operational alert banner.**~~
    Reverted a piece of the previous round on request: the per-keg
    alert banner on `scan.html` (Filler/Washer/Driver/Warehouse's own
    "N kegs overdue" notice) is back to a count only - no keg IDs, no
    one-tap shortcut to the action form. Reasoning: a clickable
    shortcut straight from the alert to the wash/fill/dispatch form
    would make it too easy to log an action without actually being
    physically at that keg to scan it, undermining the whole point of
    QR-based verification. **Admin/Manager's alerts list on the admin
    page is deliberately different** and keeps its clickable keg IDs -
    they're not the ones performing these physical actions, so there's
    no equivalent risk for them; that's an oversight tool, not a
    shortcut into the operational workflow.
34. ~~**QR-code-style scan button icon, matched to the logo, larger
    size.**~~ Done - the scan button's icon now includes a small
    QR-pattern grid inside the viewfinder brackets (not just generic
    corner brackets), so it reads as "QR scan" specifically. Button
    grew from 62px to 76px, icon from 26px to 48px. Background/icon
    color already matched the logo's blue (both use the same
    `var(--primary)` value as the header logo), made that explicit in
    the CSS rather than relying on inheritance from the general button
    style. **Actually rendered and visually inspected the icon at
    real proportions** (including within the final circular button
    shape) before finalizing the size, rather than guessing - the
    first size attempt looked too small relative to the button once
    actually rendered, adjusted based on that.
35. ~~**Card reordering, proportional font increase, label/value
    two-column layout for Destination and Fill Details.**~~ Done:
    - Cards on `scan.html` reordered to: the pending-action card first
      (warning or the actual form), then Destination, then Fill
      Details (or History for Admin/Manager), then the home-screen
      greeting, with the overdue-alert banner now genuinely last.
    - Font sizes increased ~15% across the board, keeping the same
      proportional ratios between tiers as the original spec
      (20/16/14/13/12 -> 23/18/16/15/14) rather than bumping any one
      size arbitrarily. Inputs stay at 16px regardless (the documented
      iOS-zoom-prevention exception); buttons now scale normally since
      they don't share that constraint.
    - Both the Destination card and Fill Details card now use a
      two-column label/value layout - field name on the left, actual
      data on the right (`.lv-row`/`.lv-label`/`.lv-value` in the CSS),
      instead of running text or the earlier centered treatment.
36. ~~**Fill Details card redesign: status/next-status, prominent Keg
    ID, icon-column beer/batch/ABV.**~~ Done - scoped presentation-only
    changes (no structural/navigation changes), inspired by a
    ChatGPT-generated design brief but adapted to the actual existing
    codebase and design system rather than following it literally
    (that brief assumed a React/Next.js/Tailwind stack this app doesn't
    use):
    - A compact "Current status → Next" row at the top of the Fill
      Details card - `STATUS_NEXT` in `scan.html` is a pure display
      mapping mirroring the real lifecycle in `lib/stateMachine.js`,
      not a second source of truth (no validation logic here, that
      stays entirely server-side as always). Tested it covers all 7
      real statuses.
    - Keg ID is now the visually dominant element on the card (26px,
      bold, centered) instead of just another label/value row.
    - Beer/Batch/ABV redisplayed as three compact icon columns (simple
      inline SVGs in light-blue circular backgrounds, matching the
      existing palette) instead of stacked label/value rows.
37. ~~**"Now"/"Next" labeling with role, Warehouse renamed to Mover
    everywhere, Destination card icon columns.**~~ Done:
    - "Current status" relabeled to "Now" on the Now/Next card; the
      role responsible for that status now shows underneath it (e.g.
      "Filled" / "Mover"), pulled from the existing
      `STATUS_EXPECTED_ROLE` mapping.
    - **"Warehouse" renamed to "Mover" everywhere it's displayed** -
      login dropdowns, the user chip, warning banners, the admin
      Users/Devices/Alerts lists, and the create-user role dropdown.
      This is a **display-only** rename: the backend role value stays
      the literal `'warehouse'` everywhere (database, API, every
      permission check like `role === 'warehouse'`) - a small shared
      `roleLabel()` helper (duplicated in both `scan.html` and
      `index.html`, matching how other small helpers already work in
      this app) converts it for display only. Verified with a direct
      sweep that every display site got wrapped and every permission
      check was correctly left comparing the literal value. The one
      exception needing care: `editUser()`'s free-text role prompt now
      accepts "mover" as a friendly alias, normalizing it back to
      `warehouse` before sending to the backend - tested case
      insensitivity and whitespace handling directly.
    - Destination card redesigned to match the Beer/Batch/ABV icon-
      column style (Name/Address/Phone, each with a small icon).
      **Caught a real contrast issue before shipping**: the icon
      circles' light-blue background (used elsewhere on white cards)
      would have been invisible against the Destination card's own
      light-blue background - rendered and visually compared both
      before picking a white-circle variant instead, specifically for
      icons on that one card.
38. ~~**"Now"/"Next" corrected to show WHO handles the keg, not the
    status text.**~~ Corrected the previous round: the card now shows
    role names (e.g. "Washer" -> "Filler"), not status names (e.g.
    "Empty Returned" -> "Washed"). `STATUS_ROLE_FLOW` in `scan.html`
    encodes the exact role-handoff cycle - Washer -> Filler -> Mover ->
    Driver -> Mover -> Washer - verified directly against
    `STATUS_EXPECTED_ROLE` before writing it, confirming every "Now"
    matches the real status owner for all 7 statuses, and separately
    verified the full table matches the requested cycle exactly. Driver
    owns two consecutive statuses (`dispatched`, `delivered`) before
    handing off, so both correctly point to the same "Next" (Mover)
    rather than "Next" flipping partway through Driver's own two-step
    phase. The old status-to-status `STATUS_NEXT` mapping and
    `formatStatus()` helper were removed entirely as unused, rather
    than left as dead code.
39. ~~**Removed the redundant "Keg is pending on" warning, moved
    Now/Next to its own top card, added role icons, "Details filled
    by" replaces the old warning.**~~ Done:
    - The "Keg is pending on: X" warning was removed entirely - that
      information was now duplicated by the Now/Next card's "Now"
      field.
    - Now/Next moved out of the Fill Details card into its own
      standalone card, positioned first on the page (above the action
      form/Destination/everything else).
    - Small icons added for each of the four operational roles (a
      droplet for Washer, a mug for Filler, a truck for Driver, a box
      for Mover) - **actually rendered and visually compared all four
      side by side** before wiring them in, not just written blind.
    - Where "Keg is pending on" used to show (when it's not the current
      viewer's turn), the space now shows "Details filled by [name]" -
      a compact summary of the most recent logged action (who, what,
      when), using `keg.history`'s last entry. This data was already
      present in every API response regardless of role (only
      `manufacturing_number` is role-restricted) - no backend change
      needed, just reading data that was already there. Tested this
      logic directly, including the brand-new-keg case with no history
      yet.
40. ~~**Removed the "Details filled by" summary, removed icon labels,
    reduced/streamlined font sizes.**~~ Reverted a piece of the
    previous round: the "Details filled by [last person]" card (added
    when "Keg is pending on" was removed) turned out to be unwanted -
    it duplicated what the Fill Details card already shows (Beer/Batch/
    ABV, right under the Keg ID). `formCard` now simply hides itself
    entirely when it's not the current viewer's turn - relying only on
    the Now/Next card above for context - tested all three of its
    branches directly (offline-queued action, not-your-turn/hidden,
    actual action form) to confirm the show/hide toggling is correct
    in each case. Also: the text labels under every icon (Name/Address/
    Phone/Beer/Batch/ABV) were removed - icon + value only now. The
    Destination card's values dropped from 16px to 14px, reusing an
    already-established tier in the type scale rather than inventing a
    new size. While reviewing the full font-size list for genuine
    streamlining, found and removed two dead CSS rules
    (`.keg-title-row`, `.status-pill`) left over from when those
    elements were removed in earlier rounds but the CSS never was.
41. ~~**Now/Next side-by-side with vertical divider, Destination card
    converted to icon-left/value-right rows.**~~ Done:
    - Now/Next redesigned: both labels sit on the same line, split by a
      vertical divider (reusing the existing `--card-border` color
      already used for divider lines elsewhere, rather than introducing
      a new one), with each role's icon and name together in a row
      underneath its label. **Rendered and visually verified this
      layout before finalizing** rather than just writing CSS blind.
    - Destination card converted from the icon-above-value 3-column
      grid to three stacked icon-left/value-right rows (Name, Address,
      Phone) - matches the layout explicitly requested. Fill Details'
      Beer/Batch/ABV columns were deliberately left as the original
      3-column layout, since only the Destination card was asked to
      change. **Also rendered and visually verified** before
      finalizing, and confirmed via a direct code sweep that Fill
      Details' markup was genuinely untouched.
42. ~~**Excel-friendly CSV timestamps, smaller scan button, alerts moved
    to the user chip, Destination card matching a provided reference,
    custom illustrated icon set for all 8 role/detail icons.**~~ Done -
    the full batch from the provided reference images/screenshots:
    - **CSV timestamps** now convert to IST and format as
      `YYYY-MM-DD HH:MM:SS` in both exports (`formatForExcel()` in
      `routes/kegs.js`) - Excel reliably recognizes this as a real
      sortable/filterable date-time value, unlike the raw GMT ISO
      string previously exported. Tested including the tricky
      near-midnight-IST date-rollover case, and confirmed the format
      also sorts correctly as plain text.
    - **Scan button** reduced from 76px to 56px, icon scaled
      proportionally, rendered and verified before finalizing.
    - **Alerts moved from a bottom banner to a small count badge on the
      user chip** - the banner is gone entirely; a red badge with just
      the number now sits next to the name/role.
    - **Destination card rebuilt** to match the provided reference
      image: white card (previously blue-tinted), a "Customer" header,
      and a two-column layout (Name+Address on the left, Call+phone on
      the right) split by a vertical divider.
    - **Custom icon set for all 8 categories** (Washer, Filler, Mover,
      Driver, Beer, Batch, ABV, Keg) replacing the previous simpler line
      icons, redesigned to be recognizable at a glance (a keg with
      water drops for Washer, a keg being filled from a tap for Filler,
      a person pushing a hand-truck for Mover, a delivery truck with a
      keg visible inside for Driver, a bottle, a clipboard, a percentage
      inside a droplet, and a corny keg with its two posts) rather than
      literally tracing the provided reference images pixel-for-pixel.
      **Every one of the 8 was actually rendered and visually checked
      before being committed to code** - first as a full set together,
      then individually re-rendered at the actual ~34px/22px size they
      display at (not just the larger preview size) to confirm they
      stayed legible small, and two (Filler, Mover) were reworked and
      re-verified after the first version looked too cramped. The Keg
      icon is new, placed next to the Keg ID in Fill Details.
43. ~~**Now/Next hidden when it's the current viewer's own turn.**~~
    Done - `renderNowNext()` now checks `getActionConfig()` (the same
    check `renderForm()` uses) and hides the card entirely when it's
    the viewer's own turn to act, since "Now: [their own role]" would
    just repeat what the action form in front of them already implies.
    Only shows when it's genuinely someone else's turn. Tested 5
    scenarios directly - each of the four operational roles at both
    their own active status and a status that isn't theirs, plus
    confirmed Admin/Manager (who never get an action form) always see
    it, which is correct since it's their only source of that context.
44. ~~**Bigger role/detail icons, Now/Next on one line, Destination
    card redesigned again, Keg ID de-emphasized.**~~ Done:
    - Now/Next icons grew from 34px to 44px; the "Now"/"Next" label,
      icon, and role name now sit on one flex row together (previously
      the label was a separate line above) - rendered and verified
      before implementing.
    - Beer/Batch/ABV icons grew from 34px to 48px (scoped via
      `.detail-cols .detail-icon` so this doesn't also affect the
      Destination card's icons, which share the base `.detail-icon`
      class at their own size), and their value text grew from 16px to
      18px.
    - Keg ID de-emphasized as requested - down from 26px/bold to
      15px/regular, gray instead of near-black.
    - Destination card redesigned again: "Customer" now centered at
      the top; the separate person-icon (Name) and pin-icon (Address)
      combined into a single location icon, vertically centered against
      the whole name+address text block (handles the address wrapping
      to a second line without any hardcoded height, via
      `align-items: center` on the flex row); "Call" label text
      removed; the phone icon resized to match the location icon
      exactly. Rendered and verified against the requested layout
      before implementing.
45. ~~**Switched to the actual uploaded icon artwork, Now/Next back to
    column format, Beer/Batch/ABV resized, general "de-zoom" pass.**~~
    Done:
    - **Real icon images now used** instead of hand-drawn SVGs, for all
      8 categories (Washer, Filler, Mover, Driver, Beer, Batch, ABV,
      Keg). Extracted from the provided reference sheet
      (`ChatGPT_Image_Sep_3...png`) via precise circular-mask cropping
      (verified with a contact sheet showing no text bleed before
      committing), saved as PNG assets in the new `public/icons/`
      folder - **this folder must be included when deploying**, not
      just `scan.html`.
    - **Green variants generated** for the four role icons
      (`*-green.png`) - the Now/Next card needs the same artwork in two
      different colors (green for "Now", blue for "Next"), which isn't
      possible with a single raster image the way it would be with an
      SVG's `currentColor`. Recolored the stroke and background tint
      programmatically from the original blue art, verified the result
      side-by-side against the original before using it.
    - Now/Next reverted to column format (label, then icon, then role
      name, stacked vertically within each of the two columns) -
      rendered and verified against the requested layout using the
      real icons before implementing.
    - Beer/Batch/ABV icons resized to 44px, value text reduced further
      to 13px.
    - **General sizing pass** across `scan.html` in response to "the
      whole UI looks zoomed" - the base type scale was pulled back down
      close to the original pre-inflation scale (an earlier round had
      increased it ~15% across the board), and several
      individually-enlarged elements since then (chips, banners, card
      padding, destination icons) were trimmed back down too. Did not
      apply this to `index.html`, which was never part of that earlier
      inflation and was already at the smaller original scale.
46. ~~**Form controls (inputs, selects, buttons) didn't inherit the
    page's font.**~~ Fixed a real, longstanding CSS gap in both
    `scan.html` and `index.html`: `input`, `select`, and `button` don't
    automatically inherit `font-family` from the page in browsers'
    default stylesheets - without an explicit `font-family: inherit`,
    they render with the OS's default form-control font instead of
    matching the rest of the page. Since the action form (wash/fill/
    dispatch/etc.) is built almost entirely from these elements, this
    is exactly why it looked visually inconsistent with the surrounding
    text. One-line fix in each file's `input, select` and `button`
    rules.
47. ~~**Replaced icons with the actual uploaded green/blue sheets,
    fixed a white-halo cropping bug.**~~ Done - two complete 8-icon
    sheets were provided directly (pre-made green and blue variants),
    replacing the earlier approach of extracting only blue icons and
    programmatically recoloring a green version. The previous crop also
    had a real bug: the circular mask radius didn't precisely match the
    artwork's true circle edge, leaving a visible white ring around
    each icon ("looks uncool"). Fixed by detecting each icon's actual
    circle boundary via pixel-color analysis (distinguishing the light
    circle tint from both pure-white background and dark icon
    strokes), then applying a deliberately generous safety margin
    inward from that measured edge - trading a small amount of the
    circle's outer ring for zero risk of stray text or artifacts
    bleeding into the final crop. Went through 3 rounds of measure ->
    crop -> visually verify on a contrasting gray backdrop (to make any
    white halo or bleed obvious) before landing on the final version -
    the first two attempts still showed faint text-edge bleed on
    inspection and were rejected rather than shipped. Also verified
    legibility at the actual ~44-56px deployment size, not just the
    larger preview. All 12 files in `public/icons/` were replaced
    in-place - no HTML/JS changes needed, since the code already
    referenced these same file paths from the previous round.
48. ~~**Destination card's divider wasn't centered.**~~ Fixed - the
    left column (Name+Address) was `flex: 1.4` against the right
    column's (phone) `flex: 1`, deliberately giving the longer text
    more room, but this pushed the divider off-center. Both columns
    are now `flex: 1`, which guarantees a truly centered divider (a
    property of CSS flexbox, not something that needed visual
    verification the way the icon crops did).
49. ~~**Switched to real SVG vector icons, matched Destination card
    colors, tap-to-call on the whole phone area.**~~ Done:
    - All 12 icons replaced with the actual uploaded SVG vectors
      (`public/icons/*.svg`) - real vector artwork this time, not
      raster PNGs, so no cropping/masking/text-bleed concerns at all
      (confirmed by rendering all 12 together before wiring them in).
      The provided set already included matched blue/green pairs for
      the four role icons (Washer/Filler/Mover/Driver), so no
      programmatic recoloring was needed this round.
    - Destination card's location-pin and phone icons (plus the phone
      number's text color) updated to the exact blue used by the new
      icon set (`#2699E6`), rather than the app's slightly different
      existing `--primary` blue - verified by rendering the location
      icon in the new color before committing.
    - **Tap-to-call now covers the whole icon+number area**, not just
      the number text - both wrapped in a single link, so tapping the
      phone icon calls just as well as tapping the digits. Tested the
      link-building logic directly, including the no-phone-on-file
      case (link stays present but inert, no `href`).
    - Removed all 12 of the previous round's PNG icon files - only the
      new SVGs remain in `public/icons/`.
50. ~~**Destination card icons' stroke thinned to match the uploaded
    icon set.**~~ Done - the uploaded SVG set uses `stroke-width: 3` in
    a `0 0 350 350` viewBox (~0.4px effective thickness at its ~46px
    display size); the Destination card's hand-written location-pin
    and phone icons used `stroke-width: 2` in a `0 0 24 24` viewBox at
    20px display - about 4x thicker in actual rendered pixels.
    Computed the mathematically exact matching value (~0.47), but
    **rendered it at the real 20px display size and it looked too
    faint/washed out** - sub-1px SVG strokes lose crispness to
    anti-aliasing regardless of the math. Compared 4 practical
    alternatives (0.7/0.9/1.1/1.3) side by side at actual size and
    picked `1.1` - clearly thinner than the original 2, but still
    crisp and legible, rather than chasing exact numeric parity at the
    cost of visibly worse rendering.
51. ~~**Large styling unification pass: Now/Next style applied to
    Customer/Keg ID, Name style applied to Address/Beer/Batch/ABV,
    phone number hidden behind icon-only, 2:1 destination columns,
    larger role and detail icons.**~~ Done:
    - "Customer" header label now matches Now/Next's label style
      (`.status-next-label`); Keg ID now matches Now/Next's value style
      (larger, blue) instead of its own separate small-gray treatment.
    - Keg ID's small icon removed entirely (kept the unused
      `keg.svg` file in place rather than deleting it, in case it's
      wanted again).
    - Address now matches Name's font/weight/color (both 13px/600/dark)
      instead of Address's previous smaller, lighter-gray treatment;
      Beer/Batch/ABV values were bumped from weight 500 to 600 for the
      same reason - all four (Name, Address, Beer, Batch, ABV) now
      share one consistent text style.
    - **Phone number no longer shown as visible text** - only the
      tappable call icon remains on screen; the actual digits stay in
      the DOM as a screen-reader-only element (a standard
      visually-hidden pattern: present for accessibility, invisible to
      sighted users) rather than removed outright.
    - Destination card columns changed from the previous 1:1 (centered
      divider) to **2:1** - Name+Address get double the width of the
      now icon-only phone column. Rendered and verified this layout
      before finalizing.
    - Now/Next role icons grew from 48px to 54px, with the role-name
      text sized up correspondingly (15px -> 17px, roughly
      proportional to the icon increase). Beer/Batch/ABV icons grew
      from 44px to 48px.
52. ~~**Uploaded icon set's stroke thickened to match the
    Destination/phone icons, instead of thinning those further.**~~
    Done - the opposite direction from the previous round's fix:
    thinning the Destination/phone icons further (toward the
    mathematically "exact" match) had already been tried and rejected
    for looking too faint, so this time the other 12 icons were
    thickened to meet them instead. Computed a target
    (`stroke-width: 6`, up from `3`, in each icon's `0 0 350 350`
    viewBox) based on matching the Destination icons' actual effective
    pixel thickness at their real display sizes, then verified it
    directly: tested 4 candidate values (5/6/7/8) side by side, and
    specifically checked the most detail-dense icon (Batch, with thin
    clipboard lines) to confirm the fine details stayed legible at the
    heavier weight before committing. Applied to all 12 files in
    `public/icons/` via `sed`, then verified every file was still valid
    XML afterward (a `sed`-based bulk edit on SVG files is exactly the
    kind of change that can silently corrupt markup if not checked).
53. ~~**Keg ID font matched to Customer label, Destination card 3:1
    with no divider, larger role icons with thicker strokes across the
    board.**~~ Done:
    - Keg ID was actually matching the wrong reference (Now/Next's
      value style - 17px/blue/500) - corrected to genuinely match the
      Destination card's "Customer" label (12px/gray/regular).
    - Destination card ratio changed from 2:1 to 3:1, and the vertical
      divider line removed entirely (both CSS rule and HTML element).
      Rendered and verified the final layout before finalizing.
    - Now/Next role icons grew from 54px to 56px.
    - **Stroke width increased 20% across all 12 icon files** (`6` ->
      `7.2`) - both the role icons and Beer/Batch/ABV, per explicit
      request for each. Verified the actual computed value (7.2) at
      real display size before applying it everywhere, including on
      the most detail-dense icon (Batch) to confirm its thin clipboard
      lines stayed legible at the heavier weight. Re-verified all 12
      files were still valid XML after the bulk edit, same as the
      previous stroke-width change.
54. ~~**Another 20% stroke increase, Address size/Name bold,
    Destination card 4:1 with top-aligned icons, Now->Next arrow,
    Fill Details dividers, bold Keg ID.**~~ Done:
    - Stroke width increased another 20% on all 12 icon files (`7.2`
      -> `8.64`) and the Destination card's two inline icons (`1.1`
      -> `1.32`) - checked the most detail-dense icon (Batch) still
      read clearly before applying everywhere, and re-verified all 12
      files stayed valid XML after the bulk edit.
    - Address font-size reduced 10% (13px -> 11.7px); Name given real
      bold weight (700, up from 600).
    - Destination card ratio changed from 3:1 to 4:1.
    - Destination/Call icons now align to the **top** of their text
      block instead of vertically centering against it - rendered and
      verified this specifically against a wrapping 2-line address
      (the case most likely to look awkward) before finalizing.
    - Re-added a directional arrow between the Now and Next columns
      (removed a few rounds back when the layout changed to columns) -
      replaces the plain divider line that was there.
    - Fill Details card: horizontal divider added between the Keg ID
      and the Beer/Batch/ABV row below it; vertical dividers added
      between Beer, Batch, and ABV themselves. Rendered the whole card
      together to confirm both new dividers read cleanly as one
      cohesive layout, not competing lines.
    - Keg ID given bold weight (700), keeping its existing size/color
      (still matching the Customer label otherwise).
55. ~~**Admin/Manager now see Fill Details too, Kegs table's Keg ID is
    directly clickable.**~~ Done:
    - Fill Details (Beer/Batch/ABV/Keg ID) now shows for Admin/Manager
      in addition to the full History, instead of History replacing it
      entirely - previously these were mutually exclusive. Applies to
      both the normal and offline-fallback rendering paths. Tested the
      visibility logic directly across all three role cases (admin,
      manager, an operational role) to confirm the right combination
      shows for each.
    - Kegs table: the Keg ID itself is now the link to open that keg -
      no separate "open" link needed anymore. "QR" remains as its own
      link, since that's a genuinely different action (viewing/
      downloading the QR code image, not opening the keg's page).
56. ~~**Icon background circle intensity increased 10%, excluding
    Destination/phone.**~~ Done - but with a real correction along the
    way. First tried the literal, mathematically exact interpretation
    (reduce each RGB channel's distance-from-white by 10%): rendered
    it side-by-side with the original and it was **imperceptible** -
    these source colors are already so close to white that a 10%
    RGB-distance shift barely moves them. Switched to reducing HSL
    lightness by 10% instead, which is a more standard notion of
    "intensity" in color terms and produced a genuinely visible,
    proportionate change when rendered and compared - used that instead
    (`#EAF4FE` -> `#BBDCFC` for the blue variants, `#ECF9EC` ->
    `#C7EDC7` for the green ones). Applied via `sed` to all 12 files in
    `public/icons/`, re-verified XML validity on all of them afterward,
    and confirmed via a final full contact-sheet render. Destination
    and phone icons are untouched, as requested - they get their
    background from the shared `--primary-tint-bg` CSS variable, not
    from these SVG files, so excluding them required no special
    handling beyond simply not touching that variable.
57. ~~**Clicking Keg ID also opens the QR code in a new tab.**~~ Done -
    added to the existing behavior rather than replacing it, since
    "clicking Keg ID opens the keg" was an explicit earlier request:
    the link still navigates to the keg's page normally in the current
    tab, and an `onclick` handler now also pops the QR code image open
    in a new tab via `window.open()` at the same time. This is called
    synchronously inside a genuine click handler (not deferred through
    a timeout or async callback), which is what keeps browsers' popup
    blockers from treating it as an unwanted popup - a `window.open()`
    outside that direct synchronous user-gesture context would very
    likely get blocked.
58. ~~**Clicking Keg ID should ONLY open the QR code in a new tab -
    no same-tab navigation.**~~ Corrected the previous round: that
    version did both (opened the QR in a new tab AND navigated the
    current tab to the keg's page), which wasn't what was actually
    wanted. Now `href="#"` with `return false` in the click handler
    prevents any navigation at all - clicking the Keg ID does nothing
    but pop the QR code open in a new tab.
59. ~~**Root cause found for "my fix isn't showing up": stale service
    worker cache.**~~ Both the "Fill Details invisible to Admin/
    Manager" and "Keg ID click does two things" reports turned out to
    have zero bug in the actual source code - re-verified both
    directly and confirmed correct. The real cause: `sw.js`'s
    `CACHE_NAME` was still `v4`, unchanged since the in-app scanner was
    added many rounds ago. Every `scan.html`/`index.html` edit since
    then (Fill Details for Admin/Manager, the whole icon overhaul, the
    Destination card redesign, the Keg ID click fix, all of it) was
    genuinely correct and genuinely deployed - it just never reached
    the browser, because the service worker's **cache-first** strategy
    kept serving the old `v4`-cached copies regardless of what the
    server actually had. Fixed two ways: bumped to `v5` (forces a fresh
    fetch immediately), and - more importantly - **switched the
    strategy from cache-first to network-first** for the app shell.
    Cache-first is the right choice for a stable app that rarely
    changes; network-first is the right choice while still under this
    much active iteration, so a real fix reaches users the moment
    it's deployed, with the cached copy only used as a genuine offline
    fallback (which was always the actual point of caching this
    content in the first place) rather than a default that can mask
    real updates.
60. ~~**Kegs table's Keg ID had no way to reach a keg's page at all -
    turned out to be the real root cause behind the "Fill Details not
    showing" report.**~~ The previous round's "Keg ID only opens QR"
    change (an earlier explicit request) had an unintended side effect
    that only surfaced once actually tested: it removed the only way
    to navigate to a keg's page from that table at all, meaning there
    was no way to reach Fill Details from there to check it in the
    first place - not a Fill Details bug, a navigation dead-end.
    Restored Keg ID as a real link to the keg's page, now opening in a
    **new tab** (rather than the original same-tab behavior) per this
    round's clarification; "QR" remains its own fully independent link.
61. ~~**Overview's Alerts Keg ID matches the Kegs table's new-tab
    behavior; Fill Details now sits above History.**~~ Done:
    - Overview tab's Alerts list Keg ID link now opens in a new tab too,
      consistent with the Kegs table link fixed last round.
    - Fill Details card moved above the History card in the HTML order
      for Admin/Manager - purely a DOM reordering (`fillDetailsCard`
      now appears before `historyCard`), no JS changes needed since the
      visibility-toggling logic only sets `display` by element ID and
      doesn't depend on their position.
62. ~~**Filler form's auto-filled ABV field font matched to
    Destination card's Name style.**~~ Done - scoped specifically to
    `#f_abv` rather than changing the shared `input, select` base rule,
    since that rule is deliberately kept at 16px to avoid iOS Safari's
    auto-zoom-on-focus bug across every other form field. **Worth
    flagging**: this specific field now sits below that 16px floor
    (13px, matching Name), which technically reintroduces the zoom risk
    for this one field if someone taps into it - accepted as a
    reasonable tradeoff since it's normally just auto-filled and
    glanced at rather than retyped, but noted clearly in case that
    assumption doesn't hold in practice.
63. ~~**Beer/Batch/ABV values shown in Fill Details had drifted out of
    sync with Name's font weight - not the Filler form's ABV input.**~~
    Corrected a wrong guess from the previous round (that had targeted
    the Filler form's auto-filled ABV *input field*, and has been
    reverted): the actual complaint was about the *displayed* Beer/
    Batch/ABV values in the Fill Details card, visible to Mover and
    other roles after a keg's been filled. Root cause found: `.dest-
    name` was bolded to `font-weight: 700` in a later round, but
    `.detail-col-value` (Beer/Batch/ABV) was never updated to match,
    leaving it at the older `600`. Fixed, and while investigating,
    found `.dest-address` had the exact same drift (also still `600`)
    - fixed that too, since leaving it out would've just created a
    new mismatch between Address and the other two. All three (Name,
    Address, Beer/Batch/ABV) now genuinely share `font-weight: 700`.
64. ~~**New top banner on both pages, matching the provided reference
    image's style.**~~ Done - added above the existing compact logo
    header (not replacing it, per explicit confirmation), on both
    `scan.html` and `index.html`. A blue gradient background, a faint
    dashed route line with location pins, a faint city skyline and
    delivery truck silhouette, and the real Only K logo centered in a
    white glow circle, with a curved bottom edge - built as an inline
    SVG rather than image assets, so it scales cleanly at any width.
    **Deliberately kept compact (140px)** rather than a full hero
    section - this is a tool people use to move fast (scanning kegs),
    not a marketing page, so the goal was brand presence without
    pushing the actual work content further down a small phone screen.
    Designed and rendered the concept first, then re-rendered the exact
    SVG as it actually exists in each source file afterward to confirm
    nothing was lost in translation, and verified the embedded SVG is
    valid XML in both files (a real risk given its complexity - nested
    groups, gradients, a clip-path). `index.html`'s wider container
    uses `preserveAspectRatio="xMidYMid slice"` (uniform scaling,
    cropped as needed) rather than stretching to fit, to avoid
    distortion on its wider layout compared to `scan.html`'s fixed
    480px width.
65. ~~**Removed the now-redundant lower logo, moved User/Logout snug
    below the banner.**~~ Done:
    - The smaller logo images (login screen, app header, `index.html`'s
      title) removed - the new top banner already carries the logo, so
      these were duplicating it right below.
    - `scan.html`'s User/Logout chip row now sits directly under the
      banner's curve (gap reduced from 16px to 8px), instead of having
      its own logo above it first.
    - `index.html`'s title simplified to plain text now that it's not
      pairing an image with it; the now-unnecessary flex layout on its
      `h1` rule was removed too rather than left as dead styling.
      **Scoped narrower on this page** than on `scan.html`: its "Logged
      in as X · log out" line is plain text inside a different
      structure (not a chip-style row like `scan.html`'s), so it was
      left where it already sits reasonably close to the banner, rather
      than restructuring that page to force an identical layout.
    Rendered a mockup of the final banner-plus-header spacing before
    finalizing, and confirmed the old logo classes were fully removed
    as dead code, not just unreferenced.
66. ~~**Themed brewery/bar icons added to the banner's route line.**~~
    Done, on both `scan.html` and `index.html` - discussed the
    "unnecessary load" concern first (confirmed: zero cost, since the
    whole banner is already inline SVG, not separate image files - a
    few more path elements add a negligible number of bytes, no new
    requests) before implementing. Route now has 4 points: a
    microbrewery icon (two fermentation tanks on a base) at the start,
    two plain waypoint pins in the middle, and a bar glass icon at the
    end - deliberately kept the two middle points as simple pins rather
    than themed icons at all 4, since a compact 140px banner with that
    much detail would compete with the centered logo rather than
    support it. Went through 2 rounds on the brewery icon specifically
    - the first attempt read as an unclear crate/box shape at actual
    size, rendered a zoomed-in close-up to see why, and redesigned it
    with clearer twin-tank shapes that read correctly up close before
    committing either icon to the actual files.
67. ~~**Customer-possession gap: honest Now/Next display, real overdue
    alerts, days-since-delivered indicator.**~~ Built all three
    suggestions discussed:
    - Now/Next shows "Customer" (with a location-pin icon, matching
      the Destination card's icon shape) instead of attributing a keg
      at `delivered`/`empty_at_customer` to a staff role that doesn't
      actually have it - those two statuses genuinely mean the keg is
      with the customer, not with any staff member. Went through 2
      rounds on the icon specifically: the first version looked
      visibly thinner than a real role icon in the same row (it lacked
      the background circle every uploaded icon has baked in) -
      rendered a direct side-by-side comparison, added a matching
      circle background, and re-verified before committing.
    - **Added the two missing alert rules** (`delivered`,
      `empty_at_customer`) that genuinely didn't exist before - a keg
      with a customer had zero overdue signal at all. Defaults are a
      week for a normal in-use rental and a day for an already-empty
      keg awaiting pickup - starting guesses, worth tuning via the new
      `ALERT_CUSTOMER_HOURS`/`ALERT_PICKUP_HOURS` env vars to match
      actual typical rental duration. Tested both new rules directly
      against realistic overdue scenarios.
    - Added a "Delivered N days ago" line under the Now/Next card
      while a keg is with a customer, using the delivery event's own
      timestamp (already logged, no new data needed). Tested the
      calculation across 5 cases including same-day, singular "1 day",
      and the no-matching-event fallback.
    - While implementing, found and removed `STATUS_EXPECTED_ROLE` -
      a second, now-completely-unused mapping left over from an
      earlier round (only the Now/Next-based `STATUS_ROLE_FLOW` was
      actually still in use).
68. ~~**Replaced the top banner with the detailed illustrated version
    (mountains, brewery, bar, truck), numbered pins dropped.**~~ Done,
    on both `scan.html` and `index.html`. This went through a full
    evaluation before implementing:
    - The first version supplied (a 1600x520 wide-format illustration)
      was rendered and checked at the app's actual banner proportions
      - confirmed a real problem: "MICROBREWERY" text, the truck, and
      most of the "BAR" building were cropped off at both the mobile
      (480x140) and desktop (780x140) sizes, since the artwork was
      composed for a much wider aspect ratio than the app actually
      uses anywhere.
    - A second version, correctly authored at the real 480x140
      proportions, was rendered and confirmed nothing gets cropped -
      swapped its placeholder "K" letter for the real uploaded Only K
      logo and verified that specifically, then rendered a direct
      side-by-side comparison against the previous banner (at true
      pixel size, not scaled up) before asking which to keep.
    - Implemented with the 4 numbered location pins replaced by plain
      dots along the route, per explicit request - kept the dashed
      route line connecting brewery to bar, dropped the numbers, which
      didn't carry inherent meaning the way "brewery -> bar" already
      does on its own.
    - Adjusted the logo overlay's CSS position/size to match this
      design's actual logo-circle coordinates (`top: 34px`, `46px`
      instead of the previous `60px`/`52px`), re-verified the SVG
      stayed valid XML in both files afterward, and rendered the
      final implementation directly from each source file (not just
      the design draft) to confirm nothing was lost in translation.
69. ~~**Corrected a misread: pin shapes were meant to stay, only the
    numbers needed removing.**~~ The previous round replaced the 4
    pins with plain dots entirely, misreading "drop the numbered pins"
    as "remove the pins" rather than "remove the numbers from the
    pins." Fixed: restored the full pin marker (white teardrop shape +
    route-node circle) at all 4 original positions on both
    `scan.html` and `index.html`, with only the number `<text>`
    elements left out. Rendered the corrected result from the actual
    source file to confirm before considering it done.
70. ~~**Logo misaligned and a gap below the banner on real phone
    widths.**~~ Root cause found: the new banner used
    `preserveAspectRatio="xMidYMid meet"`, which shrinks the SVG to
    fit *within* its box rather than filling it - on any phone
    narrower than the design's native 480px (most real phones), this
    left a letterboxed gap top and bottom, and shifted the SVG's own
    content away from where the separately-positioned logo `<img>`
    overlay expected it (that overlay uses a fixed CSS pixel position,
    which doesn't move when the SVG shrinks). Switched back to
    `preserveAspectRatio="xMidYMid slice"` (crops to always fill the
    box exactly, no letterboxing) on both files - confirmed the fix by
    simulating a real 375px-wide phone screen both ways: `meet` showed
    a clearly visible white gap and a misaligned logo circle; `slice`
    filled the full height with the logo landing exactly in place.
71. ~~**Two real bugs found from actual device testing: double logo
    circle, brewery/bar cropped off on narrow phones.**~~ Both root-
    caused and fixed:
    - **Double circle**: `icon-192.png` has a solid white background
      baked in (no transparency - confirmed by sampling its pixels
      directly). The banner also drew its own blue-circle-with-white-
      stroke behind it, and since the logo image was smaller, the gap
      between the two showed as a visible ring. Removed the banner's
      own hard circle entirely, replaced with just the soft glow
      (matching how the very first compact banner handled this
      correctly) - rendered with an accurately circular-clipped test
      composite (matching what the real CSS `border-radius:50%`
      produces) to confirm no artifacts before implementing.
    - **Brewery/bar nearly invisible on real phones**: confirmed the
      cause mathematically first - `preserveAspectRatio="slice"` crops
      from the edges on any screen narrower than this design's native
      480px, and the brewery/bar sat close enough to x=0/x=480 that a
      realistic 375px-wide phone would crop away nearly all of both.
      Fixed by wrapping the foreground content (route, pins, brewery,
      truck, bar - explicitly excluding the backgrounds and the logo
      group, which needs to stay uncompressed and centered or it would
      distort into an ellipse) in a 25% horizontal compression around
      the banner's center, pulling both buildings safely inward.
      Verified by rendering the actual implemented file at both a
      realistic narrow width (375px) and the full native width
      (480px) - both buildings clearly visible at the narrow width,
      nothing looks broken at full width either.
    - Copied the fixed banner content verbatim from `scan.html` into
      `index.html` (rather than hand-editing both) specifically to
      guarantee they're byte-identical, and confirmed that directly.
72. ~~**Banner recolored to match the actual logo's color, not a
    generic blue.**~~ Sampled `icon-192.png`'s real pixel values
    directly (`#29AFFD`) rather than guessing, since the banner's
    existing palette (deep navy blues like `#0759D9`, `#063F8D`) never
    actually matched the logo it was built around. Built a full
    palette as HSL lightness variations of that single real hue
    (sky, ground, buildings, truck all now share the logo's exact
    hue at different lightness levels), rendered a direct before/after
    comparison, and got confirmation before applying it to both files.
    While implementing, found and removed `bannerLogoBg` - a gradient
    definition left over from before the double-circle fix a few
    rounds back, no longer referenced anywhere. Re-verified both
    files are syntactically valid, their banner SVGs are valid XML,
    and remain byte-identical to each other afterward.
73. ~~**Reduced the gap below the banner to 0.**~~ `scan.html`'s
    User/Log out row now sits directly against the banner's curve
    (was 8px); `index.html`'s gap below the banner reduced the same
    way (was 16px, hadn't been touched in earlier gap-tightening
    rounds since scan.html was the focus at the time).
74. ~~**Major keg lifecycle redesign: Mover as central hub, with a
    branching wash-to-storage-or-filler path.**~~ Done - the biggest
    state-machine change in the project's history, planned through
    several rounds of clarifying questions before any code was
    touched (given how foundational and hard-to-reverse this is), then
    built and tested end-to-end:
    - **2 new statuses**: `allotted_washer` (Mover has released a
      returned keg to Washer - Washer can't act until this happens)
      and `clean_storage` (Washer sent a freshly-washed keg back to
      Mover instead of straight to Filler, and it's sitting there
      until Mover releases it).
    - **2 new Mover actions**: "Allot to Washer" and "Allot to
      Filler" - Mover is now the explicit central hub for most
      handoffs, matching the real physical workflow described.
    - **Washer's wash action now branches**: a new "Send to" choice
      (Filler or Mover) on the same form, reusing the existing
      dynamic-`to`-function pattern already used for the pass/fail
      inspection routing - both are resolved together, with a failed
      inspection correctly overriding the routing choice regardless of
      which "send to" option was picked (tested directly).
    - **No per-person assignment system was needed** - since there's
      only one person per role today, role-based permission already
      means person-based permission; adding a "pick a specific person"
      layer would have been unnecessary complexity for no real benefit
      at the current team size.
    - Database: added a real migration (drop + re-add the status CHECK
      constraint) for existing installations, not just the fresh-install
      schema - this is a live production database, so a schema-only
      change without a migration would have broken on the next deploy.
    - Verified thoroughly before considering this done: built a full
      role x status matrix confirming exactly one role can act at
      every one of the 9 statuses with no dead ends and no overlaps;
      ran a complete end-to-end simulation of both branches (straight
      to Filler, and via Mover's clean storage) from empty_returned
      all the way back around to empty_returned; confirmed
      `lib/reports.js` needed no changes at all since it already
      imports the transition rules from `lib/stateMachine.js` rather
      than duplicating them; confirmed the cooldown and location-
      required-actions logic both gracefully ignore action types
      they don't know about, so neither needed updating for the 2 new
      actions; updated the alert rules for the 2 new statuses (with a
      new alert rule specifically added for `empty_returned` itself,
      now pointing at Mover rather than Washer, since Washer can no
      longer act on it directly); and added the new statuses to
      `index.html`'s status filter dropdown.
75. ~~**Device approval pause switch, for the current testing phase.**~~
    Done - a new `app_settings` key/value table (written generically,
    since a future similar on/off setting would fit the same shape)
    backs a toggle Admin can flip from the Devices tab, no redeploy
    needed. While paused, every device is let through for every
    operational role with nothing logged or registered at all;
    switching it back off returns to exactly the normal per-user
    approval behavior, unaffected by whatever devices were used while
    paused. Deliberately left out of `admin`/`manager`'s own gating
    the same way the underlying device system already does (those
    roles were never gated to begin with, so there's nothing to
    pause for them). Tested directly: blocked-by-default behavior
    confirmed unchanged, then confirmed the same blocked scenario
    passes through while paused, then confirmed unpausing restores
    the original blocking behavior exactly, and confirmed admin/
    manager logins are unaffected by the pause state either way.
76. ~~**Dashboard lists per role, Mover's receive-time branching
    choice, Now/Next clears after task completion, "Pending at
    Driver" relabeling.**~~ Done - worked through several clarifying
    questions first, since "receiving button" turned out to mean
    something different from its literal reading (see below):
    - **Home-screen dashboard lists**: Mover now sees 6 live lists
      (Uncleaned, Cleaned, Filled, Pending for Deliver, Pending at
      Customer, Pending at Driver) instead of just a greeting; Washer
      and Filler each see an "Allotted to you" list; Driver sees "To
      deliver" and "To mark empty". This turned out to be the actual
      fix for "Washer needs to receive kegs to be liable" - the real
      gap wasn't a missing confirmation step, it was that Washer had
      no way to know *which* keg was allotted to them until they
      happened to scan it. Reused the existing `/api/kegs?status=X`
      endpoint rather than building a new one.
    - **Mover's receive action now branches**: choosing "Uncleaned
      storage" (default) or "straight to Washer" (skip storage
      entirely) at the moment of receiving a returned keg, using the
      same dynamic-`to`-function pattern already established for
      Washer's wash-routing choice. Verified with a full end-to-end
      cycle test through the skip-storage path.
    - **Now/Next genuinely clears after a task completes** now,
      instead of persisting into the newly-updated status - shows the
      success message for 1.5s, then returns to the home screen and
      strips `?keg=...` from the URL so a refresh doesn't silently
      reload the same now-stale keg view.
    - **"Pending at driver" replaces "empty at customer"** everywhere
      a person actually sees it (success messages, history, the Kegs
      table, both report charts, the status filter dropdown) via a
      new `statusLabel()` helper, while the underlying database value
      stays `empty_at_customer` unchanged - same display-only-rename
      pattern already used for Warehouse->Mover.
    - **Found and fixed a related bug while implementing the
      relabeling**: the overdue alert for this status was still
      targeting Mover, even though Driver is now the one who
      physically carries the keg back - re-targeted to Driver.
77. ~~**Found and fixed the "receive keg not working" report, plus 5
    related items in the same batch.**~~ Investigated the bug report
    first by tracing the entire pipeline (form config -> validation ->
    submission -> backend route -> state machine -> database) end to
    end, found nothing broken in the actual transition logic - the
    real cause turned out to be a separate bug: `showHomeScreen()`
    never hid the Destination card, so stale customer details from the
    previous keg stayed on screen after returning home, making a
    successful action look like it hadn't done anything. Fixed
    alongside:
    - Now/Next shows "Driver" instead of "Customer" for
      `empty_at_customer` - marking a keg empty means Driver has
      already picked it up from the customer, not that it's still
      sitting there.
    - Damaged kegs: Mover now classifies a repaired keg as "filled" or
      "empty" at the time of damage, with a required reason field that
      **genuinely shows/hides** based on that choice (not just
      validated-but-always-visible, which is what the one existing
      example of this pattern - the wash form's damage notes - was
      actually doing) - built a real generic show/hide mechanism and
      applied it to both fields for consistency, tested the visibility
      computation and the toggle logic directly.
    - Mover's dashboard lists reorganized into two collapsible
      sections ("Warehouse": Uncleaned/Cleaned/Filled/Damaged, "In
      Transit": To be delivered/At customer/To be received) using
      native `<details>`/`<summary>` rather than custom JS toggle
      logic - added a "Damaged" list that wasn't in the original 6.
    - A confirmation prompt now summarizes what's about to be logged
      before it's actually submitted, to catch an accidental submit.
78. ~~**Mover can undo the single most recent Washer/Filler/Driver
    action, audit trail preserved.**~~ Scoped through 3 clarifying
    questions first (full undo vs. edit details; how far back; keep or
    remove the original record), then built:
    - New `POST /api/kegs/:id/revert` endpoint (Admin or Mover/
      Warehouse only) - rejects if the keg has no events, if the most
      recent event wasn't by Washer/Filler/Driver (this is scoped to
      correcting an operational mistake, not a general-purpose undo
      for anyone's action), or if the most recent event is already a
      revert (no double-undo).
    - The keg's prior status is derived by replaying every event
      **except** the most recent one - there's no stored "previous
      status" to just read back, so this has to be computed. Rather
      than duplicate that replay logic (which already existed once, in
      `lib/reports.js`, for turnover-time stats), moved
      `resolveNextStatus` into `lib/stateMachine.js` itself and had
      both places import the single shared copy.
    - The original event is never touched - a new `revert` event is
      added on top with what was undone and what the status was
      restored to, so the audit trail shows the full story: what
      happened, and that Mover corrected it, not just the end result.
    - A new "Correct a mistake" card appears on a keg's page, but only
      when there's actually something revertable and the viewer has
      permission - checked client-side too so the button doesn't even
      show for a case the backend would reject anyway.
    - Tested the status-replay logic across 3 scenarios (undoing a
      wash, undoing with only one prior event, undoing a fill deep in
      the cycle), tested the role/double-revert rejection logic
      directly, and ran a full integration test through the actual
      `withTransaction` helper from `db.js` (not just the isolated
      logic) to confirm the whole request handler's behavior end to
      end, not merely its pieces in isolation.
79. ~~**Allotted/Received two-stage workflow for all four operational
    roles.**~~ The largest state-machine expansion in the project so
    far - scoped through several rounds of clarifying questions before
    any code was touched, given how much this changes:
    - **4 new statuses**: `received_washer`, `received_filler`,
      `received_driver`, `received_from_driver`. Every "X has been
      handed off to role R" status now splits into two stages -
      notified (allotted, not yet picked up) and received (R has
      scanned to confirm physical custody, ready to act whenever they
      choose). This is what actually enables scanning through a whole
      batch (e.g. ten kegs allotted for washing) to confirm custody of
      each first, then coming back to do the real work one at a time.
    - Mover's own case (receiving the empty keg Driver brings back) now
      splits the same way: confirming custody is a separate step from
      the "Uncleaned storage vs. straight to Washer" decision that
      follows it.
    - Kegs table's status filter, `lib/alerts.js` (each existing "hasn't
      done their job" alert split into a short-fuse "hasn't even
      received it" and the original-style "received but hasn't done
      the work"), the dashboard lists (each role now shows an
      "Allotted" list and a "Received" list separately), and Now/Next's
      role-flow mapping were all updated to match.
    - Verified thoroughly given the scale: rebuilt the full role x
      status matrix (now 13 statuses x 4 roles) confirming still
      exactly one actionable role per status, no dead ends, no
      overlaps; ran the complete cycle end to end through all 11 steps;
      confirmed the old direct actions are now correctly rejected
      (Washer can no longer wash straight from `allotted_washer` -
      must receive first); confirmed Driver can't report damage on a
      merely-dispatched (not yet received) keg, since they don't
      physically have it yet; re-tested the clean-storage branch and
      the skip-storage receive branch still work correctly alongside
      the new steps; tested all 3 updated/new alert rules directly;
      and confirmed the revert feature (built two rounds ago) works
      correctly against the expanded cycle with no changes needed,
      since it's built on generic event replay rather than anything
      specific to the old status list.
    - Also removed the Keg ID link from every dashboard list (Washer,
      Filler, Mover, Driver all share one rendering function, so this
      was a single fix applying everywhere at once) - the point of
      requiring a physical QR scan is defeated if a list makes it just
      as easy to tap through and act on a keg without ever touching it.
80. ~~**Rounded out the Allotted/Received pattern to Mover's own
    remaining handoffs, plus several related fixes.**~~
    - **Receive buttons now say "Confirm received"** (approved choice,
      confirmed before implementing) instead of the longer "Confirm
      you have this keg" text.
    - **Found the actual gap**: Mover had no explicit receive step for
      a completed fill from Filler, or for a clean keg sent by Washer
      to storage instead of straight to Filler - both went directly
      into an actionable status with no confirmation step, unlike
      every other handoff. Two new statuses fix this:
      `received_from_filler`, `received_from_washer`. Re-verified the
      Driver-to-Mover handoff specifically, since it was flagged as
      "missing" too - confirmed directly in the code that it was
      already correctly built in an earlier round, not actually
      missing.
    - `mark_empty` now displays as **"Received from Customer"**
      (matches its actual meaning - Driver has already picked the keg
      up by the time this is logged, not that it's still sitting at
      the customer's premises).
    - **New "Pending for receipt" badge** on the Now/Next card,
      shown only for a "notified, not yet received" status (as
      opposed to its "received" counterpart) - lets anyone checking on
      a keg that isn't their own (Mover checking whether Washer has
      actually picked something up, Admin/Manager's oversight view)
      tell the two stages apart at a glance, since the role shown is
      otherwise identical either way. Rendered and visually verified
      the badge design before implementing.
    - Database schema, `lib/alerts.js` (each of the two newly-split
      statuses gets a short-fuse "not received yet" alert, mirroring
      every other receive step), the dashboard lists, and the status
      filter dropdown were all extended to match.
    - Verified thoroughly given this touches the core cycle again:
      rebuilt the full role x status matrix (now 15 statuses x 4
      roles, still zero gaps or overlaps), ran the complete end-to-end
      cycle through both the direct-to-filler and clean-storage paths
      with all the new steps included, tested the 2 new alert rules
      directly, and confirmed the revert feature (built several rounds
      ago) still works correctly against this further-expanded cycle
      with no code changes needed at all, since it's built on generic
      event replay rather than anything specific to the status list.
81. ~~**Now/Next corrected to a genuine possession model, badge moved
    to the middle, operational roles redirected off the admin page.**~~
    - **Real logic correction**: "Now" previously showed the *notified*
      party even before they'd confirmed receiving anything - e.g.
      `allotted_washer` showed Washer, when Mover still actually has
      the keg until Washer scans to confirm. Rewrote the entire status
      -> role mapping around actual possession: "Now" shows whoever
      last *confirmed* holding it (via a receive_* action), with the
      previous holder still shown - correctly, not as a bug - until
      the handoff is confirmed. Verified this fully with a table across
      all 15 statuses plus 3 targeted checks on the specific corrections called out.
    - `delivered`'s "next" was `warehouse` - flagged as not physically
      possible, since Driver is who actually collects it from the
      customer, not Mover directly. Fixed to `driver`.
    - **"Pending for receipt" badge moved to the middle** of the
      Now/Next row, replacing the arrow when a handoff is awaiting
      confirmation, instead of sitting below the Now column. Rendered
      a proportional mockup at the card's actual width to confirm it
      fits properly without crowding either column before implementing.
    - Re-confirmed the Driver-to-Mover handoff was never actually
      missing (checked directly in code, same as last round).
    - **Operational roles (Washer/Filler/Driver/Warehouse) now
      redirect straight to scan.html on login**, instead of landing on
      index.html and seeing Overview/Alerts/Kegs/Customers tabs that
      were never gated to admin/manager in the first place, unlike
      Reports/Users/Devices which already were. Confirmed before
      making this change that scan.html already has equivalent "add
      new customer"/"add new product" capability inline on the
      relevant action forms, so nothing is actually lost - and left
      the backend permission checks in `routes/customers.js`/
      `routes/products.js` completely untouched, since those inline
      forms call the exact same endpoints.
82. ~~**Home screen icon sometimes launched the admin page instead of
    the scanner app.**~~ Root cause: `manifest.json` had no
    `start_url` at all, so the browser defaulted to whichever page was
    open when "Add to Home Screen" was tapped - if that happened to be
    `index.html`, the resulting icon opened the admin dashboard every
    time (no scan button, a table-based layout, nothing like the
    actual app UI), exactly matching what was reported. Fixed two
    ways: added an explicit `start_url: "/scan.html"` to the manifest
    (fixes Android/Chrome, which does respect the manifest), and
    removed `index.html`'s standalone-app capability tags entirely,
    since iOS Safari ignores the manifest's `start_url` completely and
    just uses whatever page had those tags - `index.html` can still be
    bookmarked, but now only ever opens as a normal browser tab
    (visible address bar), not a fullscreen "app", which also makes it
    immediately obvious if this class of mix-up ever happens again.
    **Anyone who already has the wrong icon on their home screen needs
    to delete it and re-add it from scan.html specifically** - this
    fix prevents new mistakes, it doesn't retroactively fix an
    already-existing shortcut.
83. ~~**"Pending for receipt" badge no longer shifts the row's layout,
    and Mover can edit a dispatched keg's destination.**~~
    - The badge previously replaced the arrow in the middle column,
      which changed the row's width depending on state. Moved to its
      own line below the whole row instead - same position/pattern as
      "Delivered today" already used, with its own warning-style color
      and bold weight to stand apart from that neutral line. Rendered
      both states side by side to confirm the row itself stays pixel-
      identical regardless of whether the badge is showing.
    - **New**: Mover can now correct a wrong customer on an already-
      dispatched keg via a new "Edit destination" action, without a
      full revert or touching the keg's status. This needed a real
      exception in `renderForm()`'s "not your turn, show nothing"
      logic - Mover isn't normally offered anything at `dispatched`/
      `received_driver` (that's Driver's turn), so without special-
      casing it, the early-return would have hidden the form entirely
      before any edit button had a chance to render, unlike Driver's
      report-damage button, which only works because Driver always has
      a primary form to append to at those same statuses. `to: null`
      in the new `edit_destination` transition rule reuses
      validateTransition's existing "no status change" support, rather
      than needing anything new there. Verified with a full integration
      test through the actual field-resolution logic in
      `routes/events.js` - destination genuinely changes, status stays
      exactly as it was.
84. ~~**Found the real Driver-to-Mover gap: it was never a bug, it was
    a genuinely missing step.**~~ After the code review found nothing
    broken (again), asked for the exact symptom rather than guessing a
    third time - the actual answer: every other handoff in the cycle
    has both a sender-side scan and a receiver-side scan, but Driver-
    to-Mover only ever had Mover's side. Driver marking a keg empty
    (received from the customer) went straight to Mover being able to
    confirm receipt, with no record of Driver actually bringing it to
    the warehouse in between. New status `returned_to_warehouse` and a
    new Driver action `return_to_warehouse` fix this - Driver now scans
    once to mark it empty, and scans again on arrival at the warehouse,
    matching the two-scan pattern every other handoff already follows.
    Database schema, `lib/alerts.js` (empty_at_customer's label
    narrowed to specifically "not yet returned"; new short-fuse
    "not received yet" alert for the new status), `getActionConfig()`
    for both Driver and Warehouse, `STATUS_ROLE_FLOW`, the dashboard
    lists, and the status filter dropdown were all updated. Rebuilt
    the full role x status matrix (now 16 statuses, still zero gaps or
    overlaps), ran the complete 13-action cycle end to end, and
    confirmed the revert feature needs no changes at all to work
    correctly with the new step, same as every previous expansion.
85. ~~**Manager elevated to full operational capability - everything
    Mover can do, plus everything every other role can do too - while
    Admin stays a pure observer.**~~ This directly solves the original
    "how do I test the whole app without switching logins" need,
    without touching Admin at all:
    - `validateTransition`'s role check now has exactly one bypass:
      Manager can perform any action regardless of which role the
      transition rule specifies. Admin gets no bypass - still
      completely unable to perform any operational action, matching
      "pure observer" exactly.
    - Frontend `getActionConfig()` was restructured around a single
      `STATUS_ACTION_MAP` (status -> the one role whose turn it is)
      instead of one role-scoped branch per role - this is what let
      Manager's bypass be a single, obviously-correct check rather
      than duplicating the same status list four times over.
    - Extended the same elevation to the two secondary, non-primary-
      form actions that exist outside `getActionConfig()`: Mover's
      "Edit destination" and Driver's "Report damage" both now also
      show for Manager. This needed a real restructure of
      `renderForm()` - edit_destination used to live entirely inside
      the "cfg is null" branch, but Manager's bypass now means cfg is
      often non-null even when it's not genuinely Mover's turn (Manager
      sees Driver's own form instead), so the old structure would have
      silently stopped showing the edit option for Manager specifically.
      Found and fixed a real, pre-existing bug while doing this: the
      report-damage button's status check (`dispatched`/`delivered`)
      never actually matched the backend's own rule
      (`received_driver`/`delivered`) - meaning it could show at a
      status where submitting would have been rejected, and stayed
      hidden at a status where it should have worked.
    - The revert feature (built several rounds ago) gets the same
      elevation: Manager can now revert Mover's own actions too, not
      just Washer/Filler/Driver's - Admin's and plain Mover's revert
      scope is untouched, unchanged from before.
    - Verified thoroughly: simulated the full status x role matrix
      confirming Manager can act at literally every one of the 16
      statuses and Admin can act at none, tested the revert permission
      logic across both elevated and unelevated cases, and ran a
      complete 13-step cycle with Manager performing every single step
      solo, without switching accounts once.
86. ~~**Admin's home screen icon stopped reaching the admin
    dashboard.**~~ A real side effect of the earlier PWA fix: pinning
    `start_url` to `/scan.html` correctly solved operational roles
    launching the wrong page, but it meant Admin now *always* lands on
    `scan.html` first too - a page with no oversight functionality for
    them at all (no dashboard lists, no action forms, since Admin is a
    pure observer). Fixed with the mirror-image of the redirect
    `index.html` already does for operational roles: Admin landing on
    `scan.html` with no specific keg requested now redirects straight
    to `index.html`. Scoped narrowly - skipped when a keg *is* already
    in the URL (a direct scan or a Keg ID link clicked from Admin's own
    Kegs table), since redirecting away from a keg Admin deliberately
    opened would undo the exact oversight capability that page exists
    to provide.
87. ~~**Alerts redesigned for Mover, categorized by pipeline stage.**~~
    Suggested the design first (3 stage-based groups rather than
    role-based, since Mover cares about *where* the pipeline is
    backing up, not just which role's turn it is) and got confirmation
    before building. No backend changes needed - `/api/alerts` already
    returned the full company-wide list, just filtered client-side for
    everyone else's small badge. Mover's home screen now shows a real
    "Alerts" section above the existing dashboard lists, using the same
    collapsible `<details>` groups already established: **At Washer/
    Filler**, **At Warehouse**, **In Transit** - each with a count badge
    and, expanded, the actual overdue keg IDs with their specific
    label (plain text, not clickable - matches the dashboard lists'
    reasoning: a one-tap shortcut to the action form would undercut
    the physical-scan requirement). Verified the 3 groups cover all 16
    statuses exactly once (no gaps, no double-counting) and tested the
    grouping logic directly against sample alert data before
    considering it done. Rendered a mockup first to confirm the
    warning-tinted alert items read as visually distinct from the
    dashboard lists' normal (non-overdue) items.
88. ~~**Full setup review.**~~ A systematic audit of the whole app given
    how much has changed - not just re-running syntax checks, but
    actually cross-referencing consistency across files:
    - Extracted the canonical 16-status list directly from
      `lib/stateMachine.js`'s `TRANSITIONS` (the real source of truth)
      and diffed it against every other place a status list is
      duplicated: `db.js`'s CHECK constraint, `lib/alerts.js`'s
      `ALERT_RULES`, `scan.html`'s `STATUS_ACTION_MAP` and
      `STATUS_ROLE_FLOW`, `scan.html`'s `ALERT_STAGE_GROUPS`, and
      `index.html`'s status filter dropdown. **Zero missing statuses,
      zero stale/extra ones, anywhere** - a genuinely clean result
      given how many rounds have touched this list.
    - Cross-checked every `ROLE_ACTIONS` sub-config against
      `STATUS_ACTION_MAP`'s references to it: all 16 defined, all 16
      referenced, no dead entries, no dangling references.
    - Re-ran the full cycle test (direct path, clean-storage branch,
      failed-inspection branch, skip-storage receive branch), a check
      that Manager can perform every single action type, and a revert-
      compatibility check - all in one pass, all still passing.
    - Verified `lib/cooldown.js`'s `COOLDOWNS` and
      `routes/events.js`'s `LOCATION_REQUIRED_ACTIONS` still reference
      valid, current action names, and both login redirects (Admin ->
      index.html, operational roles -> scan.html) are still correctly
      in place.
    - **Found one genuine bug this way**: `loadKeg()` clears
      `dashboardLists` when navigating from the home screen to a
      specific keg, but never cleared the newer `moverAlertsOverview`
      section the same way - meaning Mover's Alerts overview could
      linger on screen below a keg's own card, the identical class of
      bug the Destination card had several rounds back. Fixed by
      adding it to the same clearing block, which (since that block
      runs unconditionally at the very top of `loadKeg()`, before the
      online/offline branch splits) automatically covers the offline
      fallback path too, with no separate fix needed there.
89. ~~**Edit-destination window narrowed, "In Storage" display added,
    Mover's home screen split into Alerts/Inventory tabs.**~~ Suggested
    the last two as options first, confirmed before building:
    - **Real fix**: `edit_destination` could previously be used at
      `dispatched` (before Driver even confirms receipt), not just
      `received_driver` as intended. Narrowed to `received_driver`
      only, in both the backend transition rule and the frontend
      condition gating the button - tested both accept/reject cases
      directly.
    - **"In Storage" display**: the 4 statuses that mean "confirmed
      with Mover, not yet allotted anywhere" (`empty_returned`,
      `received_from_washer`, `received_from_filler`,
      `received_from_driver`) previously showed "Now: Mover, Next:
      [whoever's eventually involved]", implying an active handoff in
      progress when really nothing has moved yet. Now shows "Now: In
      Storage, Next: Mover" - a new display-only pseudo-value (same
      pattern as the existing 'customer' pseudo-role), with its own
      box/package icon, rendered and visually confirmed before wiring
      it in. Purely cosmetic - the underlying `STATUS_ACTION_MAP` that
      actually governs who can act is completely unaffected.
    - **Mover's home screen split into two tabs**: "Alerts" and
      "Inventory", reusing `index.html`'s existing tab visual pattern
      (replicated into `scan.html`'s own stylesheet, since they're
      separate files) rather than inventing a new one. Both sections
      still load/populate on arrival regardless of which tab is
      active, so switching is instant. Scoped to Mover only - other
      roles' simpler single-list views and Admin/Manager (who use
      index.html for this) are unaffected.
    - **Still open**: nested per-category collapsing (Uncleaned,
      Cleaned, Filled, Damaged each individually expandable inside the
      Warehouse/In Transit groups, rather than all showing at once) -
      confirmed the intended interaction with a direct question, not
      yet implemented.
90. ~~**Nested accordion for Mover's sub-categories.**~~ Confirmed the
    exact interaction before building it. Each sub-category
    (Uncleaned, Cleaned, Filled, Damaged, and the same for In Transit)
    is now its own individually-collapsible `<details>`, nested inside
    the Warehouse/In Transit outer groups, instead of all showing at
    once as soon as the outer group opens. Kept as a new function
    (`fetchNestedKegListHtml`) separate from the existing
    `fetchKegListHtml` rather than adding a flag to it, since Washer/
    Filler/Driver's simpler single-list views call the original
    directly and were never meant to change - they have no outer group
    to nest inside in the first place. **Found and fixed a real CSS
    bug while building this**: the arrow-rotation rule
    (`.dash-group[open] .dash-group-summary::before`) used a plain
    descendant selector, which - once nesting existed - would have
    incorrectly rotated a nested sub-group's arrow to look "open"
    merely because its *outer* parent was open, even while the
    sub-group itself was still genuinely collapsed. Fixed by scoping
    it to a direct-child combinator instead, verified against the
    actual DOM structure (summary is always a direct child of its own
    `<details>`; nested `<details>` sit inside a wrapping div, never as
    a direct child of an ancestor), and re-confirmed the total-count
    aggregation logic still sums correctly against the new nested HTML
    shape.
91. ~~**Overdue time added to Mover's alerts, Admin/Manager's alerts
    redesigned to match the same stage-based grouping.**~~
    - Mover's alert items now show a formatted overdue duration
      (`formatOverdueDuration()`) alongside the label - plain hours
      below a day, days-plus-leftover-hours once it's been overdue
      that long, since "127h overdue" is harder to read at a glance
      than "5d 7h overdue".
    - Admin/Manager's alerts on `index.html` were still the original
      flat, sorted list - redesigned to the same 3-stage grouping
      (At Washer/Filler, At Warehouse, In Transit) as Mover's view,
      using new collapsible `<details>` groups added to `index.html`'s
      own stylesheet (that file had no collapsible pattern yet).
      Preserved everything the original list already did well -
      clickable Keg IDs opening in a new tab, the manufacturing number,
      worst-overdue-first sorting (now scoped within each group rather
      than across the whole list), and no display cap.
    - `ALERT_STAGE_GROUPS` is necessarily duplicated between
      `scan.html` and `index.html` (two standalone files, no shared
      module system) - confirmed both copies are byte-identical rather
      than assuming it from having written them the same way.
    - Applied the direct-child arrow-rotation selector
      (`.alert-group[open] > .alert-group-summary::before`) correctly
      from the start this time, rather than repeating the descendant-
      selector bug found and fixed in `scan.html`'s equivalent CSS a
      couple rounds back.
92. **Custom domain + always-on hosting**, once the free tier's sleep
    behavior becomes a real annoyance rather than a demo-time curiosity.

## Design system

The current light theme follows a specific provided spec - keep new UI
work consistent with it rather than reintroducing arbitrary colors/sizes.

**Colors** (as CSS custom properties in both `scan.html` and `index.html`):

| Variable | Value | Use |
|---|---|---|
| `--primary` | `#2FA8F5` | Logo, active tab, primary buttons/links |
| `--primary-tint-bg` | `#E6F1FB` | Banner/card backgrounds, status pills |
| `--primary-tint-text-dark` | `#0C447C` | Banner headline text |
| `--primary-tint-text-mid` | `#185FA5` | Banner subtext |
| `--bg` | `#FFFFFF` | Page background |
| `--card-bg` | `#F5F5F5` | Cards, inactive chips |
| `--text` | `#1A1A1A` | Headings, primary text |
| `--text-secondary` | `#6B6B6B` | Timestamps, subtitles |
| `--text-muted` | `#A0A0A0` | Placeholders, inactive icons |

Success/error colors (`--success-bg/text`, `--error-bg/text`) aren't
part of the original spec - chosen to harmonize with it (light tinted
backgrounds, readable dark text, same visual language as the primary
banner).

**Typography:** single system sans-serif font. Exactly two weights -
**400 (regular) and 500 (medium) only**, never 600/700/800. Sentence
case everywhere, no uppercase labels. Size scale: 20px/500 (greeting-
level headings), 16px/500 (section titles), 14px/500 (list-item
titles), 13px/400 (secondary/meta text), 12px/400 (nav labels,
timestamps). **One deliberate exception**: form inputs stay at 16px
regardless of what the scale would otherwise call for - anything
smaller triggers iOS Safari's auto-zoom-on-focus, which is worse for
usability than a one-off deviation from the scale.

## User accounts

Real accounts now exist alongside (or instead of) the demo ones seeded
for testing. What Admin can do, from the "Users" section on the admin
page:

- **Create a new user** — name, role, and their own password (minimum 6
  characters)
- **Reset anyone's password** — for when someone forgets theirs; the new
  password is shown once in a confirmation dialog and nowhere else, so
  it needs to be told to them directly
- **Deactivate an account** instead of deleting it — blocks that
  person's login immediately, but preserves every event they ever
  logged, since `events.user_id` references `users.id` and hard-deleting
  a user with history would either fail (the foreign key) or, worse,
  silently corrupt the audit trail's attribution. Deactivated accounts
  also stop appearing in the login dropdown
- **Reactivate** an account at any time, restoring login access with the
  same password they had (a reset can also be done at the same time if
  needed)

Self-service "change my password" (any logged-in user changing their own
password) was removed on request - password changes now go through
Admin's "Reset password" only. If that's ever wanted back, the removed
code followed the exact same shape as the reset-password flow, just
scoped to the current user and requiring their current password first.

**Recommended transition from the demo setup:** the seeded demo accounts
(password `demo1234` for all) still work exactly as before - nothing
breaks. Before real staff start using this, either create fresh
individual accounts per person and deactivate the demo ones, or just
reset each demo account's password to something unique per real person
who'll be using that role.

**Safety note:** deactivating the last active Admin account is blocked
outright, the same way device registration exempts Admin/Manager from
needing approval - both exist to prevent a genuinely unrecoverable
lockout with nobody left who could undo it.

## Fixed in a review pass (worth knowing what these were)

A full code review turned up a few real bugs, now fixed:

- **Crash bug:** `/api/auth/login` would crash the entire server on a
  malformed request (e.g. an empty POST body) — reachable by anyone,
  without logging in, including automated bots that scan public URLs.
  Fixed with input validation and a try/catch (`routes/auth.js`). Also
  added a process-level safety net (`process.on('unhandledRejection', ...)`
  in `server.js`) so the same class of bug elsewhere can't take the whole
  app down again.
- **Dead-end bug:** a queued offline action that got rejected on sync
  (e.g. superseded by someone else's update) had no way to be removed —
  it would block that keg on that device indefinitely. Fixed with a
  "Discard this action" button (`discardQueuedItem()` in
  `public/scan.html`, using the already-existing but previously
  unwired `removeById()` in `offline-queue.js`).
- **Silent-failure bug:** Warehouse could submit "Assign delivery
  destination" with the field left blank — it would report success but
  leave the keg's destination actually unset, creating a misleading
  audit trail. Fixed with validation on both the frontend
  (`checkRequiredFields()`) and, more importantly, the backend
  (`routes/events.js`), since client-side validation alone isn't a real
  guarantee.

## Data model recap

| Entity | Key fields |
|---|---|
| Keg | id, manufacturing_number, size_liters, material, status, current_location, destination, destination_address, destination_phone, customer_id |
| User | id, name, role, password_hash, active |
| Event | keg_id, user_id, role, action_type, details (JSON text), created_at |
| Customer | id, name, address, phone |
| Product | id, name, default_abv |

Status flow (Mover is the central hub for most handoffs; every
handoff to Washer, Filler, Driver, or Mover-from-Driver is now a
two-stage "notified, then received" pair - see the detailed writeup
in the gap list above for the full reasoning):

`empty_returned → allotted_washer → received_washer → washed → filled
→ dispatched → received_driver → delivered → empty_at_customer →
received_from_driver → empty_returned` (cycle repeats), with two
branches:

- After washing: Washer can send a freshly-washed keg either straight
  to Filler (`washed`, where it's still a notified/received pair -
  `received_filler` - before Filler actually fills it) or back to
  Mover to hold as clean stock (`clean_storage`, released to `washed`
  later via Mover's own `allot_filler` action, on their own schedule).
- At the moment Mover actually confirms receiving a returned keg back
  from Driver (`received_from_driver`): straight back into
  `empty_returned` (the default), or directly into `allotted_washer`,
  skipping the storage stop entirely.

Each status is owned by exactly one role - see `lib/stateMachine.js`
for the authoritative table (13 statuses x role, no gaps or overlaps
between them). The `filled → dispatched` transition happens in a
single step: Warehouse runs `assign_destination`, which both sets the
keg's destination and moves its status to `dispatched` at the same
time - there's no separate driver-initiated dispatch action. Driver's
first involvement from there is `receive_driver` (confirming they're
actually holding the keg), then `deliver` (confirming delivery
location + customer signature) whenever they're actually there.

There's a third branch off this main cycle: a **failed wash
inspection** sends the keg to `needs_repair` instead of `washed`/
`clean_storage` (also owned by Warehouse), which blocks it from being
filled until `mark_repaired` sends it back to `empty_returned` for a
full wash + inspection cycle again (via a fresh `allot_washer` from
Mover, same as any other returned keg) - this override applies
regardless of which "send to" choice Washer made, since a failed
inspection means the keg isn't going anywhere in the normal cycle
either way. A driver can also flag a keg as damaged via
`report_damage`, but only once they've actually received it
(`received_driver` or `delivered` - not the earlier `dispatched`,
since there's nothing physical to report as damaged before that). See
`lib/stateMachine.js` for the exact role/transition rules.

A **third branch** sits at `receive_empty` itself: Mover chooses, at
the moment of receiving a returned keg, between routing it to
`empty_returned` (Uncleaned storage, the default) or straight to
`allotted_washer` (skipping storage entirely). Same dynamic-`to`-
function pattern as the other two branches above.
