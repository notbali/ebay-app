const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  hashPassword, verifyPassword, dummyVerifyPassword, MAX_PASSWORD_LENGTH, createSessionToken, hashSessionToken,
  signCookieValue, verifyCookieValue,
} = require('../services/authService');

test('hashPassword + verifyPassword round-trips correctly', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('hashPassword salts each hash differently for the same password', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
});

test('verifyPassword does not throw on a malformed stored hash', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-real-hash'), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('verifyPassword accepts a hash made by the old synchronous implementation (existing accounts keep working)', async () => {
  // Exactly what the pre-async hashPassword stored: "<saltHex>:<scrypt(password, salt, 64) hex>".
  const salt = crypto.randomBytes(16);
  const legacy = `${salt.toString('hex')}:${crypto.scryptSync('legacy-password', salt, 64).toString('hex')}`;
  assert.equal(await verifyPassword('legacy-password', legacy), true);
  assert.equal(await verifyPassword('not-it', legacy), false);
});

test('hashPassword and verifyPassword return promises', () => {
  const pending = hashPassword('whatever-password');
  assert.ok(pending instanceof Promise);
  assert.ok(verifyPassword('x', 'y:z') instanceof Promise);
  return pending;
});

test('hashing does not block the event loop (other requests are served while it runs)', async () => {
  let timerFired = false;
  setImmediate(() => { timerFired = true; });
  const pending = hashPassword('some-long-password-value');
  // scryptSync would have run to completion before this line, and the immediate could not have
  // fired yet either way - the point is the immediate fires *before* the hash resolves.
  assert.equal(timerFired, false);
  await pending;
  assert.equal(timerFired, true);
});

test('dummyVerifyPassword always resolves false but does real hashing work (login timing for unknown emails)', async () => {
  const start = process.hrtime.bigint();
  assert.equal(await dummyVerifyPassword('anything-at-all'), false);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms > 1, `expected a real scrypt computation, took only ${ms}ms`);
});

test('MAX_PASSWORD_LENGTH is exported and generous enough for passphrases', () => {
  assert.ok(MAX_PASSWORD_LENGTH >= 64 && MAX_PASSWORD_LENGTH <= 1024);
});

test('createSessionToken produces distinct, high-entropy tokens', () => {
  const a = createSessionToken();
  const b = createSessionToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 64); // 32 bytes hex-encoded
});

test('hashSessionToken is deterministic (same token -> same hash, for DB lookup)', () => {
  const token = createSessionToken();
  assert.equal(hashSessionToken(token), hashSessionToken(token));
});

test('hashSessionToken never stores the raw token (hash differs from input)', () => {
  const token = createSessionToken();
  assert.notEqual(hashSessionToken(token), token);
});

test('signCookieValue + verifyCookieValue round-trips correctly', () => {
  const signed = signCookieValue('user-session-value', 'test-secret');
  assert.equal(verifyCookieValue(signed, 'test-secret'), 'user-session-value');
});

test('verifyCookieValue rejects a tampered value', () => {
  const signed = signCookieValue('42.1700000000000', 'test-secret');
  const [value, sig] = signed.split('.');
  const tampered = `99.1700000000000.${sig}`;
  assert.equal(verifyCookieValue(tampered, 'test-secret'), null);
});

test('verifyCookieValue rejects a value signed with a different secret', () => {
  const signed = signCookieValue('user-session-value', 'secret-a');
  assert.equal(verifyCookieValue(signed, 'secret-b'), null);
});

test('verifyCookieValue rejects garbage input without throwing', () => {
  assert.equal(verifyCookieValue('not-a-signed-value', 'test-secret'), null);
  assert.equal(verifyCookieValue('', 'test-secret'), null);
  assert.equal(verifyCookieValue(null, 'test-secret'), null);
});
