import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createJob, getJobById, createSplitJob, listSplitKinder } from '../../src/db/jobsRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { pruefeUndFinalisiereSplitGruppe } from '../../src/services/splitGruppenExport.js';
import { PDFDocument } from 'pdf-lib';

const RFC3161_RESPONSE = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));

async function seedGruppe(db, dir, { anzahlKinder = 2, mitBeleg = false } = {}) {
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
    const seiten = mitBeleg && i === 0 ? ['Rechnung Seite 1', 'Beleg Seite 1'] : ['Rechnung Seite 1'];
    writeFileSync(kindPdfPfad, await buildPdfFixture(seiten));
    const kindId = createSplitJob(db, parentJob, { pdfPfad: kindPdfPfad, kontoId, betrag: `${(i + 1) * 10}.00`, zugewiesenAn: '1', position: `Pos. ${i + 1}` });
    createFreigabe(db, { jobId: kindId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: 0 });
    createFreigabe(db, { jobId: kindId, personId: '2', rolle: 'freigeber2', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: 0 });
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

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
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

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
  assert.equal(ergebnis.status, 'blockiert');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe merges a complete group into one stamped PDF with every Konto and Beleg pages, without a Zeitstempel when none is configured', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2, mitBeleg: true });

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
  assert.equal(ergebnis.status, 'exportiert');

  const parent = getJobById(db, parentId);
  assert.ok(parent.gruppe_pdf_pfad);
  assert.ok(existsSync(parent.gruppe_pdf_pfad));
  assert.equal(parent.gruppe_zeitstempel_gesetzt_am, null, 'no TSA configured, so no Zeitstempel is expected');

  const gruppenDoc = await PDFDocument.load(readFileSync(parent.gruppe_pdf_pfad));
  // 1 Rechnungsseite (Elternjob) + 1 Beleg-Seite (erstes Kind) + mindestens 1 Stempelseite
  assert.ok(gruppenDoc.getPageCount() >= 3);

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

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
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

  const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
  assert.equal(ergebnis.status, 'fehler');
  assert.equal(getJobById(db, parentId).gruppe_pdf_pfad, null);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('pruefeUndFinalisiereSplitGruppe is a no-op once the group is already exported', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppe-test-'));
  const { parentId } = await seedGruppe(db, dir, { anzahlKinder: 2 });

  const erster = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
  assert.equal(erster.status, 'exportiert');
  const zweiter = await pruefeUndFinalisiereSplitGruppe(db, {}, parentId);
  assert.equal(zweiter.status, 'uebersprungen');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
