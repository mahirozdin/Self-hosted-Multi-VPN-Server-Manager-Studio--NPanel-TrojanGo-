const { Op } = require('sequelize');
const { Server, VpnCatalogItem } = require('../models/Database');
const sshService = require('./sshService');
const trojanApiService = require('./trojanApiService');
const settingsService = require('./settingsService');
const monitorService = require('./monitorService');
const { foldLiveStatsOntoRows } = require('./npanelUserService');

// Real per-server load pipeline. Every poll (default 60s) each server is read
// over ONE short SSH session: trojan-go `-api list` (per-user instantaneous
// speed + concurrent client IPs) plus /proc/loadavg + nproc. The three real
// utilizations — bandwidth, CPU, concurrent IPs (only when the admin set a
// cap) — collapse into a 0-100 score, EMA-smoothed against poll noise, stored
// on the Server row. After the pass, the least-loaded active catalog item per
// (country, type) group gets `recommended` (with hysteresis so it never flaps),
// which /v1/configs exposes to the mobile app.

const POLL_MIN_SECONDS = 15;
const CONCURRENCY = 5; // servers polled at once
const PER_SERVER_TIMEOUT_MS = 10000;
const EMA_ALPHA = 0.4;
const HYSTERESIS_PTS = 8; // challenger must be this much lower to steal `recommended`
const ALERT_CONSECUTIVE_POLLS = 3;
const ALERT_RESOLVE_BELOW = 75;
const MIN_STALE_MS = 5 * 60 * 1000;
// States where a job is actively changing the box — don't poll into it.
const BUSY_STATES = new Set(['installing', 'renewing_ssl']);

// ---- Pure helpers (exported for tests) -----------------------------------

// throughputBps is BITS/sec (callers convert from trojan-go's bytes/sec).
// The score is the worst of the real utilizations, clamped to 0..100. The
// concurrent-IP component only participates when the admin set a capacity.
function computeLoadScore({ throughputBps, capacityMbps, cpuUtilPct, liveIpTotal, maxConcurrentIps }) {
  const capBits = Math.max(1, Number(capacityMbps) || 1000) * 1e6;
  const bwPct = (100 * (Number(throughputBps) || 0)) / capBits;
  const cpuPct = cpuUtilPct == null ? 0 : Number(cpuUtilPct) || 0;
  const connPct = Number(maxConcurrentIps) > 0
    ? (100 * (Number(liveIpTotal) || 0)) / Number(maxConcurrentIps)
    : 0;
  return Math.max(0, Math.min(100, Math.round(Math.max(bwPct, cpuPct, connPct))));
}

function levelFor(pct) {
  return pct <= 40 ? 'low' : pct <= 70 ? 'medium' : 'high';
}

function emaNext(prev, raw, alpha = EMA_ALPHA) {
  return prev == null ? Math.round(raw) : Math.round(alpha * raw + (1 - alpha) * prev);
}

function loadStaleMsFor(pollSeconds) {
  return Math.max(3 * (Number(pollSeconds) || 60) * 1000, MIN_STALE_MS);
}

function isLoadFresh(loadUpdatedAt, pollSeconds, now = Date.now()) {
  if (!loadUpdatedAt) return false;
  const at = new Date(loadUpdatedAt).getTime();
  return Number.isFinite(at) && now - at <= loadStaleMsFor(pollSeconds);
}

// Parse the combined `cat /proc/loadavg; nproc` output. loadavg's first token
// is the 1-minute average; nproc prints a bare integer on its own line.
function parseSystemStats(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let load1 = null;
  let cores = null;
  for (const line of lines) {
    if (load1 == null && /^\d+(\.\d+)?\s/.test(line)) {
      const first = Number(line.split(/\s+/)[0]);
      if (Number.isFinite(first)) load1 = first;
    } else if (cores == null && /^\d+$/.test(line)) {
      cores = Number(line);
    }
  }
  return { load1, cores };
}

