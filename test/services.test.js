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
  buildDefaultUserList,
  effectiveIpLimit,
} = require('../src/services/npanelUserService');
const { normalizeStatus } = require('../src/services/trojanApiService');
const { serializeConfig } = require('../src/services/catalogSerializer');
const {
  computeLoadScore,
  levelFor,
  emaNext,
  isLoadFresh,
  parseSystemStats,
  pickRecommended,
} = require('../src/services/loadMetricsService');
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

test('normalizeStatus parses ip_current/ip_limit tolerantly', () => {
  const snake = normalizeStatus({
    status: {
      user: { hash: 'h1' },
      traffic_total: { upload_traffic: 10, download_traffic: 20 },
      speed_current: { upload_speed: 1, download_speed: 2 },
      speed_limit: { upload_speed: 0, download_speed: 4194304 },
      ip_current: 3,
      ip_limit: 50000,
    },
  });
  assert.deepEqual(snake, {
    hash: 'h1', trafficUp: 10, trafficDown: 20, speedUp: 1, speedDown: 2,
    limitUp: 0, limitDown: 4194304, ipCurrent: 3, ipLimit: 50000,
  });

  const camel = normalizeStatus({
    status: {
      user: { hash: 'h2' },
      trafficTotal: { uploadTraffic: 11, downloadTraffic: 22 },
      speedCurrent: { uploadSpeed: 5, downloadSpeed: 6 },
      ipCurrent: 4,
      ipLimit: 2,
    },
  });
  assert.equal(camel.trafficUp, 11);
  assert.equal(camel.speedDown, 6);
  assert.equal(camel.ipCurrent, 4);
  assert.equal(camel.ipLimit, 2);

  // omitempty: an idle user serializes with everything but the hash absent.
  const idle = normalizeStatus({ status: { user: { hash: 'h3' } } });
  assert.equal(idle.hash, 'h3');
  assert.equal(idle.trafficUp, 0);
  assert.equal(idle.ipCurrent, 0);
  assert.equal(idle.ipLimit, 0);
});

test('effectiveIpLimit: admin limit wins, sentinel only arms unlimited users', () => {
  const cfg = { trackingEnabled: true, sentinel: 50000 };
  assert.equal(effectiveIpLimit(5, cfg), 5); // real limit respected
  assert.equal(effectiveIpLimit(0, cfg), 50000); // unlimited -> sentinel
  assert.equal(effectiveIpLimit(-3, cfg), 50000); // junk -> treated as unlimited
  assert.equal(effectiveIpLimit(0, { trackingEnabled: false, sentinel: 50000 }), 0); // tracking off
});

test('computeLoadScore takes the worst real utilization, clamped', () => {
  // Bandwidth-dominant: 500 Mbit/s of a 1000 Mbps cap.
  assert.equal(computeLoadScore({ throughputBps: 500e6, capacityMbps: 1000, cpuUtilPct: 10 }), 50);
  // CPU-dominant.
  assert.equal(computeLoadScore({ throughputBps: 0, capacityMbps: 1000, cpuUtilPct: 90 }), 90);
  // Concurrent-IP component participates only when a capacity is set.
  assert.equal(computeLoadScore({ throughputBps: 0, capacityMbps: 1000, cpuUtilPct: null, liveIpTotal: 80, maxConcurrentIps: 100 }), 80);
  assert.equal(computeLoadScore({ throughputBps: 0, capacityMbps: 1000, cpuUtilPct: null, liveIpTotal: 80, maxConcurrentIps: null }), 0);
  // Clamp at 100.
  assert.equal(computeLoadScore({ throughputBps: 5e9, capacityMbps: 1000, cpuUtilPct: 0 }), 100);
});

test('levelFor buckets and emaNext smoothing', () => {
  assert.equal(levelFor(40), 'low');
  assert.equal(levelFor(41), 'medium');
  assert.equal(levelFor(70), 'medium');
  assert.equal(levelFor(71), 'high');
  assert.equal(emaNext(null, 50), 50); // first sample seeds
  assert.equal(emaNext(50, 100), 70); // alpha 0.4
  assert.equal(emaNext(70, 100), 82);
});

test('isLoadFresh: 5-minute floor and 3x poll-interval rule', () => {
  const now = Date.now();
  // 60s poll -> horizon is the 5-minute floor.
  assert.equal(isLoadFresh(new Date(now - 4 * 60 * 1000), 60, now), true);
  assert.equal(isLoadFresh(new Date(now - 6 * 60 * 1000), 60, now), false);
  // 300s poll -> horizon is 3x = 15 minutes.
  assert.equal(isLoadFresh(new Date(now - 14 * 60 * 1000), 300, now), true);
  assert.equal(isLoadFresh(new Date(now - 16 * 60 * 1000), 300, now), false);
  assert.equal(isLoadFresh(null, 60, now), false);
});

