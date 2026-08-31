# Spesen-Einreichung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any logged-in person submit an expense claim (Spesen-Einreichung) with one or more receipted positions, each of which independently runs the existing Freigabe1 → Freigabe2 → n8n-Abholung machinery — with Freigabe 1 always going to someone other than the submitter.

**Architecture:** Every Spesen position is a normal `jobs` row (`quelle = 'spesen'`), created directly in `status = 'zugewiesen'` (submission replaces Kontierung). Two new routers (`/spesen`, `/spesen-freigabe1`) handle submission and the new review-only Freigabe-1 step; Freigabe 2, the Pool auto-assignment machinery, PDF stamping, and n8n pickup are reused unchanged or with small additive changes (mapper fields, `quelle` conditionals, `quelle != 'spesen'` guards on the invoice-only Pool queries).

**Tech Stack:** Node.js/Express, EJS views, `node:sqlite` via hand-written repo modules, `multer` (memory storage) for uploads, `pdf-lib` for PDF construction, `node:test` + `supertest` for tests.

**Spec:** `docs/superpowers/specs/2026-08-17-spesen-einreichung-design.md`

## Global Constraints

- Follow existing conventions exactly: German identifiers/comments in server code, EJS views, `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK` transactions in try/catch, CSRF via the shared `csrfProtection` middleware (manually re-ordered after `multer` on multipart routes, exactly as `kontierung.js` already does).
- **The spec's "PDF-Stempelung wird von n8n unabhängig" section is already implemented** (commit `e52354e`): `stampAndFinalize`/`renderFirstPageThumbnail` already always append/render page 0, and `src/routes/admin/pdf-einstellungen.js` + its view are already deleted. **No task in this plan touches PDF stamping, thumbnail-position logic, or admin PDF-Einstellungen** — do not reintroduce a `visumSeitePosition` parameter anywhere.
- Reuse rather than reimplement: `detectBelegMimetype` (`src/services/belegAnhaengen.js`), `normalizeIban` (`src/services/ibanUtils.js`), `sendNotification`/`resolveEmpfaenger` (`src/services/notify.js`), `buildAuditLog`/`EREIGNIS_LABEL` (`src/services/auditLog.js`), `buildSignedDownloadUrl`/`PDF_PREVIEW_TTL_SECONDS` (`src/services/downloadUrl.js`), `createFreigabe`/`listFreigabenByJob` (`src/db/freigabenRepo.js`), `getKontoById`/`listKonten` (`src/db/kontenRepo.js`).
- No admin UI for the ChurchTools custom-field names — plain required `.env` vars (`CT_CUSTOM_FIELD_IBAN`, `CT_CUSTOM_FIELD_KONTOINHABER`), same `required(env, ...)` pattern as `CT_GROUP_ID_BUCHHALTUNG`/`CT_GROUP_ID_ADMIN`.
- No rework page for rejected Spesen positions and no changes to `src/routes/ablehnung.js`/`views/abgelehnt.ejs` — this is a deliberate spec decision (a rejected position stays visible, with its rejection reason, in the new "Meine Spesen" overview; nothing links there for a Spesen job).
- **Deviation from the spec's literal file-upload wording, noted here because it's a judgment call, not an oversight:** the spec says use `upload.array(...)` with "Index-Zuordnung über Array-Position" for the per-row Beleg files. Plain `upload.array('posBeleg', N)` only stays index-aligned with the other per-row arrays if every row's file input actually submits a part — but native `<input type="file">` submits nothing at all when empty, and rows can be added/removed by JS. `views/kontierung-aufsplitten.ejs` already solves exactly this problem (there, for an *optional* per-row file) by renaming each row's file input to a positional field name (`teilBeleg_<i>`) right before submit and matching it server-side with `upload.any()` + a fieldname regex. This plan reuses that exact mechanism for Spesen (`posBeleg_<i>` / `upload.any()`) instead of `upload.array()`, because it's the already-proven-correct way to keep parallel arrays aligned in this codebase, and Spesen rows can be added/removed the same way Aufsplitten rows can.
- **Extension beyond the spec's literal file list, needed for correctness:** the spec doesn't mention `listAdminEskalierteKontierungen` when listing which Pool queries need `quelle != 'spesen'`. But a Spesen position can reach `status = 'zugewiesen', freigabe1_eskaliert_an_admin = 1` (via the *reviewer's own* Interessenskonflikt on `/spesen-freigabe1`, not just via self-submission), and `listAdminEskalierteKontierungen` is quelle-agnostic — without a fix, such a position would appear on `/pool` linking to `/kontierung/:id`, which is the wrong page for a Spesen job. This plan excludes `quelle = 'spesen'` from `listAdminEskalierteKontierungen` and adds a new `listAdminEskalierteSpesenFreigaben` query/section linking to `/spesen-freigabe1/:id` instead (Task 4, Task 10).
- Run `npm test` (or the specific new test file) after every task; don't move to the next task with a red suite.

---

### Task 1: Datenmodell — `quelle` CHECK widened, four new `jobs` columns, new `spesenabrechnungen` table

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js`
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `jobs.quelle` now accepts `'spesen'`; `jobs` gains nullable `eingereicht_von TEXT REFERENCES personen(churchtools_person_id)`, `auslage_datum TEXT`, `beschreibung TEXT`, `spesenabrechnung_id INTEGER REFERENCES spesenabrechnungen(id)`; new table `spesenabrechnungen(id, eingereicht_von, eingereicht_am, titel)`. All later tasks' repo functions read/write these.

- [ ] **Step 1: Write the failing migration test**

Add to `test/unit/db.test.js` (it already imports `DatabaseSync`, `mkdtempSync`, `join`, `tmpdir`, `rmSync`, `openDatabase`, `assert`, `test` — reuse those):

```js
test('jobs table accepts quelle = spesen and has the four Spesen columns', () => {
  const db = openDatabase(':memory:');
  const cols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const col of ['eingereicht_von', 'auslage_datum', 'beschreibung', 'spesenabrechnung_id']) {
    assert.ok(cols.includes(col), `jobs is missing column ${col}`);
  }
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status)
         VALUES ('2026-08-31T08:00:00.000Z', 'spesen', 'beleg.pdf', '/tmp/beleg.pdf', 'zugewiesen')`
      )
      .run()
  );
  db.close();
});

test('spesenabrechnungen table exists and stores a Sammelabrechnung row', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Ein', 'Reicher', 'e@example.org')"
  ).run();
  const result = db
    .prepare("INSERT INTO spesenabrechnungen (eingereicht_von, eingereicht_am, titel) VALUES ('1', '2026-08-31T08:00:00.000Z', 'Reise Zürich')")
    .run();
  assert.ok(result.lastInsertRowid > 0);
  db.close();
});

test('openDatabase rebuilds the jobs table to widen its quelle CHECK constraint on an existing on-disk database that predates Spesen', () => {
  // Simulates the real production case: a jobs table created by an older schema.sql (CHECK only
  // allowing 'scanner'/'lieferant') that already has real rows in it. `CREATE TABLE IF NOT
  // EXISTS` alone no-ops on it, and SQLite has no ALTER TABLE that widens a CHECK constraint —
  // the fix must rebuild the table without losing existing rows or their status/eskalation state.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE konten (id INTEGER PRIMARY KEY AUTOINCREMENT, kontonummer TEXT NOT NULL, bezeichnung TEXT NOT NULL, freigeber1_id TEXT NOT NULL, stellvertreter1_id TEXT NOT NULL, freigeber2_id TEXT NOT NULL, stellvertreter2_id TEXT NOT NULL, aktiv INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eingang_am TEXT NOT NULL,
      quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant')),
      absender TEXT,
      dateiname TEXT NOT NULL,
      pdf_pfad TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unzugewiesen',
      konto_id INTEGER REFERENCES konten(id),
      zugewiesen_an TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id) VALUES ('1000', 'Test', '1', '2', '3', '4');
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Frei', 'Geber', 'f@example.org');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an)
      VALUES ('2026-08-15T08:00:00.000Z', 'lieferant', 'Firma AG', 'a.pdf', '/tmp/a.pdf', 'zugewiesen', 1, '1');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const preserved = migratedDb.prepare('SELECT * FROM jobs WHERE id = 1').get();
  assert.equal(preserved.absender, 'Firma AG', 'existing rows must survive the table rebuild');
  assert.equal(preserved.status, 'zugewiesen');
  assert.equal(preserved.konto_id, 1);

  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status)
         VALUES ('2026-08-31T08:00:00.000Z', 'spesen', 'beleg.pdf', '/tmp/beleg.pdf', 'zugewiesen')`
      )
      .run(),
    'the widened CHECK constraint must accept quelle = spesen'
  );

  // The rebuild must not have dropped the trigger/index migrateJobsTable() re-creates every boot
  // — see the comment on migrateJobsTableQuelleCheck for why this could otherwise silently break.
  const trigger = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_zeitstempel_hash_unveraenderlich'")
    .get();
  assert.ok(trigger, 'zeitstempel-immutability trigger must still exist after the rebuild');

  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the jobs table when it already has the widened quelle CHECK constraint', () => {
  const db1 = openDatabase(':memory:');
  db1.close();
  // Running openDatabase twice on a real file must not throw or duplicate the migration work.
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'twice.sqlite');
  openDatabase(dbPath).close();
  assert.doesNotThrow(() => openDatabase(dbPath).close());
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: FAIL — `jobs` has no `eingereicht_von` column, `spesenabrechnungen` doesn't exist, and the CHECK-widening test fails inserting `quelle = 'spesen'`.

- [ ] **Step 3: Widen `quelle` and add the new columns/table in `schema.sql`**

In `src/db/schema.sql`, change the `jobs` CREATE TABLE's `quelle` line:

```sql
  quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant', 'spesen')),
```

and add these four columns at the end of the same `CREATE TABLE IF NOT EXISTS jobs (...)` (right before the closing `);`, after `gruppe_abgeholt_am TEXT`):

```sql
  eingereicht_von TEXT REFERENCES personen(churchtools_person_id),
  auslage_datum TEXT,
  beschreibung TEXT,
  spesenabrechnung_id INTEGER REFERENCES spesenabrechnungen(id)
```

Add a new table, anywhere after the `personen` table definition (e.g. right after the `konten`/`debitoren` block):

```sql
CREATE TABLE IF NOT EXISTS spesenabrechnungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eingereicht_von TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  eingereicht_am TEXT NOT NULL,
  titel TEXT
);
```

- [ ] **Step 4: Add the four columns to `JOBS_TABLE_MIGRATIONS` in `src/db/index.js`**

In `src/db/index.js`, append to the `JOBS_TABLE_MIGRATIONS` array (after the `gruppe_abgeholt_am` entry):

```js
  { column: 'eingereicht_von', ddl: 'ALTER TABLE jobs ADD COLUMN eingereicht_von TEXT REFERENCES personen(churchtools_person_id)' },
  { column: 'auslage_datum', ddl: 'ALTER TABLE jobs ADD COLUMN auslage_datum TEXT' },
  { column: 'beschreibung', ddl: 'ALTER TABLE jobs ADD COLUMN beschreibung TEXT' },
  { column: 'spesenabrechnung_id', ddl: 'ALTER TABLE jobs ADD COLUMN spesenabrechnung_id INTEGER REFERENCES spesenabrechnungen(id)' },
