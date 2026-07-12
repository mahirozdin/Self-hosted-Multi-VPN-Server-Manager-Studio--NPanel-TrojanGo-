const { DataTypes } = require('sequelize');

// Real server-load pipeline: per-server rollup of the trojan-go live stats
// (throughput, concurrent client IPs, box CPU) smoothed into a 0-100 load
// score, admin-set capacity inputs, a per-user concurrent-IP counter, and a
// persisted per-(country,type) "recommended" flag the mobile API exposes.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('Servers', 'load_pct', { type: DataTypes.INTEGER, allowNull: true }); // EMA-smoothed 0..100
    await queryInterface.addColumn('Servers', 'load_level', { type: DataTypes.STRING, defaultValue: 'unknown' }); // low|medium|high|unknown
    await queryInterface.addColumn('Servers', 'load_updated_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('Servers', 'live_ip_total', { type: DataTypes.INTEGER, allowNull: true }); // sum of users' ip_current
    await queryInterface.addColumn('Servers', 'throughput_bps', { type: DataTypes.BIGINT, allowNull: true }); // BITS/sec (trojan-go reports bytes/sec; stored ×8)
    await queryInterface.addColumn('Servers', 'cpu_util', { type: DataTypes.INTEGER, allowNull: true }); // pct, load1/nproc
    await queryInterface.addColumn('Servers', 'max_throughput_mbps', { type: DataTypes.INTEGER, allowNull: true }); // capacity input; null = settings default
    await queryInterface.addColumn('Servers', 'max_concurrent_ips', { type: DataTypes.INTEGER, allowNull: true }); // capacity input; null = conn component ignored

    await queryInterface.addColumn('NpanelUsers', 'ip_current', { type: DataTypes.INTEGER, defaultValue: 0 }); // live concurrent client IPs

    await queryInterface.addColumn('VpnCatalogItems', 'recommended', { type: DataTypes.BOOLEAN, defaultValue: false });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('VpnCatalogItems', 'recommended');
    await queryInterface.removeColumn('NpanelUsers', 'ip_current');
    for (const col of ['max_concurrent_ips', 'max_throughput_mbps', 'cpu_util', 'throughput_bps', 'live_ip_total', 'load_updated_at', 'load_level', 'load_pct']) {
      await queryInterface.removeColumn('Servers', col);
    }
  },
};
