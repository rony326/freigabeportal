import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById, setQrDaten, updateKontierungMetadaten, createSplitJob, listSplitKinder } from '../../src/db/jobsRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { createKreditorIban } from '../../src/db/kreditorIbanRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createSpesenPosition } from '../../src/db/jobsRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { requireApiKey } from '../../src/middleware/apiKey.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { createN8nJobsRouter } from '../../src/routes/n8n/jobs.js';
import { createAltfaelleRouter } from '../../src/routes/admin/altfaelle.js';
import { listAltfaelle } from '../../src/services/altfaelle.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../src/services/splitGruppenExport.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { setzeFreigabeSnapshot } from '../helpers/freigabeSnapshot.js';
import { setupMockTsa, signedTsaResponse } from '../helpers/mockTsa.js';

const QR_IBAN = 'CH9300762011623852957';
const ANDERE_IBAN = 'CH5604835012345678009';
const CT = { baseUrl: 'https://ct.example.org', syncServiceToken: 'sync-token', customFieldIban: 'iban_1', customFieldKontoinhaber: 'kontoinhaber' };

function stampText(path) {
  const doc = mupdf.Document.openDocument(readFileSync(path), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText().asText()).join('\n');
  } finally {
    doc.destroy();
  }
}

async function setup(t) {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const dir = mkdtempSync(join(tmpdir(), 'export-integritaet-'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  // Person 20 is a Superadmin (group 20) and therefore holds workflow_eingreifen.
  upsertPerson(db, { id: '20', vorname: 'Ada', nachname: 'Admin', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const config = {
    tsaTrustRequired: false,
    jobsDir: dir,
    n8nApiKey: 'n8n-key',
    downloadSigningSecret: 'download-secret',
    publicBaseUrl: 'https://portal.example.org',
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', ...CT },
  };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Portal' };
    next();
  });
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config }));
  app.use('/admin/altfaelle', requireLogin(), createAltfaelleRouter({ db, config }));

  async function rechnung({ qr = true, typ = 'rechnung', kreditorIbans = null, betrag = '120.50', qrBetrag = '120.50', qrIban = QR_IBAN } = {}) {
    const pdfPfad = join(dir, `rechnung-${Math.random().toString(36).slice(2)}.pdf`);
    const original = await buildPdfFixture(['Rechnung Seite 1']);
    writeFileSync(pdfPfad, original);
    const id = createJob(db, { eingangAm: '2026-09-01T08:00:00.000Z', quelle: 'lieferant', absender: 'lieferant@example.org', dateiname: 'rechnung.pdf', pdfPfad });
    let kreditorId = null;
    if (kreditorIbans) {
      kreditorId = createKreditor(db, { name: 'Muster AG', kontoId });
      for (const iban of kreditorIbans) createKreditorIban(db, { kreditorId, iban });
    }
    updateKontierungMetadaten(db, id, { absender: 'lieferant@example.org', betrag, zahlungsziel: '2026-10-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', kreditorId, typ });
    if (qr) setQrDaten(db, id, { qrIban, qrReferenz: '210000000003139471430009017', qrBetrag, qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
    setKontierung(db, id, kontoId);
    createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-09-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
    db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
    return { id, pdfPfad, original, kreditorId };
  }

  const f2 = (id, body = {}) => request(app).post(`/freigabe2/${id}`).set('x-test-person-id', '3').type('form').send({ interessenskonflikt: 'nein', begruendung: '', ...body });
  const review = async (id) => {
    const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
    const match = res.text.match(/name="zahlungsdaten_stand" value="([a-f0-9]+)"/);
    return { res, stand: match ? match[1] : null };
  };
  const abholbereit = async () => (await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key')).body;
  const nachweis = (id) => request(app).get(`/api/n8n/jobs/${id}/exportnachweis`).set('X-API-Key', 'n8n-key');
  const ack = (id) => request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  const altfallSeite = (id, person = '20') => request(app).get(`/admin/altfaelle/${id}`).set('x-test-person-id', person);
  const entscheide = async (id, body, person = '20') => {
    const seite = await altfallSeite(id, person);
    const stand = seite.text.match(/name="stand" value="([a-f0-9]+)"/)?.[1];
    return request(app).post(`/admin/altfaelle/${id}`).set('x-test-person-id', person).type('form').send({ stand, bestaetigung: 'ja', ...body });
  };
  return { db, dir, app, kontoId, config, rechnung, f2, review, abholbereit, nachweis, ack, altfallSeite, entscheide };
}

// ---------------------------------------------------------------- Freigabe 2: QR invoices

test('a QR invoice shows its payment data at Freigabe 2 and cannot be approved without explicit confirmation', async (t) => {
  const s = await setup(t);
  const { id, pdfPfad, original } = await s.rechnung();
  const { res, stand } = await s.review(id);
  assert.equal(res.status, 200);
  assert.match(res.text, /Zahlungsempfaenger:<\/strong> <span class="text-break">Muster AG/);
  assert.match(res.text, new RegExp(QR_IBAN));
  assert.match(res.text, /210000000003139471430009017/);
  assert.ok(stand);

  for (const [body, status] of [
    [{}, 400],
    [{ zahlungsdaten_stand: stand }, 409],
    [{ zahlungsdaten_stand: '0'.repeat(64), zahlungsdaten_bestaetigt: 'ja' }, 409],
  ]) {
    const antwort = await s.f2(id, body);
    assert.equal(antwort.status, status);
    assert.equal(getJobById(s.db, id).status, 'freigabe2');
    assert.equal(getJobById(s.db, id).freigabe_snapshot, null);
    assert.deepEqual(readFileSync(pdfPfad), original);
  }
});

test('a confirmed QR invoice freezes payment data, prints it on the stamp page and exports it unchanged after later edits', async (t) => {
  const s = await setup(t);
  const { id } = await s.rechnung({ kreditorIbans: [QR_IBAN] });
  const { stand } = await s.review(id);
  const res = await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' });
  assert.equal(res.status, 302);
  const job = getJobById(s.db, id);
  const snapshot = JSON.parse(job.freigabe_snapshot);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.zahlung.art, 'qr_rechnung');
  assert.equal(snapshot.zahlung.abgleich, 'uebereinstimmung');
  assert.equal(snapshot.zahlung.bestaetigung.person_id, '3');
  assert.equal(snapshot.zahlung.bestaetigung.stand, stand);
  const text = stampText(job.pdf_pfad);
  assert.match(text, /Zahlungsempfänger: Muster AG/);
  assert.match(text, new RegExp(`IBAN: ${QR_IBAN}`));
  assert.match(text, /Referenz: 210000000003139471430009017/);

  // Everything below happens after Freigabe 2 and must not reach the export.
  s.db.prepare("UPDATE jobs SET qr_iban = ?, qr_creditor_name = 'Betrueger GmbH', betrag = '999.00', lieferant = 'Andere AG', typ = 'gutschrift' WHERE id = ?").run(ANDERE_IBAN, id);
  s.db.prepare("UPDATE konten SET kontonummer = '9999', bezeichnung = 'Umbenannt' WHERE id = ?").run(s.kontoId);
  s.db.prepare('DELETE FROM kreditor_ibans').run();

  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.id, id);
  assert.equal(eintrag.nachweis_status, 'snapshot');
  assert.equal(eintrag.betrag, '120.50');
  assert.equal(eintrag.typ, 'rechnung');
  assert.equal(eintrag.betrag_signiert, '120.50');
  assert.equal(eintrag.lieferant, 'Muster AG');
  assert.equal(eintrag.konto_kontonummer, '3000');
  assert.equal(eintrag.qr_iban, QR_IBAN);
  assert.deepEqual(
    { art: eintrag.zahlung.art, freigegeben: eintrag.zahlung.freigegeben, iban: eintrag.zahlung.iban, kontoinhaber: eintrag.zahlung.kontoinhaber, abgleich: eintrag.zahlung.iban_abgleich, von: eintrag.zahlung.bestaetigt_von },
    { art: 'qr_rechnung', freigegeben: true, iban: QR_IBAN, kontoinhaber: 'Muster AG', abgleich: 'uebereinstimmung', von: '3' },
  );
  const manifest = (await s.nachweis(id)).body;
  assert.equal(manifest.version, 2);
  assert.equal(manifest.nachweis_status, 'snapshot');
  assert.equal(manifest.metadaten.betrag, '120.50');
  assert.equal(manifest.zahlung.iban, QR_IBAN);
});

