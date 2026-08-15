# Sub-Phase D3 – Ablehnung/Rückweg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Freigeber 2 an "Ablehnen" action on the Freigabe-2 page that sends a job back to its Kontierung owner with a visible reason, lets that owner reopen and resubmit it through the existing Kontierung/Freigabe-1/Freigabe-2 flow, and makes every rejection — across as many rework cycles as happen — permanently visible on the final stamped PDF.

**Architecture:** Reuses D2's established routing, transaction, and access-control patterns exactly. Adds one new job status transition (`freigabe2` → `abgelehnt` → `zugewiesen`), one new `freigaben.rolle` value (`'ablehnung'`) so rejections live in the same ordered audit table as approvals, one new route pair (`/abgelehnt/:id`), and extends D1's `stampAndFinalize` to render the full ordered history (not just the two final approvals) on appended pages. No email is sent — rejected jobs are discoverable purely via a third "Meine abgelehnten Jobs" section on the existing Pool page.

**Tech Stack:** Same as Phases A–D2 — Node.js/Express, `node:sqlite` (`DatabaseSync`), EJS views, `pdf-lib` for stamping, `mupdf` for test verification, `supertest`/real in-memory SQLite/real PDF fixtures for tests.

**Spec:** `docs/superpowers/specs/2026-08-15-phase-d3-ablehnung-rueckweg-design.md`

## Global Constraints

- `node:sqlite`'s `DatabaseSync` only — never better-sqlite3.
- Real HTTP via `supertest`, real in-memory SQLite, real PDF fixtures via `test/helpers/pdfFixture.js`'s `buildPdfFixture`. No mocking of this project's own business logic.
- All user-facing text and error messages in German, matching each file's existing copy style.
- Every multi-write DB operation runs inside `db.exec('BEGIN')` / try-COMMIT / catch-ROLLBACK-rethrow, matching the existing pattern in `src/routes/kontierung.js` and `src/routes/freigabe2.js`.
- Any DB function whose route has an `await` between its authorization/status check and its write needs an explicit `WHERE status = ...` guard with a boolean return (see `abschliessenFreigabe2` for the established pattern). A function called only from a fully synchronous handler needs no such guard (see the comment above `setKontierung` in `src/db/jobsRepo.js`).
- Schema changes are made in place inside `CREATE TABLE IF NOT EXISTS` (no live database exists yet; this matches the accepted precedent from D1/D2 — see `progress.md`'s rulings on D2's PR).

---

### Task 1: Datenmodell — Ablehnungs-Status und Repo-Funktionen

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: nothing new — reuses `openDatabase`, `upsertPerson`, `createKonto`, `createJob`, `claimJob`, `setKontierung`, `eskalierenFreigabe2`, `abschliessenFreigabe2` (all pre-existing).
- Produces (for later tasks):
  - `ablehnenJob(db, jobId, { abgelehntVon, grund })` → `boolean`
  - `wiederOeffnenJob(db, jobId, personId)` → `boolean`
  - `listAbgelehntJobsForPerson(db, personId)` → `Array<job row>`

- [ ] **Step 1: Write the failing tests**

Open `test/unit/jobsRepo.test.js`. Add `ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson` to the existing import from `'../../src/db/jobsRepo.js'` (append to the existing destructured list on line 7). Then append these tests at the end of the file:

```javascript
test('ablehnenJob sets status to abgelehnt with the rejection reason when the job is in freigabe2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  const result = ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '3');
  assert.equal(job.ablehnungsgrund, 'Falsches Konto');
  db.close();
});

test('ablehnenJob refuses to reject a job that is not in freigabe2', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const result = ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'zu spät' });
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');
  db.close();
});

test('wiederOeffnenJob resets an abgelehnt job to zugewiesen and clears the rejection fields', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const result = wiederOeffnenJob(db, jobId, '1');
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.abgelehnt_von, null);
  assert.equal(job.ablehnungsgrund, null);
  assert.equal(job.konto_id, kontoId, 'konto_id must survive a reopen so the Kontierung form stays pre-filled');
  db.close();
});

test('wiederOeffnenJob refuses to reopen a job for someone other than zugewiesen_an', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const result = wiederOeffnenJob(db, jobId, '2');
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');
  db.close();
});

test('wiederOeffnenJob refuses to reopen a job that is not abgelehnt', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const result = wiederOeffnenJob(db, jobId, '1');
  assert.equal(result, false);
  db.close();
});

test('listAbgelehntJobsForPerson returns only abgelehnt jobs assigned to that person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  claimJob(db, otherJobId, '1');

  const rows = listAbgelehntJobsForPerson(db, '1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, jobId);
  assert.equal(listAbgelehntJobsForPerson(db, '2').length, 0);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `ablehnenJob is not defined` (or similar, since the functions and the import don't exist yet).

- [ ] **Step 3: Widen the `freigaben.rolle` CHECK constraint isn't needed here — that's Task 3's concern (Task 1 only touches `jobs`).** Add the three functions to `src/db/jobsRepo.js`. Insert them directly after `releaseJob` (after line 152, before `listZugewiesenJobsForPerson`).

First, update the existing precedent comment above `setKontierung` (lines 104–109) — `ablehnenJob` also carries a `WHERE status = 'freigabe2'` guard even though its own call site in `src/routes/freigabe2.js` (Task 3) has no `await` before calling it, so the comment's "abschliessenFreigabe2 is the one exception" claim needs to become accurate again. Replace those lines with:

```javascript
// setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, and eskalierenFreigabe2 need no
// WHERE-status guard: every route that calls them is a fully synchronous handler with no
// `await` between its authorization/status check and COMMIT, so node:sqlite's synchronous
// execution rules out interleaving with another request. abschliessenFreigabe2 is guarded
// because its route awaits stampAndFinalize before completing. ablehnenJob is guarded too,
// even though its own route path has no such await — it mirrors abschliessenFreigabe2's
// "terminal transition with an honest boolean result" semantics rather than assuming success,
// and costs nothing to keep consistent.
```

Then add the three new functions:

```javascript
export function ablehnenJob(db, jobId, { abgelehntVon, grund }) {
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'abgelehnt', abgelehnt_von = ?, ablehnungsgrund = ? WHERE id = ? AND status = 'freigabe2'"
    )
    .run(abgelehntVon, grund, jobId);
  return result.changes > 0;
}

