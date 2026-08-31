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
  before it's ever filled, or before Warehouse has assigned a destination)
- `lib/sessionSecret.js` — persists the session-signing secret across
  local restarts; on Render, `SESSION_SECRET` is set as an environment
  variable instead (see "Deploying"), since Render's free tier has no
  persistent disk for this file to survive redeploys on
- `routes/auth.js` — bcrypt-hashed passwords + server-side sessions
- `routes/kegs.js` — create kegs, generate QR codes, search/list
- `routes/events.js` — the scan-to-action endpoint every form submits to;
  also where the "no dispatch without an assigned destination" rule lives
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
fill it. Then log in as "Wally Warehouse" and assign a delivery
destination — only after that can "Dana Driver" dispatch it. Try
dispatching before a destination is assigned, or filling before washing —
the state machine rejects both with a clear 409 error.

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
   `routes/events.js`. A keg can't be dispatched until Warehouse has set
   its destination.
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
7. **Move off SQLite to a real hosted database** (e.g. Postgres via
   Neon's free tier), so data survives redeploys. Deliberately not done
   yet — see "Deploying" above for the current tradeoff.
8. **Alerts.** Nothing yet flags overdue returns or kegs stuck in one
   state too long — that needs a scheduled job querying `events`/`kegs`.
9. **Reporting dashboards.** The data model supports turnover-time and
   utilization queries; there's no chart UI yet.
10. **Custom domain + always-on hosting**, once the free tier's sleep
    behavior becomes a real annoyance rather than a demo-time curiosity.

## Data model recap

| Entity | Key fields |
|---|---|
| Keg | id, size_liters, material, status, current_location, destination |
| User | id, name, role, password_hash |
| Event | keg_id, user_id, role, action_type, details (JSON text), created_at |

Status flow: `empty_returned → washed → filled → dispatched → delivered →
empty_at_customer → empty_returned` (cycle repeats). Between `filled` and
`dispatched`, Warehouse must run `assign_destination` (no status change,
just sets the keg's destination) before a driver can dispatch it. See
`lib/stateMachine.js` for the exact role/transition rules.
