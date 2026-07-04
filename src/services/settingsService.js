const { Setting } = require('../models/Database');

// Small key/value store for panel-editable operational config (non-secret).
// Cached with a short TTL so hot paths (monitor, provision) don't hit the DB on
// every call. SMTP credentials live in env, not here.

const CACHE_TTL_MS = 15 * 1000;
let cache = null;
let loadedAt = 0;

const DEFAULTS = {
  alert_email: '',            // where health/cert alerts are sent (falls back to env ALERT_EMAIL_TO)
  default_app_id: '',         // app configs auto-publish to on provision
  monitor_enabled: 'true',    // master switch for the health monitor
  auto_renew_ssl: 'true',     // master switch for scheduled cert renewal
  ssl_renew_days: '21',       // renew when the cert has fewer than this many days left
  free_speed_kib: '4096',     // default free upload/download limit (KiB/s)
  premium_speed_kib: '0',     // 0 = unlimited
  free_ip_limit: '0',         // 0 = unlimited devices
  config_test_enabled: 'true', // hourly real-tunnel test of published configs
  config_test_timeout: '30',   // per-config test timeout (seconds)
};

async function loadAll() {
  const now = Date.now();
  if (cache && now - loadedAt < CACHE_TTL_MS) return cache;
  const rows = await Setting.findAll();
  const map = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  cache = map;
  loadedAt = now;
  return map;
}

function invalidate() {
  cache = null;
  loadedAt = 0;
}

async function get(key, fallback = null) {
  const all = await loadAll();
  const value = all[key];
  return value == null || value === '' ? (fallback != null ? fallback : (DEFAULTS[key] ?? null)) : value;
}

async function getBool(key) {
  const v = await get(key);
  return v === true || v === 'true' || v === '1';
}

async function getInt(key, fallback = 0) {
  const v = await get(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function set(key, value) {
  const stored = value == null ? '' : String(value);
  await Setting.upsert({ key, value: stored });
  invalidate();
  return { key, value: stored };
}

async function setMany(obj = {}) {
  for (const [key, value] of Object.entries(obj)) {
    // Only accept known keys to avoid junk rows.
    if (key in DEFAULTS) await set(key, value);
  }
  return getAll();
}

async function getAll() {
  const all = await loadAll();
  // Only surface known keys, with defaults filled in.
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = all[key] ?? DEFAULTS[key];
  return out;
}

module.exports = {
  DEFAULTS,
  loadAll,
  invalidate,
  get,
  getBool,
  getInt,
  set,
  setMany,
  getAll,
};
