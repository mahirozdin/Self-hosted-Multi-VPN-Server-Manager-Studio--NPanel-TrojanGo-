// Canonical English country names from ISO-2 codes (via ICU/Intl), so the mobile
// API and panel always show English names even if a row was stored otherwise.
let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch (_) {
  displayNames = null;
}

function englishName(code, fallback) {
  if (displayNames && /^[A-Za-z]{2}$/.test(code || '')) {
    try {
      const name = displayNames.of(String(code).toUpperCase());
      if (name && name !== code) return name;
    } catch (_) { /* fall through */ }
  }
  return fallback || code || '';
}

module.exports = { englishName };
