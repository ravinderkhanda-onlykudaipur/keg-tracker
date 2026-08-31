# Keg Tracker (MVP)

A working implementation of the QR-code keg tracking system: scan a keg's
QR code, log a role-specific event (Filler, Washer, Driver, Warehouse),
and see the keg's full history. Built to match the requirements doc
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
  delivering it) — see gap #10 below for why, and how to tune the
  duration via `ACTION_COOLDOWN_MS`
- `lib/sessionSecret.js` — persists the session-signing secret across
  local restarts; on Render, `SESSION_SECRET` is set as an environment
  variable instead (see "Deploying"), since Render's free tier has no
  persistent disk for this file to survive redeploys on
- `routes/auth.js` — bcrypt-hashed passwords + server-side sessions
- `routes/kegs.js` — create kegs, generate QR codes, search/list
- `routes/events.js` — the scan-to-action endpoint every form submits to;
  also where the "destination can't be left blank" and cooldown rules live
- `public/index.html` — admin page: log in, create kegs, view QR codes
- `public/scan.html` — the mobile page a worker sees after scanning a QR
  code; the form fields change based on their role and the keg's status
- `public/sw.js`, `public/offline-queue.js` — offline support: caches the
  scan page for zero-signal loading, queues actions locally when offline
  and syncs them once back online

## Run it locally

You'll need [Node.js](https://nodejs.org) 22.5+ (for `node:sqlite`).

```bash
npm install
npm start          # auto-seeds demo users + DEMO-KEG-1 on first run
```

Then open **http://localhost:3000** — that's the admin page. Log in with
any of the seeded demo users (password `demo1234` for all) to create kegs.

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
12. **Move off SQLite to a real hosted database** (e.g. Postgres via
    Neon's free tier), so data survives redeploys. Deliberately not done
    yet — see "Deploying" above for the current tradeoff.
13. **Persistent session storage** (e.g. a free Redis service), so logins
    survive Render's redeploys/restarts/sleep-wake cycles. Deliberately
    not done yet — see the corrected note under "Deploying" above; this
    needs external storage, not just the local-disk fixes used elsewhere,
    since Render's free tier wipes local disk on every restart too.
13. **Alerts.** Nothing yet flags overdue returns or kegs stuck in one
    state too long — that needs a scheduled job querying `events`/`kegs`.
14. **Reporting dashboards.** The data model supports turnover-time and
    utilization queries; there's no chart UI yet.
15. **Custom domain + always-on hosting**, once the free tier's sleep
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
signature) once the keg is already dispatched. See `lib/stateMachine.js`
for the exact role/transition rules.
