const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');
const { encryptedAttr } = require('../services/cryptoService');

// Dialect is env-driven: MySQL in production, SQLite for the test suite
// (set DB_DIALECT=sqlite). Production schema is owned by the Umzug migrations
// in src/migrations/, NOT by sequelize.sync().
const DB_DIALECT = process.env.DB_DIALECT || 'mysql';

let sequelize;
if (DB_DIALECT === 'sqlite') {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.SQLITE_STORAGE || path.join(__dirname, '../../database.sqlite'),
    logging: false,
  });
} else {
  sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      dialect: 'mysql',
      logging: false,
      // Pool sizing is env-tunable for scale: at high request volume the default
      // max of 10 against a remote MySQL becomes the throughput ceiling. Raise
      // DB_POOL_MAX in tandem with the server's mysqld max_connections.
      pool: {
        max: Number(process.env.DB_POOL_MAX || 10),
        min: Number(process.env.DB_POOL_MIN || 0),
        acquire: Number(process.env.DB_POOL_ACQUIRE || 30000),
        idle: Number(process.env.DB_POOL_IDLE || 10000),
      },
      define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
      dialectOptions: { charset: 'utf8mb4' },
      timezone: '+00:00',
    },
  );
}

const Server = sequelize.define('Server', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  ip: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  port: {
    type: DataTypes.INTEGER,
    defaultValue: 22,
  },
  vpn_port: {
    type: DataTypes.INTEGER,
    defaultValue: 443,
  },
  username: {
    type: DataTypes.STRING,
    defaultValue: 'root',
  },
  password: encryptedAttr(DataTypes, 'password', { allowNull: false }),
  domain: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  admin_user: {
    type: DataTypes.STRING,
    defaultValue: 'Admin',
  },
  admin_pass: encryptedAttr(DataTypes, 'admin_pass', { defaultValue: 'ChangeMe123!' }),
  ssl_expiry: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_ssl_renew: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  latency: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'unknown', // online, error, installing
  },
  ssh_status: {
    type: DataTypes.STRING,
    defaultValue: 'unknown', // ok, error
  },
  trojan_config: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  trojan_latency: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  trojan_last_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Country this node belongs to (drives the country-grouped panel + mobile
  // catalog). Nullable for legacy rows; set on add/install.
  country_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // localhost address of the trojan-go gRPC API on the box (NPanel default 2061).
  // We manage users through it over SSH — see services/trojanApiService.js.
  trojan_api_addr: {
    type: DataTypes.STRING,
    defaultValue: '127.0.0.1:2061',
  },
  // Path to the on-box trojan-go binary (auto-detected; NPanel: /opt/Npanel/linux/trojan-go).
  trojan_binary_path: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Combined health verdict from the monitor: online | degraded | offline | unknown.
  health_status: {
    type: DataTypes.STRING,
    defaultValue: 'unknown',
  },
  last_health_ok_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_incident_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_alert_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // When true, this server's configs are auto-activated + assigned to the
  // default app on provision so they surface in the mobile API with no clicks.
  auto_publish: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Live load rollup, refreshed by loadMetricsService each poll. load_pct is the
  // EMA-smoothed 0-100 score = max(bandwidth%, cpu%, concurrent-IP% when capped).
  load_pct: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  load_level: {
    type: DataTypes.STRING, // low | medium | high | unknown
    defaultValue: 'unknown',
  },
  load_updated_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  live_ip_total: {
    type: DataTypes.INTEGER, // sum of users' ip_current (distinct client IPs)
    allowNull: true,
  },
  throughput_bps: {
    type: DataTypes.BIGINT, // BITS/sec — trojan-go reports bytes/sec, stored ×8
    allowNull: true,
  },
  cpu_util: {
    type: DataTypes.INTEGER, // pct, load1/nproc
    allowNull: true,
  },
  // Capacity inputs for the load score. Bandwidth falls back to the
  // default_server_bandwidth_mbps setting; a null IP cap disables that component.
  max_throughput_mbps: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  max_concurrent_ips: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
});

const ProvisionJob = sequelize.define('ProvisionJob', {
  server_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'queued',
  },
  current_step: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  finished_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
});

const ProvisionStep = sequelize.define('ProvisionStep', {
  job_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  key: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  label: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  sort_order: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'pending',
  },
  stdout: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  stderr: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  finished_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
});

