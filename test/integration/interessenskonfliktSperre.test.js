import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import {
  createJob, getJobById, eskalierenFreigabe2, eskalierenFreigabe2AnAdmin, ablehnenJob, wiederOeffnenJob,
  listFreigabe2JobsForPerson,
} from '../../src/db/jobsRepo.js';
import { ermittleZustaendigkeit, standToken } from '../../src/services/vorgangZustaendigkeit.js';
import { umhaengeVorgang } from '../../src/services/vorgangUmhaengen.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createSpesenFreigabe1Router } from '../../src/routes/spesenFreigabe1.js';

// Ein erklärter Interessenskonflikt gehört zur Rechnung: wer ihn erklärt hat, darf auf dieser Stufe
// nie mehr handeln -- auch nicht nach Admin-Umhängen, Ablehnung und Überarbeitung, und auch nicht
// als Ferienvertretung der zuständigen Person.

const CONFIG = {
  tsaTrustRequired: false,
  churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  downloadSigningSecret: 'test-secret',
  publicBaseUrl: 'https://portal.example.org',
};
const HEUTE = new Date().toISOString().slice(0, 10);
const Z = '2026-10-02T00:00:00.000Z';

function stubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function buildApp(db, mailer) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, CONFIG));
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config: CONFIG, mailer }));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config: CONFIG, mailer }));
  app.use('/spesen-freigabe1', requireLogin(), createSpesenFreigabe1Router({ db, config: CONFIG, mailer }));
  return app;
}

function seed(db) {
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  upsertPerson(db, { id: '9', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createKonto(db, { kontonummer: '3001', bezeichnung: 'V', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '6', stellvertreter2Id: '5' });
  return kontoId;
}

function neuerJob(db, { status, kontoId, zugewiesenAn = null, extra = {} }) {
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET status = ?, konto_id = ?, zugewiesen_an = ? WHERE id = ?').run(status, kontoId, zugewiesenAn, jobId);
  for (const [spalte, wert] of Object.entries(extra)) db.prepare(`UPDATE jobs SET ${spalte} = ? WHERE id = ?`).run(wert, jobId);
  return jobId;
}

function freigabe(db, jobId, personId, rolle) {
  createFreigabe(db, { jobId, personId, rolle, zeitpunkt: Z, ip: 'x', interessenskonflikt: rolle.endsWith('_eskalation'), kommentar: 'k', eskaliertVon: null });
}

async function kreditor(db) {
  const { createKreditor } = await import('../../src/db/kreditorenRepo.js');
  return createKreditor(db, { name: 'Muster AG', kontoId: null });
}

function kontierungsForm(kontoId, kreditorId) {
  return { aktion: 'kontieren', kontoId: String(kontoId), absender: 'Muster AG', kreditorId: String(kreditorId), rechnungsnummer: 'RE-1', betrag: '10.00', zahlungsziel: '2026-11-01', typ: 'rechnung', interessenskonflikt: '' };
}

test('Kritisch 1: nach Umhängen, Ablehnung und Überarbeitung kehrt Freigabe 2 nicht zum Konfliktmelder zurück', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const mailer = stubMailer();
  const app = buildApp(db, mailer);
  const kreditorId = await kreditor(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  freigabe(db, jobId, '1', 'freigeber1');
  freigabe(db, jobId, '3', 'freigabe2_eskalation');
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'k' });
  freigabe(db, jobId, '4', 'freigabe2_eskalation');
  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'k' });

  let job = getJobById(db, jobId);
  const umgehaengt = await umhaengeVorgang(db, CONFIG, mailer, {
    jobId, zielId: '5', bemerkung: 'bitte übernehmen', standErwartet: standToken(job, ermittleZustaendigkeit(db, job)),
    admin: { churchtools_person_id: '9', vorname: 'Ad', nachname: 'Min' }, ip: 'x',
  });
  assert.deepEqual(umgehaengt, { ok: true });
  assert.ok(ablehnenJob(db, jobId, { abgelehntVon: '5', grund: 'falsch' }));
  assert.ok(wiederOeffnenJob(db, jobId, '1'));
  mailer.sent.length = 0;

  const res = await request(app).post(`/kontierung/${jobId}`).set('x-test-person-id', '1').type('form').send(kontierungsForm(kontoId, kreditorId));
  assert.equal(res.status, 302);

  job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_an_admin, 1, 'effektiver Freigeber 2 ist Konfliktmelder → Admin-Gruppe');
  const empfaenger = mailer.sent.map((m) => m.to);
  assert.ok(empfaenger.includes('admin@example.org'), 'Freigabe-2-Mail geht an die Admin-Gruppe');
  assert.ok(!empfaenger.includes('p4@example.org'), 'keine Mail an den Konfliktmelder');
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 0);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '4')).status, 403);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '9')).status, 200);
  db.close();
});

test('1a: Konfliktmelder bekommt 403 bei Freigabe 2 -- direkt zuständig und als Superadmin', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const app = buildApp(db, stubMailer());
  // Direkt: Routing-Zustand zeigt (fehlerhaft) wieder auf den Konfliktmelder.
  const direkt = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  freigabe(db, direkt, '1', 'freigeber1');
  freigabe(db, direkt, '3', 'freigabe2_eskalation');
  const res = await request(app).get(`/freigabe2/${direkt}`).set('x-test-person-id', '3');
  assert.equal(res.status, 403);
  assert.match(res.text, /Interessenskonflikt erklärt und kannst Freigabe 2 nicht erteilen/);
  // Superadmin, der selbst einen Konflikt erklärt hat.
  const admin = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', extra: { freigabe2_eskaliert_an_admin: 1 } });
  freigabe(db, admin, '1', 'freigeber1');
  freigabe(db, admin, '9', 'freigabe2_eskalation');
  assert.equal((await request(app).get(`/freigabe2/${admin}`).set('x-test-person-id', '9')).status, 403);
  db.close();
});

