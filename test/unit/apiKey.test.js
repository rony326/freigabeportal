import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requireApiKey } from '../../src/middleware/apiKey.js';

function buildTestApp() {
  const app = express();
  app.get('/protected', requireApiKey({ n8nApiKey: 'correct-key' }), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireApiKey returns 401 when the header is missing', async () => {
  const res = await request(buildTestApp()).get('/protected');
  assert.equal(res.status, 401);
});

test('requireApiKey returns 401 when the key is wrong', async () => {
  const res = await request(buildTestApp()).get('/protected').set('X-API-Key', 'wrong-key');
  assert.equal(res.status, 401);
});

test('requireApiKey calls next when the key matches', async () => {
  const res = await request(buildTestApp()).get('/protected').set('X-API-Key', 'correct-key');
  assert.equal(res.status, 200);
});

test('requireApiKey returns 401 (not a crash) when the provided key is a different length', async () => {
  const res = await request(buildTestApp()).get('/protected').set('X-API-Key', 'a-much-longer-key-than-expected');
  assert.equal(res.status, 401);
});
