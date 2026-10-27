const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// db.js opens its file at require time, so point it at a throwaway directory first. Each test
// file runs in its own process, so this doesn't leak into other tests.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-routes-'));
fs.mkdirSync(path.join(dataDir, 'uploads'));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
delete process.env.PUBLIC_BASE_URL;
delete process.env.R2_BUCKET_NAME; // no R2 in tests - cleanup must just skip it

const express = require('express');
const db = require('../db');
const authRouter = require('../routes/auth');
const { MAX_PASSWORD_LENGTH } = require('../services/authService');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.set('trust proxy', 1); // same as server.js, so req.ip comes from X-Forwarded-For
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Every request comes from its own fake client IP: signup and login are rate-limited per IP, and
// these tests shouldn't trip (or depend on) those limits - they have their own coverage.
let nextIp = 1;
async function api(method, route, body, cookie) {
  const res = await fetch(`${baseUrl}/api/auth${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.0.${nextIp++}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie()[0];
  return { status: res.status, body: await res.json(), cookie: setCookie ? setCookie.split(';')[0] : null };
}

let aliceCookie;

test('signup creates an account, logs it in, and /me reflects it', async () => {
  const res = await api('POST', '/signup', { email: 'Alice@Example.com', password: 'correct-horse-battery' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.ok(res.cookie && res.cookie.startsWith('session='));
  aliceCookie = res.cookie;

  const me = await api('GET', '/me', null, aliceCookie);
  assert.equal(me.body.user.email, 'alice@example.com');
});

test('signup rejects a duplicate email', async () => {
  const res = await api('POST', '/signup', { email: 'alice@example.com', password: 'another-password-1' });
  assert.equal(res.status, 409);
});

test('signup rejects short and over-long passwords', async () => {
  const short = await api('POST', '/signup', { email: 'short@example.com', password: 'short' });
  assert.equal(short.status, 400);

  const long = await api('POST', '/signup', {
    email: 'long@example.com', password: 'a'.repeat(MAX_PASSWORD_LENGTH + 1),
  });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /at most/);
});

test('two simultaneous signups for the same email: exactly one wins, the other gets a clean 409', async () => {
  const [a, b] = await Promise.all([
    api('POST', '/signup', { email: 'race@example.com', password: 'race-password-1' }),
    api('POST', '/signup', { email: 'race@example.com', password: 'race-password-2' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('login succeeds with the right password and returns a session cookie', async () => {
  const res = await api('POST', '/login', { email: 'alice@example.com', password: 'correct-horse-battery' });
  assert.equal(res.status, 200);
  assert.ok(res.cookie.startsWith('session='));
});

test('login gives the same generic 401 for a wrong password and an unknown email', async () => {
  const wrong = await api('POST', '/login', { email: 'alice@example.com', password: 'not-the-password' });
  const unknown = await api('POST', '/login', { email: 'nobody@example.com', password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('login rejects an over-long password with 401 (no hashing spent on it)', async () => {
  const res = await api('POST', '/login', { email: 'alice@example.com', password: 'a'.repeat(5000) });
  assert.equal(res.status, 401);
});

test('the server keeps answering other requests while a burst of logins is hashing', async () => {
  // With scryptSync every login would block the event loop; /me must stay responsive.
  const logins = Array.from({ length: 5 }, () => api('POST', '/login', { email: 'alice@example.com', password: 'wrong-one' }));
  const start = Date.now();
  const me = await api('GET', '/me', null, aliceCookie);
  const elapsed = Date.now() - start;
  assert.equal(me.status, 200);
  await Promise.all(logins);
  assert.ok(elapsed < 1000, `/me took ${elapsed}ms during a login burst`);
});

test('change-password updates the password; the old one stops working', async () => {
  const res = await api('POST', '/change-password',
    { currentPassword: 'correct-horse-battery', newPassword: 'brand-new-password-9' }, aliceCookie);
  assert.equal(res.status, 200);

  const old = await api('POST', '/login', { email: 'alice@example.com', password: 'correct-horse-battery' });
  assert.equal(old.status, 401);
  const fresh = await api('POST', '/login', { email: 'alice@example.com', password: 'brand-new-password-9' });
  assert.equal(fresh.status, 200);
});

test('change-password rejects a wrong current password and an over-long new password', async () => {
  const wrong = await api('POST', '/change-password',
    { currentPassword: 'nope-nope-nope', newPassword: 'brand-new-password-10' }, aliceCookie);
  assert.equal(wrong.status, 401);

  const tooLong = await api('POST', '/change-password',
    { currentPassword: 'brand-new-password-9', newPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) }, aliceCookie);
  assert.equal(tooLong.status, 400);
});

test('delete-account needs the right password, then removes the account and its photo files', async () => {
  const aliceId = db.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com').id;
  const photo = path.join(process.env.UPLOAD_DIR, '123-relay.jpg');
  fs.writeFileSync(photo, 'jpeg bytes');
  db.prepare('INSERT INTO parts (user_id, ai_title, photo_paths_json) VALUES (?, ?, ?)')
    .run(aliceId, 'Relay', JSON.stringify([photo]));
  const otherPhoto = path.join(process.env.UPLOAD_DIR, '456-someone-else.jpg');
  fs.writeFileSync(otherPhoto, 'jpeg bytes');

  const wrong = await api('POST', '/delete-account', { password: 'wrong-password' }, aliceCookie);
  assert.equal(wrong.status, 401);
  assert.ok(fs.existsSync(photo), 'a wrong password must not delete anything');

  const ok = await api('POST', '/delete-account', { password: 'brand-new-password-9' }, aliceCookie);
  assert.equal(ok.status, 200);

  const login = await api('POST', '/login', { email: 'alice@example.com', password: 'brand-new-password-9' });
  assert.equal(login.status, 401);
  assert.equal(fs.existsSync(photo), false, 'the deleted account\'s photo file should be gone');
  assert.ok(fs.existsSync(otherPhoto), 'files not referenced by the account must be left alone');
});