export function wiederOeffnenJob(db, jobId, personId) {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'zugewiesen', abgelehnt_von = NULL, ablehnungsgrund = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'abgelehnt'`
    )
    .run(jobId, personId);
  return result.changes > 0;
}

export function listAbgelehntJobsForPerson(db, personId) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgelehnt' AND zugewiesen_an = ? ORDER BY eingang_am").all(personId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS (all tests in the file, including the 6 new ones).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, 233 previous + 6 new = 239.

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add ablehnenJob/wiederOeffnenJob/listAbgelehntJobsForPerson"
```

---

### Task 2: Audit-Trail-Stempelung — `stampAndFinalize` erweitern

**Files:**
- Modify: `src/services/pdfStamp.js`
- Modify: `test/unit/pdfStamp.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (for Task 3): `stampAndFinalize(pdfBuffer, stampData, visumSeitePosition)` where `stampData` now has a third field `verlauf: Array<{ rolleLabel, name, identitaet, zeitpunkt, ip, interessenskonflikt, kommentar }>` in addition to the pre-existing `freigeber1`/`freigeber2`.

**Design notes for the implementer:** `freigeber1`/`freigeber2` are drawn exactly as today (unchanged `drawFreigabeBlock` calls at y=650/y=450 on the Visum page). `verlauf` is rendered as a compact log — one-to-two lines per entry — always on new page(s) appended after all of the document's existing pages (independent of `visumSeitePosition`), so it never shares coordinate space with the two primary blocks. Each entry's first line: `"${formatZeitpunkt(entry.zeitpunkt)} — ${entry.rolleLabel} — ${entry.name} (${entry.identitaet})${entry.interessenskonflikt ? ' [Interessenskonflikt]' : ''}"`. A second, indented line only when `entry.kommentar` is truthy: `"   Kommentar: ${entry.kommentar}"`. Pages are letter-sized to match `buildPdfFixture`'s `[595, 842]` convention used throughout this project's tests (use the existing Visum page's actual dimensions via `page.getSize()` so real invoice PDFs of any page size are matched correctly, not a hardcoded constant). Start each Verlauf page at `y = pageHeight - 50`, one entry's lines advancing `y` by 14pt each, stop adding lines to the current page once `y` would go below 40 and start a fresh page instead.

- [ ] **Step 1: Write the failing tests**

Replace `test/unit/pdfStamp.test.js`'s `sampleStampData()` helper (lines 8–13) with a version that includes `verlauf`, and add new tests. Here is the complete new file content:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { stampAndFinalize } from '../../src/services/pdfStamp.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function sampleFreigeber1() {
  return { name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null };
}

function sampleFreigeber2() {
  return { name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' };
}

function sampleVerlauf() {
  return [
    { rolleLabel: 'Freigabe 1', name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' },
  ];
}

function sampleStampData() {
  return { freigeber1: sampleFreigeber1(), freigeber2: sampleFreigeber2(), verlauf: sampleVerlauf() };
}

// Same fixture shape used as PDF_BYTES in test/integration/n8n/jobs.test.js: pdf-lib's
// PDFDocument.load() parses this leniently and succeeds, but it is not a real, usable PDF.
const NOT_REALLY_A_PDF = Buffer.from('%PDF-1.4\n%test-fixture-not-a-real-pdf-body\n');

function extractedText(stampedBytes, pageIndex) {
  const doc = mupdf.Document.openDocument(stampedBytes, 'application/pdf');
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

test('stamps the last page when visumSeitePosition is "letzte", appends one Verlauf page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'letzte');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 4, 'original 3 pages + 1 appended Verlauf page');

  const text = extractedText(stamped, 2);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
  assert.match(text, /Interessenskonflikt: Nein/);
  assert.match(text, /Interessenskonflikt: Ja/);
  assert.match(text, /Verwandtschaft mit Lieferant/);
});

test('stamps the first page when visumSeitePosition is "erste", still appends the Verlauf page at the end', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'erste');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 4);

  const text = extractedText(stamped, 0);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);

  const verlaufText = extractedText(stamped, 3);
  assert.match(verlaufText, /Freigabe 1/);
  assert.match(verlaufText, /Freigabe 2/);
});

test('Verlauf page lists every entry with its rolleLabel, name, and kommentar', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.verlauf = [
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Abgelehnt', name: 'Peter Zweit', identitaet: 'ct-2', zeitpunkt: '2026-08-02T08:00:00.000Z', ip: '2.2.2.2', interessenskonflikt: false, kommentar: 'Falsches Konto' },
    { rolleLabel: 'Freigabe 1', name: 'Hans Erst', identitaet: 'ct-1', zeitpunkt: '2026-08-03T08:00:00.000Z', ip: '1.1.1.1', interessenskonflikt: false, kommentar: null },
    { rolleLabel: 'Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-04T08:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null },
  ];

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const reloaded = await PDFDocument.load(stamped);
  const verlaufText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(verlaufText, /Hans Erst/);
  assert.match(verlaufText, /Peter Zweit/);
  assert.match(verlaufText, /Abgelehnt/);
  assert.match(verlaufText, /Falsches Konto/);
});

test('Verlauf longer than one page spills onto an additional appended page', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  // 60 two-line entries is comfortably more than fits on one page at 14pt line height
  // starting at y = pageHeight - 50 with a y >= 40 cutoff (about 55 lines per page).
  stampData.verlauf = Array.from({ length: 60 }, (_, i) => ({
    rolleLabel: 'Freigabe 1',
    name: `Person ${i}`,
    identitaet: `ct-${i}`,
    zeitpunkt: '2026-08-15T08:30:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: false,
    kommentar: `Zeile ${i}`,
  }));

  const stamped = await stampAndFinalize(pdf, stampData, 'letzte');
  const reloaded = await PDFDocument.load(stamped);
  assert.ok(reloaded.getPageCount() >= 4, `expected at least 2 Verlauf pages beyond the original 2, got ${reloaded.getPageCount()} total pages`);

  const lastPageText = extractedText(stamped, reloaded.getPageCount() - 1);
  assert.match(lastPageText, /Person 59/, 'the final entry must appear on the last page, proving nothing was silently dropped');
});

test('throws a German-message Error for a PDF that cannot be loaded', async () => {
  await assert.rejects(
    () => stampAndFinalize(Buffer.alloc(0), sampleStampData(), 'letzte'),
    /PDF konnte nicht geladen werden/
  );
});

test('throws a German-message Error (not a raw TypeError) for a PDF that loads leniently but has no real page tree', async () => {
  await assert.rejects(
    () => stampAndFinalize(NOT_REALLY_A_PDF, sampleStampData(), 'letzte'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});

test('throws a German-message Error (not a raw pdf-lib WinAnsi error) when stamp text contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.freigeber2.kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData, 'letzte'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /WinAnsi/);
      assert.match(err.message, /PDF konnte nicht gestempelt werden/);
      return true;
    }
  );
});

test('throws a German-message Error when a Verlauf entry contains non-WinAnsi characters', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const stampData = sampleStampData();
  stampData.verlauf[0].kommentar = '😀 nicht darstellbar';

  await assert.rejects(
    () => stampAndFinalize(pdf, stampData, 'letzte'),
    /PDF konnte nicht gestempelt werden/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: FAIL — page count assertions fail (still 3, not 4) since `verlauf` isn't rendered yet.

- [ ] **Step 3: Implement the Verlauf rendering**

Replace `src/services/pdfStamp.js` in full:

```javascript
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const VERLAUF_LINE_HEIGHT = 14;
const VERLAUF_BOTTOM_MARGIN = 40;
const VERLAUF_TOP_MARGIN = 50;

function formatZeitpunkt(isoUtc) {
  return new Date(isoUtc).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
}

function drawFreigabeBlock(page, font, freigabe, startY) {
  const lines = [
    `${freigabe.name} (${freigabe.identitaet})`,
    `Zeitpunkt: ${formatZeitpunkt(freigabe.zeitpunkt)}`,
    `IP: ${freigabe.ip}`,
    `Interessenskonflikt: ${freigabe.interessenskonflikt ? 'Ja' : 'Nein'}`,
  ];
  if (freigabe.kommentar) {
    lines.push(`Kommentar: ${freigabe.kommentar}`);
  }
  lines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: startY - index * 14, size: 10, font, color: rgb(0, 0, 0) });
  });
}

