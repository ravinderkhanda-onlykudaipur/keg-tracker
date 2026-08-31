// seed.js - populates demo data: one user per role, password "demo1234"
// for everyone (hashed with bcrypt, never stored in plaintext), plus a
// keg sitting at "empty_returned" ready to be washed.
//
// Exported as seedIfEmpty() so server.js can auto-run it on startup when
// the database is empty. Can still be run directly too: `node seed.js`.

const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_PASSWORD = 'demo1234';

const users = [
  { id: 'u-filler',    name: 'Fiona Filler',    role: 'filler' },
  { id: 'u-washer',    name: 'Wes Washer',      role: 'washer' },
  { id: 'u-driver',    name: 'Dana Driver',     role: 'driver' },
  { id: 'u-warehouse', name: 'Wally Warehouse', role: 'warehouse' },
];

async function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) {
    console.log(`Database already has ${count} user(s) - skipping seed.`);
    return;
  }

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, name, role, password_hash) VALUES (?, ?, ?, ?)
  `);
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  users.forEach((u) => insertUser.run(u.id, u.name, u.role, hash));

  db.prepare(`
    INSERT OR IGNORE INTO kegs (id, size_liters, material, status, current_location)
    VALUES ('DEMO-KEG-1', 50, 'stainless', 'empty_returned', 'warehouse')
  `).run();

  console.log(`Seeded demo users (password "${DEMO_PASSWORD}" for all) and keg DEMO-KEG-1`);
  console.log(users.map((u) => `  ${u.role.padEnd(10)} -> ${u.id}`).join('\n'));
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  seedIfEmpty();
}