const NpanelUser = sequelize.define('NpanelUser', {
  server_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  profile_type: {
    type: DataTypes.STRING,
    defaultValue: 'free',
  },
  password: encryptedAttr(DataTypes, 'password', { allowNull: false }),
  protocol: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  speed_upload: {
    type: DataTypes.INTEGER,
    defaultValue: 4096,
  },
  speed_download: {
    type: DataTypes.INTEGER,
    defaultValue: 4096,
  },
  traffic_limit_max: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  ip_limit: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  days_left: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  day_limit: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  note: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  config_ws: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  config_tcp: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  remote_status: {
    type: DataTypes.STRING,
    defaultValue: 'desired',
  },
  remote_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  synced_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Live counters pulled from the trojan-go API (bytes; BIGINT — traffic can
  // exceed 2^31). speed_*_current is the instantaneous rate in bytes/sec.
  traffic_up: {
    type: DataTypes.BIGINT,
    defaultValue: 0,
  },
  traffic_down: {
    type: DataTypes.BIGINT,
    defaultValue: 0,
  },
  speed_up_current: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  speed_down_current: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  // Distinct client IPs currently connected as this trojan-go user. Only counted
  // on-box while ip_limit > 0 — the panel arms a high sentinel for that; the
  // sentinel is never stored here (ip_limit stays the admin-intended value).
  ip_current: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  live_synced_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // hex(SHA224(password)) — the trojan-go user identity. Cached so we can
  // correlate live API stats and target modify/delete without the password.
  remote_hash: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // 'managed' = we own the password (can push + build a config);
  // 'imported' = discovered on the server's live trojan-go set (hash + traffic
  // only, no recoverable password → no config, never pushed).
  source: {
    type: DataTypes.STRING,
    defaultValue: 'managed',
  },
});

const Country = sequelize.define('Country', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  code: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'XX',
  },
  flag: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'XX',
  },
  sort_order: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
}, {
  indexes: [
    { unique: true, fields: ['name'] },
  ],
});

const ServerGroup = sequelize.define('ServerGroup', {
  country_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  parent_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  kind: {
    type: DataTypes.STRING,
    defaultValue: 'main',
  },
  sort_order: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
});

const VpnCatalogItem = sequelize.define('VpnCatalogItem', {
  country_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  group_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  server_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  npanel_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  type: {
    type: DataTypes.STRING,
    defaultValue: 'free',
  },
  display_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  config: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  entry_ip: {
    // The real connect IP for iOS (Leaf needs it separate from the SNI/domain).
    // Falls back to the linked Server.ip when null.
    type: DataTypes.STRING,
    allowNull: true,
  },
  sni: {
    // TLS SNI / WS host. Falls back to the linked Server.domain when null.
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'active',
  },
  sort_order: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  // Real-tunnel health test results (does the published config actually work).
  last_test_at: { type: DataTypes.DATE, allowNull: true },
  last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },
  last_test_error: { type: DataTypes.TEXT, allowNull: true },
  test_latency: { type: DataTypes.INTEGER, allowNull: true }, // last measured ms
  latency_avg: { type: DataTypes.INTEGER, allowNull: true },
  latency_min: { type: DataTypes.INTEGER, allowNull: true },
  latency_max: { type: DataTypes.INTEGER, allowNull: true },
  test_samples: { type: DataTypes.TEXT, allowNull: true }, // JSON [{ok, ms, at}] last 10
  // Panel's least-loaded pick within this item's (country, type) group, refreshed
  // with hysteresis by loadMetricsService; exposed to mobile as `recommended`.
  recommended: { type: DataTypes.BOOLEAN, defaultValue: false },
});

// Tenant: each mobile VPN app served by this backend is one App.
const App = sequelize.define('App', {
  name: { type: DataTypes.STRING, allowNull: false },
  slug: { type: DataTypes.STRING, allowNull: false, unique: true },
  status: { type: DataTypes.STRING, defaultValue: 'active' }, // active | disabled
  // Mobile API credentials
  app_key: { type: DataTypes.STRING, allowNull: false, unique: true }, // public id sent as X-App-Key
  hmac_secret: encryptedAttr(DataTypes, 'hmac_secret', { allowNull: false }), // encrypted at rest
  // Attestation config (used by the Faz 4 security layer)
  ios_bundle_id: { type: DataTypes.STRING, allowNull: true },
  apple_team_id: { type: DataTypes.STRING, allowNull: true },
  apple_attest_env: { type: DataTypes.STRING, defaultValue: 'production' }, // production | development
  android_package_name: { type: DataTypes.STRING, allowNull: true },
  google_cloud_project_number: { type: DataTypes.STRING, allowNull: true },
  android_min_device_verdict: { type: DataTypes.STRING, defaultValue: 'MEETS_DEVICE_INTEGRITY' },
  play_integrity_sa_ref: { type: DataTypes.STRING, allowNull: true }, // filename key into SA dir
  min_supported_version: { type: DataTypes.STRING, allowNull: true }, // force-update gate
});