function verlaufEntryLines(entry) {
  const lines = [
    `${formatZeitpunkt(entry.zeitpunkt)} — ${entry.rolleLabel} — ${entry.name} (${entry.identitaet})${entry.interessenskonflikt ? ' [Interessenskonflikt]' : ''}`,
  ];
  if (entry.kommentar) {
    lines.push(`   Kommentar: ${entry.kommentar}`);
  }
  return lines;
}

function drawVerlauf(doc, font, verlauf, pageWidth, pageHeight) {
  const allLines = verlauf.flatMap(verlaufEntryLines);

  let page = doc.addPage([pageWidth, pageHeight]);
  page.drawText('Verlauf', { x: 60, y: pageHeight - VERLAUF_TOP_MARGIN + 20, size: 12, font, color: rgb(0, 0, 0) });
  let y = pageHeight - VERLAUF_TOP_MARGIN;

  for (const line of allLines) {
    if (y < VERLAUF_BOTTOM_MARGIN) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - VERLAUF_TOP_MARGIN;
    }
    page.drawText(line, { x: 60, y, size: 9, font, color: rgb(0, 0, 0) });
    y -= VERLAUF_LINE_HEIGHT;
  }
}

export async function stampAndFinalize(pdfBuffer, stampData, visumSeitePosition) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  // Everything below is guarded by a single catch: pdf-lib's load() parses leniently and can
  // succeed on a file that is not really usable (e.g. only a "%PDF" header with garbage after
  // it), with the real failure only surfacing on getPages()/save(). Text drawn with the
  // Helvetica standard font is also limited to WinAnsi and throws if any of the stamped or
  // Verlauf text contains characters outside that set (emoji, Cyrillic, Greek, ...).
  // All of these are "this PDF could not be stamped" to a caller, so they share one
  // German-language error rather than leaking pdf-lib's raw English exception.
  try {
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
    }

    const visumPage = visumSeitePosition === 'erste' ? pages[0] : pages[pages.length - 1];
    const font = await doc.embedFont(StandardFonts.Helvetica);

    drawFreigabeBlock(visumPage, font, stampData.freigeber1, 650);
    drawFreigabeBlock(visumPage, font, stampData.freigeber2, 450);

    const { width, height } = visumPage.getSize();
    drawVerlauf(doc, font, stampData.verlauf, width, height);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Update the D2 end-to-end test's now-stale assumption**

