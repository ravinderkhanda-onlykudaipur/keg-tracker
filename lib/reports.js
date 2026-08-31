// lib/reports.js
// Turnover-time, utilization, and a few operational stats, all computed
// live from the events/kegs tables (no separate reporting table needed -
// the full audit trail already has everything). Fine at this scale;
// worth revisiting (caching, or a scheduled pre-computation) if the
// events table grows very large - see the note in server.js/README.

const { parseSqliteUtc } = require('./cooldown');
const { TRANSITIONS } = require('./stateMachine');

function resolveNextStatus(actionType, details) {
  const rule = TRANSITIONS[actionType];
  if (!rule) return null;
  return typeof rule.to === 'function' ? rule.to(details) : rule.to;
}

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
function getStageDurations(db) {
  const kegs = db.prepare('SELECT id, created_at FROM kegs').all();
  const samples = {}; // status -> [hours, hours, ...]

  for (const keg of kegs) {
    const events = db.prepare(`
      SELECT action_type, details, created_at FROM events
      WHERE keg_id = ? ORDER BY created_at ASC, id ASC
    `).all(keg.id);

    let currentStatus = 'empty_returned'; // every keg starts here
    let periodStartStr = keg.created_at;

    for (const ev of events) {
      const startMs = parseSqliteUtc(periodStartStr).getTime();
      const endMs = parseSqliteUtc(ev.created_at).getTime();
      const hours = (endMs - startMs) / (1000 * 60 * 60);
      if (hours >= 0) {
        (samples[currentStatus] = samples[currentStatus] || []).push(hours);
      }

      let details = {};
      try { details = JSON.parse(ev.details || '{}'); } catch { /* leave as {} */ }
      const nextStatus = resolveNextStatus(ev.action_type, details);
      if (nextStatus) {
        currentStatus = nextStatus;
        periodStartStr = ev.created_at;
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
function getTurnoverTime(db) {
  const kegs = db.prepare('SELECT id FROM kegs').all();
  const cycleHours = [];

  for (const keg of kegs) {
    const washEvents = db.prepare(`
      SELECT created_at FROM events
      WHERE keg_id = ? AND action_type = 'wash'
      ORDER BY created_at ASC, id ASC
    `).all(keg.id);

    for (let i = 1; i < washEvents.length; i++) {
      const hours = (parseSqliteUtc(washEvents[i].created_at).getTime()
                    - parseSqliteUtc(washEvents[i - 1].created_at).getTime()) / (1000 * 60 * 60);
      if (hours >= 0) cycleHours.push(hours);
    }
  }

  return summarize(cycleHours);
}

// Current snapshot: how many kegs sit in each status right now.
function getInventorySnapshot(db) {
  return db.prepare('SELECT status, COUNT(*) AS count FROM kegs GROUP BY status ORDER BY count DESC').all();
}

// Fill volume + product popularity - volume is fixed at 20L per fill
// (see public/scan.html's filler config), so total liters is just a count.
function getFillStats(db) {
  const fillEvents = db.prepare(`SELECT details FROM events WHERE action_type = 'fill'`).all();
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
function getWashStats(db) {
  const washEvents = db.prepare(`SELECT details FROM events WHERE action_type = 'wash'`).all();
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
function getCustomerHoldStats(db) {
  const kegs = db.prepare('SELECT id, created_at FROM kegs').all();
  const samplesByCustomer = {}; // customer_id -> [hours, ...]

  for (const keg of kegs) {
    const events = db.prepare(`
      SELECT action_type, details, created_at FROM events
      WHERE keg_id = ? ORDER BY created_at ASC, id ASC
    `).all(keg.id);

    let currentStatus = 'empty_returned';
    let periodStartStr = keg.created_at;
    let currentCustomerId = null;

    for (const ev of events) {
      const startMs = parseSqliteUtc(periodStartStr).getTime();
      const endMs = parseSqliteUtc(ev.created_at).getTime();
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
        periodStartStr = ev.created_at;
      }
    }
  }

  const customers = db.prepare('SELECT id, name FROM customers').all();
  const nameById = Object.fromEntries(customers.map((c) => [c.id, c.name]));

  const result = [];
  for (const [customerId, hoursArr] of Object.entries(samplesByCustomer)) {
    result.push({ customerId, customerName: nameById[customerId] || customerId, ...summarize(hoursArr) });
  }
  return result.sort((a, b) => b.avgHours - a.avgHours);
}

function getFullReport(db) {
  return {
    inventory: getInventorySnapshot(db),
    stageDurations: getStageDurations(db),
    turnover: getTurnoverTime(db),
    fillStats: getFillStats(db),
    washStats: getWashStats(db),
    customerHoldStats: getCustomerHoldStats(db),
  };
}

module.exports = {
  getFullReport, getInventorySnapshot, getStageDurations,
  getTurnoverTime, getFillStats, getWashStats, getCustomerHoldStats,
};