// Which catalog items (configs) each app exposes — many-to-many join.
const AppCatalogItem = sequelize.define('AppCatalogItem', {
  app_id: { type: DataTypes.INTEGER, allowNull: false },
  catalog_item_id: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'active' }, // active | hidden
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  display_name_override: { type: DataTypes.STRING, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['app_id', 'catalog_item_id'], name: 'app_catalog_app_item' },
    { fields: ['app_id', 'status'], name: 'app_catalog_app_status' },
  ],
});

const ApiDevice = sequelize.define('ApiDevice', {
  app_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  device_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  firebase_uid: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  platform: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  attestation_subject: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'active',
  },
  session_secret_hash: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  last_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  attest_key_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  attest_public_key: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  attest_counter: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  is_premium: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  indexes: [
    { unique: true, fields: ['app_id', 'device_id'], name: 'api_devices_app_device' },
  ],
});

const ApiSession = sequelize.define('ApiSession', {
  app_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  device_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  token_hash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  refresh_token_hash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  refresh_expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  revoked_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  indexes: [
    { fields: ['device_id', 'token_hash', 'revoked_at'] },
    { fields: ['device_id', 'refresh_token_hash', 'revoked_at'] },
  ],
});

const ApiNonce = sequelize.define('ApiNonce', {
  app_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  nonce: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  device_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  purpose: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  used_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  indexes: [
    { fields: ['device_id', 'purpose', 'expires_at'] },
    { fields: ['expires_at'], name: 'api_nonces_expires' }, // hot purge predicate (migration 0011)
  ],
});

const ApiAuditLog = sequelize.define('ApiAuditLog', {
  app_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  device_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  endpoint: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  method: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  ip: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  user_agent: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  detail: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  indexes: [
    { fields: ['createdAt'], name: 'api_audit_logs_created' }, // hot purge predicate (migration 0011)
  ],
});

// Legal connection record: who (device_id + firebase_uid) connected from which
// real IP (client_ip) to which server, and for how long.
const ConnectionLog = sequelize.define('ConnectionLog', {
  log_token: { type: DataTypes.STRING, allowNull: false },
  app_id: { type: DataTypes.INTEGER, allowNull: false },
  device_id: { type: DataTypes.STRING, allowNull: false },
  firebase_uid: { type: DataTypes.STRING, allowNull: true },
  client_ip: { type: DataTypes.STRING, allowNull: false },
  server_id: { type: DataTypes.INTEGER, allowNull: true },
  entry_ip: { type: DataTypes.STRING, allowNull: true },
  catalog_item_id: { type: DataTypes.INTEGER, allowNull: true },
  config_type: { type: DataTypes.STRING, allowNull: true },
  connect_at: { type: DataTypes.DATE, allowNull: false },
  disconnect_at: { type: DataTypes.DATE, allowNull: true },
  duration_seconds: { type: DataTypes.INTEGER, allowNull: true },
  platform: { type: DataTypes.STRING, allowNull: true },
  app_version: { type: DataTypes.STRING, allowNull: true },
  closed_reason: { type: DataTypes.STRING, allowNull: true }, // client | timeout
  is_premium: { type: DataTypes.BOOLEAN, defaultValue: false }, // client-reported at connect
}, {
  indexes: [
    { unique: true, fields: ['log_token'], name: 'connection_logs_token' },
    { fields: ['firebase_uid'], name: 'connection_logs_firebase_uid' },
    { fields: ['client_ip'], name: 'connection_logs_client_ip' },
    { fields: ['app_id', 'device_id'], name: 'connection_logs_app_device' },
    { fields: ['connect_at'], name: 'connection_logs_connect_at' },
    { fields: ['app_id', 'connect_at'], name: 'connection_logs_app_connect' },
  ],
});

Server.hasMany(ProvisionJob, { foreignKey: 'server_id', as: 'provision_jobs' });
ProvisionJob.belongsTo(Server, { foreignKey: 'server_id', as: 'server' });
ProvisionJob.hasMany(ProvisionStep, { foreignKey: 'job_id', as: 'steps' });
ProvisionStep.belongsTo(ProvisionJob, { foreignKey: 'job_id', as: 'job' });

Server.hasMany(NpanelUser, { foreignKey: 'server_id', as: 'npanel_users' });
NpanelUser.belongsTo(Server, { foreignKey: 'server_id', as: 'server' });

