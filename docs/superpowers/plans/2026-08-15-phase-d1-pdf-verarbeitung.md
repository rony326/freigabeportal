# Freigabeportal Sub-Phase D1: PDF-Verarbeitung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two pure PDF-processing services (thumbnail rendering, PDF stamping) and wire the first one into the existing job-creation endpoint; add an admin-configurable setting for where the Visum cover page lives in the merged PDF.

**Architecture:** Two standalone, DB-free service modules (`src/services/thumbnail.js`, `src/services/pdfStamp.js`) that take buffers in and return buffers out — no file I/O, no `db`, no `config` inside them. `renderFirstPageThumbnail` is wired into `POST /api/n8n/jobs` (Phase C) now; `stampAndFinalize` is built and unit-tested but not wired into any route yet (D2's job, once the Freigabe2-Abschluss endpoint exists). A new `admin_config` key (`visum_seite_position`, reusing Phase A's `getConfigValue`/`setConfigValue` key-value store) drives both services, editable through a new small Admin-Bereich page that mirrors the existing `/admin/eskalation` page exactly.

**Tech Stack:** Same as Phases A/B/C (Node ≥22.13.0, Express, `node:sqlite`, `node:test`, `supertest`), plus two new dependencies: `mupdf` (^1.28.0, Artifex's official WASM PDF library, used for page rendering and text extraction) and `pdf-lib` (^1.17.1, pure-JS PDF authoring, used for stamping). Both are WASM/pure-JS with no native bindings, verified to install and run cleanly under `node --test` in this repo's Node version.

**Spec:** `docs/superpowers/specs/2026-08-15-phase-d1-pdf-verarbeitung-design.md`

## Global Constraints

- Both service functions are pure: they take a `Buffer` (and, where relevant, a resolved `visumSeitePosition` string) and return a `Buffer`. Neither touches `db`, `config`, or the filesystem — callers own all I/O and all config lookups.
- `visumSeitePosition` is one of exactly two string values: `'erste'` | `'letzte'`. It is never an environment variable — it lives in `admin_config` (key `visum_seite_position`, default `'letzte'`) and is changed at runtime through `/admin/pdf-einstellungen`, not at deploy time.
- Thumbnail rendering failure must never block job creation (`POST /api/n8n/jobs` still returns `201` and still creates the job; `thumbnail_pfad` just stays `null`). Stamping failure, by contrast, is expected to propagate as a thrown `Error` with a German message — D2 decides how to surface it to a user, D1 just guarantees the message is in German and the function never silently returns garbage.
- All thrown errors from the two service functions carry German-language messages, matching every other user/operator-facing message in this codebase.
- Tests use real PDF bytes, never mocks of `mupdf`/`pdf-lib`. Multi-page fixtures are built at test time via a shared helper (`test/helpers/pdfFixture.js`) using `pdf-lib` itself — no binary fixture files checked into the repo.
- `npm test` runs `node --test 'test/**/*.test.js'` — do not change this script.

---

### Task 1: Datenmodell — `thumbnail_pfad` column + `visum_seite_position` admin setting

**Files:**
- Modify: `src/db/schema.sql` — add `thumbnail_pfad` column to `jobs`
- Modify: `src/db/adminConfigRepo.js` — add `visum_seite_position` default
- Modify: `src/db/jobsRepo.js` — add `setThumbnailPfad`
- Modify: `test/unit/db.test.js` — assert the new column exists
- Modify: `test/unit/adminConfigRepo.test.js` — assert the new default
- Modify: `test/unit/jobsRepo.test.js` — cover `setThumbnailPfad`

**Interfaces:**
- Consumes: nothing new (uses the existing `admin_config` key-value store from Phase A: `getConfigValue`, `setConfigValue`, `seedDefaults`).
- Produces: `jobs.thumbnail_pfad` (nullable TEXT column). `admin_config` key `visum_seite_position` (default `'letzte'`). `setThumbnailPfad(db, id, thumbnailPfad)` — no return value, used by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/db.test.js`, inside the existing `'openDatabase creates all expected tables'` test area — add a new test:

```js
test('jobs table has a thumbnail_pfad column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
  assert.ok(columns.includes('thumbnail_pfad'), 'jobs table is missing thumbnail_pfad');
  db.close();
});
```

Append to `test/unit/adminConfigRepo.test.js`:

```js
test('seedDefaults sets visum_seite_position default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});
```

Append to `test/unit/jobsRepo.test.js` (add `setThumbnailPfad` to the existing import line from `'../../src/db/jobsRepo.js'`):

```js
test('setThumbnailPfad sets thumbnail_pfad on the job row', () => {
  const db = openDatabase(':memory:');
  const jobsDir = '/tmp/does-not-need-to-exist';
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: `${jobsDir}/a.pdf` });
  assert.equal(getJobById(db, id).thumbnail_pfad, null);
  setThumbnailPfad(db, id, `${jobsDir}/a.png`);
  assert.equal(getJobById(db, id).thumbnail_pfad, `${jobsDir}/a.png`);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js test/unit/adminConfigRepo.test.js test/unit/jobsRepo.test.js`
Expected: FAIL — `thumbnail_pfad` column doesn't exist, `visum_seite_position` default doesn't exist, `setThumbnailPfad` isn't exported.

- [ ] **Step 3: Modify `src/db/schema.sql`**

In the `CREATE TABLE IF NOT EXISTS jobs (...)` block, add the new column right after `fetched_by_n8n_at TEXT`:

```sql
  fetched_by_n8n_at TEXT,
  thumbnail_pfad TEXT
```

(i.e. add a comma after `fetched_by_n8n_at TEXT` and the new line before the closing `);`).

- [ ] **Step 4: Modify `src/db/adminConfigRepo.js`**

Add one line to the `DEFAULTS` object:

```js
const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  branding_farbe_primaer: '#2f4858',
  branding_farbe_sekundaer: '#4d7ea8',
  branding_theme_default: 'system',
  visum_seite_position: 'letzte',
};
```

- [ ] **Step 5: Modify `src/db/jobsRepo.js`**

Add this function (near `confirmAbholung`, at the end of the file):

```js
export function setThumbnailPfad(db, id, thumbnailPfad) {
  db.prepare('UPDATE jobs SET thumbnail_pfad = ? WHERE id = ?').run(thumbnailPfad, id);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js test/unit/adminConfigRepo.test.js test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/adminConfigRepo.js src/db/jobsRepo.js test/unit/db.test.js test/unit/adminConfigRepo.test.js test/unit/jobsRepo.test.js
git commit -m "feat: add thumbnail_pfad column and visum_seite_position admin setting"
```

---

### Task 2: Thumbnail-Rendering-Service (`renderFirstPageThumbnail`)

**Files:**
- Create: `test/helpers/pdfFixture.js`
- Create: `src/services/thumbnail.js`
- Test: `test/unit/thumbnail.test.js`
- Modify: `package.json` — add `mupdf` and `pdf-lib` dependencies (`pdf-lib` is needed here only for the test fixture helper; production use of `pdf-lib` starts in Task 4)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderFirstPageThumbnail(pdfBuffer, visumSeitePosition)` → `Buffer` (PNG bytes). Throws `Error` with a German message if the PDF cannot be opened. `buildPdfFixture(pageTexts)` (async) → `Buffer` (a real, parseable multi-page PDF with one line of text per page) — shared by Task 2 and Task 4's tests.

- [ ] **Step 1: Install the new dependencies**

```bash
npm install mupdf@^1.28.0 pdf-lib@^1.17.1
```

This updates `package.json` and `package-lock.json`.

- [ ] **Step 2: Create the shared PDF fixture helper**

Create `test/helpers/pdfFixture.js`:

```js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function buildPdfFixture(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 800, size: 14, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}
```

- [ ] **Step 3: Write the failing tests**

Create `test/unit/thumbnail.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFirstPageThumbnail } from '../../src/services/thumbnail.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const PNG_HEADER = '89504e47';

test('renders a PNG thumbnail of page 0 when the Visum page is last', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const png = renderFirstPageThumbnail(pdf, 'letzte');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('renders a PNG thumbnail of page 1 when the Visum page is first', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const png = renderFirstPageThumbnail(pdf, 'erste');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('falls back to page 0 when visumSeitePosition is "erste" but the PDF has only one page', async () => {
  const pdf = await buildPdfFixture(['Nur eine Seite']);
  const png = renderFirstPageThumbnail(pdf, 'erste');
  assert.equal(png.subarray(0, 4).toString('hex'), PNG_HEADER);
});

test('throws a defined Error for a corrupt PDF, does not crash', () => {
  const corrupt = Buffer.from('%PDF-1.4\n%not-a-real-pdf-body\n');
  assert.throws(() => renderFirstPageThumbnail(corrupt, 'letzte'), Error);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/unit/thumbnail.test.js`
Expected: FAIL — `src/services/thumbnail.js` does not exist yet.

- [ ] **Step 5: Create `src/services/thumbnail.js`**

```js
import * as mupdf from 'mupdf';

const THUMBNAIL_WIDTH_PX = 200;

export function renderFirstPageThumbnail(pdfBuffer, visumSeitePosition) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  } catch (err) {
    throw new Error(`PDF konnte für die Thumbnail-Erstellung nicht geöffnet werden: ${err.message}`);
  }
  try {
    const pageCount = doc.countPages();
    let pageIndex = visumSeitePosition === 'erste' ? 1 : 0;
    if (pageIndex >= pageCount) {
      pageIndex = 0;
    }
    const page = doc.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const width = bounds[2] - bounds[0];
      const scale = THUMBNAIL_WIDTH_PX / width;
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      try {
        return Buffer.from(pixmap.asPNG());
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/thumbnail.test.js`
Expected: PASS (4 tests). Note: mupdf prints diagnostic lines like `syntax error: expected object number` to stdout while parsing the corrupt-PDF fixture — this is mupdf's own internal repair-attempt logging, not a test failure; the test still passes because the function still throws afterward.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json test/helpers/pdfFixture.js src/services/thumbnail.js test/unit/thumbnail.test.js
git commit -m "feat: thumbnail rendering service using mupdf"
```

---

### Task 3: Wire thumbnail rendering into `POST /api/n8n/jobs`

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Modify: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `renderFirstPageThumbnail(pdfBuffer, visumSeitePosition)` (Task 2), `setThumbnailPfad(db, id, thumbnailPfad)` (Task 1), `getConfigValue(db, key)` (Phase A, `src/db/adminConfigRepo.js`).
- Produces: nothing new for later tasks — this is the last consumer of the thumbnail service in D1.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/n8n/jobs.test.js`. First, add this import at the top of the file:

```js
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
```

Then append these tests:

```js
test('POST /api/n8n/jobs with a real PDF sets thumbnail_pfad to a valid PNG file', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));
  const realPdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', realPdf, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.ok(job.thumbnail_pfad, 'thumbnail_pfad should be set');
  const pngBytes = readFileSync(job.thumbnail_pfad);
  assert.equal(pngBytes.subarray(0, 4).toString('hex'), '89504e47');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs still creates the job with 201 and thumbnail_pfad null when the PDF cannot be rendered as a thumbnail', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.thumbnail_pfad, null);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

(`PDF_BYTES` here is the existing file-level fixture `Buffer.from('%PDF-1.4\n%test-fixture-not-a-real-pdf-body\n')` — it passes the magic-bytes check but is not a real, parseable PDF, so `mupdf` fails to open it. This is exactly the "kaputtes PDF, job still created without thumbnail" case from the spec.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — `thumbnail_pfad` is always `null`, no PNG file is written.

- [ ] **Step 3: Modify `src/routes/n8n/jobs.js`**

Add two imports at the top:

```js
import { createJob, getJobById, listAbholbereitJobs, confirmAbholung, setThumbnailPfad } from '../../db/jobsRepo.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { renderFirstPageThumbnail } from '../../services/thumbnail.js';
```

(the first line replaces the existing `createJob, getJobById, listAbholbereitJobs, confirmAbholung` import line — just add `setThumbnailPfad` to it.)

In the `router.post('/', ...)` handler, right after the existing line `const id = createJob(db, { eingangAm, quelle, absender: absender || null, dateiname, pdfPfad });`, insert:

```js
      const visumSeitePosition = getConfigValue(db, 'visum_seite_position') || 'letzte';
      try {
        const thumbnailPng = renderFirstPageThumbnail(req.file.buffer, visumSeitePosition);
        const thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
        writeFileSync(thumbnailPfad, thumbnailPng);
        setThumbnailPfad(db, id, thumbnailPfad);
      } catch (err) {
        console.error(`Thumbnail-Rendering fehlgeschlagen für Job ${id}:`, err.message);
      }
```

`writeFileSync` is already imported in this file (used for `pdfPfad` a few lines above).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "feat: render and persist a thumbnail on n8n job creation"
```

---

### Task 4: PDF-Stempelung-Service (`stampAndFinalize`)

**Files:**
- Create: `src/services/pdfStamp.js`
- Test: `test/unit/pdfStamp.test.js`

**Interfaces:**
- Consumes: `buildPdfFixture(pageTexts)` (Task 2, `test/helpers/pdfFixture.js`).
- Produces: `stampAndFinalize(pdfBuffer, stampData, visumSeitePosition)` (async) → `Buffer` (stamped PDF). `stampData` shape: `{ freigeber1: { name, identitaet, zeitpunkt, ip, interessenskonflikt, kommentar }, freigeber2: { ...same fields... } }` (`zeitpunkt` is a UTC ISO string; `kommentar` may be `null`). Not consumed by any other D1 task — D2 wires this into the Freigabe2-Abschluss endpoint.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/pdfStamp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { stampAndFinalize } from '../../src/services/pdfStamp.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

function sampleStampData() {
  return {
    freigeber1: { name: 'Max Muster', identitaet: 'ct-123', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null },
    freigeber2: { name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: true, kommentar: 'Verwandtschaft mit Lieferant' },
  };
}

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

test('stamps the last page when visumSeitePosition is "letzte", keeps page count unchanged', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Rechnung Seite 2', 'Visum / Rechnungsfreigabe']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'letzte');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 3);

  const text = extractedText(stamped, 2);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
  assert.match(text, /Interessenskonflikt: Nein/);
  assert.match(text, /Interessenskonflikt: Ja/);
  assert.match(text, /Verwandtschaft mit Lieferant/);
});

