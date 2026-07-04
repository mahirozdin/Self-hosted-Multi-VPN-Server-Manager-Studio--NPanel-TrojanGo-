const sshService = require('./sshService');
const trojanApiService = require('./trojanApiService');
const { parseTrojanUrl } = require('./npanelUserService');

// Functional health test for a published config: run the on-box trojan-go binary
// as a CLIENT against the config (its own password, ws/tcp transport, TLS+SNI),
// then fetch a known 204 endpoint THROUGH the resulting SOCKS tunnel. This
// exercises the exact path a real app user takes — auth, TLS, cert validity,
// websocket path, and real outbound traffic. A wrong password makes trojan-go
// fall back to the fake website (not a 204), so we key success on HTTP 204.

// Reliable "no content" probes reached through the tunnel.
const PROBE_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_TIMEOUT_SEC = 30;

function shq(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }

function buildClientConfig(parsed, localPort) {
  const cfg = {
    run_type: 'client',
    local_addr: '127.0.0.1',
    local_port: localPort,
    remote_addr: parsed.host,
    remote_port: parsed.port || 443,
    password: [parsed.password],
    ssl: { sni: parsed.host, verify: true },
  };
  if ((parsed.type || 'ws') === 'ws') {
    cfg.websocket = { enabled: true, path: parsed.path || '/fetch', host: parsed.host };
  }
  return cfg;
}

class ConfigTestService {
  // Test one parsed config over an already-open SSH connection. Returns
  // { ok, latencyMs, httpCode, error }.
  async runOneTest(conn, binary, parsed, index, timeoutSec) {
    const port = 20800 + (index % 400);
    const tag = `ct_${port}`;
    const cfgJson = JSON.stringify(buildClientConfig(parsed, port));
    const b64 = Buffer.from(cfgJson, 'utf8').toString('base64');
    // Write config, start client, wait for the SOCKS port to open (max ~4s),
    // fetch the probe through it, then always kill the client + clean up.
    const script = [
      `echo ${shq(b64)} | base64 -d > /tmp/${tag}.json`,
      `${shq(binary)} -config /tmp/${tag}.json > /tmp/${tag}.log 2>&1 & CP=$!`,
      `for i in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && break; sleep 0.2; done`,
      `RES=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time ${timeoutSec} --socks5-hostname 127.0.0.1:${port} ${shq(PROBE_URL)} 2>/dev/null)`,
      `echo "RESULT:$RES"`,
      `kill $CP >/dev/null 2>&1; rm -f /tmp/${tag}.json /tmp/${tag}.log`,
    ].join('; ');

    const { stdout } = await sshService.execRaw(conn, script);
    const m = String(stdout || '').match(/RESULT:(\d{3})\s+([\d.]+)/);
    if (!m) return { ok: false, latencyMs: null, httpCode: null, error: 'test çıktısı alınamadı' };
    const httpCode = m[1];
    const latencyMs = Math.round(parseFloat(m[2]) * 1000);
    if (httpCode === '204') return { ok: true, latencyMs, httpCode, error: null };
    if (httpCode === '000') return { ok: false, latencyMs: null, httpCode, error: `bağlantı kurulamadı / ${timeoutSec}s timeout` };
    return { ok: false, latencyMs, httpCode, error: `beklenmeyen yanıt (HTTP ${httpCode}) — şifre/config hatalı olabilir` };
  }

  // Test every config that lives on one server, over a single SSH connection.
  // onResult(item, result) is awaited right after each config so the caller can
  // alert the instant a failure is found (not at the end of the batch).
  async testConfigsOnServer(server, items, onResult, options = {}) {
    const timeoutSec = options.timeoutSec || DEFAULT_TIMEOUT_SEC;
    const results = [];
    let conn;
    try {
      conn = await sshService.connect({
        ip: server.ip, port: server.port, username: server.username, password: server.password,
      });
      const binary = await trojanApiService.resolveBinary(conn, server);
      if (!binary) throw new Error('trojan-go binary bulunamadı');
      let i = 0;
      for (const item of items) {
        const parsed = parseTrojanUrl(item.config);
        let result;
        if (!parsed || !parsed.password) {
          result = { ok: false, latencyMs: null, error: 'config parse edilemedi (geçersiz trojan URI)' };
        } else {
          try {
            result = await this.runOneTest(conn, binary, parsed, i, timeoutSec);
          } catch (err) {
            result = { ok: false, latencyMs: null, error: err.message };
          }
        }
        results.push({ id: item.id, ...result });
        if (onResult) { await onResult(item, result); }
        i += 1;
      }
    } catch (err) {
      // Whole-server failure (SSH/binary): mark every config on it as failed.
      for (const item of items) {
        const result = { ok: false, latencyMs: null, error: `sunucuya erişilemedi: ${err.message}` };
        results.push({ id: item.id, ...result });
        if (onResult) { await onResult(item, result).catch(() => {}); }
      }
    } finally {
      if (conn) { try { conn.end(); } catch (_) { /* noop */ } }
    }
    return results;
  }
}

module.exports = new ConfigTestService();
