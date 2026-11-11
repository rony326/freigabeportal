import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function appMit(publicBaseUrl) {
  const db = openDatabase(':memory:');
  const config = {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl,
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'id', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30', syncServiceToken: 't' },
    cronSecret: 'c', n8nApiKey: 'k', smtp: {},
  };
  return { db, app: createApp({ db, config }) };
}

// /auth/login legt die Sitzung an (OAuth-state) und setzt damit das Cookie.
async function sitzungsCookie(app, https) {
  let req = request(app).get('/auth/login');
  if (https) req = req.set('X-Forwarded-Proto', 'https');
  const res = await req;
  return [].concat(res.headers['set-cookie'] || []).find((c) => /sid=/.test(c));
}

test('hinter HTTPS: __Host--Cookie mit Secure, Path=/, HttpOnly, SameSite=Lax, ohne Domain, 8 Stunden', async () => {
  const { db, app } = appMit('https://portal.example.org');
  const cookie = await sitzungsCookie(app, true);
  db.close();
  assert.match(cookie, /^__Host-portal\.sid=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain=/i);
  const laufzeitMs = Date.parse(/Expires=([^;]+)/.exec(cookie)[1]) - Date.now();
  assert.ok(Math.abs(laufzeitMs - 8 * 3600 * 1000) < 60_000, `Laufzeit ${laufzeitMs} ms`);
});

test('ohne HTTPS (lokal/Test): Standardname connect.sid, damit Entwicklung über http funktioniert', async () => {
  const { db, app } = appMit('http://localhost:3000');
  const cookie = await sitzungsCookie(app, false);
  db.close();
  assert.match(cookie, /^connect\.sid=/);
});
