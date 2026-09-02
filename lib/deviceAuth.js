// lib/deviceAuth.js
// Device registration for the four operational roles - restricts login
// to devices an Admin has approved, PER INDIVIDUAL USER. A device
// approved for one washer does NOT automatically work for a different
// washer, even though they share a role - each person's first login
// auto-registers their own first device (bootstrap, since otherwise
// nobody could log in the first time), and every device after that for
// THAT SPECIFIC PERSON needs its own approval.
//
// Deliberately NOT applied to admin/manager: those roles legitimately
// might be used from a home computer, office desktop, etc., and gating
// them risks an unrecoverable lockout (if the only admin's device ever
// changed, there'd be nobody left who could approve it).

const DEVICE_GATED_ROLES = ['filler', 'washer', 'driver', 'warehouse'];

function isGatedRole(role) {
  return DEVICE_GATED_ROLES.includes(role);
}

// Returns { allowed: true } if the login should proceed, or
// { allowed: false, pending: boolean } if it should be rejected.
// `pending: true` means a request was logged for Admin to review;
// `pending: false` means no usable device id was even sent (e.g. an old
// cached page, or a direct API call) - nothing to log, just reject.
// `db` is the pg Pool. `role` decides whether gating applies at all;
// the actual approval check itself is keyed by `userId`, not role.
async function checkAndRegisterDevice(db, role, deviceId, userId) {
  if (!isGatedRole(role)) return { allowed: true };
  if (!deviceId || typeof deviceId !== 'string') return { allowed: false, pending: false };

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS c FROM device_registrations WHERE user_id = $1', [userId]
  );
  const existingCount = Number(countRows[0].c); // COUNT(*) comes back as a string (bigint) - cast it

  if (existingCount === 0) {
    // Bootstrap: first-ever login for THIS PERSON auto-registers this device.
    await db.query(`
      INSERT INTO device_registrations (user_id, device_id) VALUES ($1, $2)
      ON CONFLICT (user_id, device_id) DO NOTHING
    `, [userId, deviceId]);
    return { allowed: true };
  }

  const { rows: existingRows } = await db.query(
    'SELECT 1 FROM device_registrations WHERE user_id = $1 AND device_id = $2', [userId, deviceId]
  );

  if (existingRows.length > 0) return { allowed: true };

  // Not registered - log a pending approval request (idempotent via
  // ON CONFLICT DO NOTHING, so repeated attempts from the same blocked
  // device don't pile up duplicate rows) and tell the caller to reject.
  await db.query(`
    INSERT INTO device_approval_requests (user_id, device_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, device_id) DO NOTHING
  `, [userId, deviceId]);

  return { allowed: false, pending: true };
}

module.exports = { DEVICE_GATED_ROLES, isGatedRole, checkAndRegisterDevice };
