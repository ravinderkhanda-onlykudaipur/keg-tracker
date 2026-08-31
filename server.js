// server.js - entry point
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');

const db = require('./db');
const { getSessionSecret } = require('./lib/sessionSecret');
const { seedIfEmpty } = require('./seed');
const { attachUser } = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth');
const kegRoutes = require('./routes/kegs');
const eventRoutes = require('./routes/events');
const alertRoutes = require('./routes/alerts');
const reportRoutes = require('./routes/reports');
const customerRoutes = require('./routes/customers');
const deviceRoutes = require('./routes/devices');

const app = express();
app.use(express.json());

// Safety net: an unhandled promise rejection anywhere in the app (e.g. an
// async route handler that throws without a try/catch) would otherwise
// crash the whole Node process by default - taking the entire app down
// for every user, not just the one bad request. Logging and continuing
// keeps the server up; the specific request that caused it still fails
// with whatever Express does by default (a hung/dropped connection),
// which is far better than a full outage. This is a backstop, not a
// substitute for fixing the underlying bug where it's found - see
// routes/auth.js's /login for the real fix to the crash we found there.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server stays up):', reason);
});

// Render (and most hosts) put the app behind a reverse proxy that
// terminates HTTPS. Without this, req.protocol always reports 'http',
// which would make generated QR codes encode the wrong scheme.
app.set('trust proxy', 1);

// Sessions now live in Postgres (the same Neon database everything else
// uses), not Express's default in-memory store - this is what actually
// fixes "logged out on every restart/redeploy/sleep-wake", which setting
// SESSION_SECRET alone never did (that only kept the cookie-signing key
// stable; the session DATA still lived in memory and was lost on every
// restart regardless). connect-pg-simple manages its own "session" table
// (auto-created on first run) and prunes expired rows automatically -
// no separate Redis or other service needed now that the database
// itself is a real persistent Postgres instance rather than SQLite.
app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // set true once this runs behind HTTPS
    maxAge: 12 * 60 * 60 * 1000, // 12-hour login, matches a work shift
  },
}));
app.use(attachUser);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/kegs', kegRoutes);
app.use('/api/kegs', eventRoutes); // adds POST /api/kegs/:kegId/events
app.use('/api/alerts', alertRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/devices', deviceRoutes);

const PORT = process.env.PORT || 3000;

// Create tables if they don't exist yet (idempotent - safe on every boot),
// then auto-seed demo data if the database is empty. Auto-seeding matters
// even with a real persistent Postgres database: it means a brand-new
// Neon database gets populated automatically on first deploy, with no
// manual `node seed.js` step needed against the live instance.
db.init()
  .then(() => seedIfEmpty())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Keg tracker running at http://localhost:${PORT}`);
      console.log(`Try it: http://localhost:${PORT}/scan.html?keg=DEMO-KEG-1`);
    });
  })
  .catch((err) => {
    console.error('Failed to start up (database init/seed):', err);
    process.exit(1);
  });
