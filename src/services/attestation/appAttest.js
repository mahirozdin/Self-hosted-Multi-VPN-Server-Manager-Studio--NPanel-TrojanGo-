const { verifyAttestation } = require('appattest-checker-node');

// iOS App Attest — one-time attestation verified at token exchange. The client
// generates a key via DCAppAttestService, attests it against this app's
// challenge, and sends { keyId, attestationObject(base64) }. The challenge bytes
// here must equal what the client used as clientDataHash input (UTF-8 of the
// challenge string); the library hashes it internally per Apple's spec.
async function verify({ app, challenge, attestation }) {
  if (!attestation || !attestation.keyId || !attestation.attestationObject) {
    return { ok: false, error: 'missing_attestation' };
  }
  if (!app || !app.apple_team_id || !app.ios_bundle_id) {
    return { ok: false, error: 'app_attest_not_configured' };
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
    return { ok: false, error: 'verify_exception', message: err.message };
  }

  if ('verifyError' in result) {
    return { ok: false, error: result.verifyError, message: result.errorMessage };
  }
  return {
    ok: true,
    subject: { platform: 'ios', appId: appInfo.appId },
    keyId: attestation.keyId,
    publicKeyPem: result.publicKeyPem,
  };
}

module.exports = { verify };
