// lib/csvHelpers.js
// Shared by routes/kegs.js's v1 exports and routes/v2Kegs.js's v2
// export - moved here rather than left duplicated in routes/kegs.js,
// so both stay identical rather than risking divergence over time.

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// Converts a stored UTC/GMT timestamp into IST and formats it as
// YYYY-MM-DD HH:MM:SS - this exact format sorts correctly as plain
// text in Excel/Sheets (lexicographic order matches chronological
// order), unlike a locale-formatted string (e.g. "9/6/2026, 3:45 PM")
// which Excel may or may not parse as a real date depending on locale
// settings, and which never sorts correctly as plain text either way.
function formatForExcel(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000); // UTC+5:30
  const pad = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

module.exports = { csvEscape, formatForExcel };
