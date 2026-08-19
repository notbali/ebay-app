const { test } = require('node:test');
const assert = require('node:assert/strict');

// encrypt/decrypt read TOKEN_ENCRYPTION_KEY lazily per call, so it's safe to set here before
// requiring the module.
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex-encoded

const { encrypt, decrypt } = require('../services/cryptoService');

test('encrypt + decrypt round-trips an eBay refresh token', () => {
  const token = 'v^1.1#i^1#f^0#p^3#r^1#I^3#t^some-refresh-token-value';
  assert.equal(decrypt(encrypt(token)), token);
});

test('encrypt produces a different ciphertext each time (random IV)', () => {
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notEqual(a, b);
});

test('decrypt rejects a tampered ciphertext (GCM auth tag check)', () => {
  const payload = encrypt('sensitive-token');
  const [iv, tag, ciphertext] = payload.split(':');
  const flipped = Buffer.from(ciphertext, 'base64');
  flipped[0] ^= 0xff;
  const tampered = `${iv}:${tag}:${flipped.toString('base64')}`;
  assert.throws(() => decrypt(tampered));
});

test('decrypt rejects a malformed payload without a confusing crash', () => {
  assert.throws(() => decrypt('not-a-valid-payload'));
});
