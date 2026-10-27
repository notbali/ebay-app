const crypto = require('crypto');
const { promisify } = require('util');

// Password hashing via Node's built-in scrypt (no bcrypt dependency, consistent with this app's
// zero-extra-auth-deps approach). Stored as "<saltHex>:<hashHex>".
//
// Uses the async crypto.scrypt (runs on libuv's threadpool) rather than scryptSync: each hash
// takes tens of milliseconds of CPU, and the sync version froze this single-process server -
// every other request included - for that whole time on every login and signup. Same algorithm
// and parameters as before, so hashes already stored in the DB still verify.
const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

// scrypt spends time proportional to the password's length, so an unbounded password is a cheap
// way to burn CPU. Generous enough for any passphrase.
const MAX_PASSWORD_LENGTH = 128;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  // timingSafeEqual throws on a length mismatch, so a malformed stored hash is rejected up front
  // rather than crashing the request (and without wasting a scrypt run on it).
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expected);
}

// Login for an email that has no account should take as long as one with a wrong password -
// otherwise response time reveals which emails are registered. Does a real verification against a
// throwaway hash (computed once, lazily) and always answers false.
let dummyHashPromise = null;
async function dummyVerifyPassword(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHashPromise);
  return false;
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
  dummyVerifyPassword,
  MAX_PASSWORD_LENGTH,
  createSessionToken,
  hashSessionToken,
  signCookieValue,
  verifyCookieValue,
};