Country.hasMany(ServerGroup, { foreignKey: 'country_id', as: 'groups' });
ServerGroup.belongsTo(Country, { foreignKey: 'country_id', as: 'country' });
ServerGroup.belongsTo(ServerGroup, { foreignKey: 'parent_id', as: 'parent' });
ServerGroup.hasMany(ServerGroup, { foreignKey: 'parent_id', as: 'children' });

Country.hasMany(VpnCatalogItem, { foreignKey: 'country_id', as: 'catalog_items' });
ServerGroup.hasMany(VpnCatalogItem, { foreignKey: 'group_id', as: 'catalog_items' });
Server.hasMany(VpnCatalogItem, { foreignKey: 'server_id', as: 'catalog_items' });
NpanelUser.hasMany(VpnCatalogItem, { foreignKey: 'npanel_user_id', as: 'catalog_items' });
VpnCatalogItem.belongsTo(Country, { foreignKey: 'country_id', as: 'country' });
VpnCatalogItem.belongsTo(ServerGroup, { foreignKey: 'group_id', as: 'group' });
VpnCatalogItem.belongsTo(Server, { foreignKey: 'server_id', as: 'server' });
VpnCatalogItem.belongsTo(NpanelUser, { foreignKey: 'npanel_user_id', as: 'npanel_user' });

ApiDevice.hasMany(ApiSession, { foreignKey: 'device_id', as: 'sessions' });
ApiSession.belongsTo(ApiDevice, { foreignKey: 'device_id', as: 'device' });

// Tenancy: an App exposes many catalog items (many-to-many via AppCatalogItem),
// and owns the devices/sessions registered under it.
App.belongsToMany(VpnCatalogItem, { through: AppCatalogItem, foreignKey: 'app_id', otherKey: 'catalog_item_id', as: 'catalog_items' });
VpnCatalogItem.belongsToMany(App, { through: AppCatalogItem, foreignKey: 'catalog_item_id', otherKey: 'app_id', as: 'apps' });
App.hasMany(ApiDevice, { foreignKey: 'app_id', as: 'devices' });
ApiDevice.belongsTo(App, { foreignKey: 'app_id', as: 'app' });

// Panel-editable operational config (non-secret): alert recipient, default user
// limits, default app for auto-publish, monitor thresholds. SMTP creds stay in
// env. Read/written through services/settingsService.js.
const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false, unique: true },
  value: { type: DataTypes.TEXT, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['key'], name: 'settings_key' },
  ],
});

// Health incident: one open row per (server, kind) while a check is failing,
// resolved when it recovers. Drives alert de-dup and the health history view.
const MonitorIncident = sequelize.define('MonitorIncident', {
  server_id: { type: DataTypes.INTEGER, allowNull: false },
  kind: { type: DataTypes.STRING, allowNull: false }, // vpn | ssh | trojan | cert | config | load
  catalog_item_id: { type: DataTypes.INTEGER, allowNull: true }, // set for kind='config'
  status: { type: DataTypes.STRING, defaultValue: 'open' }, // open | resolved
  message: { type: DataTypes.TEXT, allowNull: true },
  started_at: { type: DataTypes.DATE, allowNull: false },
  resolved_at: { type: DataTypes.DATE, allowNull: true },
  notified: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  indexes: [
    { fields: ['server_id', 'kind', 'status'], name: 'incidents_server_kind_status' },
    { fields: ['status'], name: 'incidents_status' },
  ],
});

Country.hasMany(Server, { foreignKey: 'country_id', as: 'servers' });
Server.belongsTo(Country, { foreignKey: 'country_id', as: 'country' });
Server.hasMany(MonitorIncident, { foreignKey: 'server_id', as: 'incidents' });
MonitorIncident.belongsTo(Server, { foreignKey: 'server_id', as: 'server' });

// Ban rules: type ip|device_id|firebase_uid, value, optional reason.
// app_id null = global (all apps); set = that app only.
const BanRule = sequelize.define('BanRule', {
  app_id: { type: DataTypes.INTEGER, allowNull: true },
  type: { type: DataTypes.STRING, allowNull: false },
  value: { type: DataTypes.STRING, allowNull: false },
  reason: { type: DataTypes.STRING, allowNull: true },
}, {
  indexes: [
    { fields: ['type', 'value'], name: 'ban_rules_type_value' },
    { fields: ['app_id'], name: 'ban_rules_app' },
  ],
});

module.exports = {
  sequelize,
  App,
  AppCatalogItem,
  BanRule,
  Server,
  ProvisionJob,
  ProvisionStep,
  NpanelUser,
  Country,
  ServerGroup,
  VpnCatalogItem,
  ApiDevice,
  ApiSession,
  ApiNonce,
  ApiAuditLog,
  ConnectionLog,
  Setting,
  MonitorIncident,
};