test('an IBAN not stored for the supplier needs a second, explicit acknowledgement', async (t) => {
  const s = await setup(t);
  const { id } = await s.rechnung({ kreditorIbans: [ANDERE_IBAN] });
  const { res, stand } = await s.review(id);
  assert.match(res.text, /fuer diesen Lieferanten nicht hinterlegt/);
  assert.match(res.text, /name="zahlungshinweise_bestaetigt"/);
  const ohne = await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' });
  assert.equal(ohne.status, 409);
  assert.equal(getJobById(s.db, id).status, 'freigabe2');
  const mit = await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja', zahlungshinweise_bestaetigt: 'ja' });
  assert.equal(mit.status, 302);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.zahlung.iban_abgleich, 'abweichung');
  assert.deepEqual(eintrag.zahlung.hinweise, ['iban_abweichung']);
  assert.equal(eintrag.zahlung.freigegeben, true);
});

test('a supplier IBAN change between review and submission invalidates the confirmation', async (t) => {
  const s = await setup(t);
  const { id, kreditorId } = await s.rechnung({ kreditorIbans: [QR_IBAN] });
  const { stand } = await s.review(id);
  s.db.prepare('DELETE FROM kreditor_ibans WHERE kreditor_id = ?').run(kreditorId);
  createKreditorIban(s.db, { kreditorId, iban: ANDERE_IBAN });
  const res = await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' });
  assert.equal(res.status, 409);
  assert.match(res.text, /geaendert/);
  assert.equal(getJobById(s.db, id).freigabe_snapshot, null);
});

