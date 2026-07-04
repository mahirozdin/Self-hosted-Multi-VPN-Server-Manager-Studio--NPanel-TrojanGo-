const sshService = require('./sshService');
const monitorService = require('./monitorService');
const {
  Server,
  ProvisionJob,
  ProvisionStep,
} = require('../models/Database');
const {
  ensureCountryAndGroupForServer,
  ensureDefaultCatalog,
  syncDefaultUsers,
} = require('./npanelUserService');
const { publishServerCatalog } = require('./catalogPublishService');

const STEP_DEFINITIONS = [
  ['ssh_connect', 'SSH connection'],
  ['apt_update', 'Update base packages'],
  ['dependencies', 'Install dependencies'],
  ['certbot', 'Issue TLS certificate'],
  ['npanel_install', 'Install NPanel'],
  ['panel_config', 'Write panel config'],
  ['npanel_start', 'Start NPanel'],
  ['user_sync', 'Create default VPN users'],
  ['health_check', 'Health check'],
];

function redact(value) {
  if (!value) return value;
  const secrets = [
    process.env.ADMIN_PASSWORD,
    process.env.ADMIN_SESSION_SECRET,
  ].filter(Boolean);
  let output = String(value);
  for (const secret of secrets) {
    output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(/password=[^\s]+/gi, 'password=[redacted]')
    .replace(/("admin_password"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2');
}

async function emitJob(io, jobId) {
  if (!io) return;
  const job = await getJob(jobId);
  io.emit('provision:update', sanitizeJob(job));
}

async function getJob(jobId) {
  return ProvisionJob.findByPk(jobId, {
    include: [
      { model: Server, as: 'server' },
      { model: ProvisionStep, as: 'steps' },
    ],
    order: [[{ model: ProvisionStep, as: 'steps' }, 'sort_order', 'ASC']],
  });
}

function sanitizeJob(job) {
  const row = job?.toJSON ? job.toJSON() : job;
  if (row?.server) {
    delete row.server.password;
    delete row.server.admin_pass;
  }
  return row;
}

async function createJob(serverId) {
  const job = await ProvisionJob.create({
    server_id: serverId,
    status: 'queued',
  });

  await Promise.all(STEP_DEFINITIONS.map(([key, label], index) => (
    ProvisionStep.create({
      job_id: job.id,
      key,
      label,
      sort_order: index,
      status: 'pending',
    })
  )));

  return job;
}

async function runStep(io, job, key, action) {
  const step = await ProvisionStep.findOne({ where: { job_id: job.id, key } });
  await job.update({ status: 'running', current_step: key, started_at: job.started_at || new Date() });
  await step.update({ status: 'running', started_at: new Date(), error_message: null });
  await emitJob(io, job.id);

  try {
    const result = await action();
    await step.update({
      status: result?.status || 'success',
      stdout: redact(result?.stdout || ''),
      stderr: redact(result?.stderr || ''),
      finished_at: new Date(),
    });
    await emitJob(io, job.id);
    return result;
  } catch (error) {
    await step.update({
      status: 'error',
      error_message: redact(error.message),
      stderr: redact(error.stack || error.message),
      finished_at: new Date(),
    });
    await job.update({
      status: 'error',
      error_message: redact(error.message),
      finished_at: new Date(),
    });
    await emitJob(io, job.id);
    throw error;
  }
}

function createPanelConfig(options) {
  const {
    domain,
    adminUser = 'Admin',
    adminPass = 'ChangeMe123!',
    mainPort = 443,
    websocketPath = '/fetch',
    fakeTemplate = 2,
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

async function runInstall(serverId, serverConfig, options = {}, io = null) {
  const server = await Server.findByPk(serverId);
  if (!server) throw new Error('Server not found');

  const job = options.job || await createJob(server.id);
  let conn;

  try {
    await runStep(io, job, 'ssh_connect', async () => {
      conn = await sshService.connect(serverConfig);
      return { stdout: `Connected to ${serverConfig.ip}` };
    });

    await runStep(io, job, 'apt_update', async () => sshService.execCommand(
      conn,
      'export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get upgrade -y',
    ));

    await runStep(io, job, 'dependencies', async () => sshService.execCommand(
      conn,
      'apt-get install -y curl wget unzip ufw certbot',
    ));

    await runStep(io, job, 'certbot', async () => sshService.execCommand(
      conn,
      `systemctl stop npanel || true; certbot certonly --non-interactive --standalone --agree-tos --register-unsafely-without-email -d ${options.domain}`,
    ));

    await runStep(io, job, 'npanel_install', async () => sshService.execCommand(
      conn,
      'cd /root && rm -f install.sh && wget "https://raw.githubusercontent.com/Leiren/Npanel/master/scripts/install.sh" -O install.sh && chmod +x install.sh && printf \'y\\n\' | bash install.sh && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable && ufw reload',
    ));

    await runStep(io, job, 'panel_config', async () => {
      const panelConfig = createPanelConfig(options);
      return sshService.execCommand(
        conn,
        `service npanel stop || true; cat <<'EOF' > /opt/Npanel/panel.json\n${JSON.stringify(panelConfig, null, 2)}\nEOF`,
      );
    });

    await runStep(io, job, 'npanel_start', async () => sshService.execCommand(
      conn,
      'service npanel start',
    ));

    const users = await runStep(io, job, 'user_sync', async () => {
      const autoPublish = options.publish && options.publish.autoPublish === true;
      // Create the users on the box via the trojan-go API, then wire the catalog.
      const desiredUsers = await syncDefaultUsers(server, { remote: true });
      const { country, group } = await ensureCountryAndGroupForServer(server, options.country || {});
      await ensureDefaultCatalog(server, desiredUsers, country.id, group.id, { activate: autoPublish });
      if (autoPublish) {
        await publishServerCatalog(server, { appId: options.publish.appId != null ? options.publish.appId : null, activate: true });
      }
      return {
        stdout: `Created ${desiredUsers.length} users on trojan-go. Status: ${desiredUsers.map((user) => `${user.name}:${user.remote_status}`).join(', ')}${autoPublish ? ' | published to mobile API' : ''}`,
      };
    });

    await runStep(io, job, 'health_check', async () => {
      await monitorService.updateServerStatus(server);
      return { stdout: 'Server status refreshed' };
    });

    await server.update({ status: 'online', last_ssl_renew: new Date() });
    await job.update({ status: 'success', current_step: 'complete', finished_at: new Date() });
    await emitJob(io, job.id);
    return { job, users };
  } catch (error) {
    await server.update({ status: 'error' });
    throw error;
  } finally {
    if (conn) conn.end();
  }
}

module.exports = {
  STEP_DEFINITIONS,
  createJob,
  getJob,
  sanitizeJob,
  runInstall,
  createPanelConfig,
};
