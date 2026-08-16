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
  // Headers are asserted here specifically (not on every sync test) to lock in the ChurchTools
  // Login-Token scheme: "Authorization: Login <token>", not "Bearer <token>" — the two auth
  // schemes are not interchangeable (a Bearer-scheme request against these endpoints 401s
  // outright on the real instance), and this was silently broken until caught in production
  // because no test asserted on the actual header value before.
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET', headers: { authorization: 'Login service-token' } }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET', headers: { authorization: 'Login service-token' } }).reply(200, { data: [] });
  client
    .intercept({ path: '/api/persons/7', method: 'GET', headers: { authorization: 'Login service-token' } })
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

test('runPersonenSync rolls back the entire write phase when one upsert fails partway through', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }, { personId: 8 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client
    .intercept({ path: '/api/persons/7', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });
  client
    .intercept({ path: '/api/persons/8', method: 'GET' })
    // vorname/nachname are NOT NULL in the schema: a null firstName here makes
    // upsertPerson throw a real SQLite constraint error during the write phase.
    .reply(200, { data: { id: 8, firstName: null, lastName: 'Ohnenamen', email: 'niemand@example.org' } });

  const db = openDatabase(':memory:');

  await assert.rejects(() => runPersonenSync(db, CT_CONFIG, 'service-token'));

  assert.equal(getPersonById(db, '7'), null);
  assert.equal(getPersonById(db, '8'), null);

  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'fehler'").get();
  assert.ok(logRow);
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

test('runPersonenSync aborts with nothing persisted when deactivations exceed the percent threshold (population large enough for percent to apply)', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  // Only person 1 is still in ChurchTools; persons 2-20 (19 of the 20 pre-existing active
  // people) would be deactivated — 95%, well over the 50% default threshold, and the active
  // population (20) is well above the default absolute floor (10), so the percent check applies.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/1', method: 'GET' }).reply(200, { data: { id: 1, firstName: 'Bleibt', lastName: 'Da', email: 'bleibt@example.org' } });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  for (let i = 1; i <= 20; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  assert.equal(result.deactivated, 0);
  assert.equal(result.upserted, 0);
  assert.match(result.meldung, /Schwelle/);
  // Nothing was persisted: person 1's profile was never upserted (still shows the old, pre-sync name)...
  assert.equal(getPersonById(db, '1').vorname, 'Person1');
  // ...and nobody was deactivated.
  for (let i = 1; i <= 20; i++) {
    assert.equal(getPersonById(db, String(i)).aktiv, true, `person ${i} should still be active`);
  }
  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'abgebrochen'").get();
  assert.ok(logRow);
  assert.match(logRow.fehler_details, /19 von 20/);
  db.close();
});

test('runPersonenSync aborts on the absolute-count threshold even when the percent is under the percent threshold', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  // 100 active people, only 85 still returned by ChurchTools -> 15 deactivated = 15%, well
  // under the 50% default percent threshold, but 15 > the default absolute threshold of 10.
  const stillActive = Array.from({ length: 85 }, (_, i) => ({ personId: i + 1 }));
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: stillActive });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  for (let i = 1; i <= 85; i++) {
    client.intercept({ path: `/api/persons/${i}`, method: 'GET' }).reply(200, { data: { id: i, firstName: `Person${i}`, lastName: 'Aktiv', email: `p${i}@example.org` } });
  }

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  for (let i = 1; i <= 100; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  assert.equal(result.deactivated, 0);
  for (let i = 86; i <= 100; i++) {
    assert.equal(getPersonById(db, String(i)).aktiv, true, `person ${i} should still be active — the run aborted before any deactivation`);
  }
  db.close();
});

