const { DataTypes } = require('sequelize'); // eslint-disable-line no-unused-vars

// Indexes for the two highest-volume tables' purge predicates. At 1M users
// ApiNonces (one row per signed request) and ApiAuditLogs (one row per request)
// dominate write volume; their periodic cleanup deletes by expires_at /
// createdAt, which without a leading index full-scans and locks/bloats while
// the request path is hammering the same tables.

module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addIndex('ApiNonces', ['expires_at'], { name: 'api_nonces_expires' });
    await queryInterface.addIndex('ApiAuditLogs', ['createdAt'], { name: 'api_audit_logs_created' });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeIndex('ApiAuditLogs', 'api_audit_logs_created');
    await queryInterface.removeIndex('ApiNonces', 'api_nonces_expires');
  },
};
