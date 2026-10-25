import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createApp } from '../../src/app.js';
import { erstelleSpielwiese } from '../../src/services/testmodus/spielwiese.js';
import { createTestMailer } from '../../src/services/testmodus/testMailer.js';

// Jeder ausgehende fetch/undici-Aufruf wird festgehalten und scheitert (kein Netz).
const netzVersuche = [];
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
const dispatchOriginal = mockAgent.dispatch.bind(mockAgent);
mockAgent.dispatch = (opts, handler) => {
  netzVersuche.push(`${opts.method} ${opts.origin}${opts.path}`);
  return dispatchOriginal(opts, handler);
};
setGlobalDispatcher(mockAgent);

async function umgebung() {
  const dir = mkdtempSync(join(tmpdir(), 'testmodus-instanz-'));
  const config = {
    env: 'test',
    sessionSecret: 'test-secret',
    dbPath: join(dir, 'echt.sqlite'), jobsDir: join(dir, 'jobs'), brandingDir: join(dir, 'branding'),
    downloadSigningSecret: 'download-secret',
    n8nApiKey: 'n'.repeat(32), cronSecret: 'c'.repeat(32), backupApiKey: 'b'.repeat(32),
    smtp: { host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' },
    churchtools: { baseUrl: 'https://echt.example', clientId: 'id', clientSecret: 's'.repeat(32), redirectUri: 'https://echt.example/cb', syncServiceToken: 't'.repeat(32), groupIdAdmin: '1', groupIdBuchhaltung: '2' },
  };
  const echteDb = openDatabase(config.dbPath);
  seedDefaults(echteDb);
  const sp = await erstelleSpielwiese(echteDb, config);
  const mailer = createTestMailer();
  const testApp = createApp({ db: sp.db, config: sp.config, mailer, testmodus: true });
  // Die echte App setzt req.session; hier ein festes Sitzungsobjekt von aussen.
  const sitzung = { id: 'sitzung-test', personId: 'echt-admin', testmodus: { personId: 'test-1' } };
  const aussen = express();
  aussen.use((req, res, next) => { req.session = sitzung; testApp(req, res, next); });
  const agent = request.agent(aussen);
  const aufraeumen = () => { sp.db.close(); echteDb.close(); rmSync(dir, { recursive: true, force: true }); };
  return { echteDb, db: sp.db, mailer, sitzung, agent, aussen, aufraeumen };
}

const zaehle = (db) => ['personen', 'jobs', 'mail_log', 'freigaben', 'audit_ereignisse'].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
const csrfAus = (text) => text.match(/name="_csrf" value="([^"]+)"/)[1];

test('Netz-Sperre greift: fetch wird festgehalten und scheitert', async () => {
  netzVersuche.length = 0;
  await assert.rejects(fetch('https://beispiel.invalid/probe'));
  assert.equal(netzVersuche.length, 1);
  netzVersuche.length = 0;
});

test('createTestMailer sammelt nur und schickt nichts', async () => {
  const mailer = createTestMailer();
  await mailer.sendMail({ to: 'a@beispiel.invalid', subject: 'S', text: 'T' });
  assert.deepEqual(mailer.gesendet.map((m) => m.to), ['a@beispiel.invalid']);
});