test('stamps the first page when visumSeitePosition is "erste", keeps page count unchanged', async () => {
  const pdf = await buildPdfFixture(['Visum / Rechnungsfreigabe', 'Rechnung Seite 1', 'Rechnung Seite 2']);
  const stamped = await stampAndFinalize(pdf, sampleStampData(), 'erste');

  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 3);

  const text = extractedText(stamped, 0);
  assert.match(text, /Max Muster/);
  assert.match(text, /Erika Beispiel/);
});

test('throws a German-message Error for a PDF that cannot be loaded', async () => {
  await assert.rejects(
    () => stampAndFinalize(Buffer.alloc(0), sampleStampData(), 'letzte'),
    /PDF konnte nicht geladen werden/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: FAIL — `src/services/pdfStamp.js` does not exist yet.

- [ ] **Step 3: Create `src/services/pdfStamp.js`**

```js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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

export async function stampAndFinalize(pdfBuffer, stampData, visumSeitePosition) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  const pages = doc.getPages();
  if (pages.length === 0) {
    throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
  }

  const visumPage = visumSeitePosition === 'erste' ? pages[0] : pages[pages.length - 1];
  const font = await doc.embedFont(StandardFonts.Helvetica);

  drawFreigabeBlock(visumPage, font, stampData.freigeber1, 650);
  drawFreigabeBlock(visumPage, font, stampData.freigeber2, 450);

  return Buffer.from(await doc.save());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/pdfStamp.js test/unit/pdfStamp.test.js
git commit -m "feat: PDF stamping service using pdf-lib"
```

---

### Task 5: Admin-Bereich page `/admin/pdf-einstellungen`

**Files:**
- Create: `src/routes/admin/pdf-einstellungen.js`
- Create: `views/admin/pdf-einstellungen-form.ejs`
- Modify: `views/admin/_nav.ejs`
- Modify: `src/app.js`
- Modify: `test/integration/admin/authz-sweep.test.js`
- Test: `test/integration/admin/pdf-einstellungen.test.js`

**Interfaces:**
- Consumes: `getConfigValue`, `setConfigValue` (Phase A, `src/db/adminConfigRepo.js`); `requireRole`, `loadCurrentPerson` (Phase A, `src/middleware/roles.js`); `visum_seite_position` default from Task 1.
- Produces: `createPdfEinstellungenRouter({ db })` → Router with `GET /`, `POST /`. Consumed only by `src/app.js`'s mount and by D2's future Freigabe2-Abschluss endpoint (indirectly, via the `admin_config` value it writes).

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/admin/pdf-einstellungen.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createPdfEinstellungenRouter } from '../../../src/routes/admin/pdf-einstellungen.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
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
  app.use('/admin/pdf-einstellungen', requireRole(config, 'portal-admin'), createPdfEinstellungenRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ROUTES = [
  { method: 'get', path: '/admin/pdf-einstellungen' },
  { method: 'post', path: '/admin/pdf-einstellungen' },
];

test('every PDF-Einstellungen route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ROUTES) {
    const res = await request(app)[method](path).type('form').send({ visumSeitePosition: 'erste' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});

test('every PDF-Einstellungen route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ visumSeitePosition: 'erste' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/pdf-einstellungen shows the seeded default pre-selected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/pdf-einstellungen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="letzte" selected>/);
  db.close();
});

test('POST /admin/pdf-einstellungen with "erste" persists it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/pdf-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ visumSeitePosition: 'erste' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'erste');
  db.close();
});

test('POST /admin/pdf-einstellungen with an invalid value is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/pdf-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ visumSeitePosition: 'irgendwas' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'letzte');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/pdf-einstellungen.test.js`
Expected: FAIL — `src/routes/admin/pdf-einstellungen.js` and the view don't exist yet.

- [ ] **Step 3: Modify `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
  <a href="/admin/erscheinungsbild">Erscheinungsbild</a>
  <a href="/admin/personen">Personen</a>
  <a href="/admin/pdf-einstellungen">PDF-Einstellungen</a>
</nav>
```

- [ ] **Step 4: Create `views/admin/pdf-einstellungen-form.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>PDF-Einstellungen — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>PDF-Einstellungen</h1>
  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>
  <form method="post" action="/admin/pdf-einstellungen">
    <label>Position der Visum-Seite im PDF
      <select name="visumSeitePosition">
        <option value="letzte" <%= visumSeitePosition === 'letzte' ? 'selected' : '' %>>Letzte Seite</option>
        <option value="erste" <%= visumSeitePosition === 'erste' ? 'selected' : '' %>>Erste Seite</option>
      </select>
    </label><br>
    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

- [ ] **Step 5: Create `src/routes/admin/pdf-einstellungen.js`**

```js
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const VALID_POSITIONEN = new Set(['erste', 'letzte']);

export function createPdfEinstellungenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/pdf-einstellungen-form', {
      visumSeitePosition: getConfigValue(db, 'visum_seite_position'),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { visumSeitePosition } = req.body;

    if (!VALID_POSITIONEN.has(visumSeitePosition)) {
      return res.status(400).render('admin/pdf-einstellungen-form', {
        visumSeitePosition,
        errors: ['Position der Visum-Seite muss "erste" oder "letzte" sein.'],
      });
    }

    setConfigValue(db, 'visum_seite_position', visumSeitePosition);
    res.redirect('/admin/pdf-einstellungen');
  });

  return router;
}
```

- [ ] **Step 6: Modify `src/app.js`**

Add the import near the other admin router imports:

```js
import { createPdfEinstellungenRouter } from './routes/admin/pdf-einstellungen.js';
```

Add the mount line near the other `/admin/*` mounts:

```js
app.use('/admin/pdf-einstellungen', createPdfEinstellungenRouter({ db }));
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/integration/admin/pdf-einstellungen.test.js`
Expected: PASS (5 tests)

- [ ] **Step 8: Update the authz sweep**

In `test/integration/admin/authz-sweep.test.js`, add two entries to `ADMIN_ROUTES` (after the `personen (1)` block):

```js
  // pdf-einstellungen (2)
  { method: 'get', path: '/admin/pdf-einstellungen' },
  { method: 'post', path: '/admin/pdf-einstellungen' },
```

Update the count assertions from 17 to 19 (both the `assert.equal(ADMIN_ROUTES.length, 19, ...)` sanity check and its message, and the test title/description referencing "17 admin route/method combinations" → "19 admin route/method combinations").

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/routes/admin/pdf-einstellungen.js views/admin/pdf-einstellungen-form.ejs views/admin/_nav.ejs src/app.js test/integration/admin/pdf-einstellungen.test.js test/integration/admin/authz-sweep.test.js
git commit -m "feat: admin PDF-Einstellungen page for Visum page position"
```