// Pick the `recommended` item for one (country, type) group.
// group: [{ id, sortOrder, load, fresh, healthy, recommended }].
// Only groups with >= 2 items get a star (a lone config has nothing to be
// recommended over) — but within such a group a single fresh candidate still
// wins (it steers users away from a stale/failing sibling). The incumbent keeps
// the star unless a challenger is at least HYSTERESIS_PTS lower; a
// stale/unhealthy incumbent is always replaced. Returns the winning id or null.
function pickRecommended(group) {
  const eligible = group
    .filter((g) => g.fresh && g.load != null && g.healthy !== false)
    .sort((a, b) => (a.load - b.load) || (a.sortOrder - b.sortOrder) || (a.id - b.id));
  if (group.length < 2 || !eligible.length) return null;
  const challenger = eligible[0];
  const incumbent = group.find((g) => g.recommended);
  if (incumbent
      && eligible.some((g) => g.id === incumbent.id)
      && challenger.load > incumbent.load - HYSTERESIS_PTS) {
    return incumbent.id;
  }
  return challenger.id;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Tiny concurrency pool — no dependency, order-preserving, never rejects.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      try {
        out[idx] = await fn(items[idx]);
      } catch (error) {
        out[idx] = { ok: false, error: error.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- Service --------------------------------------------------------------

class LoadMetricsService {
  constructor() {
    this._timer = null;
    this._ema = new Map(); // serverId -> smoothed pct (seeded from Server.load_pct)
    this._hot = new Map(); // serverId -> consecutive over-threshold polls
  }

  // Self-rescheduling loop (not node-cron): the interval is a runtime setting
  // and can be sub-minute, and scheduling the next tick only after the pass
  // finishes guarantees passes never overlap.
  start() {
    if (this._timer) return;
    const tick = async () => {
      let intervalSeconds = 60;
      try {
        intervalSeconds = Math.max(POLL_MIN_SECONDS, await settingsService.getInt('load_poll_seconds', 60));
        if (await settingsService.getBool('monitor_enabled')) {
          await this.runLoadPass(intervalSeconds);
        }
      } catch (error) {
        console.error('[load] pass failed:', error.message);
      }
      this._timer = setTimeout(tick, intervalSeconds * 1000);
      if (this._timer.unref) this._timer.unref();
    };
    this._timer = setTimeout(tick, 10000); // first pass shortly after boot
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async runLoadPass(pollSeconds) {
    const defaultMbps = await settingsService.getInt('default_server_bandwidth_mbps', 1000);
    const alertThreshold = await settingsService.getInt('load_alert_threshold', 90);
    const servers = await Server.findAll();
    const results = await mapLimit(servers, CONCURRENCY, (server) => this.pollServer(server, { defaultMbps, alertThreshold }));
    const polled = results.filter((r) => r && r.ok).length;
    await this.updateRecommendations(pollSeconds);
    console.log(`[load] pass complete: ${polled}/${servers.length} server(s) polled`);
    return { polled, total: servers.length };
  }

  async pollServer(server, { defaultMbps, alertThreshold }) {
    if (BUSY_STATES.has(server.status)) return { ok: false, skipped: 'busy' };
    // Attempt on 'ok'/'unknown' so brand-new servers aren't starved until the
    // next health pass; skip only confirmed-unreachable boxes.
    if (server.ssh_status === 'error') {
      this._hot.set(server.id, 0);
      return { ok: false, skipped: 'ssh_unreachable' };
    }
    let conn;
    try {
      conn = await sshService.connect({
        ip: server.ip,
        port: server.port,
        username: server.username,
        password: server.password,
        readyTimeout: PER_SERVER_TIMEOUT_MS,
      });
      const work = async () => {
        const binary = await trojanApiService.resolveBinary(conn, server);
        if (!binary) throw new Error('trojan-go binary not found');
        const users = await trojanApiService.listUsers(conn, binary, trojanApiService.apiAddr(server));
        const sys = await sshService.execRaw(conn, 'cat /proc/loadavg 2>/dev/null; nproc 2>/dev/null');
        return { users, sys };
      };
      const { users, sys } = await withTimeout(work(), PER_SERVER_TIMEOUT_MS, 'load poll timed out');

      const { load1, cores } = parseSystemStats(sys.stdout);
      const cpuUtil = load1 != null && cores > 0 ? Math.min(100, Math.round((100 * load1) / cores)) : null;
      // trojan-go reports bytes/sec; the rollup column stores bits/sec.
      const throughputBps = users.reduce((acc, u) => acc + (u.speedUp || 0) + (u.speedDown || 0), 0) * 8;
      const liveIpTotal = users.reduce((acc, u) => acc + (u.ipCurrent || 0), 0);

      const raw = computeLoadScore({
        throughputBps,
        capacityMbps: server.max_throughput_mbps || defaultMbps,
        cpuUtilPct: cpuUtil,
        liveIpTotal,
        maxConcurrentIps: server.max_concurrent_ips,
      });
      const prev = this._ema.has(server.id)
        ? this._ema.get(server.id)
        : (server.load_pct != null ? Number(server.load_pct) : null);
      const smoothed = emaNext(prev, raw);
      this._ema.set(server.id, smoothed);

      await server.update({
        load_pct: smoothed,
        load_level: levelFor(smoothed),
        load_updated_at: new Date(),
        live_ip_total: liveIpTotal,
        throughput_bps: throughputBps,
        cpu_util: cpuUtil,
      });
      // Same listing also refreshes per-user counters (panel shows devices live).
      await foldLiveStatsOntoRows(server.id, users);
      await this.checkLoadAlerts(server, smoothed, alertThreshold);
      return { ok: true, load: smoothed };
    } catch (error) {
      // Write nothing on failure — load_updated_at ages out into staleness,
      // which the serializer + recommendation pass treat as "unknown".
      this._hot.set(server.id, 0);
      return { ok: false, error: error.message };
    } finally {
      if (conn) { try { conn.end(); } catch (_) { /* noop */ } }
    }
  }

  // Sustained-load alerting: one spike can't email (EMA + 3 consecutive polls),
  // recovery below the resolve floor closes the incident (recovery mail only if
  // the outage mailed — monitorService handles that).
  async checkLoadAlerts(server, pct, threshold) {
    if (pct >= threshold) {
      const streak = (this._hot.get(server.id) || 0) + 1;
      this._hot.set(server.id, streak);
      if (streak >= ALERT_CONSECUTIVE_POLLS) {
        await monitorService.openIncident(
          server,
          'load',
          `Sunucu yükü %${pct} (eşik %${threshold}, ${streak} ardışık ölçüm)`,
          { alert: true, subject: `LOAD HIGH — ${server.name}` },
        );
      }
    } else {
      this._hot.set(server.id, 0);
      if (pct < ALERT_RESOLVE_BELOW) {
        await monitorService.resolveIncidents(server, 'load');
      }
    }
  }

  async updateRecommendations(pollSeconds) {
    const items = await VpnCatalogItem.findAll({
      where: { status: 'active' },
      include: [{ model: Server, as: 'server' }],
    });
    const groups = new Map();
    for (const item of items) {
      const key = `${item.country_id || 0}:${item.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        id: item.id,
        sortOrder: item.sort_order || 0,
        load: item.server && item.server.load_pct != null ? Number(item.server.load_pct) : null,
        fresh: item.server ? isLoadFresh(item.server.load_updated_at, pollSeconds) : false,
        healthy: item.last_test_ok !== false, // a failing config is never recommended
        recommended: !!item.recommended,
        item,
      });
    }
    for (const group of groups.values()) {
      const winnerId = pickRecommended(group);
      for (const entry of group) {
        const should = entry.id === winnerId;
        if (!!entry.item.recommended !== should) {
          await entry.item.update({ recommended: should });
        }
      }
    }
    // A deactivated incumbent must not keep a stale star.
    await VpnCatalogItem.update(
      { recommended: false },
      { where: { recommended: true, status: { [Op.ne]: 'active' } } },
    );
  }
}

module.exports = new LoadMetricsService();
module.exports.computeLoadScore = computeLoadScore;
module.exports.levelFor = levelFor;
module.exports.emaNext = emaNext;
module.exports.loadStaleMsFor = loadStaleMsFor;
module.exports.isLoadFresh = isLoadFresh;
module.exports.parseSystemStats = parseSystemStats;
module.exports.pickRecommended = pickRecommended;