test('/pool zeigt Beispielrechnungen und das Band als Anna', async () => {
  const u = await umgebung();
  const res = await u.agent.get('/pool');
  assert.equal(res.status, 200);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  const poolJob = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get().id;
  const annasJob = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung bei Anna.pdf'").get().id;
  assert.match(res.text, new RegExp(`id="pool-row-${poolJob}"`));
  assert.match(res.text, new RegExp(`id="kontierung-row-${annasJob}"`));
  assert.match(res.text, /Angemeldet als Anna Beispiel/);
  assert.match(res.text, /action="\/admin\/testmodus\/person"/);
  assert.match(res.text, /<option value="test-2"[^>]*>Ben Beispiel/);
  assert.match(res.text, /<option value="test-1" selected/);
  assert.match(res.text, /action="\/admin\/testmodus\/aus"[\s\S]*?Testmodus beenden/);
  // Beide Band-Formulare tragen das CSRF-Feld.
  const band = res.text.slice(res.text.indexOf('class="testmodus-band"'), res.text.indexOf('<header'));
  assert.equal((band.match(/name="_csrf" value="[^"]+"/g) || []).length, 2);
  u.aufraeumen();
});

test('Band erscheint auch auf Fehlerseiten der Test-Instanz', async () => {
  const u = await umgebung();
  const res = await u.agent.get('/gibt-es-nicht');
  assert.equal(res.status, 404);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  u.aufraeumen();
});

test('Rundreise: Anna kontiert, Anna darf nicht freigeben, Ben gibt frei — Mail nur im Test-Mailer, kein Netz, echte DB unverändert', async () => {
  const u = await umgebung();
  const vorher = zaehle(u.echteDb);
  netzVersuche.length = 0;
  const job = u.db.prepare("SELECT id FROM jobs WHERE dateiname = 'Rechnung im Pool.pdf'").get();
  const konto = u.db.prepare("SELECT id FROM konten WHERE kontonummer = '3000'").get();
  const kreditor = u.db.prepare("SELECT id FROM kreditoren WHERE name = 'Muster Druck AG'").get();

  const token = csrfAus((await u.agent.get('/pool')).text);
  assert.equal((await u.agent.post(`/api/pool/${job.id}/beanspruchen`).type('form').send({ _csrf: token })).status, 200);
  const kont = await u.agent.post(`/kontierung/${job.id}`).type('form').send({
    kontoId: String(konto.id), kreditorId: String(kreditor.id), absender: 'Muster Druck AG', rechnungsnummer: 'BSP-RT',
    betrag: '120.00', zahlungsziel: '2026-12-31', interessenskonflikt: 'nein', begruendung: '', _csrf: token,
  });
  assert.equal(kont.status, 302);
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'freigabe2');

  // Vier-Augen: Anna (Freigabe 1) kann nicht auch Freigabe 2 erteilen.
  await u.agent.post(`/freigabe2/${job.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: token });
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'freigabe2');

  // Rollenwechsel: dieselbe Sitzung, jetzt als Ben.
  u.sitzung.testmodus.personId = 'test-2';
  const formular = await u.agent.get(`/freigabe2/${job.id}`);
  assert.equal(formular.status, 200);
  assert.match(formular.text, /Angemeldet als Ben Beispiel/);
  const f2 = await u.agent.post(`/freigabe2/${job.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: csrfAus(formular.text) });
  assert.equal(f2.status, 302);
  assert.equal(u.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'abgeschlossen');

  // Mail an Ben: nur im Test-Mailer, in der Spiel-DB als versendet.
  assert.ok(u.mailer.gesendet.some((m) => m.to === 'ben@beispiel.invalid'));
  assert.ok(u.mailer.gesendet.every((m) => m.to.endsWith('@beispiel.invalid')));
  const log = u.db.prepare("SELECT status FROM mail_log WHERE empfaenger = 'ben@beispiel.invalid'").all();
  assert.ok(log.length > 0 && log.every((z) => z.status === 'versendet'));

  assert.deepEqual(netzVersuche, []);
  assert.deepEqual(zaehle(u.echteDb), vorher);
  u.aufraeumen();
});

test('Maschinen-Routen antworten in der Test-Instanz mit 401, auch mit den echten Schlüsseln', async () => {
  const u = await umgebung();
  for (const [pfad, header, wert] of [
    ['/api/n8n/jobs/abholbereit', 'X-API-Key', 'n'.repeat(32)],
    ['/api/n8n/kk-belege/offen', 'X-API-Key', 'n'.repeat(32)],
    ['/api/n8n/backup/status', 'X-API-Key', 'b'.repeat(32)],
    ['/internal/cron/pool-erinnerungen', 'X-Cron-Secret', 'c'.repeat(32)],
  ]) {
    assert.equal((await request(u.aussen).get(pfad).set(header, wert)).status, 401, pfad);
    assert.equal((await request(u.aussen).post(pfad).set(header, wert)).status, 401, `POST ${pfad}`);
  }
  u.aufraeumen();
});

test('kein Login-Router und kein /healthz in der Test-Instanz', async () => {
  const u = await umgebung();
  assert.equal((await u.agent.get('/auth/login')).status, 404);
  assert.equal((await u.agent.get('/healthz')).status, 404);
  u.aufraeumen();
});

test('Person-ID ausserhalb test-* oder fehlend → 403', async () => {
  const u = await umgebung();
  u.sitzung.testmodus.personId = 'echt-admin';
  // Selbst wenn eine solche Person in der Spiel-DB stünde, gilt nur test-*.
  upsertPerson(u.db, { id: 'echt-admin', vorname: 'Echt', nachname: 'Admin', email: 'e@x.invalid', gruppen: ['test-admin', 'test-buchhaltung'] });
  const res = await u.agent.get('/pool');
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, /pool-row-/);
  u.sitzung.testmodus = null;
  assert.equal((await u.agent.get('/pool')).status, 403);
  u.sitzung.testmodus = { personId: 'test-99' };
  assert.equal((await u.agent.get('/pool')).status, 403);
  u.aufraeumen();
});

test('Dora (Admin der Test-Konfiguration) sieht den Admin-Bereich', async () => {
  const u = await umgebung();
  u.sitzung.testmodus.personId = 'test-4';
  const res = await u.agent.get('/admin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Testmodus — nichts hier ist echt/);
  u.aufraeumen();
});
