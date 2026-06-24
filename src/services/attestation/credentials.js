const fs = require('fs');
const path = require('path');

// Resolves a tenant's Play Integrity service-account JSON. The App row stores
// only a filename reference (play_integrity_sa_ref); the actual key lives in a
// secure directory outside the DB (GOOGLE_APPLICATION_CREDENTIALS_DIR).
function getServiceAccountForApp(app) {
  const dir = process.env.GOOGLE_APPLICATION_CREDENTIALS_DIR;
  if (!dir || !app || !app.play_integrity_sa_ref) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, app.play_integrity_sa_ref), 'utf8'));
  } catch (err) {
    return null;
  }
}

module.exports = { getServiceAccountForApp };
