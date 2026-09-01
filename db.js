// db.js - PostgreSQL connection + schema.
//
// Requires a DATABASE_URL environment variable (a Postgres connection
// string) - e.g. from Neon (neon.tech), which has a genuinely free,
// permanent tier (no card, no expiry clock). See README.md under
// "Deploying" for setup steps.
//
// Replaces the earlier SQLite version: SQLite's file lived on the host's
// disk, which reset on every redeploy/restart on Render's free tier. A
// real hosted Postgres database persists independently of the app's own
// deploys and restarts.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required (a Postgres connection ' +
    'string). See README.md under "Deploying" for how to get a free one from Neon.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by most managed Postgres hosts (Neon, etc.)
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('filler','washer','driver','warehouse','admin','manager')),
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT
    );

    CREATE TABLE IF NOT EXISTS kegs (
      id TEXT PRIMARY KEY,
      size_liters REAL,
      material TEXT,
      status TEXT NOT NULL DEFAULT 'empty_returned'
        CHECK (status IN ('empty_returned','washed','filled','dispatched','delivered','empty_at_customer','needs_repair')),
      current_location TEXT,
      destination TEXT,
      customer_id TEXT REFERENCES customers(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      keg_id TEXT NOT NULL REFERENCES kegs(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_events_keg ON events(keg_id);
    CREATE INDEX IF NOT EXISTS idx_kegs_status ON kegs(status);

    CREATE TABLE IF NOT EXISTS device_registrations (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_label TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(role, device_id)
    );

    CREATE TABLE IF NOT EXISTS device_approval_requests (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      device_id TEXT NOT NULL,
      requested_by_user_id TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(role, device_id)
    );
  `);

  // Schema migrations for databases created before a column was added -
  // CREATE TABLE IF NOT EXISTS above is a no-op once the table already
  // exists (which it does now that Postgres persists across deploys),
  // so a genuinely new column needs its own explicit ALTER TABLE, run
  // safely with IF NOT EXISTS so this is a no-op on every future boot
  // once it's already applied once.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;`);
}

// Runs fn with a dedicated client, wrapped in BEGIN/COMMIT/ROLLBACK,
// always releasing the client back to the pool afterward. Used by
// routes/events.js for the insert-event + update-keg pair.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, withTransaction };
