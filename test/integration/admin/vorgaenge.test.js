import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { listFreigabenByJob, createFreigabe } from '../../../src/db/freigabenRepo.js';
import { listMailLog } from '../../../src/db/mailLogRepo.js';
import { seedDefaults, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { markiereRapport } from '../../../src/services/rapporte.js';
import { listKenntnisnahmen, bestaetigeKenntnisnahme } from '../../../src/db/rapporteRepo.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
import { createVorgaengeRouter } from '../../../src/routes/admin/vorgaenge.js';

const CONFIG = {
  churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
  publicBaseUrl: 'https://portal.example.org',
  downloadSigningSecret: 'test-secret',
};

function buildApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
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
  app.use('/admin/vorgaenge', requirePermission(db, CONFIG, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config: CONFIG, mailer: { async sendMail() {} } }));
  return app;
}

function seed(db) {
  seedDefaults(db);
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '8' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ?, lieferant = 'Muster AG' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

function stand(text) {
  return text.match(/name="stand" value="([^"]+)"/)[1];
}

test('Liste: 401 ohne Session, 403 ohne Recht, 200 für Manager und Admin mit zuständiger Person und Prognose', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildApp(db);
  assert.equal((await request(app).get('/admin/vorgaenge')).status, 401);
  assert.equal((await request(app).get('/admin/vorgaenge').set('x-test-person-id', '77')).status, 403);
  const res = await request(app).get('/admin/vorgaenge').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  assert.match(res.text, /rechnung\.pdf/);
  assert.match(res.text, /P1 M/);
  assert.match(res.text, /P3 M/);
  assert.doesNotMatch(res.text, />Umhängen</);
  const resAdmin = await request(app).get('/admin/vorgaenge').set('x-test-person-id', '99');
  assert.match(resAdmin.text, />Umhängen</);
  db.close();
});

test('Einzelrecht vorgaenge_einsehen reicht zum Ansehen', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  setBerechtigungenForPerson(db, '77', ['vorgaenge_einsehen']);
  const app = buildApp(db);
  assert.equal((await request(app).get('/admin/vorgaenge').set('x-test-person-id', '77')).status, 200);
  db.close();
});

test('Detail: Manager sieht Verlauf ohne Formular; Admin sieht Formular mit erlaubten Zielen', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  const app = buildApp(db);
  const manager = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '55');
  assert.equal(manager.status, 200);
  assert.doesNotMatch(manager.text, /name="zielId"/);
  const adminRes = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99');
  assert.match(adminRes.text, /name="zielId"/);
  assert.match(adminRes.text, /value="5"/);
  assert.doesNotMatch(adminRes.text, /<option value="1"/);
  assert.equal((await request(app).get('/admin/vorgaenge/99999').set('x-test-person-id', '99')).status, 404);
  db.close();
});

test('POST umhaengen: Manager 403, fehlende Bemerkung 422, Erfolg schreibt Verlauf und Mails', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  const app = buildApp(db);
  const token = stand((await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99')).text);

  const manager = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '55').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(manager.status, 403);

  const ohneBemerkung = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'kurz', bestaetigung: 'ja', stand: token });
  assert.equal(ohneBemerkung.status, 422);
  assert.equal(getJobById(db, jobId).zugewiesen_an, '1');

  const falschesZiel = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '1', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(falschesZiel.status, 422);

  const ok = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `/admin/vorgaenge/${jobId}?umgehaengt=1`);
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  assert.equal(listFreigabenByJob(db, jobId).at(-1).rolle, 'admin_umzuweisung');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').length, 2);

  const nochmal = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '6', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(nochmal.status, 409);
  db.close();
});

