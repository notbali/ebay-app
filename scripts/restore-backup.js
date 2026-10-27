#!/usr/bin/env node
// Lists or downloads database backups from the private R2 backup bucket.
//
//   node scripts/restore-backup.js                      list available backups
//   node scripts/restore-backup.js latest [outPath]     download the newest backup
//   node scripts/restore-backup.js <key> [outPath]      download a specific one, e.g. backups/app-2026-10-27.db.gz
//
// Writes a verified copy to outPath (default: restored-app.db next to the live database) and never
// overwrites an existing file. Swapping it in for the live database is a manual step - see the
// "Backups" section of the README.
require('dotenv').config();
const path = require('path');
const { getBackupConfig, createR2BackupStore, restoreBackup, latestBackupKey } = require('../services/backupService');

async function main() {
  const [target, outArg] = process.argv.slice(2);

  const config = getBackupConfig();
  if (!config.enabled) {
    console.error(`Backups are not configured: ${config.reason}`);
    process.exit(1);
  }
  const store = createR2BackupStore({ bucket: config.bucket });

  if (!target) {
    const keys = (await store.list()).sort();
    console.log(keys.length ? keys.join('\n') : 'No backups found.');
    return;
  }

  const key = target === 'latest' ? await latestBackupKey(store) : target;
  if (!key) {
    console.error('No backups found.');
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const outPath = path.resolve(outArg || path.join(dataDir, 'restored-app.db'));
  await restoreBackup({ store, key, outPath });
  console.log(`Restored ${key} -> ${outPath} (integrity check passed).`);
  console.log('To use it: stop the app, move your current app.db aside, copy this file to app.db, start the app.');
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
});
