const crypto = require('crypto');
const {
  ApiDevice,
  ApiSession,
  ApiNonce,
  ApiAuditLog,
} = require('../models/Database');
const { getClientIp } = require('./clientIpService');
const appAttest = require('./attestation/appAttest');
const playIntegrity = require('./attestation/playIntegrity');
const banService = require('./banService');

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const REQUEST_CLOCK_SKEW_MS = 2 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const rateLimitBuckets = new Map();

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function canonicalBody(body) {
  return JSON.stringify(body || {});
}

function issueSessionPayload() {
  return {
    accessToken: randomToken(32),
    refreshToken: randomToken(40),
    sessionSecret: randomToken(32),
  };
}

async function createSession(device) {
  const payload = issueSessionPayload();

  await ApiSession.create({
    app_id: device.app_id,
    device_id: device.id,
    token_hash: sha256(payload.accessToken),
    refresh_token_hash: sha256(payload.refreshToken),
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refresh_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  await device.update({
    session_secret_hash: sha256(payload.sessionSecret),
    last_seen_at: new Date(),
  });

  return {
    ...payload,
    tokenType: 'NPanel-HMAC-SHA256',
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refreshExpiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  };
}

async function createChallenge({ app, platform, deviceId, appVersion }) {
  if (!platform || !deviceId) {
    const error = new Error('platform and deviceId are required');
    error.status = 400;
    throw error;
  }

  const nonce = randomToken(24);
  await ApiNonce.create({
    app_id: app ? app.id : null,
    nonce,
    device_id: deviceId,
    purpose: 'attestation',
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
    metadata: JSON.stringify({ platform, appVersion: appVersion || null }),
  });

  return {
    challenge: nonce,
    expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000),
    attestationMode: process.env.MOBILE_ATTESTATION_MODE || 'development',
    minSupportedVersion: app ? (app.min_supported_version || null) : null,
  };
}

// Tenant-aware attestation dispatcher. development mode accepts a mock token for
// local tests; strict mode runs real iOS App Attest / Android Play Integrity
// verification against the per-app config. Returns { ok, subject?, keyId?, publicKeyPem?, error? }.
async function verifyAttestation({ app, platform, deviceId, challenge, attestation, attestationToken }) {
  const mode = process.env.MOBILE_ATTESTATION_MODE || 'development';
  if (mode === 'development') {
    const token = attestationToken || (attestation && (attestation.attestationObject || attestation.keyId));
    return { ok: Boolean(platform && token && String(token).length >= 12), subject: { mode: 'development', platform } };
  }
  if (!app) return { ok: false, error: 'tenant_required' };
  if (platform === 'ios') {
    return appAttest.verify({ app, deviceId, challenge, attestation });
  }
  if (platform === 'android') {
    return playIntegrity.verify({ app, challenge, integrityToken: attestationToken });
  }
  return { ok: false, error: 'unsupported_platform' };
}

async function exchangeToken({ app, platform, deviceId, challenge, attestation, attestationToken, firebaseUid }) {
  const appId = app ? app.id : null;
  const nonce = await ApiNonce.findOne({ where: { nonce: challenge, purpose: 'attestation', app_id: appId } });
  if (!nonce || nonce.used_at || nonce.expires_at < new Date() || nonce.device_id !== deviceId) {
    const error = new Error('Invalid or expired challenge');
    error.status = 401;
    throw error;
  }

  const attestationResult = await verifyAttestation({ app, platform, deviceId, challenge, attestation, attestationToken });
  if (!attestationResult.ok) {
    const error = new Error('Device attestation failed');
    error.status = 401;
    error.detail = attestationResult.error;
    throw error;
  }

  await nonce.update({ used_at: new Date() });

  const subject = JSON.stringify(attestationResult.subject || { platform });
  const [device] = await ApiDevice.findOrCreate({
    where: { app_id: appId, device_id: deviceId },
    defaults: {
      app_id: appId,
      device_id: deviceId,
      firebase_uid: firebaseUid || null,
      platform,
      attestation_subject: subject,
      attest_key_id: attestationResult.keyId || null,
      attest_public_key: attestationResult.publicKeyPem || null,
      status: 'active',
    },
  });

  await device.update({
    platform,
    status: 'active',
    firebase_uid: firebaseUid || device.firebase_uid || null,
    attestation_subject: subject,
    attest_key_id: attestationResult.keyId || device.attest_key_id || null,
    attest_public_key: attestationResult.publicKeyPem || device.attest_public_key || null,
    last_seen_at: new Date(),
  });

  return createSession(device);
}

async function refreshToken({ app, deviceId, refreshToken: token }) {
  if (!deviceId || !token) {
    const error = new Error('deviceId and refreshToken are required');
    error.status = 400;
    throw error;
  }

  const device = await ApiDevice.findOne({ where: { app_id: app ? app.id : null, device_id: deviceId, status: 'active' } });
  if (!device) {
    const error = new Error('Unknown device');
    error.status = 401;
    throw error;
  }

  const session = await ApiSession.findOne({
    where: {
      device_id: device.id,
      refresh_token_hash: sha256(token),
      revoked_at: null,
    },
    order: [['createdAt', 'DESC']],
  });

  if (!session || session.refresh_expires_at < new Date()) {
    const error = new Error('Expired or invalid refresh token');
    error.status = 401;
    throw error;
  }

  await session.update({ revoked_at: new Date() });
  return createSession(device);
}

async function verifySignedRequest(req) {
  const auth = req.headers.authorization || '';
  const accessToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const deviceId = req.headers['x-device-id'];
  const nonceValue = req.headers['x-nonce'];
  const timestamp = Number(req.headers['x-timestamp']);
  const bodyHash = req.headers['x-body-sha256'];
  const signature = req.headers['x-signature'];

  if (!accessToken || !deviceId || !nonceValue || !timestamp || !bodyHash || !signature) {
    const error = new Error('Missing signed request headers');
    error.status = 401;
    throw error;
  }

  if (Math.abs(Date.now() - timestamp) > REQUEST_CLOCK_SKEW_MS) {
    const error = new Error('Request timestamp outside allowed window');
    error.status = 401;
    throw error;
  }

  const appId = req.app_tenant ? req.app_tenant.id : null;
  const device = await ApiDevice.findOne({ where: { app_id: appId, device_id: deviceId, status: 'active' } });
  if (!device) {
    const error = new Error('Unknown device');
    error.status = 401;
    throw error;
  }
  if (device.firebase_uid && banService.isBannedValue(appId, 'firebase_uid', device.firebase_uid)) {
    const error = new Error('access_denied');
    error.status = 403;
    throw error;
  }

  const session = await ApiSession.findOne({
    where: {
      device_id: device.id,
      token_hash: sha256(accessToken),
      revoked_at: null,
    },
    order: [['createdAt', 'DESC']],
  });

  if (!session || session.expires_at < new Date()) {
    const error = new Error('Expired or invalid access token');
    error.status = 401;
    throw error;
  }

  const replay = await ApiNonce.findOne({ where: { nonce: nonceValue, purpose: 'api_request' } });
  if (replay) {
    const error = new Error('Replay nonce rejected');
    error.status = 401;
    throw error;
  }

  const computedBodyHash = sha256(canonicalBody(req.body));
  if (!safeEqual(bodyHash, computedBodyHash)) {
    const error = new Error('Body hash mismatch');
    error.status = 401;
    throw error;
  }

  const secretHash = device.session_secret_hash;
  const stringToSign = [
    req.method.toUpperCase(),
    req.originalUrl.split('?')[0],
    timestamp,
    nonceValue,
    bodyHash,
  ].join('\n');
  const expected = hmac(secretHash, stringToSign);
  if (!safeEqual(signature, expected)) {
    const error = new Error('Signature mismatch');
    error.status = 401;
    throw error;
  }

  try {
    await ApiNonce.create({
      app_id: appId,
      nonce: nonceValue,
      device_id: deviceId,
      purpose: 'api_request',
      expires_at: new Date(Date.now() + REQUEST_CLOCK_SKEW_MS),
      used_at: new Date(),
    });
  } catch (err) {
    // The `nonce` column is globally unique (across purposes), so a duplicate
    // nonce surfaces as a unique-constraint error. Treat it as a replay (401)
    // instead of leaking a 500.
    if (err.name === 'SequelizeUniqueConstraintError') {
      const error = new Error('Replay nonce rejected');
      error.status = 401;
      throw error;
    }
    throw err;
  }

  const deviceUpdate = { last_seen_at: new Date() };
  if ('x-premium' in req.headers) {
    deviceUpdate.is_premium = req.headers['x-premium'] === '1' || req.headers['x-premium'] === 'true';
  }
  await device.update(deviceUpdate);

  req.mobileDevice = device;
  req.mobileSession = session;
}

function mobileAuthMiddleware(req, res, next) {
  verifySignedRequest(req)
    .then(() => next())
    .catch(async (error) => {
      await audit(req, error.status || 500, error.message);
      res.status(error.status || 500).json({ error: error.message });
    });
}

function mobileRateLimitMiddleware(req, res, next) {
  const key = `${getClientIp(req)}:${req.headers['x-device-id'] || req.body?.deviceId || 'anonymous'}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (bucket.resetAt < now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
}

// Drop expired rate-limit buckets so the in-memory Map can't grow unbounded
// (one entry per ip+device). Call periodically (see server.js cron).
function pruneRateLimitBuckets() {
  const now = Date.now();
  let removed = 0;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt < now) {
      rateLimitBuckets.delete(key);
      removed += 1;
    }
  }
  return removed;
}

async function audit(req, status, detail = null) {
  try {
    await ApiAuditLog.create({
      app_id: req.app_tenant ? req.app_tenant.id : null,
      device_id: req.headers['x-device-id'] || null,
      endpoint: req.originalUrl,
      method: req.method,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent'] || null,
      status,
      detail,
    });
  } catch (error) {
    console.error('Failed to write API audit log:', error.message);
  }
}

module.exports = {
  createChallenge,
  exchangeToken,
  refreshToken,
  mobileAuthMiddleware,
  mobileRateLimitMiddleware,
  pruneRateLimitBuckets,
  audit,
  sha256,
  canonicalBody,
  hmac,
};
