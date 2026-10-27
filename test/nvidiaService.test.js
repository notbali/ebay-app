const { test } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('openai');
const {
  extractJson, validateListing, generateListing, resolveModels, MAX_AI_IMAGES,
  DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL,
} = require('../services/nvidiaService');

const GOOD = {
  part_number: '700-HC24Z24',
  brand: 'Allen-Bradley',
  title: 'Allen-Bradley 700-HC24Z24 4PDT Relay 24V DC Coil',
  description: 'Industrial control relay.',
  price_low: 25,
  price_high: 65,
  specifics: [{ key: 'Brand', value: 'Allen-Bradley' }, { key: 'Coil Voltage', value: '24V DC' }],
  condition: 'USED_GOOD',
  category_search_term: 'general purpose relay',
  confidence: 'high',
  notes_for_seller: 'Check the coil voltage.',
  weight_lb: 0.5,
  length_in: 4,
  width_in: 3,
  height_in: 3,
};

// A stand-in for the OpenAI SDK client: each entry in `script` is consumed by one create() call
// and is either a response body string (returned as the model's message content) or an Error
// (thrown). Records the request params so tests can assert which model was called.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          const next = script.shift();
          if (next instanceof Error) throw next;
          if (next && next.raw) return next.raw;
          return { choices: [{ finish_reason: 'stop', message: { content: next } }] };
        },
      },
    },
  };
}

const noSleep = async () => {};
const deps = (client) => ({ client, sleep: noSleep, models: ['primary-model', 'fallback-model'] });
const statusError = (status, message = 'boom') => Object.assign(new Error(message), { status });

// --- extractJson ---

test('extractJson parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson strips a markdown code fence', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson ignores a <think> block and surrounding prose', () => {
  assert.deepEqual(extractJson('<think>hmm {not json}</think>\nHere you go: {"a":1} hope that helps'), { a: 1 });
});

