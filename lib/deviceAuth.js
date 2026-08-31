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
// `db` is the pg Pool.
async function checkAndRegisterDevice(db, role, deviceId, userId) {
  if (!isGatedRole(role)) return { allowed: true };
  if (!deviceId || typeof deviceId !== 'string') return { allowed: false, pending: false };

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*) AS c FROM device_registrations WHERE role = $1', [role]
  );
  const existingCount = Number(countRows[0].c); // COUNT(*) comes back as a string (bigint) - cast it

  if (existingCount === 0) {
    // Bootstrap: first-ever login for this role auto-registers this device.
    await db.query(`
      INSERT INTO device_registrations (role, device_id) VALUES ($1, $2)
      ON CONFLICT (role, device_id) DO NOTHING
    `, [role, deviceId]);
    return { allowed: true };
  }

  const { rows: existingRows } = await db.query(
    'SELECT 1 FROM device_registrations WHERE role = $1 AND device_id = $2', [role, deviceId]
  );

  if (existingRows.length > 0) return { allowed: true };

  // Not registered - log a pending approval request (idempotent via
  // ON CONFLICT DO NOTHING, so repeated attempts from the same blocked
  // device don't pile up duplicate rows) and tell the caller to reject.
  await db.query(`
    INSERT INTO device_approval_requests (role, device_id, requested_by_user_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (role, device_id) DO NOTHING
  `, [role, deviceId, userId]);

  return { allowed: false, pending: true };
}

module.exports = { DEVICE_GATED_ROLES, isGatedRole, checkAndRegisterDevice };
