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
