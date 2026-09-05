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
      -- location_note: a free-text note (GPS coords, "Zone A", etc.)
      -- entered alongside certain actions - unrelated to the v2 model's
      -- current_location below, which is an ENTITY (customer/driver/
      -- mover/washer/filler/warehouse), not free text. This column used
      -- to be named current_location itself before the v2 rebuild
      -- needed that name for the entity field - renamed here rather
      -- than picking a different name for the new field, since
      -- current_location is what DATA_MODEL.md and the transition
      -- engine already call it throughout.
      location_note TEXT,
      destination TEXT,
      destination_address TEXT,
      destination_phone TEXT,
      customer_id TEXT REFERENCES customers(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- ===== v2 custody model (see DATA_MODEL.md) =====
      -- Coexists with the legacy status column above during the
      -- transition rather than replacing it outright - both are kept
      -- in sync by the v2 routes, so nothing that still reads status
      -- breaks while the new model is being validated. status is a
      -- real candidate for removal in a later round once v2 is fully
      -- proven out, not yet.
      current_location TEXT NOT NULL DEFAULT 'warehouse'
        CHECK (current_location IN ('customer','driver','mover','washer','filler','warehouse')),
      warehouse_sublocation TEXT
        CHECK (warehouse_sublocation IN ('uncleaned','cleaned','filled','damaged')),
      current_condition TEXT NOT NULL DEFAULT 'empty'
        CHECK (current_condition IN ('empty','washing','cleaned','filling','filled','to_be_delivered','delivered','delivery_failed','damaged')),
      pending_handover_to TEXT
        CHECK (pending_handover_to IN ('customer','driver','mover','washer','filler','warehouse')),
      pending_handover_warehouse_sublocation TEXT
        CHECK (pending_handover_warehouse_sublocation IN ('uncleaned','cleaned','filled','damaged')),
      pending_handover_initiated_at TIMESTAMPTZ,
      pending_handover_initiated_by TEXT REFERENCES users(id),
      pending_handover_transition_id TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      keg_id TEXT NOT NULL REFERENCES kegs(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- v2 custody model fields (see DATA_MODEL.md). Nullable and
      -- coexisting alongside the pre-existing columns above rather than
      -- replacing them, same reasoning as kegs' own v2 columns - legacy
      -- events keep working, v2 events populate these too.
      sender TEXT,
      receiver TEXT,
      from_location TEXT,
      from_warehouse_sublocation TEXT,
      from_condition TEXT,
      to_location TEXT,
      to_warehouse_sublocation TEXT,
      to_condition TEXT,
      -- 'initiated' (sender's scan, on a two-scan handover) or
      -- 'confirmed' (receiver's scan, or the only event for a
      -- single-actor transition like washer_completes_wash). NULL for
      -- pre-v2 events, which had no such concept.
      phase TEXT CHECK (phase IN ('initiated','confirmed'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_keg ON events(keg_id);
    CREATE INDEX IF NOT EXISTS idx_kegs_status ON kegs(status);
    CREATE INDEX IF NOT EXISTS idx_kegs_current_location ON kegs(current_location);

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

  // v2 custody model migration (see DATA_MODEL.md). Renames the
  // pre-existing free-text current_location to location_note first -
  // guarded purely by "does location_note not exist yet", which is
  // the one condition that's actually true only on a database that
  // predates this rename (a brand-new database's CREATE TABLE above
  // already creates both columns under their final names, so
  // location_note already exists there and this never fires; once the
  // rename has happened once on an old database, location_note exists
  // from then on too, so it never fires again either).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'kegs' AND column_name = 'current_location'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'kegs' AND column_name = 'location_note'
      ) THEN
        ALTER TABLE kegs RENAME COLUMN current_location TO location_note;
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS location_note TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS current_location TEXT NOT NULL DEFAULT 'warehouse';`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS warehouse_sublocation TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS current_condition TEXT NOT NULL DEFAULT 'empty';`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS pending_handover_to TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS pending_handover_warehouse_sublocation TEXT;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS pending_handover_initiated_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS pending_handover_initiated_by TEXT REFERENCES users(id);`);
  await pool.query(`ALTER TABLE kegs ADD COLUMN IF NOT EXISTS pending_handover_transition_id TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS sender TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS receiver TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS from_location TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS from_warehouse_sublocation TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS from_condition TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS to_location TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS to_warehouse_sublocation TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS to_condition TEXT;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS phase TEXT;`);

  // CHECK constraints added separately from the ADD COLUMN statements
  // above (a plain ALTER TABLE ADD COLUMN can't attach one inline the
  // way CREATE TABLE can) - drop-and-recreate on every boot, same
  // pattern already used for kegs_status_check elsewhere in this file,
  // so a constraint definition changing in a later round doesn't need
  // its own new migration step.
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_current_location_check;`);
  await pool.query(`ALTER TABLE kegs ADD CONSTRAINT kegs_current_location_check CHECK (current_location IN ('customer','driver','mover','washer','filler','warehouse'));`);
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_warehouse_sublocation_check;`);
  await pool.query(`ALTER TABLE kegs ADD CONSTRAINT kegs_warehouse_sublocation_check CHECK (warehouse_sublocation IN ('uncleaned','cleaned','filled','damaged'));`);
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_current_condition_check;`);
  await pool.query(`ALTER TABLE kegs ADD CONSTRAINT kegs_current_condition_check CHECK (current_condition IN ('empty','washing','cleaned','filling','filled','to_be_delivered','delivered','delivery_failed','damaged'));`);
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_pending_handover_to_check;`);
  await pool.query(`ALTER TABLE kegs ADD CONSTRAINT kegs_pending_handover_to_check CHECK (pending_handover_to IN ('customer','driver','mover','washer','filler','warehouse'));`);
  await pool.query(`ALTER TABLE kegs DROP CONSTRAINT IF EXISTS kegs_pending_handover_warehouse_sublocation_check;`);
  await pool.query(`ALTER TABLE kegs ADD CONSTRAINT kegs_pending_handover_warehouse_sublocation_check CHECK (pending_handover_warehouse_sublocation IN ('uncleaned','cleaned','filled','damaged'));`);
  await pool.query(`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_phase_check;`);
  await pool.query(`ALTER TABLE events ADD CONSTRAINT events_phase_check CHECK (phase IN ('initiated','confirmed'));`);

  // One-time data population: maps every EXISTING keg's legacy status
  // into the new four-field model, so a keg that already existed
  // before this migration doesn't just sit at the DEFAULT
  // (warehouse/empty) regardless of what it actually is. Guarded by an
  // app_settings flag rather than some inferred "does this look
  // unmigrated" check on the data itself - trying to detect "still at
  // the default" would be genuinely ambiguous once real v2 traffic
  // exists, since warehouse/empty is also a perfectly normal state a
  // v2-managed keg can legitimately be in on its own.
  const { getSetting, setSetting } = require('./lib/settings');
  const migrationDone = await getSetting(pool, 'v2_status_migration_done', 'false');
  if (migrationDone !== 'true') {
    const STATUS_TO_V2 = {
      empty_returned:        { current_location: 'mover',     current_condition: 'empty' },
      allotted_washer:       { current_location: 'mover',     current_condition: 'empty',  pending_handover_to: 'washer' },
      received_washer:       { current_location: 'washer',    current_condition: 'empty' },
      washed:                { current_location: 'washer',    current_condition: 'cleaned', pending_handover_to: 'filler' },
      clean_storage:         { current_location: 'washer',    current_condition: 'cleaned', pending_handover_to: 'mover' },
      received_from_washer:  { current_location: 'mover',     current_condition: 'cleaned' },
      received_filler:       { current_location: 'filler',    current_condition: 'cleaned' },
      filled:                { current_location: 'filler',    current_condition: 'filled', pending_handover_to: 'mover' },
      received_from_filler:  { current_location: 'mover',     current_condition: 'filled' },
      dispatched:            { current_location: 'mover',     current_condition: 'filled', pending_handover_to: 'driver' },
      received_driver:       { current_location: 'driver',    current_condition: 'to_be_delivered' },
      delivered:             { current_location: 'customer',  current_condition: 'delivered' },
      empty_at_customer:     { current_location: 'driver',    current_condition: 'empty' },
      returned_to_warehouse: { current_location: 'driver',    current_condition: 'empty',  pending_handover_to: 'mover' },
      received_from_driver:  { current_location: 'mover',     current_condition: 'empty' },
      needs_repair:          { current_location: 'mover',     current_condition: 'damaged' },
    };
    for (const [status, v2] of Object.entries(STATUS_TO_V2)) {
      await pool.query(
        `UPDATE kegs SET current_location = $1, current_condition = $2, pending_handover_to = $3 WHERE status = $4`,
        [v2.current_location, v2.current_condition, v2.pending_handover_to || null, status]
      );
    }
    await setSetting(pool, 'v2_status_migration_done', 'true');
  }

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
