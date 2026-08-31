// lib/cooldown.js
// Some actions shouldn't be logged too soon after another one on the same
// keg - either because they represent genuinely separate real-world
// moments (a keg isn't actually empty the instant it's delivered full -
// that happens later, once the customer's finished it), or because an
// action with no real state change attached could otherwise be submitted
// in an unbounded loop with no natural stopping point.
//
// COOLDOWNS maps an action type to the action type whose most recent
// timestamp it must wait on - which can be itself (a same-action
// cooldown) or a different one (a cross-action cooldown, like mark_empty
// waiting on the keg's last deliver).

const COOLDOWNS = {
  mark_empty: 'deliver', // can't mark empty too soon after logging delivery
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

// Postgres's node-postgres driver returns TIMESTAMPTZ columns as real JS
// Date objects already, but this stays defensive (handles a Date, an
// ISO string, or anything Date() can parse) so callers don't need to
// know or care which shape they got back.
function toDate(val) {
  return val instanceof Date ? val : new Date(val);
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
// `db` is the pg Pool (or a client) - passed in rather than required
// here so this stays easy to unit test against a fake db object.
async function checkCooldown(db, kegId, actionType) {
  const referenceAction = COOLDOWNS[actionType];
  if (!referenceAction) return { blocked: false }; // no cooldown rule for this action

  const { rows } = await db.query(`
    SELECT created_at FROM events
    WHERE keg_id = $1 AND action_type = $2
    ORDER BY created_at DESC LIMIT 1
  `, [kegId, referenceAction]);
  const lastEvent = rows[0];

  if (!lastEvent) return { blocked: false }; // nothing to wait on yet

  const elapsedMs = Date.now() - toDate(lastEvent.created_at).getTime();
  const minMs = getCooldownMs();
  if (elapsedMs >= minMs) return { blocked: false };

  return {
    blocked: true,
    error: `Please wait before logging this again - ${formatDuration(minMs - elapsedMs)} remaining.`,
  };
}

module.exports = { checkCooldown, getCooldownMs, formatDuration, toDate, COOLDOWNS };
