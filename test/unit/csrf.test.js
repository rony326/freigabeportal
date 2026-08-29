import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createCsrfProtection } from '../../src/middleware/csrf.js';

function buildTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { id: req.headers['x-test-session-id'] || 'test-session-id' };
    next();
  });
  app.use(cookieParser());
  const { attachCsrfToken, csrfProtection } = createCsrfProtection({ sessionSecret: 'test-secret' });
  app.get('/form', attachCsrfToken, (req, res) => res.json({ csrfToken: res.locals.csrfToken }));
  app.post('/protected', csrfProtection, (req, res) => res.json({ ok: true }));
  app.post('/protected-header', csrfProtection, (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.code || 'error' });
  });
  return app;
}

async function getTokenAndCookie(agent) {
  const res = await agent.get('/form');
  const cookie = res.headers['set-cookie'];
  return { token: res.body.csrfToken, cookie };
}

test('POST without a CSRF cookie or token is rejected', async () => {
  const res = await request(buildTestApp()).post('/protected').type('form').send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'EBADCSRFTOKEN');
});

test('POST with the cookie but no token field is rejected', async () => {
  const app = buildTestApp();
  const agent = request.agent(app);
  await getTokenAndCookie(agent);
  const res = await agent.post('/protected').type('form').send({});
  assert.equal(res.status, 403);
});

test('POST with a valid cookie and matching _csrf body field succeeds', async () => {
  const app = buildTestApp();
  const agent = request.agent(app);
  const { token } = await getTokenAndCookie(agent);
  const res = await agent.post('/protected').type('form').send({ _csrf: token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('POST with a valid cookie and matching x-csrf-token header succeeds (AJAX path)', async () => {
  const app = buildTestApp();
  const agent = request.agent(app);
  const { token } = await getTokenAndCookie(agent);
  const res = await agent.post('/protected-header').set('x-csrf-token', token).send({});
  assert.equal(res.status, 200);
});

test('POST with a tampered token is rejected', async () => {
  const app = buildTestApp();
  const agent = request.agent(app);
  await getTokenAndCookie(agent);
  const res = await agent.post('/protected').type('form').send({ _csrf: 'tampered-value' });
  assert.equal(res.status, 403);
});

test('a token minted for one session is rejected under a different session', async () => {
  const app = buildTestApp();
  const res1 = await request(app).get('/form').set('x-test-session-id', 'session-a');
  const { csrfToken } = res1.body;
  const cookie = res1.headers['set-cookie'];

  const res2 = await request(app)
    .post('/protected')
    .type('form')
    .set('Cookie', cookie)
    .set('x-test-session-id', 'session-b')
    .send({ _csrf: csrfToken });
  assert.equal(res2.status, 403);
});
