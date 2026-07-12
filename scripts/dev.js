#!/usr/bin/env node
/*
 * Local development launcher — runs the panel on SQLite with no MySQL required.
 * Sets safe dev defaults for any unset env var, then boots the real server.
 *
 *   npm run dev
 *
 * Do NOT use in production: it defaults to a known admin password and a fixed
 * encryption key when those aren't provided. Set real values in .env for prod
 * and use `npm start`.
 */
const path = require('path');

function setDefault(key, value) {
  if (!process.env[key]) process.env[key] = value;
}

setDefault('DB_DIALECT', 'sqlite');
setDefault('SQLITE_STORAGE', path.join(__dirname, '..', 'database.sqlite'));
setDefault('ADMIN_PASSWORD', 'admin123');
setDefault('ADMIN_SESSION_SECRET', 'dev-session-secret-change-me-please-32b');
setDefault('DB_ENCRYPTION_KEY', '0'.repeat(64));
setDefault('MOBILE_ATTESTATION_MODE', 'development');
setDefault('PORT', '3210');
// Dev is single-instance on SQLite — auto-apply migrations on boot for
// convenience. Production leaves this unset and runs `npm run migrate`.
setDefault('AUTO_MIGRATE', 'true');

console.log('── DEV MODE (SQLite) ─────────────────────────────');
console.log(`   DB:    sqlite @ ${process.env.SQLITE_STORAGE}`);
console.log(`   Admin: password "${process.env.ADMIN_PASSWORD}" (dev default)`);
console.log(`   Port:  ${process.env.PORT}`);
console.log('──────────────────────────────────────────────────');

require(path.join(__dirname, '..', 'src', 'server.js'));
