const crypto = require('crypto');
const { Op } = require('sequelize');
const { NpanelUser, VpnCatalogItem, Country, ServerGroup } = require('../models/Database');
const trojanApiService = require('./trojanApiService');
const settingsService = require('./settingsService');
const { englishName } = require('./countryNames');

// Per-profile server-side defaults. Free is speed/IP limited (matches the NPanel
// default of 4096 KiB/s we observed live); Premium is unlimited. Traffic caps /
// day limits are gated by the mobile app (free session timer + subscription), so
// we leave trojan-go's traffic_limit at 0 and enforce only speed + ip server-side.
const PROFILE_DEFAULTS = {
  free: {
    protocol: 1,
    speed_upload: 4096,
    speed_download: 4096,
    traffic_limit_max: 0,
    ip_limit: 0, // unlimited devices (free and premium alike)
    days_left: 0,
    day_limit: false,
    enabled: true,
  },
  premium: {
    protocol: 1,
    speed_upload: 0,
    speed_download: 0,
    traffic_limit_max: 0,
    ip_limit: 0,
    days_left: 0,
    day_limit: false,
    enabled: true,
  },
};

// Kept for backward-compatible imports; free profile is the baseline.
const DEFAULT_PROFILE = PROFILE_DEFAULTS.free;

// Build the default user set for provisioning. Naming preserves idempotency
// with servers created before counts were configurable (findOrCreate matches by
// name): free i -> `Free${i}`; premium 1 -> `Premium`, premium i>1 -> `Premium${i}`.
function buildDefaultUserList(freeCount, premiumCount) {
  const users = [];
  for (let i = 1; i <= freeCount; i += 1) {
    users.push({ name: `Free${i}`, profile_type: 'free' });
  }
  for (let i = 1; i <= premiumCount; i += 1) {
    users.push({ name: i === 1 ? 'Premium' : `Premium${i}`, profile_type: 'premium' });
  }
  return users;
}

// Kept for backward-compatible imports — the legacy fixed set.
const DEFAULT_USERS = buildDefaultUserList(2, 1);

// Counts for default-user provisioning: explicit request values win (ints
// 0-10), otherwise the panel Settings defaults. At least one user must result.
async function resolveDefaultCounts({ freeCount, premiumCount } = {}) {
  const clamp = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 10 ? n : fallback;
  };
  const free = clamp(freeCount, await settingsService.getInt('default_free_count', 2));
  const premium = clamp(premiumCount, await settingsService.getInt('default_premium_count', 1));
  if (free + premium < 1) {
    throw new Error('En az 1 varsayılan kullanıcı gerekli (free + premium >= 1)');
  }
  return { free, premium };
}

function profileFor(type) {
  return PROFILE_DEFAULTS[type] || PROFILE_DEFAULTS.free;
}

// Like profileFor, but with the panel-editable limits from Settings applied
// (free/premium speed, free ip_limit). Request fields still override at call
// sites that accept explicit values.
async function profileForFromSettings(type) {
  const base = { ...profileFor(type) };
  if (type === 'premium') {
    const speed = await settingsService.getInt('premium_speed_kib', 0);
    base.speed_upload = speed;
    base.speed_download = speed;
  } else {
    const speed = await settingsService.getInt('free_speed_kib', 4096);
    base.speed_upload = speed;
    base.speed_download = speed;
    base.ip_limit = await settingsService.getInt('free_ip_limit', 0);
  }
  return base;
}

// Effective on-box ip_limit for a pushed user: a real admin limit wins;
// otherwise the measurement sentinel (trojan-go only counts concurrent IPs
// while ip_limit > 0), or 0 when tracking is disabled. The sentinel is never
// persisted on the row — NpanelUser.ip_limit stays the admin-intended value.
function effectiveIpLimit(userIpLimit, { trackingEnabled = false, sentinel = 50000 } = {}) {
  const n = Math.max(0, Number(userIpLimit) || 0);
  if (n > 0) return n;
  return trackingEnabled ? Math.max(1, Number(sentinel) || 50000) : 0;
}

async function ipTrackingConfig() {
  return {
    trackingEnabled: await settingsService.getBool('stats_ip_tracking'),
    sentinel: await settingsService.getInt('stats_ip_limit_sentinel', 50000),
  };
}

function generatePassword() {
  return crypto.randomBytes(12).toString('hex');
}

