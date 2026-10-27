const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// db.js and uploadService.js read these at require time, so set them before loading the route.
// Each test file runs in its own process, so nothing leaks into other tests.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-quota-'));
process.env.DATA_DIR = path.join(tmp, 'db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SESSION_SECRET = 'test-session-secret';
process.env.AI_DAILY_LIMIT = '2';
delete process.env.PUBLIC_BASE_URL;

// Replace the AI and eBay services with stubs (before the route requires them) so no test touches
// the network or spends model quota.
let generateImpl;
const stub = (name, exports) => {
  const resolved = require.resolve(`../services/${name}`);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('aiService', { generateListing: (args) => generateImpl(args) });
stub('ebayService', {
  suggestCategories: async () => [{ categoryId: '12345', categoryName: 'Relays' }],
  getValidConditions: async () => [],
  publishListing: async () => { throw new Error('not used'); },
});

const express = require('express');
const db = require('../db');
const { createSessionToken } = require('../services/authService');
const { createSession } = require('../middleware/auth');
const { signCookieValue } = require('../services/authService');
const partsRouter = require('../routes/parts');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const LISTING = {
  part_number: 'X1', brand: 'Acme', title: 'Acme X1 Relay', description: 'A relay.', price_low: 10, price_high: 20,
  specifics: {}, condition: 'USED_GOOD', category_search_term: 'relay', confidence: 'high', notes_for_seller: '',
  weight_lb: 1, length_in: 2, width_in: 3, height_in: 4,
};

let server;
let baseUrl;
let userId;
let cookie;
const uploadsOnDisk = () => fs.readdirSync(process.env.UPLOAD_DIR);
const quotaRows = () => db.prepare('SELECT COUNT(*) AS n FROM ai_generations WHERE user_id = ?').get(userId).n;

async function eventually(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return check();
}

before(async () => {
  userId = Number(db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('seller@example.com', 'x').lastInsertRowid);
  const token = createSessionToken();
  createSession(userId, token);
  cookie = `session=${encodeURIComponent(signCookieValue(token, process.env.SESSION_SECRET))}`;

  const app = express();
  app.use(express.json());
  app.use('/api/parts', partsRouter);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM ai_generations').run();
  db.prepare('DELETE FROM parts').run();
  fs.readdirSync(process.env.UPLOAD_DIR).forEach((f) => fs.rmSync(path.join(process.env.UPLOAD_DIR, f)));
  generateImpl = async () => LISTING;
});

function createDraft({ signal } = {}) {
  const form = new FormData();
  form.append('notes', 'a relay');
  form.append('photos', new Blob([PNG], { type: 'image/png' }), 'relay.png');
  return fetch(`${baseUrl}/api/parts`, { method: 'POST', headers: { Cookie: cookie }, body: form, signal });
}

test('a successful draft is saved, keeps its photo, and counts against the daily limit', async () => {
  const res = await createDraft();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).part.ai_title, 'Acme X1 Relay');
  assert.equal(uploadsOnDisk().length, 1);
  assert.equal(quotaRows(), 1);
});

test('a failed generation returns an error, uses no quota, and leaves no orphaned photo', async () => {
  generateImpl = async () => { throw new Error('AI service is unavailable'); };

  const res = await createDraft();

  assert.equal(res.status, 500);
  assert.equal(quotaRows(), 0);
  assert.ok(await eventually(() => uploadsOnDisk().length === 0), 'orphaned upload was not removed');
});

test('once the daily limit is reached, the next draft is refused with 429 before any AI call', async () => {
  assert.equal((await createDraft()).status, 200);
  assert.equal((await createDraft()).status, 200);
  let aiCalled = false;
  generateImpl = async () => { aiCalled = true; return LISTING; };

  const res = await createDraft();

  assert.equal(res.status, 429);
  const body = await res.json();
  assert.match(body.error, /limit of 2 AI drafts per 24 hours/);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(aiCalled, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n, 2);
  assert.ok(await eventually(() => uploadsOnDisk().length === 2), 'the refused upload should be removed, the two saved kept');
});

test('failures between successes do not eat into the limit', async () => {
  assert.equal((await createDraft()).status, 200);
  generateImpl = async () => { throw new Error('boom'); };
  assert.equal((await createDraft()).status, 500);
  assert.equal((await createDraft()).status, 500);
  generateImpl = async () => LISTING;

  assert.equal((await createDraft()).status, 200, 'limit is 2 and only one draft actually succeeded so far');
});

test('a third simultaneous draft is refused while two are still generating', async () => {
  const releases = [];
  generateImpl = () => new Promise((resolve) => { releases.push(() => resolve(LISTING)); });

  const first = createDraft();
  const second = createDraft();
  await eventually(() => releases.length === 2);

  const third = await createDraft();
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /already being generated/i);

  releases.forEach((release) => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('cancelling mid-generation uses no quota and removes the uploaded photo', async () => {
  generateImpl = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('Generation cancelled.');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const controller = new AbortController();
  const pending = createDraft({ signal: controller.signal }).catch(() => null);
  await eventually(() => uploadsOnDisk().length === 1);

  controller.abort();
  await pending;

  assert.ok(await eventually(() => quotaRows() === 0), 'quota should be released after a cancel');
  assert.ok(await eventually(() => uploadsOnDisk().length === 0), 'upload should be removed after a cancel');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n, 0);
});
