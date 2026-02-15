#!/usr/bin/env node
'use strict';

const { Client } = require('ssh2');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .scriptName('npanel-auto')
  .usage('$0 --host <ip> --password <rootPass> --domain <sub.domain>')
  .option('host', {
    type: 'string',
    demandOption: true,
    describe: 'IPv4/IPv6 address or hostname of the VPS',
  })
  .option('ssh-port', {
    type: 'number',
    default: 22,
    describe: 'SSH port of the VPS',
  })
  .option('user', {
    type: 'string',
    default: 'root',
    describe: 'SSH username with sudo privileges (default: root)',
  })
  .option('password', {
    type: 'string',
    demandOption: true,
    describe: 'SSH password for the user (used for root login)',
  })
  .option('domain', {
    type: 'string',
    demandOption: true,
    describe: 'Domain/subdomain that already resolves to this VPS',
  })
  .option('admin-user', {
    type: 'string',
    default: 'Admin',
    describe: 'Desired Npanel admin username',
  })
  .option('admin-pass', {
    type: 'string',
    default: 'ChangeMe123!',
    describe: 'Desired Npanel admin password',
  })
  .option('main-port', {
    type: 'number',
    default: 443,
    describe: 'Main TLS port exposed by Npanel',
  })
  .option('websocket-path', {
    type: 'string',
    default: '/fetch',
    describe: 'Websocket path to use in Npanel config',
  })
  .option('fake-template', {
    type: 'number',
    default: 2,
    describe: 'Fake website template ID (matches manual setup)',
  })
  .help()
  .alias('h', 'help')
  .strict()
  .argv;

const SSH_TIMEOUT = 60000;

function createPanelConfig(options) {
  const {
    domain,
    adminUser,
    adminPass,
    mainPort,
    websocketPath,
    fakeTemplate,
  } = options;

  return {
    admin_username: adminUser,
    admin_password: adminPass,
    domain,
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
}

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log('SSH connection established.');
      resolve(conn);
    });
    conn.on('error', reject);
    conn.connect({
      host: argv.host,
      port: argv.sshPort,
      username: argv.user,
      password: argv.password,
      readyTimeout: SSH_TIMEOUT,
    });
  });
}

function wrapInBash(command) {
  const escaped = command.replace(/(["$`\\])/g, '\\$1');
  return `/bin/bash -lc "set -euo pipefail; ${escaped}"`;
}

function execCommand(conn, command, description) {
  const finalCommand = wrapInBash(command);
  return new Promise((resolve, reject) => {
    console.log(`\n→ ${description}`);
    let stdout = '';
    let stderr = '';
    conn.exec(finalCommand, { pty: true }, (err, stream) => {
      if (err) {
        return reject(err);
      }
      stream.on('close', (code) => {
        if (stdout.trim()) {
          console.log(stdout.trim());
        }
        if (stderr.trim()) {
          console.error(stderr.trim());
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
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

async function run() {
  const conn = await connectSSH();
  try {
    const steps = [
      {
        description: 'Updating apt sources',
        command: 'export DEBIAN_FRONTEND=noninteractive && apt-get update',
      },
      {
        description: 'Upgrading base system packages',
        command: 'export DEBIAN_FRONTEND=noninteractive && apt-get upgrade -y',
      },
      {
        description: 'Installing required packages',
        command: 'apt-get install -y curl wget unzip ufw certbot',
      },
      {
        description: 'Stopping any old Npanel instance',
        command: 'systemctl stop npanel || true',
      },
      {
        description: `Issuing TLS certificate for ${argv.domain}`,
        command: `certbot certonly --non-interactive --standalone --agree-tos --register-unsafely-without-email -d ${argv.domain}`,
      },
      {
        description: 'Downloading Npanel install script',
        command:
          'cd /root && rm -f install.sh && wget "https://raw.githubusercontent.com/Leiren/Npanel/master/scripts/install.sh" -O install.sh',
      },
      {
        description: 'Running Npanel installer (auto-confirm prompt)',
        command: 'cd /root && chmod +x install.sh && printf \'y\\n\' | bash install.sh',
      },
      {
        description: 'Allowing SSH through UFW',
        command: 'ufw allow 22/tcp',
      },
      {
        description: 'Allowing HTTP through UFW',
        command: 'ufw allow 80/tcp',
      },
      {
        description: 'Allowing HTTPS through UFW',
        command: 'ufw allow 443/tcp',
      },
      {
        description: 'Enabling firewall',
        command: 'ufw --force enable',
      },
      {
        description: 'Reloading firewall rules',
        command: 'ufw reload',
      },
      {
        description: 'Stopping Npanel to apply new config',
        command: 'service npanel stop',
      },
    ];

    for (const step of steps) {
      await execCommand(conn, step.command, step.description);
    }

    const panelConfig = createPanelConfig({
      domain: argv.domain,
      adminUser: argv.adminUser,
      adminPass: argv.adminPass,
      mainPort: argv.mainPort,
      websocketPath: argv.websocketPath,
      fakeTemplate: argv.fakeTemplate,
    });

    const writeConfigCommand = `cat <<'EOF' > /opt/Npanel/panel.json
${JSON.stringify(panelConfig, null, 2)}
EOF`;

    await execCommand(conn, writeConfigCommand, 'Writing /opt/Npanel/panel.json');

    await execCommand(conn, 'service npanel start', 'Starting Npanel');
    await execCommand(conn, 'echo "BITTI"', 'Final confirmation');

    console.log('\n✅ VPS provisioning complete. Npanel is up.');
  } catch (error) {
    console.error('\n❌ Automation failed:', error.message);
    process.exitCode = 1;
  } finally {
    conn.end();
  }
}

run();
