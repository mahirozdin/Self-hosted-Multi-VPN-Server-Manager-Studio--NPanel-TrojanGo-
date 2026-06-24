const { BanRule } = require('../models/Database');
const { getClientIp } = require('./clientIpService');

// In-memory ban cache, refreshed lazily (TTL) and on mutation. Avoids a DB hit
// on every /v1 request. NOTE: per-process — for multi-instance, move to Redis.
const TTL_MS = 30 * 1000;
let globalSet = new Set();   // `${type}:${value}` — applies to all apps
let scopedSet = new Set();   // `${app_id}:${type}:${value}` — single app
let loadedAt = 0;
let loading = null;

async function refresh() {
  const rules = await BanRule.findAll();
  const g = new Set();
  const s = new Set();
  for (const r of rules) {
    if (r.app_id == null) g.add(`${r.type}:${r.value}`);
    else s.add(`${r.app_id}:${r.type}:${r.value}`);
  }
  globalSet = g;
  scopedSet = s;
  loadedAt = Date.now();
}

async function ensureFresh() {
  if (Date.now() - loadedAt < TTL_MS) return;
  if (!loading) loading = refresh().finally(() => { loading = null; });
  await loading;
}

function invalidate() { loadedAt = 0; }

// Sync check against the in-memory cache (call ensureFresh() first).
function isBannedValue(appId, type, value) {
  if (!value) return false;
  if (globalSet.has(`${type}:${value}`)) return true;
  if (appId != null && scopedSet.has(`${appId}:${type}:${value}`)) return true;
  return false;
}

// Blocks banned IPs and device ids on every /v1 request (firebase_uid bans are
// enforced in verifySignedRequest once the device — and its uid — is known).
// Fail-open on cache error so a transient DB issue can't lock out all users.
async function banGuardMiddleware(req, res, next) {
  try {
    await ensureFresh();
    const appId = req.app_tenant ? req.app_tenant.id : null;
    const ip = getClientIp(req);
    const deviceId = req.headers['x-device-id'] || (req.body && req.body.deviceId);
    if (isBannedValue(appId, 'ip', ip) || (deviceId && isBannedValue(appId, 'device_id', deviceId))) {
      return res.status(403).json({ error: 'access_denied' });
    }
  } catch (err) {
    console.error('Ban guard error (fail-open):', err.message);
  }
  next();
}

module.exports = { refresh, ensureFresh, invalidate, isBannedValue, banGuardMiddleware };
