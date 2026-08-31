// server.js - entry point
const express = require('express');
const session = require('express-session');
const path = require('path');

const { getSessionSecret } = require('./lib/sessionSecret');
const { seedIfEmpty } = require('./seed');
const { attachUser } = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth');
const kegRoutes = require('./routes/kegs');
const eventRoutes = require('./routes/events');

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

// Secret persists across restarts (see lib/sessionSecret.js) so logins
// survive a server restart instead of everyone being logged out each time.
app.use(session({
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

const PORT = process.env.PORT || 3000;

// Auto-seed demo data if the database is empty - handles hosts like
// Render's free tier where the disk resets on every redeploy, so there's
// no reliable way to manually run `node seed.js` against the live instance.
seedIfEmpty()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Keg tracker running at http://localhost:${PORT}`);
      console.log(`Try it: http://localhost:${PORT}/scan.html?keg=DEMO-KEG-1`);
    });
  })
  .catch((err) => {
    console.error('Failed to seed database on startup:', err);
    process.exit(1);
  });
