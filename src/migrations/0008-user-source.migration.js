const { DataTypes } = require('sequelize');

// Distinguish users the panel owns (source='managed' — we hold the password and
// can push/build configs) from ones imported off an existing server's live
// trojan-go set (source='imported' — hash + traffic only, no recoverable
// password, so no config and never pushed). Existing rows are 'managed'.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('NpanelUsers', 'source', {
      type: DataTypes.STRING,
      defaultValue: 'managed', // managed | imported
    });
    await queryInterface.addIndex('NpanelUsers', ['server_id', 'source'], { name: 'npanel_users_server_source' });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeIndex('NpanelUsers', 'npanel_users_server_source');
    await queryInterface.removeColumn('NpanelUsers', 'source');
  },
};
