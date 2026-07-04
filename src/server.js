const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');

// Create default .env before loading environment variables on first run.
const envPath = path.join(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
    const template = [
        '# Admin panel',
        'ADMIN_PASSWORD=admin123',
        `ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
        'PORT=3210',
        '',
        '# Database (MySQL). For local dev without MySQL, set DB_DIALECT=sqlite',
        'DB_DIALECT=mysql',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_USER=npanel',
        'DB_PASSWORD=',
        'DB_NAME=npanel',
        '',
        '# 32-byte hex key encrypting secrets at rest (server/admin/user passwords)',
        `DB_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`,
        '',
        '# Mobile API attestation: development (mock) or strict (App Attest / Play Integrity)',
        'MOBILE_ATTESTATION_MODE=development',
        '',
        '# Email alerts (optional). Leave SMTP_HOST empty to disable email alerts.',
        'SMTP_HOST=',
        'SMTP_PORT=587',
        'SMTP_SECURE=false',
        'SMTP_USER=',
        'SMTP_PASS=',
        'SMTP_FROM=',
        'ALERT_EMAIL_TO=',
        '',
    ].join('\n');
    fs.writeFileSync(envPath, template);
    console.log('.env file created with default password: admin123 (set DB_* values before using MySQL)');
}

require('dotenv').config();

const { sequelize } = require('./models/Database');

const app = express();
// Behind Cloudflare (optionally + a reverse proxy). Trust a fixed number of
// proxy hops so req.ip / X-Forwarded-For are honoured without being spoofable
// (never `true`). CF-Connecting-IP is still the source of truth — see clientIpService.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3210;

// Same-origin admin panel needs no CORS; lock cross-origin to ADMIN_ORIGIN when set.
const corsOptions = process.env.ADMIN_ORIGIN
  ? { origin: process.env.ADMIN_ORIGIN.split(',').map((o) => o.trim()) }
  : {};
app.use(cors(corsOptions));
// Baseline hardening headers (admin UI + API alike).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const cron = require('node-cron');
const apiRoutes = require('./routes/api');
const monitorService = require('./services/monitorService');
const terminalService = require('./services/terminalService');
const connectionLogService = require('./services/connectionLogService');
const { pruneRateLimitBuckets } = require('./services/mobileSecurityService');
const { migrator } = require('./migrations/umzug');

const AUDIT_LOG_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 90);
const CONNECTION_LOG_RETENTION_DAYS = Number(process.env.CONNECTION_LOG_RETENTION_DAYS || 365);

app.set('io', io);
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});
app.use('/api', apiRoutes);

// Initialize Terminal Service with IO
terminalService(io);

async function bootstrapDatabase() {
  await sequelize.authenticate();
  const pending = await migrator.pending();
  if (pending.length) {
    console.log(`Running ${pending.length} pending migration(s): ${pending.map((m) => m.name).join(', ')}`);
    await migrator.up();
    console.log('Migrations applied');
  } else {
    console.log('Database schema up to date');
  }
}

async function start() {
  if (process.env.MOBILE_ATTESTATION_MODE !== 'strict') {
    console.warn('WARNING: attestation in development mode — not for production. Set MOBILE_ATTESTATION_MODE=strict.');
  }
  await bootstrapDatabase();
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Close orphaned connection-log sessions hourly (app killed without /sessions/stop).
  cron.schedule('0 * * * *', () => {
    connectionLogService.sweepStale().catch((err) => console.error('Connection log sweep failed:', err.message));
  });

  // Purge expired nonces + prune in-memory rate-limit buckets hourly.
  cron.schedule('15 * * * *', () => {
    connectionLogService.purgeExpiredNonces().catch((err) => console.error('Nonce purge failed:', err.message));
    pruneRateLimitBuckets();
  });

  // Retention: trim audit + connection logs daily to their configured horizons.
  cron.schedule('30 3 * * *', () => {
    connectionLogService.purgeOldAuditLogs(AUDIT_LOG_RETENTION_DAYS)
      .catch((err) => console.error('Audit log purge failed:', err.message));
    connectionLogService.purgeOldConnectionLogs(CONNECTION_LOG_RETENTION_DAYS)
      .catch((err) => console.error('Connection log purge failed:', err.message));
  });

  // Health monitor: TLS liveness + SSH reachability + incident/alert bookkeeping.
  cron.schedule('*/3 * * * *', () => {
    monitorService.runHealthPass().catch((err) => console.error('Health pass failed:', err.message));
  });

  // Reconcile managed trojan-go users (persistence after restarts) + pull live
  // traffic counters back onto the panel.
  cron.schedule('*/15 * * * *', () => {
    monitorService.runUserSyncPass().catch((err) => console.error('User sync pass failed:', err.message));
  });

  // Certificate auto-renewal: renew certs nearing expiry, alert on failure.
  cron.schedule('45 3 * * *', () => {
    monitorService.runCertRenewalPass().catch((err) => console.error('Cert renewal pass failed:', err.message));
  });

  // Hourly: functionally test every published config over a real trojan tunnel;
  // alert per-config the moment one fails.
  cron.schedule('20 * * * *', () => {
    monitorService.runConfigTestPass().catch((err) => console.error('Config test pass failed:', err.message));
  });

  // Kick an initial health pass shortly after boot so the panel isn't blank.
  setTimeout(() => {
    monitorService.runHealthPass().catch((err) => console.error('Initial health pass failed:', err.message));
  }, 5000);
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
