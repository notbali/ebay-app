const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeLocalUploads, cleanupAccountFiles } = require('../services/userFilesService');

function makeUploadDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-files-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  return dir;
}

// --- removeLocalUploads ---

test('removeLocalUploads deletes the listed files from the upload dir', async () => {
  const dir = makeUploadDir(['1-a.jpg', '2-b.jpg', 'keep.jpg']);

  const result = await removeLocalUploads([path.join(dir, '1-a.jpg'), path.join(dir, '2-b.jpg')], { uploadDir: dir });

  assert.equal(result.removed, 2);
  assert.deepEqual(fs.readdirSync(dir), ['keep.jpg']);
});

test('removeLocalUploads resolves by filename inside the current upload dir (stored paths may predate a UPLOAD_DIR change)', async () => {
  const dir = makeUploadDir(['1-a.jpg']);

  const result = await removeLocalUploads(['/old/disk/location/uploads/1-a.jpg'], { uploadDir: dir });

  assert.equal(result.removed, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('removeLocalUploads can never delete outside the upload dir, whatever the stored path says', async () => {
  const dir = makeUploadDir([]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');

  await removeLocalUploads([path.join(outside, 'precious.txt'), '../../precious.txt', path.join(dir, '..', path.basename(outside), 'precious.txt')], { uploadDir: dir });

  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
});

test('removeLocalUploads treats an already-missing file as fine and ignores junk entries', async () => {
  const dir = makeUploadDir(['real.jpg']);

  const result = await removeLocalUploads(['gone.jpg', null, '', 42, path.join(dir, 'real.jpg')], { uploadDir: dir });

  assert.equal(result.failed, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('removeLocalUploads counts real failures instead of throwing', async () => {
  const dir = makeUploadDir(['a.jpg']);
  const unlink = async () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };

  const result = await removeLocalUploads([path.join(dir, 'a.jpg')], { uploadDir: dir, unlink });

  assert.equal(result.failed, 1);
  assert.equal(result.removed, 0);
});

// --- cleanupAccountFiles ---

test('cleanupAccountFiles removes local photos and the user\'s R2 photos', async () => {
  const calls = [];
  const summary = await cleanupAccountFiles({ photoPaths: ['/up/a.jpg'], userId: 7 }, {
    removeLocal: async (paths) => { calls.push(['local', paths]); return { removed: 1, failed: 0 }; },
    deleteR2: async (userId) => { calls.push(['r2', userId]); return { deleted: 3 }; },
    log: () => {},
  });

  assert.deepEqual(calls, [['local', ['/up/a.jpg']], ['r2', 7]]);
  assert.equal(summary.local.removed, 1);
  assert.equal(summary.r2.deleted, 3);
});

test('cleanupAccountFiles still cleans R2 when local deletion throws, and vice versa, and never throws itself', async () => {
  const logged = [];
  const a = await cleanupAccountFiles({ photoPaths: ['/x'], userId: 1 }, {
    removeLocal: async () => { throw new Error('disk error'); },
    deleteR2: async () => ({ deleted: 2 }),
    log: (...args) => logged.push(args.join(' ')),
  });
  assert.equal(a.r2.deleted, 2);
  assert.match(a.local.error, /disk error/);

  const b = await cleanupAccountFiles({ photoPaths: ['/x'], userId: 1 }, {
    removeLocal: async () => ({ removed: 1, failed: 0 }),
    deleteR2: async () => { throw new Error('R2 unreachable'); },
    log: (...args) => logged.push(args.join(' ')),
  });
  assert.equal(b.local.removed, 1);
  assert.match(b.r2.error, /R2 unreachable/);
  assert.ok(logged.some((l) => /R2 unreachable/.test(l)), 'failures should be logged for the operator');
});
