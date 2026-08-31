// lib/cooldown.js
// Some actions shouldn't be logged too soon after another one on the same
// keg - either because they represent genuinely separate real-world
// moments (a keg isn't actually empty the instant it's delivered full -
// that happens later, once the customer's finished it), or because an
// action with no real state change attached (like Warehouse's general
// location log) could otherwise be submitted in an unbounded loop with
// no natural stopping point.
//
// COOLDOWNS maps an action type to the action type whose most recent
// timestamp it must wait on - which can be itself (a same-action
// cooldown, like warehouse_move waiting on its own last submission) or a
// different one (a cross-action cooldown, like mark_empty waiting on the
// keg's last deliver).

const COOLDOWNS = {
  mark_empty: 'deliver', // can't mark empty too soon after logging delivery
  // Note: warehouse_move used to need a same-action cooldown here too
  // (it had no natural stopping point), but that whole action was
  // removed instead - see lib/stateMachine.js's comment on why.
};

// Configurable via ACTION_COOLDOWN_MS so this can be set to something
// small (e.g. 60000 = 1 minute) for testing without touching code, and
// a realistic value (e.g. 86400000 = 1 day) for real use. Defaults to 1
// day if unset.
function getCooldownMs() {
  const envVal = process.env.ACTION_COOLDOWN_MS;
  const parsed = Number(envVal);
  if (envVal && !isNaN(parsed) && parsed >= 0) return parsed;
  return 24 * 60 * 60 * 1000; // 1 day
}

// The database stores timestamps as UTC "YYYY-MM-DD HH:MM:SS" text with
// no timezone marker (SQLite's datetime('now')) - this makes that
// parseable as the UTC instant it actually is, same trick used for IST
// display formatting in scan.html, just on the server side this time.
function parseSqliteUtc(dtString) {
  return new Date(dtString.replace(' ', 'T') + 'Z');
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Returns { blocked: false } or { blocked: true, error: '...' }.
// `db` is passed in rather than required here so this stays easy to unit
// test with a fake db object, same pattern as the rest of the app.
function checkCooldown(db, kegId, actionType) {
  const referenceAction = COOLDOWNS[actionType];
  if (!referenceAction) return { blocked: false }; // no cooldown rule for this action

  const lastEvent = db.prepare(`
    SELECT created_at FROM events
    WHERE keg_id = ? AND action_type = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(kegId, referenceAction);

  if (!lastEvent) return { blocked: false }; // nothing to wait on yet

  const elapsedMs = Date.now() - parseSqliteUtc(lastEvent.created_at).getTime();
  const minMs = getCooldownMs();
  if (elapsedMs >= minMs) return { blocked: false };

  return {
    blocked: true,
    error: `Please wait before logging this again - ${formatDuration(minMs - elapsedMs)} remaining.`,
  };
}

module.exports = { checkCooldown, getCooldownMs, formatDuration, parseSqliteUtc, COOLDOWNS };
