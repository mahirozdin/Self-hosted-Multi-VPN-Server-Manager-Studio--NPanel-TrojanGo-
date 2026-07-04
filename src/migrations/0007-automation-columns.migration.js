const { DataTypes } = require('sequelize');

// Automation upgrade: live trojan-go user management, per-server country link +
// trojan-go API address, server health/alert bookkeeping, live traffic counters
// on users, a generic key/value Settings store (panel-editable operational
// config), and a MonitorIncidents table (health history + alert de-dup).

const idCol = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false };
const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

module.exports = {
  async up({ context: queryInterface }) {
    // ---- Server: country link, trojan-go API endpoint, health/alert state ----
    await queryInterface.addColumn('Servers', 'country_id', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('Servers', 'trojan_api_addr', { type: DataTypes.STRING, defaultValue: '127.0.0.1:2061' });
    await queryInterface.addColumn('Servers', 'trojan_binary_path', { type: DataTypes.STRING, allowNull: true });
    await queryInterface.addColumn('Servers', 'health_status', { type: DataTypes.STRING, defaultValue: 'unknown' });
    await queryInterface.addColumn('Servers', 'last_health_ok_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('Servers', 'last_incident_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('Servers', 'last_alert_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('Servers', 'auto_publish', { type: DataTypes.BOOLEAN, defaultValue: false });
    await queryInterface.addIndex('Servers', ['country_id'], { name: 'servers_country' });

    // ---- NpanelUser: live traffic + current speed pulled from trojan-go API ----
    await queryInterface.addColumn('NpanelUsers', 'traffic_up', { type: DataTypes.BIGINT, defaultValue: 0 });
    await queryInterface.addColumn('NpanelUsers', 'traffic_down', { type: DataTypes.BIGINT, defaultValue: 0 });
    await queryInterface.addColumn('NpanelUsers', 'speed_up_current', { type: DataTypes.INTEGER, defaultValue: 0 });
    await queryInterface.addColumn('NpanelUsers', 'speed_down_current', { type: DataTypes.INTEGER, defaultValue: 0 });
    await queryInterface.addColumn('NpanelUsers', 'live_synced_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('NpanelUsers', 'remote_hash', { type: DataTypes.STRING, allowNull: true });

    // ---- Settings: panel-editable operational config (non-secret) ----
    await queryInterface.createTable('Settings', {
      id: idCol,
      key: { type: DataTypes.STRING, allowNull: false, unique: true },
      value: { type: DataTypes.TEXT, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('Settings', ['key'], { name: 'settings_key', unique: true });

    // ---- MonitorIncidents: health history + alert de-duplication ----
    await queryInterface.createTable('MonitorIncidents', {
      id: idCol,
      server_id: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false }, // vpn | ssh | trojan | cert
      status: { type: DataTypes.STRING, defaultValue: 'open' }, // open | resolved
      message: { type: DataTypes.TEXT, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: false },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      notified: { type: DataTypes.BOOLEAN, defaultValue: false },
      ...timestamps,
    });
    await queryInterface.addIndex('MonitorIncidents', ['server_id', 'kind', 'status'], { name: 'incidents_server_kind_status' });
    await queryInterface.addIndex('MonitorIncidents', ['status'], { name: 'incidents_status' });
  },

  async down({ context: queryInterface }) {
    await queryInterface.dropTable('MonitorIncidents');
    await queryInterface.dropTable('Settings');
    for (const col of ['remote_hash', 'live_synced_at', 'speed_down_current', 'speed_up_current', 'traffic_down', 'traffic_up']) {
      await queryInterface.removeColumn('NpanelUsers', col);
    }
    await queryInterface.removeIndex('Servers', 'servers_country');
    for (const col of ['auto_publish', 'last_alert_at', 'last_incident_at', 'last_health_ok_at', 'health_status', 'trojan_binary_path', 'trojan_api_addr', 'country_id']) {
      await queryInterface.removeColumn('Servers', col);
    }
  },
};
