# Keg Tracker (MVP)

A minimal, working implementation of the QR-code keg tracking system: scan a
keg's QR code, log a role-specific event (Filler, Washer, Driver,
Warehouse), and see the keg's full history. Built to match the requirements
doc discussed earlier.

## What's here

- `server.js` — Express app entry point
- `db.js` — SQLite schema (Keg, User, Event/Log tables)
- `lib/stateMachine.js` — the rules for which role can move a keg from
  which status to which status (this is what stops a keg being dispatched
  before it's ever filled)
- `routes/auth.js` — simple PIN login (**MVP only, not real auth**)
- `routes/kegs.js` — create kegs, generate QR codes, search/list
- `routes/events.js` — the scan-to-action endpoint every form submits to
- `public/index.html` — admin page: create kegs, view QR codes, browse status
- `public/scan.html` — the mobile page a worker sees after scanning a QR
  code; the form fields change based on their role and the keg's status

## Run it locally

You'll need [Node.js](https://nodejs.org) 22.5+ installed (this uses Node's
built-in `node:sqlite` module — no native compilation, no Xcode tools
needed for the database layer).

> **If you're upgrading from an earlier copy of this project:** the user
> table schema changed (plaintext `pin` → hashed `password_hash`). Delete
> your existing `db/` folder before reseeding, or the old table structure
> will conflict:
> ```bash
> rm -rf db
> ```

```bash
npm install
node seed.js      # creates 4 demo users (password "demo1234") + one demo keg
npm start
```

Then open **http://localhost:3000** — that's the admin page. Log in with
any of the seeded demo users (password `demo1234` for all) to create kegs.

To try the scan flow: open
**http://localhost:3000/scan.html?keg=DEMO-KEG-1**, log in as "Wes Washer"
(password `demo1234`), submit a wash. Then log in as "Fiona Filler" and
fill it. Watch the status and history update. Try logging in as the
Filler *before* washing it — the state machine will reject it with a 409
error, which is the "can't fill an unwashed keg" rule from the
requirements doc in action.

On an actual phone: visit `/api/kegs/DEMO-KEG-1/qrcode.png`, print or
display it, and scan it with any camera app — it opens the scan page
directly.

## Known gaps (by design — this is the MVP, not the finished system)

These are exactly the things to tackle next, roughly in priority order:

1. ~~**Real authentication.**~~ Done: bcrypt-hashed passwords + server-side
   sessions, with a persistent session secret (survives restarts — see
   `lib/sessionSecret.js`). Still worth doing before wider rollout:
   password reset flow and account lockout after failed attempts.
2. **Offline support.** Right now a scan needs connectivity. Add a
   service worker / local queue that syncs when the connection returns —
   important for drivers and warehouse staff.
3. **Photo uploads.** Washer damage notes and driver delivery proof would
   benefit from attaching a photo to the event.
4. **Alerts.** Nothing yet flags overdue returns or kegs stuck in one
   state too long — that needs a scheduled job querying `events`/`kegs`.
5. **Reporting dashboards.** The data model supports turnover-time and
   utilization queries; there's no chart UI yet.
6. **Swap SQLite for PostgreSQL** once you're past prototyping and need
   concurrent multi-user writes at scale — the queries in `db.js` and the
   routes translate almost directly (better-sqlite3 syntax is close to
   `pg`, but not identical).
7. **Deploy.** Locally this runs on your machine only. For real use,
   deploy to a small VM or PaaS (Render, Railway, Fly.io are simple
   options) and put it behind HTTPS.

## Data model recap

| Entity | Key fields |
|---|---|
| Keg | id, size_liters, material, status, current_location |
| User | id, name, role, pin |
| Event | keg_id, user_id, role, action_type, details (JSON), created_at |

Status flow: `empty_returned → washed → filled → dispatched → delivered →
empty_at_customer → empty_returned` (cycle repeats). See
`lib/stateMachine.js` for the exact role/transition rules.
