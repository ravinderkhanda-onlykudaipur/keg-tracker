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
      address TEXT,
      phone TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      default_abv REAL
    );

    CREATE TABLE IF NOT EXISTS kegs (
      id TEXT PRIMARY KEY,
      manufacturing_number TEXT,
      size_liters REAL,
      material TEXT,
      status TEXT NOT NULL DEFAULT 'empty_returned'
        CHECK (status IN ('empty_returned','allotted_washer','received_washer','clean_storage','received_from_washer','washed','received_filler','filled','received_from_filler','dispatched','received_driver','delivered','empty_at_customer','returned_to_warehouse','received_from_driver','needs_repair')),
      current_location TEXT,
      destination TEXT,
      destination_address TEXT,
      destination_phone TEXT,
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
      user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      device_label TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS device_approval_requests (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, device_id)
    );

    -- Small generic key/value table for app-wide toggles Admin can flip
    -- from the UI without a redeploy - currently just the device-
    -- approval pause switch, but written generically since another
    -- similar on/off setting would fit the same shape.
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Schema migrations for databases created before a column was added -
  // CREATE TABLE IF NOT EXISTS above is a no-op once the table already
  // exists (which it does now that Postgres persists across deploys),
  // so a genuinely new column needs its own explicit ALTER TABLE, run
  // safely with IF NOT EXISTS so this is a no-op on every future boot
  // once it's already applied once.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS manufacturing_number TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS destination_address TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS destination_phone TEXT;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT;`);

  // Device registration moved from per-ROLE to per-USER: a device
  // approved for one washer no longer automatically works for a
  // different washer sharing that role - each individual now needs
  // their own device approved. Existing role-keyed rows can't be
  // attributed to a specific person under the old model (it never
  // tracked who, only which role), so they're removed rather than kept
  // as meaningless data - everyone's device just needs approving once
  // more under the new system. All of this is safe to run on every
  // boot: each step either uses IF EXISTS/IF NOT EXISTS, or (for the
  // UNIQUE constraint, which has no such shorthand in Postgres) is
  // wrapped in a existence check first.
  await pool.query(`ALTER TABLE device_registrations ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);`);
  await pool.query(`ALTER TABLE device_approval_requests ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);`);
  await pool.query(`DELETE FROM device_registrations WHERE user_id IS NULL;`);
  await pool.query(`DELETE FROM device_approval_requests WHERE user_id IS NULL;`);
  await pool.query(`ALTER TABLE device_registrations ALTER COLUMN user_id SET NOT NULL;`);
  await pool.query(`ALTER TABLE device_approval_requests ALTER COLUMN user_id SET NOT NULL;`);
  await pool.query(`ALTER TABLE device_registrations DROP CONSTRAINT IF EXISTS device_registrations_role_device_id_key;`);
  await pool.query(`ALTER TABLE device_approval_requests DROP CONSTRAINT IF EXISTS device_approval_requests_role_device_id_key;`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_registrations_user_id_device_id_key') THEN
        ALTER TABLE device_registrations ADD CONSTRAINT device_registrations_user_id_device_id_key UNIQUE (user_id, device_id);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_approval_requests_user_id_device_id_key') THEN
        ALTER TABLE device_approval_requests ADD CONSTRAINT device_approval_requests_user_id_device_id_key UNIQUE (user_id, device_id);
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE device_registrations DROP COLUMN IF EXISTS role;`);
  await pool.query(`ALTER TABLE device_approval_requests DROP COLUMN IF EXISTS role;`);
  await pool.query(`ALTER TABLE device_approval_requests DROP COLUMN IF EXISTS requested_by_user_id;`); // superseded by user_id itself

  // Keg lifecycle expanded: Mover now explicitly releases a returned
  // keg to Washer ('allotted_washer') rather than Washer being able to
  // act on anything sitting in 'empty_returned', and Washer can now
  // choose to route a freshly-washed keg either straight to Filler
  // ('washed', unchanged) or back to Mover to hold as clean stock
  // ('clean_storage') until Mover decides to release it to Filler.
  //
  // Further expanded: Washer, Filler, Driver, and Mover (for the
  // empty-keg handoff from Driver specifically) each now have a
  // separate "receive" step before their actual work action -
  // 'received_washer', 'received_filler', 'received_driver',
  // 'received_from_driver'. This decouples "Mover/whoever told me
  // about this keg" from "I'm physically holding it right now", so
  // someone can scan through a whole batch (e.g. ten kegs allotted for
  // washing) confirming custody of each first, then come back and do
  // the actual wash/fill/deliver one at a time whenever they're ready,
  // rather than the notification and the work being forced into one
  // single action.
  //
  // Rounded out further still: Mover also gets an explicit receive
  // step for the two remaining handoffs into their own hands -
  // 'received_from_filler' (a completed fill, before Mover dispatches
  // it) and 'received_from_washer' (a keg Washer sent to clean storage
  // instead of straight to Filler, before Mover releases it onward) -
  // same reasoning as above, applied consistently everywhere a keg
  // changes hands, not just some of those places.
  //
  // Existing kegs already sitting in a status from before either
  // change need no data migration - only the new status values
  // themselves need to become valid, which means dropping and
  // re-adding the CHECK constraint (ALTER COLUMN can't add to a
  // CHECK's allowed list directly, and ADD COLUMN IF NOT EXISTS - the
  // pattern used elsewhere in this function - doesn't apply to constraints).
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_status_check;`);
  await pool.query(`
    ALTER TABLE kegs ADD CONSTRAINT kegs_status_check
      CHECK (status IN ('empty_returned','allotted_washer','received_washer','clean_storage','received_from_washer','washed','received_filler','filled','received_from_filler','dispatched','received_driver','delivered','empty_at_customer','returned_to_warehouse','received_from_driver','needs_repair'));
  `);
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
