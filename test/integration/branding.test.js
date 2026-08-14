import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  };
}

test('GET / renders with no data-theme attribute when default is system and no cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  // Anchored to the <html> tag itself, not just "data-theme=" anywhere in the
  // document — the shared header partial's CSS unconditionally contains
  // `:root[data-theme="dunkel"]` / `:root:not([data-theme="hell"])`, so an
  // unanchored regex would match that static CSS regardless of whether the
  // <html> tag actually carries the attribute.
  assert.doesNotMatch(res.text, /<html lang="de" data-theme=/);
  db.close();
});

test('GET / renders data-theme="dunkel" when a theme cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/').set('Cookie', 'theme=dunkel');
  assert.equal(res.status, 200);
  assert.match(res.text, /<html lang="de" data-theme="dunkel"/);
  db.close();
});

test('GET /branding/logo returns 404 when no logo is configured', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/branding/logo');
  assert.equal(res.status, 404);
  db.close();
});

test('the error page also renders the shared header partial', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_theme_default', 'hell');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /<html lang="de" data-theme="hell"/);
  db.close();
});
