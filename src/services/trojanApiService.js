const crypto = require('crypto');
const sshService = require('./sshService');

// Manage trojan-go users directly through its built-in gRPC API, driven over SSH
// with the on-box trojan-go binary as the API client. This is what makes real
// automatic user creation / listing / traffic work — NPanel's own user API uses
// an unpublished cipher, but trojan-go's API is open and documented.
//
//   list:   trojan-go -api list   -api-addr 127.0.0.1:2061
//   get:    trojan-go -api get    -target-hash <hash>
//   add:    trojan-go -api set -add-profile    -target-password <pw> \
//               -upload-speed-limit <Bps> -download-speed-limit <Bps> -ip-limit <n>
//   modify: trojan-go -api set -modify-profile -target-hash <hash> ...
//   delete: trojan-go -api set -delete-profile -target-hash <hash>
//
// A trojan-go user's identity is hash = hex(SHA224(password)). Speed limits are
// bytes/sec; our NpanelUser.speed_* columns are KiB/s, so we multiply by 1024.

const DEFAULT_API_ADDR = '127.0.0.1:2061';
const BINARY_CANDIDATES = [
  '/opt/Npanel/linux/trojan-go',
  '/usr/local/bin/trojan-go',
  '/usr/bin/trojan-go',
  '/opt/trojan-go/trojan-go',
];
const KIB = 1024;

function sha224(value) {
  return crypto.createHash('sha224').update(String(value), 'utf8').digest('hex');
}

// Single-quote a shell argument safely (handles embedded quotes). Our generated
// passwords are hex, but imported ones may contain anything.
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function kibToBytes(kib) {
  const n = Number(kib) || 0;
  return n > 0 ? Math.round(n * KIB) : 0; // 0 = unlimited
}

// Run a command with a clean (no-PTY) channel so stdout stays pure — the API
// prints JSON to stdout while trojan-go's own logs go to stderr.
function execRaw(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => resolve({ code: code == null ? 0 : code, stdout, stderr }));
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
    });
  });
}

