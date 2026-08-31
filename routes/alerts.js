// routes/alerts.js
// Any logged-in user can read the full overdue-keg list - it's not
// sensitive data, and operational roles (washer, filler, driver,
// warehouse) use it too, filtered client-side to their own role, for the
// in-app banner in scan.html. The admin/manager dashboard in index.html
// shows the full, unfiltered breakdown.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { getOverdueKegs } = require('../lib/alerts');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json(getOverdueKegs(db));
});

module.exports = router;
