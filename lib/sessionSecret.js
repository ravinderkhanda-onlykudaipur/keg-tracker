// lib/sessionSecret.js
// Session cookies are signed with this secret - it needs to stay the same
// across restarts, or every login gets invalidated each time the server
// restarts. This generates a random secret once and saves it next to the
// database, then reuses it on every future startup.
//
// For a real deployment (not just local dev), set SESSION_SECRET as an
// environment variable instead - that's the standard approach on hosting
// platforms and avoids the secret being just a file sitting on disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
  const secretPath = path.join(dbDir, '.session-secret');

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 }); // owner-read/write only
  return secret;
}

module.exports = { getSessionSecret };
