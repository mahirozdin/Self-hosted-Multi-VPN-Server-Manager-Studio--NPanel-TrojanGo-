const { DataTypes } = require('sequelize');

// Ban rules (IP / device_id / firebase_uid) + client-reported premium status on
// devices and connection logs. app_id null = global ban across all apps.

const idCol = { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false };
const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.createTable('BanRules', {
      id: idCol,
      app_id: { type: DataTypes.INTEGER, allowNull: true },
      type: { type: DataTypes.STRING, allowNull: false }, // ip | device_id | firebase_uid
      value: { type: DataTypes.STRING, allowNull: false },
      reason: { type: DataTypes.STRING, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('BanRules', ['type', 'value'], { name: 'ban_rules_type_value' });
    await queryInterface.addIndex('BanRules', ['app_id'], { name: 'ban_rules_app' });

    await queryInterface.addColumn('ConnectionLogs', 'is_premium', { type: DataTypes.BOOLEAN, defaultValue: false });
    await queryInterface.addColumn('ApiDevices', 'is_premium', { type: DataTypes.BOOLEAN, defaultValue: false });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('ApiDevices', 'is_premium');
    await queryInterface.removeColumn('ConnectionLogs', 'is_premium');
    await queryInterface.dropTable('BanRules');
  },
};
