// routes/v2Kegs.js
// New v2 custody-model endpoints, coexisting with the legacy
// routes/kegs.js + routes/events.js rather than replacing them yet -
// see DATA_MODEL.md and lib/v2/README (transitionMatrix.js,
// transitionEngine.js, entityRoleMapping.js) for the full design.
// Mounted at /api/v2/kegs in server.js.

const express = require('express');
const { pool, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware/requireAuth');
const { getAvailableTransitions, initiateHandover, confirmHandover, executeSingleActor } = require('../lib/v2/transitionEngine');
const { getOverdueKegsV2 } = require('../lib/v2/alerts');
const { dbRoleCanActAsEntity, ENTITY_TO_DB_ROLE } = require('../lib/v2/entityRoleMapping');
const { csvEscape, formatForExcel } = require('../lib/csvHelpers');

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
    SELECT id, manufacturing_number, current_location, warehouse_sublocation, current_condition,
           pending_handover_to, pending_handover_transition_id
    FROM kegs ORDER BY id
  `);
  // Manufacturing number restricted to Admin/Manager, matching the
  // exact same rule v1's routes/kegs.js already applies - not a new
  // restriction invented here, kept consistent with it.
  const canSeeMfg = req.user.role === 'admin' || req.user.role === 'manager';
  const result = canSeeMfg ? rows : rows.map(({ manufacturing_number, ...rest }) => rest);
  res.json(result);
});

// GET /api/v2/kegs/alerts - overdue kegs per the v2 custody model.
// Placed before the /:id route below - Express matches routes in
// definition order, and /:id would otherwise treat "alerts" as a keg
// ID and never reach this handler at all. Same access rule as v1's
// routes/alerts.js: manufacturingNumber stripped for anyone who isn't
// Admin/Manager.
router.get('/alerts', requireAuth, async (req, res) => {
  const overdue = await getOverdueKegsV2(pool);
  const canSeeMfg = req.user && (req.user.role === 'admin' || req.user.role === 'manager');
  const result = canSeeMfg
    ? overdue
    : overdue.map(({ manufacturingNumber, ...rest }) => rest);
  res.json(result);
});

// GET /api/v2/kegs/my-stats - the logged-in user's own activity count,
// for their personal "Home" tab (name/role/actions-completed summary).
// Scoped entirely to req.user.id - this is "how much have I done",
// not an oversight feature, so no role restriction beyond being logged in.
router.get('/my-stats', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today
     FROM events WHERE user_id = $1 AND phase IS NOT NULL`,
    [req.user.id]
  );
  res.json({ actionsCompletedTotal: rows[0].total, actionsCompletedToday: rows[0].today });
});

