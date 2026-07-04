const { Client } = require('ssh2');

const SSH_TIMEOUT = 60000;

class SSHService {
  connect(serverConfig) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        resolve(conn);
      });
      conn.on('error', (err) => {
        reject(err);
      });
      conn.connect({
        host: serverConfig.ip,
        port: serverConfig.port || 22,
        username: serverConfig.username || 'root',
        password: serverConfig.password,
        readyTimeout: SSH_TIMEOUT,
      });
    });
  }

  execCommand(conn, command) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      // Wrap in bash for pipefail and safer execution
      const wrappedCommand = `/bin/bash -lc "set -euo pipefail; ${command.replace(/(["$\`\\])/g, '\\$1')}"`;

      conn.exec(wrappedCommand, { pty: true }, (err, stream) => {
        if (err) return reject(err);

        stream.on('close', (code, signal) => {
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            console.error(`Command failed: ${command}\nUnique STDOUT: ${stdout}\nSTDERR: ${stderr}`);
            reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
          }
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  // Raw exec on an open connection: no PTY (clean stdout), no pipefail wrapper,
  // never throws on non-zero — returns { code, stdout, stderr } for the caller to
  // inspect. Use for reads where a non-zero exit is expected/handled.
  execRaw(conn, command) {
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

  // Connect, run one raw command, disconnect. Convenience for one-off reads.
  async runCommand(serverConfig, command) {
    const conn = await this.connect(serverConfig);
    try {
      return await this.execRaw(conn, command);
    } finally {
      conn.end();
    }
  }

  // Read the live TLS certificate's notAfter date from the box. Returns a Date or
  // null (cert missing / parse failure). Domain drives the letsencrypt path.
  async readCertExpiry(serverConfig) {
    const domain = serverConfig.domain;
    if (!domain) return null;
    const cmd = `openssl x509 -enddate -noout -in /etc/letsencrypt/live/${domain}/fullchain.pem 2>/dev/null | cut -d= -f2`;
    try {
      const { stdout } = await this.runCommand(serverConfig, cmd);
      const raw = String(stdout || '').trim();
      if (!raw) return null;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch (_) {
      return null;
    }
  }

  async installNpanel(serverConfig,  options = {}) {
     const conn = await this.connect(serverConfig);
     try {
        const { domain, adminUser, adminPass, mainPort = 443, websocketPath = '/fetch', fakeTemplate = 2 } = options;
        const passToUse = adminPass || 'ChangeMe123!';

        const steps = [
            'export DEBIAN_FRONTEND=noninteractive && apt-get update',
            'export DEBIAN_FRONTEND=noninteractive && apt-get upgrade -y',
            'apt-get install -y curl wget unzip ufw certbot',
            'systemctl stop npanel || true',
            `certbot certonly --non-interactive --standalone --agree-tos --register-unsafely-without-email -d ${domain}`,
            'cd /root && rm -f install.sh && wget "https://raw.githubusercontent.com/Leiren/Npanel/master/scripts/install.sh" -O install.sh',
            'cd /root && chmod +x install.sh && printf \'y\\n\' | bash install.sh',
            'ufw allow 22/tcp',
            'ufw allow 80/tcp',
            'ufw allow 443/tcp',
            'ufw --force enable',
            'ufw reload',
            'service npanel stop'
        ];

        for (const cmd of steps) {
            console.log(`Executing on ${serverConfig.ip}: ${cmd}`);
            await this.execCommand(conn, cmd);
        }

        const panelConfig = {
            admin_username: adminUser,
            admin_password: passToUse,
            domain: domain,
            mainport: mainPort,
            websocket_path: websocketPath,
            fakewebsite_template: fakeTemplate,
            cert_path: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
            private_key_path: `/etc/letsencrypt/live/${domain}/privkey.pem`,
            mux: true,
            bbr_on_start: true,
            telegram_bot_key: '',
            adminoptions: {
              notif_panel_login_fail: { enable: true, notify: true },
              notif_panel_login_success: { enable: true, notify: true },
              notif_panel_information_changed: { enable: true, notify: true },
              notif_panel_cpu_usage_high: { enable: true, notify: true },
              notif_panel_mem_usage_high: { enable: true, notify: true },
              notif_panel_server_reboot: { enable: true, notify: true },
              notif_panel_start: { enable: true, notify: true },
              notif_user_reach_duration_limit: { enable: true, notify: true },
              notif_user_reach_traffic_limit: { enable: true, notify: true },
              notif_user_added: { enable: true, notify: true },
              notif_user_disabled: { enable: true, notify: true },
              notif_user_enable: { enable: true, notify: true },
              notif_user_removed: { enable: true, notify: true },
              notif_user_support: { enable: true, notify: true },
            },
            useroptions: {
              can_ask_info: true,
              info_include_traffic_used: true,
              info_include_ip_limit: true,
              info_include_speed_limit: true,
              info_include_traffic_limit: true,
              info_include_days_left: true,
              info_include_user_note: true,
            },
            botoverrides: {
              domain: '',
              sni: '',
              ws_host: '',
              port: 0,
            },
        };

        const configJson = JSON.stringify(panelConfig, null, 2);
        await this.execCommand(conn, `cat <<'EOF' > /opt/Npanel/panel.json\n${configJson}\nEOF`);
        await this.execCommand(conn, 'service npanel start');

     } finally {
        conn.end();
     }
  }

  // Renew the TLS cert. certbot (standalone) needs port 80 free, so NPanel is
  // stopped around the renewal and restarted after (even on failure). For the
  // scheduled job pass force=false so Let's Encrypt only reissues when the cert
  // is actually near expiry (avoids rate limits); the manual button forces.
  // Returns the new cert expiry Date (or null).
  async renewSSL(serverConfig, options = {}) {
    const force = options.force === true;
    const conn = await this.connect(serverConfig);
    try {
      console.log(`Renewing SSL for ${serverConfig.domain} on ${serverConfig.ip} (force=${force})`);
      await this.execRaw(conn, 'service npanel stop || systemctl stop npanel || true');
      const renewCmd = force
        ? 'certbot renew --force-renewal --non-interactive'
        : 'certbot renew --non-interactive';
      const renew = await this.execRaw(conn, renewCmd);
      // Always bring NPanel back up, even if certbot failed.
      await this.execRaw(conn, 'service npanel start || systemctl start npanel || true');
      if (renew.code !== 0) {
        throw new Error(`certbot renew failed (code ${renew.code}): ${(renew.stderr || renew.stdout || '').trim().slice(0, 300)}`);
      }
      // Report the actual post-renewal expiry.
      const { stdout } = await this.execRaw(
        conn,
        `openssl x509 -enddate -noout -in /etc/letsencrypt/live/${serverConfig.domain}/fullchain.pem 2>/dev/null | cut -d= -f2`,
      );
      const raw = String(stdout || '').trim();
      const parsed = raw ? new Date(raw) : null;
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    } finally {
      conn.end();
    }
  }

  async rebootServer(serverConfig) {
    const conn = await this.connect(serverConfig);
    try {
        console.log(`Rebooting server ${serverConfig.ip}`);
        // Reboot command usually closes connection immediately, so we might get an error or simple close.
        // We'll ignore the error if it's just a closure.
        await this.execCommand(conn, 'reboot').catch(err => {
            // It's expected that the connection drops
            if (err.message && (err.message.includes('closed') || err.message.includes('econnreset'))) {
                return; 
            }
            throw err; 
        });
    } catch (err) {
         // Ignore connection drop errors which are expected on reboot
         console.log('Reboot command sent (connection drop expected).');
    } finally {
        try { conn.end(); } catch(e){}
    }
  }
}

module.exports = new SSHService();
