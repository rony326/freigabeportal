import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { openDatabase } from '../../src/db/index.js';
import { createJob, getJobById, createSplitJob, listSplitKinder } from '../../src/db/jobsRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { stampAndFinalize } from '../../src/services/pdfStamp.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../src/services/splitGruppenExport.js';
import { PDFDocument } from 'pdf-lib';

const RFC3161_RESPONSE = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));

function extractedText(pdfBytes, pageIndex) {
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    try {
      return page.toStructuredText().asText();
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function alleSeitenText(pdfBytes, seitenzahl) {
  return Array.from({ length: seitenzahl }, (_, i) => extractedText(pdfBytes, i)).join('\n');
}

// Mirrors what freigabe2.js really does when a Splitkind's own Freigabe 2 completes: it stamps
// that child's PDF in place (appending at least one Stempel-/Verlauf-Seite) BEFORE the group
// merge ever runs. Seeding children as 'abgeschlossen' without this step hides exactly the class
// of bug this file has to guard against -- a merge that cannot tell Beleg pages from a child's
// own Stempelseiten.
async function stempleKindWieFreigabe2(db, kindId) {
  const kind = getJobById(db, kindId);
  const gestempelt = await stampAndFinalize(readFileSync(kind.pdf_pfad), {
    jobId: kindId,
    konto: { nummer: '6500', bezeichnung: 'Unterhalt' },
    freigeber1: { name: 'Max Muster', identitaet: '1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null },
    freigeber2: { name: 'Erika Beispiel', identitaet: '2', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null },
    verlauf: [],
  });
  writeFileSync(kind.pdf_pfad, gestempelt);
}

async function seedGruppe(db, dir, { anzahlKinder = 2, mitBeleg = false, gestempelt = false } = {}) {
  upsertPerson(db, { id: '1', vorname: 'Max', nachname: 'Muster', email: 'max@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Erika', nachname: 'Beispiel', email: 'erika@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, {
    kontonummer: '6500',
    bezeichnung: 'Unterhalt',
    freigeber1Id: '1',
    stellvertreter1Id: '2',
    freigeber2Id: '2',
    stellvertreter2Id: '1',
  });

  const parentPdfPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: parentPdfPfad });
  const parentJob = getJobById(db, parentId);

  const kindIds = [];
  for (let i = 0; i < anzahlKinder; i++) {
    const kindPdfPfad = join(dir, `kind-${i}.pdf`);
    const hatBeleg = mitBeleg && i === 0;
    // Genau die Seitenreihenfolge, die mergeBelegFuerJob beim Aufsplitten erzeugt:
    // [Rechnungsseiten][Belegseiten] -- Stempelseiten kommen erst später obendrauf.
    const seiten = hatBeleg ? ['Rechnung Seite 1', 'Beleg Seite 1'] : ['Rechnung Seite 1'];
    writeFileSync(kindPdfPfad, await buildPdfFixture(seiten));
    const kindId = createSplitJob(db, parentJob, {
      pdfPfad: kindPdfPfad,
      kontoId,
      betrag: `${(i + 1) * 10}.00`,
      zugewiesenAn: '1',
      position: `Pos. ${i + 1}`,
      belegSeitenzahl: hatBeleg ? 1 : null,
    });
    createFreigabe(db, { jobId: kindId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: 0 });
    createFreigabe(db, { jobId: kindId, personId: '2', rolle: 'freigeber2', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: 0 });
    if (gestempelt) await stempleKindWieFreigabe2(db, kindId);
    db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kindId);
    kindIds.push(kindId);
  }

  return { parentId, kindIds };
}

