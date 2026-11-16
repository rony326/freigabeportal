// Prüfung 2026-11-15, S8 und B3: Texteingaben der Freigabe-/Kontierungs-/Spesen-/Fehlermelde-Routen.
//  - S8: mehrfach gesendete Felder (Array) → 400 statt Fehler 500; zu lange Felder → 400; Wert genau an der Grenze → ok.
//  - B3: Pflichtbegründung nur aus Leerzeichen gilt als leer (und gespeichert wird der getrimmte Text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, setKontierung, createSpesenPosition } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { createSpesenFreigabe1Router } from '../../src/routes/spesenFreigabe1.js';
import { createSpesenRouter } from '../../src/routes/spesen.js';
import { createFehlerMeldenRouter } from '../../src/routes/fehlerMelden.js';
import { kreditorOhneIbanPflicht } from '../helpers/kreditor.js';
import { PNG_1X1 } from '../helpers/imageFixture.js';
import { leseText, MAX_LAENGE } from '../../src/utils/eingabe.js';

const mailer = { async sendMail() {} };

// Wie in der echten App: unerwartete Fehler enden in einer 500-Seite (dort würde ein Array-Feld heute landen).
function baueApp(db, mounts) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Freigabeportal' };
    res.locals.csrfToken = 'valid-token';
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', publicBaseUrl: 'https://portal.example.org', jobsDir: '/tmp' };
  const csrfProtection = (req, res, next) => (req.body?._csrf === 'valid-token' ? next() : res.status(403).send('invalid csrf'));
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  for (const [pfad, fabrik] of Object.entries(mounts)) app.use(pfad, requireLogin(), fabrik({ db, config, mailer, csrfProtection }));
  app.use((err, req, res, next) => res.status(500).send(`500: ${err.message}`));
  return app;
}

