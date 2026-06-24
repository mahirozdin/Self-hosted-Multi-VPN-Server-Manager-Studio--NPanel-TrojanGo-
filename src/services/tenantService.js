const crypto = require('crypto');
const { App } = require('../models/Database');

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
    const app = await App.findOne({ where: { app_key: appKey, status: 'active' } });
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

module.exports = { resolveAppMiddleware, generateAppCredentials };
