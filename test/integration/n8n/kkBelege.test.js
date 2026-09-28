import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { createKreditkarte, setErfasser } from '../../../src/db/kreditkartenRepo.js';
import { getKkBelegById } from '../../../src/db/kkBelegeRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nKkBelegeRouter } from '../../../src/routes/n8n/kkBelege.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
import { PNG_1X1 } from '../../helpers/imageFixture.js';

function setup({ modul = '1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kk-mail-'));
  const config = { n8nApiKey: 'n8n-key', jobsDir: dir, publicBaseUrl: 'https://p.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', modul);
  setConfigValue(db, 'mail_batching_aktiv', '1'); // proves kk-beleg-eingegangen bypasses batching
  upsertPerson(db, { id: '1', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Anna', nachname: 'Kauf', email: 'Anna.Kauf@example.org', gruppen: [] });
  const karte = createKreditkarte(db, { bezeichnung: 'Visa Zu', verantwortlichId: '1', erfassungOffen: false });
  setErfasser(db, karte, ['2']);
  const sent = [];
  const app = express();
  app.use('/api/n8n/kk-belege', requireApiKey(config), createN8nKkBelegeRouter({ db, config, mailer: { async sendMail(m) { sent.push(m); } } }));
  return { db, app, karte, sent, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a known sender creates an Entwurf with the only allowed card pre-filled, plus suggestions, and gets an immediate mail', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['Quittung 03.09.2026', 'Total CHF 12.50']);
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'Anna <anna.kauf@example.org>').attach('pdf', pdf, 'quittung.pdf');
  assert.equal(res.status, 201);
  const b = getKkBelegById(t.db, res.body.id);
  assert.equal(b.status, 'entwurf');
  assert.equal(b.quelle, 'mail');
  assert.equal(b.hochgeladen_von, '2');
  assert.equal(b.kreditkarte_id, t.karte);
  assert.equal(b.betrag, '12.50');
  assert.equal(b.kaufdatum, '2026-09-03');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'Anna.Kauf@example.org');
  t.cleanup();
});

test('an image receipt by mail is converted to PDF', async () => {
  const t = setup();
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', PNG_1X1, { filename: 'foto.png', contentType: 'image/png' });
  assert.equal(res.status, 201);
  assert.ok(getKkBelegById(t.db, res.body.id).pdf_pfad.endsWith('.pdf'));
  t.cleanup();
});

test('unknown sender → 422, module off → 409, bad file → 400', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['x']);
  const r1 = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'fremd@example.org').attach('pdf', pdf, 'x.pdf');
  assert.equal(r1.status, 422);
  assert.equal(r1.body.fehler, 'absender_unbekannt');
  const r2 = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', Buffer.from('nope'), 'x.pdf');
  assert.equal(r2.status, 400);
  t.cleanup();
  const t2 = setup({ modul: '0' });
  const r3 = await request(t2.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', pdf, 'x.pdf');
  assert.equal(r3.status, 409);
  t2.cleanup();
});

test('a sender address shared by two active persons → 422 absender_mehrdeutig, nothing created', async () => {
  const t = setup();
  upsertPerson(t.db, { id: '3', vorname: 'Zweite', nachname: 'Kauf', email: 'anna.kauf@example.org', gruppen: [] });
  const pdf = await buildPdfFixture(['x']);
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', pdf, 'x.pdf');
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, { fehler: 'absender_mehrdeutig' });
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM kk_belege').get().n, 0);
  assert.equal(t.sent.length, 0);
  t.cleanup();
});

test('a %PDF-prefixed but unreadable PDF still creates an Entwurf without Betrag and Kaufdatum', async () => {
  const t = setup();
  const kaputt = Buffer.from('%PDF-1.4\n%kein-lesbarer-pdf-inhalt\n');
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', kaputt, 'x.pdf');
  assert.equal(res.status, 201);
  const b = getKkBelegById(t.db, res.body.id);
  assert.equal(b.status, 'entwurf');
  assert.equal(b.betrag, null);
  assert.equal(b.kaufdatum, null);
  t.cleanup();
});
