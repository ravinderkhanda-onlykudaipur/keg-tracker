// lib/reports.js
// Turnover-time, utilization, and a few operational stats, all computed
// live from the events/kegs tables (no separate reporting table needed -
// the full audit trail already has everything). Fine at this scale;
// worth revisiting (caching, or a scheduled pre-computation) if the
// events table grows very large - see the note in server.js/README.
//
// Note on query pattern: several functions here loop over kegs and run
// one events query per keg. That was cheap with SQLite (local file), and
// stays correct with Postgres (each await just happens in sequence) -
// but it does mean more network round-trips than a single joined query
// would. Fine at this app's current scale; worth revisiting (a single
// query fetching all events, grouped in JS) if the kegs table grows into
// the thousands.

const { toDate } = require('./cooldown');
const { resolveNextStatus } = require('./stateMachine');

function summarize(hoursArr) {
  if (!hoursArr.length) return null;
  const sum = hoursArr.reduce((a, b) => a + b, 0);
  return {
    count: hoursArr.length,
    avgHours: Math.round((sum / hoursArr.length) * 10) / 10,
    minHours: Math.round(Math.min(...hoursArr) * 10) / 10,
    maxHours: Math.round(Math.max(...hoursArr) * 10) / 10,
  };
}

// How long kegs spend in each status, on average, based on COMPLETED
// stays only (i.e. periods that actually ended when the next event
// happened) - a keg's current, still-ongoing stay is deliberately
// excluded here, since that's exactly what lib/alerts.js already covers
// (flagging ones that are currently overdue), and mixing the two would
// double up on the same signal in two different, inconsistent ways.
async function getStageDurations(db) {
  const { rows: kegs } = await db.query('SELECT id, created_at FROM kegs');
  const samples = {}; // status -> [hours, hours, ...]

  for (const keg of kegs) {
    const { rows: events } = await db.query(`
      SELECT action_type, details, created_at FROM events
      WHERE keg_id = $1 ORDER BY created_at ASC, id ASC
    `, [keg.id]);

    let currentStatus = 'empty_returned'; // every keg starts here
    let periodStartVal = keg.created_at;

    for (const ev of events) {
      const startMs = toDate(periodStartVal).getTime();
      const endMs = toDate(ev.created_at).getTime();
      const hours = (endMs - startMs) / (1000 * 60 * 60);
      if (hours >= 0) {
        (samples[currentStatus] = samples[currentStatus] || []).push(hours);
      }

      let details = {};
      try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }
      const nextStatus = resolveNextStatus(ev.action_type, details);
      if (nextStatus) {
        currentStatus = nextStatus;
        periodStartVal = ev.created_at;
      }
    }
  }

  const result = {};
  for (const [status, hoursArr] of Object.entries(samples)) {
    result[status] = summarize(hoursArr);
  }
  return result;
}

// Full-cycle turnover: time between consecutive 'wash' events on the
// same keg, i.e. one complete trip through the whole pipeline and back
// to being washed again.
async function getTurnoverTime(db) {
  const { rows: kegs } = await db.query('SELECT id FROM kegs');
  const cycleHours = [];

  for (const keg of kegs) {
    const { rows: washEvents } = await db.query(`
      SELECT created_at FROM events
      WHERE keg_id = $1 AND action_type = 'wash'
      ORDER BY created_at ASC, id ASC
    `, [keg.id]);

    for (let i = 1; i < washEvents.length; i++) {
      const hours = (toDate(washEvents[i].created_at).getTime()
                    - toDate(washEvents[i - 1].created_at).getTime()) / (1000 * 60 * 60);
      if (hours >= 0) cycleHours.push(hours);
    }
  }

  return summarize(cycleHours);
}

