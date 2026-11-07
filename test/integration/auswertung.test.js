import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { setzeBudget } from '../../src/db/budgetRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createAuswertungRouter } from '../../src/routes/auswertung.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, CONFIG));
  app.use('/auswertung', requireLogin(), createAuswertungRouter({ db, config: CONFIG }));
  return app;
}

function jahrHeute() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric' }).format(new Date());
}

function job(db, felder) {
  const jahr = jahrHeute();
  const werte = { eingang_am: `${jahr}-01-01T08:00:00Z`, quelle: 'scanner', dateiname: 'x.pdf', pdf_pfad: '/x.pdf', status: 'abgeschlossen', abgeschlossen_am: `${jahr}-01-02T08:00:00Z`, ...felder };
  const spalten = Object.keys(werte);
  return Number(db.prepare(`INSERT INTO jobs (${spalten.join(',')}) VALUES (${spalten.map(() => '?').join(',')})`).run(...Object.values(werte)).lastInsertRowid);
}

function seed(db) {
  seedDefaults(db);
  for (const [id, vorname, nachname] of [['1', 'Anna', 'Eins'], ['2', 'Beat', 'Zwei'], ['5', 'Nora', 'Niemand'], ['7', 'Kurt', 'Kassier'], ['8', 'Vera', 'Vorgang']]) {
    upsertPerson(db, { id, vorname, nachname, email: `${id}@x.ch`, gruppen: [], loggedInNow: true });
  }
  setBerechtigungenForPerson(db, '7', ['auswertung_einsehen']);
  setBerechtigungenForPerson(db, '8', ['auswertung_einsehen', 'vorgaenge_einsehen']);
  const a = Number(createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '2', stellvertreter2Id: '7' }));
  const b = Number(createKonto(db, { kontonummer: '4100', bezeichnung: 'Musik', freigeber1Id: '2', stellvertreter1Id: '7', freigeber2Id: '1', stellvertreter2Id: '7' }));
  const kr = Number(db.prepare("INSERT INTO kreditoren (name) VALUES ('Papeterie AG')").run().lastInsertRowid);
  const kr2 = Number(db.prepare("INSERT INTO kreditoren (name) VALUES ('Orgelbau GmbH')").run().lastInsertRowid);
  job(db, { konto_id: a, betrag: '1234.5', kreditor_id: kr });
  job(db, { konto_id: b, betrag: '777', kreditor_id: kr2 });
  job(db, { konto_id: b, betrag: '50', status: 'zugewiesen', zugewiesen_an: '2' });
  setzeBudget(db, { kontoId: a, jahr: Number(jahrHeute()), betrag: 1000, personId: '7' });
  return { a, b };
}

const get = (app, pfad, person) => request(app).get(pfad).set('x-test-person-id', person);

test('Zugang: auswertung_einsehen sieht alle Abschnitte und alle Konten', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await get(buildTestApp(db), '/auswertung', '7');
  assert.equal(res.status, 200);
  for (const text of ['Freigegeben', 'Budget pro Konto', 'Durchlaufzeit pro Stufe', 'Wo Rechnungen liegen', 'Lieferanten', '4000', '4100', 'Papeterie AG', 'Orgelbau GmbH', 'Beat Zwei']) {
    assert.ok(res.text.includes(text), `fehlt: ${text}`);
  }
  assert.match(res.text, /CHF 2&#39;011.50/, 'Summe freigegeben');
  assert.match(res.text, /über Budget/);
  db.close();
});

test('Zugang: Freigeber 1 sieht nur eigene Konten, ohne "Wo Rechnungen liegen"', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await get(buildTestApp(db), '/auswertung', '1');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Papeterie AG'));
  assert.ok(!res.text.includes('Orgelbau GmbH'), 'fremder Lieferant sichtbar');
  assert.ok(!res.text.includes('4100'), 'fremdes Konto sichtbar');
  assert.ok(!res.text.includes('Wo Rechnungen liegen'));
  assert.match(res.text, /CHF 1&#39;234.50/);
  db.close();
});

test('Zugang: Person ohne Recht und ohne Konto → 403', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await get(buildTestApp(db), '/auswertung', '5');
  assert.equal(res.status, 403);
  assert.equal((await get(buildTestApp(db), '/auswertung/export/budget.csv', '5')).status, 403);
  db.close();
});

