import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import ejs from 'ejs';
import { ansichtWahl, ANSICHT_SCHLUESSEL } from '../../src/middleware/ansicht.js';

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(ansichtWahl());
  a.use((req, res) => res.json({ ansicht: res.locals.ansicht, ansichtSchluessel: res.locals.ansichtSchluessel }));
  return a;
}

test('gültiges ?ansicht setzt Cookie und leitet ohne ansicht-Parameter um', async () => {
  const res = await request(app()).get('/admin/vorgaenge?status=kontierung&ansicht=kacheln&probleme=1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/vorgaenge?status=kontierung&probleme=1');
  const cookie = res.headers['set-cookie'].join(';');
  assert.match(cookie, /ansicht_admin-vorgaenge=kacheln/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /SameSite=Lax/);
});

test('Redirect ohne weitere Query hat keinen Fragezeichen-Rest', async () => {
  const res = await request(app()).get('/pool/?ansicht=tabelle');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
});

test('ungültiger ansicht-Wert: kein Cookie, auto', async () => {
  const res = await request(app()).get('/pool?ansicht=quatsch');
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.body.ansicht, 'auto');
});

test('Pfad ohne Schlüssel: kein Cookie, kein Redirect', async () => {
  const res = await request(app()).get('/admin/konten?ansicht=kacheln');
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.body.ansichtSchluessel, null);
});

test('Cookie wird gelesen, auch mit abschliessendem Slash', async () => {
  const res = await request(app()).get('/pool/').set('Cookie', 'ansicht_pool=kacheln');
  assert.equal(res.body.ansicht, 'kacheln');
  assert.equal(res.body.ansichtSchluessel, 'pool');
});

test('kaputtes Cookie ergibt auto', async () => {
  const res = await request(app()).get('/pool').set('Cookie', 'ansicht_pool=kaputt');
  assert.equal(res.body.ansicht, 'auto');
});

test('kein Open Redirect: Doppelslash-Pfade matchen nicht', async () => {
  const res = await request(app()).get('//evil.example/pool?ansicht=kacheln');
  assert.notEqual(res.status, 302);
});

test('alle sieben Schlüssel vorhanden', () => {
  assert.equal(Object.keys(ANSICHT_SCHLUESSEL).length, 7);
});

test('Umschalter rendert nur mit Schlüssel und markiert gewählte Ansicht', async () => {
  const leer = await ejs.renderFile('views/_ansicht_umschalter.ejs', { ansichtSchluessel: null, ansicht: 'auto', ansichtBasisQuery: '' });
  assert.equal(leer.trim(), '');
  const html = await ejs.renderFile('views/_ansicht_umschalter.ejs', { ansichtSchluessel: 'pool', ansicht: 'kacheln', ansichtBasisQuery: 'status=x' });
  assert.match(html, /href="\?status=x&amp;ansicht=kacheln"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /☰ Tabelle/);
  assert.match(html, /▦ Kacheln/);
});
