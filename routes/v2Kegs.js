// routes/v2Kegs.js
// New v2 custody-model endpoints, coexisting with the legacy
// routes/kegs.js + routes/events.js rather than replacing them yet -
// see DATA_MODEL.md and lib/v2/README (transitionMatrix.js,
// transitionEngine.js, entityRoleMapping.js) for the full design.
// Mounted at /api/v2/kegs in server.js.

const express = require('express');
const { pool, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { getAvailableTransitions, initiateHandover, confirmHandover, executeSingleActor } = require('../lib/v2/transitionEngine');

const router = express.Router();

// Applied to every route on this router, not just the GETs - these
// endpoints reflect a keg's live custody state, so a stale cached
// response (from the browser, a proxy, or a CDN) showing an action as
// not having happened yet is a correctness bug, not a performance
// tradeoff worth making. Found this the hard way: Safari caches GET
// fetch() responses more aggressively than Chrome by default, which
// made a real, successful action look like it hadn't done anything
// when the page reloaded the keg afterward - fixed on the frontend
// (cache: 'no-store' added to every fetch call in scan-v2.html) and
// here too, for any caching layer between the browser and this server.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

async function loadKeg(kegId) {
  const { rows } = await pool.query('SELECT * FROM kegs WHERE id = $1', [kegId]);
  return rows[0] || null;
}

async function persist(kegId, userId, dbRole, result) {
  await withTransaction(async (client) => {
    const cols = Object.keys(result.kegUpdates);
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map((c) => result.kegUpdates[c]);
    await client.query(`UPDATE kegs SET ${setClause} WHERE id = $${cols.length + 1}`, [...values, kegId]);

    const ev = result.eventToLog;
    await client.query(`
      INSERT INTO events (
        keg_id, user_id, role, action_type, details, phase,
        sender, receiver, from_location, from_warehouse_sublocation, from_condition,
        to_location, to_warehouse_sublocation, to_condition
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      kegId, userId, dbRole, ev.action_type, JSON.stringify(ev.details || {}), ev.phase,
      ev.sender, ev.receiver, ev.from_location, ev.from_warehouse_sublocation || null, ev.from_condition,
      ev.to_location, ev.to_warehouse_sublocation || null, ev.to_condition,
    ]);
  });
}

// GET /api/v2/kegs - full v2 state for every keg, in one call, so the
// dashboard can group them into whatever categories make sense
// (Washer/Filler, Warehouse+Mover, In Transit) without a separate
// round-trip per category - unlike v1's dashboard lists, which fetched
// one status at a time since there were only a handful of fixed
// statuses to ask for individually.
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, current_location, warehouse_sublocation, current_condition, pending_handover_to
    FROM kegs ORDER BY id
  `);
  res.json(rows);
});

// GET /api/v2/kegs/:id - the keg's current v2 state, plus every
// transition available to the requesting user right now. No "next" -
// see DATA_MODEL.md's Section 9 note - just whatever's genuinely
// available given current_location/current_condition and the user's role.
router.get('/:id', requireAuth, async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });
  const availableTransitions = getAvailableTransitions(keg, req.user.role);
  res.json({ keg, availableTransitions });
});

// POST /api/v2/kegs/:id/initiate - sender's scan (two-scan handovers only)
router.post('/:id/initiate', requireAuth, async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });
  const { transitionId, details } = req.body || {};
  if (!transitionId) return res.status(400).json({ error: 'transitionId is required' });

  const result = initiateHandover(keg, transitionId, req.user.role, req.user.id, details || {});
  if (!result.ok) return res.status(409).json({ error: result.error });

  await persist(keg.id, req.user.id, req.user.role, result);
  const updated = await loadKeg(keg.id);
  res.status(201).json(updated);
});

// POST /api/v2/kegs/:id/confirm - receiver's scan (two-scan handovers only)
router.post('/:id/confirm', requireAuth, async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const result = confirmHandover(keg, req.user.role, req.user.id);
  if (!result.ok) return res.status(409).json({ error: result.error });

  await persist(keg.id, req.user.id, req.user.role, result);
  const updated = await loadKeg(keg.id);
  res.status(201).json(updated);
});

// POST /api/v2/kegs/:id/execute - single-actor transitions (washing,
// filling, Driver's customer pickup/delivery) - no pending state involved.
router.post('/:id/execute', requireAuth, async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });
  const { transitionId } = req.body || {};
  if (!transitionId) return res.status(400).json({ error: 'transitionId is required' });

  const result = executeSingleActor(keg, transitionId, req.user.role);
  if (!result.ok) return res.status(409).json({ error: result.error });

  await persist(keg.id, req.user.id, req.user.role, result);
  const updated = await loadKeg(keg.id);
  res.status(201).json(updated);
});

module.exports = router;
