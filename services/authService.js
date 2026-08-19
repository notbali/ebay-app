const crypto = require('crypto');

// Password hashing via Node's built-in scrypt (no bcrypt dependency, consistent with this app's
// zero-extra-auth-deps approach). Stored as "<saltHex>:<hashHex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  // Lengths always match (scrypt with fixed keylen 64) but timingSafeEqual throws on mismatch,
  // so guard first rather than let a malformed stored hash crash the request.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Raw session token goes in the cookie; only its SHA-256 hash is ever stored in the DB, so a
// leaked DB row alone can't be replayed as a session.
function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Manual cookie signing (HMAC-SHA256) since no cookie-parser/express-session dependency exists.
// Format: "<value>.<signatureHex>".
function signCookieValue(value, secret) {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${sig}`;
}

function verifyCookieValue(signed, secret) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(value).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return value;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  signCookieValue,
  verifyCookieValue,
};