`test/integration/freigabeWorkflowEndToEnd.test.js` calls `stampAndFinalize` indirectly through `src/routes/freigabe2.js`, which Task 3 will update to build `verlauf` — this existing test does not need direct edits in this task (Task 3 owns that route change), but re-run the full suite now to confirm nothing else broke:

Run: `node --test 'test/**/*.test.js'`
Expected: `test/integration/freigabeWorkflowEndToEnd.test.js` and `test/integration/freigabe2.test.js` will FAIL at this point, because `src/routes/freigabe2.js` still calls `stampAndFinalize` with the old two-field `stampData` — `stampData.verlauf` is `undefined`, so `verlauf.flatMap` throws. **This is expected and will be fixed in Task 3.** Confirm the failures are exactly in those two files and nowhere else (all of Task 1's and Task 2's own tests pass).

- [ ] **Step 6: Commit**

```bash
git add src/services/pdfStamp.js test/unit/pdfStamp.test.js
git commit -m "feat: render full Verlauf audit trail in stampAndFinalize"
```

---

### Task 3: Freigabe 2 — Ablehnen-Aktion, `.findLast`-Fix, `verlauf` verdrahten

**Files:**
- Modify: `src/routes/freigabe2.js`
- Modify: `views/freigabe2.ejs`
- Modify: `test/integration/freigabe2.test.js`
- Modify: `test/integration/freigabeWorkflowEndToEnd.test.js`