test('parseSystemStats reads loadavg + nproc output', () => {
  const { load1, cores } = parseSystemStats('0.52 0.58 0.59 1/234 5678\n4\n');
  assert.equal(load1, 0.52);
  assert.equal(cores, 4);
  const empty = parseSystemStats('');
  assert.equal(empty.load1, null);
  assert.equal(empty.cores, null);
});

test('buildDefaultUserList naming preserves legacy idempotency', () => {
  assert.deepEqual(buildDefaultUserList(2, 1), [
    { name: 'Free1', profile_type: 'free' },
    { name: 'Free2', profile_type: 'free' },
    { name: 'Premium', profile_type: 'premium' },
  ]);
  assert.deepEqual(buildDefaultUserList(0, 3).map((u) => u.name), ['Premium', 'Premium2', 'Premium3']);
  assert.deepEqual(buildDefaultUserList(1, 0).map((u) => u.name), ['Free1']);
  assert.deepEqual(buildDefaultUserList(0, 0), []);
});

test('serializeConfig exposes load + recommended additively', () => {
  const item = {
    id: 1,
    display_name: 'Argentina Premium',
    type: 'premium',
    sort_order: 0,
    config: 'trojan://pw@vpn.example.com:443?security=tls&type=ws&path=%2Ffetch#Premium',
    entry_ip: null,
    sni: null,
    recommended: true,
    country: { code: 'AR', name: 'Argentina', flag: 'https://flagcdn.com/w80/ar.png' },
    server: {
      ip: '1.2.3.4',
      domain: 'vpn.example.com',
      vpn_port: 443,
      load_pct: 35,
      load_level: 'low',
      load_updated_at: new Date(),
    },
  };

  const fresh = serializeConfig(item, { loadStaleMs: 5 * 60 * 1000 });
  // Pre-existing contract stays intact.
  assert.equal(fresh.id, 1);
  assert.equal(fresh.type, 'premium');
  assert.equal(fresh.country.code, 'AR');
  assert.equal(fresh.connection.host, '1.2.3.4');
  assert.equal(fresh.connection.port, 443);
  assert.equal(fresh.connection.sni, 'vpn.example.com');
  assert.equal(fresh.connection.transport, 'ws');
  assert.equal(fresh.connection.path, '/fetch');
  // Additive fields.
  assert.equal(fresh.load.pct, 35);
  assert.equal(fresh.load.level, 'low');
  assert.ok(fresh.load.at);
  assert.equal(fresh.recommended, true);

  // Stale load -> null + never recommended.
  const staleItem = { ...item, server: { ...item.server, load_updated_at: new Date(Date.now() - 10 * 60 * 1000) } };
  const stale = serializeConfig(staleItem, { loadStaleMs: 5 * 60 * 1000 });
  assert.equal(stale.load, null);
  assert.equal(stale.recommended, false);

  // Server never polled -> null.
  const unpolled = serializeConfig({ ...item, server: { ip: '1.2.3.4', domain: 'vpn.example.com', vpn_port: 443 } });
  assert.equal(unpolled.load, null);
  assert.equal(unpolled.recommended, false);
});

test('pickRecommended: hysteresis, staleness, and lone-config rules', () => {
  const entry = (id, load, extra = {}) => ({ id, sortOrder: 0, load, fresh: true, healthy: true, recommended: false, ...extra });

  // No incumbent -> lowest load wins.
  assert.equal(pickRecommended([entry(1, 40), entry(2, 30)]), 2);
  // Incumbent survives a challenger within the 8-pt hysteresis band.
  assert.equal(pickRecommended([entry(1, 40, { recommended: true }), entry(2, 34)]), 1);
  // A challenger >= 8 pts lower steals the star.
  assert.equal(pickRecommended([entry(1, 40, { recommended: true }), entry(2, 30)]), 2);
  // Stale incumbent is always replaced.
  assert.equal(pickRecommended([entry(1, 20, { recommended: true, fresh: false }), entry(2, 90)]), 2);
  // Unhealthy (failing config test) candidates never win.
  assert.equal(pickRecommended([entry(1, 10, { healthy: false }), entry(2, 90)]), 2);
  // A lone config has nothing to be recommended over.
  assert.equal(pickRecommended([entry(1, 10)]), null);
  // Everything stale -> nobody recommended.
  assert.equal(pickRecommended([entry(1, 10, { fresh: false }), entry(2, 20, { fresh: false })]), null);
});
