import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';
import { erstelleAuditExportPaket } from '../../src/services/auditExport.js';
import { stempleAuditPaket } from '../../src/services/auditZeitstempel.js';
import { formatierePruefnummer } from '../../src/services/auditNachweisJobs.js';
import { kanonischesJson } from '../../src/services/tsaNachweis.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { createChainedTsa } from '../helpers/chainedTsa.js';

const TSA_URL = 'https://tsa.example.org/tsr';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
    n8nApiKey: 'test-n8n-key',
    downloadSigningSecret: 'test-signing-secret',
    jobsDir: '/tmp/freigabeportal-audit-pruefen-test-jobs',
    publicBaseUrl: 'https://portal.example.org',
  };
}

// Ein gestempeltes Paket mit einem Ereignis einer benannten Person.
async function setup(t, { stempeln = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  seedDefaults(db);
  db.prepare(`INSERT INTO audit_ereignisse (zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, nachher)
    VALUES ('2026-09-29T00:00:00Z', '42', 'Erika Mustermann', 'test', '1', 'test', '{"email":"erika@example.org"}')`).run();
  erstelleAuditExportPaket(db);
  const paket = db.prepare('SELECT * FROM audit_export_pakete WHERE id = 1').get();
  if (stempeln) {
    const tsa = createChainedTsa(t);
    setupMockTsa(TSA_URL).intercept({ path: '/tsr', method: 'POST' }).reply(200, tsa.reply);
    const tsaConfig = { url: TSA_URL, trustAnchorsFile: tsa.rootFile, trustAnchorsSha256: tsa.rootSha256, crlFile: tsa.crlFile };
    const { token, genTime, nachweis } = await stempleAuditPaket(paket.paket_sha256, tsaConfig);
    db.prepare(`INSERT INTO audit_export_zeitstempel (paket_nr, token, gen_time, nachweis, erstellt_am)
      VALUES (1, ?, ?, ?, ?)`).run(token, genTime.toISOString(), kanonischesJson(nachweis), new Date().toISOString());
  }
  return { db, app: createApp({ db, config: testConfig() }), paket };
}

test('GET /audit-pruefen ohne Login → 200 mit Formular', async (t) => {
  const { app } = await setup(t, { stempeln: false });
  const res = await request(app).get('/audit-pruefen');
  assert.equal(res.status, 200);
  assert.match(res.text, /<form method="get" action="\/audit-pruefen"/);
  assert.match(res.text, /name="paket"/);
  assert.match(res.text, /name="pruefnummer"/);
  assert.doesNotMatch(res.text, /name="_csrf"/);
  assert.doesNotMatch(res.text, /abgeschaltet/);
  assert.match(res.text, /Die Seite läuft im Portal selbst/);
});

test('richtige Angaben → 200 "Keine Veränderung festgestellt", druckbar, ohne Personendaten', async (t) => {
  const { app, paket } = await setup(t);
  const res = await request(app).get('/audit-pruefen').query({ paket: '1', pruefnummer: paket.paket_sha256 });
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Veränderung festgestellt/);
  assert.match(res.text, /window\.print\(\)/);
  assert.match(res.text, new RegExp(formatierePruefnummer(paket.paket_sha256)));
  assert.doesNotMatch(res.text, /Mustermann|Erika|erika@example\.org/);
});

test('formatierte Prüfnummer in Grossbuchstaben wird akzeptiert', async (t) => {
  const { app, paket } = await setup(t);
  const res = await request(app).get('/audit-pruefen')
    .query({ paket: ' 1 ', pruefnummer: formatierePruefnummer(paket.paket_sha256).toUpperCase() });
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Veränderung festgestellt/);
});

test('falsche Prüfnummer → 200 mit Abweichung', async (t) => {
  const { app } = await setup(t);
  const res = await request(app).get('/audit-pruefen').query({ paket: '1', pruefnummer: 'cd'.repeat(32) });
  assert.equal(res.status, 200);
  assert.match(res.text, /Abweichung festgestellt/);
  assert.doesNotMatch(res.text, /Keine Veränderung festgestellt/);
});

test('unbekannte Paketnummer und kein Paket → verständliche Meldung', async (t) => {
  const { app } = await setup(t, { stempeln: false });
  const res = await request(app).get('/audit-pruefen').query({ paket: '7', pruefnummer: 'ab'.repeat(32) });
  assert.equal(res.status, 200);
  assert.match(res.text, /Paket 7 ist nicht bekannt/);
  const leer = openDatabase(':memory:');
  t.after(() => leer.close());
  seedDefaults(leer);
  const res2 = await request(createApp({ db: leer, config: testConfig() })).get('/audit-pruefen').query({ paket: '1', pruefnummer: 'ab'.repeat(32) });
  assert.equal(res2.status, 200);
  assert.match(res2.text, /noch kein Audit-Paket/);
});

test('ungültige Eingaben → 400 mit Meldung, nie 500', async (t) => {
  const { app } = await setup(t, { stempeln: false });
  const faelle = [
    [{ paket: 'abc', pruefnummer: 'ab'.repeat(32) }, /Paketnummer/],
    [{ paket: '0', pruefnummer: 'ab'.repeat(32) }, /Paketnummer/],
    [{ paket: '99999999999999999999', pruefnummer: 'ab'.repeat(32) }, /Paketnummer/],
    [{ paket: '1', pruefnummer: 'xyz' }, /Prüfnummer/],
    [{ paket: '', pruefnummer: '' }, /Paketnummer/],
    [{ paket: '1' }, /Prüfnummer/],
    [{ 'paket[]': '1', pruefnummer: 'ab'.repeat(32) }, /Paketnummer/],
  ];
  for (const [query, meldung] of faelle) {
    const res = await request(app).get('/audit-pruefen').query(query);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.match(res.text, meldung, JSON.stringify(query));
    assert.match(res.text, /class="alert alert-danger/);
  }
  const xss = await request(app).get('/audit-pruefen').query({ paket: '<script>x</script>', pruefnummer: '"><b>' });
  assert.equal(xss.status, 400);
  assert.doesNotMatch(xss.text, /<script>x<\/script>|"><b>/);
});

test('abgeschaltet → Hinweis, Prüfung vorhandener Pakete funktioniert', async (t) => {
  const { db, app, paket } = await setup(t);
  setConfigValue(db, 'modul_audit_nachweis_aktiv', '0');
  const res = await request(app).get('/audit-pruefen').query({ paket: '1', pruefnummer: paket.paket_sha256 });
  assert.equal(res.status, 200);
  assert.match(res.text, /Der automatische Audit-Nachweis ist derzeit abgeschaltet\./);
  assert.match(res.text, /Keine Veränderung festgestellt/);
});

test('POST /audit-pruefen gibt es nicht', async (t) => {
  const { app } = await setup(t, { stempeln: false });
  const res = await request(app).post('/audit-pruefen').type('form').send({ paket: '1' });
  assert.notEqual(res.status, 200);
  assert.notEqual(res.status, 500);
});
