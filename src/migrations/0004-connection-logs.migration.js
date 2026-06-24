const { DataTypes } = require('sequelize');

// Connection session log — the legal record of who connected from which IP to
// which server, and for how long. Indexed for admin search by firebase_uid, IP,
// device, and date range. entry_ip/config_type are denormalized so a log stays
// meaningful even after its server/catalog item is deleted.

const idCol = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false };
const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.createTable('ConnectionLogs', {
      id: idCol,
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
      closed_reason: { type: DataTypes.STRING, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('ConnectionLogs', ['log_token'], { unique: true, name: 'connection_logs_token' });
    await queryInterface.addIndex('ConnectionLogs', ['firebase_uid'], { name: 'connection_logs_firebase_uid' });
    await queryInterface.addIndex('ConnectionLogs', ['client_ip'], { name: 'connection_logs_client_ip' });
    await queryInterface.addIndex('ConnectionLogs', ['app_id', 'device_id'], { name: 'connection_logs_app_device' });
    await queryInterface.addIndex('ConnectionLogs', ['connect_at'], { name: 'connection_logs_connect_at' });
    await queryInterface.addIndex('ConnectionLogs', ['app_id', 'connect_at'], { name: 'connection_logs_app_connect' });
  },

  async down({ context: queryInterface }) {
    await queryInterface.dropTable('ConnectionLogs');
  },
};
