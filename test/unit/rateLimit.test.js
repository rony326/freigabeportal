import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {
  createPublicRateLimiter,
  createSessionRateLimiter,
  createMachineRateLimiter,
  RATE_LIMIT_MESSAGE,
} from '../../src/middleware/rateLimit.js';

function buildTestApp(limiter) {
  const app = express();
  app.use((req, res, next) => {
    const personId = req.headers['x-test-person-id'];
    if (personId) {
      req.currentPerson = { churchtools_person_id: personId };
    }
    next();
  });
  app.get('/probe', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

test('createPublicRateLimiter allows every request under the limit', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 3, windowMs: 60000 }));
  for (let i = 0; i < 3; i++) {
    const res = await request(app).get('/probe');
    assert.equal(res.status, 200);
  }
});

test('createPublicRateLimiter returns 429 with the exact German message once the limit is exceeded', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 2, windowMs: 60000 }));
  await request(app).get('/probe');
  await request(app).get('/probe');
  const res = await request(app).get('/probe');
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, RATE_LIMIT_MESSAGE);
});

test('createPublicRateLimiter sets modern RateLimit-* headers, never the legacy X-RateLimit-* ones', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 5, windowMs: 60000 }));
  const res = await request(app).get('/probe');
  assert.equal(res.status, 200);
  assert.ok(res.headers['ratelimit-limit'] !== undefined, 'expected a RateLimit-Limit header');
  assert.equal(res.headers['x-ratelimit-limit'], undefined, 'legacy X-RateLimit-Limit header must not be set');
});

test('createPublicRateLimiter keys by IP: two different IPs each get their own counter', async () => {
  const app = express();
  app.set('trust proxy', true);
  app.get('/probe', createPublicRateLimiter({ limit: 1, windowMs: 60000 }), (req, res) => res.json({ ok: true }));

  const ipAFirst = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(ipAFirst.status, 200);
  const ipASecond = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(ipASecond.status, 429, 'the same IP exceeded its own limit');

  const ipBFirst = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.20');
  assert.equal(ipBFirst.status, 200, 'a different IP has an independent counter, unaffected by IP A');
});
// createMachineRateLimiter uses the exact same default (unmodified) IP-based keying as
// createPublicRateLimiter — neither overrides keyGenerator — so the guarantee proven above
// applies to it too; no separate test duplicates this mechanism for the machine tier.

test('createSessionRateLimiter keys by churchtools_person_id: two different people each get their own counter', async () => {
  const app = buildTestApp(createSessionRateLimiter({ limit: 1, windowMs: 60000 }));

  const personAFirst = await request(app).get('/probe').set('x-test-person-id', 'A');
  assert.equal(personAFirst.status, 200);
  const personASecond = await request(app).get('/probe').set('x-test-person-id', 'A');
  assert.equal(personASecond.status, 429, 'person A exceeded their own limit');

  const personBFirst = await request(app).get('/probe').set('x-test-person-id', 'B');
  assert.equal(personBFirst.status, 200, 'person B has an independent counter, unaffected by person A');
});

test('createSessionRateLimiter falls back to req.ip when req.currentPerson is absent', async () => {
  const app = buildTestApp(createSessionRateLimiter({ limit: 2, windowMs: 60000 }));
  const res1 = await request(app).get('/probe');
  const res2 = await request(app).get('/probe');
  const res3 = await request(app).get('/probe');
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res3.status, 429, 'anonymous requests still get limited via the IP fallback');
});

test('createMachineRateLimiter returns 429 once its limit is exceeded', async () => {
  const app = buildTestApp(createMachineRateLimiter({ limit: 2, windowMs: 60000 }));
  await request(app).get('/probe');
  await request(app).get('/probe');
  const res = await request(app).get('/probe');
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, RATE_LIMIT_MESSAGE);
});
