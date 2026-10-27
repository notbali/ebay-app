const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getClient } = require('./r2Service');

// Daily off-site backups of the SQLite database (accounts, sessions, eBay connections, drafts).
// Without this the only copy lives on one Render disk: a disk failure or a bad deploy loses every
// account. Each backup is a consistent snapshot (VACUUM INTO - safe while the app is running),
// integrity-checked, gzipped, and uploaded to a *private* R2 bucket.
//
// Not the photo bucket: that one is publicly readable (eBay has to fetch listing photos from it),
// and a backup holds every seller's email, password hash and encrypted eBay token.

const BACKUP_PREFIX = 'backups/';
const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_BACKUP_DELAY_MS = 2 * 60 * 1000; // let boot finish before spending I/O on a backup

function getBackupConfig(env = process.env) {
  const bucket = (env.R2_BACKUP_BUCKET_NAME || '').trim();
  const retention = Number.parseInt(env.BACKUP_RETENTION_DAYS, 10);
  const retentionDays = Number.isInteger(retention) && retention > 0 ? retention : DEFAULT_RETENTION_DAYS;

  if (!bucket) return { enabled: false, reason: 'R2_BACKUP_BUCKET_NAME is not set' };
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return { enabled: false, reason: 'R2 credentials (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) are not set' };
  }
  if (bucket === (env.R2_BUCKET_NAME || '').trim()) {
    return {
      enabled: false,
      reason: 'R2_BACKUP_BUCKET_NAME is the same as the public photo bucket (R2_BUCKET_NAME) - backups must go in a separate private bucket',
    };
  }
  return { enabled: true, bucket, retentionDays };
}

// One backup per UTC day: running again the same day replaces that day's file rather than piling up.
function backupKey(now = Date.now()) {
  return `${BACKUP_PREFIX}app-${new Date(now).toISOString().slice(0, 10)}.db.gz`;
}

// Epoch ms of the UTC day a backup key is for, or null if the key isn't one of ours.
function parseBackupDate(key) {
  const m = /^backups\/app-(\d{4})-(\d{2})-(\d{2})\.db\.gz$/.exec(String(key));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Date.UTC rolls impossible dates over (month 13 -> next year); only accept exact matches.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}

// Only ever selects objects that parse as dated backups - anything else in the bucket (a README, a
// manual export) is never deleted by this job.
function selectKeysToPrune(keys, { now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  return keys.filter((key) => {
    const date = parseBackupDate(key);
    return date !== null && (todayStart - date) / DAY_MS > retentionDays;
  });
}

// VACUUM INTO writes a transactionally consistent copy while the app keeps serving requests.
// Refuses to overwrite an existing file, so the destination must be fresh.
function createSnapshot(db, destPath) {
  db.prepare('VACUUM INTO ?').run(destPath);
}

function verifySnapshot(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch { /* nothing useful to do */ }
    }
  }
}

async function runBackup(db, {
  store, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS, tmpDir = os.tmpdir(), verify = verifySnapshot,
}) {
  const snapshotPath = path.join(tmpDir, `snapshot-${now}-${crypto.randomBytes(6).toString('hex')}.db`);
  let key;
  let bytes;

  try {
    createSnapshot(db, snapshotPath);
    // An unverified backup is worse than none: it would eventually replace the good ones.
    if (!verify(snapshotPath)) throw new Error('Database snapshot failed integrity verification - nothing was uploaded');

    const compressed = zlib.gzipSync(fs.readFileSync(snapshotPath));
    key = backupKey(now);
    await store.put(key, compressed);
    bytes = compressed.length;
  } finally {
    fs.rmSync(snapshotPath, { force: true });
  }

  const result = { key, bytes, pruned: [] };
  // Pruning is housekeeping: the new backup is already safely uploaded, so a failure here (e.g. a
  // token without list/delete permission) is reported, not treated as a failed backup.
  try {
    const stale = selectKeysToPrune(await store.list(), { now, retentionDays });
    if (stale.length) await store.remove(stale);
    result.pruned = stale;
  } catch (err) {
    result.pruneError = err.message;
  }
  return result;
}

