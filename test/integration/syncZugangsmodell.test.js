import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson, getPersonById, findActivePersonByEmail, setFerienmodus } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { runPersonenSync } from '../../src/services/sync.js';

// Regressionen zum Befund "Personen-Sync deaktiviert berechtigte Nutzer außerhalb des alten
// Rollenmodells" (docs/review-frischer-blick-2026-09-29.md, Abschnitt 1): Portalzugang hängt am
// ChurchTools-Login, nicht an Verwaltungsgruppen.

const CT = { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' };

function person(db, id, gruppen = []) {
  upsertPerson(db, { id, vorname: `V${id}`, nachname: `N${id}`, email: `p${id}@example.org`, gruppen, loggedInNow: true });
}

function ctPerson(client, id, extra = {}) {
  client.intercept({ path: `/api/persons/${id}`, method: 'GET' }).reply(200, { data: { id: Number(id), firstName: `V${id}`, lastName: `N${id}`, email: `p${id}@example.org`, ...extra } });
}

function gruppen(client, { buchhaltung = [], admin = [] }) {
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: buchhaltung.map((personId) => ({ personId })) });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: admin.map((personId) => ({ personId })) });
}

test('Reproduktion aus dem Bericht: ein normaler angemeldeter Nutzer ohne Kontorolle bleibt aktiv und per E-Mail auffindbar', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, { admin: [1] });
  ctPerson(client, '1');
  ctPerson(client, '2');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['20']);
  person(db, '2');

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.deactivated, 0);
  assert.equal(result.upserted, 2);
  assert.equal(getPersonById(db, '2').aktiv, true);
  assert.equal(findActivePersonByEmail(db, 'p2@example.org')?.churchtools_person_id, '2', 'Kreditkartenbeleg-Mails dieser Person dürfen nicht als unbekannter Absender enden');
  db.close();
});

test('reine Spesen-Nutzer, Kartenverantwortliche, Ferienvertretungen und Personen mit Einzelrechten bleiben aktiv', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, { buchhaltung: [1], admin: [9] });
  for (const id of ['1', '9', '2', '3', '4', '5', '6']) ctPerson(client, id);
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['10']);
  person(db, '9', ['20']);
  person(db, '2'); // reiner Spesen-Nutzer: keine Gruppe, keine Kontorolle
  person(db, '3'); // Kartenverantwortliche Person
  createKreditkarte(db, { bezeichnung: 'Visa', verantwortlichId: '3', erfassungOffen: false });
  person(db, '4'); // Ferienvertretung
  person(db, '5'); // Person im Ferienmodus
  setFerienmodus(db, '5', { von: '2026-01-01', bis: '2099-12-31', stellvertreterId: '4' });
  person(db, '6'); // nur Einzelrechte
  setBerechtigungenForPerson(db, '6', ['mails_einsehen']);

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.deactivated, 0);
  for (const id of ['2', '3', '4', '5', '6']) {
    assert.equal(getPersonById(db, id).aktiv, true, `Person ${id} muss aktiv bleiben`);
    assert.deepEqual(getPersonById(db, id).gruppen, []);
  }
  db.close();
});

test('Austritt aus einer Verwaltungsgruppe entzieht sofort die Rolle, nicht aber den Portalzugang', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, { buchhaltung: [1], admin: [9] });
  for (const id of ['1', '9', '2']) ctPerson(client, id);
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['10']);
  person(db, '9', ['20']);
  person(db, '2', ['10', '20']);

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.rollenentzug, 1);
  assert.equal(getPersonById(db, '2').aktiv, true);
  assert.deepEqual(getPersonById(db, '2').gruppen, [], 'Admin-/Buchhaltungsrechte dürfen nach dem Gruppenaustritt nicht bestehen bleiben');
  db.close();
});

test('vorübergehend nicht abrufbare Person verliert eine feststehend entfallene Gruppenrolle, bleibt aber aktiv', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, { buchhaltung: [1], admin: [9] });
  ctPerson(client, '1');
  ctPerson(client, '9');
  client.intercept({ path: '/api/persons/2', method: 'GET' }).reply(429, {});
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['10']);
  person(db, '9', ['20']);
  person(db, '2', ['20']);

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.unresolved, 1);
  const p2 = getPersonById(db, '2');
  assert.equal(p2.aktiv, true);
  assert.equal(p2.ct_person_unresolved, true);
  assert.deepEqual(p2.gruppen, []);
  db.close();
});

test('in ChurchTools archivierte Personen werden mit Grund deaktiviert; erneuter Login hebt das auf', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, { admin: [1] });
  ctPerson(client, '1');
  ctPerson(client, '2', { isArchived: true });
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['20']);
  person(db, '2');

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.deactivated, 1);
  const p2 = getPersonById(db, '2');
  assert.equal(p2.aktiv, false);
  assert.equal(p2.deaktivierungsgrund, 'churchtools_archiviert');
  assert.ok(p2.deaktiviert_am);
  assert.equal(findActivePersonByEmail(db, 'p2@example.org'), null);

  person(db, '2');
  assert.equal(getPersonById(db, '2').aktiv, true);
  assert.equal(getPersonById(db, '2').deaktivierungsgrund, null);
  db.close();
});

test('leere Gruppenantwort nimmt nicht still allen Administratoren die Rolle, auch bei vielen normalen Nutzern', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  gruppen(client, {});
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['20']);
  person(db, '9', ['10']);
  for (let i = 100; i < 130; i++) {
    person(db, String(i));
    ctPerson(client, String(i));
  }
  ctPerson(client, '1');
  ctPerson(client, '9');

  const result = await runPersonenSync(db, CT, 'token');

  assert.equal(result.abgebrochen, true);
  assert.deepEqual(getPersonById(db, '1').gruppen, ['20']);
  assert.deepEqual(getPersonById(db, '9').gruppen, ['10']);
  db.close();
});

test('ein Gruppenabruf-Ausfall ändert nichts und deaktiviert niemanden', async () => {
  const client = setupMockChurchTools(CT.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(502, {});
  const db = openDatabase(':memory:');
  seedDefaults(db);
  person(db, '1', ['10']);
  person(db, '2');

  await assert.rejects(() => runPersonenSync(db, CT, 'token'), /502/);

  assert.equal(getPersonById(db, '1').aktiv, true);
  assert.deepEqual(getPersonById(db, '1').gruppen, ['10']);
  assert.equal(getPersonById(db, '2').aktiv, true);
  db.close();
});