```

- [ ] **Step 5: Add `migrateJobsTableQuelleCheck` and call it before `migrateJobsTable` in `openDatabase`**

In `src/db/index.js`, add this new function right before `migrateJobsTable`:

```js
// SQLite CHECK constraints can't be widened with ALTER TABLE — same rebuild-in-a-transaction
// approach as migrateFreigabenTable below. The marker this function checks for is `'spesen'`
// (the newest quelle value); check schema.sql's jobs CREATE TABLE for what the CHECK currently
// allows, not this comment.
//
// Must run BEFORE migrateJobsTable(db) in openDatabase(): renaming jobs aside (and later
// dropping the renamed copy) also renames/drops every trigger and index attached to it, since
// SQLite's ALTER TABLE RENAME rewrites their ON-clause to follow the table and DROP TABLE takes
// dependent triggers with it. Running migrateJobsTable(db) immediately afterwards re-creates
// idx_jobs_datei_hash and all four zeitstempel-immutability triggers unconditionally (its own
// CREATE INDEX/TRIGGER IF NOT EXISTS statements), healing what this rebuild just dropped. This
// function deliberately does NOT also add the four new Spesen columns — JOBS_TABLE_MIGRATIONS'
// plain ADD COLUMN entries (which don't care about an unrelated CHECK constraint) already cover
// that, exactly like every other jobs column added since this table's original schema.sql.
function migrateJobsTableQuelleCheck(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
  if (!tableSql || tableSql.sql.includes("'spesen'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE jobs RENAME TO jobs_pre_spesen_quelle');
    db.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eingang_am TEXT NOT NULL,
        quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant', 'spesen')),
        absender TEXT,
        dateiname TEXT NOT NULL,
        pdf_pfad TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'unzugewiesen','zugewiesen','kontiert','freigabe1','freigabe2',
          'abgeschlossen','abgeholt','archiviert','abgelehnt','aufgesplittet','geloescht'
        )) DEFAULT 'unzugewiesen',
        konto_id INTEGER REFERENCES konten(id),
        zugewiesen_an TEXT REFERENCES personen(churchtools_person_id),
        abgelehnt_von TEXT REFERENCES personen(churchtools_person_id),
        ablehnungsgrund TEXT,
        fetched_by_n8n_at TEXT,
        thumbnail_pfad TEXT,
        freigabe1_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe1_eskalationsgrund TEXT,
        freigabe2_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
        freigabe2_eskalationsgrund TEXT,
        reminder_gesendet_at TEXT,
        eskalation_gesendet_at TEXT,
        archiviert_am TEXT,
        freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
        betrag TEXT,
        zahlungsziel TEXT,
        rechnungsnummer TEXT,
        lieferant TEXT,
        debitor_id INTEGER REFERENCES debitoren(id),
        aufgesplittet_von INTEGER REFERENCES jobs(id),
        datei_hash TEXT,
        hinweis_konto_id INTEGER REFERENCES konten(id),
        zeitstempel_gesetzt_am TEXT,
        zeitstempel_datei_hash TEXT,
        abgeschlossen_am TEXT,
        qr_iban TEXT,
        qr_referenz TEXT,
        qr_betrag TEXT,
        qr_waehrung TEXT,
        qr_creditor_name TEXT,
        qr_erkannt_am TEXT,
        typ TEXT,
        rechnungsposition TEXT,
        gruppe_pdf_pfad TEXT,
        gruppe_zeitstempel_gesetzt_am TEXT,
        gruppe_zeitstempel_datei_hash TEXT,
        beleg_seitenzahl INTEGER,
        gruppe_abgeholt_am TEXT
      )
    `);
    db.exec(`
      INSERT INTO jobs (
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      )
      SELECT
        id, eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an,
        abgelehnt_von, ablehnungsgrund, fetched_by_n8n_at, thumbnail_pfad, freigabe1_eskaliert_von,
        freigabe1_eskalationsgrund, freigabe2_eskaliert_von, freigabe2_eskalationsgrund,
        reminder_gesendet_at, eskalation_gesendet_at, archiviert_am, freigabe1_eskaliert_an_admin,
        freigabe2_eskaliert_an_admin, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id,
        aufgesplittet_von, datei_hash, hinweis_konto_id, zeitstempel_gesetzt_am,
        zeitstempel_datei_hash, abgeschlossen_am, qr_iban, qr_referenz, qr_betrag, qr_waehrung,
        qr_creditor_name, qr_erkannt_am, typ, rechnungsposition, gruppe_pdf_pfad,
        gruppe_zeitstempel_gesetzt_am, gruppe_zeitstempel_datei_hash, beleg_seitenzahl, gruppe_abgeholt_am
      FROM jobs_pre_spesen_quelle
    `);
    db.exec('DROP TABLE jobs_pre_spesen_quelle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

Then, in `openDatabase`, call it before `migrateJobsTable(db)`:

```js
  db.exec(schema);
  migrateJobsTableQuelleCheck(db);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateMailLogTable(db);
  migrateCronLogTable(db);
  migratePersonBerechtigungenTable(db);
  migrateCronLogTableSplitGruppen(db);
  return db;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: PASS — all new tests green, no existing test broken.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(spesen): widen jobs.quelle CHECK for 'spesen', add Spesen columns and spesenabrechnungen table"
```

---

### Task 2: `src/db/spesenabrechnungenRepo.js` — `createSpesenabrechnung`

**Files:**
- Create: `src/db/spesenabrechnungenRepo.js`
- Test: `test/unit/spesenabrechnungenRepo.test.js`

**Interfaces:**
- Consumes: `spesenabrechnungen` table from Task 1.
- Produces: `createSpesenabrechnung(db, { eingereichtVon, eingereichtAm, titel }) → id:number`, used by Task 7's `POST /spesen`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createSpesenabrechnung } from '../../src/db/spesenabrechnungenRepo.js';

test('createSpesenabrechnung inserts a row and returns its id', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });

  const id = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: 'Reise Zürich' });

  const row = db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id);
  assert.equal(row.eingereicht_von, '1');
  assert.equal(row.titel, 'Reise Zürich');
  db.close();
});

test('createSpesenabrechnung stores a NULL titel when none is given', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });

  const id = createSpesenabrechnung(db, { eingereichtVon: '1', eingereichtAm: '2026-08-31T08:00:00.000Z', titel: null });

  const row = db.prepare('SELECT * FROM spesenabrechnungen WHERE id = ?').get(id);
  assert.equal(row.titel, null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/spesenabrechnungenRepo.test.js`
Expected: FAIL with a module-not-found error for `../../src/db/spesenabrechnungenRepo.js`.

- [ ] **Step 3: Write the implementation**

```js
export function createSpesenabrechnung(db, { eingereichtVon, eingereichtAm, titel }) {
  const result = db
    .prepare('INSERT INTO spesenabrechnungen (eingereicht_von, eingereicht_am, titel) VALUES (?, ?, ?)')
    .run(eingereichtVon, eingereichtAm, titel ?? null);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/spesenabrechnungenRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/spesenabrechnungenRepo.js test/unit/spesenabrechnungenRepo.test.js
git commit -m "feat(spesen): add spesenabrechnungenRepo.createSpesenabrechnung"
```

---

### Task 3: `jobsRepo.js` — `createSpesenPosition` + Pool-Query-Ausschlüsse

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `jobs` columns from Task 1.
- Produces: `createSpesenPosition(db, { eingangAm, eingereichtVon, kontoId, betrag, auslageDatum, beschreibung, dateiname, pdfPfad, thumbnailPfad, spesenabrechnungId, zugewiesenAn, freigabe1EskaliertVon, freigabe1Eskalationsgrund }) → id:number`, used by Task 7. `listPoolJobs`, `listZugewiesenJobsForPerson`, `listAbgelehntJobsForPerson`, `listAdminEskalierteKontierungen` now all exclude `quelle = 'spesen'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js` (it already imports `openDatabase`, `upsertPerson`, `createKonto`, assorted `jobsRepo` functions, and `assert`/`test` — extend those imports with `createSpesenPosition`):

```js
test('createSpesenPosition inserts a quelle=spesen job in status zugewiesen with Spesen-specific fields', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '3', freigeber2Id: '4', stellvertreter2Id: '5' });

  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z',
    eingereichtVon: '2',
    kontoId,
    betrag: '61.75',
    auslageDatum: '2026-08-20',
    beschreibung: 'Bahnticket',
    dateiname: 'ticket.pdf',
    pdfPfad: '/tmp/ticket.pdf',
    thumbnailPfad: null,
    spesenabrechnungId: 1,
    zugewiesenAn: '1',
    freigabe1EskaliertVon: null,
    freigabe1Eskalationsgrund: null,
  });

  const job = getJobById(db, id);
  assert.equal(job.quelle, 'spesen');
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.eingereicht_von, '2');
  assert.equal(job.auslage_datum, '2026-08-20');
  assert.equal(job.beschreibung, 'Bahnticket');
  assert.equal(job.spesenabrechnung_id, 1);
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.konto_id, kontoId);
  db.close();
});

test('createSpesenPosition records the self-submission escalation reason when given', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '3', freigeber2Id: '4', stellvertreter2Id: '5' });

  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z',
    eingereichtVon: '1',
    kontoId,
    betrag: '10.00',
    auslageDatum: '2026-08-20',
    beschreibung: 'Parkgebühr',
    dateiname: 'beleg.pdf',
    pdfPfad: '/tmp/beleg.pdf',
    thumbnailPfad: null,
    spesenabrechnungId: 1,
    zugewiesenAn: '3',
    freigabe1EskaliertVon: '1',
    freigabe1Eskalationsgrund: 'Selbsteinreichung durch Freigeber1',
  });

  const job = getJobById(db, id);
  assert.equal(job.zugewiesen_an, '3');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Selbsteinreichung durch Freigeber1');
  db.close();
});

test('listPoolJobs excludes quelle=spesen jobs', () => {
  const db = openDatabase(':memory:');
  createJob(db, { eingangAm: '2026-08-31T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare(
    "INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status) VALUES ('2026-08-31T08:00:00.000Z', 'spesen', 'b.pdf', '/tmp/b.pdf', 'unzugewiesen')"
  ).run();
  assert.equal(listPoolJobs(db).length, 1);
  db.close();
});

test('listZugewiesenJobsForPerson excludes quelle=spesen jobs', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '1', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  assert.equal(listZugewiesenJobsForPerson(db, '1').length, 0);
  db.close();
});

test('listAbgelehntJobsForPerson excludes quelle=spesen jobs', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '1', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  ablehnenJob(db, id, { abgelehntVon: '1', grund: 'nein' });
  assert.equal(listAbgelehntJobsForPerson(db, '1').length, 0);
  db.close();
});

test('listAdminEskalierteKontierungen excludes quelle=spesen jobs', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '1', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  eskalierenFreigabe1AnAdmin(db, id, { eskaliertVon: '1', grund: 'Befangen' });
  assert.equal(listAdminEskalierteKontierungen(db).length, 0);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `createSpesenPosition` not exported yet; the exclusion tests fail because the Pool queries currently return the Spesen job too.

- [ ] **Step 3: Implement `createSpesenPosition` and the four query exclusions**

Add to `src/db/jobsRepo.js` (near `createSplitJob`, which it closely mirrors):

```js
export function createSpesenPosition(
  db,
  {
    eingangAm,
    eingereichtVon,
    kontoId,
    betrag,
    auslageDatum,
    beschreibung,
    dateiname,
    pdfPfad,
    thumbnailPfad,
    spesenabrechnungId,
    zugewiesenAn,
    freigabe1EskaliertVon,
    freigabe1Eskalationsgrund,
  }
) {
  const result = db
    .prepare(
      `INSERT INTO jobs (
        eingang_am, quelle, dateiname, pdf_pfad, thumbnail_pfad, status, konto_id, betrag,
        eingereicht_von, auslage_datum, beschreibung, spesenabrechnung_id, zugewiesen_an,
        freigabe1_eskaliert_von, freigabe1_eskalationsgrund
      ) VALUES (?, 'spesen', ?, ?, ?, 'zugewiesen', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eingangAm,
      dateiname,
      pdfPfad,
      thumbnailPfad,
      kontoId,
      betrag,
      eingereichtVon,
      auslageDatum,
      beschreibung,
      spesenabrechnungId,
      zugewiesenAn,
      freigabe1EskaliertVon ?? null,
      freigabe1Eskalationsgrund ?? null
    );
  return Number(result.lastInsertRowid);
}
```

Change the four existing queries (find each by its current SQL string shown here and add the `quelle` guard):

```js
export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' AND quelle != 'spesen' ORDER BY eingang_am").all();
}
```

```js
export function listZugewiesenJobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'zugewiesen' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 AND quelle != 'spesen' ORDER BY eingang_am"
    )
    .all(personId);
}
```

```js
export function listAbgelehntJobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'abgelehnt' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 AND quelle != 'spesen' ORDER BY eingang_am"
    )
    .all(personId);
}
```

```js
export function listAdminEskalierteKontierungen(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND freigabe1_eskaliert_an_admin = 1 AND quelle != 'spesen' ORDER BY eingang_am").all();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat(spesen): add jobsRepo.createSpesenPosition, exclude quelle=spesen from invoice-only Pool queries"
```

---

### Task 4: `jobsRepo.js` — `listSpesenFreigabe1JobsForPerson`, `listSpesenForEinreicher`, `listAdminEskalierteSpesenFreigaben`

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Produces: `listSpesenFreigabe1JobsForPerson(db, personId) → job[]`, `listSpesenForEinreicher(db, personId) → job[]`, `listAdminEskalierteSpesenFreigaben(db) → job[]`. All three consumed by Task 10 (`poolPage.js`).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`:

```js
test('listSpesenFreigabe1JobsForPerson returns only quelle=spesen jobs assigned to that person, not admin-escalated ones', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const offeneId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  const eskaliertId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '20.00', auslageDatum: '2026-08-20',
    beschreibung: 'y', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  eskalierenFreigabe1AnAdmin(db, eskaliertId, { eskaliertVon: '1', grund: 'Befangen' });

  const result = listSpesenFreigabe1JobsForPerson(db, '1');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, offeneId);
  db.close();
});

