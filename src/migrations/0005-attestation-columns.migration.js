const { DataTypes } = require('sequelize');

// Runtime attestation state per device. iOS App Attest yields a key id +
// public key (persisted to support future per-request assertions); attest_counter
// reserves room for the App Attest assertion counter.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('ApiDevices', 'attest_key_id', { type: DataTypes.STRING, allowNull: true });
    await queryInterface.addColumn('ApiDevices', 'attest_public_key', { type: DataTypes.TEXT, allowNull: true });
    await queryInterface.addColumn('ApiDevices', 'attest_counter', { type: DataTypes.INTEGER, defaultValue: 0 });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('ApiDevices', 'attest_counter');
    await queryInterface.removeColumn('ApiDevices', 'attest_public_key');
    await queryInterface.removeColumn('ApiDevices', 'attest_key_id');
  },
};
