const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPhotoUpload, verifyUploadedImages } = require('../services/photoUpload');

// Real multipart requests against a throwaway server, so these exercise multer itself rather than
// a mock - the point is to catch behavior changes when multer is upgraded.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (size = 64) => Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, size - PNG_HEADER.length), 1)]);

let server;
let baseUrl;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-upload-'));
  const upload = createPhotoUpload(dir);
  const app = express();
  app.post('/up', upload.array('photos', 12), verifyUploadedImages, (req, res) => {
    res.json({ files: (req.files || []).map((f) => path.basename(f.path)), notes: req.body.notes });
  });
  // Same shape as server.js's generic handler, plus the multer error code so tests can tell
  // limit violations apart from other failures.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status || err.statusCode || 500).json({ error: err.message, code: err.code });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const filesOnDisk = () => fs.readdirSync(dir);

// verifyUploadedImages deletes rejected files fire-and-forget (fs.unlink with a no-op callback)
// after the 400 has already gone out, so the dir can briefly still hold them when the response
// arrives - wait for that cleanup instead of asserting on the instant the response lands.
async function filesOnDiskOnceSettled(expectedCount = 0, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (filesOnDisk().length !== expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return filesOnDisk();
}

function post(parts, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const { name, type, bytes } of parts) form.append('photos', new Blob([bytes], { type }), name);
  return fetch(`${baseUrl}/up`, { method: 'POST', body: form });
}

test('accepts real images, saves them under the upload dir, and passes text fields through', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const res = await post([
    { name: 'a.png', type: 'image/png', bytes: pngBytes() },
    { name: 'b.png', type: 'image/png', bytes: pngBytes() },
  ], { notes: 'Omron relay' });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.files.length, 2);
  assert.equal(body.notes, 'Omron relay');
  assert.deepEqual(filesOnDisk().sort(), body.files.slice().sort());
});

test('silently drops a file whose declared type is not an allowed image type', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const res = await post([{ name: 'evil.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg onload=alert(1)>') }]);

  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).files, []);
  assert.deepEqual(filesOnDisk(), []);
});

test('rejects a non-image smuggled in behind a spoofed image Content-Type, and deletes it from disk', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const res = await post([
    { name: 'good.png', type: 'image/png', bytes: pngBytes() },
    { name: 'photo.html', type: 'image/jpeg', bytes: Buffer.from('<script>alert(1)</script>') },
  ]);

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /photo\.html.*not a valid image/);
  assert.deepEqual(await filesOnDiskOnceSettled(), [], 'neither file (including the valid one) should be left on disk');
});

test('a path-traversal filename cannot escape the upload dir', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const res = await post([{ name: '../../escaped.png', type: 'image/png', bytes: pngBytes() }]);

  assert.equal(res.status, 200);
  const { files } = await res.json();
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('escaped.png'));
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'escaped.png')));
  assert.deepEqual(filesOnDisk(), files);
});

test('rejects a file over the 10MB limit and leaves nothing on disk', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const res = await post([
    { name: 'small.png', type: 'image/png', bytes: pngBytes() },
    { name: 'huge.png', type: 'image/png', bytes: pngBytes(10 * 1024 * 1024 + 1024) },
  ]);

  assert.notEqual(res.status, 200);
  assert.equal((await res.json()).code, 'LIMIT_FILE_SIZE');
  assert.deepEqual(await filesOnDiskOnceSettled(), []);
});

test('accepts exactly 12 photos but rejects a 13th, leaving nothing on disk', async () => {
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const make = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}.png`, type: 'image/png', bytes: pngBytes() }));

  const ok = await post(make(12));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).files.length, 12);

  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  const tooMany = await post(make(13));
  assert.notEqual(tooMany.status, 200);
  assert.match((await tooMany.json()).code, /^LIMIT_/);
  assert.deepEqual(await filesOnDiskOnceSettled(), []);
});
