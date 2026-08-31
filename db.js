// db.js - SQLite setup and schema for the keg tracking MVP.
// Uses Node's built-in node:sqlite module (no native compilation required -
// avoids the better-sqlite3 native-binary crashes seen on newer Node
// versions).

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);

const db = new DatabaseSync(path.join(dbDir, 'kegs.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('filler','washer','driver','warehouse','admin','manager')),
  password_hash TEXT NOT NULL
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
  destination TEXT, -- customer name for display; set together with customer_id when Warehouse assigns a destination
  customer_id TEXT REFERENCES customers(id), -- links to a real customer record - enables customer-level reporting
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keg_id TEXT NOT NULL REFERENCES kegs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  action_type TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_keg ON events(keg_id);
CREATE INDEX IF NOT EXISTS idx_kegs_status ON kegs(status);
`);

// node:sqlite's DatabaseSync has no built-in .transaction() helper (unlike
// better-sqlite3), so this small wrapper gives routes/events.js the same
// "run these statements atomically" behavior.
db.withTransaction = (fn) => {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

module.exports = db;