test('pruefeUndFinalisiereSplitGruppe skips an incomplete group without writing anything', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId, kindIds } = await seedGruppe(db, dir, { anzahlKinder: 2 });
  db.prepare("UPDATE jobs SET status = 'zugewiesen' WHERE id = ?").run(kindIds[1]);

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'unvollstaendig');
  assert.equal(getJobById(db, parentId).gruppe_pdf_pfad, null);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe reports blockiert while a sibling is abgelehnt', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId, kindIds } = await seedGruppe(db, dir, { anzahlKinder: 2 });
  db.prepare("UPDATE jobs SET status = 'abgelehnt' WHERE id = ?").run(kindIds[1]);

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'blockiert');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe merges a complete group into one stamped PDF with every Konto and Beleg pages, without a Zeitstempel when none is configured', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  // gestempelt: true reproduces production order -- jedes Kind wurde bei seiner eigenen Freigabe 2
  // bereits einzeln gestempelt, bevor der Gruppen-Merge überhaupt läuft.
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2, mitBeleg: true, gestempelt: true });

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'exportiert');

  const parent = getJobById(db, parentId);
  assert.ok(parent.gruppe_pdf_pfad);
  assert.ok(existsSync(parent.gruppe_pdf_pfad));
  assert.equal(parent.gruppe_zeitstempel_gesetzt_am, null, 'no TSA configured, so no Zeitstempel is expected');

  const gruppenBytes = readFileSync(parent.gruppe_pdf_pfad);
  const gruppenDoc = await PDFDocument.load(gruppenBytes);
  // 1 Rechnungsseite (Elternjob) + 1 Beleg-Seite (erstes Kind) + genau 1 gemeinsame Stempelseite.
  // Die Einzel-Stempelseiten der beiden Kinder dürfen NICHT mitkopiert werden.
  assert.equal(gruppenDoc.getPageCount(), 3);

  const allText = alleSeitenText(gruppenBytes, gruppenDoc.getPageCount());
  assert.match(allText, /Beleg Seite 1/, 'die Belegseite des ersten Kindes muss im Gruppendokument enthalten sein');
  assert.match(allText, new RegExp(`Splitgruppe — Job-ID: ${parentId}`));

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the merged document carries only the combined Splitgruppen stamp — no individual child stamp page survives the merge (regression: Beleg pages were derived from a page-count delta that the per-child stamping invalidated)', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-stempel-test-'));
  const { parentId, kindIds } = await seedGruppe(db, dir, { anzahlKinder: 2, mitBeleg: true, gestempelt: true });

  // Vorbedingung: jedes Kind trägt seine eigene Stempelseite mit seiner eigenen Job-ID.
  for (const kindId of kindIds) {
    const kindBytes = readFileSync(getJobById(db, kindId).pdf_pfad);
    const kindDoc = await PDFDocument.load(kindBytes);
    assert.match(
      alleSeitenText(kindBytes, kindDoc.getPageCount()),
      new RegExp(`Job-ID: ${kindId}\\b`),
      'sanity check: das Kind wurde tatsächlich einzeln gestempelt'
    );
  }

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'exportiert');

  const gruppenBytes = readFileSync(getJobById(db, parentId).gruppe_pdf_pfad);
  const gruppenDoc = await PDFDocument.load(gruppenBytes);
  const allText = alleSeitenText(gruppenBytes, gruppenDoc.getPageCount());

  for (const kindId of kindIds) {
    assert.doesNotMatch(
      allText,
      new RegExp(`Job-ID: ${kindId}\\b`),
      `die Einzel-Stempelseite von Kind ${kindId} darf nicht im gemeinsamen Archivdokument landen`
    );
  }
  assert.match(allText, new RegExp(`Splitgruppe — Job-ID: ${parentId}`), 'nur der gemeinsame Stempel gehört hinein');
  assert.match(allText, /Beleg Seite 1/, 'der Beleg selbst muss aber sehr wohl enthalten sein');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('a child without a recorded beleg_seitenzahl contributes no extra pages at all, even after being individually stamped', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-ohne-beleg-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2, mitBeleg: false, gestempelt: true });

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'exportiert');

  const gruppenDoc = await PDFDocument.load(readFileSync(getJobById(db, parentId).gruppe_pdf_pfad));
  // 1 Rechnungsseite + 1 gemeinsame Stempelseite, sonst nichts.
  assert.equal(gruppenDoc.getPageCount(), 2);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe applies a fresh RFC3161 Zeitstempel to the merged document when a TSA is configured', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2 });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'exportiert');
  const parent = getJobById(db, parentId);
  assert.ok(parent.gruppe_zeitstempel_gesetzt_am);
  assert.match(parent.gruppe_zeitstempel_datei_hash, /^[0-9a-f]{64}$/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe returns fehler and leaves gruppe_pdf_pfad unset when the TSA is configured but unreachable', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2 });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(500, 'kaputt');

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'fehler');
  assert.equal(getJobById(db, parentId).gruppe_pdf_pfad, null);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe is a no-op once the group is already exported', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2 });

  const erster = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(erster.status, 'exportiert');
  const zweiter = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(zweiter.status, 'uebersprungen');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('two concurrent merges of the same group produce exactly one merged PDF — the loser reports uebersprungen and deletes its own orphaned file', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-race-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2, gestempelt: true });

  // Beide Aufrufe starten, bevor einer von beiden geschrieben hat -- genau das Fenster, das der
  // Frühabbruch (parent.gruppe_pdf_pfad) allein nicht schliessen kann, weil zwischen ihm und dem
  // Schreiben mehrere awaits liegen (Cron-Job vs. Freigabe-2-Abschluss in der Praxis).
  const [a, b] = await Promise.all([
    pruefeUndFinalisiereSplitGruppe(db, parentId),
    pruefeUndFinalisiereSplitGruppe(db, parentId),
  ]);

  const stati = [a.status, b.status].sort();
  assert.deepEqual(stati, ['exportiert', 'uebersprungen']);

  const parent = getJobById(db, parentId);
  assert.ok(existsSync(parent.gruppe_pdf_pfad));
  const gruppenDateien = readdirSync(dir).filter((name) => name.startsWith('gruppe-'));
  assert.equal(gruppenDateien.length, 1, 'die verlorene Datei des Race-Verlierers muss aufgeräumt sein');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the merged PDF never overwrites the parent invoice, even when the parent file has no .pdf extension', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-endung-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2, gestempelt: true });

  // Elternjob auf eine Datei ohne .pdf-Endung umbiegen (z.B. ein Upload-Name ohne Endung) --
  // die frühere Regex-Ableitung `pdf_pfad.replace(/\.pdf$/, ...)` hätte hier denselben Pfad
  // zurückgegeben und die Original-Rechnung per renameSync überschrieben.
  const parentOhneEndung = join(dir, 'parent-ohne-endung');
  writeFileSync(parentOhneEndung, await buildPdfFixture(['Rechnung Seite 1']));
  db.prepare('UPDATE jobs SET pdf_pfad = ? WHERE id = ?').run(parentOhneEndung, parentId);
  const originalBytes = readFileSync(parentOhneEndung);

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, parentId);
  assert.equal(ergebnis.status, 'exportiert');

  const parent = getJobById(db, parentId);
  assert.notEqual(parent.gruppe_pdf_pfad, parentOhneEndung);
  assert.ok(parent.gruppe_pdf_pfad.endsWith('.pdf'));
  assert.deepEqual(readFileSync(parentOhneEndung), originalBytes, 'die Original-Rechnung muss unangetastet bleiben');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