async function latestBackupKey(store) {
  const dated = (await store.list())
    .map((key) => ({ key, date: parseBackupDate(key) }))
    .filter((e) => e.date !== null)
    .sort((a, b) => b.date - a.date);
  return dated.length ? dated[0].key : null;
}

// Downloads a backup into a *new* file (never overwrites an existing one - copying it over the live
// database is a deliberate step the operator takes themselves, see README). The file only appears
// at outPath once it has passed an integrity check.
async function restoreBackup({ store, key, outPath }) {
  if (fs.existsSync(outPath)) throw new Error(`${outPath} already exists - refusing to overwrite it`);

  const partial = `${outPath}.partial`;
  try {
    let raw;
    try {
      raw = zlib.gunzipSync(await store.get(key));
    } catch (err) {
      if (err.code && String(err.code).startsWith('Z_')) throw new Error(`Backup ${key} is corrupt (not valid gzip)`);
      throw err;
    }
    fs.writeFileSync(partial, raw, { flag: 'wx' });
    if (!verifySnapshot(partial)) throw new Error(`Backup ${key} is corrupt (failed database integrity check)`);
    fs.renameSync(partial, outPath);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return { key, outPath };
}

function createR2BackupStore({ client = getClient(), bucket }) {
  return {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip' }));
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },

    async list() {
      const keys = [];
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: BACKUP_PREFIX, ContinuationToken: token }));
        keys.push(...(page.Contents || []).map((o) => o.Key));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },

    async remove(keys) {
      // Belt and braces: this store only ever manages backups/, whatever a caller passes in.
      if (keys.some((k) => !String(k).startsWith(BACKUP_PREFIX))) {
        throw new Error('Refusing to delete a key outside the backups/ prefix');
      }
      for (let i = 0; i < keys.length; i += 1000) {
        const result = await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }));
        if (result.Errors && result.Errors.length) {
          throw new Error(`R2 could not delete some backups: ${result.Errors.map((e) => `${e.Key}: ${e.Message}`).join('; ')}`);
        }
      }
    },
  };
}

// Never throws: a backup that fails is logged loudly but must not crash the server. Returns a stop
// function. Timers are unref'd so they never keep the process alive by themselves.
function startBackupSchedule(db, {
  env = process.env, log = console.log, run,
  setTimeoutFn = setTimeout, setIntervalFn = setInterval, clearTimeoutFn = clearTimeout, clearIntervalFn = clearInterval,
} = {}) {
  const config = getBackupConfig(env);
  if (!config.enabled) {
    log(`Database backups disabled: ${config.reason}`);
    return () => {};
  }

  const runOnce = run || (() => runBackup(db, {
    store: createR2BackupStore({ bucket: config.bucket }), retentionDays: config.retentionDays,
  }));

  const task = async () => {
    try {
      const result = await runOnce();
      log(`Database backup uploaded: ${result.key} (${Math.ceil(result.bytes / 1024)} KB)`
        + `${result.pruned && result.pruned.length ? `, pruned ${result.pruned.length} old` : ''}`
        + `${result.pruneError ? `; pruning failed: ${result.pruneError}` : ''}`);
    } catch (err) {
      log(`Database backup FAILED: ${err.message}`);
    }
  };

  const first = setTimeoutFn(task, FIRST_BACKUP_DELAY_MS);
  const daily = setIntervalFn(task, DAY_MS);
  if (first && first.unref) first.unref();
  if (daily && daily.unref) daily.unref();
  log(`Database backups enabled: daily to bucket "${config.bucket}", keeping ${config.retentionDays} days`);

  return () => {
    clearTimeoutFn(first);
    clearIntervalFn(daily);
  };
}

module.exports = {
  getBackupConfig, backupKey, parseBackupDate, selectKeysToPrune, createSnapshot, verifySnapshot,
  runBackup, restoreBackup, latestBackupKey, createR2BackupStore, startBackupSchedule,
  BACKUP_PREFIX, DEFAULT_RETENTION_DAYS,
};
