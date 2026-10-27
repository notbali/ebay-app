const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider, generateListing } = require('../services/aiService');

test('resolveProvider defaults to the NVIDIA service when AI_PROVIDER is unset', () => {
  assert.equal(resolveProvider(undefined), './nvidiaService');
  assert.equal(resolveProvider(''), './nvidiaService');
});

test('resolveProvider picks each known provider', () => {
  assert.equal(resolveProvider('nvidia'), './nvidiaService');
  assert.equal(resolveProvider('claude'), './claudeService');
});

test('resolveProvider keeps the legacy "kimi" value working so existing deployments boot unchanged', () => {
  assert.equal(resolveProvider('kimi'), './nvidiaService');
});

test('resolveProvider rejects an unknown provider with a message listing the valid ones', () => {
  assert.throws(() => resolveProvider('gemini'), /Unknown AI_PROVIDER "gemini".*nvidia.*claude/);
});

test('requiring aiService does not need an API key just to load', () => {
  assert.equal(typeof generateListing, 'function');
});