function seedPersonenUndKonto(db) {
  for (const id of ['1', '2', '3', '4', '5']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

function neuerKontierungsJob(db) {
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  return id;
}

function kontierungSetup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedPersonenUndKonto(db);
  const kreditorId = kreditorOhneIbanPflicht(db, { name: 'Muster AG' });
  const id = neuerKontierungsJob(db);
  const app = baueApp(db, { '/kontierung': createKontierungRouter });
  const gueltig = { kontoId: String(kontoId), kreditorId: String(kreditorId), absender: 'Muster AG', rechnungsnummer: 'RE-1', betrag: '100.00', zahlungsziel: '2026-09-01', interessenskonflikt: 'nein', begruendung: '' };
  const post = (body, pfad = '') => request(app).post(`/kontierung/${id}${pfad}`).set('x-test-person-id', '1').type('form').send({ _csrf: 'valid-token', ...body });
  return { db, id, kontoId, kreditorId, gueltig, post, app };
}

// ---------- leseText (Hilfsfunktion) ----------

test('leseText: trimmt, lehnt Array/Objekt ab, prüft die Höchstlänge genau an der Grenze', () => {
  assert.deepEqual(leseText('  x  ', { max: 5, feld: 'F' }), { wert: 'x', fehler: null });
  assert.deepEqual(leseText(undefined, { max: 5, feld: 'F' }), { wert: '', fehler: null });
  assert.match(leseText(['a', 'b'], { max: 5, feld: 'F' }).fehler, /genau einen Text/);
  assert.match(leseText({ a: 1 }, { max: 5, feld: 'F' }).fehler, /genau einen Text/);
  assert.equal(leseText('a'.repeat(5), { max: 5, feld: 'F' }).fehler, null);
  assert.match(leseText('a'.repeat(6), { max: 5, feld: 'F' }).fehler, /höchstens 5 Zeichen/);
});

// ---------- Kontierung ----------

test('B3 Kontierung: Ablehnen mit Begründung aus Leerzeichen wird abgelehnt', async () => {
  const { db, id, post } = kontierungSetup();
  const res = await post({ aktion: 'ablehnen', begruendung: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bei einer Ablehnung ist eine Begründung Pflicht/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});

test('B3 Kontierung: Ablehnen speichert die getrimmte Begründung', async () => {
  const { db, id, post } = kontierungSetup();
  const res = await post({ aktion: 'ablehnen', begruendung: '  Falsche Adresse  ' });
  assert.equal(res.status, 302);
  assert.equal(getJobById(db, id).ablehnungsgrund, 'Falsche Adresse');
  db.close();
});

test('B3 Kontierung: Interessenskonflikt mit Begründung aus Leerzeichen wird abgelehnt', async () => {
  const { db, id, gueltig, post } = kontierungSetup();
  const res = await post({ ...gueltig, interessenskonflikt: 'ja', begruendung: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bei einem Interessenskonflikt ist eine Begründung Pflicht/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});

test('B3 Aufsplitten: Interessenskonflikt mit Begründung aus Leerzeichen wird abgelehnt', async () => {
  const { db, id, kontoId, kreditorId, post } = kontierungSetup();
  const res = await post({
    kreditorId: String(kreditorId), gesamtbetrag: '200.00', teilKontoId: [String(kontoId), String(kontoId)], teilBetrag: ['120.00', '80.00'],
    teilInteressenskonflikt: ['true', 'false'], begruendung: '   ',
  }, '/aufsplitten');
  assert.equal(res.status, 400);
  assert.match(res.text, /Bei einem Interessenskonflikt ist eine Begründung Pflicht/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});

test('S8 Kontierung: Array in absender/rechnungsnummer/begruendung ergibt 400 statt 500', async () => {
  const { db, gueltig, post } = kontierungSetup();
  for (const feld of ['absender', 'rechnungsnummer', 'begruendung', 'betrag', 'kontoId']) {
    const res = await post({ ...gueltig, [feld]: ['a', 'b'] });
    assert.equal(res.status, 400, `${feld}: ${res.text.slice(0, 80)}`);
    assert.match(res.text, /genau einen Text/);
  }
  const abl = await post({ aktion: 'ablehnen', begruendung: ['a', 'b'] });
  assert.equal(abl.status, 400);
  db.close();
});

test('S8 Kontierung: zu lange Felder ergeben 400 mit Feldfehler, Wert genau an der Grenze wird angenommen', async () => {
  const { db, id, gueltig, post } = kontierungSetup();
  const zuLang = [['absender', MAX_LAENGE.einzeilig], ['rechnungsnummer', MAX_LAENGE.rechnungsnummer], ['begruendung', MAX_LAENGE.text]];
  for (const [feld, max] of zuLang) {
    const res = await post({ ...gueltig, [feld]: 'x'.repeat(max + 1) });
    assert.equal(res.status, 400, feld);
    assert.match(res.text, new RegExp(`höchstens ${max} Zeichen`));
    assert.match(res.text, new RegExp(`id="${feld}"[^>]*aria-invalid="true"`));
  }
  const ok = await post({ ...gueltig, absender: 'x'.repeat(MAX_LAENGE.einzeilig), rechnungsnummer: 'r'.repeat(MAX_LAENGE.rechnungsnummer), begruendung: 'b'.repeat(MAX_LAENGE.text) });
  assert.equal(ok.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.absender.length, MAX_LAENGE.einzeilig);
  assert.equal(job.rechnungsnummer.length, MAX_LAENGE.rechnungsnummer);
  db.close();
});

test('S8 Kontierung: Formular trägt maxlength für Absender, Rechnungsnummer und Begründung', async () => {
  const { db, id, app } = kontierungSetup();
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.match(res.text, new RegExp(`name="absender" value="[^"]*" maxlength="${MAX_LAENGE.einzeilig}"`));
  assert.match(res.text, new RegExp(`name="rechnungsnummer" value="[^"]*" maxlength="${MAX_LAENGE.rechnungsnummer}"`));
  assert.match(res.text, new RegExp(`name="begruendung" maxlength="${MAX_LAENGE.text}"`));
  db.close();
});

test('S8 Aufsplitten: Array-Begründung/-Gesamtbetrag → 400; mehrere Teilzeilen (legitime Mehrfachfelder) bleiben möglich; zu lange Position → 400', async () => {
  const { db, kontoId, kreditorId, post } = kontierungSetup();
  const basis = { kreditorId: String(kreditorId), gesamtbetrag: '200.00', teilKontoId: [String(kontoId), String(kontoId)], teilBetrag: ['120.00', '80.00'] };
  for (const feld of ['begruendung', 'gesamtbetrag', 'kreditorId']) {
    const res = await post({ ...basis, [feld]: ['a', 'b'] }, '/aufsplitten');
    assert.equal(res.status, 400, feld);
    assert.match(res.text, /genau einen Text/);
  }
  const lang = await post({ ...basis, teilPosition: ['x'.repeat(MAX_LAENGE.einzeilig + 1), ''] }, '/aufsplitten');
  assert.equal(lang.status, 400);
  assert.match(lang.text, new RegExp(`höchstens ${MAX_LAENGE.einzeilig} Zeichen`));
  db.close();
});

test('S8 Kontierung: Array-Bemerkung bei Rückgabe an die Gruppe und beim Schnell-Lieferanten → 400', async () => {
  const { db, id, post, app } = kontierungSetup();
  const res = await post({ bemerkung: ['a', 'b'] }, '/an-gruppe-zurueck');
  assert.equal(res.status, 400);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  setBerechtigungenForPerson(db, '1', ['kreditoren_verwalten']);
  const lief = await request(app).post('/kontierung/lieferanten').set('x-test-person-id', '1').type('form').send({ _csrf: 'valid-token', name: ['A', 'B'], zahlungsart: 'ueberweisung', iban: 'CH9300762011623852957' });
  assert.equal(lief.status, 400);
  assert.match(lief.body.error, /genau einen Text/);
  const lang = await request(app).post('/kontierung/lieferanten').set('x-test-person-id', '1').type('form').send({ _csrf: 'valid-token', name: 'N'.repeat(MAX_LAENGE.einzeilig + 1), zahlungsart: 'bar' });
  assert.equal(lang.status, 400);
  assert.match(lang.body.error, new RegExp(`höchstens ${MAX_LAENGE.einzeilig} Zeichen`));
  db.close();
});

test('S8 Kontierung: Rapport mit Array-Bemerkung → 400', async () => {
  const { db, post } = kontierungSetup();
  const res = await post({ aktion: 'rapport', bemerkung: ['a', 'b'], empfaengerIds: ['2'] });
  assert.equal(res.status, 400);
  assert.match(res.text, /genau einen Text/);
  db.close();
});

// ---------- Freigabe 2 ----------

function freigabe2Setup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedPersonenUndKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  const app = baueApp(db, { '/freigabe2': createFreigabe2Router });
  const post = (body) => request(app).post(`/freigabe2/${id}`).set('x-test-person-id', '3').type('form').send({ _csrf: 'valid-token', ...body });
  return { db, id, post, app };
}

test('B3 Freigabe 2: Ablehnen und Interessenskonflikt mit Begründung aus Leerzeichen werden abgelehnt', async () => {
  const { db, id, post } = freigabe2Setup();
  const abl = await post({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: '   ' });
  assert.equal(abl.status, 400);
  assert.match(abl.text, /Bei einer Ablehnung ist eine Begründung Pflicht/);
  const konflikt = await post({ aktion: 'freigeben', interessenskonflikt: 'ja', begruendung: '   ' });
  assert.equal(konflikt.status, 400);
  assert.match(konflikt.text, /Bei einem Interessenskonflikt ist eine Begründung Pflicht/);
  assert.equal(getJobById(db, id).status, 'freigabe2');
  db.close();
});

test('S8 Freigabe 2: Array-Begründung → 400 statt 500, zu lange Begründung → 400 mit Feldfehler, Grenze ok', async () => {
  const { db, id, post } = freigabe2Setup();
  const arr = await post({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: ['a', 'b'] });
  assert.equal(arr.status, 400);
  assert.match(arr.text, /genau einen Text/);
  const lang = await post({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'x'.repeat(MAX_LAENGE.text + 1) });
  assert.equal(lang.status, 400);
  assert.match(lang.text, /id="f2begruendung"[^>]*aria-invalid="true"/);
  assert.equal(getJobById(db, id).status, 'freigabe2');
  const ok = await post({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: ` ${'x'.repeat(MAX_LAENGE.text)} ` });
  assert.equal(ok.status, 302);
  assert.equal(getJobById(db, id).ablehnungsgrund.length, MAX_LAENGE.text);
  db.close();
});

// ---------- Spesen-Freigabe 1 ----------

function spesenFreigabeSetup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedPersonenUndKonto(db);
  const abrechnung = createSpesenabrechnung(db, { eingereichtVon: '5', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });
  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '61.75', auslageDatum: '2026-08-20', beschreibung: 'Bahnticket',
    dateiname: 't.pdf', pdfPfad: '/tmp/t.pdf', thumbnailPfad: null, spesenabrechnungId: abrechnung, zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  const app = baueApp(db, { '/spesen-freigabe1': createSpesenFreigabe1Router });
  const post = (body) => request(app).post(`/spesen-freigabe1/${id}`).set('x-test-person-id', '1').type('form').send({ _csrf: 'valid-token', ...body });
  return { db, id, post };
}

test('B3 Spesen-Freigabe 1: Ablehnen und Interessenskonflikt mit Begründung aus Leerzeichen werden abgelehnt', async () => {
  const { db, id, post } = spesenFreigabeSetup();
  for (const body of [{ aktion: 'ablehnen', begruendung: '   ' }, { aktion: 'freigeben', interessenskonflikt: 'ja', begruendung: ' \t ' }]) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.match(res.text, /Begründung ist bei Interessenskonflikt oder Ablehnung Pflicht/);
  }
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});

test('S8 Spesen-Freigabe 1: Array-Begründung → 400, zu lang → 400 mit Feldfehler, Grenze ok', async () => {
  const { db, id, post } = spesenFreigabeSetup();
  const arr = await post({ aktion: 'ablehnen', begruendung: ['a', 'b'] });
  assert.equal(arr.status, 400);
  assert.match(arr.text, /genau einen Text/);
  const lang = await post({ aktion: 'ablehnen', begruendung: 'x'.repeat(MAX_LAENGE.text + 1) });
  assert.equal(lang.status, 400);
  assert.match(lang.text, /id="sf1begruendung"[^>]*aria-invalid="true"/);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  const ok = await post({ aktion: 'ablehnen', begruendung: 'x'.repeat(MAX_LAENGE.text) });
  assert.equal(ok.status, 302);
  db.close();
});

// ---------- Spesen einreichen ----------

function spesenSetup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const kontoId = seedPersonenUndKonto(db);
  const app = baueApp(db, { '/spesen': createSpesenRouter });
  const senden = (felder, { beleg = true, anzahl = 1 } = {}) => {
    let req = request(app).post('/spesen').set('x-test-person-id', '5').field('_csrf', 'valid-token');
    for (const [name, wert] of Object.entries(felder)) {
      for (const einzel of [].concat(wert)) req = req.field(name, einzel);
    }
    if (beleg) for (let i = 0; i < anzahl; i++) req = req.attach(`posBeleg_${i}`, PNG_1X1, { filename: `b${i}.png`, contentType: 'image/png' });
    return req;
  };
  const gueltig = { posKontoId: String(kontoId), posBetrag: '10.00', posAuslageDatum: '2026-01-01', posBeschreibung: 'Zug' };
  return { db, senden, gueltig, kontoId };
}

test('S8 Spesen: Array im Titel → 400 statt 500', async () => {
  const { db, senden, gueltig } = spesenSetup();
  const res = await senden({ ...gueltig, titel: ['a', 'b'] });
  assert.equal(res.status, 400);
  assert.match(res.text, /Titel: Bitte genau einen Text/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
  db.close();
});

test('S8 Spesen: zu langer Titel und zu langer Verwendungszweck → 400, Grenzwerte werden angenommen', async () => {
  const { db, senden, gueltig } = spesenSetup();
  const titel = await senden({ ...gueltig, titel: 't'.repeat(MAX_LAENGE.einzeilig + 1) });
  assert.equal(titel.status, 400);
  assert.match(titel.text, new RegExp(`Titel darf höchstens ${MAX_LAENGE.einzeilig} Zeichen`));
  const zweck = await senden({ ...gueltig, posBeschreibung: 'z'.repeat(MAX_LAENGE.text + 1) });
  assert.equal(zweck.status, 400);
  assert.match(zweck.text, new RegExp(`Verwendungszweck darf höchstens ${MAX_LAENGE.text} Zeichen`));
  const ok = await senden({ ...gueltig, titel: 't'.repeat(MAX_LAENGE.einzeilig), posBeschreibung: 'z'.repeat(MAX_LAENGE.text) });
  assert.equal(ok.status, 302);
  db.close();
});

test('S8 Spesen: mehrere Positionen (mehrfach benannte Felder) bleiben möglich', async () => {
  const { db, senden, gueltig } = spesenSetup();
  const res = await senden({ posKontoId: [gueltig.posKontoId, gueltig.posKontoId], posBetrag: ['10.00', '20.00'], posAuslageDatum: ['2026-01-01', '2026-01-02'], posBeschreibung: ['Zug', 'Tram'] }, { anzahl: 2 });
  assert.equal(res.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 2);
  db.close();
});

// ---------- Fehler melden ----------

test('S8 Fehler melden: Array in beschreibung oder fehlerId → 400 (wird nicht stillschweigend verworfen)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Eva', nachname: 'Muster', email: 'eva@example.org', gruppen: ['10'], loggedInNow: true });
  const app = baueApp(db, { '/fehler-melden': createFehlerMeldenRouter });
  const post = (body) => request(app).post('/fehler-melden').set('x-test-person-id', '1').type('form').send({ _csrf: 'valid-token', ...body });
  const arr = await post({ beschreibung: ['a', 'b'] });
  assert.equal(arr.status, 400);
  assert.match(arr.text, /genau einen Text/);
  assert.equal((await post({ fehlerId: ['a', 'b'], beschreibung: 'x' })).status, 400);
  assert.equal((await post({ beschreibung: 'x'.repeat(MAX_LAENGE.text + 1) })).status, 400);
  assert.equal((await post({ beschreibung: 'x'.repeat(MAX_LAENGE.text) })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM betrieb_fehlermeldungen').get().n, 1);
  db.close();
});
