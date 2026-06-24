const { Umzug, SequelizeStorage } = require('umzug');
const { sequelize } = require('../models/Database');

// Single migrator instance shared by the boot path (src/server.js) and the CLI
// (src/migrations/cli.js). Migrations live next to this file as *.migration.js
// and run in filename order (numeric prefix: 0001-, 0002-, ...).
const migrator = new Umzug({
  migrations: {
    glob: ['*.migration.js', { cwd: __dirname }],
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, modelName: 'SequelizeMeta' }),
  logger: console,
});

module.exports = { migrator };
