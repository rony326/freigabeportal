import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKreditkarte, setErfasser, setKreditkarteAktiv } from '../../src/db/kreditkartenRepo.js';
import { getKkBelegById, listKkBelegeFuerPerson } from '../../src/db/kkBelegeRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKreditkarteRouter } from '../../src/routes/kreditkarte.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1 } from '../helpers/imageFixture.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kk-test-'));
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', jobsDir: dir, publicBaseUrl: 'https://portal.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  for (const id of ['1', '2', '3']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  const offen = createKreditkarte(db, { bezeichnung: 'Visa Offen', verantwortlichId: '1', erfassungOffen: true });
  const zu = createKreditkarte(db, { bezeichnung: 'Visa Zu', verantwortlichId: '1', erfassungOffen: false });
  setErfasser(db, zu, ['2']);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kreditkarte', requireLogin(), createKreditkarteRouter({ db, config }));
  return { db, app, dir, offen, zu, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function upload(app, personId, felder, datei = { buffer: null, name: 'beleg.pdf', type: 'application/pdf' }) {
  const buffer = datei.buffer ?? (await buildPdfFixture(['Beleg']));
  let req = request(app).post('/kreditkarte/belege').set('x-test-person-id', personId);
  for (const [k, v] of Object.entries(felder)) req = req.field(k, v);
  return req.attach('beleg', buffer, { filename: datei.name, contentType: datei.type });
}

test('GET /kreditkarte lists only cards the person may upload to', async () => {
  const t = setup();
  const res = await request(t.app).get('/kreditkarte').set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /Visa Offen/);
  assert.doesNotMatch(res.text, /Visa Zu/);
  t.cleanup();
});

test('POST /kreditkarte/belege stores an offen receipt with file and thumbnail, image converted to PDF', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '12,50', kaufdatum: '2026-09-01', beschreibung: 'Zugticket' }, { buffer: PNG_1X1, name: 'foto.png', type: 'image/png' });
  assert.equal(res.status, 302);
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  assert.equal(beleg.status, 'offen');
  assert.equal(beleg.betrag, '12.50');
  assert.equal(beleg.quelle, 'web');
  assert.ok(beleg.pdf_pfad.endsWith('.pdf'));
  assert.ok(existsSync(beleg.pdf_pfad));
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM kk_beleg_ereignisse WHERE aktion = 'kk_beleg_erfasst'").get().n, 1);
  t.cleanup();
});

test('POST /kreditkarte/belege accepts a negative amount (refund)', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '-20.00', kaufdatum: '2026-09-01', beschreibung: 'Rückerstattung' });
  assert.equal(res.status, 302);
  assert.equal(listKkBelegeFuerPerson(t.db, '3')[0].betrag, '-20.00');
  t.cleanup();
});

test('POST /kreditkarte/belege: 403 on a Modus-B card the person is not listed for', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.zu), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x' });
  assert.equal(res.status, 403);
  assert.equal(listKkBelegeFuerPerson(t.db, '3').length, 0);
  t.cleanup();
});

test('POST /kreditkarte/belege: 400 for a future date, a missing description, and a disguised file', async () => {
  const t = setup();
  const zukunft = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const r1 = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: zukunft, beschreibung: 'x' });
  assert.equal(r1.status, 400);
  const r2 = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: '' });
  assert.equal(r2.status, 400);
  const r3 = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x' }, { buffer: Buffer.from('not a pdf at all'), name: 'x.pdf', type: 'application/pdf' });
  assert.equal(r3.status, 400);
  assert.equal(listKkBelegeFuerPerson(t.db, '3').length, 0);
  t.cleanup();
});

test('module off: GET / and POST /belege are 403, but viewing an existing receipt still works', async () => {
  const t = setup();
  await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x' });
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await request(t.app).get('/kreditkarte').set('x-test-person-id', '3')).status, 403);
  assert.equal((await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x' })).status, 403);
  const datei = await request(t.app).get(`/kreditkarte/belege/${beleg.id}/datei`).set('x-test-person-id', '3');
  assert.equal(datei.status, 200);
  assert.equal(datei.headers['content-type'], 'application/pdf');
  t.cleanup();
});

test('bearbeiten and verwerfen: allowed for uploader and responsible person, 403 for others, locked afterwards', async () => {
  const t = setup();
  await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'alt' });
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  const fremd = await request(t.app).post(`/kreditkarte/belege/${beleg.id}`).set('x-test-person-id', '2')
    .field('kreditkarteId', String(t.offen)).field('betrag', '2.00').field('kaufdatum', '2026-09-01').field('beschreibung', 'neu');
  assert.equal(fremd.status, 403);
  const ok = await request(t.app).post(`/kreditkarte/belege/${beleg.id}`).set('x-test-person-id', '1')
    .field('kreditkarteId', String(t.offen)).field('betrag', '2.00').field('kaufdatum', '2026-09-01').field('beschreibung', 'neu');
  assert.equal(ok.status, 302);
  assert.equal(getKkBelegById(t.db, beleg.id).beschreibung, 'neu');
  const ohneGrund = await request(t.app).post(`/kreditkarte/belege/${beleg.id}/verwerfen`).set('x-test-person-id', '3').type('form').send({ grund: '' });
  assert.equal(ohneGrund.status, 400);
  const verworfen = await request(t.app).post(`/kreditkarte/belege/${beleg.id}/verwerfen`).set('x-test-person-id', '3').type('form').send({ grund: 'doppelt' });
  assert.equal(verworfen.status, 302);
  assert.equal(getKkBelegById(t.db, beleg.id).status, 'verworfen');
  const danach = await request(t.app).get(`/kreditkarte/belege/${beleg.id}/bearbeiten`).set('x-test-person-id', '3');
  assert.equal(danach.status, 403);
  t.cleanup();
});