test('listSpesenForEinreicher returns every quelle=spesen job for that submitter regardless of status', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const zugewiesenId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '9', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  const abgelehntId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '9', kontoId, betrag: '20.00', auslageDatum: '2026-08-20',
    beschreibung: 'y', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  ablehnenJob(db, abgelehntId, { abgelehntVon: '1', grund: 'nein' });

  const result = listSpesenForEinreicher(db, '9');
  assert.equal(result.length, 2);
  assert.ok(result.some((j) => j.id === zugewiesenId));
  assert.ok(result.some((j) => j.id === abgelehntId && j.ablehnungsgrund === 'nein'));
  db.close();
});

test('listAdminEskalierteSpesenFreigaben returns only admin-escalated quelle=spesen jobs', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Test', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createJob(db, { eingangAm: '2026-08-31T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/r.pdf' });
  const spesenId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'x', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  eskalierenFreigabe1AnAdmin(db, spesenId, { eskaliertVon: '1', grund: 'Befangen' });

  const result = listAdminEskalierteSpesenFreigaben(db);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, spesenId);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — the three functions aren't exported yet.

- [ ] **Step 3: Implement the three query functions**

Add to `src/db/jobsRepo.js` (near `listZugewiesenJobsForPerson`/`listAdminEskalierteKontierungen`):

```js
export function listSpesenFreigabe1JobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'zugewiesen' AND quelle = 'spesen' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 ORDER BY eingang_am"
    )
    .all(personId);
}

export function listSpesenForEinreicher(db, personId) {
  return db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen' AND eingereicht_von = ? ORDER BY eingang_am DESC").all(personId);
}

export function listAdminEskalierteSpesenFreigaben(db) {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND quelle = 'spesen' AND freigabe1_eskaliert_an_admin = 1 ORDER BY eingang_am")
    .all();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat(spesen): add jobsRepo queries backing the Pool dashboard's Spesen sections"
```

---

### Task 5: `belegAnhaengen.js` — `buildBelegPdf` (standalone PDF from a submitted Beleg)

**Files:**
- Modify: `src/services/belegAnhaengen.js`
- Test: `test/unit/belegAnhaengen.test.js`

**Interfaces:**
- Consumes: `PDFDocument` from `pdf-lib`, `toOwnedUint8Array` (already private to this file).
- Produces: `buildBelegPdf(belegBuffer, belegMimetype) → Promise<Buffer>`, used by Task 7. Unlike `mergeBelegInPdf`, this doesn't need an existing PDF to merge into — a Spesen position's Beleg *is* the entire job document, not an attachment to one.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/belegAnhaengen.test.js` (it already imports `PDFDocument`, `PNG_1X1`, `JPEG_1X1`, `buildPdfFixture` — extend the `belegAnhaengen.js` import with `buildBelegPdf`):

```js
test('buildBelegPdf returns a PDF Beleg unchanged', async () => {
  const original = await buildPdfFixture(['Seite 1', 'Seite 2']);

  const result = await buildBelegPdf(original, 'application/pdf');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 2);
});

test('buildBelegPdf wraps a PNG Beleg into a fresh one-page PDF', async () => {
  const result = await buildBelegPdf(PNG_1X1, 'image/png');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 1);
});

