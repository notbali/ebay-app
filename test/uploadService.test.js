const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { safeUploadFilename, isAllowedImageMimetype } = require('../services/uploadService');

test('safeUploadFilename strips directory traversal from a malicious originalname', () => {
  const result = safeUploadFilename('../../../../etc/cron.d/evil');
  assert.equal(path.basename(result), result, `expected no path separators, got "${result}"`);
  assert.ok(!result.includes('..'), `expected no ".." segments, got "${result}"`);
});

test('safeUploadFilename strips an absolute path passed as originalname', () => {
  const result = safeUploadFilename('/etc/passwd');
  assert.equal(path.basename(result), result, `expected no path separators, got "${result}"`);
});

test('safeUploadFilename keeps a normal filename intact (suffixed, not mangled)', () => {
  const result = safeUploadFilename('relay-photo.jpg');
  assert.ok(result.endsWith('-relay-photo.jpg'), `expected original name preserved as suffix, got "${result}"`);
});

test('safeUploadFilename never collides for the same input across separate calls', () => {
  const a = safeUploadFilename('part.jpg');
  const b = safeUploadFilename('part.jpg');
  assert.notEqual(a, b);
});

test('isAllowedImageMimetype accepts real image types', () => {
  assert.equal(isAllowedImageMimetype('image/jpeg'), true);
  assert.equal(isAllowedImageMimetype('image/png'), true);
  assert.equal(isAllowedImageMimetype('image/webp'), true);
});

test('isAllowedImageMimetype rejects SVG (can embed executable script content)', () => {
  assert.equal(isAllowedImageMimetype('image/svg+xml'), false);
});

test('isAllowedImageMimetype rejects non-image types entirely', () => {
  assert.equal(isAllowedImageMimetype('text/html'), false);
  assert.equal(isAllowedImageMimetype('application/octet-stream'), false);
  assert.equal(isAllowedImageMimetype('application/javascript'), false);
});