test('runPersonenSync does NOT abort a small-population run even at 100% deactivation (percent threshold only applies once active count reaches the absolute floor)', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/7', method: 'GET' }).reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  // Exactly one pre-existing active person, who will be deactivated this run (100% of the
  // population) — with only the default absolute floor of 10, this must NOT trip the guard.
  upsertPerson(db, { id: '99', vorname: 'Alt', nachname: 'Verlassen', email: 'alt@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.deactivated, 1);
  assert.equal(getPersonById(db, '99').aktiv, false);
  db.close();
});

test('runPersonenSync aborts a full-wipe run against a small population that never crosses the percent/absolute-count arms', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  // ChurchTools returns nobody at all in either group (e.g. an outage) — this would deactivate
  // all 9 pre-existing active people, 100% of the population. With the default absolute floor
  // of 10, the percent arm is gated off (9 < 10) and the absolute-count arm can't fire either
  // (9 is not > 10) — only the dedicated full-wipe arm can catch this.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  for (let i = 1; i <= 9; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  assert.equal(result.deactivated, 0);
  assert.equal(result.upserted, 0);
  for (let i = 1; i <= 9; i++) {
    assert.equal(getPersonById(db, String(i)).aktiv, true, `person ${i} should still be active`);
  }
  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'abgebrochen'").get();
  assert.ok(logRow);
  assert.match(logRow.fehler_details, /9 von 9/);
  db.close();
});

test('runPersonenSync respects admin_config-configured thresholds', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  // Lower the absolute threshold to 1 so a single deactivation now trips the guard.
  setConfigValue(db, 'sync_max_deaktivierung_anzahl', '1');
  upsertPerson(db, { id: '1', vorname: 'Wird', nachname: 'Deaktiviert', email: 'weg@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Wird', nachname: 'Auch', email: 'auch@example.org', gruppen: ['10'], loggedInNow: false });
  // Population is 2, below the default absolute floor used to gate the percent check, so this
  // exercises the (now-lowered) absolute threshold specifically.

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  db.close();
});

test('runPersonenSync does not deactivate persons referenced as approvers on an active Konto, even with no group membership', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  for (const id of [50, 51, 52, 53]) {
    client.intercept({ path: `/api/persons/${id}`, method: 'GET' }).reply(200, { data: { id, firstName: `Person${id}`, lastName: 'Muster', email: `p${id}@example.org` } });
  }

  const db = openDatabase(':memory:');
  for (const id of ['50', '51', '52', '53']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.upserted, 4);
  assert.equal(result.deactivated, 0);
  assert.equal(getPersonById(db, '50').aktiv, true);
  assert.equal(getPersonById(db, '53').aktiv, true);
  db.close();
});

test('runPersonenSync does not overwrite real group membership for a person who is also referenced as an approver on an active Konto', async () => {
  // SYNC-WIDEN-1's dedup guard (`if (!personIdToGroups.has(personId))`) must not run
  // unconditionally: person 50 is a genuine Buchhaltung member AND is referenced as freigeber1
  // on an active Konto. If the guard were removed, the Konto-referenced-persons loop would
  // unconditionally overwrite personIdToGroups.set(50, []), silently wiping their real ['10']
  // membership on the very next sync — and with it, their /pool, /api/pool, and /admin access.
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 50 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  for (const id of [50, 51, 52, 53]) {
    client.intercept({ path: `/api/persons/${id}`, method: 'GET' }).reply(200, { data: { id, firstName: `Person${id}`, lastName: 'Muster', email: `p${id}@example.org` } });
  }

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '50', vorname: 'Person50', nachname: 'Muster', email: 'p50@example.org', gruppen: ['10'], loggedInNow: false });
  for (const id of ['51', '52', '53']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  // Person 50 is both a Buchhaltung group member (above) AND freigeber1 on this Konto.
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, false);
  assert.deepEqual(getPersonById(db, '50').gruppen, ['10'], "person 50's real group membership must survive the sync, not be overwritten with []");
  db.close();
});

test('runPersonenSync deactivates a person referenced only on a deactivated Konto when they have no group membership', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/99', method: 'GET' }).reply(200, { data: { id: 99, firstName: 'Bleibt', lastName: 'Aktiv', email: 'bleibt@example.org' } });

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Bleibt', nachname: 'Aktiv', email: 'bleibt@example.org', gruppen: ['10'], loggedInNow: false });
  for (const id of ['50', '51', '52', '53']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const { createKonto, deactivateKonto } = await import('../../src/db/kontenRepo.js');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });
  deactivateKonto(db, kontoId);

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.deactivated, 4);
  assert.equal(getPersonById(db, '50').aktiv, false);
  assert.equal(getPersonById(db, '99').aktiv, true);
  db.close();
});
