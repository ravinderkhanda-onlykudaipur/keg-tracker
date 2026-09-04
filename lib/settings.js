// lib/settings.js
// Thin wrapper around the app_settings key/value table - lets Admin
// flip app-wide toggles from the UI without needing a redeploy or an
// environment variable change. Currently just backs the device-
// approval pause switch (see lib/deviceAuth.js), but written
// generically since a similar on/off setting would fit the same shape.

async function getSetting(db, key, defaultValue) {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  if (rows.length === 0) return defaultValue;
  return rows[0].value;
}

async function setSetting(db, key, value) {
  await db.query(`
    INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, value]);
}

module.exports = { getSetting, setSetting };