test('a QR amount differing from the booked amount is flagged and must be acknowledged', async (t) => {
  const s = await setup(t);
  const { id } = await s.rechnung({ qrBetrag: '99.00' });
  const { res, stand } = await s.review(id);
  assert.match(res.text, /QR-Betrag weicht/);
  assert.equal((await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' })).status, 409);
  assert.equal((await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja', zahlungshinweise_bestaetigt: 'ja' })).status, 302);
  const snapshot = JSON.parse(getJobById(s.db, id).freigabe_snapshot);
  assert.deepEqual(snapshot.zahlung.hinweise, ['betrag_abweichung']);
});

test('invalid QR payment data is never exported as a payment order, but its manual handling must be confirmed', async (t) => {
  const s = await setup(t);
  const { id } = await s.rechnung({ qrIban: 'CH9400762011623852957' });
  const { res, stand } = await s.review(id);
  assert.match(res.text, /unvollstaendig oder ungueltig/);
  assert.equal((await s.f2(id, {})).status, 400);
  assert.equal((await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja', zahlungshinweise_bestaetigt: 'ja' })).status, 302);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.zahlung.art, 'ohne_zahlungsdaten');
  assert.equal(eintrag.zahlung.freigegeben, false);
  assert.equal(eintrag.zahlung.iban, null);
  assert.deepEqual(eintrag.zahlung.hinweise, ['qr_ungueltig']);
});

for (const [fall, optionen, art] of [
  ['a credit note, even with a QR code', { typ: 'gutschrift' }, 'keine_zahlung'],
  ['an invoice without machine-readable payment data', { qr: false }, 'ohne_zahlungsdaten'],
]) {
  test(`${fall} needs no payment confirmation and exports no payment order`, async (t) => {
    const s = await setup(t);
    const { id } = await s.rechnung(optionen);
    const { stand } = await s.review(id);
    assert.equal(stand, null);
    assert.equal((await s.f2(id, {})).status, 302);
    const [eintrag] = await s.abholbereit();
    assert.equal(eintrag.nachweis_status, 'snapshot');
    assert.equal(eintrag.zahlung.art, art);
    assert.equal(eintrag.zahlung.freigegeben, false);
    assert.equal(eintrag.zahlung.iban, null);
  });
}

test('a supplier IBAN change during the TSA request rolls the approval back instead of freezing a stale check', async (t) => {
  const s = await setup(t);
  const { id, kreditorId, pdfPfad, original } = await s.rechnung({ kreditorIbans: [QR_IBAN] });
  const { stand } = await s.review(id);
  setConfigValue(s.db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply((options) => {
    s.db.prepare('DELETE FROM kreditor_ibans WHERE kreditor_id = ?').run(kreditorId);
    createKreditorIban(s.db, { kreditorId, iban: ANDERE_IBAN });
    return { statusCode: 200, data: signedTsaResponse(options), responseOptions: { headers: { 'content-type': 'application/timestamp-reply' } } };
  });
  const res = await s.f2(id, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' });
  assert.equal(res.status, 409);
  const job = getJobById(s.db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe_snapshot, null);
  assert.equal(job.pdf_pfad, pdfPfad);
  assert.deepEqual(readFileSync(pdfPfad), original);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM freigaben WHERE job_id = ? AND rolle = 'freigeber2'").get(id).n, 0);
});

test('two concurrent Freigabe-2 submissions with the same confirmation complete the invoice exactly once', async (t) => {
  const s = await setup(t);
  const { id } = await s.rechnung();
  const { stand } = await s.review(id);
  const body = { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' };
  const results = await Promise.all([s.f2(id, body), s.f2(id, body)]);
  assert.equal(results.filter((r) => r.status === 302).length, 1);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM freigaben WHERE job_id = ? AND rolle = 'freigeber2'").get(id).n, 1);
  assert.equal(JSON.parse(getJobById(s.db, id).freigabe_snapshot).zahlung.bestaetigung.stand, stand);
});

// ---------------------------------------------------------------- split groups

async function gruppe(s, { qr = true, kinder = 2 } = {}) {
  const parentPfad = join(s.dir, `parent-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(parentPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const parentId = createJob(s.db, { eingangAm: '2026-09-01T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'gruppe.pdf', pdfPfad: parentPfad });
  updateKontierungMetadaten(s.db, parentId, { absender: null, betrag: '30.00', zahlungsziel: '2026-10-01', rechnungsnummer: 'RE-G', lieferant: 'Gruppen AG', kreditorId: null, typ: 'rechnung' });
  if (qr) setQrDaten(s.db, parentId, { qrIban: QR_IBAN, qrReferenz: '210000000003139471430009017', qrBetrag: '30.00', qrWaehrung: 'CHF', qrCreditorName: 'Gruppen AG' });
  s.db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ?").run(parentId);
  const ids = [];
  for (let i = 0; i < kinder; i++) {
    const pfad = join(s.dir, `kind-${parentId}-${i}.pdf`);
    writeFileSync(pfad, await buildPdfFixture(['Rechnung Seite 1']));
    const kind = createSplitJob(s.db, getJobById(s.db, parentId), { pdfPfad: pfad, kontoId: s.kontoId, betrag: i === 0 ? '10.00' : '20.00', zugewiesenAn: '1', position: `Pos. ${i + 1}` });
    createFreigabe(s.db, { jobId: kind, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-09-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
    s.db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(kind);
    ids.push(kind);
  }
  return { parentId, kinder: ids };
}

test('every split child confirms the whole invoice payment; the group snapshot binds PDF and export', async (t) => {
  const s = await setup(t);
  const { parentId, kinder } = await gruppe(s);
  for (const kind of kinder) {
    const { res, stand } = await s.review(kind);
    assert.match(res.text, /Gruppen AG/);
    assert.equal((await s.f2(kind, { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' })).status, 302);
  }
  const parent = getJobById(s.db, parentId);
  assert.ok(parent.gruppe_pdf_pfad);
  const snapshot = JSON.parse(parent.gruppe_freigabe_snapshot);
  assert.equal(snapshot.nachweis_status, 'snapshot');
  assert.equal(snapshot.zahlung.bestaetigungen.length, 2);
  assert.deepEqual(snapshot.positionen.map((p) => p.betrag), ['10.00', '20.00']);

  s.db.prepare("UPDATE jobs SET betrag = '77.00', typ = 'gutschrift' WHERE id = ?").run(kinder[0]);
  s.db.prepare("UPDATE konten SET kontonummer = '9999' WHERE id = ?").run(s.kontoId);
  const eintrag = (await s.abholbereit()).find((e) => e.id === parentId);
  assert.equal(eintrag.nachweis_status, 'snapshot');
  assert.deepEqual(eintrag.positionen.map((p) => [p.job_id, p.betrag, p.betrag_signiert, p.konto_kontonummer]), [[kinder[0], '10.00', '10.00', '3000'], [kinder[1], '20.00', '20.00', '3000']]);
  assert.equal(eintrag.zahlung.art, 'qr_rechnung');
  assert.equal(eintrag.zahlung.freigegeben, true);
  const manifest = (await s.nachweis(parentId)).body;
  assert.deepEqual(manifest.positionen.map((p) => p.job_id), kinder);
  assert.ok(manifest.positionen.every((p) => /^[a-f0-9]{64}$/.test(p.datei_sha256)));
  assert.throws(() => s.db.prepare('UPDATE jobs SET gruppe_freigabe_snapshot = NULL WHERE id = ?').run(parentId), /unveraenderlich/);
  assert.throws(() => s.db.prepare("UPDATE jobs SET gruppe_freigabe_snapshot = '{}' WHERE id = ?").run(parentId), /unveraenderlich/);
});

test('a split child whose QR data differs from the whole invoice cannot be approved', async (t) => {
  const s = await setup(t);
  const { kinder } = await gruppe(s);
  s.db.prepare('UPDATE jobs SET qr_iban = ? WHERE id = ?').run(ANDERE_IBAN, kinder[0]);
  const res = await s.f2(kinder[0], { zahlungsdaten_bestaetigt: 'ja' });
  assert.equal(res.status, 400);
  assert.match(res.text, /weichen von der Gesamtrechnung ab/);
  assert.equal(getJobById(s.db, kinder[0]).status, 'freigabe2');
});

test('a group with an unconfirmed legacy child is not finalized and is listed as Altfall until decided', async (t) => {
  const s = await setup(t);
  const { parentId, kinder } = await gruppe(s);
  const { stand } = await s.review(kinder[0]);
  assert.equal((await s.f2(kinder[0], { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' })).status, 302);
  // Legacy: the second child was completed before this package, without a payment confirmation.
  s.db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kinder[1]);
  setzeFreigabeSnapshot(s.db, kinder[1], { bestaetigt: false });
  const ergebnis = await pruefeUndFinalisiereSplitGruppe(s.db, parentId, s.config);
  assert.equal(ergebnis.status, 'nachpruefung');
  assert.equal(getJobById(s.db, parentId).gruppe_pdf_pfad, null);
  assert.deepEqual(listAltfaelle(s.db).map((f) => [f.job.id, f.gruppe]), [[parentId, true]]);

  const seite = await s.altfallSeite(parentId);
  assert.equal(seite.status, 200);
  assert.match(seite.text, /QR-Scan beim Eingang/);
  const res = await s.entscheide(parentId, { entscheidung: 'nachbestaetigt', begruendung: 'Zahlung gegen Originalrechnung geprueft.' });
  assert.equal(res.status, 302);
  const parent = getJobById(s.db, parentId);
  assert.ok(parent.gruppe_pdf_pfad, 'the decision triggers the group finalization');
  const snapshot = JSON.parse(parent.gruppe_freigabe_snapshot);
  assert.equal(snapshot.nachweis_status, 'altfall_nachbestaetigt');
  const eintrag = (await s.abholbereit()).find((e) => e.id === parentId);
  assert.equal(eintrag.nachweis_status, 'altfall_nachbestaetigt');
  assert.equal(eintrag.zahlung.freigegeben, true);
  assert.equal(eintrag.zahlung.bestaetigt_von, '20');
  assert.deepEqual(listAltfaelle(s.db), []);
});

// ---------------------------------------------------------------- legacy single receipts

async function altRechnung(s, { status = 'abgeschlossen' } = {}) {
  const { id } = await s.rechnung();
  s.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  return id;
}

test('a legacy invoice without snapshot is blocked everywhere until an explicit, immutable decision', async (t) => {
  const s = await setup(t);
  const id = await altRechnung(s);
  assert.deepEqual(await s.abholbereit(), []);
  assert.equal(getJobById(s.db, id).fetched_by_n8n_at, null);
  assert.equal((await s.ack(id)).status, 409);
  assert.equal((await s.nachweis(id)).status, 409);
  assert.deepEqual(listAltfaelle(s.db).map((f) => f.job.id), [id]);

  const seite = await s.altfallSeite(id);
  assert.match(seite.text, /aktueller Jobdatensatz \(nicht freigabegebunden\)/);
  assert.match(seite.text, /aktueller Kontenstamm/);
  // Missing confirmation, missing reason and a stale state are all rejected without effect.
  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: 'x', bestaetigung: '' })).status, 400);
  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: '   ' })).status, 400);
  assert.equal((await s.entscheide(id, { entscheidung: 'irgendwas', begruendung: 'x' })).status, 400);
  const stale = await s.altfallSeite(id);
  const staleStand = stale.text.match(/name="stand" value="([a-f0-9]+)"/)[1];
  s.db.prepare("UPDATE jobs SET qr_creditor_name = 'Geaendert AG' WHERE id = ?").run(id);
  const veraltet = await request(s.app).post(`/admin/altfaelle/${id}`).set('x-test-person-id', '20').type('form')
    .send({ stand: staleStand, bestaetigung: 'ja', entscheidung: 'nachbestaetigt', begruendung: 'geprueft' });
  assert.equal(veraltet.status, 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM altfall_entscheidungen').get().n, 0);

  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: 'Mit Originalbeleg abgeglichen.' })).status, 302);
  const row = s.db.prepare('SELECT * FROM altfall_entscheidungen WHERE job_id = ?').get(id);
  assert.equal(row.person_id, '20');
  assert.equal(JSON.parse(row.angezeigte_daten).herkunft.metadaten, 'jobdatensatz');
  assert.throws(() => s.db.prepare("UPDATE altfall_entscheidungen SET entscheidung = 'nur_archiv'").run(), /unveraenderlich/);
  assert.throws(() => s.db.prepare('DELETE FROM altfall_entscheidungen').run(), /unveraenderlich/);
  assert.equal((await s.altfallSeite(id)).status, 404);

  s.db.prepare("UPDATE jobs SET qr_creditor_name = 'Spaeter AG', betrag = '1.00' WHERE id = ?").run(id);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.nachweis_status, 'altfall_nachbestaetigt');
  assert.equal(eintrag.betrag, '120.50');
  assert.equal(eintrag.zahlung.kontoinhaber, 'Geaendert AG');
  assert.equal(eintrag.zahlung.herkunft, 'altfall_nachbestaetigt');
  assert.equal(eintrag.altfall.person_id, '20');
});

test('two concurrent Altfall decisions store exactly one', async (t) => {
  const s = await setup(t);
  const id = await altRechnung(s);
  const seite = await s.altfallSeite(id);
  const stand = seite.text.match(/name="stand" value="([a-f0-9]+)"/)[1];
  const post = (entscheidung) => request(s.app).post(`/admin/altfaelle/${id}`).set('x-test-person-id', '20').type('form')
    .send({ stand, bestaetigung: 'ja', entscheidung, begruendung: 'parallel' });
  const results = await Promise.all([post('nachbestaetigt'), post('nur_archiv')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [302, 409]);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM altfall_entscheidungen').get().n, 1);
});

test('a version-1 QR snapshot without payment confirmation is blocked; archive-only never releases a payment', async (t) => {
  const s = await setup(t);
  const id = await altRechnung(s);
  const job = getJobById(s.db, id);
  s.db.prepare('UPDATE jobs SET freigabe_snapshot = ? WHERE id = ?').run(JSON.stringify({ version: 1, job, konto: { id: s.kontoId, kontonummer: '3000', bezeichnung: 'Unterhalt' }, zahlungsdaten: null, zahlungsdaten_bestaetigung: null }), id);
  assert.deepEqual(await s.abholbereit(), []);
  const seite = await s.altfallSeite(id);
  assert.match(seite.text, /Freigabe-Snapshot, damals nicht bestätigt/);
  assert.equal((await s.entscheide(id, { entscheidung: 'nur_archiv', begruendung: 'Bereits manuell bezahlt.' })).status, 302);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.nachweis_status, 'altfall_nur_archiv');
  assert.equal(eintrag.konto_kontonummer, '3000');
  assert.equal(eintrag.zahlung.freigegeben, false);
  assert.equal(eintrag.zahlung.herkunft, 'altfall_nur_archiv');
});

async function altSpesen(s) {
  upsertPerson(s.db, { id: '60', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [], loggedInNow: false });
  const pdfPfad = join(s.dir, 'spesen.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Quittung']));
  const id = createSpesenPosition(s.db, {
    eingangAm: '2026-09-01T08:00:00.000Z', eingereichtVon: '60', kontoId: s.kontoId, betrag: '42.00', auslageDatum: '2026-08-30',
    beschreibung: 'Taxi', dateiname: 'taxi.pdf', pdfPfad, thumbnailPfad: null,
    spesenabrechnungId: createSpesenabrechnung(s.db, { eingereichtVon: '60', eingereichtAm: '2026-09-01T08:00:00.000Z', titel: null }),
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  s.db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  return id;
}

test('legacy Spesen are never filled from ChurchTools silently; without data only archive-only is allowed', async (t) => {
  const s = await setup(t);
  const id = await altSpesen(s);
  const client = setupMockChurchTools(CT.baseUrl);
  client.intercept({ path: '/api/persons/60', method: 'GET' }).reply(500, {}).times(4);
  const seite = await s.altfallSeite(id);
  assert.match(seite.text, /nicht abrufbar oder ungueltig/);
  assert.match(seite.text, /id="nachbestaetigt"[^>]*disabled/);
  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: 'x' })).status, 400);
  assert.equal((await s.entscheide(id, { entscheidung: 'nur_archiv', begruendung: 'Ausserhalb des Portals erstattet.' })).status, 302);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.nachweis_status, 'altfall_nur_archiv');
  assert.equal(eintrag.iban, null);
  assert.equal(eintrag.zahlung.freigegeben, false);
});

test('a current ChurchTools IBAN for legacy Spesen is labelled as such and only used after explicit confirmation', async (t) => {
  const s = await setup(t);
  const id = await altSpesen(s);
  const client = setupMockChurchTools(CT.baseUrl);
  client.intercept({ path: '/api/persons/60', method: 'GET' }).reply(200, { data: { id: 60, iban_1: QR_IBAN, kontoinhaber: 'Ein Reicher' } }).times(10);
  const seite = await s.altfallSeite(id);
  assert.match(seite.text, /AKTUELLER ChurchTools-Stand, nicht der historische Freigabestand/);
  // Before the decision nothing is exported, although the current master data is available.
  assert.deepEqual(await s.abholbereit(), []);
  // The submitter may not confirm their own reimbursement.
  upsertPerson(s.db, { id: '60', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: ['20'], loggedInNow: true });
  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: 'selbst' }, '60')).status, 403);
  assert.equal((await s.entscheide(id, { entscheidung: 'nachbestaetigt', begruendung: 'IBAN telefonisch bestaetigt.' })).status, 302);
  const [eintrag] = await s.abholbereit();
  assert.equal(eintrag.iban, QR_IBAN);
  assert.equal(eintrag.zahlung.freigegeben, true);
  assert.equal(eintrag.altfall.herkunft.zahlung, 'churchtools_aktuell');
});

test('an already transported legacy receipt stays archivable but only with marked, unbound data and no payment release', async (t) => {
  const s = await setup(t);
  const id = await altRechnung(s, { status: 'abgeholt' });
  assert.deepEqual(listAltfaelle(s.db), []);
  const res = await s.nachweis(id);
  assert.equal(res.status, 200);
  assert.equal(res.body.nachweis_status, 'historisch_unvollstaendig');
  assert.equal(res.body.archiv_ohne_zahlung, true);
  assert.equal(res.body.metadaten.lieferant, undefined);
  assert.equal(res.body.unbelegte_jobdaten.lieferant, 'Muster AG');
  assert.match(res.body.unbelegte_jobdaten.hinweis, /nicht durch eine Freigabe belegt/);
  assert.equal(res.body.zahlung.freigegeben, false);
  assert.equal(res.body.zahlung.iban, null);
});

test('an Altfall decision and a split child approval do not leak across groups', async (t) => {
  const s = await setup(t);
  const { parentId, kinder } = await gruppe(s, { kinder: 1 });
  const einzel = await altRechnung(s);
  assert.deepEqual(listAltfaelle(s.db).map((f) => f.job.id), [einzel]);
  const { stand } = await s.review(kinder[0]);
  assert.equal((await s.f2(kinder[0], { zahlungsdaten_stand: stand, zahlungsdaten_bestaetigt: 'ja' })).status, 302);
  assert.equal(JSON.parse(getJobById(s.db, parentId).gruppe_freigabe_snapshot).nachweis_status, 'snapshot');
  assert.equal(listSplitKinder(s.db, parentId).length, 1);
  assert.deepEqual(listAltfaelle(s.db).map((f) => f.job.id), [einzel]);
});
