const { parseTrojanUrl } = require('./npanelUserService');
const { englishName } = require('./countryNames');

const DEFAULT_LOAD_STALE_MS = 5 * 60 * 1000;

// Live-load block for one config's server, or null when the panel has no fresh
// data (never polled, or older than the staleness horizon) — the app hides the
// indicator on null instead of showing a dead number.
function loadInfo(server, { loadStaleMs = DEFAULT_LOAD_STALE_MS, now = Date.now() } = {}) {
  if (!server || server.load_pct == null || !server.load_updated_at) return null;
  const at = new Date(server.load_updated_at).getTime();
  if (!Number.isFinite(at) || now - at > loadStaleMs) return null;
  return {
    pct: Number(server.load_pct),
    level: server.load_level && server.load_level !== 'unknown' ? server.load_level : 'low',
    at: new Date(at).toISOString(),
  };
}

// Single mapper from a VpnCatalogItem (with country + server included) to the
// clean mobile config shape. Critically exposes connection.host = the entry IP
// (distinct from the SNI) so iOS can dial the IP while presenting the domain as
// SNI; Android uses connection.uri directly.
//
// `load` and `recommended` are ADDITIVE (2026-07): older app builds ignore
// them; everything that existed before must stay byte-identical.
function serializeConfig(item, options = {}) {
  const parsed = parseTrojanUrl(item.config) || {};
  const server = item.server || null;
  const country = item.country || null;
  const load = loadInfo(server, options);
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
    load, // { pct, level, at } | null
    recommended: Boolean(item.recommended) && load != null, // stale load never recommends
  };
}

module.exports = { serializeConfig, loadInfo };
