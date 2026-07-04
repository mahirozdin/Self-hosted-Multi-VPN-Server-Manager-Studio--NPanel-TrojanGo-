const { parseTrojanUrl } = require('./npanelUserService');
const { englishName } = require('./countryNames');

// Single mapper from a VpnCatalogItem (with country + server included) to the
// clean mobile config shape. Critically exposes connection.host = the entry IP
// (distinct from the SNI) so iOS can dial the IP while presenting the domain as
// SNI; Android uses connection.uri directly.
function serializeConfig(item) {
  const parsed = parseTrojanUrl(item.config) || {};
  const server = item.server || null;
  const country = item.country || null;
  return {
    id: item.id,
    displayName: item.display_name,
    type: item.type, // free | premium
    sortOrder: item.sort_order,
    country: country
      ? { name: englishName(country.code, country.name), code: country.code, flag: country.flag }
      : null,
    connection: {
      uri: item.config, // full trojan:// URI (Android parses this directly)
      host: item.entry_ip || (server ? server.ip : null), // entry IP for iOS
      port: (server && server.vpn_port) || parsed.port || 443,
      sni: item.sni || (server ? server.domain : parsed.host) || null,
      transport: parsed.type || 'ws',
      path: parsed.path || null,
    },
  };
}

module.exports = { serializeConfig };
