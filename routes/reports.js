// routes/reports.js
// Reporting/analytics is oversight-level data, so it's restricted to
// Admin and Manager - the same "sees everything, Manager just can't
// change anything" split as the rest of the admin page. Operational
// roles don't need aggregate stats to do their job.

const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { getFullReport } = require('../lib/reports');

const router = express.Router();

router.get('/', requireRole('admin', 'manager'), (req, res) => {
  res.json(getFullReport(db));
});

module.exports = router;