// GET /api/v2/kegs/my-tasks - three categories for the "Task" tab,
// per explicit direction: Todo (kegs currently in this user's own
// hands, nothing pending, next action not yet done - no overdue
// threshold, unlike Alerts, this shows everything current), Incoming
// (handovers sent TO this user, not yet confirmed by them), and
// Outgoing (handovers this user sent, still awaiting the other side -
// informational only, not actionable by this user).
//
// Reuses the same entity/DB-role mapping the transition engine itself
// uses (dbRoleCanActAsEntity), so "does this keg belong in my Todo
// list" is answered the exact same way "can I act on this keg" is
// answered everywhere else in the app - not a second, separately
// maintained notion of role ownership.
router.get('/my-tasks', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, current_location, current_condition, warehouse_sublocation,
           pending_handover_to, pending_handover_initiated_by
    FROM kegs
  `);

  const todo = rows.filter((k) => !k.pending_handover_to && dbRoleCanActAsEntity(req.user.role, k.current_location));
  const incoming = rows.filter((k) => k.pending_handover_to && dbRoleCanActAsEntity(req.user.role, k.pending_handover_to));
  const outgoing = rows.filter((k) => k.pending_handover_to && k.pending_handover_initiated_by === req.user.id);

  const shape = (k) => ({
    kegId: k.id, currentLocation: k.current_location, currentCondition: k.current_condition,
    warehouseSublocation: k.warehouse_sublocation, pendingHandoverTo: k.pending_handover_to,
  });
  res.json({ todo: todo.map(shape), incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
});

// GET /api/v2/kegs/overview-stats - customer and product breakdowns
// for the Overview page's pie charts. Admin/Manager only, same access
// level as the rest of index.html's oversight features.
//
// Customer breakdown is filtered to current_location = 'customer'
// specifically, not just "has a customer_id set" - current_customer_id
// is never cleared once a keg comes back empty, so an unfiltered count
// would include kegs that already returned and are sitting with Mover,
// not genuinely still out with that customer.
//
// Product breakdown is filtered to conditions where the keg still
// actually contains that product (filled, to_be_delivered, delivered) -
// current_product_id has the same "never cleared" property, so once a
// keg empties and gets washed again, its last-filled product is stale
// until refilled.
router.get('/overview-stats', requireRole('admin', 'manager'), async (req, res) => {
  const { rows: byCustomer } = await pool.query(`
    SELECT c.name, COUNT(*)::int AS count
    FROM kegs k JOIN customers c ON c.id = k.current_customer_id
    WHERE k.current_location = 'customer'
    GROUP BY c.name ORDER BY count DESC
  `);
  const { rows: byProduct } = await pool.query(`
    SELECT p.name, COUNT(*)::int AS count
    FROM kegs k JOIN products p ON p.id = k.current_product_id
    WHERE k.current_condition IN ('filled', 'to_be_delivered', 'delivered')
    GROUP BY p.name ORDER BY count DESC
  `);
  res.json({ byCustomer, byProduct });
});

// GET /api/v2/kegs/export-events.csv - every v2 event (WHERE phase IS
// NOT NULL, so v1-only history rows are excluded), one row per scan -
// a two-scan handover produces two rows (initiated + confirmed), a
// single-actor action produces one. Admin/Manager only, same access
// rule as v1's export-history.csv in routes/kegs.js. Placed before
// /:id for the same routing reason as /alerts above.
//
// Timestamps use formatForExcel() (lib/csvHelpers.js) - YYYY-MM-DD
// HH:MM:SS in IST - which Excel sorts correctly as plain text, unlike
// a raw ISO string with a literal "T"/"Z" that some Excel versions
// treat as text rather than a real date/time value.
router.get('/export-events.csv', requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.keg_id, k.manufacturing_number, e.created_at, e.action_type, e.phase,
           e.sender, e.receiver, e.from_location, e.from_warehouse_sublocation, e.from_condition,
           e.to_location, e.to_warehouse_sublocation, e.to_condition,
           e.role, u.name AS user_name, e.details
    FROM events e
    JOIN kegs k ON k.id = e.keg_id
    JOIN users u ON u.id = e.user_id
    WHERE e.phase IS NOT NULL
    ORDER BY e.keg_id ASC, e.created_at ASC
  `);
  const headers = [
    'keg_id', 'manufacturing_number', 'timestamp', 'transition_id', 'phase',
    'sender', 'receiver', 'from_location', 'from_warehouse_sublocation', 'from_condition',
    'to_location', 'to_warehouse_sublocation', 'to_condition', 'role', 'user_name', 'details',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push([
      csvEscape(row.keg_id),
      csvEscape(row.manufacturing_number),
      csvEscape(formatForExcel(row.created_at)),
      csvEscape(row.action_type),
      csvEscape(row.phase),
      csvEscape(row.sender),
      csvEscape(row.receiver),
      csvEscape(row.from_location),
      csvEscape(row.from_warehouse_sublocation),
      csvEscape(row.from_condition),
      csvEscape(row.to_location),
      csvEscape(row.to_warehouse_sublocation),
      csvEscape(row.to_condition),
      csvEscape(row.role),
      csvEscape(row.user_name),
      csvEscape(row.details),
    ].join(','));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="keg-events-export.csv"');
  res.type('text/csv').send(lines.join('\n'));
});

