import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createMeineBenachrichtigungenRouter } from '../../src/routes/meineBenachrichtigungen.js';
import { setzeBenachrichtigung } from '../../src/services/benachrichtigung.js';
import { reiheBenachrichtigungEin } from '../../src/services/notify.js';

function buildTestApp(db) {
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
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  const config = { publicBaseUrl: 'http://portal.example.org' };
  app.use('/meine-benachrichtigungen', requireLogin(), createMeineBenachrichtigungenRouter({ db, config, mailer }));
  app.mailer = mailer;
  return app;
}

function frischeDb() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Anna', nachname: 'Muster', email: 'anna@example.org', gruppen: [], loggedInNow: true });
  return db;
}

const get = (app, id = '1') => request(app).get('/meine-benachrichtigungen').set('x-test-person-id', id);
const post = (app, wert, id = '1') => request(app).post('/meine-benachrichtigungen').set('x-test-person-id', id).type('form').send({ benachrichtigung: wert });

function zuweisung(db, to) {
  return reiheBenachrichtigungEin(db, { to, typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'X', jobDateiname: 'a.pdf', grund: 'G', link: 'L' } });
}

test('ohne Login 401', async () => {
  const db = frischeDb();
  const app = buildTestApp(db);
  assert.equal((await request(app).get('/meine-benachrichtigungen')).status, 401);
  db.close();
});

test('GET zeigt die vier Radios, Standard ist vorgewählt, Hinweis zu Immer-sofort', async () => {
  const db = frischeDb();
  const res = await get(buildTestApp(db));
  assert.equal(res.status, 200);
  assert.match(res.text, /value="sofort"/);
  assert.match(res.text, /Täglich um 07:00/);
  assert.match(res.text, /Wöchentlich am Montag um 07:00/);
  assert.match(res.text, /Standard verwenden \(Sofort\)/);
  assert.match(res.text, /<input[^>]*value="standard"[^>]*checked/);
  assert.match(res.text, /Erinnerungen, Eskalationen und Sicherheitsmeldungen kommen immer sofort\./);
  db.close();
});

test('GET zeigt die aktuelle Wahl und die Admin-Zeit/-Wochentag', async () => {
  const db = frischeDb();
  setConfigValue(db, 'mail_batching_stunde', '7');
  setConfigValue(db, 'mail_batching_minute', '5');
  setConfigValue(db, 'mail_digest_wochentag', '4');
  setzeBenachrichtigung(db, '1', 'woechentlich');
  const res = await get(buildTestApp(db));
  assert.match(res.text, /<input[^>]*value="woechentlich"[^>]*checked/);
  assert.match(res.text, /Wöchentlich am Donnerstag um 07:05/);
  db.close();
});

test('Speichern jeder Option', async () => {
  const db = frischeDb();
  const app = buildTestApp(db);
  for (const [wert, erwartet] of [['taeglich', 'taeglich'], ['woechentlich', 'woechentlich'], ['sofort', 'sofort'], ['standard', null]]) {
    const res = await post(app, wert);
    assert.equal(res.status, 302, wert);
    assert.match(res.headers.location, /^\/meine-benachrichtigungen/);
    assert.equal(getPersonById(db, '1').benachrichtigung, erwartet, wert);
  }
  db.close();
});

test('ungültiger Wert → 422, nichts gespeichert', async () => {
  const db = frischeDb();
  setzeBenachrichtigung(db, '1', 'taeglich');
  const res = await post(buildTestApp(db), 'quatsch');
  assert.equal(res.status, 422);
  assert.equal(getPersonById(db, '1').benachrichtigung, 'taeglich');
  db.close();
});

test('Wechsel auf sofort stellt geplante Mails sofort als Digest zu und nennt die Anzahl', async () => {
  const db = frischeDb();
  setzeBenachrichtigung(db, '1', 'woechentlich');
  zuweisung(db, 'anna@example.org');
  zuweisung(db, 'anna@example.org');
  assert.equal(listMailLog(db).filter((m) => m.status === 'geplant').length, 2);
  const app = buildTestApp(db);
  const res = await post(app, 'sofort');
  assert.equal(res.status, 302);
  assert.equal(app.mailer.sent.length, 1);
  assert.equal(app.mailer.sent[0].to, 'anna@example.org');
  assert.ok(listMailLog(db).every((m) => m.status === 'versendet'));
  const seite2 = await request(app).get(res.headers.location).set('x-test-person-id', '1');
  assert.match(seite2.text, /2 wartende Mails/);
  db.close();
});

