const { DataTypes } = require('sequelize');

// Multi-tenancy: an App (tenant) per mobile VPN app, an AppCatalogItem join
// deciding which configs each app exposes, and an app_id stamped on the mobile
// auth tables. app_id columns are added nullable for cross-dialect ADD COLUMN
// safety (SQLite forbids NOT NULL ADD COLUMN without a default); the application
// always sets them and the models treat device/session app_id as required.

const idCol = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false };
const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.createTable('Apps', {
      id: idCol,
      name: { type: DataTypes.STRING, allowNull: false },
      slug: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, defaultValue: 'active' },
      app_key: { type: DataTypes.STRING, allowNull: false },
      hmac_secret: { type: DataTypes.STRING(512), allowNull: false },
      ios_bundle_id: { type: DataTypes.STRING, allowNull: true },
      apple_team_id: { type: DataTypes.STRING, allowNull: true },
      apple_attest_env: { type: DataTypes.STRING, defaultValue: 'production' },
      android_package_name: { type: DataTypes.STRING, allowNull: true },
      google_cloud_project_number: { type: DataTypes.STRING, allowNull: true },
      android_min_device_verdict: { type: DataTypes.STRING, defaultValue: 'MEETS_DEVICE_INTEGRITY' },
      play_integrity_sa_ref: { type: DataTypes.STRING, allowNull: true },
      min_supported_version: { type: DataTypes.STRING, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('Apps', ['slug'], { unique: true, name: 'apps_slug_unique' });
    await queryInterface.addIndex('Apps', ['app_key'], { unique: true, name: 'apps_app_key_unique' });

    await queryInterface.createTable('AppCatalogItems', {
      id: idCol,
      app_id: { type: DataTypes.INTEGER, allowNull: false },
      catalog_item_id: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING, defaultValue: 'active' },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      display_name_override: { type: DataTypes.STRING, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('AppCatalogItems', ['app_id', 'catalog_item_id'], {
      unique: true,
      name: 'app_catalog_app_item',
    });
    await queryInterface.addIndex('AppCatalogItems', ['app_id', 'status'], {
      name: 'app_catalog_app_status',
    });

    await queryInterface.addColumn('ApiDevices', 'app_id', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('ApiDevices', 'firebase_uid', { type: DataTypes.STRING, allowNull: true });
    await queryInterface.addIndex('ApiDevices', ['app_id', 'device_id'], {
      unique: true,
      name: 'api_devices_app_device',
    });

    await queryInterface.addColumn('ApiSessions', 'app_id', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('ApiNonces', 'app_id', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('ApiAuditLogs', 'app_id', { type: DataTypes.INTEGER, allowNull: true });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('ApiAuditLogs', 'app_id');
    await queryInterface.removeColumn('ApiNonces', 'app_id');
    await queryInterface.removeColumn('ApiSessions', 'app_id');
    await queryInterface.removeIndex('ApiDevices', 'api_devices_app_device');
    await queryInterface.removeColumn('ApiDevices', 'firebase_uid');
    await queryInterface.removeColumn('ApiDevices', 'app_id');
    await queryInterface.dropTable('AppCatalogItems');
    await queryInterface.dropTable('Apps');
  },
};