**Interfaces:**
- Consumes: `ablehnenJob` (Task 1), `stampAndFinalize`'s new `verlauf`-aware signature (Task 2), pre-existing `listFreigabenByJob`, `getPersonById`.
- Produces: nothing new consumed by later tasks (Task 4/5 don't touch this file).

This task also fixes a real latent bug in already-merged D2 code: `freigaben.find(f => f.rolle === 'freigeber1')` picks the *first* matching row. After Task 4 lets a job get rejected and reworked, a job can accumulate a second (or third) `freigeber1` row from a later Kontierung cycle — `.find()` would then display and stamp the stale, superseded approval instead of the current one. This task changes both call sites to `.findLast()`, which is correct today (exactly one match, so `.find`/`.findLast` behave identically) and becomes load-bearing once rework cycles exist.

- [ ] **Step 1: Write the failing tests**

Add these tests to `test/integration/freigabe2.test.js`. First, add `ablehnenJob` to the existing import from `'../../src/db/jobsRepo.js'` (append to the destructured list on line 9), then append at the end of the file:

```javascript
test('POST /freigabe2/:id with aktion=ablehnen and a Begründung rejects the job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-ablehnen-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.abgelehnt_von, '3');
  assert.equal(job.ablehnungsgrund, 'Falsches Konto gewählt');

  const freigaben = listFreigabenByJob(db, id);
  const ablehnung = freigaben.find((f) => f.rolle === 'ablehnung');
  assert.ok(ablehnung, 'the rejection must be logged in freigaben for the audit trail');
  assert.equal(ablehnung.person_id, '3');
  assert.equal(ablehnung.kommentar, 'Falsches Konto gewählt');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen and no Begründung is rejected with 400', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen on a job with an unstampable PDF still rejects cleanly (no stamping is attempted)', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/nonexistent/path.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'zu spät' });

  assert.equal(res.status, 302);
  assert.equal(getJobById(db, id).status, 'abgelehnt');
  db.close();
});

test('after a rejected job is reworked and resubmitted through Kontierung, Freigabe 2 shows and stamps the newest Freigabe-1 row, not the stale one', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-findlast-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id, kontoId } = await seedFreigabe2Job(db, { pdfPfad });

  // Reject the job, then simulate the rework cycle directly at the repo level (Task 4 builds
  // the actual /abgelehnt route; this test only needs the resulting data shape).
  const { ablehnenJob, wiederOeffnenJob } = await import('../../src/db/jobsRepo.js');
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto' });
  wiederOeffnenJob(db, id, '1');
  // A second, newer Freigabe-1 approval for the same job — this is what .find() would miss.
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T10:00:00.000Z', ip: '9.9.9.9', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const viewRes = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(viewRes.status, 200);

  const freigebenRes = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigebenRes.status, 302);

  const stampedPdf = readFileSync(pdfPfad);
  const doc = mupdf.Document.openDocument(stampedPdf, 'application/pdf');
  // The Visum page (second-to-last: original page + Visum + 1 Verlauf page) must carry the
  // NEW Freigabe-1 row's IP (9.9.9.9), not the original, superseded row's IP (1.2.3.4) — this
  // is the assertion that actually distinguishes .find() (would pick the old row) from
  // .findLast() (picks the new one); both rows belong to the same person, so name alone can't
  // tell them apart.
  const visumPageText = doc.loadPage(doc.countPages() - 2).toStructuredText().asText();
  assert.match(visumPageText, /9\.9\.9\.9/, 'the operative Freigabe-1 block must use the newest row (proves .findLast, not .find)');
  assert.doesNotMatch(visumPageText, /1\.2\.3\.4/, 'the stale, superseded Freigabe-1 row must not be the one stamped as operative');

  const verlaufPageText = doc.loadPage(doc.countPages() - 1).toStructuredText().asText();
  assert.match(verlaufPageText, /Abgelehnt/, 'the Verlauf page must include the original rejection');
  assert.match(verlaufPageText, /Falsches Konto/);
  assert.match(verlaufPageText, /1\.2\.3\.4/, 'the Verlauf, unlike the Visum block, must still show the superseded row for the full audit trail');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen on a job someone else already handled returns 409, no double transition', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  // Simulate another process having already moved the job out of freigabe2 (e.g. a concurrent
  // Freigeben) between this request's authorization check and its ablehnenJob call.
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'zu spät' });

  // loadAuthorized itself already 403s once status !== 'freigabe2', so this is the same
  // access-control path as any other stale-status request — confirms no partial state change.
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'abgeschlossen');
  db.close();
});
```

Add `readFileSync` to the existing `node:fs` import at the top of the file (`import { writeFileSync } from 'node:fs';` becomes `import { readFileSync, writeFileSync } from 'node:fs';`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — `aktion` is ignored today (no `ablehnen` branch exists), so these all fail on status/body assertions.

- [ ] **Step 3: Implement the Ablehnen action, the `.findLast` fix, and `verlauf` wiring**

In `src/routes/freigabe2.js`, add `ablehnenJob` to the import from `'../db/jobsRepo.js'` on line 4 (it becomes `import { getJobById, eskalierenFreigabe2, abschliessenFreigabe2, ablehnenJob, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';`).

Replace the `renderForm` function (lines 29–45) — change `.find` to `.findLast`:

```javascript
  function renderForm(req, res, status, { job, konto }, values, errors) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
    if (!freigabe1) {
      return res.status(500).render('error', { message: 'Freigabe 1 fehlt für diesen Job — bitte an den Portal-Admin wenden.' });
    }
    const freigeber1Person = getPersonById(db, freigabe1.person_id);
    res.status(status).render('freigabe2', {
      job,
      konto,
      freigabe1,
      freigeber1Person,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
    });
  }
```

Replace the `router.post('/:id', ...)` handler (from `router.post('/:id', async (req, res, next) => {` through its closing `});`) in full:

```javascript
  router.post('/:id', async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';

      if (hatKonflikt && !begruendung) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einem Interessenskonflikt ist eine Begründung Pflicht.']);
      }

      if (hatKonflikt && job.freigabe2_eskaliert_von) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [
          'Diese Aufgabe wurde bereits eskaliert und kann nicht erneut eskaliert werden. Bitte wende dich an den Portal-Admin.',
        ]);
      }

      if (hatKonflikt) {
        db.exec('BEGIN');
        try {
          eskalierenFreigabe2(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return res.redirect('/pool');
      }

      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einer Ablehnung ist eine Begründung Pflicht.']);
        }
        db.exec('BEGIN');
        try {
          const abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (!abgelehnt) {
            db.exec('ROLLBACK');
            return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
              'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang bearbeitet.',
            ]);
          }
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung,
            eskaliertVon: null,
          });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return res.redirect('/pool');
      }

      const freigaben = listFreigabenByJob(db, job.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigeber1Person = getPersonById(db, freigabe1.person_id);
      const zeitpunkt = new Date().toISOString();
      const stampData = {
        freigeber1: {
          name: `${freigeber1Person.vorname} ${freigeber1Person.nachname}`,
          identitaet: freigeber1Person.churchtools_person_id,
          zeitpunkt: freigabe1.zeitpunkt,
          ip: freigabe1.ip,
          interessenskonflikt: Boolean(freigabe1.interessenskonflikt),
          kommentar: freigabe1.kommentar,
        },
        freigeber2: {
          name: `${req.currentPerson.vorname} ${req.currentPerson.nachname}`,
          identitaet: req.currentPerson.churchtools_person_id,
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: null,
        },
        verlauf: freigaben.map((f) => {
          const person = getPersonById(db, f.person_id);
          return {
            rolleLabel: { freigeber1: 'Freigabe 1', freigeber2: 'Freigabe 2', ablehnung: 'Abgelehnt' }[f.rolle],
            name: `${person.vorname} ${person.nachname}`,
            identitaet: f.person_id,
            zeitpunkt: f.zeitpunkt,
            ip: f.ip,
            interessenskonflikt: Boolean(f.interessenskonflikt),
            kommentar: f.kommentar,
          };
        }),
      };

      const pdfBuffer = readFileSync(job.pdf_pfad);
      let stamped;
      try {
        const position = getConfigValue(db, 'visum_seite_position') || 'letzte';
        stamped = await stampAndFinalize(pdfBuffer, stampData, position);
      } catch (err) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
      }

      const tmpPfad = `${job.pdf_pfad}.${randomUUID()}.tmp`;
      writeFileSync(tmpPfad, stamped);

      db.exec('BEGIN');
      try {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber2',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: null,
          eskaliertVon: job.freigabe2_eskaliert_von,
        });
        const abgeschlossen = abschliessenFreigabe2(db, job.id);
        if (!abgeschlossen) {
          db.exec('ROLLBACK');
          try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup of the losing attempt's tmp file */ }
          return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
            'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang abgeschlossen.',
          ]);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        try { unlinkSync(tmpPfad); } catch { /* best-effort cleanup */ }
        throw err;
      }

      renameSync(tmpPfad, job.pdf_pfad);
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });
```

Now widen the `freigaben.rolle` CHECK constraint in `src/db/schema.sql` (this belongs to this task since it's the `ablehnung` rolle that needs it — Task 1 only touched `jobs`). Change line 78 from:

```sql
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2')),
```

to:

```sql
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung')),
```

- [ ] **Step 4: Update `views/freigabe2.ejs`**

Replace the `<form>` block (lines 21–26) with:

```html
      <form method="post" action="/freigabe2/<%= job.id %>">
        <label><input type="radio" name="interessenskonflikt" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>> Kein Interessenskonflikt</label><br>
        <label><input type="radio" name="interessenskonflikt" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>> Interessenskonflikt</label><br>
        <label>Begründung (bei Interessenskonflikt oder Ablehnung Pflicht) <textarea name="begruendung"><%= values.begruendung || '' %></textarea></label><br>
        <button type="submit" name="aktion" value="freigeben">Freigeben</button>
        <button type="submit" name="aktion" value="ablehnen">Ablehnen</button>
      </form>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS. `test/integration/freigabeWorkflowEndToEnd.test.js` should now pass again too (it exercises the plain "freigeben" path, which is unaffected by these changes — `verlauf` is now built automatically from `listFreigabenByJob`, so no edits to that test file are needed).

- [ ] **Step 7: Commit**

```bash
git add src/routes/freigabe2.js src/db/schema.sql views/freigabe2.ejs test/integration/freigabe2.test.js
git commit -m "feat: Ablehnen action on Freigabe 2, fix stale-approval .find bug, wire verlauf"
```

---

### Task 4: Abgelehnt-Screen und Überarbeiten

**Files:**
- Create: `src/routes/ablehnung.js`
- Create: `views/abgelehnt.ejs`
- Modify: `src/app.js`
- Test: `test/integration/ablehnung.test.js`

**Interfaces:**
- Consumes: `getJobById`, `wiederOeffnenJob` (Task 1), `getPersonById`.
- Produces: nothing consumed by later tasks (Task 5 reads `listAbgelehntJobsForPerson` directly from `jobsRepo.js`, not from this router).

- [ ] **Step 1: Write the failing tests**

Create `test/integration/ablehnung.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, ablehnenJob, getJobById } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createAblehnungRouter } from '../../src/routes/ablehnung.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/abgelehnt', requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));
  return app;
}

