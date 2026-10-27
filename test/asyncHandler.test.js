const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asyncHandler } = require('../middleware/asyncHandler');

test('asyncHandler forwards a rejected promise to next(err)', async () => {
  const boom = new Error('boom');
  let received;
  await new Promise((resolve) => {
    asyncHandler(async () => { throw boom; })({}, {}, (err) => { received = err; resolve(); });
  });
  assert.equal(received, boom);
});

test('asyncHandler forwards a synchronous throw inside the handler to next(err) too', async () => {
  const boom = new Error('sync boom');
  let received;
  await new Promise((resolve) => {
    asyncHandler(() => { throw boom; })({}, {}, (err) => { received = err; resolve(); });
  });
  assert.equal(received, boom);
});

test('asyncHandler does not call next when the handler succeeds', async () => {
  let nextCalled = false;
  await asyncHandler(async (req, res) => { res.done = true; })({}, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
});

test('asyncHandler passes req, res and next through to the handler', async () => {
  const req = {}; const res = {}; const next = () => {};
  let args;
  await asyncHandler(async (...a) => { args = a; })(req, res, next);
  assert.deepEqual(args, [req, res, next]);
  assert.equal(args[0], req);
});