test('1c: Meine Freigaben listet einen Vorgang nie einem Freigabe-2-Konfliktmelder', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 1);
  freigabe(db, jobId, '3', 'freigabe2_eskalation');
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 0);
  // Auch nicht über die Ferienvertretung des effektiven Freigeber 2.
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5' WHERE id = ?").run(jobId);
  setFerienmodus(db, '5', { von: HEUTE, bis: HEUTE, stellvertreterId: '3' });
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 0);
  db.close();
});

test('Wichtig 2: Ferienvertretung, die Freigabe-2-Konfliktmelder ist, bekommt 403', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const app = buildApp(db, stubMailer());
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', extra: { freigabe2_eskaliert_von: '3' } });
  freigabe(db, jobId, '1', 'freigeber1');
  freigabe(db, jobId, '3', 'freigabe2_eskalation');
  setFerienmodus(db, '4', { von: HEUTE, bis: HEUTE, stellvertreterId: '3' });
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '3')).status, 403);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '4')).status, 200);
  db.close();
});

test('Wichtig 2: Ferienvertretung, die Freigabe-1-Konfliktmelder ist, bekommt 403 bei der Kontierung', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const app = buildApp(db, stubMailer());
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '2', extra: { freigabe1_eskaliert_von: '1' } });
  freigabe(db, jobId, '1', 'freigabe1_eskalation');
  setFerienmodus(db, '2', { von: HEUTE, bis: HEUTE, stellvertreterId: '1' });
  const res = await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  assert.match(res.text, /Interessenskonflikt erklärt und kannst sie nicht kontieren/);
  assert.equal((await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '2')).status, 200);
  db.close();
});

test('Wichtig 2: Konfliktmelder als Superadmin bei admin-eskalierter Kontierung → 403, anderer Admin → 200', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  upsertPerson(db, { id: '8', vorname: 'Zweit', nachname: 'Admin', email: 'admin2@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildApp(db, stubMailer());
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '9', extra: { freigabe1_eskaliert_von: '9', freigabe1_eskaliert_an_admin: 1 } });
  freigabe(db, jobId, '9', 'freigabe1_eskalation');
  assert.equal((await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '9')).status, 403);
  assert.equal((await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '8')).status, 200);
  db.close();
});

test('Wichtig 2: Spesen-Freigabe 1 sperrt Freigabe-1-Konfliktmelder (auch Superadmin)', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  upsertPerson(db, { id: '8', vorname: 'Zweit', nachname: 'Admin', email: 'admin2@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildApp(db, stubMailer());
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '2', extra: { quelle: 'spesen', eingereicht_von: '6', freigabe1_eskaliert_von: '9', freigabe1_eskaliert_an_admin: 1 } });
  freigabe(db, jobId, '9', 'freigabe1_eskalation');
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '9');
  assert.equal(res.status, 403);
  assert.match(res.text, /Interessenskonflikt erklärt/);
  assert.equal((await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '8')).status, 200);
  db.close();
});

test('Minor 4: strikte Weiterleitung ohne zulässigen Freigeber 1 → Admin-Gruppe, Kontierer wird nicht zum Konfliktmelder', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  const mailer = stubMailer();
  const app = buildApp(db, mailer);
  const kreditorId = await kreditor(db);
  // Nach Überarbeitung: freigabe1_eskaliert_von ist durch abschliessenFreigabe1 bereits gelöscht,
  // die Konflikte von Freigeber 1 und Stellvertreter 1 stehen nur noch im Verlauf.
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '3' });
  freigabe(db, jobId, '1', 'freigabe1_eskalation');
  freigabe(db, jobId, '2', 'freigabe1_eskalation');

  const res = await request(app).post(`/kontierung/${jobId}`).set('x-test-person-id', '3').type('form').send(kontierungsForm(kontoId, kreditorId));
  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.freigabe1_eskaliert_von, null, 'der Kontierer hat keinen Konflikt erklärt');
  assert.deepEqual(mailer.sent.map((m) => m.to), ['admin@example.org']);
  db.close();
});

test('Minor 5: Konflikt der vom Admin umgeleiteten Person nennt die umgeleitete Person in der Admin-Mail', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const mailer = stubMailer();
  const app = buildApp(db, mailer);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', extra: { freigabe2_umgeleitet_an: '5' } });
  freigabe(db, jobId, '1', 'freigeber1');
  const res = await request(app).post(`/freigabe2/${jobId}`).set('x-test-person-id', '5').type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'ja', begruendung: 'Eigene Firma' });
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'admin@example.org');
  assert.match(mailer.sent[0].text, /vom Admin bestimmte Person/);
  assert.doesNotMatch(mailer.sent[0].text, /auch die Stellvertretung/);
  db.close();
});

test('Konfliktmelder, der den Vorgang nach einem Pool-Zyklus wieder hält, kann ihn nicht kontieren, aber zurück in den Pool geben', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const app = buildApp(db, stubMailer());
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '1' });
  freigabe(db, jobId, '1', 'freigabe1_eskalation');
  assert.equal((await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '1')).status, 403);
  const res = await request(app).post(`/kontierung/${jobId}/zurueck-in-pool`).set('x-test-person-id', '1').type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
  db.close();
});