// Pull the first JSON value (array or object) out of mixed output, tolerating
// stray log lines / ANSI the binary may emit alongside the payload.
function extractJson(text) {
  const clean = String(text || '').replace(/\x1B\[[0-9;]*m/g, '').trim();
  if (!clean) return null;
  try { return JSON.parse(clean); } catch (_) { /* fall through */ }
  const start = clean.search(/[[{]/);
  if (start === -1) return null;
  const open = clean[start];
  const close = open === '[' ? ']' : '}';
  const end = clean.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { return null; }
}

function firstNum(...vals) {
  for (const v of vals) {
    if (v != null) return Number(v) || 0;
  }
  return 0;
}

// Tolerant of both snake_case and camelCase key styles (different trojan-go
// builds marshal the proto differently) and of omitempty: zero-valued fields —
// notably ip_current/ip_limit — are simply absent, which means 0, not an error.
function normalizeStatus(entry) {
  const s = (entry && entry.status) || entry || {};
  const total = s.traffic_total || s.trafficTotal || {};
  const speed = s.speed_current || s.speedCurrent || {};
  const limit = s.speed_limit || s.speedLimit || {};
  return {
    hash: (s.user && s.user.hash) || null,
    trafficUp: firstNum(total.upload_traffic, total.uploadTraffic),
    trafficDown: firstNum(total.download_traffic, total.downloadTraffic),
    speedUp: firstNum(speed.upload_speed, speed.uploadSpeed),
    speedDown: firstNum(speed.download_speed, speed.downloadSpeed),
    limitUp: firstNum(limit.upload_speed, limit.uploadSpeed),
    limitDown: firstNum(limit.download_speed, limit.downloadSpeed),
    // Concurrent client IPs — only counted on-box while ip_limit > 0.
    ipCurrent: firstNum(s.ip_current, s.ipCurrent),
    ipLimit: firstNum(s.ip_limit, s.ipLimit),
  };
}

class TrojanApiService {
  hash(password) {
    return sha224(password);
  }

  apiAddr(server) {
    return (server && server.trojan_api_addr) || DEFAULT_API_ADDR;
  }

  // Locate a usable trojan-go binary on the box (prefers a stored path, then the
  // NPanel default, then PATH). Returns the resolved path or null.
  async resolveBinary(conn, server) {
    const stored = server && server.trojan_binary_path;
    const candidates = [stored, ...BINARY_CANDIDATES].filter(Boolean);
    const probe = candidates.map((p) => `if [ -x ${shq(p)} ]; then echo ${shq(p)}; exit 0; fi`).join('; ')
      + '; command -v trojan-go 2>/dev/null | head -1';
    const { stdout } = await execRaw(conn, probe);
    const found = stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return found || null;
  }

  async apiCommand(conn, binary, addr, args) {
    const cmd = `${shq(binary)} -api-addr ${shq(addr)} ${args}`;
    return execRaw(conn, cmd);
  }

  async listUsers(conn, binary, addr) {
    const { stdout, stderr, code } = await this.apiCommand(conn, binary, addr, '-api list');
    const parsed = extractJson(stdout) || extractJson(stderr);
    if (!Array.isArray(parsed)) {
      throw new Error(`trojan-go API list failed (code ${code}): ${(stderr || stdout || '').trim().slice(0, 200)}`);
    }
    return parsed.map(normalizeStatus);
  }

  buildLimitArgs(user) {
    const up = kibToBytes(user.speed_upload);
    const down = kibToBytes(user.speed_download);
    const ip = Math.max(0, Number(user.ip_limit) || 0);
    return `-upload-speed-limit ${up} -download-speed-limit ${down} -ip-limit ${ip}`;
  }

  // Byte-precise variant for users whose limits we only know from the live API
  // (imported users): no KiB round-trip, so a modify re-sends their speed
  // limits exactly and only the ip_limit actually changes.
  buildLimitArgsRaw({ upBps = 0, downBps = 0, ipLimit = 0 } = {}) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return `-upload-speed-limit ${n(upBps)} -download-speed-limit ${n(downBps)} -ip-limit ${n(ipLimit)}`;
  }

  async modifyUserRaw(conn, binary, addr, hash, raw) {
    const args = `-api set -modify-profile -target-hash ${shq(hash)} ${this.buildLimitArgsRaw(raw)}`;
    return this.apiCommand(conn, binary, addr, args);
  }

  async addUser(conn, binary, addr, user) {
    const args = `-api set -add-profile -target-password ${shq(user.password)} ${this.buildLimitArgs(user)}`;
    return this.apiCommand(conn, binary, addr, args);
  }

  async modifyUser(conn, binary, addr, user, hash) {
    const args = `-api set -modify-profile -target-hash ${shq(hash)} ${this.buildLimitArgs(user)}`;
    return this.apiCommand(conn, binary, addr, args);
  }

  async deleteUserByHash(conn, binary, addr, hash) {
    const args = `-api set -delete-profile -target-hash ${shq(hash)}`;
    return this.apiCommand(conn, binary, addr, args);
  }

  // Reconcile a set of NpanelUser rows against the live trojan-go user set on one
  // server, over a single SSH connection. Additive by default: never removes
  // users we don't manage (so it coexists with NPanel's own users). Enabled
  // users are created/updated to match their limits; disabled managed users are
  // removed. Live traffic is written back onto each row.
  //
  // options.removeUnmanaged (default false) — also delete live users that match
  // no managed row (only safe on servers we exclusively own).
  async syncServerUsers(server, users, options = {}) {
    const removeUnmanaged = options.removeUnmanaged === true;
    const deleteHashes = Array.isArray(options.deleteHashes) ? options.deleteHashes.filter(Boolean) : [];
    const result = { ok: false, applied: [], error: null, addr: this.apiAddr(server) };
    let conn;
    try {
      conn = await sshService.connect({
        ip: server.ip,
        port: server.port,
        username: server.username,
        password: server.password,
      });
      const binary = await this.resolveBinary(conn, server);
      if (!binary) throw new Error('trojan-go binary not found on server');
      result.binary = binary;
      const addr = this.apiAddr(server);

      // Explicit orphan cleanup (e.g. a rotated password's old hash) before the
      // reconcile so it never lingers as an unmanaged live user.
      for (const h of deleteHashes) {
        await this.deleteUserByHash(conn, binary, addr, h).catch(() => {});
      }

      const live = await this.listUsers(conn, binary, addr);
      const liveByHash = new Map(live.map((u) => [u.hash, u]));
      const managedHashes = new Set();

      // Measurement arming for users we can't push (imported): trojan-go only
      // counts concurrent IPs while ip_limit > 0, so 0-limit users get the high
      // sentinel via ONE modify that re-sends their live speed limits
      // byte-for-byte. A positive live limit (admin-set on NPanel, or an earlier
      // sentinel) already counts and is never overridden.
      const armHashes = new Set((options.armHashes || []).filter(Boolean));
      const armIpLimit = Math.max(0, Number(options.armIpLimit) || 0);
      if (armHashes.size && armIpLimit > 0) {
        for (const u of live) {
          if (u.hash && armHashes.has(u.hash) && u.ipLimit === 0) {
            await this.modifyUserRaw(conn, binary, addr, u.hash, {
              upBps: u.limitUp,
              downBps: u.limitDown,
              ipLimit: armIpLimit,
            }).catch(() => { /* arming is best-effort */ });
          }
        }
      }

      const desiredByHash = new Map(users.map((u) => [this.hash(u.password), u]));

      for (const user of users) {
        const hash = this.hash(user.password);
        managedHashes.add(hash);
        const exists = liveByHash.has(hash);
        let action = 'none';
        let message = '';
        // Any non-zero exit means the command was rejected — surface it as an
        // error, not a silent "created", so the panel never shows a fake success.
        const fail = (r, verb) => {
          action = 'error';
          message = `${verb} failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`;
        };
        try {
          if (user.enabled === false) {
            if (exists) {
              const r = await this.deleteUserByHash(conn, binary, addr, hash);
              if (r.code !== 0) fail(r, 'delete'); else action = 'deleted';
            } else {
              action = 'absent';
            }
          } else if (exists) {
            const r = await this.modifyUser(conn, binary, addr, user, hash);
            if (r.code !== 0) fail(r, 'modify'); else action = 'updated';
          } else {
            const r = await this.addUser(conn, binary, addr, user);
            if (r.code !== 0) fail(r, 'add'); else action = 'created';
          }
        } catch (err) {
          action = 'error';
          message = err.message;
        }
        const stats = liveByHash.get(hash);
        result.applied.push({
          id: user.id,
          name: user.name,
          hash,
          action,
          message,
          stats: stats || null,
        });
      }

      if (removeUnmanaged) {
        for (const u of live) {
          if (u.hash && !managedHashes.has(u.hash)) {
            await this.deleteUserByHash(conn, binary, addr, u.hash).catch(() => {});
          }
        }
      }

      // Re-read once and VERIFY reality: a created/updated user must now be
      // present; a deleted one must be gone. This catches the case where the API
      // returns success but the user didn't actually land — so the panel status
      // reflects the box, not the command's exit code alone.
      try {
        const fresh = await this.listUsers(conn, binary, addr);
        const freshByHash = new Map(fresh.map((u) => [u.hash, u]));
        const ipRepairs = [];
        for (const item of result.applied) {
          const present = freshByHash.has(item.hash);
          if ((item.action === 'created' || item.action === 'updated') && !present) {
            item.action = 'error';
            item.message = item.message || 'user not present on trojan-go after sync';
          } else if (item.action === 'deleted' && present) {
            item.action = 'error';
            item.message = item.message || 'user still present after delete';
          }
          const s = freshByHash.get(item.hash);
          if (s) item.stats = s;
          // trojan-go's Add op applies -ip-limit unreliably (only alongside a
          // speed limit); Modify applies it unconditionally. Repair once when
          // the fresh listing disagrees with the desired limit.
          const want = desiredByHash.get(item.hash);
          if (s && want && want.enabled !== false
              && (item.action === 'created' || item.action === 'updated')
              && Number(s.ipLimit) !== Math.max(0, Number(want.ip_limit) || 0)) {
            ipRepairs.push({ hash: item.hash, user: want, item });
          }
        }
        if (ipRepairs.length) {
          for (const repair of ipRepairs) {
            await this.modifyUser(conn, binary, addr, repair.user, repair.hash).catch(() => {});
          }
          const check = await this.listUsers(conn, binary, addr);
          const checkByHash = new Map(check.map((u) => [u.hash, u]));
          for (const repair of ipRepairs) {
            const s = checkByHash.get(repair.hash);
            if (s) repair.item.stats = s;
            if (!s || Number(s.ipLimit) !== Math.max(0, Number(repair.user.ip_limit) || 0)) {
              // Informational only — the user itself is live, just uncounted.
              repair.item.message = repair.item.message || 'ip_limit did not apply';
            }
          }
        }
      } catch (_) { /* keep pre-read stats */ }

      result.ok = true;
      return result;
    } catch (error) {
      result.ok = false;
      result.error = error.message;
      return result;
    } finally {
      if (conn) { try { conn.end(); } catch (_) { /* noop */ } }
    }
  }

  // Read-only: list live users + traffic for a server (used by the monitor to
  // refresh counters without changing state).
  async fetchLiveUsers(server) {
    let conn;
    try {
      conn = await sshService.connect({
        ip: server.ip,
        port: server.port,
        username: server.username,
        password: server.password,
      });
      const binary = await this.resolveBinary(conn, server);
      if (!binary) throw new Error('trojan-go binary not found on server');
      const users = await this.listUsers(conn, binary, this.apiAddr(server));
      return { ok: true, users, binary };
    } catch (error) {
      return { ok: false, error: error.message, users: [] };
    } finally {
      if (conn) { try { conn.end(); } catch (_) { /* noop */ } }
    }
  }
}

module.exports = new TrojanApiService();
module.exports.sha224 = sha224;
module.exports.normalizeStatus = normalizeStatus;
