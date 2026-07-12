const crypto = require('crypto');
const { App } = require('../models/Database');

// Per-app_key tenant cache. Without it, every /v1 request (challenge/token/
// configs/sessions) runs an App SELECT before rate-limit and auth — a hot-path
// query that caps throughput at 1M scale. Mirrors banService's TTL + per-key
// single-flight + invalidate() shape. Caches the Sequelize model instance so
// the encryptedAttr hmac_secret getter keeps working. NOTE: per-process — for
// multi-instance move to Redis (see RELEASE_NEW_PANEL roadmap).
const APP_CACHE_TTL_MS = 30 * 1000;
const appCache = new Map(); // app_key -> { app, at }
const appLoading = new Map(); // app_key -> Promise (single-flight guard)

async function resolveApp(appKey) {
  const cached = appCache.get(appKey);
  if (cached && Date.now() - cached.at < APP_CACHE_TTL_MS) return cached.app;
  // Single-flight: concurrent requests for the same key share one query.
  if (appLoading.has(appKey)) return appLoading.get(appKey);
  const promise = App.findOne({ where: { app_key: appKey, status: 'active' } })
    .then((app) => {
      // Cache negatives too (as null) so an unknown/spoofed key can't hammer the
      // DB every request; the short TTL bounds staleness after a real create.
      appCache.set(appKey, { app: app || null, at: Date.now() });
      return app || null;
    })
    .finally(() => { appLoading.delete(appKey); });
  appLoading.set(appKey, promise);
  return promise;
}

// Clears the whole tenant cache. Call on any App mutation (create/edit/delete/
// key-rotate) so a status/key/attestation-config change takes effect at once.
function invalidateAppCache() {
  appCache.clear();
}

// Resolves the tenant for a mobile API request from the X-App-Key header.
// app_key is a PUBLIC per-app identifier baked into each build (not a secret);
// real anti-abuse comes from attestation (Faz 4) + per-device request signing.
// Sets req.app_tenant for downstream handlers. Must run first in the /v1 chain.
async function resolveAppMiddleware(req, res, next) {
  try {
    const appKey = req.headers['x-app-key'];
    if (!appKey) {
      return res.status(400).json({ error: 'Missing X-App-Key header' });
    }
    const app = await resolveApp(appKey);
    if (!app) {
      return res.status(403).json({ error: 'Unknown or disabled app' });
    }
    req.app_tenant = app;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Generates a fresh public app_key + signing secret. Returned plaintext only at
// create/rotate time; hmac_secret is encrypted at rest by the model.
function generateAppCredentials() {
  return {
    appKey: `app_${crypto.randomBytes(16).toString('hex')}`,
    hmacSecret: crypto.randomBytes(32).toString('base64url'),
  };
}

module.exports = { resolveAppMiddleware, generateAppCredentials, invalidateAppCache };
