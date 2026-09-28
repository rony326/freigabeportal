import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditkarte } from '../../src/db/kreditkartenRepo.js';
import { createKkBeleg, getKkBelegById, verwerfeKkBeleg } from '../../src/db/kkBelegeRepo.js';
import { createJob, getJobById, markiereJobAlsKkAbrechnung, listSplitKinder } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKkAbgleichRouter } from '../../src/routes/kkAbgleich.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../src/services/splitGruppenExport.js';
import { abschliessenFreigabe2 } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kk-abgleich-'));
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', jobsDir: dir, publicBaseUrl: 'https://portal.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [] });
  // Person 1 = verantwortlich + Freigeber1 von "Eigen"; Person 5 = Freigeber1 von "Fremd".
  const eigen = createKonto(db, { kontonummer: '1000', bezeichnung: 'Eigen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const fremd = createKonto(db, { kontonummer: '2000', bezeichnung: 'Fremd', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '6', stellvertreter2Id: '4' });
  const karteId = createKreditkarte(db, { bezeichnung: 'Visa Jugend', verantwortlichId: '1', erfassungOffen: true });
  const abrechnungPfad = join(dir, 'abrechnung.pdf');
  writeFileSync(abrechnungPfad, await buildPdfFixture(['Abrechnung September']));
  const jobId = createJob(db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: 'karten@bank.example', dateiname: 'abrechnung.pdf', pdfPfad: abrechnungPfad });
  markiereJobAlsKkAbrechnung(db, jobId, { kreditkarteId: karteId, verantwortlichId: '1', ausStatus: 'unzugewiesen' });
  async function beleg(betrag, beschreibung, kontoId = null) {
    const pfad = join(dir, `beleg-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(pfad, await buildPdfFixture([`Beleg ${beschreibung}`]));
    return createKkBeleg(db, { kreditkarteId: karteId, hochgeladenVon: '7', gekauftVon: '7', quelle: 'web', pdfPfad: pfad, betrag, kaufdatum: '2026-09-03', beschreibung, kontoId, status: 'offen' });
  }
  const sent = [];
  const mailer = { async sendMail(m) { sent.push(m); } };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kontierung', requireLogin(), createKkAbgleichRouter({ db, config, mailer }));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return { db, app, dir, config, eigen, fremd, karteId, jobId, beleg, sent, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('GET /kontierung/:id/kk-abgleich shows the open receipts of the card to the assigned person only', async () => {
  const t = await setup();
  await t.beleg('12.50', 'Zugticket');
  const ok = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Zugticket/);
  assert.match(ok.text, /Visa Jugend/);
  const fremd = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '5');
  assert.equal(fremd.status, 403);
  t.cleanup();
});

test('GET /kontierung/:id/kk-abgleich on an unmarked job is 409', async () => {
  const t = await setup();
  const id = createJob(t.db, { eingangAm: '2026-09-27T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'x.pdf', pdfPfad: join(t.dir, 'abrechnung.pdf') });
  t.db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(id);
  assert.equal((await request(t.app).get(`/kontierung/${id}/kk-abgleich`).set('x-test-person-id', '1')).status, 409);
  t.cleanup();
});

test('GET /kontierung/:id/kk-abgleich still works with the module switched off', async () => {
  const t = await setup();
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1')).status, 200);
  t.cleanup();
});

function post(t, personId, { gesamtbetrag, zeilen, kopf = {}, begruendung = '', dateien = {} }) {
  let req = request(t.app).post(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', personId).field('gesamtbetrag', gesamtbetrag).field('begruendung', begruendung);
  for (const [k, v] of Object.entries(kopf)) req = req.field(k, v);
  for (const z of zeilen) {
    req = req.field('zeileArt', z.art).field('zeileBelegId', z.belegId ? String(z.belegId) : '').field('zeileKontoId', String(z.kontoId))
      .field('zeileBetrag', z.betrag).field('zeilePosition', z.position || '').field('zeileBeschreibung', z.beschreibung || '')
      .field('zeileGrund', z.grund || '').field('zeileKonflikt', z.konflikt ? 'true' : 'false');
  }
  for (const [feld, { buffer, name, type }] of Object.entries(dateien)) req = req.attach(feld, buffer, { filename: name, contentType: type });
  return req;
}

test('POST kk-abgleich with all three line kinds creates the children, assigns receipts, keeps the rest open', async () => {
  const t = await setup();
  const b1 = await t.beleg('30.00', 'Papier', t.eigen);
  const b2 = await t.beleg('20.00', 'Kursgebühr', t.fremd);
  const uebrig = await t.beleg('99.00', 'Kommt nächsten Monat');
  const nachgereicht = await buildPdfFixture(['Nachgereichter Beleg']);
  const res = await post(t, '1', {
    gesamtbetrag: '47.50',
    kopf: { rechnungsnummer: 'KK-2026-09', zahlungsziel: '2026-10-20' },
    zeilen: [
      { art: 'beleg', belegId: b1, kontoId: t.eigen, betrag: '30.00', beschreibung: 'Papier' },
      { art: 'beleg', belegId: b2, kontoId: t.fremd, betrag: '20.00', beschreibung: 'Kursgebühr' },
      { art: 'nachreichen', kontoId: t.eigen, betrag: '5.00', beschreibung: 'Parkhaus' },
      { art: 'eigenbeleg', kontoId: t.eigen, betrag: '4.00', beschreibung: 'Kaffee', grund: 'Beleg verloren' },
      { art: 'gebuehr', kontoId: t.eigen, betrag: '-11.50', beschreibung: 'Rückvergütung Jahresgebühr' },
    ],
    dateien: { zeileDatei_2: { buffer: nachgereicht, name: 'park.pdf', type: 'application/pdf' } },
  });
  assert.equal(res.status, 302, res.text);
  const parent = getJobById(t.db, t.jobId);
  assert.equal(parent.status, 'aufgesplittet');
  assert.equal(parent.betrag, '47.50');
  const kinder = listSplitKinder(t.db, t.jobId);
  assert.equal(kinder.length, 5);
  assert.ok(kinder.every((k) => k.kreditkarte_id === null));
  assert.ok(kinder.every((k) => k.rechnungsnummer === 'KK-2026-09'));
  const [kPapier, kKurs, kPark, kKaffee, kGebuehr] = kinder;
  assert.equal(kPapier.status, 'freigabe2');
  assert.equal(kPapier.beleg_seitenzahl, 1);
  assert.equal(kKurs.status, 'zugewiesen');
  assert.equal(kKurs.zugewiesen_an, '5');
  assert.equal(kKurs.konto_id, t.fremd);
  assert.equal(kPark.beleg_seitenzahl, 1);
  assert.equal(kKaffee.kk_eigenbeleg_grund, 'Beleg verloren');
  assert.equal(kKaffee.beleg_seitenzahl, null);
  assert.equal(kGebuehr.kk_eigenbeleg_grund, 'Gebühr/Zins');
  assert.equal(kGebuehr.typ, 'gutschrift');
  assert.equal(kGebuehr.betrag, '11.50');
  assert.equal(getKkBelegById(t.db, b1).status, 'zugeordnet');
  assert.equal(getKkBelegById(t.db, b1).zugeordnet_job_id, kPapier.id);
  assert.equal(getKkBelegById(t.db, uebrig).status, 'offen');
  const nachreich = t.db.prepare("SELECT * FROM kk_belege WHERE quelle = 'abgleich'").get();
  assert.equal(nachreich.status, 'zugeordnet');
  assert.equal(nachreich.zugeordnet_job_id, kPark.id);
  assert.ok(t.sent.some((m) => m.to === 'p5@example.org'), 'Freigeber1 des fremden Kontos wird informiert');
  t.cleanup();
});

test('POST kk-abgleich: a single line is enough', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  const res = await post(t, '1', { gesamtbetrag: '12.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  assert.equal(res.status, 302);
  assert.equal(listSplitKinder(t.db, t.jobId).length, 1);
  t.cleanup();
});

test('POST kk-abgleich: 400 on sum mismatch, on Eigenbeleg without reason, on no lines — nothing changes', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  const r1 = await post(t, '1', { gesamtbetrag: '13.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  assert.equal(r1.status, 400);
  assert.match(r1.text, /Summe/);
  const r2 = await post(t, '1', { gesamtbetrag: '4.00', zeilen: [{ art: 'eigenbeleg', kontoId: t.eigen, betrag: '4.00', grund: '' }] });
  assert.equal(r2.status, 400);
  const r3 = await post(t, '1', { gesamtbetrag: '0.00', zeilen: [] });
  assert.equal(r3.status, 400);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  assert.equal(getKkBelegById(t.db, b).status, 'offen');
  t.cleanup();
});

test('POST kk-abgleich: a receipt discarded meanwhile makes the whole Abgleich fail with 409, no children, no leftover files', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  const dateienVorher = readdirSync(t.dir).length;
  verwerfeKkBeleg(t.db, b, { personId: '7', grund: 'doppelt' });
  const res = await post(t, '1', { gesamtbetrag: '12.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  assert.equal(res.status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  assert.equal(listSplitKinder(t.db, t.jobId).length, 0);
  assert.equal(readdirSync(t.dir).length, dateienVorher);
  t.cleanup();
});

test('POST kk-abgleich: a receipt of another card is rejected with 400', async () => {
  const t = await setup();
  const andere = createKreditkarte(t.db, { bezeichnung: 'Andere', verantwortlichId: '1', erfassungOffen: true });
  const fremderBeleg = createKkBeleg(t.db, { kreditkarteId: andere, hochgeladenVon: '7', gekauftVon: '7', quelle: 'web', pdfPfad: join(t.dir, 'abrechnung.pdf'), betrag: '5.00', kaufdatum: '2026-09-01', beschreibung: 'x', status: 'offen' });
  const res = await post(t, '1', { gesamtbetrag: '5.00', zeilen: [{ art: 'beleg', belegId: fremderBeleg, kontoId: t.eigen, betrag: '5.00' }] });
  assert.equal(res.status, 400);
  t.cleanup();
});

test('POST kk-abgleich still works with the module switched off', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  const res = await post(t, '1', { gesamtbetrag: '12.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  assert.equal(res.status, 302);
  t.cleanup();
});

test('the foreign-Konto child opens in the normal Kontierung with Konto/Betrag/Beschreibung pre-filled (not redirected)', async () => {
  const t = await setup();
  const b = await t.beleg('20.00', 'Kursgebühr', t.fremd);
  await post(t, '1', { gesamtbetrag: '20.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.fremd, betrag: '20.00', beschreibung: 'Kursgebühr' }] });
  const [kind] = listSplitKinder(t.db, t.jobId);
  const res = await request(t.app).get(`/kontierung/${kind.id}`).set('x-test-person-id', '5');
  assert.equal(res.status, 200);
  assert.match(res.text, /20\.00/);
  t.cleanup();
});

test('after all children are approved, the Splitgruppe exports one merged document — also for a single line', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  await post(t, '1', { gesamtbetrag: '12.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  const [kind] = listSplitKinder(t.db, t.jobId);
  createFreigabe(t.db, { jobId: kind.id, personId: '3', rolle: 'freigeber2', zeitpunkt: new Date().toISOString(), ip: '::1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  abschliessenFreigabe2(t.db, kind.id);
  const ergebnis = await pruefeUndFinalisiereSplitGruppe(t.db, t.jobId);
  assert.equal(ergebnis.status, 'exportiert');
  assert.ok(existsSync(ergebnis.pdfPfad));
  t.cleanup();
});

test('a negative line on a foreign Konto becomes a positive Gutschrift the Freigeber1 can kontieren', async () => {
  const t = await setup();
  const res = await post(t, '1', { gesamtbetrag: '-7.25', zeilen: [{ art: 'eigenbeleg', kontoId: t.fremd, betrag: '-7.25', beschreibung: 'Rueckerstattung', grund: 'Gutschrift ohne Beleg' }] });
  assert.equal(res.status, 302, res.text);
  assert.equal(getJobById(t.db, t.jobId).betrag, '-7.25');
  const [kind] = listSplitKinder(t.db, t.jobId);
  assert.equal(kind.betrag, '7.25');
  assert.equal(kind.typ, 'gutschrift');
  assert.equal(kind.zugewiesen_an, '5');
  const seite = await request(t.app).get(`/kontierung/${kind.id}`).set('x-test-person-id', '5');
  assert.equal(seite.status, 200);
  assert.match(seite.text, /7\.25/);
  assert.doesNotMatch(seite.text, /-7\.25/);
  t.cleanup();
});

test('a nachgereichter Beleg keeps its signed amount in kk_belege while the child is a positive Gutschrift', async () => {
  const t = await setup();
  const pdf = await buildPdfFixture(['Gutschrift Beleg']);
  const res = await post(t, '1', {
    gesamtbetrag: '-3.00',
    zeilen: [{ art: 'nachreichen', kontoId: t.eigen, betrag: '-3.00', beschreibung: 'Retoure' }],
    dateien: { zeileDatei_0: { buffer: pdf, name: 'r.pdf', type: 'application/pdf' } },
  });
  assert.equal(res.status, 302, res.text);
  const [kind] = listSplitKinder(t.db, t.jobId);
  assert.equal(kind.betrag, '3.00');
  assert.equal(kind.typ, 'gutschrift');
  assert.equal(t.db.prepare("SELECT betrag FROM kk_belege WHERE quelle = 'abgleich'").get().betrag, '-3.00');
  t.cleanup();
});

test('POST kk-abgleich: a corrupt upload is a 400 without leftover files', async () => {
  const t = await setup();
  const dateienVorher = readdirSync(t.dir).length;
  const res = await post(t, '1', {
    gesamtbetrag: '5.00',
    zeilen: [{ art: 'nachreichen', kontoId: t.eigen, betrag: '5.00', beschreibung: 'Parkhaus' }],
    dateien: { zeileDatei_0: { buffer: Buffer.from('%PDF-1.4 kaputt'), name: 'kaputt.pdf', type: 'application/pdf' } },
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /Position 1: Die Datei kann nicht gelesen werden\./);
  assert.equal(readdirSync(t.dir).length, dateienVorher);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.cleanup();
});

test('POST kk-abgleich: a line of 0.00 is rejected', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  const res = await post(t, '1', {
    gesamtbetrag: '12.00',
    zeilen: [
      { art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' },
      { art: 'gebuehr', kontoId: t.eigen, betrag: '0.00' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /Position 2: Betrag darf nicht 0 sein\./);
  assert.equal(listSplitKinder(t.db, t.jobId).length, 0);
  t.cleanup();
});

test('POST kk-abgleich: a receipt whose file is missing on disk is a 409', async () => {
  const t = await setup();
  const b = await t.beleg('12.00', 'Einzelkauf', t.eigen);
  rmSync(getKkBelegById(t.db, b).pdf_pfad);
  const res = await post(t, '1', { gesamtbetrag: '12.00', zeilen: [{ art: 'beleg', belegId: b, kontoId: t.eigen, betrag: '12.00' }] });
  assert.equal(res.status, 409);
  assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
  t.cleanup();
});
