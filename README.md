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
59. **Custom domain + always-on hosting**, once the free tier's sleep
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

Status flow: `empty_returned → washed → filled → dispatched → delivered →
empty_at_customer → empty_returned` (cycle repeats), with each status
owned by exactly one role: Washer (`empty_returned`), Filler (`washed`),
Warehouse (`filled`), Driver (`dispatched` and `delivered`), Warehouse
again (`empty_at_customer`). The `filled → dispatched` transition happens
in a single step: Warehouse runs `assign_destination`, which both sets
the keg's destination and moves its status to `dispatched` at the same
time - there's no separate driver-initiated dispatch action. The driver's
first involvement is `deliver` (confirming delivery location + customer
signature) once the keg is already dispatched.

There's a branch off this main cycle: a **failed wash inspection** sends
the keg to `needs_repair` instead of `washed` (also owned by Warehouse),
which blocks it from being filled until `mark_repaired` sends it back to
`empty_returned` for a full wash + inspection cycle again. See
`lib/stateMachine.js` for the exact role/transition rules.
for the exact role/transition rules.
