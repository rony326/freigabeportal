import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requireCronSecret } from '../../src/middleware/cronAuth.js';

function buildTestApp() {
  const app = express();
  app.post('/protected', requireCronSecret({ cronSecret: 'correct-secret' }), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireCronSecret returns 401 without the header', async () => {
  const res = await request(buildTestApp()).post('/protected');
  assert.equal(res.status, 401);
});

test('requireCronSecret returns 401 with the wrong secret', async () => {
  const res = await request(buildTestApp()).post('/protected').set('X-Cron-Secret', 'wrong');
  assert.equal(res.status, 401);
});

test('requireCronSecret calls next with the correct secret', async () => {
  const res = await request(buildTestApp()).post('/protected').set('X-Cron-Secret', 'correct-secret');
  assert.equal(res.status, 200);
});