// Current snapshot: how many kegs sit in each status right now.
async function getInventorySnapshot(db) {
  const { rows } = await db.query(
    'SELECT status, COUNT(*) AS count FROM kegs GROUP BY status ORDER BY count DESC'
  );
  // Postgres COUNT(*) returns a bigint, which node-postgres gives back as
  // a string (bigints don't fit safely in a JS number) - cast it here so
  // the frontend gets a plain number like it did with SQLite.
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

// Fill volume + product popularity - volume is fixed at 20L per fill
// (see public/scan.html's filler config), so total liters is just a count.
async function getFillStats(db) {
  const { rows: fillEvents } = await db.query(`SELECT details FROM events WHERE action_type = 'fill'`);
  const productCounts = {};
  for (const ev of fillEvents) {
    let details = {};
    try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }
    const product = details.product || 'Unknown';
    productCounts[product] = (productCounts[product] || 0) + 1;
  }
  return {
    totalFills: fillEvents.length,
    totalLiters: fillEvents.length * 20,
    productCounts, // { "IPA": 5, "Lager": 3, ... }
  };
}

// Wash inspection pass/fail rate.
async function getWashStats(db) {
  const { rows: washEvents } = await db.query(`SELECT details FROM events WHERE action_type = 'wash'`);
  let pass = 0, fail = 0;
  for (const ev of washEvents) {
    let details = {};
    try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }
    if (details.inspection === 'fail') fail++; else pass++;
  }
  const total = washEvents.length;
  return {
    total, pass, fail,
    failRatePercent: total ? Math.round((fail / total) * 1000) / 10 : 0,
  };
}

// How long each customer typically holds a keg - "delivered" (full) plus
// "empty_at_customer" (empty but not yet picked up) both count as time
// the customer physically has it. Same completed-stays-only approach as
// getStageDurations, just grouped by customer instead of status. This is
// the "who holds kegs longest" report customer management was built for.
async function getCustomerHoldStats(db) {
  const { rows: kegs } = await db.query('SELECT id, created_at FROM kegs');
  const samplesByCustomer = {}; // customer_id -> [hours, ...]

  for (const keg of kegs) {
    const { rows: events } = await db.query(`
      SELECT action_type, details, created_at FROM events
      WHERE keg_id = $1 ORDER BY created_at ASC, id ASC
    `, [keg.id]);

    let currentStatus = 'empty_returned';
    let periodStartVal = keg.created_at;
    let currentCustomerId = null;

    for (const ev of events) {
      const startMs = toDate(periodStartVal).getTime();
      const endMs = toDate(ev.created_at).getTime();
      const hours = (endMs - startMs) / (1000 * 60 * 60);

      if (hours >= 0 && currentCustomerId
          && (currentStatus === 'delivered' || currentStatus === 'empty_at_customer')) {
        (samplesByCustomer[currentCustomerId] = samplesByCustomer[currentCustomerId] || []).push(hours);
      }

      let details = {};
      try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }

      if (ev.action_type === 'assign_destination' && details.customer_id) {
        currentCustomerId = details.customer_id;
      }

      const nextStatus = resolveNextStatus(ev.action_type, details);
      if (nextStatus) {
        currentStatus = nextStatus;
        periodStartVal = ev.created_at;
      }
    }
  }

  const { rows: customers } = await db.query('SELECT id, name FROM customers');
  const nameById = Object.fromEntries(customers.map((c) => [c.id, c.name]));

  const result = [];
  for (const [customerId, hoursArr] of Object.entries(samplesByCustomer)) {
    result.push({ customerId, customerName: nameById[customerId] || customerId, ...summarize(hoursArr) });
  }
  return result.sort((a, b) => b.avgHours - a.avgHours);
}

async function getFullReport(db) {
  return {
    inventory: await getInventorySnapshot(db),
    stageDurations: await getStageDurations(db),
    turnover: await getTurnoverTime(db),
    fillStats: await getFillStats(db),
    washStats: await getWashStats(db),
    customerHoldStats: await getCustomerHoldStats(db),
  };
}

module.exports = {
  getFullReport, getInventorySnapshot, getStageDurations,
  getTurnoverTime, getFillStats, getWashStats, getCustomerHoldStats,
};