function encodeFragment(value) {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function buildTrojanConfig(server, user, transport = 'ws') {
  const port = server.vpn_port || 443;
  const password = encodeURIComponent(user.password);
  const label = encodeFragment(user.name);
  if (transport === 'tcp') {
    return `trojan://${password}@${server.domain}:${port}?security=tls&type=tcp#${label}`;
  }
  const path = encodeURIComponent('/fetch');
  return `trojan://${password}@${server.domain}:${port}?security=tls&type=ws&path=${path}#${label}`;
}

function parseTrojanUrl(config) {
  if (!config || !config.trim().startsWith('trojan://')) return null;
  try {
    const url = new URL(config.trim());
    return {
      password: decodeURIComponent(url.username || ''),
      host: url.hostname,
      port: Number(url.port || 443),
      label: decodeURIComponent(url.hash.replace(/^#/, '')) || 'Imported',
      path: url.searchParams.get('path') || '/fetch',
      type: url.searchParams.get('type') || 'ws',
    };
  } catch (error) {
    return null;
  }
}

function serializeUser(user) {
  const row = user.toJSON ? user.toJSON() : { ...user };
  delete row.password;
  // BIGINT columns can surface as strings; normalise for the panel.
  row.traffic_up = Number(row.traffic_up || 0);
  row.traffic_down = Number(row.traffic_down || 0);
  return row;
}

// Write the live trojan-go counters for one applied-sync result onto its row.
async function applyLiveStats(user, applied) {
  if (!applied) return;
  const patch = {
    remote_hash: applied.hash || user.remote_hash,
    remote_status: applied.action === 'error' ? 'trojan_api_error' : 'synced',
    remote_message: applied.message || (applied.action ? `trojan-go user ${applied.action}` : null),
    synced_at: applied.action === 'error' ? user.synced_at : new Date(),
  };
  if (applied.stats) {
    patch.traffic_up = applied.stats.trafficUp;
    patch.traffic_down = applied.stats.trafficDown;
    patch.speed_up_current = applied.stats.speedUp;
    patch.speed_down_current = applied.stats.speedDown;
    patch.ip_current = applied.stats.ipCurrent || 0;
    patch.live_synced_at = new Date();
  }
  await user.update(patch);
}

// Write one live trojan-go listing onto this server's rows (managed + imported,
// matched by hash). Shared by the monitor's traffic refresh and the load poll so
// there is exactly one live-counter write path.
async function foldLiveStatsOntoRows(serverId, liveUsers) {
  const rows = await NpanelUser.findAll({ where: { server_id: serverId } });
  const byHash = new Map((liveUsers || []).map((u) => [u.hash, u]));
  for (const row of rows) {
    const stats = byHash.get(row.remote_hash || trojanApiService.hash(row.password));
    if (!stats) continue;
    await row.update({
      traffic_up: stats.trafficUp,
      traffic_down: stats.trafficDown,
      speed_up_current: stats.speedUp,
      speed_down_current: stats.speedDown,
      ip_current: stats.ipCurrent || 0,
      live_synced_at: new Date(),
    });
  }
}

// Ensure the default users (Free1..N, Premium, Premium2..M) exist with the
// Settings-defined per-type limits + generated configs, then (when remote) push
// them to the box's trojan-go over one SSH connection and record live
// status/traffic. Counts come from options.freeCount/premiumCount, falling back
// to the Settings defaults; reducing counts later never deletes existing users.
async function syncDefaultUsers(server, options = {}) {
  const remote = options.remote !== false;
  const counts = await resolveDefaultCounts(options);
  const profiles = {
    free: await profileForFromSettings('free'),
    premium: await profileForFromSettings('premium'),
  };
  const users = [];

  for (const definition of buildDefaultUserList(counts.free, counts.premium)) {
    const profile = profiles[definition.profile_type] || profiles.free;
    const [user] = await NpanelUser.findOrCreate({
      where: { server_id: server.id, name: definition.name },
      defaults: {
        server_id: server.id,
        name: definition.name,
        profile_type: definition.profile_type,
        password: generatePassword(),
        ...profile,
      },
    });

    await user.update({
      profile_type: definition.profile_type,
      ...profile,
      config_ws: buildTrojanConfig(server, user, 'ws'),
      config_tcp: buildTrojanConfig(server, user, 'tcp'),
      remote_hash: trojanApiService.hash(user.password),
      note: user.note || 'Auto-created by NPanel Manager Studio',
    });

    users.push(user);
  }

  if (remote) {
    await pushUsersToServer(server, users);
  }

  return users;
}

// Reconcile a set of already-persisted NpanelUser rows to the server in one
// connection and fold the live results back onto each row. Only 'managed' users
// (ones we hold the password for) are pushed — 'imported' users have no
// recoverable password and are never written, but they ARE armed with the
// measurement ip_limit sentinel so trojan-go counts their concurrent IPs too.
// This is the single place the effective on-box ip_limit is computed.
async function pushUsersToServer(server, users, options = {}) {
  const cfg = await ipTrackingConfig();
  const managed = users.filter((u) => u.source !== 'imported' && u.password);
  const armHashes = cfg.trackingEnabled
    ? users.filter((u) => u.source === 'imported' && u.remote_hash && u.enabled !== false).map((u) => u.remote_hash)
    : [];
  if (!managed.length && !armHashes.length) return { ok: true, applied: [] };

  // Throwaway desired-state objects: ip_limit carries the EFFECTIVE on-box value
  // (sentinel when unlimited + tracking on); the row's ip_limit column keeps the
  // admin-intended value and must never receive the sentinel.
  const desired = managed.map((u) => ({
    id: u.id,
    name: u.name,
    password: u.password,
    enabled: u.enabled,
    speed_upload: u.speed_upload,
    speed_download: u.speed_download,
    ip_limit: effectiveIpLimit(u.ip_limit, cfg),
  }));
  const result = await trojanApiService.syncServerUsers(server, desired, {
    ...options,
    armHashes,
    armIpLimit: cfg.sentinel,
  });
  const byHash = new Map((result.applied || []).map((a) => [a.hash, a]));
  for (const user of managed) {
    const applied = byHash.get(trojanApiService.hash(user.password));
    if (applied) {
      await applyLiveStats(user, applied);
    } else {
      await user.update({
        remote_status: result.ok ? 'synced' : 'trojan_api_error',
        remote_message: result.error || 'no result returned',
      });
    }
  }
  return result;
}

// Import the server's live trojan-go users into the panel for visibility +
// traffic. Existing NPanel users appear as source='imported' (hash + traffic
// only — their password lives in NPanel's encrypted store and can't be
// recovered, so no config is built and they're never pushed). Managed users we
// already track are refreshed, not duplicated.
async function importLiveUsers(server) {
  const { ok, users, error } = await trojanApiService.fetchLiveUsers(server);
  if (!ok) return { ok: false, error, imported: 0 };

  const existing = await NpanelUser.findAll({ where: { server_id: server.id } });
  const knownByHash = new Map();
  for (const u of existing) {
    knownByHash.set(u.remote_hash || trojanApiService.hash(u.password), u);
  }

  const cfg = await ipTrackingConfig();
  let imported = 0;
  for (const live of users) {
    const known = knownByHash.get(live.hash);
    if (known) {
      // A user we already track (managed or previously imported) — just refresh.
      await known.update({
        traffic_up: live.trafficUp,
        traffic_down: live.trafficDown,
        speed_up_current: live.speedUp,
        speed_down_current: live.speedDown,
        ip_current: live.ipCurrent || 0,
        live_synced_at: new Date(),
        remote_status: known.source === 'imported' ? 'synced' : known.remote_status,
      });
      continue;
    }
    const isPremium = !live.limitDown;
    await NpanelUser.create({
      server_id: server.id,
      name: `imported-${live.hash.slice(0, 8)}`,
      profile_type: isPremium ? 'premium' : 'free',
      password: generatePassword(), // placeholder to satisfy NOT NULL; never pushed
      source: 'imported',
      remote_hash: live.hash,
      speed_upload: Math.round((live.limitUp || 0) / 1024),
      speed_download: Math.round((live.limitDown || 0) / 1024),
      // Store the real on-box limit, but never the measurement sentinel.
      ip_limit: live.ipLimit > 0 && live.ipLimit !== cfg.sentinel ? live.ipLimit : 0,
      ip_current: live.ipCurrent || 0,
      traffic_up: live.trafficUp,
      traffic_down: live.trafficDown,
      speed_up_current: live.speedUp,
      speed_down_current: live.speedDown,
      remote_status: 'synced',
      remote_message: 'Sunucudan içe aktarıldı — şifre NPanel’de, config üretilemez',
      live_synced_at: new Date(),
      enabled: true,
    });
    imported += 1;
    knownByHash.set(live.hash, true);
  }
  return { ok: true, imported, total: users.length };
}

// Adopt a pasted, working trojan:// config as a managed user: extract its
// password so the panel can manage it (push limits, build the catalog config).
async function adoptConfig(server, { name, config, profile_type } = {}) {
  const parsed = parseTrojanUrl(config);
  if (!parsed || !parsed.password) throw new Error('Geçerli bir trojan:// config gerekli');
  const type = profile_type === 'premium' ? 'premium' : 'free';
  const profile = await profileForFromSettings(type);
  const [user] = await NpanelUser.findOrCreate({
    where: { server_id: server.id, name: name || parsed.label || `adopt-${Date.now()}` },
    defaults: {
      server_id: server.id,
      name: name || parsed.label || `adopt-${parsed.password.slice(0, 6)}`,
      profile_type: type,
      password: parsed.password,
      source: 'managed',
      ...profile,
      remote_hash: trojanApiService.hash(parsed.password),
      note: 'Adopted from pasted config',
    },
  });
  await user.update({
    password: parsed.password,
    source: 'managed',
    remote_hash: trojanApiService.hash(parsed.password),
    config_ws: buildTrojanConfig(server, user, 'ws'),
    config_tcp: buildTrojanConfig(server, user, 'tcp'),
  });
  await pushUsersToServer(server, [user]);
  return user;
}

// Create one arbitrary user on a server (panel "Add user" action).
async function createUser(server, input = {}) {
  const type = input.profile_type === 'premium' ? 'premium' : 'free';
  const profile = { ...(await profileForFromSettings(type)) };
  for (const key of ['speed_upload', 'speed_download', 'traffic_limit_max', 'ip_limit', 'days_left', 'protocol']) {
    if (input[key] != null && input[key] !== '') profile[key] = Number(input[key]);
  }
  if (typeof input.enabled === 'boolean') profile.enabled = input.enabled;

  const password = input.password && String(input.password).trim() ? String(input.password).trim() : generatePassword();
  const user = await NpanelUser.create({
    server_id: server.id,
    name: input.name,
    profile_type: type,
    password,
    ...profile,
    note: input.note || 'Created via NPanel Manager Studio',
    remote_hash: trojanApiService.hash(password),
  });
  await user.update({
    config_ws: buildTrojanConfig(server, user, 'ws'),
    config_tcp: buildTrojanConfig(server, user, 'tcp'),
  });
  if (input.remote !== false) await pushUsersToServer(server, [user]);
  return user;
}

// Update limits / profile / password / enabled for one user, then reconcile.
async function updateUser(server, user, input = {}) {
  const previousHash = user.remote_hash || trojanApiService.hash(user.password);
  const patch = {};
  for (const key of ['name', 'note']) {
    if (input[key] != null) patch[key] = input[key];
  }
  for (const key of ['speed_upload', 'speed_download', 'traffic_limit_max', 'ip_limit', 'days_left', 'protocol']) {
    if (input[key] != null && input[key] !== '') patch[key] = Number(input[key]);
  }
  if (input.profile_type === 'free' || input.profile_type === 'premium') patch.profile_type = input.profile_type;
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;

  let passwordChanged = false;
  if (input.password && String(input.password).trim() && String(input.password).trim() !== user.password) {
    patch.password = String(input.password).trim();
    passwordChanged = true;
  } else if (input.regeneratePassword) {
    patch.password = generatePassword();
    passwordChanged = true;
  }

  await user.update(patch);
  if (passwordChanged) {
    await user.update({ remote_hash: trojanApiService.hash(user.password) });
  }
  await user.update({
    config_ws: buildTrojanConfig(server, user, 'ws'),
    config_tcp: buildTrojanConfig(server, user, 'tcp'),
  });

  if (input.remote !== false) {
    const opts = passwordChanged ? { deleteHashes: [previousHash] } : {};
    await pushUsersToServer(server, [user], opts);
  }
  await syncUserConfigsIntoCatalog(user);
  return user;
}

// Remove a user's row + catalog items. Managed users are also removed from the
// box; imported users are only unlinked from the panel (we never delete a real
// NPanel-owned user off trojan-go just because it was hidden from our view).
async function deleteUser(server, user) {
  if (server && user.source !== 'imported') {
    const hash = user.remote_hash || trojanApiService.hash(user.password);
    await trojanApiService.syncServerUsers(server, [], { deleteHashes: [hash] }).catch(() => {});
  }
  await VpnCatalogItem.destroy({ where: { npanel_user_id: user.id } });
  await user.destroy();
  return true;
}

// Keep catalog item configs in sync with a user's current ws config (e.g. after a
// password rotation the trojan:// URI changes).
async function syncUserConfigsIntoCatalog(user) {
  const items = await VpnCatalogItem.findAll({ where: { npanel_user_id: user.id } });
  for (const item of items) {
    await item.update({ config: user.config_ws });
  }
}

// Display names must be unique within a country so a second server's items
// don't collide in the app (e.g. two "Argentina Premium") — clashes get a
// " 2", " 3", … suffix. Items that already carry a display_name are never
// renamed (users may have customized them).
async function uniqueDisplayName(countryId, base, excludeItemId = null) {
  let candidate = base;
  for (let n = 2; ; n += 1) {
    const where = { country_id: countryId, display_name: candidate };
    if (excludeItemId) where.id = { [Op.ne]: excludeItemId };
    const clash = await VpnCatalogItem.findOne({ where });
    if (!clash) return candidate;
    candidate = `${base} ${n}`;
  }
}

async function ensureDefaultCatalog(server, users, countryId, groupId, options = {}) {
  const activate = options.activate === true;
  const results = [];
  for (const user of users) {
    const type = user.profile_type === 'premium' ? 'premium' : 'free';
    const baseName = `${server.name} ${user.name}`;
    const [item] = await VpnCatalogItem.findOrCreate({
      where: {
        server_id: server.id,
        npanel_user_id: user.id,
        type,
      },
      defaults: {
        country_id: countryId,
        group_id: groupId,
        server_id: server.id,
        npanel_user_id: user.id,
        type,
        display_name: await uniqueDisplayName(countryId, baseName),
        config: user.config_ws,
        status: activate ? 'active' : 'draft',
      },
    });

    await item.update({
      country_id: countryId,
      group_id: groupId,
      display_name: item.display_name || await uniqueDisplayName(countryId, baseName, item.id),
      config: user.config_ws,
      ...(activate ? { status: 'active' } : {}),
    });

    results.push(item);
  }
  return results;
}

function inferCountryName(serverName) {
  const parts = String(serverName || '').split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : 'Imported';
}

// flagcdn URL for a 2-letter ISO code; otherwise pass the raw value through so
// the panel can still render a text pill. Keeps auto-created countries showing a
// real flag in the app instead of a bare code.
function flagForCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? `https://flagcdn.com/w80/${c}.png` : (code || 'XX');
}

// Resolve the country a server belongs to. Priority:
//   1. An explicit existing country (countryId) chosen in the panel.
//   2. An explicit new country name (countryName) [+ countryCode], created here.
//   3. Fallback: infer from the server name (legacy "City, Country" convention).
async function resolveCountryForServer(server, { countryId, countryName, countryCode } = {}) {
  if (countryId) {
    const existing = await Country.findByPk(countryId);
    if (existing) return existing;
  }
  // Match an existing country by ISO code first, so picking from the full
  // country list never creates a duplicate of one already in use.
  const code = (countryCode && countryCode.trim().toUpperCase()) || '';
  if (code) {
    const byCode = await Country.findOne({ where: { code } });
    if (byCode) return byCode;
  }
  const rawName = (countryName && countryName.trim()) || inferCountryName(server.name);
  const finalCode = code || rawName.slice(0, 2).toUpperCase() || 'XX';
  // Always store the canonical English name when we have a valid ISO code.
  const name = englishName(finalCode, rawName);
  const [country] = await Country.findOrCreate({
    where: { name },
    defaults: { name, code: finalCode, flag: flagForCode(finalCode) },
  });
  return country;
}

async function ensureCountryAndGroupForServer(server, options = {}) {
  const country = await resolveCountryForServer(server, options);

  // Persist the country link on the server itself so the panel can group by it
  // and the mobile catalog stays consistent even if the name changes.
  if (server.country_id !== country.id) {
    await server.update({ country_id: country.id });
  }

  const [group] = await ServerGroup.findOrCreate({
    where: {
      country_id: country.id,
      parent_id: null,
      name: 'Default',
    },
    defaults: {
      country_id: country.id,
      parent_id: null,
      name: 'Default',
      kind: 'main',
    },
  });

  return { country, group };
}

module.exports = {
  PROFILE_DEFAULTS,
  DEFAULT_PROFILE,
  DEFAULT_USERS,
  profileFor,
  profileForFromSettings,
  buildDefaultUserList,
  resolveDefaultCounts,
  effectiveIpLimit,
  ipTrackingConfig,
  generatePassword,
  buildTrojanConfig,
  parseTrojanUrl,
  serializeUser,
  applyLiveStats,
  foldLiveStatsOntoRows,
  syncDefaultUsers,
  pushUsersToServer,
  importLiveUsers,
  adoptConfig,
  createUser,
  updateUser,
  deleteUser,
  syncUserConfigsIntoCatalog,
  ensureDefaultCatalog,
  uniqueDisplayName,
  ensureCountryAndGroupForServer,
  flagForCode,
};
