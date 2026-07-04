const { VpnCatalogItem, AppCatalogItem } = require('../models/Database');
const settingsService = require('./settingsService');

// Publish a server's configs to the mobile API: activate its catalog items and
// (when an app is chosen) assign them to that app so /v1/configs surfaces them.
//   appId undefined/null → resolve the default app from Settings.default_app_id
//   appId false          → activate only, assign to no app
async function publishServerCatalog(server, { appId, activate = true } = {}) {
  const items = await VpnCatalogItem.findAll({ where: { server_id: server.id } });
  if (activate) {
    await VpnCatalogItem.update({ status: 'active' }, { where: { server_id: server.id } });
    for (const it of items) it.status = 'active';
  }

  let resolvedAppId = appId;
  if (resolvedAppId == null) {
    const fromSettings = await settingsService.get('default_app_id', '');
    resolvedAppId = fromSettings ? Number(fromSettings) : null;
  }
  if (resolvedAppId) {
    for (const item of items) {
      await AppCatalogItem.findOrCreate({
        where: { app_id: resolvedAppId, catalog_item_id: item.id },
        defaults: { app_id: resolvedAppId, catalog_item_id: item.id, status: 'active', sort_order: item.sort_order || 0 },
      });
    }
  }
  return { items, appId: resolvedAppId || null };
}

module.exports = { publishServerCatalog };