async function seedAbgelehntJob(db) {
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto gewählt' });
  return { id, kontoId };
}

test('GET /abgelehnt/:id returns 403 for a person other than zugewiesen_an', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /abgelehnt/:id returns 403 when the job is not in status abgelehnt', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const { wiederOeffnenJob } = await import('../../src/db/jobsRepo.js');
  wiederOeffnenJob(db, id, '1');
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /abgelehnt/:id shows the rejection reason and who rejected it', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Falsches Konto gewählt/);
  assert.match(res.text, /Person3/);
  db.close();
});

test('POST /abgelehnt/:id/ueberarbeiten reopens the job to zugewiesen and redirects to Kontierung', async () => {
  const db = openDatabase(':memory:');
  const { id, kontoId } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).post(`/abgelehnt/${id}/ueberarbeiten`).set('x-test-person-id', '1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${id}`);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.abgelehnt_von, null);
  assert.equal(job.ablehnungsgrund, null);
  assert.equal(job.konto_id, kontoId);
  db.close();
});

test('POST /abgelehnt/:id/ueberarbeiten returns 403 for a person other than zugewiesen_an', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).post(`/abgelehnt/${id}/ueberarbeiten`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'abgelehnt');
  db.close();
});

test('GET /abgelehnt/:id returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`);
  assert.equal(res.status, 401);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/ablehnung.test.js`
Expected: FAIL — `src/routes/ablehnung.js` doesn't exist yet (import error).

- [ ] **Step 3: Create `src/routes/ablehnung.js`**

```javascript
import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';

export function createAblehnungRouter({ db }) {
  const router = Router();

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.zugewiesen_an !== req.currentPerson.churchtools_person_id || job.status !== 'abgelehnt') {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const abgelehntVonPerson = getPersonById(db, job.abgelehnt_von);
    res.render('abgelehnt', { job, abgelehntVonPerson });
  });

  router.post('/:id/ueberarbeiten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    wiederOeffnenJob(db, job.id, req.currentPerson.churchtools_person_id);
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
```

- [ ] **Step 4: Create `views/abgelehnt.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Abgelehnt — Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <h1>Abgelehnt: <%= job.dateiname %></h1>
  <p><strong>Abgelehnt von:</strong> <%= abgelehntVonPerson.vorname %> <%= abgelehntVonPerson.nachname %></p>
  <p><strong>Grund:</strong> <%= job.ablehnungsgrund %></p>
  <form method="post" action="/abgelehnt/<%= job.id %>/ueberarbeiten">
    <button type="submit">Überarbeiten</button>
  </form>
</body>
</html>
```

- [ ] **Step 5: Mount the router in `src/app.js`**

Add the import after the `createFreigabe2Router` import (line 23):

```javascript
import { createAblehnungRouter } from './routes/ablehnung.js';
```

Add the mount line after the `/freigabe2` mount (line 64):

```javascript
  app.use('/abgelehnt', requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/integration/ablehnung.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 7: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/routes/ablehnung.js views/abgelehnt.ejs src/app.js test/integration/ablehnung.test.js
git commit -m "feat: Abgelehnt screen with Überarbeiten action"
```

---

### Task 5: Pool-Integration — "Meine abgelehnten Jobs"

**Files:**
- Modify: `src/routes/poolPage.js`
- Modify: `views/pool.ejs`
- Modify: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `listAbgelehntJobsForPerson` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add `setKontierung, ablehnenJob` to the existing `jobsRepo.js` import in `test/integration/poolPage.test.js` (line 8 becomes `import { createJob, claimJob, setKontierung, setThumbnailPfad, ablehnenJob } from '../../src/db/jobsRepo.js';`), then append at the end of the file:

```javascript
test('GET /pool lists a job the current person can rework under "Meine abgelehnten Jobs"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '50', stellvertreter1Id: '1', freigeber2Id: '2', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'abgelehnt.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '50' WHERE id = ?").run(id);
  ablehnenJob(db, id, { abgelehntVon: '2', grund: 'Falsches Konto' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /abgelehnt\.pdf/);
  assert.match(res.text, new RegExp(`/abgelehnt/${id}`));
  db.close();
});

test('GET /pool shows the empty-state text when there are no abgelehnt jobs for this person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine abgelehnten Rechnungen\./);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — the "Meine abgelehnten Jobs" section doesn't exist in the rendered page yet.

- [ ] **Step 3: Wire `listAbgelehntJobsForPerson` into `src/routes/poolPage.js`**

Replace the file in full:

```javascript
import { Router } from 'express';
import { listPoolJobs, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, listAbgelehntJobsForPerson } from '../db/jobsRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createPoolPageRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    const poolJobs = listPoolJobs(db).map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
    }));
    res.render('pool', {
      poolJobs,
      meineKontierungen: listZugewiesenJobsForPerson(db, personId),
      meineFreigaben: listFreigabe2JobsForPerson(db, personId),
      meineAbgelehnten: listAbgelehntJobsForPerson(db, personId),
    });
  });

  return router;
}
```

- [ ] **Step 4: Add the section to `views/pool.ejs`**

Insert a new section after the "Meine Freigaben" block (after line 53, before the `<dialog>` element on line 55):

```html
  <h2>Meine abgelehnten Jobs</h2>
  <% if (meineAbgelehnten.length === 0) { %>
    <p>Keine abgelehnten Rechnungen.</p>
  <% } else { %>
    <ul>
      <% meineAbgelehnten.forEach((job) => { %>
        <li><a href="/abgelehnt/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
      <% }) %>
    </ul>
  <% } %>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/poolPage.js views/pool.ejs test/integration/poolPage.test.js
git commit -m "feat: Meine abgelehnten Jobs section on the Pool page"
```

---

### Task 6: Ende-zu-Ende-Test — Ablehnen → Überarbeiten → Abschluss mit vollständigem Audit-Trail

**Files:**
- Create: `test/integration/ablehnungRueckwegEndToEnd.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus the pre-existing `createApp`, `loginAs`-style login helper (same technique as `test/integration/freigabeWorkflowEndToEnd.test.js`), `setupMockChurchTools`.
- Produces: nothing (final composition test, no production code).

This is the last task, modeled directly on D2's Task 6: a genuine end-to-end proof driving the real `createApp()` object graph through a full reject → rework → re-approve cycle, checked against the real stamped PDF output — the one test that can catch any remaining cross-task defect between Tasks 1–5 before the final whole-branch review.

- [ ] **Step 1: Write the test**

Create `test/integration/ablehnungRueckwegEndToEnd.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import * as mupdf from 'mupdf';

function testConfig(jobsDir) {
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
      syncServiceToken: 'token',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, { data: { id, firstName: vorname, lastName: nachname, email } });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}

test('Kontierung → Freigabe 2 Ablehnen → Meine abgelehnten Jobs → Überarbeiten → erneute Kontierung/Freigabe 2 → abgeschlossen mit vollständigem Verlauf', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'ablehnung-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const ablehnenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Rechnungsnummer stimmt nicht' });
  assert.equal(ablehnenRes.status, 302);

  const poolResAfterAblehnung = await freigeber1Agent.get('/pool');
  assert.match(poolResAfterAblehnung.text, /rechnung\.pdf/);
  assert.match(poolResAfterAblehnung.text, new RegExp(`/abgelehnt/${jobId}`));

  const ueberarbeitenRes = await freigeber1Agent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  assert.equal(ueberarbeitenRes.status, 302);
  assert.equal(ueberarbeitenRes.headers.location, `/kontierung/${jobId}`);

  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  const freigebenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigebenRes.status, 302);

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  assert.equal(abholbereitRes.body.length, 1);

  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  assert.equal(downloadRes.status, 200);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');
  assert.ok(mdoc.countPages() >= 3, 'expected the original page + Visum page + at least one appended Verlauf page');

  const verlaufText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(verlaufText, /Abgelehnt/);
  assert.match(verlaufText, /Rechnungsnummer stimmt nicht/);
  assert.match(verlaufText, /Freigabe 1/);
  assert.match(verlaufText, /Freigabe 2/);

  const visumText = mdoc.loadPage(mdoc.countPages() - 2).toStructuredText().asText();
  assert.match(visumText, /Eins/);
  assert.match(visumText, /Zwei/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a job rejected twice before final approval carries both rejections in the Verlauf', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'ablehnung-e2e-doppel-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  const jobId = createRes.body.id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });

  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  for (const grund of ['Erster Ablehnungsgrund', 'Zweiter Ablehnungsgrund']) {
    await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
    await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: grund });
    await freigeber1Agent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  }
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');

  let allVerlaufText = '';
  for (let i = 2; i < mdoc.countPages(); i++) {
    allVerlaufText += mdoc.loadPage(i).toStructuredText().asText();
  }
  assert.match(allVerlaufText, /Erster Ablehnungsgrund/);
  assert.match(allVerlaufText, /Zweiter Ablehnungsgrund/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/integration/ablehnungRueckwegEndToEnd.test.js`
Expected: PASS, both tests. If either fails, investigate whether it's a genuine cross-task defect in Tasks 1–5 (fix it there, flag prominently) or a mistake in this test file itself — do not paper over a real defect by loosening an assertion.

- [ ] **Step 3: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS. Compare the total count against the baseline recorded at the start of Task 1 (233 tests before this plan) plus every test added across Tasks 1–6.

- [ ] **Step 4: Commit**

```bash
git add test/integration/ablehnungRueckwegEndToEnd.test.js
git commit -m "test: end-to-end Ablehnung/Rückweg proof against the real app"
```
