const settingsService = require('./settingsService');

// Email alerts (server down/recovered, cert renewal outcome, provision failures).
// SMTP config comes from env; recipient from Settings.alert_email (fallback env
// ALERT_EMAIL_TO). No-ops with a warning when SMTP isn't configured, so the panel
// runs fine without email set up. Sends are de-duplicated by key + min-gap so a
// flapping server can't spam the inbox.

let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null;
}

let transporter = null;
let transporterKey = '';
const lastSent = new Map(); // dedupKey -> epoch ms
const DEFAULT_MIN_GAP_MS = 10 * 60 * 1000;

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  };
}

function isConfigured() {
  const c = smtpConfig();
  return Boolean(nodemailer && c.host && c.from);
}

function getTransporter() {
  const c = smtpConfig();
  const key = `${c.host}:${c.port}:${c.secure}:${c.user}`;
  if (transporter && transporterKey === key) return transporter;
  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  transporterKey = key;
  return transporter;
}

async function resolveRecipient(explicitTo) {
  if (explicitTo) return explicitTo;
  const configured = await settingsService.get('alert_email', '');
  return configured || process.env.ALERT_EMAIL_TO || '';
}

// Low-level send. Returns { ok, skipped?, error? }.
async function sendMail({ subject, text, html, to } = {}) {
  if (!isConfigured()) {
    console.warn(`[notify] SMTP not configured — skipped email: ${subject}`);
    return { ok: false, skipped: true, reason: 'smtp_not_configured' };
  }
  const recipient = await resolveRecipient(to);
  if (!recipient) {
    console.warn(`[notify] no alert recipient set — skipped email: ${subject}`);
    return { ok: false, skipped: true, reason: 'no_recipient' };
  }
  try {
    const c = smtpConfig();
    await getTransporter().sendMail({
      from: c.from,
      to: recipient,
      subject,
      text: text || undefined,
      html: html || undefined,
    });
    return { ok: true };
  } catch (error) {
    console.error(`[notify] email send failed (${subject}):`, error.message);
    return { ok: false, error: error.message };
  }
}

// Alert with de-dup: within minGapMs, a repeated dedupKey is suppressed.
async function sendAlert(subject, body, options = {}) {
  const dedupKey = options.dedupKey || subject;
  const minGap = options.minGapMs != null ? options.minGapMs : DEFAULT_MIN_GAP_MS;
  const now = Date.now();
  const prev = lastSent.get(dedupKey) || 0;
  if (now - prev < minGap) {
    return { ok: false, skipped: true, reason: 'deduped' };
  }
  lastSent.set(dedupKey, now);
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const html = options.html || `<pre style="font:14px/1.5 monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  const result = await sendMail({ subject: `[VPN Panel] ${subject}`, text, html, to: options.to });
  // If the send was skipped/failed, don't burn the dedup window.
  if (!result.ok) lastSent.delete(dedupKey);
  return result;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Send a test email regardless of dedup (used by the Settings "test" button).
async function sendTest(to) {
  return sendMail({
    subject: '[VPN Panel] Test alert',
    text: 'This is a test alert from NPanel Manager Studio. Email alerts are configured correctly.',
    to,
  });
}

module.exports = {
  isConfigured,
  smtpConfig,
  sendMail,
  sendAlert,
  sendTest,
};
