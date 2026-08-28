const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isApiRequest, statusForError } = require('../services/errorPageService');

// --- isApiRequest ---

test('isApiRequest recognizes API paths', () => {
  assert.equal(isApiRequest('/api/parts'), true);
  assert.equal(isApiRequest('/api/'), true);
  assert.equal(isApiRequest('/api/auth/login'), true);
});

test('isApiRequest rejects non-API page paths', () => {
  assert.equal(isApiRequest('/app.html'), false);
  assert.equal(isApiRequest('/'), false);
  assert.equal(isApiRequest('/terms.html'), false);
});

test('isApiRequest does not match a lookalike path that merely starts with "api"', () => {
  // "/apis/fake" should not be treated as an API route just because it starts with "api"
  assert.equal(isApiRequest('/apis/fake'), false);
  assert.equal(isApiRequest('/apiary'), false);
});

test('isApiRequest handles missing/malformed input without throwing', () => {
  assert.doesNotThrow(() => isApiRequest(undefined));
  assert.doesNotThrow(() => isApiRequest(null));
  assert.equal(isApiRequest(undefined), false);
  assert.equal(isApiRequest(null), false);
  assert.equal(isApiRequest(''), false);
});

// --- statusForError ---

test('statusForError defaults to 500 for a plain Error with no status', () => {
  assert.equal(statusForError(new Error('boom')), 500);
});

test('statusForError uses err.status when it is a valid HTTP error code', () => {
  assert.equal(statusForError({ status: 404 }), 404);
  assert.equal(statusForError({ status: 403 }), 403);
});

test('statusForError falls back to err.statusCode when status is absent', () => {
  assert.equal(statusForError({ statusCode: 400 }), 400);
});

test('statusForError prefers status over statusCode when both are present', () => {
  assert.equal(statusForError({ status: 409, statusCode: 400 }), 409);
});

test('statusForError treats an out-of-range status as invalid and defaults to 500', () => {
  assert.equal(statusForError({ status: 999 }), 500);
  assert.equal(statusForError({ status: 200 }), 500); // not an error range
  assert.equal(statusForError({ status: 0 }), 500);
});

test('statusForError treats a non-numeric status as invalid and defaults to 500', () => {
  assert.equal(statusForError({ status: 'not-a-number' }), 500);
  assert.equal(statusForError({ status: '404' }), 500); // strings not coerced, must be a real number
});

test('statusForError handles null/undefined/non-object input without throwing', () => {
  assert.doesNotThrow(() => statusForError(null));
  assert.doesNotThrow(() => statusForError(undefined));
  assert.equal(statusForError(null), 500);
  assert.equal(statusForError(undefined), 500);
});
