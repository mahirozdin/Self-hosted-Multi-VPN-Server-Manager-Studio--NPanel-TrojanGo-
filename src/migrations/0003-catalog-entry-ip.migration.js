const { DataTypes } = require('sequelize');

// entry_ip + sni let a catalog item carry an explicit connect IP / SNI that may
// differ from the trojan URI host (the iOS Leaf engine needs the entry IP
// separately from the SNI). Both fall back to the linked Server when null.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('VpnCatalogItems', 'entry_ip', { type: DataTypes.STRING, allowNull: true });
    await queryInterface.addColumn('VpnCatalogItems', 'sni', { type: DataTypes.STRING, allowNull: true });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('VpnCatalogItems', 'sni');
    await queryInterface.removeColumn('VpnCatalogItems', 'entry_ip');
  },
};
