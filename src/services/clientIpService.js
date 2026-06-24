const net = require('net');

// Published Cloudflare edge ranges (https://www.cloudflare.com/ips/). Used to
// decide whether the immediate TCP peer is a Cloudflare proxy when CF_ENFORCE
// is on, so CF-Connecting-IP can be trusted (and non-CF peers rejected).
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

// Normalise an IP string: strip a zone id and unwrap IPv4-mapped IPv6
// (::ffff:1.2.3.4 -> 1.2.3.4) so it matches the IPv4 ranges.
function normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (v.toLowerCase().startsWith('::ffff:') && v.includes('.')) {
    v = v.slice(7);
  }
  return v;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// Expand an IPv6 address to its 16 bytes (handles :: compression).
function ipv6ToBytes(ip) {
  if (!net.isIPv6(ip)) return null;
  let head = ip;
  let tail = '';
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    head = h;
    tail = t;
  }
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const groups = [
    ...headGroups,
    ...Array(missing).fill('0'),
    ...tailGroups,
  ];
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const val = parseInt(groups[i] || '0', 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[(i * 2) + 1] = val & 0xff;
  }
  return bytes;
}

function ipv6InCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipBytes = ipv6ToBytes(ip);
  const rangeBytes = ipv6ToBytes(range);
  if (!ipBytes || !rangeBytes) return false;
  let remaining = bits;
  for (let i = 0; i < 16 && remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

function isCloudflareIp(ip) {
  const v = normalizeIp(ip);
  if (!v) return false;
  if (net.isIPv4(v)) return CLOUDFLARE_IPV4.some((cidr) => ipv4InCidr(v, cidr));
  if (net.isIPv6(v)) return CLOUDFLARE_IPV6.some((cidr) => ipv6InCidr(v, cidr));
  return false;
}

// The immediate TCP peer. With `trust proxy` set, Express exposes the real
// socket peer on req.connection/req.socket.remoteAddress.
function peerAddress(req) {
  return (req.socket && req.socket.remoteAddress)
    || (req.connection && req.connection.remoteAddress)
    || null;
}

function cfEnforced() {
  return process.env.CF_ENFORCE === 'true';
}

// Resolves the true client IP behind Cloudflare. CF-Connecting-IP is
// authoritative when present; otherwise fall back to the first X-Forwarded-For
// hop, then Express's req.ip (which honours `trust proxy`). Used everywhere a
// client IP is logged so legal/court-order records hold the real address, not a
// Cloudflare edge IP. When CF_ENFORCE=true, CF-Connecting-IP is only trusted if
// the immediate peer is a known Cloudflare edge (prevents header spoofing).
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) {
    if (!cfEnforced() || isCloudflareIp(peerAddress(req))) {
      return String(cf).trim();
    }
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
}

// Rejects /v1 requests whose immediate peer is not a Cloudflare edge when
// CF_ENFORCE=true. No-op otherwise so local/dev keeps working.
function cloudflareGuardMiddleware(req, res, next) {
  if (!cfEnforced()) return next();
  if (isCloudflareIp(peerAddress(req))) return next();
  return res.status(403).json({ error: 'origin_not_trusted' });
}

module.exports = {
  getClientIp,
  cloudflareGuardMiddleware,
  isCloudflareIp,
};