test('fremdes Konto per Filter → 403, eigenes Konto per Filter → 200', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  const fremd = await get(app, '/auswertung?konto=4100', '1');
  assert.equal(fremd.status, 403);
  assert.match(fremd.text, /Für dieses Konto hast du keine Auswertung/);
  assert.equal((await get(app, '/auswertung/export/lieferanten.csv?konto=4100', '1')).status, 403);
  const eigen = await get(app, '/auswertung?konto=4000', '1');
  assert.equal(eigen.status, 200);
  const kassierGefiltert = await get(app, '/auswertung?konto=4100', '7');
  assert.ok(kassierGefiltert.text.includes('Orgelbau GmbH'));
  assert.ok(!kassierGefiltert.text.includes('Papeterie AG'));
  db.close();
});

test('ungültiger Zeitraum → Meldung, Standard-Zeitraum angezeigt', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await get(buildTestApp(db), '/auswertung?zeitraum=eigen&von=2026-05-01&bis=2026-01-01', '7');
  assert.equal(res.status, 200);
  assert.match(res.text, /Von-Datum muss vor dem Bis-Datum/);
  assert.match(res.text, /<option value="jahr" selected/);
  db.close();
});

test('CSV-Export: BOM, Semikolon, Dateiname, Inhalt', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  const res = await get(app, '/auswertung/export/lieferanten.csv', '7').buffer(true).parse((r, cb) => {
    const teile = [];
    r.on('data', (c) => teile.push(c));
    r.on('end', () => cb(null, Buffer.concat(teile)));
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv; charset=utf-8/);
  const jahr = jahrHeute();
  assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="auswertung-lieferanten-${jahr}-01-01-${jahr}-\\d\\d-\\d\\d.csv"`));
  assert.deepEqual([...res.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = res.body.toString('utf8').slice(1);
  const zeilen = text.trim().split('\r\n');
  assert.equal(zeilen[0], 'Lieferant;Rechnungen;Betrag CHF;Anteil %;Häufigste Konten');
  assert.equal(zeilen[1], 'Papeterie AG;1;1234.50;61.4;4000');
  for (const abschnitt of ['budget', 'durchlauf', 'engpaesse']) {
    assert.equal((await get(app, `/auswertung/export/${abschnitt}.csv`, '7')).status, 200, abschnitt);
  }
  assert.equal((await get(app, '/auswertung/export/quatsch.csv', '7')).status, 404);
  assert.equal((await get(app, '/auswertung/export/engpaesse.csv', '1')).status, 403, 'F1 ohne Engpässe');
  db.close();
});

test('CSV-Export entschärft Formeln am Zellanfang', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.prepare("UPDATE kreditoren SET name = '=HYPERLINK(\"x\";\"y\")' WHERE name = 'Papeterie AG'").run();
  const res = await get(buildTestApp(db), '/auswertung/export/lieferanten.csv', '7');
  assert.match(res.text, /\n"'=HYPERLINK\(""x"";""y""\)";1;/);
  db.close();
});

test('Link auf Laufende Vorgänge nur mit vorgaenge_einsehen', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  assert.ok(!(await get(app, '/auswertung', '7')).text.includes('/admin/vorgaenge?person=2'));
  assert.ok((await get(app, '/auswertung', '8')).text.includes('/admin/vorgaenge?person=2'));
  db.close();
});

test('Navigation: "Auswertung" nur für Personen mit Zugang', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildTestApp(db);
  app.get('/pool', (req, res) => res.json(res.locals.navigation.gruppen.flatMap((g) => g.punkte.map((p) => p.href))));
  assert.ok((await get(app, '/pool', '7')).body.includes('/auswertung'));
  assert.ok((await get(app, '/pool', '1')).body.includes('/auswertung'));
  assert.ok(!(await get(app, '/pool', '5')).body.includes('/auswertung'));
  db.close();
});

test('leere Datenbank: Seite rendert mit leeren Zuständen', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '20', vorname: 'Super', nachname: 'Admin', email: 's@x.ch', gruppen: ['20'], loggedInNow: true });
  const res = await get(buildTestApp(db), '/auswertung?zeitraum=12m', '20');
  assert.equal(res.status, 200);
  assert.match(res.text, /keine Rechnungen freigegeben/);
  assert.match(res.text, /keine Rechnungen offen/);
  assert.match(res.text, /mehrere Jahre/);
  db.close();
});

test('Betragsspalten nutzen gleich breite Ziffern (Klasse betrag)', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const res = await get(buildTestApp(db), '/auswertung', '7');
  const zellen = [...res.text.matchAll(/<td class="([^"]*)">CHF /g)].map((m) => m[1]);
  assert.ok(zellen.length >= 6, 'keine Betragszellen gefunden');
  for (const klasse of zellen) assert.match(klasse, /\bbetrag\b/, `Betragszelle ohne Klasse betrag: ${klasse}`);
  db.close();
});
