const crypto = require('crypto');

// Transparent column-level encryption for secrets stored at rest
// (server SSH passwords, NPanel admin passwords, per-app HMAC secrets).
// Envelope format: "v1:<ivB64>:<authTagB64>:<cipherB64>" (AES-256-GCM).
// Values that are not prefixed with "v1:" are returned verbatim so plaintext
// or legacy rows keep working during a transition.

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function getKey() {
  const hex = process.env.DB_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'DB_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Generate one with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  // Pass through null/undefined/'' so optional columns and defaults are untouched.
  if (plain === null || plain === undefined || plain === '') return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
  if (blob === null || blob === undefined || blob === '') return blob;

  const str = String(blob);
  // Tolerate plaintext / legacy values that were never encrypted.
  if (!str.startsWith(`${VERSION}:`)) return blob;

  const [, ivB64, tagB64, dataB64] = str.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // Fail loud rather than silently returning corrupted data — almost always a key mismatch.
    throw new Error('Failed to decrypt an encrypted column (DB_ENCRYPTION_KEY mismatch?)');
  }
}

// Helper to build a Sequelize attribute whose value is encrypted at rest and
// decrypted transparently on read. fieldName must equal the attribute key.
function encryptedAttr(DataTypes, fieldName, extra = {}) {
  return {
    type: DataTypes.STRING(512),
    ...extra,
    set(value) {
      this.setDataValue(fieldName, encrypt(value));
    },
    get() {
      return decrypt(this.getDataValue(fieldName));
    },
  };
}

module.exports = { encrypt, decrypt, encryptedAttr };
