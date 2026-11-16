// B2, Etappe 5: Das Splitgruppen-Dokument (Basis-PDF + Belegseiten der Teile + Gruppenstempel) entsteht im PDF-Worker,
// die Datenbankarbeit bleibt im Hauptthread. Geprüft wird: Störung des Workers → Freigabe 2 des letzten Teils bleibt
// erfolgreich, die Gruppe bleibt ausstehend (keine Datei, kein Zustand), der Nachhol-Cron exportiert danach; mehrere
// gleichzeitige Finalisierungen (durch den Worker echt nebenläufig) → genau ein Export, eine Datei.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { mitPdfStoerung } from '../helpers/pdfStoerung.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, createSplitJob, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { runSplitGruppenNachholenJob } from '../../src/services/cronJobs.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../src/services/splitGruppenExport.js';

const mitMarke = async (seiten, marke) => Buffer.concat([await buildPdfFixture(seiten), Buffer.from(`\n%${marke}\n`)]);

// Elternjob (aufgesplittet) mit zwei Teilen in Freigabe 2; Teil 0 trägt eine Belegseite. `marke` kommt ins Basis-PDF.
async function setup(t, { marke = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-worker-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const parentPfad = join(dir, 'rechnung.pdf');
  writeFileSync(parentPfad, marke ? await mitMarke(['Rechnung Seite 1'], marke) : await buildPdfFixture(['Rechnung Seite 1']));
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: parentPfad });
  db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ?").run(parentId);
  const kindIds = [];
  for (let i = 0; i < 2; i++) {
    const pfad = join(dir, `teil-${i}.pdf`);
    writeFileSync(pfad, await buildPdfFixture(i === 0 ? ['Rechnung Seite 1', 'Beleg Seite 1'] : ['Rechnung Seite 1']));
    const kindId = createSplitJob(db, getJobById(db, parentId), { pdfPfad: pfad, kontoId, betrag: `${(i + 1) * 10}.00`, zugewiesenAn: '1', position: `Pos. ${i + 1}`, belegSeitenzahl: i === 0 ? 1 : null });
    createFreigabe(db, { jobId: kindId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
    db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(kindId);
    kindIds.push(kindId);
  }
  const config = { tsaTrustRequired: false, churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 's', publicBaseUrl: 'https://portal.example.org' };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => { res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null }; next(); });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.session = { personId: req.headers['x-test-person-id'] }; next(); });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config, mailer: { async sendMail() {} } }));
  return { db, app, dir, parentId, kindIds, config };
}

const freigeben = (s, kindId) => request(s.app).post(`/freigabe2/${kindId}`).set('x-test-person-id', '3').type('form').send({ interessenskonflikt: 'nein', begruendung: '' });

// Gruppendateien = final-*.pdf, die nicht das finale PDF eines Teils sind.
function gruppenDateien(s) {
  const teilDateien = new Set(s.kindIds.map((id) => getJobById(s.db, id).pdf_pfad));
  return readdirSync(s.dir).filter((f) => f.startsWith('final-') && !teilDateien.has(join(s.dir, f)));
}

function gruppenStand(s) {
  const p = getJobById(s.db, s.parentId);
  return { gruppe_pdf_pfad: p.gruppe_pdf_pfad, gruppe_final_datei_hash: p.gruppe_final_datei_hash, gruppe_freigabe_snapshot: p.gruppe_freigabe_snapshot, dateien: gruppenDateien(s) };
}

async function pruefeExportiert(s) {
  const p = getJobById(s.db, s.parentId);
  assert.ok(p.gruppe_pdf_pfad);
  const bytes = readFileSync(p.gruppe_pdf_pfad);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), p.gruppe_final_datei_hash);
  // Rechnung + eine Belegseite (Teil 0) + Gruppenstempel.
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  assert.deepEqual(gruppenDateien(s), [p.gruppe_pdf_pfad.slice(s.dir.length + 1)]);
}

