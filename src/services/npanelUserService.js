const crypto = require('crypto');
const { NpanelUser, VpnCatalogItem, Country, ServerGroup } = require('../models/Database');
const npanelClient = require('./npanelClient');

const DEFAULT_PROFILE = {
  protocol: 1,
  speed_upload: 4096,
  speed_download: 4096,
  traffic_limit_max: 0,
  ip_limit: 0,
  days_left: 0,
  day_limit: false,
  enabled: true,
};

const DEFAULT_USERS = [
  { name: 'Free1', profile_type: 'free' },
  { name: 'Free2', profile_type: 'free' },
  { name: 'Premium', profile_type: 'premium' },
];

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
  const row = user.toJSON ? user.toJSON() : user;
  delete row.password;
  return row;
}

async function syncDefaultUsers(server, options = {}) {
  const remote = options.remote !== false;
  const synced = [];

  for (const definition of DEFAULT_USERS) {
    const [user] = await NpanelUser.findOrCreate({
      where: { server_id: server.id, name: definition.name },
      defaults: {
        server_id: server.id,
        name: definition.name,
        profile_type: definition.profile_type,
        password: generatePassword(),
        ...DEFAULT_PROFILE,
      },
    });

    await user.update({
      profile_type: definition.profile_type,
      ...DEFAULT_PROFILE,
      config_ws: buildTrojanConfig(server, user, 'ws'),
      config_tcp: buildTrojanConfig(server, user, 'tcp'),
      note: 'Auto-created by NPanel Manager Studio',
    });

    if (remote) {
      const remoteResult = await npanelClient.syncUser(server, user);
      await user.update({
        remote_status: remoteResult.ok ? 'synced' : remoteResult.status,
        remote_message: remoteResult.message,
        synced_at: remoteResult.ok ? new Date() : user.synced_at,
      });
    }

    synced.push(user);
  }

  return synced;
}

async function ensureDefaultCatalog(server, users, countryId, groupId) {
  const results = [];
  for (const user of users) {
    const type = user.profile_type === 'premium' ? 'premium' : 'free';
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
        display_name: `${server.name} ${user.name}`,
        config: user.config_ws,
        status: 'draft',
      },
    });

    await item.update({
      country_id: countryId,
      group_id: groupId,
      display_name: item.display_name || `${server.name} ${user.name}`,
      config: user.config_ws,
    });

    results.push(item);
  }
  return results;
}

function inferCountryName(serverName) {
  const parts = String(serverName || '').split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : 'Imported';
}

async function ensureCountryAndGroupForServer(server) {
  const countryName = inferCountryName(server.name);
  const [country] = await Country.findOrCreate({
    where: { name: countryName },
    defaults: {
      name: countryName,
      code: countryName.slice(0, 2).toUpperCase() || 'XX',
      flag: countryName.slice(0, 2).toUpperCase() || 'XX',
    },
  });

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
  DEFAULT_PROFILE,
  DEFAULT_USERS,
  buildTrojanConfig,
  parseTrojanUrl,
  serializeUser,
  syncDefaultUsers,
  ensureDefaultCatalog,
  ensureCountryAndGroupForServer,
};
