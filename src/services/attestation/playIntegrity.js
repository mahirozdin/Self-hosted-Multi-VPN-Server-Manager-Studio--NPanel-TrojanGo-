const { GoogleAuth } = require('google-auth-library');
const { getServiceAccountForApp } = require('./credentials');

// Android Play Integrity (Classic) — the client requests an integrity token with
// our challenge as the nonce; we decode it on Google's servers and verify the
// verdicts. Classic is used (not Standard) because it binds a server-issued
// nonce, which maps 1:1 onto our challenge flow.
const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const authCache = new Map(); // app_id -> GoogleAuth

function getAuth(app, saJson) {
  if (authCache.has(app.id)) return authCache.get(app.id);
  const auth = new GoogleAuth({ credentials: saJson, scopes: [SCOPE] });
  authCache.set(app.id, auth);
  return auth;
}

async function verify({ app, challenge, integrityToken }) {
  if (!integrityToken) return { ok: false, error: 'missing_integrity_token' };
  if (!app || !app.android_package_name) return { ok: false, error: 'play_integrity_not_configured' };

  const saJson = getServiceAccountForApp(app);
  if (!saJson) return { ok: false, error: 'play_integrity_sa_missing' };

  let payload;
  try {
    const client = await getAuth(app, saJson).getClient();
    const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(app.android_package_name)}:decodeIntegrityToken`;
    const res = await client.request({ url, method: 'POST', data: { integrity_token: integrityToken } });
    payload = res.data && res.data.tokenPayloadExternal;
  } catch (err) {
    return { ok: false, error: 'decode_exception', message: err.message };
  }
  if (!payload) return { ok: false, error: 'decode_failed' };

  const requestDetails = payload.requestDetails || {};
  const appIntegrity = payload.appIntegrity || {};
  const deviceIntegrity = payload.deviceIntegrity || {};

  if (requestDetails.requestPackageName !== app.android_package_name) {
    return { ok: false, error: 'package_mismatch' };
  }
  if (requestDetails.nonce !== challenge) {
    return { ok: false, error: 'nonce_mismatch' };
  }
  const ts = Number(requestDetails.timestampMillis || 0);
  if (!ts || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) {
    return { ok: false, error: 'timestamp_skew' };
  }
  if (appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return { ok: false, error: 'app_not_recognized' };
  }
  const verdicts = deviceIntegrity.deviceRecognitionVerdict || [];
  const minVerdict = app.android_min_device_verdict || 'MEETS_DEVICE_INTEGRITY';
  if (!verdicts.includes(minVerdict)) {
    return { ok: false, error: 'device_integrity_failed' };
  }

  return { ok: true, subject: { platform: 'android', package: app.android_package_name, verdicts } };
}

module.exports = { verify };
