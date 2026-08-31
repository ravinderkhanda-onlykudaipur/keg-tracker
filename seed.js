// seed.js - populates demo data: one user per role, password "demo1234"
// for everyone (hashed with bcrypt, never stored in plaintext), plus a
// keg sitting at "empty_returned" ready to be washed.
//
// Exported as seedIfEmpty() so server.js can auto-run it on startup when
// the database is empty. Can still be run directly too: `node seed.js`
// (needs DATABASE_URL set in the environment either way).

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const DEMO_PASSWORD = 'demo1234';

const users = [
  { id: 'u-filler',    name: 'Fiona Filler',    role: 'filler' },
  { id: 'u-washer',    name: 'Wes Washer',      role: 'washer' },
  { id: 'u-driver',    name: 'Dana Driver',     role: 'driver' },
  { id: 'u-warehouse', name: 'Wally Warehouse', role: 'warehouse' },
  { id: 'u-admin',     name: 'Alex Admin',      role: 'admin' },   // can create kegs; sees everything
  { id: 'u-manager',   name: 'Mona Manager',    role: 'manager' }, // sees everything admin sees, can't create/change anything
];

// Demo customers, so the destination dropdown isn't empty on first run.
// Replace with your real customer names/addresses whenever - see
// public/index.html's "Customers" section, or add them inline from
// Warehouse's "Assign destination" form.
const customers = [
  { id: 'CUST-DOWNTOWN', name: 'Downtown Taproom',       address: null },
  { id: 'CUST-RIVERSIDE', name: 'Riverside Pub',          address: null },
  { id: 'CUST-CITYCTR',  name: 'City Center Bar',         address: null },
];

async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM users');
  const count = Number(rows[0].count); // COUNT(*) comes back as a string (bigint) - cast it
  if (count > 0) {
    console.log(`Database already has ${count} user(s) - skipping seed.`);
    return;
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of users) {
    await pool.query(`
      INSERT INTO users (id, name, role, password_hash) VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING
    `, [u.id, u.name, u.role, hash]);
  }

  for (const c of customers) {
    await pool.query(`
      INSERT INTO customers (id, name, address) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `, [c.id, c.name, c.address]);
  }

  await pool.query(`
    INSERT INTO kegs (id, size_liters, material, status, current_location)
    VALUES ('DEMO-KEG-1', 50, 'stainless', 'empty_returned', 'warehouse')
    ON CONFLICT (id) DO NOTHING
  `);

  console.log(`Seeded demo users (password "${DEMO_PASSWORD}" for all), ${customers.length} demo customers, and keg DEMO-KEG-1`);
  console.log(users.map((u) => `  ${u.role.padEnd(10)} -> ${u.id}`).join('\n'));
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  seedIfEmpty()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
