const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const {
  getBackupConfig, backupKey, parseBackupDate, selectKeysToPrune, createSnapshot, verifySnapshot,
  runBackup, restoreBackup, latestBackupKey, createR2BackupStore, startBackupSchedule,
  BACKUP_PREFIX, DEFAULT_RETENTION_DAYS,
} = require('../services/backupService');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 15, 30, 0); // 2026-10-27

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com'), ('c@example.com');
  `);
  return db;
}

// An in-memory stand-in for the R2 bucket.
function memoryStore(initial = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    objects,
    put: async (key, body) => { objects.set(key, body); },
    get: async (key) => { if (!objects.has(key)) throw new Error(`no such key ${key}`); return objects.get(key); },
    list: async () => [...objects.keys()],
    remove: async (keys) => { keys.forEach((k) => objects.delete(k)); },
  };
}

const goodEnv = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET_NAME: 'public-photos', R2_BACKUP_BUCKET_NAME: 'private-backups',
};

// --- getBackupConfig ---

test('getBackupConfig is enabled with credentials and a separate backup bucket', () => {
  const c = getBackupConfig(goodEnv);
  assert.equal(c.enabled, true);
  assert.equal(c.bucket, 'private-backups');
  assert.equal(c.retentionDays, DEFAULT_RETENTION_DAYS);
});

test('getBackupConfig is disabled, with a reason, when the backup bucket is not set', () => {
  const { R2_BACKUP_BUCKET_NAME, ...env } = goodEnv;
  const c = getBackupConfig(env);
  assert.equal(c.enabled, false);
  assert.match(c.reason, /R2_BACKUP_BUCKET_NAME/);
});

test('getBackupConfig is disabled when R2 credentials are missing', () => {
  const { R2_SECRET_ACCESS_KEY, ...env } = goodEnv;
  assert.equal(getBackupConfig(env).enabled, false);
});

test('getBackupConfig refuses to use the public photo bucket - backups hold password hashes and tokens', () => {
  const c = getBackupConfig({ ...goodEnv, R2_BACKUP_BUCKET_NAME: 'public-photos' });
  assert.equal(c.enabled, false);
  assert.match(c.reason, /public/i);
});

test('getBackupConfig reads BACKUP_RETENTION_DAYS, ignoring junk', () => {
  assert.equal(getBackupConfig({ ...goodEnv, BACKUP_RETENTION_DAYS: '30' }).retentionDays, 30);
  assert.equal(getBackupConfig({ ...goodEnv, BACKUP_RETENTION_DAYS: 'x' }).retentionDays, DEFAULT_RETENTION_DAYS);
  assert.equal(getBackupConfig({ ...goodEnv, BACKUP_RETENTION_DAYS: '0' }).retentionDays, DEFAULT_RETENTION_DAYS);
});

// --- keys ---

test('backupKey names a backup by its UTC date, under the backups/ prefix', () => {
  assert.equal(backupKey(NOW), 'backups/app-2026-10-27.db.gz');
  assert.equal(backupKey(Date.UTC(2026, 0, 5, 23, 59, 59)), 'backups/app-2026-01-05.db.gz');
  assert.ok(backupKey(NOW).startsWith(BACKUP_PREFIX));
});

test('parseBackupDate round-trips a backup key and rejects anything else', () => {
  assert.equal(parseBackupDate('backups/app-2026-10-27.db.gz'), Date.UTC(2026, 9, 27));
  for (const bad of ['backups/notes.txt', 'parts/7/a.jpg', 'backups/app-2026-13-40.db.gz', 'backups/app-2026-10-27.db', '']) {
    assert.equal(parseBackupDate(bad), null, bad);
  }
});

test('selectKeysToPrune returns only dated backups older than the retention window', () => {
  const keys = [
    'backups/app-2026-10-27.db.gz', // today
    'backups/app-2026-10-20.db.gz', // 7 days
    'backups/app-2026-10-13.db.gz', // 14 days - inside a 14-day window
    'backups/app-2026-10-12.db.gz', // 15 days - out
    'backups/app-2026-01-01.db.gz', // way out
  ];
  assert.deepEqual(selectKeysToPrune(keys, { now: NOW, retentionDays: 14 }).sort(), [
    'backups/app-2026-01-01.db.gz', 'backups/app-2026-10-12.db.gz',
  ]);
});

test('selectKeysToPrune never touches objects that are not dated backups', () => {
  const keys = ['backups/README.txt', 'parts/7/photo.jpg', 'backups/app-latest.db.gz', 'backups/app-2020-01-01.db.gz'];
  assert.deepEqual(selectKeysToPrune(keys, { now: NOW, retentionDays: 14 }), ['backups/app-2020-01-01.db.gz']);
});

// --- snapshot / verify ---

test('createSnapshot writes a consistent, openable copy of a live database', () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'snap.db');

  createSnapshot(makeDb(), dest);

  const copy = new DatabaseSync(dest);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
  copy.close();
});

test('verifySnapshot accepts a healthy database and rejects garbage or a missing file', () => {
  const dir = tmpDir();
  createSnapshot(makeDb(), path.join(dir, 'good.db'));
  fs.writeFileSync(path.join(dir, 'bad.db'), 'definitely not sqlite '.repeat(200));

  assert.equal(verifySnapshot(path.join(dir, 'good.db')), true);
  assert.equal(verifySnapshot(path.join(dir, 'bad.db')), false);
  assert.equal(verifySnapshot(path.join(dir, 'missing.db')), false);
});

// --- runBackup ---

test('runBackup uploads a gzipped snapshot named for today that restores to the same data', async () => {
  const store = memoryStore();
  const dir = tmpDir();

  const result = await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: dir });

  assert.equal(result.key, 'backups/app-2026-10-27.db.gz');
  assert.ok(result.bytes > 0);
  const restored = path.join(dir, 'check.db');
  fs.writeFileSync(restored, zlib.gunzipSync(store.objects.get(result.key)));
  const db = new DatabaseSync(restored);
  assert.deepEqual(db.prepare('SELECT email FROM users ORDER BY id').all().map((r) => r.email),
    ['a@example.com', 'b@example.com', 'c@example.com']);
  db.close();
});

test('runBackup leaves no temporary snapshot file behind', async () => {
  const dir = tmpDir();
  await runBackup(makeDb(), { store: memoryStore(), now: NOW, retentionDays: 14, tmpDir: dir });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('runBackup prunes backups older than the retention window but keeps recent ones', async () => {
  const store = memoryStore({
    'backups/app-2026-10-26.db.gz': Buffer.from('yesterday'),
    'backups/app-2026-09-01.db.gz': Buffer.from('ancient'),
    'parts/7/photo.jpg': Buffer.from('not a backup'),
  });

  const result = await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: tmpDir() });

  assert.deepEqual(result.pruned, ['backups/app-2026-09-01.db.gz']);
  assert.ok(store.objects.has('backups/app-2026-10-26.db.gz'));
  assert.ok(store.objects.has('backups/app-2026-10-27.db.gz'));
  assert.ok(store.objects.has('parts/7/photo.jpg'));
});

test('runBackup running twice on the same day replaces that day\'s backup instead of piling up', async () => {
  const store = memoryStore();
  await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: tmpDir() });
  await runBackup(makeDb(), { store, now: NOW + 3600_000, retentionDays: 14, tmpDir: tmpDir() });
  assert.equal(store.objects.size, 1);
});

test('runBackup does not upload when the snapshot fails verification, and cleans up', async () => {
  const store = memoryStore();
  const dir = tmpDir();

  await assert.rejects(
    runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: dir, verify: () => false }),
    /verif/i,
  );

  assert.equal(store.objects.size, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('runBackup fails loudly (and cleans up) when the upload fails', async () => {
  const store = memoryStore();
  store.put = async () => { throw new Error('R2 unreachable'); };
  const dir = tmpDir();

  await assert.rejects(runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: dir }), /R2 unreachable/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('runBackup still succeeds if only the pruning step fails - the new backup is safely uploaded', async () => {
  const store = memoryStore();
  store.list = async () => { throw new Error('list denied'); };

  const result = await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: tmpDir() });

  assert.ok(store.objects.has(result.key));
  assert.match(result.pruneError, /list denied/);
});

// --- restoreBackup ---

test('restoreBackup downloads, decompresses and verifies a backup into a new file', async () => {
  const store = memoryStore();
  const dir = tmpDir();
  const { key } = await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: dir });
  const out = path.join(dir, 'restored.db');

  await restoreBackup({ store, key, outPath: out });

  const db = new DatabaseSync(out);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
  db.close();
});

test('restoreBackup refuses to overwrite an existing file', async () => {
  const store = memoryStore();
  const dir = tmpDir();
  const { key } = await runBackup(makeDb(), { store, now: NOW, retentionDays: 14, tmpDir: dir });
  const out = path.join(dir, 'live.db');
  fs.writeFileSync(out, 'the live database');

  await assert.rejects(restoreBackup({ store, key, outPath: out }), /already exists/i);
  assert.equal(fs.readFileSync(out, 'utf8'), 'the live database');
});

test('restoreBackup rejects a corrupt backup and leaves no file behind', async () => {
  const dir = tmpDir();
  const store = memoryStore({ 'backups/app-2026-10-27.db.gz': zlib.gzipSync(Buffer.from('not sqlite '.repeat(300))) });
  const out = path.join(dir, 'restored.db');

  await assert.rejects(restoreBackup({ store, key: 'backups/app-2026-10-27.db.gz', outPath: out }), /corrupt|verif/i);
  assert.equal(fs.existsSync(out), false);
});

test('latestBackupKey picks the newest dated backup', async () => {
  const store = memoryStore({
    'backups/app-2026-10-01.db.gz': 'x', 'backups/app-2026-10-27.db.gz': 'x', 'backups/app-2026-10-15.db.gz': 'x', 'backups/other.txt': 'x',
  });
  assert.equal(await latestBackupKey(store), 'backups/app-2026-10-27.db.gz');
  assert.equal(await latestBackupKey(memoryStore()), null);
});

// --- R2 store ---

function fakeS3(pages = []) {
  const sent = [];
  const queue = pages.slice();
  return {
    sent,
    send: async (command) => {
      const type = command.constructor.name;
      sent.push({ type, input: command.input });
      if (type === 'ListObjectsV2Command') return queue.shift() || { Contents: [], IsTruncated: false };
      if (type === 'GetObjectCommand') return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      return {};
    },
  };
}

test('R2 store put uploads to the backup bucket as gzip', async () => {
  const client = fakeS3();
  await createR2BackupStore({ client, bucket: 'private-backups' }).put('backups/app-2026-10-27.db.gz', Buffer.from('data'));

  assert.equal(client.sent[0].type, 'PutObjectCommand');
  assert.equal(client.sent[0].input.Bucket, 'private-backups');
  assert.equal(client.sent[0].input.Key, 'backups/app-2026-10-27.db.gz');
  assert.equal(client.sent[0].input.ContentType, 'application/gzip');
});

test('R2 store list returns every key under backups/, following pagination', async () => {
  const client = fakeS3([
    { Contents: [{ Key: 'backups/app-2026-10-26.db.gz' }], IsTruncated: true, NextContinuationToken: 't' },
    { Contents: [{ Key: 'backups/app-2026-10-27.db.gz' }], IsTruncated: false },
  ]);

  const keys = await createR2BackupStore({ client, bucket: 'private-backups' }).list();

  assert.deepEqual(keys, ['backups/app-2026-10-26.db.gz', 'backups/app-2026-10-27.db.gz']);
  assert.equal(client.sent[0].input.Prefix, 'backups/');
  assert.equal(client.sent[1].input.ContinuationToken, 't');
});

test('R2 store get returns the object bytes as a Buffer', async () => {
  const body = await createR2BackupStore({ client: fakeS3(), bucket: 'b' }).get('backups/app-2026-10-27.db.gz');
  assert.deepEqual([...body], [1, 2, 3]);
  assert.ok(Buffer.isBuffer(body));
});

test('R2 store remove deletes the given keys, and refuses keys outside the backups/ prefix', async () => {
  const client = fakeS3();
  const store = createR2BackupStore({ client, bucket: 'private-backups' });

  await store.remove(['backups/app-2026-01-01.db.gz']);
  assert.equal(client.sent[0].type, 'DeleteObjectsCommand');
  assert.deepEqual(client.sent[0].input.Delete.Objects, [{ Key: 'backups/app-2026-01-01.db.gz' }]);

  await assert.rejects(store.remove(['parts/7/photo.jpg']), /outside/i);
});

// --- schedule ---

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
    clearIntervalFn: () => {},
  };
}

test('startBackupSchedule does nothing but log when backups are not configured', () => {
  const timers = fakeTimers();
  const logs = [];
  let ran = 0;

  const stop = startBackupSchedule(makeDb(), {
    env: {}, log: (m) => logs.push(m), run: async () => { ran += 1; }, ...timers,
  });

  assert.equal(timers.timeouts.length + timers.intervals.length, 0);
  assert.equal(ran, 0);
  assert.ok(logs.some((m) => /disabled/i.test(m) && /R2_BACKUP_BUCKET_NAME/.test(m)));
  assert.doesNotThrow(stop);
});

test('startBackupSchedule runs a backup shortly after boot and then daily', async () => {
  const timers = fakeTimers();
  let ran = 0;

  startBackupSchedule(makeDb(), {
    env: goodEnv, log: () => {}, run: async () => { ran += 1; return { key: 'k', bytes: 1, pruned: [] }; }, ...timers,
  });

  assert.equal(timers.timeouts.length, 1);
  assert.ok(timers.timeouts[0].ms > 0 && timers.timeouts[0].ms <= 10 * 60 * 1000);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, DAY);

  await timers.timeouts[0].fn();
  await timers.intervals[0].fn();
  assert.equal(ran, 2);
});

test('a failing scheduled backup is logged and never throws into the event loop', async () => {
  const timers = fakeTimers();
  const logs = [];

  startBackupSchedule(makeDb(), {
    env: goodEnv, log: (m) => logs.push(m), run: async () => { throw new Error('R2 unreachable'); }, ...timers,
  });

  await assert.doesNotReject(async () => { await timers.timeouts[0].fn(); });
  assert.ok(logs.some((m) => /backup failed/i.test(m) && /R2 unreachable/.test(m)));
});

test('startBackupSchedule logs each successful backup', async () => {
  const timers = fakeTimers();
  const logs = [];
  startBackupSchedule(makeDb(), {
    env: goodEnv, log: (m) => logs.push(m), run: async () => ({ key: 'backups/app-2026-10-27.db.gz', bytes: 2048, pruned: ['x'] }), ...timers,
  });

  await timers.timeouts[0].fn();

  assert.ok(logs.some((m) => /backups\/app-2026-10-27\.db\.gz/.test(m)));
});
