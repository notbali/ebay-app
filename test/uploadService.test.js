const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { safeUploadFilename, isAllowedImageMimetype, sniffImageBuffer, sniffImageFile } = require('../services/uploadService');

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

test('sniffImageBuffer identifies real image signatures regardless of any claimed mimetype', () => {
  assert.equal(sniffImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImageBuffer(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(
    sniffImageBuffer(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')])),
    'image/webp'
  );
});

test('sniffImageBuffer rejects a file that only claims to be an image (e.g. spoofed Content-Type)', () => {
  // The bytes an attacker would actually have to smuggle a script past a client-declared
  // "image/jpeg" Content-Type - see the "rejects SVG" test above for why this matters.
  assert.equal(sniffImageBuffer(Buffer.from('<script>alert(1)</script>', 'ascii')), null);
  assert.equal(sniffImageBuffer(Buffer.from('<svg onload=alert(1)>', 'ascii')), null);
});

test('sniffImageBuffer rejects a buffer too short to contain any valid signature', () => {
  assert.equal(sniffImageBuffer(Buffer.from([0xff])), null);
  assert.equal(sniffImageBuffer(Buffer.alloc(0)), null);
});

test('sniffImageFile reads a real file on disk and sniffs its signature', () => {
  const tmpFile = path.join(os.tmpdir(), `sniff-test-${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]));
  try {
    assert.equal(sniffImageFile(tmpFile), 'image/jpeg');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('sniffImageFile returns null for a non-image file regardless of its extension', () => {
  const tmpFile = path.join(os.tmpdir(), `sniff-test-${Date.now()}.jpg`);
  fs.writeFileSync(tmpFile, '<script>alert(1)</script>');
  try {
    assert.equal(sniffImageFile(tmpFile), null);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
