const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword, verifyPassword, createSessionToken, hashSessionToken,
  signCookieValue, verifyCookieValue,
} = require('../services/authService');

test('hashPassword + verifyPassword round-trips correctly', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', hash), true);
});

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('hashPassword salts each hash differently for the same password', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
});

test('verifyPassword does not throw on a malformed stored hash', () => {
  assert.equal(verifyPassword('anything', 'not-a-real-hash'), false);
  assert.equal(verifyPassword('anything', ''), false);
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
