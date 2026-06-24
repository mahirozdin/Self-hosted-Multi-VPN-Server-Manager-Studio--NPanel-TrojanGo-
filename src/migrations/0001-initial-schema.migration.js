const { DataTypes } = require('sequelize');

// Initial schema: creates every table that previously existed under the legacy
// sequelize.sync() bootstrap. Mirrors src/models/Database.js exactly, plus the
// composite indexes that bootstrapService used to create by hand. Encrypted
// secret columns (Servers.password/admin_pass, NpanelUsers.password) are widened
// to VARCHAR(512) to hold the "v1:iv:tag:cipher" envelope. No DB-level foreign
// keys (app enforces relationships, matching prior SQLite behaviour).

const idCol = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false };
const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.createTable('Servers', {
      id: idCol,
      name: { type: DataTypes.STRING, allowNull: false },
      ip: { type: DataTypes.STRING, allowNull: false },
      port: { type: DataTypes.INTEGER, defaultValue: 22 },
      vpn_port: { type: DataTypes.INTEGER, defaultValue: 443 },
      username: { type: DataTypes.STRING, defaultValue: 'root' },
      password: { type: DataTypes.STRING(512), allowNull: false },
      domain: { type: DataTypes.STRING, allowNull: false },
      admin_user: { type: DataTypes.STRING, defaultValue: 'Admin' },
      admin_pass: { type: DataTypes.STRING(512), allowNull: true },
      ssl_expiry: { type: DataTypes.DATE, allowNull: true },
      last_ssl_renew: { type: DataTypes.DATE, allowNull: true },
      latency: { type: DataTypes.INTEGER, allowNull: true },
      status: { type: DataTypes.STRING, defaultValue: 'unknown' },
      ssh_status: { type: DataTypes.STRING, defaultValue: 'unknown' },
      trojan_config: { type: DataTypes.TEXT, allowNull: true },
      trojan_latency: { type: DataTypes.INTEGER, allowNull: true },
      trojan_last_error: { type: DataTypes.TEXT, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('ProvisionJobs', {
      id: idCol,
      server_id: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING, defaultValue: 'queued' },
      current_step: { type: DataTypes.STRING, allowNull: true },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('ProvisionSteps', {
      id: idCol,
      job_id: { type: DataTypes.INTEGER, allowNull: false },
      key: { type: DataTypes.STRING, allowNull: false },
      label: { type: DataTypes.STRING, allowNull: false },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      status: { type: DataTypes.STRING, defaultValue: 'pending' },
      stdout: { type: DataTypes.TEXT, allowNull: true },
      stderr: { type: DataTypes.TEXT, allowNull: true },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('NpanelUsers', {
      id: idCol,
      server_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      profile_type: { type: DataTypes.STRING, defaultValue: 'free' },
      password: { type: DataTypes.STRING(512), allowNull: false },
      protocol: { type: DataTypes.INTEGER, defaultValue: 1 },
      speed_upload: { type: DataTypes.INTEGER, defaultValue: 4096 },
      speed_download: { type: DataTypes.INTEGER, defaultValue: 4096 },
      traffic_limit_max: { type: DataTypes.INTEGER, defaultValue: 0 },
      ip_limit: { type: DataTypes.INTEGER, defaultValue: 0 },
      days_left: { type: DataTypes.INTEGER, defaultValue: 0 },
      day_limit: { type: DataTypes.BOOLEAN, defaultValue: false },
      enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      config_ws: { type: DataTypes.TEXT, allowNull: true },
      config_tcp: { type: DataTypes.TEXT, allowNull: true },
      remote_status: { type: DataTypes.STRING, defaultValue: 'desired' },
      remote_message: { type: DataTypes.TEXT, allowNull: true },
      synced_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('NpanelUsers', ['server_id', 'name'], {
      unique: true,
      name: 'npanel_users_server_id_name',
    });

    await queryInterface.createTable('Countries', {
      id: idCol,
      name: { type: DataTypes.STRING, allowNull: false },
      code: { type: DataTypes.STRING, allowNull: false, defaultValue: 'XX' },
      flag: { type: DataTypes.STRING, allowNull: false, defaultValue: 'XX' },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      ...timestamps,
    });
    await queryInterface.addIndex('Countries', ['name'], {
      unique: true,
      name: 'countries_name_unique',
    });

    await queryInterface.createTable('ServerGroups', {
      id: idCol,
      country_id: { type: DataTypes.INTEGER, allowNull: false },
      parent_id: { type: DataTypes.INTEGER, allowNull: true },
      name: { type: DataTypes.STRING, allowNull: false },
      kind: { type: DataTypes.STRING, defaultValue: 'main' },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      ...timestamps,
    });

    await queryInterface.createTable('VpnCatalogItems', {
      id: idCol,
      country_id: { type: DataTypes.INTEGER, allowNull: false },
      group_id: { type: DataTypes.INTEGER, allowNull: true },
      server_id: { type: DataTypes.INTEGER, allowNull: false },
      npanel_user_id: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.STRING, defaultValue: 'free' },
      display_name: { type: DataTypes.STRING, allowNull: false },
      config: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.STRING, defaultValue: 'active' },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      ...timestamps,
    });
    await queryInterface.addIndex('VpnCatalogItems', ['server_id', 'npanel_user_id', 'type'], {
      unique: true,
      name: 'vpn_catalog_server_user_type',
    });
    await queryInterface.addIndex('VpnCatalogItems', ['country_id', 'group_id', 'status'], {
      name: 'vpn_catalog_country_group_status',
    });

    await queryInterface.createTable('ApiDevices', {
      id: idCol,
      device_id: { type: DataTypes.STRING, allowNull: false },
      platform: { type: DataTypes.STRING, allowNull: false },
      attestation_subject: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING, defaultValue: 'active' },
      session_secret_hash: { type: DataTypes.STRING, allowNull: true },
      last_seen_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable('ApiSessions', {
      id: idCol,
      device_id: { type: DataTypes.INTEGER, allowNull: false },
      token_hash: { type: DataTypes.STRING, allowNull: false },
      refresh_token_hash: { type: DataTypes.STRING, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      refresh_expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('ApiSessions', ['device_id', 'token_hash', 'revoked_at'], {
      name: 'api_sessions_device_token_revoked',
    });
    await queryInterface.addIndex('ApiSessions', ['device_id', 'refresh_token_hash', 'revoked_at'], {
      name: 'api_sessions_device_refresh_revoked',
    });

    await queryInterface.createTable('ApiNonces', {
      id: idCol,
      nonce: { type: DataTypes.STRING, allowNull: false, unique: true },
      device_id: { type: DataTypes.STRING, allowNull: true },
      purpose: { type: DataTypes.STRING, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.TEXT, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('ApiNonces', ['device_id', 'purpose', 'expires_at'], {
      name: 'api_nonces_device_purpose_expires',
    });

    await queryInterface.createTable('ApiAuditLogs', {
      id: idCol,
      device_id: { type: DataTypes.STRING, allowNull: true },
      endpoint: { type: DataTypes.STRING, allowNull: false },
      method: { type: DataTypes.STRING, allowNull: false },
      ip: { type: DataTypes.STRING, allowNull: true },
      user_agent: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.INTEGER, allowNull: false },
      detail: { type: DataTypes.TEXT, allowNull: true },
      ...timestamps,
    });
  },

  async down({ context: queryInterface }) {
    await queryInterface.dropTable('ApiAuditLogs');
    await queryInterface.dropTable('ApiNonces');
    await queryInterface.dropTable('ApiSessions');
    await queryInterface.dropTable('ApiDevices');
    await queryInterface.dropTable('VpnCatalogItems');
    await queryInterface.dropTable('ServerGroups');
    await queryInterface.dropTable('Countries');
    await queryInterface.dropTable('NpanelUsers');
    await queryInterface.dropTable('ProvisionSteps');
    await queryInterface.dropTable('ProvisionJobs');
    await queryInterface.dropTable('Servers');
  },
};
