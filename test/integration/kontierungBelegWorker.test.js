// B2, Etappe 4: «Beleg anhängen» in Kontierung, Ablehnung und Aufsplitten rechnet im PDF-Worker – und zwar BEVOR etwas
// gespeichert wird. Geprüft wird: Störung des Workers → 503 und der Vorgang bleibt unverändert; ein unlesbarer Beleg → nichts
// gespeichert; zwei gleichzeitige Kontierungen mit Beleg → genau eine gewinnt, das PDF enthält genau ihren Beleg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { buildSolidPng } from '../helpers/imageFixture.js';
import { kreditorOhneIbanPflicht } from '../helpers/kreditor.js';
import { mitPdfStoerung } from '../helpers/pdfStoerung.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById, listSplitKinder, updateKontierungMetadaten } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kontierung-beleg-worker-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kreditorId = kreditorOhneIbanPflicht(db, { name: 'Muster AG', kontoId: null });
  const pdfPfad = join(dir, 'original.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  claimJob(db, jobId, '1');
  updateKontierungMetadaten(db, jobId, { absender: 'lief@example.org', betrag: '200.00', zahlungsziel: '2026-09-01', rechnungsnummer: 'RE-1', lieferant: 'Muster AG', kreditorId: null });

  const sent = [];
  const mailer = { async sendMail(m) { sent.push(m); } };
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org', jobsDir: dir };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
  return { db, app, dir, jobId, kontoId, kreditorId, pdfPfad, sent, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// Alles, was sich bei einem abgewiesenen Versuch nicht ändern darf.
function stand(t) {
  const job = getJobById(t.db, t.jobId);
  return {
    status: job.status, konto_id: job.konto_id, betrag: job.betrag, rechnungsnummer: job.rechnungsnummer, kreditor_id: job.kreditor_id,
    zugewiesen_an: job.zugewiesen_an, beleg_seitenzahl: job.beleg_seitenzahl, typ: job.typ,
    freigaben: listFreigabenByJob(t.db, t.jobId).length,
    pdf: readFileSync(t.pdfPfad).toString('base64'),
    dateien: readdirSync(t.dir).sort(),
    splitKinder: listSplitKinder(t.db, t.jobId).length,
  };
}

function kontieren(t, beleg, { name = 'beleg.pdf', type = 'application/pdf' } = {}) {
  return request(t.app)
    .post(`/kontierung/${t.jobId}`)
    .set('x-test-person-id', '1')
    .field('kontoId', String(t.kontoId))
    .field('kreditorId', String(t.kreditorId))
    .field('absender', 'Muster AG')
    .field('rechnungsnummer', 'RE-1')
    .field('betrag', '200.00')
    .field('zahlungsziel', '2026-09-01')
    .field('interessenskonflikt', 'nein')
    .field('begruendung', '')
    .attach('beleg', beleg, { filename: name, contentType: type });
}

function ablehnen(t, beleg, { name = 'beleg.pdf', type = 'application/pdf' } = {}) {
  return request(t.app)
    .post(`/kontierung/${t.jobId}`)
    .set('x-test-person-id', '1')
    .field('aktion', 'ablehnen')
    .field('begruendung', 'Fehlerhafte Rechnung')
    .attach('beleg', beleg, { filename: name, contentType: type });
}

function aufsplitten(t, beleg) {
  return request(t.app)
    .post(`/kontierung/${t.jobId}/aufsplitten`)
    .set('x-test-person-id', '1')
    .field('kreditorId', String(t.kreditorId)).field('gesamtbetrag', '200.00')
    .field('teilKontoId', String(t.kontoId))
    .field('teilKontoId', String(t.kontoId))
    .field('teilBetrag', '120.00')
    .field('teilBetrag', '80.00')
    .attach('teilBeleg_0', beleg, { filename: 'beleg.pdf', contentType: 'application/pdf' });
}

const mitMarke = async (seiten, marke) => Buffer.concat([await buildPdfFixture(seiten), Buffer.from(`\n%${marke}\n`)]);

function pruefe503(res) {
  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '60');
  assert.match(res.text, /in einer Minute erneut/);
  assert.match(res.text, /Es wurde nichts gespeichert/);
}

test('B2 Etappe 4: Kontierung mit Beleg – Zeitlimit des Workers → 503, Vorgang, PDF und Verlauf unverändert, keine Mail', async () => {
  const t = await setup();
  try {
    const vorher = stand(t);
    const res = await mitPdfStoerung('zeitlimit', async () => kontieren(t, await mitMarke(['Quittung'], 'LANGSAM_ANHAENGEN')));
    pruefe503(res);
    assert.match(res.text, /RE-1/, 'die eingegebenen Werte bleiben im Formular');
    assert.deepEqual(stand(t), vorher);
    assert.equal(t.sent.length, 0);
  } finally {
    t.cleanup();
  }
});

test('B2 Etappe 4: Kontierung mit Beleg – überlasteter Worker → 503, nichts gespeichert', async () => {
  const t = await setup();
  try {
    const vorher = stand(t);
    const res = await mitPdfStoerung('ueberlastet', async () => kontieren(t, await buildPdfFixture(['Quittung'])));
    pruefe503(res);
    assert.deepEqual(stand(t), vorher);
    assert.equal(t.sent.length, 0);
  } finally {
    t.cleanup();
  }
});

test('B2 Etappe 4: Ablehnung mit Beleg – gestörter Worker → 503, Vorgang bleibt zugewiesen, kein Ablehnungseintrag', async () => {
  for (const art of ['zeitlimit', 'ueberlastet']) {
    const t = await setup();
    try {
      const vorher = stand(t);
      const res = await mitPdfStoerung(art, async () => ablehnen(t, await mitMarke(['Quittung'], 'LANGSAM_ANHAENGEN')));
      pruefe503(res);
      assert.deepEqual(stand(t), vorher, art);
      assert.equal(getJobById(t.db, t.jobId).status, 'zugewiesen');
    } finally {
      t.cleanup();
    }
  }
});

test('B2 Etappe 4: Aufsplitten mit Zeilen-Beleg – gestörter Worker → 503, keine Teilvorgänge, keine verwaisten Dateien', async () => {
  for (const art of ['zeitlimit', 'ueberlastet']) {
    const t = await setup();
    try {
      const vorher = stand(t);
      const res = await mitPdfStoerung(art, async () => aufsplitten(t, await mitMarke(['Quittung'], 'LANGSAM_ANHAENGEN')));
      pruefe503(res);
      assert.match(res.text, /120\.00/, 'die Zeilen bleiben im Formular');
      assert.deepEqual(stand(t), vorher, art);
      assert.equal(t.sent.length, 0);
    } finally {
      t.cleanup();
    }
  }
});

test('B2 Etappe 4: zwei gleichzeitige Kontierungen mit Beleg – genau eine gewinnt, das PDF enthält genau ihren Beleg', async () => {
  const t = await setup();
  try {
    const belegA = await mitMarke(['Beleg A'], 'VERZOEGERT_ANHAENGEN');
    const belegB = await mitMarke(['Beleg B Seite 1', 'Beleg B Seite 2'], 'VERZOEGERT_ANHAENGEN');
    const [a, b] = await mitPdfStoerung('verzoegert', () => Promise.all([kontieren(t, belegA, { name: 'a.pdf' }), kontieren(t, belegB, { name: 'b.pdf' })]));
    assert.deepEqual([a.status, b.status].sort(), [302, 409]);
    const verlierer = a.status === 409 ? a : b;
    assert.match(verlierer.text, /inzwischen bereits von einem anderen Vorgang bearbeitet/);
    const gewinnerSeiten = a.status === 302 ? 1 : 2;

    const job = getJobById(t.db, t.jobId);
    assert.equal(job.status, 'freigabe2');
    assert.equal(job.beleg_seitenzahl, gewinnerSeiten);
    const pdf = await PDFDocument.load(readFileSync(t.pdfPfad));
    assert.equal(pdf.getPageCount(), 1 + gewinnerSeiten, 'Rechnungsseite + genau ein angehängter Beleg');
    const freigaben = listFreigabenByJob(t.db, t.jobId).filter((f) => f.rolle === 'freigeber1');
    assert.equal(freigaben.length, 1, 'Freigabe 1 genau einmal protokolliert');
    assert.deepEqual(readdirSync(t.dir).filter((d) => d.endsWith('.tmp')), [], 'keine temporären Dateien zurück');
  } finally {
    t.cleanup();
  }
});

test('B2 Etappe 4: Kontierung und Ablehnung gleichzeitig mit Beleg – nur eine wird gespeichert', async () => {
  const t = await setup();
  try {
    const belegA = await mitMarke(['Beleg A'], 'VERZOEGERT_ANHAENGEN');
    const belegB = await mitMarke(['Beleg B'], 'VERZOEGERT_ANHAENGEN');
    const [a, b] = await mitPdfStoerung('verzoegert', () => Promise.all([kontieren(t, belegA, { name: 'a.pdf' }), ablehnen(t, belegB, { name: 'b.pdf' })]));
    assert.deepEqual([a.status, b.status].sort(), [302, 409]);
    const job = getJobById(t.db, t.jobId);
    assert.equal(job.status, a.status === 302 ? 'freigabe2' : 'abgelehnt');
    assert.equal(job.beleg_seitenzahl, 1);
    assert.equal((await PDFDocument.load(readFileSync(t.pdfPfad))).getPageCount(), 2);
    const rollen = listFreigabenByJob(t.db, t.jobId).map((f) => f.rolle);
    assert.equal(rollen.filter((r) => r === 'freigeber1' || r === 'ablehnung').length, 1);
  } finally {
    t.cleanup();
  }
});

test('B2 Etappe 4: Kontierung mit Beleg im Normalbetrieb – PDF zusammengeführt, beleg_seitenzahl stimmt, keine Temp-Datei', async () => {
  const t = await setup();
  try {
    const res = await kontieren(t, await buildPdfFixture(['Beleg Seite 1', 'Beleg Seite 2']));
    assert.equal(res.status, 302);
    const job = getJobById(t.db, t.jobId);
    assert.equal(job.status, 'freigabe2');
    assert.equal(job.beleg_seitenzahl, 2);
    assert.equal((await PDFDocument.load(readFileSync(t.pdfPfad))).getPageCount(), 3);
    assert.deepEqual(readdirSync(t.dir).filter((d) => d.endsWith('.tmp')), []);
  } finally {
    t.cleanup();
  }
});

// Ein PDF mit gültiger Kennung, das pdf-lib nicht lesen kann: scheiterte früher erst NACH dem COMMIT (Fehler 500, die Kontierung
// war gespeichert, der Beleg fehlte, Mails wurden keine verschickt). Jetzt: Formular mit 422, nichts gespeichert.
test('B2 Etappe 4: unlesbarer PDF-Beleg bei der Kontierung → 422 mit Hinweis, nichts gespeichert', async () => {
  const t = await setup();
  try {
    const vorher = stand(t);
    const res = await kontieren(t, Buffer.from('%PDF-1.4 kaputt'));
    assert.equal(res.status, 422);
    assert.match(res.text, /Der Beleg konnte nicht angehängt werden/);
    assert.deepEqual(stand(t), vorher);
    assert.equal(t.sent.length, 0);
  } finally {
    t.cleanup();
  }
});

// Abgeschnittenes PNG: Kopf und Masse gültig (pruefeBelegBild lässt es durch), die Bilddaten fehlen und scheitern erst in embedPng.
// (Bewusst nur Signatur + IHDR: an manchen anderen Schnittstellen hängt pdf-lib in embedPng endlos – das fängt nur das
// Zeitlimit des Workers ab, siehe Bericht zu Etappe 4.)
test('B2 Etappe 4: abgeschnittenes Bild bei der Ablehnung → 422 mit Hinweis, Vorgang bleibt zugewiesen', async () => {
  const t = await setup();
  try {
    const voll = buildSolidPng(40, 40);
    const abgeschnitten = voll.subarray(0, 33);
    const vorher = stand(t);
    const res = await ablehnen(t, abgeschnitten, { name: 'beleg.png', type: 'image/png' });
    assert.equal(res.status, 422);
    assert.match(res.text, /Der Beleg konnte nicht angehängt werden/);
    assert.deepEqual(stand(t), vorher);
  } finally {
    t.cleanup();
  }
});
