const crypto = require('crypto');
const { Op } = require('sequelize');
const { ConnectionLog, VpnCatalogItem, Server, ApiNonce, ApiAuditLog } = require('../models/Database');
const { getClientIp } = require('./clientIpService');

// Session-based connection logging for legal/court-order lookups. Duration is
// always computed server-side on stop (never trust a client-reported duration).

async function startLog(req, { configId, platform, appVersion, firebaseUid, isPremium } = {}) {
  const app = req.app_tenant;
  const device = req.mobileDevice; // set by mobileAuthMiddleware

  let serverId = null;
  let entryIp = null;
  let configType = null;
  let catalogItemId = null;
  if (configId) {
    const item = await VpnCatalogItem.findByPk(configId, { include: [{ model: Server, as: 'server' }] });
    if (item) {
      catalogItemId = item.id;
      configType = item.type;
      serverId = item.server_id;
      entryIp = item.entry_ip || (item.server ? item.server.ip : null);
    }
  }

  return ConnectionLog.create({
    log_token: crypto.randomBytes(24).toString('base64url'),
    app_id: app.id,
    device_id: device ? device.device_id : (req.headers['x-device-id'] || 'unknown'),
    firebase_uid: firebaseUid || (device ? device.firebase_uid : null) || null,
    client_ip: getClientIp(req),
    server_id: serverId,
    entry_ip: entryIp,
    catalog_item_id: catalogItemId,
    config_type: configType,
    connect_at: new Date(),
    platform: platform || (device ? device.platform : null),
    app_version: appVersion || null,
    is_premium: (device && device.is_premium) || isPremium || false,
  });
}

async function stopLog(req, { logId } = {}) {
  const app = req.app_tenant;
  const device = req.mobileDevice;

  const log = await ConnectionLog.findOne({ where: { log_token: logId, app_id: app.id } });
  if (!log) {
    const error = new Error('Connection log not found');
    error.status = 404;
    throw error;
  }
  if (device && log.device_id !== device.device_id) {
    const error = new Error('Connection log does not belong to this device');
    error.status = 403;
    throw error;
  }
  if (log.disconnect_at) return log; // idempotent

  const now = new Date();
  const durationSeconds = Math.max(0, Math.round((now - new Date(log.connect_at)) / 1000));
  await log.update({ disconnect_at: now, duration_seconds: durationSeconds, closed_reason: 'client' });
  return log;
}

// Closes sessions that never received a stop (app killed). Capped at maxHours.
async function sweepStale(maxHours = 24) {
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000);
  const stale = await ConnectionLog.findAll({
    where: { disconnect_at: null, connect_at: { [Op.lt]: cutoff } },
  });
  for (const log of stale) {
    const capped = new Date(new Date(log.connect_at).getTime() + maxHours * 3600 * 1000);
    await log.update({ disconnect_at: capped, duration_seconds: maxHours * 3600, closed_reason: 'timeout' });
  }
  return stale.length;
}

async function searchLogs({ firebaseUid, ip, deviceId, appId, from, to, page = 1, pageSize = 100 } = {}) {
  const where = {};
  if (firebaseUid) where.firebase_uid = firebaseUid;
  if (ip) where.client_ip = ip;
  if (deviceId) where.device_id = deviceId;
  if (appId) where.app_id = appId;
  if (from || to) {
    where.connect_at = {};
    if (from) where.connect_at[Op.gte] = new Date(from);
    if (to) where.connect_at[Op.lte] = new Date(to);
  }
  const limit = Math.min(Number(pageSize) || 100, 100);
  const pageNum = Math.max(Number(page) || 1, 1);
  const { rows, count } = await ConnectionLog.findAndCountAll({
    where,
    order: [['connect_at', 'DESC']],
    limit,
    offset: (pageNum - 1) * limit,
  });
  return { total: count, page: pageNum, pageSize: limit, logs: rows };
}

// ---- Retention / cleanup ----

// Delete nonces past their expiry. Expired nonces no longer protect against
// replay (the timestamp window has closed), so they're pure dead weight.
async function purgeExpiredNonces() {
  return ApiNonce.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
}

// Delete audit-log rows older than `days`.
async function purgeOldAuditLogs(days = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  return ApiAuditLog.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
}

// Delete connection-log rows older than `days` (legal retention horizon).
async function purgeOldConnectionLogs(days = 365) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  return ConnectionLog.destroy({ where: { connect_at: { [Op.lt]: cutoff } } });
}

module.exports = {
  startLog,
  stopLog,
  sweepStale,
  searchLogs,
  purgeExpiredNonces,
  purgeOldAuditLogs,
  purgeOldConnectionLogs,
};