test('GET /kreditkarte shows the responsible person all open receipts of their cards', async () => {
  const t = setup();
  await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '9.90', kaufdatum: '2026-09-01', beschreibung: 'Druckerpapier' });
  const res = await request(t.app).get('/kreditkarte').set('x-test-person-id', '1');
  assert.match(res.text, /Offene Belege meiner Karten/);
  assert.match(res.text, /Druckerpapier/);
  t.cleanup();
});

test('POST /kreditkarte/belege and editing: 400 for a description with characters that cannot be stamped', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'Kaffee ☕' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Beschreibung enthält Zeichen, die nicht gestempelt werden können/);
  assert.equal(listKkBelegeFuerPerson(t.db, '3').length, 0);
  await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'Kaffee' });
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  const edit = await request(t.app).post(`/kreditkarte/belege/${beleg.id}`).set('x-test-person-id', '3')
    .field('kreditkarteId', String(t.offen)).field('betrag', '1.00').field('kaufdatum', '2026-09-01').field('beschreibung', 'Kaffee ☕');
  assert.equal(edit.status, 400);
  assert.equal(getKkBelegById(t.db, beleg.id).beschreibung, 'Kaffee');
  t.cleanup();
});

test('editing a receipt whose card was deactivated meanwhile still works, new uploads to that card stay forbidden', async () => {
  const t = setup();
  await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'alt' });
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  setKreditkarteAktiv(t.db, t.offen, false);
  const edit = await request(t.app).post(`/kreditkarte/belege/${beleg.id}`).set('x-test-person-id', '3')
    .field('kreditkarteId', String(t.offen)).field('betrag', '2.00').field('kaufdatum', '2026-09-01').field('beschreibung', 'neu');
  assert.equal(edit.status, 302, edit.text);
  assert.equal(getKkBelegById(t.db, beleg.id).beschreibung, 'neu');
  const neu = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '1.00', kaufdatum: '2026-09-01', beschreibung: 'x' });
  assert.equal(neu.status, 403);
  assert.equal(listKkBelegeFuerPerson(t.db, '3').length, 1);
  t.cleanup();
});

test('upload for someone else: gekauft_von is stored, and the buyer may edit the receipt', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '8.00', kaufdatum: '2026-09-01', beschreibung: 'Taxi', gekauftVon: '2' });
  assert.equal(res.status, 302);
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  assert.equal(beleg.hochgeladen_von, '3');
  assert.equal(beleg.gekauft_von, '2');
  const alsKaeufer = await request(t.app).get(`/kreditkarte/belege/${beleg.id}/bearbeiten`).set('x-test-person-id', '2');
  assert.equal(alsKaeufer.status, 200);
  t.cleanup();
});

test('upload with an unknown gekauftVon person is rejected with 400', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '8.00', kaufdatum: '2026-09-01', beschreibung: 'Taxi', gekauftVon: '999' });
  assert.equal(res.status, 400);
  t.cleanup();
});

test('completing an Entwurf moves it to offen; the Entwurf is not offered on any card list before', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['Beleg']);
  const { pdfPfad } = await (await import('../../src/services/kkBelegDatei.js')).speichereKkBelegDatei({ jobsDir: t.dir }, pdf, 'application/pdf');
  const { createKkBeleg } = await import('../../src/db/kkBelegeRepo.js');
  const id = createKkBeleg(t.db, { kreditkarteId: null, hochgeladenVon: '3', gekauftVon: '3', quelle: 'mail', pdfPfad, status: 'entwurf' });
  const seite = await request(t.app).get('/kreditkarte').set('x-test-person-id', '3');
  assert.match(seite.text, /Zu ergänzen/);
  const res = await request(t.app).post(`/kreditkarte/belege/${id}`).set('x-test-person-id', '3')
    .field('kreditkarteId', String(t.offen)).field('betrag', '4.20').field('kaufdatum', '2026-09-01').field('beschreibung', 'Kaffee Team');
  assert.equal(res.status, 302);
  const b = getKkBelegById(t.db, id);
  assert.equal(b.status, 'offen');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM kk_beleg_ereignisse WHERE beleg_id = ? AND aktion = 'kk_beleg_ergaenzt'").get(id).n, 1);
  t.cleanup();
});