test('abgelehnte Spesen-Position: Detail zeigt kein Formular, POST liefert 404', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const spesenId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'spesen.pdf', pdfPfad: '/tmp/s.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', quelle = 'spesen', zugewiesen_an = '1', eingereicht_von = '6' WHERE id = ?").run(spesenId);
  const app = buildApp(db);
  const detail = await request(app).get(`/admin/vorgaenge/${spesenId}`).set('x-test-person-id', '99');
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /name="zielId"/);
  const post = await request(app).post(`/admin/vorgaenge/${spesenId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: 'egal' });
  assert.equal(post.status, 404);
  db.close();
});

test('strikter Hinweis nennt das tatsächliche Weiterleitungsziel: Stellvertreter 1, wenn Freigeber 1 Konflikt erklärt hat', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  // Nach Überarbeitung steht der Konflikt nur noch im Verlauf, freigabe1_eskaliert_von ist leer.
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigabe1_eskalation', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'befangen', eskaliertVon: null });
  db.prepare("UPDATE jobs SET zugewiesen_an = '5' WHERE id = ?").run(jobId);
  const app = buildApp(db);
  const res = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99');
  assert.match(res.text, /wird der Vorgang bei der Kontierung an P2 M weitergeleitet/);
  assert.doesNotMatch(res.text, /an P1 M weitergeleitet/);
  db.close();
});

test('strikter Hinweis: sind Freigeber 1 und Stellvertreter 1 ausgeschlossen, nennt er die Admin-Gruppe', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  for (const personId of ['1', '2']) {
    createFreigabe(db, { jobId, personId, rolle: 'freigabe1_eskalation', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'befangen', eskaliertVon: null });
  }
  db.prepare("UPDATE jobs SET zugewiesen_an = '5' WHERE id = ?").run(jobId);
  const app = buildApp(db);
  const res = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99');
  assert.match(res.text, /bei der Kontierung an die Admin-Gruppe übergeben/);
  db.close();
});

test('422-Neuanzeige behält den abgeschickten Stand, damit eine zwischenzeitliche Änderung erkannt wird', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  const app = buildApp(db);
  const token = stand((await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99')).text);
  // Zwischenzeitliche Änderung: jemand anderes übernimmt den Vorgang.
  db.prepare("UPDATE jobs SET zugewiesen_an = '2' WHERE id = ?").run(jobId);
  const fehler = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'kurz', bestaetigung: 'ja', stand: token });
  assert.equal(fehler.status, 422);
  assert.equal(stand(fehler.text), token);
  const erneut = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: stand(fehler.text) });
  assert.equal(erneut.status, 409);
  db.close();
});

// --- Rapporte ---

async function seedRapport(t, { empfaenger = ['2', '3'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vorgaenge-rapport-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seed(db);
  setConfigValue(db, 'modul_rapporte_aktiv', '1');
  setConfigValue(db, 'zeitstempel_tsa_url', '');
  const config = { ...CONFIG, jobsDir: dir, tsaTrustRequired: false };
  const pdfPfad = join(dir, 'rapport.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rapport']));
  const jobId = createJob(db, { eingangAm: '2026-11-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rapport.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);
  const markierer = { churchtools_person_id: '1', vorname: 'P1', nachname: 'M' };
  const r = await markiereRapport(db, config, { async sendMail() {} }, { job: getJobById(db, jobId), person: markierer, empfaengerIds: empfaenger, bemerkung: 'Bitte lesen', ip: '' });
  assert.equal(r.ok, true);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/vorgaenge', requirePermission(db, config, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config, mailer: { async sendMail() {} } }));
  return { db, app, jobId };
}

const ersetzen = (x, kid, body, person = '99') => request(x.app).post(`/admin/vorgaenge/${x.jobId}/rapport/${kid}/ersetzen`).set('x-test-person-id', person).type('form').send(body);
const entfernen = (x, kid, body, person = '99') => request(x.app).post(`/admin/vorgaenge/${x.jobId}/rapport/${kid}/entfernen`).set('x-test-person-id', person).type('form').send(body);

test('Rapport erscheint mit Art "Rapport" und "1 von 2" im Dashboard, Filter typ=rapport', async (t) => {
  const x = await seedRapport(t);
  const [k1] = listKenntnisnahmen(x.db, x.jobId);
  bestaetigeKenntnisnahme(x.db, x.jobId, k1.person_id, new Date().toISOString());
  const liste = await request(x.app).get('/admin/vorgaenge').set('x-test-person-id', '99');
  assert.equal(liste.status, 200);
  assert.match(liste.text, /Rapport/);
  assert.match(liste.text, /Wartet auf Kenntnisnahme/);
  assert.match(liste.text, /1 von 2/);
  const nurRapport = await request(x.app).get('/admin/vorgaenge?typ=rapport').set('x-test-person-id', '99');
  assert.match(nurRapport.text, /rapport\.pdf/);
  assert.doesNotMatch(nurRapport.text, /rechnung\.pdf/);
  const nurRechnung = await request(x.app).get('/admin/vorgaenge?art=rechnung').set('x-test-person-id', '99');
  assert.doesNotMatch(nurRechnung.text, /rapport\.pdf/);
  const detail = await request(x.app).get(`/admin/vorgaenge/${x.jobId}`).set('x-test-person-id', '99');
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Zur Kenntnis weitergegeben/);
  assert.match(detail.text, /\/rapport\/\d+\/ersetzen/);
});

test('ersetzen: alte Zeile entfernt mit ersetzt_durch_id, neue Person bekommt Mail, Audit-Eintrag', async (t) => {
  const x = await seedRapport(t);
  const [k1] = listKenntnisnahmen(x.db, x.jobId);
  const res = await ersetzen(x, k1.id, { neuePersonId: '5', begruendung: 'Person ist abwesend' });
  assert.equal(res.status, 302);
  const zeilen = listKenntnisnahmen(x.db, x.jobId);
  const alt = zeilen.find((k) => k.id === k1.id);
  const neu = zeilen.find((k) => k.person_id === '5');
  assert.ok(alt.entfernt_am);
  assert.equal(alt.ersetzt_durch_id, neu.id);
  assert.equal(alt.begruendung, 'Person ist abwesend');
  assert.ok(listMailLog(x.db).some((m) => m.typ === 'rapport-zuweisung' && m.empfaenger === 'p5@example.org'));
  const f = listFreigabenByJob(x.db, x.jobId).at(-1);
  assert.equal(f.rolle, 'rapport_empfaenger_ersetzt');
  assert.equal(f.person_id, '99');
  const detail = await request(x.app).get(`/admin/vorgaenge/${x.jobId}`).set('x-test-person-id', '99');
  assert.match(detail.text, /Empfänger ersetzt/);
});

test('ersetzen mit Begründung < 10 Zeichen → 400; ohne workflow_eingreifen → 403; schon offene oder gleiche Person → 409', async (t) => {
  const x = await seedRapport(t);
  const [k1, k2] = listKenntnisnahmen(x.db, x.jobId);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: '5', begruendung: 'kurz' })).status, 400);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: '5', begruendung: 'Person ist abwesend' }, '55')).status, 403);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: k2.person_id, begruendung: 'Person ist abwesend' })).status, 409);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: k1.person_id, begruendung: 'Person ist abwesend' })).status, 409);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: 'gibtsnicht', begruendung: 'Person ist abwesend' })).status, 400);
  assert.equal(listKenntnisnahmen(x.db, x.jobId).length, 2);
});

test('ersetzen doppelt abgeschickt (gleiche kid) → zweites Mal 409, nur eine neue Zeile', async (t) => {
  const x = await seedRapport(t);
  const [k1] = listKenntnisnahmen(x.db, x.jobId);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: '5', begruendung: 'Person ist abwesend' })).status, 302);
  assert.equal((await ersetzen(x, k1.id, { neuePersonId: '6', begruendung: 'Person ist abwesend' })).status, 409);
  assert.equal(listKenntnisnahmen(x.db, x.jobId).length, 3);
});

test('entfernen des letzten Offenen nach einer Bestätigung → abgeschlossen mit Vermerk "entfernt"', async (t) => {
  const x = await seedRapport(t);
  const [k1, k2] = listKenntnisnahmen(x.db, x.jobId);
  bestaetigeKenntnisnahme(x.db, x.jobId, k1.person_id, new Date().toISOString());
  const res = await entfernen(x, k2.id, { begruendung: 'Nicht mehr zuständig' });
  assert.equal(res.status, 302);
  assert.equal(getJobById(x.db, x.jobId).status, 'abgeschlossen');
  assert.equal(listFreigabenByJob(x.db, x.jobId).at(-1).rolle, 'rapport_empfaenger_entfernt');
  assert.equal(listKenntnisnahmen(x.db, x.jobId).find((k) => k.id === k2.id).begruendung, 'Nicht mehr zuständig');
});

test('entfernen eines von zwei Offenen lässt den Rapport offen; kurze Begründung → 400', async (t) => {
  const x = await seedRapport(t);
  const [k1] = listKenntnisnahmen(x.db, x.jobId);
  assert.equal((await entfernen(x, k1.id, { begruendung: 'kurz' })).status, 400);
  assert.equal((await entfernen(x, k1.id, { begruendung: 'Nicht mehr zuständig' })).status, 302);
  assert.equal(getJobById(x.db, x.jobId).status, 'kenntnisnahme');
});

test('entfernen des letzten Offenen ohne Bestätigung → 409 mit Hinweis ersetzen/aufheben', async (t) => {
  const x = await seedRapport(t, { empfaenger: ['2'] });
  const [k1] = listKenntnisnahmen(x.db, x.jobId);
  const res = await entfernen(x, k1.id, { begruendung: 'Nicht mehr zuständig' });
  assert.equal(res.status, 409);
  assert.match(res.text, /ersetzen|aufheben/);
  assert.equal(getJobById(x.db, x.jobId).status, 'kenntnisnahme');
});

test('aufheben über das Dashboard: Rapport wird wieder normaler Vorgang; ohne Recht 403', async (t) => {
  const x = await seedRapport(t);
  assert.equal((await request(x.app).post(`/admin/vorgaenge/${x.jobId}/rapport/aufheben`).set('x-test-person-id', '55').type('form').send({})).status, 403);
  const res = await request(x.app).post(`/admin/vorgaenge/${x.jobId}/rapport/aufheben`).set('x-test-person-id', '99').type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(getJobById(x.db, x.jobId).status, 'zugewiesen');
  assert.equal(listFreigabenByJob(x.db, x.jobId).at(-1).rolle, 'rapport_markierung_aufgehoben');
});

test('allgemeines Umhängen bietet Rapporte nicht an', async (t) => {
  const x = await seedRapport(t);
  const detail = await request(x.app).get(`/admin/vorgaenge/${x.jobId}`).set('x-test-person-id', '99');
  assert.doesNotMatch(detail.text, /\/umhaengen"/);
  const post = await request(x.app).post(`/admin/vorgaenge/${x.jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: 'x' });
  assert.equal(post.status, 404);
});
