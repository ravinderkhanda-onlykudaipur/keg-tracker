// routes/alerts.js
// Any logged-in user can read the overdue-keg list - operational roles
// (washer, filler, driver, warehouse) use it too, filtered client-side
// to their own role, for the in-app banner in scan.html. The
// admin/manager dashboard in index.html shows the full, unfiltered
// breakdown. manufacturingNumber is stripped for anyone who isn't
// Admin/Manager, same access rule as routes/kegs.js.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { getOverdueKegs } = require('../lib/alerts');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const overdue = await getOverdueKegs(pool);
  const canSeeMfg = req.user && (req.user.role === 'admin' || req.user.role === 'manager');
  const result = canSeeMfg
    ? overdue
    : overdue.map(({ manufacturingNumber, ...rest }) => rest);
  res.json(result);
});

module.exports = router;
