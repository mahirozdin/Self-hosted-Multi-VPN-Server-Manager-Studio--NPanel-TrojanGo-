const tls = require('tls');
const { Client } = require('ssh2');
const { Server, NpanelUser, MonitorIncident, VpnCatalogItem } = require('../models/Database');
const sshService = require('./sshService');
const trojanApiService = require('./trojanApiService');
const npanelUserService = require('./npanelUserService');
const configTestService = require('./configTestService');
const notificationService = require('./notificationService');
const settingsService = require('./settingsService');

// States the monitor must not overwrite (a job is actively changing the box).
const BUSY_STATES = new Set(['installing', 'renewing_ssl']);
const HANDSHAKE_TIMEOUT_MS = 8000;
const SSH_CHECK_TIMEOUT_MS = 10000;

class MonitorService {
  // ---- Individual checks -------------------------------------------------

  // Real trojan-go liveness: complete a TLS handshake to the VPN port presenting
  // the server's domain as SNI. If trojan-go is serving TLS, this succeeds and we
  // also learn the cert expiry straight from the handshake (no SSH needed).
  checkTrojanTls(server) {
    return new Promise((resolve) => {
      const port = server.vpn_port || 443;
      const start = Date.now();
      let settled = false;
      const finish = (out) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) { /* noop */ }
        resolve(out);
      };
      const socket = tls.connect({
        host: server.ip,
        port,
        servername: server.domain || undefined,
        rejectUnauthorized: false,
        timeout: HANDSHAKE_TIMEOUT_MS,
      }, () => {
        const latency = Date.now() - start;
        let certExpiry = null;
        try {
          const cert = socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const d = new Date(cert.valid_to);
            if (!Number.isNaN(d.getTime())) certExpiry = d;
          }
        } catch (_) { /* ignore */ }
        finish({ ok: true, latency, error: null, certExpiry });
      });
      socket.on('error', (err) => finish({ ok: false, latency: null, error: err.message, certExpiry: null }));
      socket.on('timeout', () => finish({ ok: false, latency: null, error: 'TLS handshake timeout', certExpiry: null }));
    });
  }

  checkSSH(server) {
    return new Promise((resolve) => {
      const conn = new Client();
      let resolved = false;
      const done = (status) => {
        if (resolved) return;
        resolved = true;
        try { conn.end(); } catch (_) { /* noop */ }
        resolve(status);
      };
      conn.on('ready', () => done('ok'));
      conn.on('error', () => done('error'));
      conn.on('timeout', () => done('error'));
      try {
        conn.connect({
          host: server.ip,
          port: server.port || 22,
          username: server.username || 'root',
          password: server.password,
          readyTimeout: SSH_CHECK_TIMEOUT_MS,
          keepaliveInterval: 0,
        });
      } catch (_) {
        done('error');
      }
    });
  }

  // ---- Incident tracking + alerting -------------------------------------

  async openIncident(server, kind, message, options = {}) {
    const alert = options.alert !== false;
    const catalogItemId = options.catalogItemId != null ? options.catalogItemId : null;
    const existing = await MonitorIncident.findOne({ where: { server_id: server.id, kind, catalog_item_id: catalogItemId, status: 'open' } });
    if (existing) return existing;

    const incident = await MonitorIncident.create({
      server_id: server.id,
      kind,
      catalog_item_id: catalogItemId,
      status: 'open',
      message: String(message || '').slice(0, 1000),
      started_at: new Date(),
      notified: false,
    });
    await server.update({ last_incident_at: new Date() });

    if (alert) {
      const subject = options.subject || `${kind.toUpperCase()} DOWN — ${server.name}`;
      const body = options.body || [
        `Server: ${server.name} (${server.ip})`,
        `Domain: ${server.domain}`,
        `Check: ${kind}`,
        `Detail: ${message}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n');
      const res = await notificationService.sendAlert(subject, body, {
        dedupKey: options.dedupKey || `${server.id}:${kind}:${catalogItemId || 'srv'}:down`,
        minGapMs: options.minGapMs,
      });
      if (res.ok) await incident.update({ notified: true });
    }
    return incident;
  }

  async resolveIncidents(server, kind, options = {}) {
    const alert = options.alert !== false;
    const catalogItemId = options.catalogItemId != null ? options.catalogItemId : null;
    const open = await MonitorIncident.findAll({ where: { server_id: server.id, kind, catalog_item_id: catalogItemId, status: 'open' } });
    if (!open.length) return;
    const wasNotified = open.some((i) => i.notified);
    for (const inc of open) {
      await inc.update({ status: 'resolved', resolved_at: new Date() });
    }
    // Only announce recovery if we announced the outage.
    if (alert && wasNotified) {
      const subject = options.subject || `${kind.toUpperCase()} RECOVERED — ${server.name}`;
      const body = options.body || `Server ${server.name} (${server.ip}) — ${kind} is back to normal at ${new Date().toISOString()}.`;
      await notificationService.sendAlert(subject, body, { dedupKey: options.dedupKey || `${server.id}:${kind}:${catalogItemId || 'srv'}:up`, minGapMs: 0 });
    }
  }

  // ---- Combined status update for one server ----------------------------

  async updateServerStatus(server) {
    try {
      if (BUSY_STATES.has(server.status)) return server;

      const [trojan, sshStatus] = await Promise.all([
        this.checkTrojanTls(server),
        this.checkSSH(server),
      ]);

      const online = trojan.ok;
      const health = !online ? 'offline' : (sshStatus === 'ok' ? 'online' : 'degraded');

      const patch = {
        status: online ? 'online' : 'error',
        ssh_status: sshStatus,
        latency: trojan.latency,
        trojan_latency: online ? trojan.latency : -1,
        trojan_last_error: trojan.error,
        health_status: health,
      };
      if (trojan.certExpiry) patch.ssl_expiry = trojan.certExpiry;
      if (online) patch.last_health_ok_at = new Date();
      await server.update(patch);

      // Incidents: the trojan handshake is the user-facing outage signal (alert);
      // SSH failures are tracked quietly (they only block management).
      if (!online) {
        await this.openIncident(server, 'trojan', trojan.error || 'TLS handshake failed', { alert: true });
      } else {
        await this.resolveIncidents(server, 'trojan');
      }
      if (sshStatus !== 'ok') {
        await this.openIncident(server, 'ssh', 'SSH unreachable', { alert: false });
      } else {
        await this.resolveIncidents(server, 'ssh', { alert: false });
      }

      console.log(`[monitor] ${server.name}: trojan=${online ? `${trojan.latency}ms` : 'DOWN'} ssh=${sshStatus} health=${health}`);
      return server;
    } catch (e) {
      console.error(`[monitor] error updating ${server.ip}:`, e.message);
      return server;
    }
  }

  // ---- Passes (scheduled by server.js) ----------------------------------

  async runHealthPass() {
    if (!(await settingsService.getBool('monitor_enabled'))) return;
    const servers = await Server.findAll();
    for (const server of servers) {
      await this.updateServerStatus(server);
    }
    console.log(`[monitor] health pass complete for ${servers.length} server(s)`);
  }

  // Reconcile managed users to the box (persistence after restarts) and pull live
  // traffic back onto the rows. Skips busy/offline servers.
  async syncUsersAndTraffic(server) {
    if (BUSY_STATES.has(server.status)) return { ok: false, skipped: 'busy' };
    const users = await NpanelUser.findAll({ where: { server_id: server.id } });
    if (!users.length) return { ok: true, skipped: 'no_users' };
    try {
      // Persist managed users (re-add after a trojan-go restart, enforce limits).
      const result = await npanelUserService.pushUsersToServer(server, users);
      // Refresh live traffic for ALL rows (managed + imported) by hash.
      await this.refreshTraffic(server);
      return result;
    } catch (error) {
      console.error(`[monitor] user sync failed for ${server.name}:`, error.message);
      return { ok: false, error: error.message };
    }
  }

  async runUserSyncPass() {
    const servers = await Server.findAll();
    let synced = 0;
    for (const server of servers) {
      const r = await this.syncUsersAndTraffic(server);
      if (r && r.ok && !r.skipped) synced += 1;
    }
    console.log(`[monitor] user/traffic sync complete (${synced} server(s) reconciled)`);
  }

  // Read-only traffic refresh (lighter than a full reconcile) — used when we only
  // want fresh counters without touching the live user set.
  async refreshTraffic(server) {
    const { ok, users, error } = await trojanApiService.fetchLiveUsers(server);
    if (!ok) return { ok: false, error };
    await npanelUserService.foldLiveStatsOntoRows(server.id, users);
    return { ok: true };
  }

  // ---- Certificate auto-renewal -----------------------------------------

  // Daily: renew certs that are within the threshold, update expiry, and alert on
  // failure (and on recovery of a previously-failing renewal).
  async runCertRenewalPass() {
    if (!(await settingsService.getBool('auto_renew_ssl'))) return;
    const thresholdDays = await settingsService.getInt('ssl_renew_days', 21);
    const servers = await Server.findAll();
    const now = Date.now();

    for (const server of servers) {
      if (BUSY_STATES.has(server.status)) continue;
      const expiry = server.ssl_expiry ? new Date(server.ssl_expiry) : null;
      const daysLeft = expiry ? Math.floor((expiry.getTime() - now) / (24 * 60 * 60 * 1000)) : null;

      // Renew if we don't know the expiry or it's within the threshold.
      if (daysLeft != null && daysLeft > thresholdDays) continue;

      console.log(`[cert] renewing ${server.name} (daysLeft=${daysLeft})`);
      const prevStatus = server.status;
      try {
        await server.update({ status: 'renewing_ssl' });
        const newExpiry = await sshService.renewSSL({
          ip: server.ip,
          port: server.port,
          username: server.username,
          password: server.password,
          domain: server.domain,
        });
        await server.update({
          status: prevStatus === 'renewing_ssl' ? 'online' : prevStatus,
          last_ssl_renew: new Date(),
          ssl_expiry: newExpiry || server.ssl_expiry,
        });
        await this.resolveIncidents(server, 'cert');
        console.log(`[cert] ${server.name} renewed; expiry=${newExpiry ? newExpiry.toISOString() : 'unknown'}`);
      } catch (error) {
        await server.update({ status: prevStatus === 'renewing_ssl' ? 'error' : prevStatus });
        await this.openIncident(server, 'cert', `Certificate renewal failed: ${error.message}`, { alert: true });
        console.error(`[cert] renewal failed for ${server.name}:`, error.message);
      }
      // Refresh reachability after fiddling with NPanel/port 80.
      await this.updateServerStatus(server);
    }
  }

  // ---- Config functional tests (does the published config actually work) ----

  // Fold one config test result onto its catalog item (last status + rolling
  // last-10 latency samples with avg/min/max) and alert immediately on failure.
  async recordConfigResult(server, item, result) {
    let samples = [];
    try { samples = JSON.parse(item.test_samples || '[]'); } catch (_) { samples = []; }
    samples.push({ ok: !!result.ok, ms: result.latencyMs != null ? result.latencyMs : null });
    if (samples.length > 10) samples = samples.slice(-10);
    const okLat = samples.filter((s) => s.ok && s.ms != null).map((s) => s.ms);
    const avg = okLat.length ? Math.round(okLat.reduce((a, b) => a + b, 0) / okLat.length) : null;
    const min = okLat.length ? Math.min(...okLat) : null;
    const max = okLat.length ? Math.max(...okLat) : null;
    const wasOk = item.last_test_ok;

    await item.update({
      last_test_at: new Date(),
      last_test_ok: result.ok,
      last_test_error: result.ok ? null : String(result.error || 'hata').slice(0, 500),
      test_latency: result.latencyMs != null ? result.latencyMs : null,
      latency_avg: avg,
      latency_min: min,
      latency_max: max,
      test_samples: JSON.stringify(samples),
    });

    if (!result.ok) {
      // Track for the dashboard (no email here)…
      await this.openIncident(server, 'config', `Config "${item.display_name}" testi başarısız: ${result.error}`, {
        catalogItemId: item.id, alert: false,
      });
      // …and alert immediately, the instant we catch it. Dedup 55 min < the 60 min
      // test interval, so a still-broken config re-alerts on the next hourly run.
      await notificationService.sendAlert(
        `CONFIG DOWN — ${item.display_name} (${server.name})`,
        [
          `Config: ${item.display_name} (${item.type})`,
          `Server: ${server.name} (${server.ip})`,
          `Domain: ${server.domain}`,
          `Hata: ${result.error}`,
          `Zaman: ${new Date().toISOString()}`,
        ].join('\n'),
        { dedupKey: `config:${item.id}:down`, minGapMs: 55 * 60 * 1000 },
      );
    } else {
      await this.resolveIncidents(server, 'config', { catalogItemId: item.id, alert: false });
      if (wasOk === false) {
        await notificationService.sendAlert(
          `CONFIG RECOVERED — ${item.display_name} (${server.name})`,
          `Config "${item.display_name}" yeniden çalışıyor (${result.latencyMs} ms) — ${new Date().toISOString()}.`,
          { dedupKey: `config:${item.id}:up`, minGapMs: 0 },
        );
      }
    }
    return item;
  }

  // Hourly: test every active/published config over a real trojan tunnel,
  // grouped by server (one SSH connection each). Alerts fire per-config as they
  // fail — the pass does not wait to finish.
  async runConfigTestPass() {
    if (!(await settingsService.getBool('config_test_enabled'))) return;
    const timeoutSec = await settingsService.getInt('config_test_timeout', 30);
    const items = await VpnCatalogItem.findAll({
      where: { status: 'active' },
      include: [{ model: Server, as: 'server' }],
    });
    const byServer = new Map();
    for (const it of items) {
      if (!it.server) continue;
      if (!byServer.has(it.server.id)) byServer.set(it.server.id, { server: it.server, list: [] });
      byServer.get(it.server.id).list.push(it);
    }
    let tested = 0; let failed = 0;
    for (const { server, list } of byServer.values()) {
      if (BUSY_STATES.has(server.status)) continue;
      const results = await configTestService.testConfigsOnServer(
        server, list,
        (item, result) => this.recordConfigResult(server, item, result).catch((e) => console.error('[config-test] record:', e.message)),
        { timeoutSec },
      );
      tested += results.length;
      failed += results.filter((r) => !r.ok).length;
    }
    console.log(`[config-test] tested ${tested} config(s), ${failed} failing`);
    return { tested, failed };
  }

  // Test a single config on demand (panel "test now" button).
  async testSingleConfig(item, server) {
    const results = await configTestService.testConfigsOnServer(
      server, [item],
      (it, result) => this.recordConfigResult(server, it, result),
      { timeoutSec: await settingsService.getInt('config_test_timeout', 30) },
    );
    return results[0];
  }

  // Back-compat alias used elsewhere in the codebase.
  async updateAllServers() {
    return this.runHealthPass();
  }
}

module.exports = new MonitorService();
