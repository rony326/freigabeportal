import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import express from 'express';
import { createHash } from 'node:crypto';
import { createHealthzRouter } from '../../src/routes/healthz.js';
import { createStatusCache } from '../../src/services/statusPruefungen.js';
import { createTsaErreichbarkeit } from '../../src/services/statusTsa.js';

const hash = (k) => createHash('sha256').update(k).digest('hex');

const KEY = 'ab'.repeat(32);
const DIENSTE = ['datenbank', 'sicherung', 'mailversand', 'churchtools', 'zeitstempel', 'audit_nachweis', 'archivuebergabe', 'speicher', 'jobs', 'sicherheitsalarme', 'einrichtung'];

function config() {
  return {
    sessionSecret: 'test-secret', env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    n8nApiKey: 'k', downloadSigningSecret: 's', jobsDir: '/tmp/freigabeportal-healthz-test-jobs',
  };
}
function setup({ secret = KEY, tsaVersuch } = {}) {
  const db = openDatabase(':memory:');
  if (secret) setConfigValue(db, 'monitoring_secret', hash(secret));
  return { db, app: createApp({ db, config: config(), tsaVersuch }) };
}

test('ohne Schlüssel: exakt Kurzantwort, kein Cookie', async () => {
  const { db, app } = setup();
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"status":"ok"}');
  assert.equal(res.headers['set-cookie'], undefined);
  db.close();
});

test('falscher, kurzer und überlanger Schlüssel: Kurzantwort', async () => {
  const { db, app } = setup();
  for (const k of ['cd'.repeat(32), 'ab', 'ab'.repeat(40)]) {
    const res = await request(app).get('/healthz').set('X-Monitoring-Key', k);
    assert.equal(res.status, 200);
    assert.equal(res.text, '{"status":"ok"}');
  }
  db.close();
});

test('gespeichert wird nur der Hash: Klartextwert in der DB ist kein gültiger Schlüssel', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'monitoring_secret', KEY);
  const app = createApp({ db, config: config() });
  const res = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(res.text, '{"status":"ok"}', 'alter Klartextschlüssel muss neu erzeugt werden');
  db.close();
});

test('leeres monitoring_secret: nie Details, auch nicht mit leerem Header', async () => {
  const { db, app } = setup({ secret: '' });
  for (const k of ['', 'x', KEY]) {
    const res = await request(app).get('/healthz').set('X-Monitoring-Key', k);
    assert.equal(res.text, '{"status":"ok"}');
  }
  db.close();
});

test('gültiger Schlüssel: volles JSON mit allen Diensten', async () => {
  const { db, app } = setup();
  const res = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.dienste), DIENSTE);
  assert.ok(['ok', 'warnung', 'fehler'].includes(res.body.status));
  assert.match(res.body.version, /^\d+\.\d+\.\d+/);
  assert.ok(res.body.geprueft_am);
  assert.equal(res.headers['set-cookie'], undefined);
  db.close();
});

test('geschlossene Datenbank: 503 mit und ohne Schlüssel', async () => {
  const { db, app } = setup();
  db.close();
  const a = await request(app).get('/healthz');
  assert.equal(a.status, 503);
  assert.equal(a.text, '{"status":"fehler"}');
  const b = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(b.status, 503);
});

test('TSA-Versuch hängt: Antwort ohne Warten, kein zweiter Versuch innerhalb 15 min', async () => {
  let aufrufe = 0;
  const { db, app } = setup({ tsaVersuch: () => { aufrufe++; return new Promise(() => {}); } });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const t0 = Date.now();
  const r1 = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  const r2 = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(aufrufe, 1);
  db.close();
});

test('TSA-Ergebnis wird zwischengespeichert und fließt ein (nach Ablauf des Status-Caches)', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'monitoring_secret', hash(KEY));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const tsaErreichbarkeit = createTsaErreichbarkeit();
  const tsaVersuch = async () => { throw new Error('nein'); };
  const app = express().use('/healthz', createHealthzRouter({
    db, config: config(), statusCache: createStatusCache({ db, config: config(), tsaErreichbarkeit, tsaVersuch, ttlMs: 0 }),
  }));
  await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  await new Promise((r) => setTimeout(r, 20));
  const res = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(res.body.dienste.zeitstempel.status, 'fehler');
  db.close();
});

test('Status-Cache: zweiter Aufruf innerhalb 30 s liefert dasselbe Ergebnis ohne neue Prüfung', async () => {
  const { db, app } = setup();
  const r1 = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  db.prepare("INSERT INTO sicherheitsalarme (alarm_typ, schluessel, erkannt_am, naechster_versuch_am) VALUES ('backup_loeschung_offen', 'k', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  const r2 = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  assert.equal(r2.body.geprueft_am, r1.body.geprueft_am);
  assert.equal(r2.body.dienste.sicherheitsalarme.status, 'ok');
  db.close();
});

test('Limiter: 121. Anfrage in einer Minute -> 429', async () => {
  const { db, app } = setup();
  let letzte;
  for (let i = 0; i < 121; i++) letzte = await request(app).get('/healthz');
  assert.equal(letzte.status, 429);
  db.close();
});

test('keine Personendaten, Pfade oder URLs im JSON', async () => {
  const { db, app } = setup();
  upsertPerson(db, { id: 7, gruppen: [], vorname: 'Erika', nachname: 'Musterfrau', email: 'erika@example.org' });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const res = await request(app).get('/healthz').set('X-Monitoring-Key', KEY);
  const t = res.text;
  assert.ok(!/erika|musterfrau|example\.org|https?:|\/tmp|\/config|\/data/i.test(t), t);
  db.close();
});
