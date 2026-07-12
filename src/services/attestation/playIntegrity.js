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

// Config health check for the admin panel. Verifies the whole Android chain
// WITHOUT a real device: required fields present, SA file readable, and — the
// real test — an actual call to Google's decodeIntegrityToken with a dummy
// token. Google replying 400 ("invalid token") means auth + API access +
// package are all correct (only the token is fake). 401/403 = permission / API
// not enabled; 404 = wrong package/project. Uses a FRESH auth client (bypasses
// authCache) so re-testing after fixing the SA reflects the new file.
async function checkConfig(app) {
  if (!app || !app.android_package_name) {
    return { ok: false, detail: 'Android package adı boş — App kaydına gir.' };
  }
  const dir = process.env.GOOGLE_APPLICATION_CREDENTIALS_DIR;
  if (!dir) {
    return { ok: false, detail: 'Sunucuda GOOGLE_APPLICATION_CREDENTIALS_DIR ayarlı değil (.env).' };
  }
  if (!app.play_integrity_sa_ref) {
    return { ok: false, detail: 'Play Integrity SA dosya adı boş — App kaydına gir (örn play-integrity.json).' };
  }
  const saJson = getServiceAccountForApp(app);
  if (!saJson) {
    return {
      ok: false,
      detail: `SA dosyası bulunamadı veya geçerli JSON değil: ${dir}/${app.play_integrity_sa_ref}`,
    };
  }
  try {
    const auth = new GoogleAuth({ credentials: saJson, scopes: [SCOPE] });
    const client = await auth.getClient();
    const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(app.android_package_name)}:decodeIntegrityToken`;
    await client.request({ url, method: 'POST', data: { integrity_token: 'panel-health-check-invalid-token' } });
    // Google normally rejects a fake token; reaching here still proves the call went through.
    return { ok: true, detail: 'Bağlantı kuruldu (Google yanıt verdi).' };
  } catch (err) {
    const status = err.response && err.response.status;
    const gmsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || '';
    if (status === 400) {
      return {
        ok: true,
        detail: 'Kurulum doğru: servis hesabı geçerli, Play Integrity API erişilebilir ve package adı eşleşiyor. '
          + '(400 = sahte token reddedildi; bu beklenen ve iyi bir sonuç. Gerçek doğrulama cihazdan gelen token ile çalışır.)',
      };
    }
    if (status === 401 || status === 403) {
      return { ok: false, detail: `Yetki hatası (${status}): Play Integrity API bu projede etkin olmayabilir ya da servis hesabı yetkisiz. ${gmsg}`.trim() };
    }
    if (status === 404) {
      return { ok: false, detail: `Bulunamadı (404): Android package adı ya da Google Cloud projesi yanlış olabilir. ${gmsg}`.trim() };
    }
    return { ok: false, detail: `Bağlantı/kimlik hatası: ${err.message}` };
  }
}

module.exports = { verify, checkConfig };
