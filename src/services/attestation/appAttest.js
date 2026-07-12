const { verifyAttestation } = require('appattest-checker-node');

// iOS App Attest — one-time attestation verified at token exchange. The client
// generates a key via DCAppAttestService, attests it against this app's
// challenge, and sends { keyId, attestationObject(base64) }. The challenge bytes
// here must equal what the client used as clientDataHash input (UTF-8 of the
// challenge string); the library hashes it internally per Apple's spec.
// failClass mirrors playIntegrity: 'system' = the backend couldn't run a real
// verification (missing input / misconfig / library exception) and a legitimate
// user could be locked out by our own fault; 'reject' = the App Attest library
// actually verified and rejected the device. Callers fail-open only on 'system'.
async function verify({ app, challenge, attestation }) {
  if (!attestation || !attestation.keyId || !attestation.attestationObject) {
    return { ok: false, error: 'missing_attestation', failClass: 'system' };
  }
  if (!app || !app.apple_team_id || !app.ios_bundle_id) {
    return { ok: false, error: 'app_attest_not_configured', failClass: 'system' };
  }

  const appInfo = {
    appId: `${app.apple_team_id}.${app.ios_bundle_id}`,
    developmentEnv: (app.apple_attest_env || 'production') === 'development',
  };
  const challengeBuf = Buffer.from(challenge, 'utf8');
  const attestationBuf = Buffer.from(attestation.attestationObject, 'base64');

  let result;
  try {
    result = await verifyAttestation(appInfo, attestation.keyId, challengeBuf, attestationBuf);
  } catch (err) {
    return { ok: false, error: 'verify_exception', failClass: 'system', message: err.message };
  }

  if ('verifyError' in result) {
    return { ok: false, error: result.verifyError, failClass: 'reject', message: result.errorMessage };
  }
  return {
    ok: true,
    subject: { platform: 'ios', appId: appInfo.appId },
    keyId: attestation.keyId,
    publicKeyPem: result.publicKeyPem,
  };
}

// Config health check for the admin panel. App Attest is verified locally (no
// Apple server call), so there is nothing to "connect" to — we can only confirm
// the required per-app fields are present. Real verification happens on-device.
function checkConfig(app) {
  const missing = [];
  if (!app || !app.apple_team_id) missing.push('Apple Team ID');
  if (!app || !app.ios_bundle_id) missing.push('iOS bundle id');
  if (missing.length) {
    return { ok: false, detail: `Eksik alan: ${missing.join(', ')}. App kaydına gir.` };
  }
  return {
    ok: true,
    detail: `Gerekli alanlar dolu (App ID: ${app.apple_team_id}.${app.ios_bundle_id}). `
      + 'App Attest cihazda/yerel doğrulanır; sunucu bağlantısı gerekmez. '
      + 'Gerçek doğrulama, gerçek bir iPhone uygulamayı açınca çalışır.',
  };
}

module.exports = { verify, checkConfig };
