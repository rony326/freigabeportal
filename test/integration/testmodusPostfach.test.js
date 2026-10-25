import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createApp } from '../../src/app.js';
import { erstelleSpielwiese } from '../../src/services/testmodus/spielwiese.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';

async function umgebung() {
  const dir = mkdtempSync(join(tmpdir(), 'testmodus-postfach-'));
  const config = {
    env: 'test', sessionSecret: 'test-secret',
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'),
    backupDir: join(dir, 'backups'), backupKeyringFile: join(dir, 'keyring.json'),
    downloadSigningSecret: 'download-secret',
    n8nApiKey: 'n'.repeat(32), cronSecret: 'c'.repeat(32), backupApiKey: 'b'.repeat(32),
    smtp: { host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' },
    churchtools: { baseUrl: 'https://echt.example', clientId: 'id', clientSecret: 's'.repeat(32), redirectUri: 'https://echt.example/cb', syncServiceToken: 't'.repeat(32), groupIdAdmin: '1', groupIdBuchhaltung: '2', customFieldIban: 'iban', customFieldKontoinhaber: 'kontoinhaber' },
  };
  for (const d of [config.jobsDir, config.brandingDir, config.backupDir]) mkdirSync(d, { recursive: true });
  const echteDb = openDatabase(config.dbPath);
  seedDefaults(echteDb);
  upsertPerson(echteDb, { id: 'echt-admin', vorname: 'Echt', nachname: 'Admin', email: 'echt@example.org', gruppen: ['1', '2'] });
  const sp = await erstelleSpielwiese(echteDb, config);
  const testApp = createApp({ db: sp.db, config: sp.config, mailer: createTestMailer(), testmodus: true });
  const echteApp = createApp({ db: echteDb, config, mailer: createTestMailer() });
  const sitzung = { id: 'sitzung-test', personId: 'echt-admin', testmodus: { personId: 'test-4' } };
  const aussen = express();
  aussen.use((req, res, next) => {
    req.session = sitzung;
    return (sitzung.testmodus ? testApp : echteApp)(req, res, next);
  });
  const aufraeumen = () => { sp.db.close(); echteDb.close(); rmSync(dir, { recursive: true, force: true }); };
  return { echteDb, db: sp.db, sitzung, agent: request.agent(aussen), echteApp, aufraeumen };
}

const csrfAus = (text) => text.match(/name="_csrf" value="([^"]+)"/)[1];
const mails = (db) => db.prepare('SELECT * FROM mail_log').all();

test('Postfach zeigt die Mails der Spiel-DB, neueste zuerst, Text escaped', async () => {
  const u = await umgebung();
  const ins = db => (zeit, betreff, text) => db.prepare(`INSERT INTO mail_log (typ, empfaenger, betreff, text, status, versucht_am) VALUES ('zuweisung', 'ben@beispiel.invalid', ?, ?, 'versendet', ?)`).run(betreff, text, zeit);
  ins(u.db)('2026-01-01T10:00:00.000Z', 'Alt-Betreff', 'alt');
  ins(u.db)('2026-02-01T10:00:00.000Z', 'Neu-Betreff', '<script>alert(1)</script>');
  const res = await u.agent.get('/testmodus/postfach');
  assert.equal(res.status, 200);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  assert.match(res.text, /ben@beispiel\.invalid/);
  assert.ok(res.text.indexOf('Neu-Betreff') < res.text.indexOf('Alt-Betreff'));
  assert.doesNotMatch(res.text, /<script>alert\(1\)/);
  assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  u.aufraeumen();
});

test('Postfach zeigt die beim Freigeben entstandene Mail', async () => {
  const u = await umgebung();
  u.sitzung.testmodus = { personId: 'test-1' };
  const job = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const konto = u.db.prepare("SELECT id FROM konten WHERE kontonummer = '3000'").get();
  const kreditor = u.db.prepare("SELECT id FROM kreditoren WHERE name = 'Muster Druck AG'").get();
  const token = csrfAus((await u.agent.get('/pool')).text);
  await u.agent.post(`/api/pool/${job.id}/beanspruchen`).type('form').send({ _csrf: token });
  const kont = await u.agent.post(`/kontierung/${job.id}`).type('form').send({
    kontoId: String(konto.id), kreditorId: String(kreditor.id), absender: 'Muster Druck AG', rechnungsnummer: 'BSP-PF',
    betrag: '120.00', zahlungsziel: '2026-12-31', interessenskonflikt: 'nein', begruendung: '', _csrf: token,
  });
  assert.equal(kont.status, 302);
  const res = await u.agent.get('/testmodus/postfach');
  assert.equal(res.status, 200);
  assert.match(res.text, /ben@beispiel\.invalid/);
  u.aufraeumen();
});

test('Jobs auslösen: Erinnerungsmails im Postfach, echte DB unberührt', async () => {
  const u = await umgebung();
  u.db.prepare("UPDATE jobs SET eingang_am = '2020-01-01T00:00:00.000Z' WHERE dateiname = 'Rechnung im Pool.pdf'").run();
  const echteMailsVorher = mails(u.echteDb).length;
  const echteAuditVorher = u.echteDb.prepare('SELECT COUNT(*) c FROM audit_ereignisse').get().c;
  const vorher = mails(u.db).length;
  const token = csrfAus((await u.agent.get('/testmodus/postfach')).text);
  const res = await u.agent.post('/testmodus/jobs').type('form').send({ _csrf: token });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/testmodus\/postfach/);
  assert.ok(mails(u.db).length > vorher, 'Erinnerungsmails in der Spiel-DB');
  assert.ok(mails(u.db).some((m) => m.typ === 'reminder' && m.empfaenger.endsWith('@beispiel.invalid')));
  const seite = await u.agent.get(res.headers.location);
  assert.match(seite.text, /Erinnerungen|pool-erinnerungen/);
  assert.equal(mails(u.echteDb).length, echteMailsVorher);
  assert.equal(u.echteDb.prepare('SELECT COUNT(*) c FROM audit_ereignisse').get().c, echteAuditVorher);
  u.aufraeumen();
});

test('Jobs ohne CSRF-Token werden abgelehnt', async () => {
  const u = await umgebung();
  const res = await u.agent.post('/testmodus/jobs').type('form').send({});
  assert.equal(res.status, 403);
  u.aufraeumen();
});

test('Band: Links Test-Postfach und Jobs auslösen, Jobs-Formular mit Test-Token', async () => {
  const u = await umgebung();
  const res = await u.agent.get('/pool');
  assert.match(res.text, /href="\/testmodus\/postfach"[^>]*>Test-Postfach/);
  const form = res.text.match(/<form[^>]*action="\/testmodus\/jobs"[\s\S]*?<\/form>/)[0];
  assert.match(form, /Jobs auslösen/);
  assert.match(form, /name="_csrf" value="[^"]+"/);
  u.aufraeumen();
});

test('in der echten App gibt es /testmodus/* nicht (404)', async () => {
  const u = await umgebung();
  u.sitzung.testmodus = null;
  assert.equal((await u.agent.get('/testmodus/postfach')).status, 404);
  assert.equal((await u.agent.post('/testmodus/jobs').type('form').send({})).status, 404);
  u.aufraeumen();
});
