const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkRateLimit, resetRateLimit } = require('../services/rateLimitService');

test('allows attempts under the max within the window', () => {
  const key = 'ip:1.2.3.4:test-under-max';
  resetRateLimit(key);
  const now = 1000000;
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now }), true);
  }
});

test('blocks once the max attempts in the window is exceeded', () => {
  const key = 'ip:1.2.3.4:test-over-max';
  resetRateLimit(key);
  const now = 1000000;
  for (let i = 0; i < 5; i++) checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now });
  assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now }), false);
});

test('resets the count after the window elapses', () => {
  const key = 'ip:1.2.3.4:test-window-reset';
  resetRateLimit(key);
  const start = 1000000;
  for (let i = 0; i < 5; i++) checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now: start });
  assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now: start }), false);

  const afterWindow = start + 60001;
  assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now: afterWindow }), true);
});

test('tracks separate keys independently (one IP/email exhausting its limit does not affect another)', () => {
  const keyA = 'ip:1.1.1.1:test-independent';
  const keyB = 'ip:2.2.2.2:test-independent';
  resetRateLimit(keyA);
  resetRateLimit(keyB);
  const now = 1000000;
  for (let i = 0; i < 5; i++) checkRateLimit(keyA, { maxAttempts: 5, windowMs: 60000, now });
  assert.equal(checkRateLimit(keyA, { maxAttempts: 5, windowMs: 60000, now }), false);
  assert.equal(checkRateLimit(keyB, { maxAttempts: 5, windowMs: 60000, now }), true);
});

test('resetRateLimit clears a key immediately (used after a successful login)', () => {
  const key = 'ip:3.3.3.3:test-reset-clears';
  const now = 1000000;
  for (let i = 0; i < 5; i++) checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now });
  assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now }), false);
  resetRateLimit(key);
  assert.equal(checkRateLimit(key, { maxAttempts: 5, windowMs: 60000, now }), true);
});