test('B2 Etappe 5: Zeitlimit beim Gruppendokument → Freigabe 2 des letzten Teils erfolgreich, Gruppe bleibt ausstehend (keine Datei); Nachhol-Cron exportiert danach', async (t) => {
  const s = await setup(t, { marke: 'LANGSAM_GRUPPE' });
  assert.equal((await freigeben(s, s.kindIds[0])).status, 302);
  const vorher = gruppenStand(s);
  assert.equal(vorher.gruppe_pdf_pfad, null);

  // Der Stempel des Teils läuft normal (Teil-PDF ohne Marke), das Gruppendokument (Basis-PDF mit Marke) überschreitet das Zeitlimit.
  const res = await mitPdfStoerung('zeitlimit', () => freigeben(s, s.kindIds[1]));
  assert.equal(res.status, 302);
  assert.equal(getJobById(s.db, s.kindIds[1]).status, 'abgeschlossen');
  assert.deepEqual(gruppenStand(s), vorher, 'Gruppe ausstehend, keine Datei');

  const lauf = await runSplitGruppenNachholenJob(s.db, s.config);
  assert.equal(lauf.nachgeholt, 1);
  await pruefeExportiert(s);
});

test('B2 Etappe 5: Nachhol-Cron bei überlastetem Worker → Gruppe als fehlgeschlagen gezählt, nichts geschrieben; nächster Lauf exportiert', async (t) => {
  const s = await setup(t);
  // Beide Teile normal freigeben; der direkte Export nach dem letzten Teil wird hier (Trigger) verhindert, damit der
  // Cron die Gruppe unter Überlastung antrifft.
  assert.equal((await freigeben(s, s.kindIds[0])).status, 302);
  s.db.exec('CREATE TEMP TRIGGER kein_export BEFORE UPDATE OF gruppe_pdf_pfad ON jobs BEGIN SELECT RAISE(ABORT, \'noch nicht\'); END');
  assert.equal((await freigeben(s, s.kindIds[1])).status, 302);
  s.db.exec('DROP TRIGGER kein_export');
  const vorher = gruppenStand(s);
  assert.equal(vorher.gruppe_pdf_pfad, null);
  assert.deepEqual(vorher.dateien, []);

  const gestoert = await mitPdfStoerung('ueberlastet', () => runSplitGruppenNachholenJob(s.db, s.config));
  assert.equal(gestoert.status, 'erfolg');
  assert.equal(gestoert.fehlgeschlagen, 1);
  assert.equal(gestoert.nachgeholt, 0);
  assert.deepEqual(gruppenStand(s), vorher);

  const lauf = await runSplitGruppenNachholenJob(s.db, s.config);
  assert.equal(lauf.nachgeholt, 1);
  await pruefeExportiert(s);
});

test('B2 Etappe 5: zwei Teile schliessen Freigabe 2 gleichzeitig ab → beide erfolgreich, genau ein Gruppenexport', async (t) => {
  const s = await setup(t, { marke: 'VERZOEGERT_GRUPPE' });
  const [a, b] = await mitPdfStoerung('verzoegert', () => Promise.all([freigeben(s, s.kindIds[0]), freigeben(s, s.kindIds[1])]));
  assert.equal(a.status, 302);
  assert.equal(b.status, 302);
  for (const id of s.kindIds) assert.equal(getJobById(s.db, id).status, 'abgeschlossen');
  await pruefeExportiert(s);
});

test('B2 Etappe 5: Freigabe-2-Abschluss, Admin-Aufruf und Nachhol-Cron finalisieren dieselbe Gruppe gleichzeitig → genau ein Export, die anderen übersprungen', async (t) => {
  const s = await setup(t, { marke: 'VERZOEGERT_GRUPPE' });
  s.db.exec('CREATE TEMP TRIGGER kein_export BEFORE UPDATE OF gruppe_pdf_pfad ON jobs BEGIN SELECT RAISE(ABORT, \'noch nicht\'); END');
  for (const id of s.kindIds) assert.equal((await freigeben(s, id)).status, 302);
  s.db.exec('DROP TRIGGER kein_export');
  assert.equal(getJobById(s.db, s.parentId).gruppe_pdf_pfad, null);

  const [x, y, cron] = await mitPdfStoerung('verzoegert', () => Promise.all([
    pruefeUndFinalisiereSplitGruppe(s.db, s.parentId, s.config, { spur: 'interaktiv' }),
    pruefeUndFinalisiereSplitGruppe(s.db, s.parentId, s.config, { spur: 'interaktiv' }),
    runSplitGruppenNachholenJob(s.db, s.config),
  ]));
  assert.equal(cron.fehlgeschlagen, 0);
  const stati = [x.status, y.status, cron.nachgeholt === 1 ? 'exportiert' : 'uebersprungen'].sort();
  assert.deepEqual(stati, ['exportiert', 'uebersprungen', 'uebersprungen']);
  await pruefeExportiert(s);
});
