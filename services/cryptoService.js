const crypto = require('crypto');

// Encrypts secrets before they're stored in the DB (per-user eBay refresh tokens) so a leaked
// DB file alone isn't enough to act as any seller - the key lives only in TOKEN_ENCRYPTION_KEY.
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error('TOKEN_ENCRYPTION_KEY is not set - required to store eBay tokens');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes hex-encoded (64 hex chars)');
  }
  return key;
}

// Stored as "<ivB64>:<authTagB64>:<ciphertextB64>".
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(payload) {
  const [ivB64, tagB64, ciphertextB64] = String(payload).split(':');
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error('Malformed encrypted payload');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