test('buildBelegPdf wraps a JPEG Beleg into a fresh one-page PDF', async () => {
  const result = await buildBelegPdf(JPEG_1X1, 'image/jpeg');

  const reloaded = await PDFDocument.load(result);
  assert.equal(reloaded.getPageCount(), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/belegAnhaengen.test.js`
Expected: FAIL — `buildBelegPdf` is not exported.

- [ ] **Step 3: Implement `buildBelegPdf`**

Add to `src/services/belegAnhaengen.js`, after `mergeBelegInPdf`:

```js
// Unlike mergeBelegInPdf, there is no existing job PDF to merge into here — a Spesen position's
// Beleg *is* the entire job document. A PDF Beleg is returned as-is; an image Beleg is embedded
// as the sole page of a brand-new PDF, at its own natural pixel dimensions (same convention
// mergeBelegInPdf's image branch already uses for a merged image page).
export async function buildBelegPdf(belegBuffer, belegMimetype) {
  const belegBytes = toOwnedUint8Array(belegBuffer);
  if (belegMimetype === 'application/pdf') {
    return Buffer.from(belegBytes);
  }
  const doc = await PDFDocument.create();
  const image = belegMimetype === 'image/png' ? await doc.embedPng(belegBytes) : await doc.embedJpg(belegBytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await doc.save());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/belegAnhaengen.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/belegAnhaengen.js test/unit/belegAnhaengen.test.js
git commit -m "feat(spesen): add belegAnhaengen.buildBelegPdf to turn a submitted Beleg into a standalone PDF"
```

---

### Task 6: ChurchTools IBAN/Kontoinhaber custom-field lookup + env vars

**⚠️ Before writing the extraction logic, confirm the real response shape.** The design spec explicitly flags this as unverified ("Offene Annahme, vor Implementierung zu verifizieren", spec §"Offene Annahme"): the exact custom-field key/shape in `GET /api/persons/{id}`'s response depends on the ChurchTools installation and API version, and no code in this repo has ever read a ChurchTools custom field before (confirmed: zero existing usages). Do one real `GET /api/persons/{id}` against the target instance with the sync service token (`config.churchtools.syncServiceToken`, `Authorization: Login <token>`) for a person known to have the IBAN field filled in, and look at the actual `customFields` shape in the response before finalizing Step 3 below — adjust `extractCustomFieldValue`'s matching logic if the real shape differs from what's implemented here (currently assumes a flat `customFields: [{ id, name, value }]` array, matched by exact `name` or by `id`).

**Files:**
- Modify: `src/services/churchtools.js`
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Test: `test/integration/churchtools.test.js`
- Test: `test/unit/env.test.js`

**Interfaces:**
- Produces: `extractCustomFieldValue(person, fieldNameOrId) → string|null` in `churchtools.js`; `config.churchtools.customFieldIban`/`customFieldKontoinhaber` in `env.js`. Both consumed by Task 11.

- [ ] **Step 1: Write the failing churchtools.js test**

Add to `test/integration/churchtools.test.js` (extend the existing `from '../../src/services/churchtools.js'` import with `extractCustomFieldValue`):

```js
test('extractCustomFieldValue finds a custom field by name and returns its trimmed value', () => {
  const person = {
    id: 9,
    customFields: [
      { id: 12, name: 'IBAN', value: '  CH93 0076 2011 6238 5295 7  ' },
      { id: 13, name: 'Kontoinhaber', value: 'Max Muster' },
    ],
  };
  assert.equal(extractCustomFieldValue(person, 'IBAN'), 'CH93 0076 2011 6238 5295 7');
});

test('extractCustomFieldValue finds a custom field by numeric id', () => {
  const person = { id: 9, customFields: [{ id: 12, name: 'IBAN', value: 'CH930076201162385295 7' }] };
  assert.equal(extractCustomFieldValue(person, '12'), 'CH930076201162385295 7');
});

test('extractCustomFieldValue returns null when the field is missing, empty, or the person has no customFields', () => {
  assert.equal(extractCustomFieldValue({ id: 9, customFields: [] }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue({ id: 9, customFields: [{ id: 12, name: 'IBAN', value: '' }] }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue({ id: 9 }, 'IBAN'), null);
  assert.equal(extractCustomFieldValue(null, 'IBAN'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/churchtools.test.js`
Expected: FAIL — `extractCustomFieldValue` is not exported.

- [ ] **Step 3: Implement `extractCustomFieldValue`**

Add to `src/services/churchtools.js`, after `fetchPersonById`:

```js
// ChurchTools' GET /api/persons/{id} response includes a `customFields` array — see the
// verification note on this feature's implementation-plan Task 6 before relying on this against
// production data; the exact shape is installation/API-version-specific and was not confirmed
// against a real instance while writing this.
export function extractCustomFieldValue(person, fieldNameOrId) {
  if (!person || !Array.isArray(person.customFields)) return null;
  const eintrag = person.customFields.find((feld) => feld.name === fieldNameOrId || String(feld.id) === String(fieldNameOrId));
  if (!eintrag || !eintrag.value) return null;
  const wert = String(eintrag.value).trim();
  return wert || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/churchtools.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing env.js test**

Add to `test/unit/env.test.js` (add `CT_CUSTOM_FIELD_IBAN: 'IBAN', CT_CUSTOM_FIELD_KONTOINHABER: 'Kontoinhaber',` to `FULL_ENV`, then):

```js
test('loadConfig exposes the ChurchTools custom-field names for IBAN/Kontoinhaber', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.churchtools.customFieldIban, 'IBAN');
  assert.equal(config.churchtools.customFieldKontoinhaber, 'Kontoinhaber');
});

test('loadConfig throws when CT_CUSTOM_FIELD_IBAN is missing', () => {
  const { CT_CUSTOM_FIELD_IBAN, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: CT_CUSTOM_FIELD_IBAN/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/unit/env.test.js`
Expected: FAIL — `config.churchtools.customFieldIban` is `undefined`, and the missing-var test doesn't throw.

- [ ] **Step 7: Add the two env vars to `loadConfig`**

In `src/config/env.js`, inside the `churchtools: { ... }` block, after `syncServiceToken: requiredSecret(env, 'CT_SYNC_SERVICE_TOKEN'),`:

```js
      customFieldIban: required(env, 'CT_CUSTOM_FIELD_IBAN'),
      customFieldKontoinhaber: required(env, 'CT_CUSTOM_FIELD_KONTOINHABER'),
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/unit/env.test.js`
Expected: PASS

- [ ] **Step 9: Document the two new vars in `.env.example`**

In `.env.example`, right after the `CT_GROUP_ID_ADMIN=` line (before the `CT_GROUP_ID_MANAGER` comment block):

```
# ChurchTools-Custom-Feld-Namen (Personen), aus denen die Spesen-Abholung (n8n) IBAN und
# Kontoinhaber live abruft -- siehe docs/superpowers/specs/2026-08-17-spesen-einreichung-design.md
CT_CUSTOM_FIELD_IBAN=
CT_CUSTOM_FIELD_KONTOINHABER=
```

- [ ] **Step 10: Commit**

```bash
git add src/services/churchtools.js src/config/env.js .env.example test/integration/churchtools.test.js test/unit/env.test.js
git commit -m "feat(spesen): add ChurchTools custom-field extraction for IBAN/Kontoinhaber lookup"
```

---

### Task 7: `src/routes/spesen.js` + `views/spesen-neu.ejs` — Einreichung

**Files:**
- Create: `src/routes/spesen.js`
- Create: `views/spesen-neu.ejs`
- Modify: `src/app.js`
- Test: `test/integration/spesen.test.js`

**Interfaces:**
- Consumes: `createSpesenabrechnung` (Task 2), `createSpesenPosition`, `eskalierenFreigabe1AnAdmin` — no, self-submission never needs the admin tier (Konto roles are always 4 distinct people, see Global Constraints) — `getJobById` (Task 3/4), `listKonten`/`getKontoById` (`kontenRepo.js`), `createFreigabe` (`freigabenRepo.js`), `getPersonById` (`personenRepo.js`), `detectBelegMimetype`, `buildBelegPdf` (Task 5), `sendNotification` (`notify.js`).
- Produces: `createSpesenRouter({ db, config, mailer, csrfProtection }) → Router`, mounted at `/spesen`. `GET /spesen/neu`, `POST /spesen`.

- [ ] **Step 1: Write the failing integration tests**

Create `test/integration/spesen.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { getJobById } from '../../src/db/jobsRepo.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { PNG_1X1 } from '../helpers/imageFixture.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createSpesenRouter } from '../../src/routes/spesen.js';
import { fetchCsrfToken } from '../helpers/csrf.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function testConfig() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', jobsDir: '/tmp', publicBaseUrl: 'https://portal.example.org' };
}

function buildTestApp(db, mailer, config = testConfig()) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const csrfProtection = (req, res, next) => {
    if (req.body?._csrf === 'valid-token') return next();
    return res.status(403).send('invalid csrf');
  };
  app.use((req, res, next) => {
    res.locals.csrfToken = 'valid-token';
    next();
  });
  app.use('/spesen', requireLogin(), createSpesenRouter({ db, config, mailer, csrfProtection }));
  return app;
}

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  return createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /spesen/neu requires login', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /spesen/neu lists every active Konto regardless of the current person\'s roles', async () => {
  const db = openDatabase(':memory:');
  seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/spesen/neu').set('x-test-person-id', '5');
  assert.equal(res.status, 200);
  assert.match(res.text, /1000/);
  assert.match(res.text, /Reisespesen/);
  db.close();
});

test('POST /spesen creates one job per position, assigned to the Konto Freigeber1, status zugewiesen', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);
  const pdf = await buildPdfFixture(['Beleg 1']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('titel', 'Reise Zürich')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '61.75')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Bahnticket')
    .attach('posBeleg_0', pdf, { filename: 'ticket.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.eingereicht_von, '5');
  assert.equal(job.beschreibung, 'Bahnticket');
  assert.equal(job.auslage_datum, '2026-08-20');
  assert.equal(job.betrag, '61.75');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'f1@example.org');
  db.close();
});

test('POST /spesen with two positions on different Konten creates two independent jobs', async () => {
  const db = openDatabase(':memory:');
  const kontoId1 = seedGrundlagen(db);
  const kontoId2 = createKonto(db, { kontonummer: '2000', bezeichnung: 'Büromaterial', freigeber1Id: '3', stellvertreter1Id: '4', freigeber2Id: '1', stellvertreter2Id: '2' });
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', [String(kontoId1), String(kontoId2)])
    .field('posBetrag', ['10.00', '20.00'])
    .field('posAuslageDatum', ['2026-08-20', '2026-08-21'])
    .field('posBeschreibung', ['Taxi', 'Toner'])
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' })
    .attach('posBeleg_1', pdf, { filename: 'b.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  const jobs = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen' ORDER BY betrag").all();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].konto_id, kontoId1);
  assert.equal(jobs[1].konto_id, kontoId2);
  db.close();
});

test('POST /spesen escalates to Stellvertreter1 and sets the escalation reason when the submitter is the Konto\'s own Freigeber1', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '1') // person '1' is this Konto's own Freigeber1
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Parkgebühr')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 302);
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.equal(job.zugewiesen_an, '2', 'must reassign to Stellvertreter1, never the submitter');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Selbsteinreichung durch Freigeber1');
  const eintrag = db.prepare("SELECT * FROM freigaben WHERE job_id = ? AND rolle = 'freigabe1_eskalation'").get(job.id);
  assert.ok(eintrag, 'the auto-escalation must be logged as a freigaben row so the audit log shows the reason');
  assert.equal(eintrag.kommentar, 'Selbsteinreichung durch Freigeber1');
  assert.equal(mailer.sent[0].to, 's1@example.org');
  db.close();
});

test('POST /spesen rejects a position with an inactive Konto', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  deactivateKonto(db, kontoId);
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE quelle = 'spesen'").get().n, 0);
  db.close();
});

test('POST /spesen rejects a position with a future Auslage-Datum', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const pdf = await buildPdfFixture(['Beleg']);

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2999-01-01')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  db.close();
});

test('POST /spesen rejects a position missing its Beleg', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x');

  assert.equal(res.status, 400);
  db.close();
});

test('POST /spesen accepts a PNG Beleg and wraps it into a standalone PDF', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post('/spesen')
    .set('x-test-person-id', '5')
    .field('_csrf', 'valid-token')
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'x')
    .attach('posBeleg_0', PNG_1X1, { filename: 'beleg.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  const job = db.prepare("SELECT * FROM jobs WHERE quelle = 'spesen'").get();
  assert.ok(job.pdf_pfad.endsWith('.pdf'));
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/spesen.test.js`
Expected: FAIL — `src/routes/spesen.js` doesn't exist.

- [ ] **Step 3: Implement `src/routes/spesen.js`**

```js
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listKonten, getKontoById } from '../db/kontenRepo.js';
import { createSpesenabrechnung } from '../db/spesenabrechnungenRepo.js';
import { createSpesenPosition, getJobById } from '../db/jobsRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { detectBelegMimetype, buildBelegPdf } from '../services/belegAnhaengen.js';
import { renderFirstPageThumbnail } from '../services/thumbnail.js';
import { sendNotification } from '../services/notify.js';

const BETRAG_PATTERN = /^\d+([.,]\d{1,2})?$/;
const AUSLAGE_DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BELEG_SIZE = 20 * 1024 * 1024;
const MAX_POSITIONEN = 25;

const uploadBelege = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BELEG_SIZE, files: MAX_POSITIONEN } });

export function createSpesenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/neu', (req, res) => {
    res.render('spesen-neu', {
      alleKonten: listKonten(db),
      values: { titel: '', positionen: [{}, {}] },
      errors: [],
    });
  });

  router.post('/', (req, res, next) => {
    // multer must run before csrfProtection: CSRF validation reads req.body._csrf, which only
    // exists once multer has parsed the multipart body — same ordering kontierung.js already
    // uses for its own multipart POST routes.
    uploadBelege.any()(req, res, (uploadErr) => {
      csrfProtection(req, res, async (csrfErr) => {
        if (uploadErr) return next(uploadErr);
        if (csrfErr) return next(csrfErr);
        try {
          const alleKonten = listKonten(db);
          const titel = (req.body.titel || '').trim() || null;
          const kontoIds = [].concat(req.body.posKontoId || []);
          const betraege = [].concat(req.body.posBetrag || []);
          const auslageDaten = [].concat(req.body.posAuslageDatum || []);
          const beschreibungen = [].concat(req.body.posBeschreibung || []);

          // Each row's Beleg input is renamed to a positional fieldname (posBeleg_<i>) by the
          // page's own JS right before submit — same trick kontierung-aufsplitten.ejs already
          // uses for its own per-row optional file, needed here because a plain shared fieldname
          // would silently misalign once any row's <input type="file"> submits nothing at all.
          const belegByIndex = new Map();
          for (const file of req.files || []) {
            const match = /^posBeleg_(\d+)$/.exec(file.fieldname);
            if (match) belegByIndex.set(Number(match[1]), file);
          }

          const positionen = kontoIds.map((kontoId, i) => ({
            kontoId,
            betrag: betraege[i] || '',
            auslageDatum: auslageDaten[i] || '',
            beschreibung: (beschreibungen[i] || '').trim(),
            beleg: belegByIndex.get(i) || null,
          }));

          const errors = [];
          const heute = new Date().toISOString().slice(0, 10);
          const aufgeloestePositionen = [];

          if (positionen.length === 0) {
            errors.push('Mindestens eine Position ist erforderlich.');
          }

          positionen.forEach((pos, i) => {
            const konto = alleKonten.find((k) => String(k.id) === pos.kontoId);
            if (!konto) {
              errors.push(`Position ${i + 1}: Bitte ein gültiges Konto wählen.`);
              return;
            }
            if (!BETRAG_PATTERN.test(pos.betrag)) {
              errors.push(`Position ${i + 1}: Bitte einen gültigen Betrag angeben.`);
              return;
            }
            if (!AUSLAGE_DATUM_PATTERN.test(pos.auslageDatum) || pos.auslageDatum > heute) {
              errors.push(`Position ${i + 1}: Bitte ein gültiges, nicht in der Zukunft liegendes Auslage-Datum angeben.`);
              return;
            }
            if (!pos.beschreibung) {
              errors.push(`Position ${i + 1}: Bitte einen Verwendungszweck angeben.`);
              return;
            }
            if (!pos.beleg) {
              errors.push(`Position ${i + 1}: Bitte einen Beleg hochladen.`);
              return;
            }
            const mimetype = detectBelegMimetype(pos.beleg.buffer);
            if (!mimetype || mimetype !== pos.beleg.mimetype) {
              errors.push(`Position ${i + 1}: Beleg muss eine PDF-, PNG- oder JPEG-Datei sein.`);
              return;
            }
            aufgeloestePositionen.push({ ...pos, konto, betrag: pos.betrag.replace(',', '.'), mimetype });
          });

          if (errors.length > 0) {
            return res.status(400).render('spesen-neu', { alleKonten, values: { titel: req.body.titel || '', positionen }, errors });
          }

          // File I/O happens before the DB transaction (mirrors kontierung.js's Aufsplitten
          // handler): better-sqlite3-style synchronous transactions can't hold an await open.
          mkdirSync(config.jobsDir, { recursive: true });
          const vorbereitetePositionen = [];
          for (const pos of aufgeloestePositionen) {
            const pdfBuffer = await buildBelegPdf(pos.beleg.buffer, pos.mimetype);
            const pdfPfad = join(config.jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
            writeFileSync(pdfPfad, pdfBuffer);
            let thumbnailPfad = null;
            try {
              const thumbnailPng = renderFirstPageThumbnail(pdfBuffer);
              thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
              writeFileSync(thumbnailPfad, thumbnailPng);
            } catch (err) {
              console.error(`Thumbnail-Rendering fehlgeschlagen für Spesen-Position (${pos.beleg.originalname}):`, err.message);
              thumbnailPfad = null;
            }
            vorbereitetePositionen.push({ ...pos, pdfPfad, thumbnailPfad });
          }

          const eingangAm = new Date().toISOString();
          const eingereichtVon = req.currentPerson.churchtools_person_id;
          const erstellteJobIds = [];
          const eskaliert = [];

          db.exec('BEGIN');
          try {
            const spesenabrechnungId = createSpesenabrechnung(db, { eingereichtVon, eingereichtAm: eingangAm, titel });
            for (const pos of vorbereitetePositionen) {
              const istSelbstFreigeber1 = pos.konto.freigeber1_id === eingereichtVon;
              const zugewiesenAn = istSelbstFreigeber1 ? pos.konto.stellvertreter1_id : pos.konto.freigeber1_id;
              const jobId = createSpesenPosition(db, {
                eingangAm,
                eingereichtVon,
                kontoId: pos.konto.id,
                betrag: pos.betrag,
                auslageDatum: pos.auslageDatum,
                beschreibung: pos.beschreibung,
                dateiname: pos.beleg.originalname,
                pdfPfad: pos.pdfPfad,
                thumbnailPfad: pos.thumbnailPfad,
                spesenabrechnungId,
                zugewiesenAn,
                freigabe1EskaliertVon: istSelbstFreigeber1 ? eingereichtVon : null,
                freigabe1Eskalationsgrund: istSelbstFreigeber1 ? 'Selbsteinreichung durch Freigeber1' : null,
              });
              erstellteJobIds.push(jobId);
              if (istSelbstFreigeber1) {
                createFreigabe(db, {
                  jobId,
                  personId: eingereichtVon,
                  rolle: 'freigabe1_eskalation',
                  zeitpunkt: eingangAm,
                  ip: req.ip,
                  interessenskonflikt: true,
                  kommentar: 'Selbsteinreichung durch Freigeber1',
                  eskaliertVon: null,
                });
                eskaliert.push({ jobId, konto: pos.konto });
              }
            }
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }

          for (const jobId of erstellteJobIds) {
            const job = getJobById(db, jobId);
            const konto = getKontoById(db, job.konto_id);
            const zustaendig = getPersonById(db, job.zugewiesen_an);
            if (!zustaendig) continue;
            const istEskaliert = eskaliert.some((e) => e.jobId === jobId);
            await sendNotification(db, mailer, {
              to: zustaendig.email,
              subject: istEskaliert
                ? 'Freigabeportal: Spesen-Position zur Prüfung — Selbsteinreichung durch Freigeber1'
                : 'Freigabeportal: Neue Spesen-Position zur Prüfung',
              text: `Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1): ${job.dateiname}${
                istEskaliert ? `\n\nGrund für die Zuweisung an dich: ${job.freigabe1_eskalationsgrund}` : ''
              }\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }

          res.redirect('/pool');
        } catch (err) {
          next(err);
        }
      });
    });
  });

  return router;
}
```

- [ ] **Step 4: Create `views/spesen-neu.ejs`**

Model it closely on `views/kontierung-aufsplitten.ejs`'s row-cloning/removal JS and layout, adapted for Spesen fields (Konto/Betrag/Auslage-Datum/Beschreibung/Beleg instead of Konto/Betrag/Position, and a required file input per row instead of an optional one):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Spesen einreichen — <%= branding.seitenTitel %></title>
</head>
<body>
  <%- include('_header', { navContainerClass: 'container-fluid px-4' }) %>
  <main class="container px-4 py-4">
    <h1 class="h3">Spesen einreichen</h1>

    <% if (errors.length > 0) { %>
      <div class="alert alert-danger"><ul class="mb-0"><% errors.forEach((e) => { %><li><%= e %></li><% }) %></ul></div>
    <% } %>

    <form method="post" action="/spesen" enctype="multipart/form-data">
      <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">

      <div class="mb-3">
        <label class="form-label" for="titel">Titel <span class="text-muted">(optional, z.B. "Reise Zürich 12.–14.8.")</span></label>
        <input type="text" class="form-control" id="titel" name="titel" value="<%= values.titel || '' %>">
      </div>

      <div id="positionen-container">
        <% values.positionen.forEach((pos) => { %>
          <div class="row g-2 mb-3 pb-3 border-bottom align-items-start position-zeile">
            <div class="col-md-3">
              <label class="form-label small">Konto</label>
              <select class="form-select" name="posKontoId">
                <option value="">— Konto wählen —</option>
                <% alleKonten.forEach((k) => { %>
                  <option value="<%= k.id %>" <%= String(k.id) === pos.kontoId ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
                <% }) %>
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small">Betrag</label>
              <input type="text" inputmode="decimal" class="form-control" name="posBetrag" value="<%= pos.betrag || '' %>" placeholder="z.B. 61.75">
            </div>
            <div class="col-md-2">
              <label class="form-label small">Auslage-Datum</label>
              <input type="date" class="form-control" name="posAuslageDatum" value="<%= pos.auslageDatum || '' %>">
            </div>
            <div class="col-md-3">
              <label class="form-label small">Verwendungszweck</label>
              <input type="text" class="form-control" name="posBeschreibung" value="<%= pos.beschreibung || '' %>">
            </div>
            <div class="col-md-1">
              <label class="form-label small">Beleg</label>
              <input type="file" class="form-control position-beleg-input" accept="application/pdf,image/png,image/jpeg" required>
            </div>
            <div class="col-md-1 d-flex align-items-end">
              <button type="button" class="btn btn-outline-danger btn-sm zeile-entfernen">Entfernen</button>
            </div>
          </div>
        <% }) %>
      </div>

      <button type="button" id="zeile-hinzufuegen" class="btn btn-outline-secondary btn-sm mb-3">+ Position hinzufügen</button>

      <div>
        <button type="submit" class="btn btn-primary">Einreichen</button>
      </div>
    </form>
  </main>

  <script>
    (function () {
      var kontoOptionsHtml = document.querySelector('.position-zeile select').innerHTML;

      function zeileEntfernenBinden(zeile) {
        zeile.querySelector('.zeile-entfernen').addEventListener('click', function () {
          zeile.remove();
        });
      }

      document.querySelectorAll('.position-zeile').forEach(zeileEntfernenBinden);

      document.getElementById('zeile-hinzufuegen').addEventListener('click', function () {
        var zeile = document.createElement('div');
        zeile.className = 'row g-2 mb-3 pb-3 border-bottom align-items-start position-zeile';
        zeile.innerHTML =
          '<div class="col-md-3"><label class="form-label small">Konto</label>' +
          '<select class="form-select" name="posKontoId"><option value="">— Konto wählen —</option>' + kontoOptionsHtml + '</select></div>' +
          '<div class="col-md-2"><label class="form-label small">Betrag</label>' +
          '<input type="text" inputmode="decimal" class="form-control" name="posBetrag" placeholder="z.B. 61.75"></div>' +
          '<div class="col-md-2"><label class="form-label small">Auslage-Datum</label>' +
          '<input type="date" class="form-control" name="posAuslageDatum"></div>' +
          '<div class="col-md-3"><label class="form-label small">Verwendungszweck</label>' +
          '<input type="text" class="form-control" name="posBeschreibung"></div>' +
          '<div class="col-md-1"><label class="form-label small">Beleg</label>' +
          '<input type="file" class="form-control position-beleg-input" accept="application/pdf,image/png,image/jpeg" required></div>' +
          '<div class="col-md-1 d-flex align-items-end"><button type="button" class="btn btn-outline-danger btn-sm zeile-entfernen">Entfernen</button></div>';
        document.getElementById('positionen-container').appendChild(zeile);
        zeileEntfernenBinden(zeile);
      });

      // Rename each row's file input to a positional fieldname right before submit, matching
      // current DOM order — native <input type="file"> with nothing selected is omitted
      // entirely from the multipart body, so positional array alignment (req.files vs.
      // posKontoId[i]) can't be relied on otherwise. Same trick as kontierung-aufsplitten.ejs.
      document.querySelector('form[action="/spesen"]').addEventListener('submit', function () {
        document.querySelectorAll('.position-zeile').forEach(function (zeile, i) {
          var fileInput = zeile.querySelector('.position-beleg-input');
          if (fileInput) fileInput.name = 'posBeleg_' + i;
        });
      });
    })();
  </script>
  <%- include('_footer') %>
</body>
</html>
```

- [ ] **Step 5: Mount the router in `src/app.js`**

Add the import alongside the other `createXRouter` imports:

```js
import { createSpesenRouter } from './routes/spesen.js';
```

Add the mount line alongside `/kontierung`'s:

```js
app.use('/spesen', sessionLimiter, requireLogin(), createSpesenRouter({ db, config, mailer, csrfProtection }));
```

- [ ] **Step 6: Add the "Spesen einreichen" nav link so the form is reachable in a real browser session (minimal placeholder here — the full nav treatment is Task 10)**

Skip for now — Task 10 owns `_header.ejs`. Confirm instead via `npm run dev` (or whatever this repo's start script is) that `GET /spesen/neu` renders and `POST /spesen` redirects to `/pool` when submitted manually with a real session cookie (open two browser tabs logged in as different seeded test people, or use `curl` with a session cookie obtained via `/auth`). Note in your task-completion message which method you used.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/integration/spesen.test.js`
Expected: PASS. Then run `npm test` to confirm nothing else broke.

- [ ] **Step 8: Commit**

```bash
git add src/routes/spesen.js views/spesen-neu.ejs src/app.js test/integration/spesen.test.js
git commit -m "feat(spesen): add /spesen submission route and form"
```

---

### Task 8: `src/routes/spesenFreigabe1.js` + `views/spesen-freigabe1.ejs` — Freigabe 1 (review-only)

**Files:**
- Create: `src/routes/spesenFreigabe1.js`
- Create: `views/spesen-freigabe1.ejs`
- Modify: `src/app.js`
- Test: `test/integration/spesenFreigabe1.test.js`

**Interfaces:**
- Consumes: `getJobById`, `eskalierenFreigabe1`, `eskalierenFreigabe1AnAdmin`, `abschliessenFreigabe1`, `ablehnenJob`, `getEffectiveFreigeber2Id` (`jobsRepo.js`), `getKontoById` (`kontenRepo.js`), `createFreigabe`, `listFreigabenByJob` (`freigabenRepo.js`), `getPersonById` (`personenRepo.js`), `buildSignedDownloadUrl`, `PDF_PREVIEW_TTL_SECONDS` (`downloadUrl.js`), `sendNotification`, `resolveEmpfaenger` (`notify.js`), `buildAuditLog` (`auditLog.js`).
- Produces: `createSpesenFreigabe1Router({ db, config, mailer, csrfProtection }) → Router`, mounted at `/spesen-freigabe1`. `GET /spesen-freigabe1/:id`, `POST /spesen-freigabe1/:id` (`aktion=freigeben|ablehnen`, plus `interessenskonflikt`/`begruendung`).

- [ ] **Step 1: Write the failing integration tests**

Create `test/integration/spesenFreigabe1.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createSpesenPosition, getJobById } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createSpesenFreigabe1Router } from '../../src/routes/spesenFreigabe1.js';

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function testConfig() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', publicBaseUrl: 'https://portal.example.org' };
}

function buildTestApp(db, mailer, config = testConfig()) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const csrfProtection = (req, res, next) => {
    if (req.body?._csrf === 'valid-token') return next();
    return res.status(403).send('invalid csrf');
  };
  app.use((req, res, next) => {
    res.locals.csrfToken = 'valid-token';
    next();
  });
  app.use('/spesen-freigabe1', requireLogin(), createSpesenFreigabe1Router({ db, config, mailer, csrfProtection }));
  return app;
}

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: ['20'] });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '61.75', auslageDatum: '2026-08-20',
    beschreibung: 'Bahnticket', dateiname: 'ticket.pdf', pdfPfad: '/tmp/ticket.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  return { kontoId, jobId };
}

test('GET /spesen-freigabe1/:id 403s for someone the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '5');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /spesen-freigabe1/:id 200s and shows Beschreibung/Auslage-Datum/Eingereicht-von for the assigned Freigeber1', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/spesen-freigabe1/${jobId}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Bahnticket/);
  assert.match(res.text, /2026-08-20/);
  assert.match(res.text, /Ein Reicher/);
  db.close();
});

test('POST /spesen-freigabe1/:id freigeben (no conflict) moves the job to freigabe2 and notifies Freigeber2', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'nein', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(mailer.sent[0].to, 'f2@example.org');
  db.close();
});

test('POST /spesen-freigabe1/:id ablehnen sets status abgelehnt and notifies the submitter', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', aktion: 'ablehnen', begruendung: 'Kein Beleg lesbar' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgelehnt');
  assert.equal(job.ablehnungsgrund, 'Kein Beleg lesbar');
  assert.equal(mailer.sent[0].to, 'e@example.org');
  db.close();
});

test('POST /spesen-freigabe1/:id with a declared Interessenskonflikt escalates to Stellvertreter1', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'Verwandt mit der einreichenden Person', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen', 'must stay open, not auto-approve');
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(mailer.sent[0].to, 's1@example.org');
  db.close();
});

test('POST /spesen-freigabe1/:id escalates to the admin group when the Stellvertreter1 also declares a conflict', async () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedGrundlagen(db);
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'erster Konflikt', aktion: 'freigeben' });

  const res = await request(app)
    .post(`/spesen-freigabe1/${jobId}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({ _csrf: 'valid-token', interessenskonflikt: 'ja', begruendung: 'auch befangen', aktion: 'freigeben' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(mailer.sent.at(-1).to, 'f1@example.org', 'admin group resolves to person 1, the only seeded member of group 20');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/spesenFreigabe1.test.js`
Expected: FAIL — `src/routes/spesenFreigabe1.js` doesn't exist.

- [ ] **Step 3: Implement `src/routes/spesenFreigabe1.js`**

```js
import { Router } from 'express';
import {
  getJobById,
  eskalierenFreigabe1,
  eskalierenFreigabe1AnAdmin,
  abschliessenFreigabe1,
  ablehnenJob,
  getEffectiveFreigeber2Id,
} from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';
import { buildAuditLog } from '../services/auditLog.js';

export function createSpesenFreigabe1Router({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function isSuperadmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.quelle !== 'spesen' || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Für diese Spesen-Position ist aktuell keine Freigabe 1 möglich.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isSuperadmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Diese Spesen-Position ist dir aktuell nicht zur Prüfung zugewiesen.' });
      return null;
    }
    return { job, konto: getKontoById(db, job.konto_id) };
  }

  function renderForm(req, res, status, { job, konto }, values, errors) {
    res.status(status).render('spesen-freigabe1', {
      job,
      konto,
      eingereichtePerson: getPersonById(db, job.eingereicht_von),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values,
      errors,
      auditLog: buildAuditLog(db, job.id),
    });
  }

  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  router.post('/:id', csrfProtection, async (req, res, next) => {
    try {
      const result = loadAuthorized(req, res);
      if (!result) return;
      const { job, konto } = result;
      const { aktion, interessenskonflikt, begruendung } = req.body;
      const hatKonflikt = interessenskonflikt === 'ja';
      const values = { interessenskonflikt: interessenskonflikt || '', begruendung: begruendung || '' };

      if ((hatKonflikt || aktion === 'ablehnen') && !begruendung) {
        return renderForm(req, res, 400, result, values, ['Begründung ist bei Interessenskonflikt oder Ablehnung Pflicht.']);
      }

      const zeitpunkt = new Date().toISOString();

      if (aktion === 'ablehnen') {
        db.exec('BEGIN');
        try {
          const abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (!abgelehnt) {
            db.exec('ROLLBACK');
            return res.status(409).render('error', { message: 'Diese Spesen-Position wurde inzwischen bereits bearbeitet.' });
          }
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt,
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
        const einreicher = getPersonById(db, job.eingereicht_von);
        if (einreicher) {
          await sendNotification(db, mailer, {
            to: einreicher.email,
            subject: 'Freigabeportal: Spesen-Position abgelehnt',
            text: `Deine Spesen-Position wurde abgelehnt: ${job.dateiname}\n\nBegründung: ${begruendung}`,
            typ: 'ablehnung',
            jobId: job.id,
          });
        }
        return res.redirect('/pool');
      }

      if (hatKonflikt) {
        const eskaliertAnAdmin = Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
        db.exec('BEGIN');
        try {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt,
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          if (eskaliertAnAdmin) {
            eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          } else {
            eskalierenFreigabe1(db, job.id, {
              eskaliertVon: req.currentPerson.churchtools_person_id,
              grund: begruendung,
              stellvertreterId: konto.stellvertreter1_id,
            });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        if (eskaliertAnAdmin) {
          for (const email of resolveEmpfaenger(db, config, 'gruppe:admin')) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – an Portal-Admin eskaliert',
              text: `Eine Spesen-Position wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        } else {
          const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
          if (stellvertreter1) {
            await sendNotification(db, mailer, {
              to: stellvertreter1.email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – Prüfung an dich übergeben',
              text: `Eine Spesen-Position wurde dir zur Prüfung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        }
        return res.redirect('/pool');
      }

      db.exec('BEGIN');
      try {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber1',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: begruendung || null,
          eskaliertVon: job.freigabe1_eskaliert_von,
        });
        abschliessenFreigabe1(db, job.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const aktualisierterJob = getJobById(db, job.id);
      const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(aktualisierterJob, konto));
      if (freigeber2) {
        await sendNotification(db, mailer, {
          to: freigeber2.email,
          subject: 'Freigabeportal: Neue Spesen-Position zur Freigabe 2',
          text: `Eine Spesen-Position wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
          typ: 'zuweisung',
          jobId: job.id,
        });
      }
      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Create `views/spesen-freigabe1.ejs`**

Model it on `views/freigabe2.ejs`'s two-column layout (PDF.js preview iframe left, details + form right, `_audit_log` included), swapping the invoice-specific fields for Spesen ones:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Spesen-Freigabe 1 — <%= branding.seitenTitel %></title>
</head>
<body>
  <%- include('_header', { navContainerClass: 'container-fluid px-4' }) %>
  <main class="container-fluid px-4 py-4">
    <div class="row">
      <div class="col-lg-6">
        <iframe id="spesen-freigabe1-preview-frame" class="pdf-preview" style="width:100%;height:80vh" data-preview-url="<%= previewUrl %>"></iframe>
      </div>
      <div class="col-lg-6 col-xl-4">
        <h1 class="h3">Spesen-Freigabe 1: <%= job.dateiname %></h1>
        <% if (job.freigabe1_eskaliert_von) { %>
          <p class="text-muted">Hinweis: dir zugewiesen — <%= job.freigabe1_eskalationsgrund %></p>
        <% } %>
        <p><strong>Konto:</strong> <%= konto.kontonummer %> — <%= konto.bezeichnung %></p>
        <p><strong>Betrag:</strong> <%= job.betrag %></p>
        <p><strong>Auslage-Datum:</strong> <%= job.auslage_datum %></p>
        <p><strong>Verwendungszweck:</strong> <%= job.beschreibung %></p>
        <p><strong>Eingereicht von:</strong> <%= eingereichtePerson ? `${eingereichtePerson.vorname} ${eingereichtePerson.nachname}` : 'Unbekannt' %></p>

        <div class="card">
          <div class="card-body">
            <form method="post" action="/spesen-freigabe1/<%= job.id %>">
              <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
              <div class="mb-3">
                <div class="form-check">
                  <input class="form-check-input" type="radio" name="interessenskonflikt" id="sf1konfliktNein" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>>
                  <label class="form-check-label" for="sf1konfliktNein">Kein Interessenskonflikt</label>
                </div>
                <div class="form-check">
                  <input class="form-check-input" type="radio" name="interessenskonflikt" id="sf1konfliktJa" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>>
                  <label class="form-check-label" for="sf1konfliktJa">Interessenskonflikt</label>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="sf1begruendung">Begründung <span class="text-muted">(bei Interessenskonflikt oder Ablehnung Pflicht)</span></label>
                <textarea class="form-control" id="sf1begruendung" name="begruendung"><%= values.begruendung || '' %></textarea>
              </div>
              <button type="submit" name="aktion" value="freigeben" class="btn btn-primary me-2">Freigeben</button>
              <button type="submit" name="aktion" value="ablehnen" class="btn btn-outline-danger">Ablehnen</button>
            </form>
          </div>
        </div>

        <%- include('_audit_log', { auditLog }) %>
      </div>
    </div>
  </main>

  <script>
    (function () {
      var frame = document.getElementById('spesen-freigabe1-preview-frame');
      var absoluteUrl = new URL(frame.dataset.previewUrl, window.location.origin).href;
      frame.src = '/vendor/pdfjs/web/viewer.html?file=' + encodeURIComponent(absoluteUrl);
    })();
  </script>
  <%- include('_footer') %>
</body>
</html>
```

- [ ] **Step 5: Mount the router in `src/app.js`**

Add the import:

```js
import { createSpesenFreigabe1Router } from './routes/spesenFreigabe1.js';
```

Add the mount line, alongside `/freigabe2`'s:

```js
app.use('/spesen-freigabe1', sessionLimiter, requireLogin(), createSpesenFreigabe1Router({ db, config, mailer, csrfProtection }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/integration/spesenFreigabe1.test.js`
Expected: PASS. Then run `npm test`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/spesenFreigabe1.js views/spesen-freigabe1.ejs src/app.js test/integration/spesenFreigabe1.test.js
git commit -m "feat(spesen): add /spesen-freigabe1 review-only route and view"
```

---

### Task 9: `freigabe2.ejs` + `_job_table.ejs` — `quelle`-conditional display

**Files:**
- Modify: `views/freigabe2.ejs`
- Modify: `views/_job_table.ejs`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- No new server-side interface — `freigabe2.js` needs no route changes (confirmed: its `stampData`/authorization logic never reads Lieferant/Rechnungsnummer/Zahlungsziel, so it's already quelle-agnostic).

- [ ] **Step 1: Write the failing test**

Add to `test/integration/freigabe2.test.js` (it already has helpers for seeding a Konto/job/person and driving `/freigabe2` — follow its existing conventions; import `createSpesenPosition` from `jobsRepo.js` and reuse the file's existing `seedGrundlagen`-style helper or write the position inline):

```js
test('GET /freigabe2/:id shows Verwendungszweck/Auslage-Datum/Eingereicht-von instead of Lieferant/Rechnungsnummer/Zahlungsziel for a Spesen position', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '5', kontoId, betrag: '61.75', auslageDatum: '2026-08-20',
    beschreibung: 'Bahnticket', dateiname: 'ticket.pdf', pdfPfad: '/tmp/ticket.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '1', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-31T08:10:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '3');

  assert.equal(res.status, 200);
  assert.match(res.text, /Verwendungszweck/);
  assert.match(res.text, /Bahnticket/);
  assert.match(res.text, /Auslage-Datum/);
  assert.match(res.text, /2026-08-20/);
  assert.match(res.text, /Eingereicht von/);
  assert.match(res.text, /Ein Reicher/);
  assert.doesNotMatch(res.text, /Rechnungsnummer/);
  assert.doesNotMatch(res.text, /Zahlungsziel/);
  db.close();
});
```

(Adjust the import list and `buildTestApp`/`createFreigabe`/`createKonto`/`upsertPerson` calls to match whatever helpers `freigabe2.test.js` already defines at its top — reuse them rather than redefining.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — the current view always renders Lieferant/Rechnungsnummer/Zahlungsziel labels and never Verwendungszweck/Auslage-Datum/Eingereicht-von.

- [ ] **Step 3: Update `views/freigabe2.ejs`**

Replace the detail-fields block (the `Quelle:` line and the `Lieferant`/`Rechnungsnummer`/`Zahlungsziel` conditionals) with:

```ejs
<h1 class="h3">Freigabe 2: <%= job.dateiname %></h1>
<p class="text-muted">Quelle: <%= job.quelle === 'scanner' ? 'Scanner' : job.quelle === 'spesen' ? 'Spesen' : 'Lieferant' %><% if (job.absender) { %> · Absender: <%= job.absender %><% } %></p>
<p><strong>Konto:</strong> <%= konto.kontonummer %> — <%= konto.bezeichnung %></p>
<% if (job.quelle === 'spesen') { %>
  <p><strong>Verwendungszweck:</strong> <%= job.beschreibung %></p>
  <p><strong>Auslage-Datum:</strong> <%= job.auslage_datum %></p>
  <% const spesenEinreicher = getPersonById(db, job.eingereicht_von); %>
  <p><strong>Eingereicht von:</strong> <%= spesenEinreicher ? `${spesenEinreicher.vorname} ${spesenEinreicher.nachname}` : 'Unbekannt' %></p>
  <% if (job.betrag) { %><p><strong>Betrag:</strong> <%= job.betrag %></p><% } %>
<% } else { %>
  <% if (job.typ === 'gutschrift') { %><p><strong>Typ:</strong> Gutschrift</p><% } %>
  <% if (job.lieferant) { %><p><strong>Lieferant:</strong> <%= job.lieferant %></p><% } %>
  <% if (job.rechnungsnummer) { %><p><strong>Rechnungsnummer:</strong> <%= job.rechnungsnummer %></p><% } %>
  <% if (job.betrag) { %><p><strong>Betrag:</strong> <%= job.betrag %></p><% } %>
  <% if (job.zahlungsziel) { %><p><strong>Zahlungsziel:</strong> <%= job.zahlungsziel %></p><% } %>
<% } %>
```

`getPersonById`/`db` are not currently passed into this view — instead of adding them as template locals (inconsistent with how every other lookup in this view arrives pre-resolved), resolve the submitter server-side in `freigabe2.js`'s `renderForm` and pass it as a new `spesenEinreicher` local:

In `src/routes/freigabe2.js`, inside `renderForm`, add right before the `res.status(status).render(...)` call:

```js
    const spesenEinreicher = job.quelle === 'spesen' ? getPersonById(db, job.eingereicht_von) : null;
```

and add `spesenEinreicher,` to the `res.render('freigabe2', { ... })` locals object. Then simplify the view snippet above to use the passed-in local instead of calling `getPersonById` directly:

```ejs
  <p><strong>Eingereicht von:</strong> <%= spesenEinreicher ? `${spesenEinreicher.vorname} ${spesenEinreicher.nachname}` : 'Unbekannt' %></p>
```

- [ ] **Step 4: Update the `Quelle` ternary in `views/_job_table.ejs`**

Change line 17:

```ejs
            <td><%= job.quelle === 'scanner' ? 'Scanner' : job.quelle === 'spesen' ? 'Spesen' : 'Lieferant' %></td>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS. Then run `npm test`.

- [ ] **Step 6: Commit**

```bash
git add views/freigabe2.ejs views/_job_table.ejs src/routes/freigabe2.js test/integration/freigabe2.test.js
git commit -m "feat(spesen): show Spesen-specific fields on the reused Freigabe-2 review page"
```

---

### Task 10: Navigation — `_header.ejs`, `poolPage.js`, `pool.ejs`, new `_spesen_meine_tabelle.ejs`

**Files:**
- Modify: `views/_header.ejs`
- Modify: `src/routes/poolPage.js`
- Modify: `views/pool.ejs`
- Create: `views/_spesen_meine_tabelle.ejs`
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `listSpesenFreigabe1JobsForPerson`, `listSpesenForEinreicher`, `listAdminEskalierteSpesenFreigaben` (Task 4).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/poolPage.test.js` (reuse its existing `buildTestApp`/`seedBuchhaltungPerson`/`seedPortalAdminPerson` helpers; import `createKonto`, `createSpesenPosition`, `ablehnenJob`, `eskalierenFreigabe1AnAdmin` alongside its existing imports):

```js
test('GET /pool shows a Spesen-Freigabe1 job under "Meine offenen Spesen-Freigaben" with a Prüfen link to /spesen-freigabe1', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  upsertPerson(db, { id: '60', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '60', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '50', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.match(res.text, /Meine offenen Spesen-Freigaben/);
  assert.match(res.text, /href="\/spesen-freigabe1\/\d+"/);
  db.close();
});

test('GET /pool shows every Spesen job the current person submitted under "Meine Spesen", including rejected ones', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  upsertPerson(db, { id: '60', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });
  const abgelehntId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '60', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '50', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  ablehnenJob(db, abgelehntId, { abgelehntVon: '50', grund: 'Kein Beleg' });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '60');
  assert.match(res.text, /Meine Spesen/);
  assert.match(res.text, /Taxi/);
  assert.match(res.text, /Kein Beleg/);
  db.close();
});

test('GET /pool shows an admin-escalated Spesen position under a Superadmin-only section linking to /spesen-freigabe1', async () => {
  const db = openDatabase(':memory:');
  seedPortalAdminPerson(db, '99');
  upsertPerson(db, { id: '50', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  upsertPerson(db, { id: '60', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '50', stellvertreter1Id: '51', freigeber2Id: '52', stellvertreter2Id: '53' });
  const jobId = createSpesenPosition(db, {
    eingangAm: '2026-08-31T08:00:00.000Z', eingereichtVon: '60', kontoId, betrag: '10.00', auslageDatum: '2026-08-20',
    beschreibung: 'Taxi', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf', thumbnailPfad: null, spesenabrechnungId: 1,
    zugewiesenAn: '50', freigabe1EskaliertVon: null, freigabe1Eskalationsgrund: null,
  });
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '50', grund: 'Befangen' });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '99');
  assert.match(res.text, /An Superadmin eskalierte Spesen-Freigaben/);
  assert.match(res.text, new RegExp(`href="/spesen-freigabe1/${jobId}"`));
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — the three new sections don't exist yet.

- [ ] **Step 3: Wire the three new queries into `poolPage.js`**

In `src/routes/poolPage.js`, extend the `jobsRepo.js` import:

```js
import {
  listPoolJobs,
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listAbgelehntJobsForPerson,
  listAdminEskalierteKontierungen,
  listAdminEskalierteFreigaben,
  listAdminEskalierteSpesenFreigaben,
  listAbgeschlossenJobsForPerson,
  listSpesenFreigabe1JobsForPerson,
  listSpesenForEinreicher,
} from '../db/jobsRepo.js';
```

Extend the `router.get('/', ...)` handler's rendered locals:

```js
    res.render('pool', {
      poolJobs: zeigtPool ? enrich(listPoolJobs(db)) : [],
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineSpesenFreigaben: enrich(listSpesenFreigabe1JobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
      meineSpesen: enrich(listSpesenForEinreicher(db, personId)),
      adminEskalierteKontierungen: istSuperadmin ? enrich(listAdminEskalierteKontierungen(db)) : [],
      adminEskalierteFreigaben: istSuperadmin ? enrich(listAdminEskalierteFreigaben(db)) : [],
      adminEskalierteSpesenFreigaben: istSuperadmin ? enrich(listAdminEskalierteSpesenFreigaben(db)) : [],
      meineAbgeschlossenen: listAbgeschlossenJobsForPerson(db, personId),
    });
```

- [ ] **Step 4: Add the "Meine offenen Spesen-Freigaben" and admin-escalation sections to `views/pool.ejs`**

Add right after the existing "An Superadmin eskalierte Freigaben" block (inside the same `isSuperadmin` conditional):

```ejs
      <h2 class="h4 mt-4">An Superadmin eskalierte Spesen-Freigaben</h2>
      <%- include('_job_table', { jobs: adminEskalierteSpesenFreigaben, idPrefix: 'admin-eskalation-spesen-freigabe', linkPrefix: '/spesen-freigabe1', aktionLabel: 'Prüfen', leerText: 'Keine an Superadmin eskalierten Spesen-Freigaben.' }) %>
```

Add right after the "Meine offenen Kontierungen" block:

```ejs
    <h2 class="h4 mt-4">Meine offenen Spesen-Freigaben</h2>
    <%- include('_job_table', { jobs: meineSpesenFreigaben, idPrefix: 'spesen-freigabe1', linkPrefix: '/spesen-freigabe1', aktionLabel: 'Prüfen', leerText: 'Keine offenen Spesen-Freigaben.' }) %>
```

Add right after the "Meine abgelehnten Jobs" block:

```ejs
    <h2 class="h4 mt-4">Meine Spesen</h2>
    <%- include('_spesen_meine_tabelle', { jobs: meineSpesen }) %>
```

- [ ] **Step 5: Create `views/_spesen_meine_tabelle.ejs`**

Modeled on `views/_abgeschlossen_table.ejs` (a status-overview table with no action link):

```html
<% if (jobs.length === 0) { %>
  <p>Keine eigenen Spesen-Einreichungen.</p>
<% } else { %>
  <div class="table-responsive">
    <table class="table align-middle">
      <thead><tr><th>Eingereicht am</th><th>Konto</th><th>Betrag</th><th>Verwendungszweck</th><th>Status</th></tr></thead>
      <tbody>
        <% jobs.forEach((job) => { %>
          <tr id="spesen-meine-row-<%= job.id %>">
            <td><%= job.eingang_am %></td>
            <td><%= job.kontonummer || '—' %></td>
            <td><%= job.betrag %></td>
            <td><%= job.beschreibung %></td>
            <td>
              <%= job.status %>
              <% if (job.status === 'abgelehnt' && job.ablehnungsgrund) { %>
                — <%= job.ablehnungsgrund %>
              <% } %>
            </td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>
<% } %>
```

- [ ] **Step 6: Add the "Spesen einreichen" nav entry to `views/_header.ejs`**

In the dropdown `<ul class="dropdown-menu" ...>`, right after the "Aufgaben" `<li>` (this entry is `requireLogin()`-level, visible to every logged-in person, same as "Aufgaben"/"Zeitstempel prüfen" — no `navHatAdminZugang` gate):

```ejs
          <li><a class="dropdown-item<%= navAktuellerPfad === '/spesen/neu' ? ' active' : '' %>" href="/spesen/neu">Spesen einreichen</a></li>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS. Then run `npm test`.

- [ ] **Step 8: Commit**

```bash
git add views/_header.ejs src/routes/poolPage.js views/pool.ejs views/_spesen_meine_tabelle.ejs test/integration/poolPage.test.js
git commit -m "feat(spesen): add Spesen navigation entry and Pool-dashboard sections"
```

---

### Task 11: n8n-Abholung — Response-Mapper-Erweiterung + Live-IBAN-Abruf

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Test: `test/integration/n8n` (find the existing `abholbereit`-focused test file in that directory and extend it — likely `jobs.test.js` or `abholbereit.test.js`; confirm the exact filename with `ls test/integration/n8n` before editing)

**Interfaces:**
- Consumes: `extractCustomFieldValue`, `fetchPersonById` (Task 6, `churchtools.js`), `normalizeIban` (`ibanUtils.js`).
- Produces: the `GET /api/n8n/jobs/abholbereit` response's per-job payload now includes `quelle`, `eingereicht_von`, `auslage_datum`, `beschreibung`, `iban`, `kontoinhaber`.

- [ ] **Step 1: Inspect the existing test file and write the failing tests**

Run `ls test/integration/n8n` and open the file covering `GET /abholbereit` to see its existing `buildTestApp`/seeding helpers, then add tests following its conventions:

```js
test('GET /api/n8n/jobs/abholbereit includes quelle, eingereicht_von, auslage_datum and beschreibung for a Spesen position', async () => {
  // ... seed a quelle='spesen' job (via createSpesenPosition) in an abholbereit-eligible status,
  // matching however this file's existing abholbereit tests get a job into that state (likely:
  // status 'abgeschlossen' with abgeschlossen_am set, or whatever listAbholbereitJobs requires).
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('x-api-key', apiKey);
  const entry = res.body.find((j) => j.id === jobId);
  assert.equal(entry.quelle, 'spesen');
  assert.equal(entry.eingereicht_von, '60');
  assert.equal(entry.auslage_datum, '2026-08-20');
  assert.equal(entry.beschreibung, 'Taxi');
});

test('GET /api/n8n/jobs/abholbereit includes a live-looked-up, normalized IBAN and Kontoinhaber for a Spesen position', async () => {
  // Mock ChurchTools's GET /api/persons/:id (via setupMockChurchTools, same helper churchtools.test.js
  // uses) to return customFields matching config.churchtools.customFieldIban/customFieldKontoinhaber,
  // with a raw IBAN containing spaces (e.g. 'CH93 0076 2011 6238 5295 7') to prove normalizeIban runs.
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('x-api-key', apiKey);
  const entry = res.body.find((j) => j.id === jobId);
  assert.equal(entry.iban, 'CH9300762011623852957');
  assert.equal(entry.kontoinhaber, 'Max Muster');
});

test('GET /api/n8n/jobs/abholbereit returns iban: null for a Spesen position when the ChurchTools lookup fails, without failing the whole request', async () => {
  // Mock GET /api/persons/:id to 500 (or don't intercept it at all, forcing a network error).
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('x-api-key', apiKey);
  assert.equal(res.status, 200);
  const entry = res.body.find((j) => j.id === jobId);
  assert.equal(entry.iban, null);
});

test('GET /api/n8n/jobs/abholbereit omits quelle/eingereicht_von-style Spesen fields as null for a Lieferant job', async () => {
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('x-api-key', apiKey);
  const entry = res.body.find((j) => j.quelle === 'lieferant');
  assert.equal(entry.eingereicht_von, null);
  assert.equal(entry.iban, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/n8n/<the file you found>.test.js`
Expected: FAIL — the mapper doesn't include these fields yet.

- [ ] **Step 3: Extend the `GET /abholbereit` mapper**

In `src/routes/n8n/jobs.js`, add the two new imports:

```js
import { fetchPersonById, extractCustomFieldValue } from '../../services/churchtools.js';
import { normalizeIban } from '../../services/ibanUtils.js';
```

Change the `GET /abholbereit` handler to build the per-job payload with an async IBAN lookup for Spesen positions (it currently uses a synchronous `.map()`; switch to sequential `for...of` + `Promise.all` since the handler needs to `await` a ChurchTools call per Spesen job — mirror the defensive, non-throwing style already used for thumbnail/QR best-effort steps elsewhere in this file):

```js
  router.get('/abholbereit', async (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const jobs = listAbholbereitJobs(db, undefined, nurMitZeitstempel);
    const einzelPayload = await Promise.all(
      jobs.map(async (job) => {
        const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
        let iban = null;
        let kontoinhaber = null;
        if (job.quelle === 'spesen' && job.eingereicht_von) {
          try {
            const person = await fetchPersonById(config.churchtools, config.churchtools.syncServiceToken, job.eingereicht_von);
            const ibanRoh = extractCustomFieldValue(person, config.churchtools.customFieldIban);
            iban = ibanRoh ? normalizeIban(ibanRoh) : null;
            kontoinhaber = extractCustomFieldValue(person, config.churchtools.customFieldKontoinhaber);
          } catch (err) {
            // A single unresolvable ChurchTools person must not block the whole Abholung
            // response — n8n gets iban: null for this one job and decides itself how to handle
            // a missing IBAN (e.g. skip and retry later), same tolerance-of-partial-failure
            // pattern as this file's own thumbnail/QR best-effort steps.
            console.error(`IBAN-Abruf fehlgeschlagen für Spesen-Position ${job.id}:`, err.message);
          }
        }
        return {
          id: job.id,
          eingang_am: job.eingang_am,
          quelle: job.quelle,
          absender: job.absender,
          lieferant: job.lieferant,
          rechnungsnummer: job.rechnungsnummer,
          betrag: job.betrag,
          zahlungsziel: job.zahlungsziel,
          dateiname: job.dateiname,
          konto_id: job.konto_id,
          konto_kontonummer: konto?.kontonummer ?? null,
          konto_bezeichnung: konto?.bezeichnung ?? null,
          eingereicht_von: job.eingereicht_von,
          auslage_datum: job.auslage_datum,
          beschreibung: job.beschreibung,
          iban,
          kontoinhaber,
          qr_iban: job.qr_iban,
          qr_referenz: job.qr_referenz,
          qr_betrag: job.qr_betrag,
          qr_waehrung: job.qr_waehrung,
          qr_creditor_name: job.qr_creditor_name,
          qr_erkannt_am: job.qr_erkannt_am,
          download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
        };
      })
    );

    // ... gruppenPayload block stays unchanged (Splitgruppen are never quelle='spesen' — see
    // spec's "Bewusst nicht Teil dieser Spec": no mixed or Spesen-only Splitgruppen exist) ...

    res.json([...einzelPayload, ...gruppenPayload]);
  });
```

Keep the existing `gruppenPayload` block exactly as-is below this — Splitgruppen are inherently invoice-only per the spec, so no IBAN/Spesen fields are needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/n8n/<the file you found>.test.js`
Expected: PASS. Then run `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n
git commit -m "feat(spesen): include Spesen fields and live IBAN/Kontoinhaber lookup in n8n abholbereit response"
```

---

### Task 12: End-to-end integration test — full Spesen workflow

**Files:**
- Create: `test/integration/spesenWorkflowEndToEnd.test.js`

**Interfaces:**
- Consumes: everything built in Tasks 1–11. This task adds no new production code — it's a regression net proving the full chain works together the way the unit/route tests (which each mock/stub the app around a single router) can't fully prove.

- [ ] **Step 1: Write the end-to-end test**

Copy `test/integration/freigabeWorkflowEndToEnd.test.js`'s `testConfig`/`loginAs` helpers verbatim (real `createApp()`, real `/auth/login`+`/auth/callback` OAuth flow mocked via `setupMockChurchTools`/`client.intercept`) — this plan's Task 7/8 tests use a lighter fake-session `buildTestApp` for speed, but this end-to-end file exists specifically to prove the real app wiring (`app.js`'s actual router mounts, the real CSRF middleware, a real OAuth login) works end-to-end, so it must drive the real app the same way `freigabeWorkflowEndToEnd.test.js` already does — not the lighter fake-session helper:

```js
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
import { fetchCsrfToken } from '../helpers/csrf.js';

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
      customFieldIban: 'IBAN',
      customFieldKontoinhaber: 'Kontoinhaber',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

// Identical to freigabeWorkflowEndToEnd.test.js's loginAs — logs a person in through the real
// /auth/login + /auth/callback flow, mocking exactly the ChurchTools calls that flow makes.
async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
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

function seedGrundlagen(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stell', nachname: 'Vertreter2', email: 's2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '5', vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [], loggedInNow: false });
  return createKonto(db, { kontonummer: '1000', bezeichnung: 'Reisespesen', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('a Spesen position walks the full path: Einreichung -> Freigabe1 -> Freigabe2 -> abholbereit with IBAN', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'spesen-e2e-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const kontoId = seedGrundlagen(db);
  const pdf = await buildPdfFixture(['Bahnticket']);

  const einreicherAgent = await loginAs(app, client, { id: 5, vorname: 'Ein', nachname: 'Reicher', email: 'e@example.org', gruppen: [] });
  const einreichenToken = await fetchCsrfToken(einreicherAgent, '/spesen/neu');
  const einreichenRes = await einreicherAgent
    .post('/spesen')
    .field('_csrf', einreichenToken)
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '61.75')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Bahnticket')
    .attach('posBeleg_0', pdf, { filename: 'ticket.pdf', contentType: 'application/pdf' });
  assert.equal(einreichenRes.status, 302);
  assert.equal(einreichenRes.headers.location, '/pool');
  const jobId = db.prepare("SELECT id FROM jobs WHERE quelle = 'spesen'").get().id;

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  const freigeber1Token = await fetchCsrfToken(freigeber1Agent, `/spesen-freigabe1/${jobId}`);
  const freigabe1Res = await freigeber1Agent
    .post(`/spesen-freigabe1/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', aktion: 'freigeben', _csrf: freigeber1Token });
  assert.equal(freigabe1Res.status, 302);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'freigabe2');

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Frei', nachname: 'Geber2', email: 'f2@example.org', gruppen: [] });
  const freigeber2Token = await fetchCsrfToken(freigeber2Agent, `/freigabe2/${jobId}`);
  const freigabe2Res = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', _csrf: freigeber2Token });
  assert.equal(freigabe2Res.status, 302);
  const abgeschlossenerJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(abgeschlossenerJob.status, 'abgeschlossen');
  assert.ok(abgeschlossenerJob.abgeschlossen_am);

  client
    .intercept({ path: '/api/persons/5', method: 'GET' })
    .reply(200, {
      data: {
        id: 5,
        customFields: [
          { id: 30, name: 'IBAN', value: 'CH93 0076 2011 6238 5295 7' },
          { id: 31, name: 'Kontoinhaber', value: 'Ein Reicher' },
        ],
      },
    });
  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  const entry = abholbereitRes.body.find((j) => j.id === jobId);
  assert.equal(entry.quelle, 'spesen');
  assert.equal(entry.beschreibung, 'Bahnticket');
  assert.equal(entry.auslage_datum, '2026-08-20');
  assert.equal(entry.eingereicht_von, '5');
  assert.equal(entry.iban, 'CH9300762011623852957');
  assert.equal(entry.kontoinhaber, 'Ein Reicher');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a self-submitted Spesen position (submitter is the Konto\'s own Freigeber1) is reviewable only by Stellvertreter1, never by the submitter', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'spesen-e2e-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const kontoId = seedGrundlagen(db);
  const pdf = await buildPdfFixture(['Parkgebühr']);

  // Person 1 is this Konto's own Freigeber1 — submitting as person 1 must self-escalate to
  // person 2 (Stellvertreter1) rather than assigning the job to the submitter.
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Frei', nachname: 'Geber1', email: 'f1@example.org', gruppen: [] });
  const einreichenToken = await fetchCsrfToken(freigeber1Agent, '/spesen/neu');
  const einreichenRes = await freigeber1Agent
    .post('/spesen')
    .field('_csrf', einreichenToken)
    .field('posKontoId', String(kontoId))
    .field('posBetrag', '10.00')
    .field('posAuslageDatum', '2026-08-20')
    .field('posBeschreibung', 'Parkgebühr')
    .attach('posBeleg_0', pdf, { filename: 'beleg.pdf', contentType: 'application/pdf' });
  assert.equal(einreichenRes.status, 302);
  const jobId = db.prepare("SELECT id FROM jobs WHERE quelle = 'spesen'").get().id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(job.zugewiesen_an, '2', 'must reassign to Stellvertreter1, never the submitter');
  assert.equal(job.freigabe1_eskalationsgrund, 'Selbsteinreichung durch Freigeber1');

  const submitterViewRes = await freigeber1Agent.get(`/spesen-freigabe1/${jobId}`);
  assert.equal(submitterViewRes.status, 403, 'the submitter must never be able to review their own Freigabe1, even though they are the Konto\'s Freigeber1');

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stell', nachname: 'Vertreter1', email: 's1@example.org', gruppen: [] });
  const stellvertreter1Token = await fetchCsrfToken(stellvertreter1Agent, `/spesen-freigabe1/${jobId}`);
  const freigabe1Res = await stellvertreter1Agent
    .post(`/spesen-freigabe1/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '', aktion: 'freigeben', _csrf: stellvertreter1Token });
  assert.equal(freigabe1Res.status, 302);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'freigabe2');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails first for the right reason, then implement/fix until green**

Run: `node --test test/integration/spesenWorkflowEndToEnd.test.js`

If it fails on missing helper setup (not on the actual feature), fix the test scaffolding — every piece of production code it exercises was already built and unit/route-tested in Tasks 1–11, so a failure here should point at an integration seam (e.g. a route not mounted, a config field the app needs that this test's `testConfig()` forgot), not a new logic bug. If it does surface a genuine logic bug, fix it in the relevant Task's file and re-run that Task's own test file too before continuing.

Expected once scaffolding is right: PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions anywhere else in the suite.

- [ ] **Step 4: Commit**

```bash
git add test/integration/spesenWorkflowEndToEnd.test.js
git commit -m "test(spesen): add end-to-end coverage for the full Spesen-Einreichung workflow"
```

---

## Post-implementation checklist (manual, not automatable)

- [ ] Confirm Task 6's ChurchTools custom-field shape against the real instance (see Task 6's warning banner) before this ships to production; adjust `extractCustomFieldValue` if the real shape differs.
- [ ] Set `CT_CUSTOM_FIELD_IBAN`/`CT_CUSTOM_FIELD_KONTOINHABER` in the real `.env` before deploying — `loadConfig` will otherwise refuse to start (`required()`).
- [ ] Manually exercise `/spesen/neu` in a browser (dynamic row add/remove, image Beleg upload) once — Task 7's automated tests cover the server side but not real multipart-from-a-browser behavior of the rename-at-submit JS trick.
