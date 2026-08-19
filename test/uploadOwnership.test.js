const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownsUploadedFile } = require('../services/uploadService');

const rowsForUser1 = [
  JSON.stringify(['/app/uploads/111-aaa-relay1.jpg', '/app/uploads/222-bbb-relay2.jpg']),
  JSON.stringify(['/app/uploads/333-ccc-relay3.jpg']),
];

test('returns true when the filename belongs to one of this user\'s parts', () => {
  assert.equal(ownsUploadedFile(rowsForUser1, '222-bbb-relay2.jpg'), true);
});

test('returns false when the filename belongs to a different user (not in their rows)', () => {
  assert.equal(ownsUploadedFile(rowsForUser1, '999-zzz-someone-elses-photo.jpg'), false);
});

test('matches by exact basename, not a loose substring', () => {
  // "1-aaa-relay1.jpg" is a substring of "111-aaa-relay1.jpg" but is not the same file.
  assert.equal(ownsUploadedFile(rowsForUser1, '1-aaa-relay1.jpg'), false);
});

test('handles empty/malformed photo_paths_json rows without throwing', () => {
  const rows = ['[]', null, '', 'not-json'];
  assert.doesNotThrow(() => ownsUploadedFile(rows, 'anything.jpg'));
  assert.equal(ownsUploadedFile(rows, 'anything.jpg'), false);
});
