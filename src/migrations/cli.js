// CLI entrypoint for migrations. Loads env so DB credentials are available when
// run standalone (e.g. `npm run migrate`). Exposes up/down/pending/executed via
// Umzug's runAsCLI(), e.g.:
//   npm run migrate            -> apply all pending migrations
//   npm run migrate:status     -> list pending migrations
//   npm run migrate:down       -> revert the last migration
require('dotenv').config();
const { migrator } = require('./umzug');

migrator.runAsCLI();
