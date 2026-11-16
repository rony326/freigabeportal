import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKreditor } from '../../../src/db/kreditorenRepo.js';
import { createKreditorIban, listKreditorIbansAll } from '../../../src/db/kreditorIbanRepo.js';
import { listMailLog } from '../../../src/db/mailLogRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { createKreditorenRouter } from '../../../src/routes/admin/kreditoren.js';
import { IMMER_SOFORT_TYPEN } from '../../../src/services/notify.js';
import { EREIGNISSE } from '../../../src/services/benachrichtigungsEreignisse.js';
import { TYP_ZU_KEY_INFIX } from '../../../src/services/mailTemplates.js';

// S4: Wer eine Lieferanten-IBAN hinzufügt oder löscht, löst immer sofort eine Meldung an Buchhaltung und Admin aus.
const IBAN = 'CH4431999123000889012';

function bauen(db, mails) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  const config = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const mailer = { async sendMail(mail) { mails.push(mail); } };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/kreditoren', requirePermission(db, config, 'kreditoren_verwalten'), createKreditorenRouter({ db, config, mailer }));
  return app;
}

function aufsetzen() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '11', vorname: 'Berta', nachname: 'Buch', email: 'buch@example.org', gruppen: ['10'], loggedInNow: true });
  // Wählt sonst die tägliche Zusammenfassung: diese Meldung muss trotzdem sofort kommen.
  upsertPerson(db, { id: '12', vorname: 'Karl', nachname: 'Kollektiv', email: 'kollektiv@example.org', gruppen: ['10'], loggedInNow: true });
  db.prepare("UPDATE personen SET benachrichtigung = 'taeglich' WHERE churchtools_person_id = '12'").run();
  const mails = [];
  return { db, mails, app: bauen(db, mails) };
}

test('IBAN hinzufügen: Mail an Buchhaltung und Admin (auch an die ändernde Person), sofort, mit Lieferant, IBAN, Wer und Wann', async () => {
  const { db, mails, app } = aufsetzen();
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'lastschrift' });
  const res = await request(app).post('/admin/kreditoren/ibans').set('x-test-person-id', '99').type('form').send({ iban: IBAN, kreditorId: String(kreditorId) });
  assert.equal(res.status, 302);
  const zeilen = listMailLog(db).filter((m) => m.typ === 'iban-aenderung');
  assert.deepEqual(zeilen.map((m) => m.empfaenger).sort(), ['admin@example.org', 'buch@example.org', 'kollektiv@example.org']);
  assert.ok(zeilen.every((m) => m.status === 'versendet'), 'nie gebündelt (geplant)');
  assert.equal(mails.length, 3);
  const text = mails[0].text;
  assert.match(mails[0].subject, /Muster AG/);
  assert.match(text, /Muster AG/);
  assert.match(text, /CH44 … 9012/);
  assert.doesNotMatch(text, /CH4431999123000889012/, 'IBAN gekürzt wie bei der IBAN-Abweichung');
  assert.match(text, /hinzugefügt/);
  assert.match(text, /Admina Portal/);
  assert.match(text, /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  db.close();
});

