const { test } = require('node:test');
const assert = require('node:assert/strict');
const { securityHeaders } = require('../middleware/securityHeaders');

function fakeRes() {
  const headers = {};
  return { headers, setHeader: (name, value) => { headers[name] = value; } };
}

test('sets X-Content-Type-Options to prevent MIME-sniffing', () => {
  const res = fakeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('sets X-Frame-Options to prevent clickjacking via iframe embedding', () => {
  const res = fakeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
});

test('sets a conservative Referrer-Policy', () => {
  const res = fakeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('always calls next() so the request isn\'t stalled', () => {
  let called = false;
  securityHeaders({}, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});