// GET /api/v2/kegs/:id - the keg's current v2 state, plus every
// transition available to the requesting user right now. No "next" -
// see DATA_MODEL.md's Section 9 note - just whatever's genuinely
// available given current_location/current_condition and the user's role.
router.get('/:id', requireAuth, async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });
  // Customer/product names looked up specifically here, not folded
  // into loadKeg() itself - the other routes that share that helper
  // (initiate/confirm/execute) only ever need the IDs for their own
  // logic, not the display names.
  if (keg.current_customer_id) {
    const { rows } = await pool.query('SELECT name, address, phone FROM customers WHERE id = $1', [keg.current_customer_id]);
    keg.current_customer_name = rows[0]?.name || null;
    keg.current_customer_address = rows[0]?.address || null;
    keg.current_customer_phone = rows[0]?.phone || null;
  }
  if (keg.current_product_id) {
    const { rows } = await pool.query('SELECT name FROM products WHERE id = $1', [keg.current_product_id]);
    keg.current_product_name = rows[0]?.name || null;
  }

  // Name of whoever currently holds the role matching the keg's
  // location - "one person per role" is already an established
  // assumption elsewhere in the app (e.g. alerts.js's
  // receivingUserName lookup), reused here rather than a new notion.
  // Skipped for 'customer' - the customer isn't an app user, so
  // there's genuinely no one to show here.
  if (keg.current_location && keg.current_location !== 'customer') {
    const dbRole = ENTITY_TO_DB_ROLE[keg.current_location];
    if (dbRole) {
      const { rows } = await pool.query('SELECT name FROM users WHERE role = $1 AND active = true LIMIT 1', [dbRole]);
      keg.holding_user_name = rows[0]?.name || null;
    }
  }

  // History - Admin and Manager, per explicit direction (updated from
  // an earlier round that restricted this to Admin only). v1's own
  // GET /api/kegs/:id (routes/kegs.js) already returns this same data
  // completely ungated - this is a separate, deliberately-restricted
  // copy for v2 rather than loosening that endpoint's existing access.
  if (req.user.role === 'admin' || req.user.role === 'manager') {
    const { rows: events } = await pool.query(`
      SELECT e.id, e.action_type, e.phase, e.role, e.details, e.created_at, u.name AS user_name
      FROM events e JOIN users u ON u.id = e.user_id
      WHERE e.keg_id = $1 AND e.phase IS NOT NULL
      ORDER BY e.created_at ASC
    `, [keg.id]);
    keg.history = events.map((e) => ({ ...e, details: JSON.parse(e.details) }));
  }

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
  const { transitionId, details } = req.body || {};
  if (!transitionId) return res.status(400).json({ error: 'transitionId is required' });

  const result = executeSingleActor(keg, transitionId, req.user.role, details || {});
  if (!result.ok) return res.status(409).json({ error: result.error });

  await persist(keg.id, req.user.id, req.user.role, result);
  const updated = await loadKeg(keg.id);
  res.status(201).json(updated);
});

// POST /api/v2/kegs/:id/revert - undo the single most recent v2 event
// on a keg. Mover (warehouse role), Admin, and Manager only - matches
// v1's own revert scope (routes/events.js), not a general-purpose undo
// for any action by anyone.
//
// Unlike v1's revert, which had to replay every earlier event through
// resolveNextStatus() to derive the previous status (since v1 never
// stored a "before" state on the event itself), v2 events already
// record from_location/from_warehouse_sublocation/from_condition
// directly - so undoing is just restoring those values, no replay
// needed. Works correctly for both an 'initiated' event (clears the
// pending fields; location was never actually touched at initiate
// time, so restoring from_location is a no-op there, but from_condition
// correctly reverts an initiate that used conditionAtInitiate, like
// a failed-delivery report) and a 'confirmed' event (fully reverses
// the location/condition change).
//
// The revert itself is logged as a new event (phase: 'confirmed', so
// it correctly resets the alert-timing clock - see lib/v2/alerts.js -
// rather than leaving the keg looking instantly overdue again from
// the pre-revert timestamp), never deleting or altering the original
// event - same audit-trail principle as v1.
router.post('/:id/revert', requireRole('admin', 'warehouse', 'manager'), async (req, res) => {
  const keg = await loadKeg(req.params.id);
  if (!keg) return res.status(404).json({ error: 'Keg not found' });

  const { rows: recentEvents } = await pool.query(
    `SELECT * FROM events WHERE keg_id = $1 AND phase IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    [keg.id]
  );
  const lastEvent = recentEvents[0];
  if (!lastEvent) return res.status(409).json({ error: 'This keg has no logged v2 actions to revert.' });
  if (lastEvent.action_type === 'revert') {
    return res.status(409).json({ error: 'The most recent event is already a revert - nothing further to undo.' });
  }

  await withTransaction(async (client) => {
    await client.query(`
      UPDATE kegs SET
        current_location = $1, warehouse_sublocation = $2, current_condition = $3,
        pending_handover_to = NULL, pending_handover_warehouse_sublocation = NULL,
        pending_handover_initiated_at = NULL, pending_handover_initiated_by = NULL, pending_handover_transition_id = NULL
      WHERE id = $4
    `, [lastEvent.from_location, lastEvent.from_warehouse_sublocation, lastEvent.from_condition, keg.id]);

    await client.query(`
      INSERT INTO events (
        keg_id, user_id, role, action_type, details, phase,
        sender, receiver, from_location, from_warehouse_sublocation, from_condition,
        to_location, to_warehouse_sublocation, to_condition
      ) VALUES ($1,$2,$3,'revert',$4,'confirmed',$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      keg.id, req.user.id, req.user.role,
      JSON.stringify({ reverted_transition_id: lastEvent.action_type, reverted_phase: lastEvent.phase }),
      lastEvent.receiver, lastEvent.sender,
      lastEvent.to_location, lastEvent.to_warehouse_sublocation, lastEvent.to_condition,
      lastEvent.from_location, lastEvent.from_warehouse_sublocation, lastEvent.from_condition,
    ]);
  });

  const updated = await loadKeg(keg.id);
  res.status(201).json(updated);
});

module.exports = router;
