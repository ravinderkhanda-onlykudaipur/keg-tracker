# Keg Tracker (MVP)

A working implementation of the QR-code keg tracking system: scan a keg's
QR code, log a role-specific event (Filler, Washer, Driver, Warehouse),
and see the keg's full history. Admin and Manager roles oversee the
whole operation from the admin page. Built to match the requirements doc
discussed earlier. Deployed live at Render.

## What's here

- `server.js` — Express app entry point; auto-seeds demo data on boot
- `db.js` — SQLite setup and schema (Keg, User, Event/Log tables), using
  Node's built-in `node:sqlite` module (no native compilation needed)
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
- `public/index.html` — admin page: log in, create kegs (Admin only),
  view QR codes, browse all kegs, see the full alerts and reports
  dashboards (Admin/Manager)
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

## Run it locally

You'll need [Node.js](https://nodejs.org) 22.5+ (for `node:sqlite`).

```bash
npm install
npm start          # auto-seeds demo users + DEMO-KEG-1 on first run
```

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

Shown as simple horizontal bar charts on the admin page, built with
plain CSS (no charting library dependency).

**Trying GPS location:** on the driver's pickup field, and the
warehouse's zone/storage fields, tap "Use my location" to auto-fill real
GPS coordinates (requires HTTPS and location permission — works on the
Render deployment, not on plain `http://localhost`).

## Deploying (currently: Render, free tier)

1. Push this repo to GitHub.
2. Create a Render Web Service connected to the `main` branch.
   Build command: `npm install`. Start command: `npm start`.
3. Set one environment variable in Render's dashboard:
   - `SESSION_SECRET` → a fixed random value
     (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
     — without this, everyone gets logged out on every redeploy.
4. Push to `main` → Render auto-deploys.

**Known limitation:** Render's free tier has no persistent disk, so the
SQLite file resets on every redeploy — kegs/events/history created since
the last deploy will be wiped, and demo data re-seeds fresh. Fine for a
demo; a real database (Postgres) would fix this, but that's a deliberate
choice to defer for now (see gap list below) rather than something
broken.

**About `SESSION_SECRET` and staying logged in — corrected note:** setting
this environment variable is still the right thing to do (it keeps the
cookie-signing secret stable and unguessable), but on its own it does
**not** stop people from being logged out on redeploy/restart/sleep-wake.
That's because session *data* (who's actually logged in) lives in
Express's default in-memory store, which is wiped by the exact same
ephemeral-disk-and-process reset that wipes the SQLite file — completely
independent of whether the secret is stable. A real fix needs an
external, persistent session store (e.g. a free-tier Redis service like
Upstash), which is infrastructure on the same order as the Postgres move
already deferred below. Until then: expect to need to log back in after
Render's 15-minute idle sleep, not just after a `git push`.

Also: the free web service sleeps after 15 minutes of no traffic (first
visit after that takes ~1 minute to wake up).

## Known gaps (by design — this is the MVP, not the finished system)

Roughly in priority order:

1. ~~**Real authentication.**~~ Done: bcrypt-hashed passwords + server-side
   sessions. Still worth doing before wider rollout: individual passwords
   per real user (currently everyone shares the demo password —
   deliberately not yet changed since the app is still in testing), a
   password reset flow, and account lockout after failed attempts.
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
13. **Move off SQLite to a real hosted database** (e.g. Postgres via
    Neon's free tier), so data survives redeploys. Deliberately not done
    yet — see "Deploying" above for the current tradeoff.
14. **Persistent session storage** (e.g. a free Redis service), so logins
    survive Render's redeploys/restarts/sleep-wake cycles. Deliberately
    not done yet — see the corrected note under "Deploying" above; this
    needs external storage, not just the local-disk fixes used elsewhere,
    since Render's free tier wipes local disk on every restart too.
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
18. **Custom domain + always-on hosting**, once the free tier's sleep
    behavior becomes a real annoyance rather than a demo-time curiosity.

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
| Keg | id, size_liters, material, status, current_location, destination |
| User | id, name, role, password_hash |
| Event | keg_id, user_id, role, action_type, details (JSON text), created_at |

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