test('Wechsel auf standard mit Standard sofort stellt ebenfalls zu; auf täglich nicht', async () => {
  const db = frischeDb();
  setzeBenachrichtigung(db, '1', 'woechentlich');
  zuweisung(db, 'anna@example.org');
  const app = buildTestApp(db);
  await post(app, 'taeglich');
  assert.equal(app.mailer.sent.length, 0);
  await post(app, 'standard');
  assert.equal(app.mailer.sent.length, 1);
  db.close();
});

test('Hinweis bei wöchentlich (168 h > Frist), bei täglich nur wenn die Frist unter 24 h liegt, nie bei sofort', async () => {
  const db = frischeDb();
  const app = buildTestApp(db);
  const text = 'Bei dieser Bündelung siehst du neue Aufgaben eventuell erst nach der Erinnerung — Erinnerungen kommen trotzdem sofort.';
  setzeBenachrichtigung(db, '1', 'woechentlich');
  assert.ok((await get(app)).text.includes(text));
  setzeBenachrichtigung(db, '1', 'taeglich');
  assert.ok(!(await get(app)).text.includes(text), 'Frist 24 h, Bündelung 24 h');
  setConfigValue(db, 'reminder_stunden', '12');
  assert.ok((await get(app)).text.includes(text));
  setzeBenachrichtigung(db, '1', 'sofort');
  assert.ok(!(await get(app)).text.includes(text));
  setzeBenachrichtigung(db, '1', null);
  assert.ok(!(await get(app)).text.includes(text));
  db.close();
});

test('Radios haben grosse Touch-Ziele (min-height 44 px)', async () => {
  const db = frischeDb();
  const res = await get(buildTestApp(db));
  assert.match(res.text, /class="benachrichtigung-option"/);
  assert.doesNotMatch(res.text, /\.benachrichtigung-option\s*\{/);
  const css = readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');
  assert.match(css, /\.benachrichtigung-option\s*\{[^}]*min-height:\s*44px/);
  db.close();
});

// --- Abschlussprüfung ---

test('F3: gemeinsame Adresse - Seite nennt den tatsächlich geltenden Wert', async () => {
  const db = frischeDb();
  upsertPerson(db, { id: '2', vorname: 'Bert', nachname: 'Muster', email: 'ANNA@example.org', gruppen: [], loggedInNow: true });
  setzeBenachrichtigung(db, '1', 'woechentlich');
  const app = buildTestApp(db);
  const res = await get(app);
  assert.match(res.text, /Deine Adresse wird mit anderen Personen geteilt; es gilt: Sofort/);
  setzeBenachrichtigung(db, '2', 'woechentlich');
  assert.doesNotMatch((await get(app)).text, /Adresse wird mit anderen/);
  db.close();
});

test('F4: Person ohne Mailadresse sieht den Hinweis, kann speichern, nichts wird zugestellt', async () => {
  const db = frischeDb();
  upsertPerson(db, { id: '3', vorname: 'Ohne', nachname: 'Mail', email: '', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  assert.match((await get(app, '3')).text, /Für dich ist keine Mailadresse hinterlegt/);
  assert.doesNotMatch((await get(app, '1')).text, /keine Mailadresse hinterlegt/);
  reiheBenachrichtigungEin(db, { to: '', typ: 'zuweisung', jobId: null, variablen: { empfaengerName: 'X', jobDateiname: 'a.pdf', grund: 'G', link: 'L' } });
  const res = await post(app, 'sofort', '3');
  assert.equal(res.status, 302);
  assert.equal(getPersonById(db, '3').benachrichtigung, 'sofort');
  assert.equal(app.mailer.sent.length, 0);
  db.close();
});

test('P1: scheitert die Sofort-Zustellung, meldet die Seite, dass es später erneut versucht wird', async () => {
  const db = frischeDb();
  setzeBenachrichtigung(db, '1', 'woechentlich');
  zuweisung(db, 'anna@example.org');
  const app = buildTestApp(db);
  app.mailer.sendMail = async () => { throw new Error('SMTP down'); };
  const res = await post(app, 'sofort');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /flushFehler=1/);
  const seite = await request(app).get(res.headers.location).set('x-test-person-id', '1');
  assert.match(seite.text, /Die wartenden Mails konnten nicht sofort verschickt werden und werden später erneut versucht\./);
  assert.doesNotMatch(seite.text, /wartende Mail(s)? wurde/);
  assert.equal(listMailLog(db).filter((m) => m.status === 'geplant').length, 1);
  db.close();
});
