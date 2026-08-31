// lib/deviceAuth.js
// Device registration for the four operational roles - restricts login
// as that role to devices an Admin has approved, after a trust-on-first-
// use bootstrap (the first successful login for a role auto-registers
// that device, since otherwise nobody could ever log in the first time).
//
// Deliberately NOT applied to admin/manager: those roles legitimately
// might be used from a home computer, office desktop, etc., and gating
// them risks an unrecoverable lockout (if the only admin's device ever
// changed, there'd be nobody left who could approve it). The operational
// roles are exactly where "wrong device" is a real anomaly worth
// catching, since each is normally tied to one work station's phone.
//
// Each role has its own independent approved-device list - a device
// approved for 'washer' is not automatically approved for 'filler', even
// if the same phone tries. If one person genuinely covers two roles,
// that phone just needs approving for each role separately.

const DEVICE_GATED_ROLES = ['filler', 'washer', 'driver', 'warehouse'];

function isGatedRole(role) {
  return DEVICE_GATED_ROLES.includes(role);
}

// Returns { allowed: true } if the login should proceed, or
// { allowed: false, pending: boolean } if it should be rejected.
// `pending: true` means a request was logged for Admin to review;
// `pending: false` means no usable device id was even sent (e.g. an old
// cached page, or a direct API call) - nothing to log, just reject.
function checkAndRegisterDevice(db, role, deviceId, userId) {
  if (!isGatedRole(role)) return { allowed: true };
  if (!deviceId || typeof deviceId !== 'string') return { allowed: false, pending: false };

  const { c: existingCount } = db.prepare(
    'SELECT COUNT(*) AS c FROM device_registrations WHERE role = ?'
  ).get(role);

  if (existingCount === 0) {
    // Bootstrap: first-ever login for this role auto-registers this device.
    db.prepare(`
      INSERT OR IGNORE INTO device_registrations (role, device_id) VALUES (?, ?)
    `).run(role, deviceId);
    return { allowed: true };
  }

  const isRegistered = db.prepare(
    'SELECT 1 FROM device_registrations WHERE role = ? AND device_id = ?'
  ).get(role, deviceId);

  if (isRegistered) return { allowed: true };

  // Not registered - log a pending approval request (idempotent via
  // INSERT OR IGNORE, so repeated attempts from the same blocked device
  // don't pile up duplicate rows) and tell the caller to reject the login.
  db.prepare(`
    INSERT OR IGNORE INTO device_approval_requests (role, device_id, requested_by_user_id)
    VALUES (?, ?, ?)
  `).run(role, deviceId, userId);

  return { allowed: false, pending: true };
}

module.exports = { DEVICE_GATED_ROLES, isGatedRole, checkAndRegisterDevice };
