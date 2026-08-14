import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { runPersonenSync } from '../../src/services/sync.js';

const CT_CONFIG = {
  baseUrl: 'https://ct.example.org',
  groupIdBuchhaltung: '10',
  groupIdAdmin: '20',
};

test('runPersonenSync upserts current members and deactivates people no longer in any group', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client
    .intercept({ path: '/api/persons/7', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Alt', nachname: 'Verlassen', email: 'alt@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.upserted, 1);
  assert.equal(result.deactivated, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(getPersonById(db, '7').vorname, 'Max');
  assert.equal(getPersonById(db, '99').aktiv, false);

  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'erfolg'").get();
  assert.ok(logRow);
  assert.equal(logRow.anzahl_upserted, 1);
  assert.equal(logRow.anzahl_deaktiviert, 1);
  db.close();
});

test('runPersonenSync marks an existing local person unresolved when their detail fetch fails', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/7', method: 'GET' }).reply(404, {});

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '7', vorname: 'Max', nachname: 'Muster', email: 'max@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.unresolved, 1);
  assert.equal(getPersonById(db, '7').ct_person_unresolved, true);
  db.close();
});

test('runPersonenSync records a failed run and leaves existing data untouched', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(500, {});

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Bleibt', nachname: 'Gleich', email: 'b@example.org', gruppen: ['10'], loggedInNow: false });

  await assert.rejects(() => runPersonenSync(db, CT_CONFIG, 'service-token'));

  assert.equal(getPersonById(db, '1').vorname, 'Bleibt');
  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'fehler'").get();
  assert.ok(logRow);
  db.close();
});
