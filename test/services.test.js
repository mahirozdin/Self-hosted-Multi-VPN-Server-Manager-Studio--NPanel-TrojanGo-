const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'unit-admin-password';
process.env.ADMIN_SESSION_SECRET = 'unit-admin-secret';
process.env.MOBILE_ATTESTATION_MODE = 'development';
process.env.DB_DIALECT = 'sqlite';
process.env.SQLITE_STORAGE = ':memory:';
process.env.DB_ENCRYPTION_KEY = '0'.repeat(64);

const {
  sequelize,
  App,
  ApiDevice,
  ApiSession,
} = require('../src/models/Database');
const {
  buildTrojanConfig,
  parseTrojanUrl,
} = require('../src/services/npanelUserService');
const npanelClient = require('../src/services/npanelClient');
const {
  createAdminToken,
  verifyAdminToken,
} = require('../src/services/authService');
const {
  createChallenge,
  exchangeToken,
  refreshToken,
  canonicalBody,
  hmac,
  sha256,
} = require('../src/services/mobileSecurityService');

test.before(async () => {
  await sequelize.sync({ force: true });
});

test.after(async () => {
  await sequelize.close();
});

test('builds and parses websocket trojan config', () => {
  const server = { domain: 'uist1.tempmail.monster', vpn_port: 443 };
  const user = { name: 'Free1', password: 'secret-pass' };

  const config = buildTrojanConfig(server, user, 'ws');
  assert.equal(config, 'trojan://secret-pass@uist1.tempmail.monster:443?security=tls&type=ws&path=%2Ffetch#Free1');

  const parsed = parseTrojanUrl(config);
  assert.equal(parsed.password, 'secret-pass');
  assert.equal(parsed.host, 'uist1.tempmail.monster');
  assert.equal(parsed.type, 'ws');
  assert.equal(parsed.path, '/fetch');
  assert.equal(parsed.label, 'Free1');
});

test('builds tcp trojan config', () => {
  const config = buildTrojanConfig(
    { domain: 'vpn.example.com', vpn_port: 8443 },
    { name: 'Premium', password: 'p' },
    'tcp',
  );
  assert.equal(config, 'trojan://p@vpn.example.com:8443?security=tls&type=tcp#Premium');
});

test('admin token verifies with hmac signature', () => {
  const token = createAdminToken();
  assert.equal(verifyAdminToken(token), true);
  assert.equal(verifyAdminToken(`${token}x`), false);
});

test('mobile signing primitives are deterministic', () => {
  const body = { event: 'connect_attempt', configId: 1 };
  const bodyHash = sha256(canonicalBody(body));
  const payload = ['POST', '/api/v1/telemetry', '1781352000000', 'nonce-1', bodyHash].join('\n');
  assert.equal(
    hmac('secret', payload),
    hmac('secret', payload),
  );
  assert.notEqual(hmac('secret', payload), hmac('other', payload));
});

test('mobile challenge exchange and refresh rotate session secrets', async () => {
  const deviceId = 'unit-device-ios';
  const app = await App.create({
    name: 'Unit App',
    slug: 'unit-app',
    app_key: 'app_unit_test',
    hmac_secret: 'unit-hmac-secret',
  });
  const challenge = await createChallenge({
    app,
    platform: 'ios',
    deviceId,
    appVersion: '1.0.0',
  });

  const token = await exchangeToken({
    app,
    platform: 'ios',
    deviceId,
    challenge: challenge.challenge,
    attestationToken: 'mock-attestation-token',
  });

  assert.ok(token.accessToken);
  assert.ok(token.refreshToken);
  assert.ok(token.sessionSecret);
  assert.equal(token.refreshExpiresIn, 30 * 24 * 60 * 60);

  const device = await ApiDevice.findOne({ where: { device_id: deviceId } });
  assert.equal(device.session_secret_hash, sha256(token.sessionSecret));

  const originalSession = await ApiSession.findOne({ where: { device_id: device.id } });
  assert.equal(originalSession.revoked_at, null);

  const refreshed = await refreshToken({ app, deviceId, refreshToken: token.refreshToken });
  assert.notEqual(refreshed.accessToken, token.accessToken);
  assert.notEqual(refreshed.refreshToken, token.refreshToken);
  assert.notEqual(refreshed.sessionSecret, token.sessionSecret);

  await originalSession.reload();
  assert.ok(originalSession.revoked_at);

  await assert.rejects(
    () => refreshToken({ app, deviceId, refreshToken: token.refreshToken }),
    /Expired or invalid refresh token/,
  );
});

test('npanel client builds upstream create and update payloads', () => {
  const user = {
    name: 'Free1',
    password: 'secret',
    speed_upload: 4096,
    speed_download: 4096,
    traffic_limit_max: 0,
    ip_limit: 0,
    enabled: true,
    days_left: 0,
    day_limit: false,
    protocol: 1,
    note: 'Auto-created',
  };

  assert.deepEqual(
    npanelClient.buildCreateUserRequest(user, { token: 'tok', key: 7 }),
    {
      token: 'tok',
      req: 'create-user',
      params: ['Free1'],
      specialparam: 'req',
      key: '7',
    },
  );

  assert.deepEqual(
    npanelClient.buildUpdateUserRequest(user, { token: 'tok', key: 8 }).params,
    ['Free1', 'secret', '4096', '4096', '0', '0', '1', '0', '0', '1', 'Auto-created', '-1', '-1'],
  );
});