test('IBAN löschen: Mail "gelöscht"; abgelehnte Löschung (letzte IBAN bei Überweisung) und ungültige IBAN lösen keine Mail aus', async () => {
  const { db, mails, app } = aufsetzen();
  const frei = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'lastschrift' });
  const ibanId = createKreditorIban(db, { kreditorId: frei, iban: IBAN });
  const res = await request(app).post(`/admin/kreditoren/ibans/${ibanId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(mails.length, 3);
  assert.match(mails[0].text, /gelöscht/);
  assert.match(mails[0].text, /Muster AG/);

  mails.length = 0;
  const pflicht = createKreditor(db, { name: 'Pflicht AG', kontoId: null, zahlungsart: 'ueberweisung' });
  const letzte = createKreditorIban(db, { kreditorId: pflicht, iban: 'CH9300762011623852957' });
  const abgelehnt = await request(app).post(`/admin/kreditoren/ibans/${letzte}/loeschen`).set('x-test-person-id', '99');
  assert.equal(abgelehnt.status, 400);
  const ungueltig = await request(app).post('/admin/kreditoren/ibans').set('x-test-person-id', '99').type('form').send({ iban: 'KEINE', kreditorId: String(pflicht) });
  assert.equal(ungueltig.status, 400);
  assert.equal(mails.length, 0);
  db.close();
});

test('neuer Lieferant mit Erst-IBAN über Admin → Kreditoren meldet ebenfalls', async () => {
  const { db, mails, app } = aufsetzen();
  const res = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form').send({ name: 'Neu GmbH', zahlungsart: 'ueberweisung', iban: IBAN });
  assert.equal(res.status, 302);
  assert.equal(mails.length, 3);
  assert.match(mails[0].text, /Neu GmbH/);
  assert.match(mails[0].text, /neuer Lieferant/);
  db.close();
});

test('neuer Lieferant mit Erst-IBAN und Absender: Meldung kommt, Link führt auf die Kreditor-Seite', async () => {
  const { db, mails, app } = aufsetzen();
  const res = await request(app).post('/admin/kreditoren').set('x-test-person-id', '99').type('form').send({ name: 'Regel GmbH', zahlungsart: 'ueberweisung', iban: IBAN, absenderMuster: 'regel-gmbh.ch' });
  assert.equal(res.status, 302);
  const id = db.prepare("SELECT id FROM kreditoren WHERE name = 'Regel GmbH'").get().id;
  assert.equal(mails.length, 3);
  assert.ok(mails[0].text.includes(`https://portal.example.org/admin/kreditoren/${id}/bearbeiten`), mails[0].text);
  db.close();
});

test('IBAN-Eintrag merkt sich, wer ihn erfasst hat (erstellt_von)', async () => {
  const { db, app } = aufsetzen();
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'lastschrift' });
  await request(app).post('/admin/kreditoren/ibans').set('x-test-person-id', '99').type('form').send({ iban: IBAN, kreditorId: String(kreditorId) });
  assert.equal(listKreditorIbansAll(db)[0].erstellt_von, '99');
  db.close();
});

test('Empfänger sind einstellbar (Standard: Buchhaltung und Admin); Ereignis ist definiert, sofort und hat Vorlage', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'iban_aenderung_empfaenger'), 'gruppe:buchhaltung\ngruppe:admin');
  const e = EREIGNISSE.find((x) => x.id === 'iban-aenderung');
  assert.ok(e, 'Ereignis fehlt');
  assert.equal(e.sofort, true);
  assert.equal(e.empfaengerKey, 'iban_aenderung_empfaenger');
  assert.equal(e.vorlagenTyp, 'iban-aenderung');
  assert.ok(TYP_ZU_KEY_INFIX['iban-aenderung']);
  assert.ok(IMMER_SOFORT_TYPEN.has('iban-aenderung'));
  assert.ok(getConfigValue(db, 'mail_vorlage_iban_aenderung_betreff'));
  assert.ok(getConfigValue(db, 'mail_vorlage_iban_aenderung_text'));
  const vorlage = getConfigValue(db, 'mail_vorlage_iban_aenderung_betreff') + getConfigValue(db, 'mail_vorlage_iban_aenderung_text');
  for (const v of e.variablen) assert.ok(vorlage.includes(`%${v.name}%`), `Variable %${v.name}% fehlt in der Vorlage`);
  db.close();
});

test('Zusätzlich konfigurierte Empfänger werden berücksichtigt', async () => {
  const { db, mails, app } = aufsetzen();
  setConfigValue(db, 'iban_aenderung_empfaenger', 'gruppe:admin\nrevision@example.org');
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: null, zahlungsart: 'lastschrift' });
  await request(app).post('/admin/kreditoren/ibans').set('x-test-person-id', '99').type('form').send({ iban: IBAN, kreditorId: String(kreditorId) });
  assert.deepEqual(mails.map((m) => m.to).sort(), ['admin@example.org', 'revision@example.org']);
  db.close();
});
