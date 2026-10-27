const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deleteUserPhotos } = require('../services/r2Service');

// A stand-in for the S3 client: scripted list pages, and a record of every command sent.
function fakeClient(pages) {
  const sent = [];
  const queue = pages.slice();
  return {
    sent,
    send: async (command) => {
      const type = command.constructor.name;
      sent.push({ type, input: command.input });
      if (type === 'ListObjectsV2Command') return queue.shift() || { Contents: [], IsTruncated: false };
      return {};
    },
  };
}

const keys = (...ks) => ks.map((Key) => ({ Key }));
const deletedKeys = (client) => client.sent
  .filter((c) => c.type === 'DeleteObjectsCommand')
  .flatMap((c) => c.input.Delete.Objects.map((o) => o.Key));

test('deleteUserPhotos lists only that user\'s prefix and deletes what it finds', async () => {
  const client = fakeClient([{ Contents: keys('parts/7/a.jpg', 'parts/7/b.jpg'), IsTruncated: false }]);

  const result = await deleteUserPhotos(7, { client, bucket: 'photos' });

  const list = client.sent.find((c) => c.type === 'ListObjectsV2Command');
  assert.equal(list.input.Prefix, 'parts/7/');
  assert.equal(list.input.Bucket, 'photos');
  assert.deepEqual(deletedKeys(client), ['parts/7/a.jpg', 'parts/7/b.jpg']);
  assert.equal(result.deleted, 2);
});

test('the prefix ends with a slash so user 7 can never match user 70\'s photos', async () => {
  const client = fakeClient([{ Contents: [], IsTruncated: false }]);
  await deleteUserPhotos(7, { client, bucket: 'photos' });
  assert.equal(client.sent[0].input.Prefix, 'parts/7/');
});

test('deleteUserPhotos follows pagination until the listing is exhausted', async () => {
  const client = fakeClient([
    { Contents: keys('parts/7/a.jpg'), IsTruncated: true, NextContinuationToken: 'tok1' },
    { Contents: keys('parts/7/b.jpg'), IsTruncated: false },
  ]);

  const result = await deleteUserPhotos(7, { client, bucket: 'photos' });

  const lists = client.sent.filter((c) => c.type === 'ListObjectsV2Command');
  assert.equal(lists.length, 2);
  assert.equal(lists[1].input.ContinuationToken, 'tok1');
  assert.equal(result.deleted, 2);
});

test('deleteUserPhotos deletes in batches of at most 1000 keys (S3\'s limit)', async () => {
  const many = Array.from({ length: 2300 }, (_, i) => ({ Key: `parts/7/${i}.jpg` }));
  const client = fakeClient([{ Contents: many, IsTruncated: false }]);

  const result = await deleteUserPhotos(7, { client, bucket: 'photos' });

  const batches = client.sent.filter((c) => c.type === 'DeleteObjectsCommand');
  assert.deepEqual(batches.map((b) => b.input.Delete.Objects.length), [1000, 1000, 300]);
  assert.equal(result.deleted, 2300);
});

test('deleteUserPhotos with nothing to delete sends no delete command', async () => {
  const client = fakeClient([{ Contents: undefined, IsTruncated: false }]);
  const result = await deleteUserPhotos(7, { client, bucket: 'photos' });
  assert.equal(client.sent.filter((c) => c.type === 'DeleteObjectsCommand').length, 0);
  assert.equal(result.deleted, 0);
});

test('deleteUserPhotos refuses anything but a positive integer user id (a bad prefix could wipe every seller\'s photos)', async () => {
  for (const bad of [undefined, null, '', 'abc', '7/../8', 0, -1, 1.5, '7']) {
    const client = fakeClient([]);
    await assert.rejects(deleteUserPhotos(bad, { client, bucket: 'photos' }), /user id/i, `accepted ${JSON.stringify(bad)}`);
    assert.equal(client.sent.length, 0);
  }
});

test('deleteUserPhotos is a no-op when R2 is not configured (local dev)', async () => {
  const client = fakeClient([]);
  const result = await deleteUserPhotos(7, { client, bucket: undefined });
  assert.equal(result.skipped, true);
  assert.equal(client.sent.length, 0);
});

test('deleteUserPhotos surfaces per-key delete errors instead of reporting success', async () => {
  const client = {
    send: async (command) => {
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: keys('parts/7/a.jpg'), IsTruncated: false };
      return { Errors: [{ Key: 'parts/7/a.jpg', Message: 'AccessDenied' }] };
    },
  };
  await assert.rejects(deleteUserPhotos(7, { client, bucket: 'photos' }), /AccessDenied/);
});
