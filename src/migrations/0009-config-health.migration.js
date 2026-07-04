const { DataTypes } = require('sequelize');

// Per-config health: results of the real trojan-tunnel test (does the published
// config actually connect + carry traffic), latency history (last 10 samples,
// avg/min/max), and a catalog_item_id on incidents so a failing config is
// tracked/alerted independently of its server.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('VpnCatalogItems', 'last_test_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'last_test_ok', { type: DataTypes.BOOLEAN, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'last_test_error', { type: DataTypes.TEXT, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'test_latency', { type: DataTypes.INTEGER, allowNull: true }); // last, ms
    await queryInterface.addColumn('VpnCatalogItems', 'latency_avg', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'latency_min', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'latency_max', { type: DataTypes.INTEGER, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'test_samples', { type: DataTypes.TEXT, allowNull: true }); // JSON [{ok,ms,at}]

    await queryInterface.addColumn('MonitorIncidents', 'catalog_item_id', { type: DataTypes.INTEGER, allowNull: true });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('MonitorIncidents', 'catalog_item_id');
    for (const col of ['test_samples', 'latency_max', 'latency_min', 'latency_avg', 'test_latency', 'last_test_error', 'last_test_ok', 'last_test_at']) {
      await queryInterface.removeColumn('VpnCatalogItems', col);
    }
  },
};
