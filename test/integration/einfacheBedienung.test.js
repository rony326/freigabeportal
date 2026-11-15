import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret', env: 'test', publicBaseUrl: 'http://portal.example.org',
    churchtools: { baseUrl: 'https://ct.example.org', clientId: 'c', clientSecret: 's', redirectUri: 'https://portal.example.org/auth/callback', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    n8nApiKey: 'k', downloadSigningSecret: 'x', jobsDir: '/tmp/freigabeportal-bedienung-test-jobs',
  };
}

async function login(db) {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'b@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  const agent = request.agent(createApp({ db, config }));
  const r = await agent.get('/auth/login');
  const state = new URL(r.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'c', state });
  return agent;
}

test('Schriftgrösse: Cookie steuert data-schrift, Unsinn fällt auf normal zurück', async () => {
  const db = openDatabase(':memory:');
  const agent = await login(db);
  assert.match((await agent.get('/pool')).text, /<html lang="de"[^>]*data-schrift="normal"/);
  assert.match((await agent.get('/pool').set('Cookie', 'schrift=gross')).text, /data-schrift="gross"/);
  assert.match((await agent.get('/pool').set('Cookie', 'schrift=sehr-gross')).text, /data-schrift="sehr-gross"/);
  assert.match((await agent.get('/pool').set('Cookie', 'schrift="><script>')).text, /data-schrift="normal"/);
  db.close();
});

test('Hilfe: Knopf und Text auf der Aufgabenseite, leere Liste erklärt sich', async () => {
  const db = openDatabase(':memory:');
  const agent = await login(db);
  const res = await agent.get('/pool');
  assert.match(res.text, /hilfe-knopf/);
  assert.match(res.text, /Hilfe: Aufgaben/);
  assert.match(res.text, /Alles erledigt\./);
  assert.match(res.text, /Du musst nichts tun/);
  db.close();
});

test('Bestätigung: Cookie erledigt zeigt einmal den Hinweis und wird gelöscht; Unsinn zeigt nichts', async () => {
  const db = openDatabase(':memory:');
  const agent = await login(db);
  const res = await agent.get('/pool').set('Cookie', 'erledigt=freigeben');
  assert.match(res.text, /erledigt-hinweis/);
  assert.match(res.text, /Freigegeben\./);
  assert.match([].concat(res.headers['set-cookie'] || []).join(';'), /erledigt=;/);
  const falsch = await agent.get('/pool').set('Cookie', 'erledigt=<b>x</b>');
  assert.doesNotMatch(falsch.text, /erledigt-hinweis/);
  db.close();
});

test('Befangenheits-Frage: Kontierung zeigt Karte mit beiden Antworten, IDs und Formularwerte bleiben', async () => {
  const { default: ejs } = await import('ejs');
  const html = await ejs.renderFile(new URL('../../views/_konflikt_frage.ejs', import.meta.url).pathname, { praefix: 'f2', values: { interessenskonflikt: 'ja' } });
  assert.match(html, /Betrifft dieser Beleg dich oder jemanden aus deinem Umfeld persönlich\?/);
  assert.match(html, /id="f2konfliktNein" value="nein"/);
  assert.match(html, /id="f2konfliktJa" value="ja" checked/);
  assert.match(html, /name="interessenskonflikt"/);
  assert.doesNotMatch(html, /data-konflikt-folge hidden/);
  const nein = await ejs.renderFile(new URL('../../views/_konflikt_frage.ejs', import.meta.url).pathname, { praefix: '', values: {} });
  assert.match(nein, /id="konfliktNein" value="nein" checked/);
  assert.match(nein, /data-konflikt-folge hidden/);
});
