const { DataTypes } = require('sequelize');

// Resilience columns for the fail-open attestation path (mobileSecurityService).
// attested_at records the last FULL attestation and drives the re-verification
// throttle: a device that attested within ATTESTATION_REVERIFY_DAYS is trusted on
// re-exchange without another Apple/Google round-trip. The degraded pair records a
// fail-open issuance — a session minted despite the backend being unable to reach
// the attestation provider (a system error, not a genuine device rejection).

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('ApiDevices', 'attested_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('ApiDevices', 'attest_degraded_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('ApiDevices', 'attest_last_error', { type: DataTypes.STRING, allowNull: true });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('ApiDevices', 'attest_last_error');
    await queryInterface.removeColumn('ApiDevices', 'attest_degraded_at');
    await queryInterface.removeColumn('ApiDevices', 'attested_at');
  },
};