test('extractJson returns null when there is no JSON object (e.g. the model answered in prose)', () => {
  assert.equal(extractJson('**Part Identification** This looks like a relay.'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('extractJson returns null for truncated JSON', () => {
  assert.equal(extractJson('{"title": "Relay", "description": "cut o'), null);
});

// --- validateListing ---

test('validateListing converts the specifics array into an object', () => {
  const out = validateListing(GOOD);
  assert.deepEqual(out.specifics, { Brand: 'Allen-Bradley', 'Coil Voltage': '24V DC' });
  assert.equal(out.title, GOOD.title);
});

test('validateListing rejects an empty title or description (the model "succeeded" with blanks)', () => {
  assert.equal(validateListing({ ...GOOD, title: '' }), null);
  assert.equal(validateListing({ ...GOOD, description: '   ' }), null);
});

test('validateListing rejects non-numeric prices', () => {
  assert.equal(validateListing({ ...GOOD, price_low: 'cheap' }), null);
  assert.equal(validateListing({ ...GOOD, price_high: null }), null);
});

test('validateListing swaps an inverted price range instead of failing', () => {
  const out = validateListing({ ...GOOD, price_low: 90, price_high: 20 });
  assert.equal(out.price_low, 20);
  assert.equal(out.price_high, 90);
});

test('validateListing falls back to safe defaults for an unrecognized condition or confidence', () => {
  const out = validateListing({ ...GOOD, condition: 'LIKE_NEW', confidence: 'certain' });
  assert.equal(out.condition, 'USED_GOOD');
  assert.equal(out.confidence, 'low');
});

test('validateListing tolerates missing specifics and clips an over-long title to eBay\'s 80 characters', () => {
  const out = validateListing({ ...GOOD, specifics: undefined, title: 'X'.repeat(120) });
  assert.deepEqual(out.specifics, {});
  assert.equal(out.title.length, 80);
});

// --- resolveModels ---

test('resolveModels defaults to the primary and fallback models', () => {
  assert.deepEqual(resolveModels({}), [DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL]);
});

test('resolveModels honors NVIDIA_MODEL / NVIDIA_FALLBACK_MODEL and drops a duplicate fallback', () => {
  assert.deepEqual(resolveModels({ NVIDIA_MODEL: 'a/b', NVIDIA_FALLBACK_MODEL: 'c/d' }), ['a/b', 'c/d']);
  assert.deepEqual(resolveModels({ NVIDIA_MODEL: 'a/b', NVIDIA_FALLBACK_MODEL: 'a/b' }), ['a/b']);
});

test('resolveModels lets an empty NVIDIA_FALLBACK_MODEL disable the fallback', () => {
  assert.deepEqual(resolveModels({ NVIDIA_FALLBACK_MODEL: '' }), [DEFAULT_MODEL]);
});

// --- generateListing ---

test('generateListing returns a validated listing on the first good response', async () => {
  const client = fakeClient([JSON.stringify(GOOD)]);
  const out = await generateListing({ imagePaths: [], rawInput: 'relay' }, deps(client));
  assert.equal(out.part_number, '700-HC24Z24');
  assert.deepEqual(out.specifics, { Brand: 'Allen-Bradley', 'Coil Voltage': '24V DC' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, 'primary-model');
});

test('generateListing retries the same model when the output is not valid JSON', async () => {
  const client = fakeClient(['**Part Identification** it is a relay', JSON.stringify(GOOD)]);
  const out = await generateListing({ imagePaths: [], rawInput: 'relay' }, deps(client));
  assert.equal(out.title, GOOD.title);
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'primary-model']);
});

test('generateListing retries when the model returns blank fields', async () => {
  const blank = { ...GOOD, title: '', description: '' };
  const client = fakeClient([JSON.stringify(blank), JSON.stringify(GOOD)]);
  const out = await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.equal(out.title, GOOD.title);
});

test('generateListing moves to the fallback model when the primary is gone (404)', async () => {
  const client = fakeClient([statusError(404, 'Function not found for account'), JSON.stringify(GOOD)]);
  const out = await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.equal(out.title, GOOD.title);
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'fallback-model']);
});

test('generateListing moves to the fallback model on 410 (end-of-life model)', async () => {
  const client = fakeClient([statusError(410), JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'fallback-model']);
});

test('generateListing moves to the fallback model after repeated bad output from the primary', async () => {
  const client = fakeClient(['nope', 'still nope', JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'primary-model', 'fallback-model']);
});

test('generateListing falls back on a 5xx or 429 that the SDK already retried', async () => {
  const client = fakeClient([statusError(503), JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'fallback-model']);

  const client2 = fakeClient([statusError(429), JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client2));
  assert.deepEqual(client2.calls.map((c) => c.model), ['primary-model', 'fallback-model']);
});

test('generateListing falls back on a connection error or timeout', async () => {
  const client = fakeClient([new OpenAI.APIConnectionTimeoutError(), JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.deepEqual(client.calls.map((c) => c.model), ['primary-model', 'fallback-model']);
});

test('generateListing does not fall back on an auth failure - a bad key fails every model', async () => {
  const client = fakeClient([statusError(401, 'bad key'), JSON.stringify(GOOD)]);
  await assert.rejects(
    generateListing({ imagePaths: [], rawInput: 'x' }, deps(client)),
    /NVIDIA_API_KEY/,
  );
  assert.equal(client.calls.length, 1);
});

test('generateListing throws a clear error once every model has failed', async () => {
  const client = fakeClient([statusError(404), statusError(404)]);
  await assert.rejects(
    generateListing({ imagePaths: [], rawInput: 'x' }, deps(client)),
    /AI service|unavailable|try again/i,
  );
  assert.equal(client.calls.length, 2);
});

test('generateListing never mentions Kimi in its errors (the model is configurable)', async () => {
  const client = fakeClient([statusError(404), statusError(404)]);
  await assert.rejects(
    generateListing({ imagePaths: [], rawInput: 'x' }, deps(client)),
    (err) => !/kimi/i.test(err.message),
  );
});

test('generateListing surfaces a content-filter finish_reason without retrying', async () => {
  const client = fakeClient([{ raw: { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] } }]);
  await assert.rejects(
    generateListing({ imagePaths: [], rawInput: 'x' }, deps(client)),
    /declined/i,
  );
  assert.equal(client.calls.length, 1);
});

test('generateListing treats a length cut-off as retryable bad output', async () => {
  const cut = { raw: { choices: [{ finish_reason: 'length', message: { content: '{"title":"Rel' } }] } };
  const client = fakeClient([cut, JSON.stringify(GOOD)]);
  const out = await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.equal(out.title, GOOD.title);
});

test('generateListing normalizes an aborted request to an AbortError and stops immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient([new OpenAI.APIUserAbortError(), JSON.stringify(GOOD)]);
  await assert.rejects(
    generateListing({ imagePaths: [], rawInput: 'x', signal: controller.signal }, deps(client)),
    (err) => err.name === 'AbortError',
  );
  assert.equal(client.calls.length, 1);
});

test('generateListing sends at most MAX_AI_IMAGES photos to the model', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-img-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const paths = Array.from({ length: MAX_AI_IMAGES + 3 }, (_, i) => {
    const p = path.join(dir, `p${i}.png`);
    fs.writeFileSync(p, png);
    return p;
  });

  const client = fakeClient([JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: paths, rawInput: 'x' }, deps(client));

  const userContent = client.calls[0].messages.find((m) => m.role === 'user').content;
  assert.equal(userContent.filter((b) => b.type === 'image_url').length, MAX_AI_IMAGES);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generateListing asks for strict JSON-schema output', async () => {
  const client = fakeClient([JSON.stringify(GOOD)]);
  await generateListing({ imagePaths: [], rawInput: 'x' }, deps(client));
  assert.equal(client.calls[0].response_format.type, 'json_schema');
});
