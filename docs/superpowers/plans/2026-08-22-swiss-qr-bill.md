# Swiss-QR-Bill Auto-Erkennung & IBAN-Abgleich Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode the Swiss QR-Bill embedded in incoming invoice PDFs to prefill Betrag/Referenz/IBAN in the Kontierung form, and warn (mail + audit-log) when the decoded creditor IBAN doesn't match a Lieferant's on-file IBAN(s) — a fraud-detection signal, never an auto-routing one.

**Architecture:** A new pure SPC-payload parser (`src/services/qrBill.js`) is composed with a new mupdf+jsQR decode step (`src/services/qrBillScan.js`) and called once, non-fatally, at ingest (`POST /n8n/jobs`), storing results on new `jobs.qr_*` columns. A new `debitor_ibans` table (admin-managed + opt-in-learned) is compared against the decoded IBAN inside the existing Kontierung POST handler; the existing `zuweisungsregeln` (absender-based) auto-assignment is untouched and runs completely independently.

**Tech Stack:** Node.js (`type: module`), Express 4, `node:sqlite` (`DatabaseSync`), EJS views, `mupdf` (already a dependency), new dependency `jsqr`, new devDependencies `swissqrbill` + `pdfkit` (test fixtures only), Node's built-in `node:test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-08-22-swiss-qr-bill-design.md` — read it in full before starting; this plan implements it task-by-task and assumes its rationale (three-way absender/QR-IBAN reconciliation, Phase-1 "prefill only, never auto-routes" principle, mismatch-warns-but-never-blocks) as given.

## Global Constraints

- Node >=22.13.0, ESM (`"type": "module"`) — every new file uses `import`/`export`, no `require`.
- Test runner is `node --test 'test/**/*.test.js'` (`npm test`) — new tests are plain `node:test` files under `test/unit/` or `test/integration/`, following the exact conventions in the existing files of those directories (see each task).
- SQLite `CHECK` constraints cannot be widened with `ALTER TABLE` — any new allowed value for `freigaben.rolle` or `mail_log.typ` requires the table-rebuild migration pattern already established in `src/db/index.js`'s `migrateFreigabenTable`.
- QR/IBAN data must never auto-change a job's `status`, `konto_id`, or trigger a Freigabe — it is either a prefill suggestion or a non-blocking warning. Do not wire it into `createJob`'s auto-assignment path.
- German-language UI strings and DB/field naming (`snake_case` SQL columns, `camelCase` JS, German domain nouns like `Lieferant`/`Kontierung`/`Empfänger`) match the rest of the codebase — do not introduce English field names.
- Every new git commit follows this repo's existing commit style (imperative, one-paragraph rationale where non-obvious) — no `Co-Authored-By` requirement is imposed by this plan; follow whatever the executing session's own commit conventions are.

---

## Task 1: Schema & DB migrations

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js`
- Modify: `src/db/adminConfigRepo.js`
- Test: `test/unit/db.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `jobs` table gains columns `qr_iban`, `qr_referenz`, `qr_betrag`, `qr_waehrung`, `qr_creditor_name`, `qr_erkannt_am` (all `TEXT`, nullable). New table `debitor_ibans(id, debitor_id, iban UNIQUE, quelle, erstellt_am)`. `freigaben.rolle` CHECK gains `'iban_abweichung'`. `mail_log.typ` CHECK gains `'iban-warnung'`. `admin_config` DEFAULTS gains `iban_abweichung_empfaenger: 'gruppe:admin'`. All of this is consumed by every later task.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/db.test.js` (append at the end of the file):

```javascript
test('jobs table has the six qr_* columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['qr_iban', 'qr_referenz', 'qr_betrag', 'qr_waehrung', 'qr_creditor_name', 'qr_erkannt_am']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});

test('openDatabase adds the qr_* columns via ALTER TABLE to an existing on-disk database that predates them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eingang_am TEXT NOT NULL,
      quelle TEXT NOT NULL,
      absender TEXT,
      dateiname TEXT NOT NULL,
      pdf_pfad TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unzugewiesen'
    )
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const columns = migratedDb.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['qr_iban', 'qr_referenz', 'qr_betrag', 'qr_waehrung', 'qr_creditor_name', 'qr_erkannt_am']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected}`);
  }
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('debitor_ibans table exists with a UNIQUE constraint on iban', () => {
  const db = openDatabase(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('debitor_ibans'));
  db.close();
});

test('openDatabase rebuilds the freigaben table to widen its rolle CHECK constraint to include iban_abweichung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Frei', 'Geber', 'f@example.org');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      VALUES (1, '1', 'freigeber1', '2026-08-15T08:30:00.000Z', '1.2.3.4', 0, NULL, NULL);
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM freigaben WHERE id = 1').get();
  assert.equal(preserved.rolle, 'freigeber1', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
         VALUES (1, '1', 'iban_abweichung', '2026-08-15T09:00:00.000Z', '1.2.3.4', 0, 'QR-IBAN weicht ab', NULL)`
      )
      .run(),
    'the widened CHECK constraint must accept iban_abweichung'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the mail_log table to widen its typ CHECK constraint to include iban-warnung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL
    );
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
      VALUES ('zuweisung', 1, 'a@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T08:05:00.000Z');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM mail_log WHERE id = 1').get();
  assert.equal(preserved.empfaenger, 'a@example.org', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
         VALUES ('iban-warnung', 1, 'b@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T09:00:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept iban-warnung'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/unit/db.test.js` (or `node --test test/unit/db.test.js`)
Expected: FAIL — `qr_iban` etc. columns missing, `debitor_ibans` table missing, `iban_abweichung`/`iban-warnung` CHECK violations.

- [ ] **Step 3: Widen `src/db/schema.sql`**

In the `jobs` table definition, add six columns right after `datei_hash TEXT` (the last existing column, before the closing `);`):

```sql
  qr_iban TEXT,
  qr_referenz TEXT,
  qr_betrag TEXT,
  qr_waehrung TEXT,
  qr_creditor_name TEXT,
  qr_erkannt_am TEXT
```

In the `freigaben` table's `rolle` CHECK, add `'iban_abweichung'`:

```sql
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung')),
```

In the `mail_log` table's `typ` CHECK, add `'iban-warnung'`:

```sql
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung')),
```

Add a new table, right after the `debitoren` table definition (before `zuweisungsregeln`):

```sql
CREATE TABLE IF NOT EXISTS debitor_ibans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debitor_id INTEGER NOT NULL REFERENCES debitoren(id),
  iban TEXT NOT NULL UNIQUE,
  quelle TEXT NOT NULL CHECK (quelle IN ('manuell', 'bestaetigt')) DEFAULT 'manuell',
  erstellt_am TEXT NOT NULL
);
```

- [ ] **Step 4: Extend `src/db/index.js`**

Add the six new columns to `JOBS_TABLE_MIGRATIONS` (append entries):

```javascript
  { column: 'qr_iban', ddl: 'ALTER TABLE jobs ADD COLUMN qr_iban TEXT' },
  { column: 'qr_referenz', ddl: 'ALTER TABLE jobs ADD COLUMN qr_referenz TEXT' },
  { column: 'qr_betrag', ddl: 'ALTER TABLE jobs ADD COLUMN qr_betrag TEXT' },
  { column: 'qr_waehrung', ddl: 'ALTER TABLE jobs ADD COLUMN qr_waehrung TEXT' },
  { column: 'qr_creditor_name', ddl: 'ALTER TABLE jobs ADD COLUMN qr_creditor_name TEXT' },
  { column: 'qr_erkannt_am', ddl: 'ALTER TABLE jobs ADD COLUMN qr_erkannt_am TEXT' },
```

Update `migrateFreigabenTable`'s early-return check and the widened `CREATE TABLE` (the marker moves from `'freigabe1_eskalation'` to `'iban_abweichung'`, since a database that already has the escalation values but not `iban_abweichung` must still be rebuilt):

```javascript
function migrateFreigabenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'freigaben'").get();
  if (!tableSql || tableSql.sql.includes('iban_abweichung')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE freigaben RENAME TO freigaben_pre_iban_abweichung_rolle');
    db.exec(`
      CREATE TABLE freigaben (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung')),
        zeitpunkt TEXT NOT NULL,
        ip TEXT NOT NULL,
        interessenskonflikt INTEGER NOT NULL DEFAULT 0,
        kommentar TEXT,
        eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
      )
    `);
    db.exec(`
      INSERT INTO freigaben (id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von FROM freigaben_pre_iban_abweichung_rolle
    `);
    db.exec('DROP TABLE freigaben_pre_iban_abweichung_rolle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Add a new, analogous function for `mail_log` (same rebuild pattern), and call it from `openDatabase`:

```javascript
// Same rationale as migrateFreigabenTable above: mail_log.typ's CHECK constraint can't be
// widened with ALTER TABLE, so an already-running database that predates 'iban-warnung' needs
// its mail_log table rebuilt in place to accept the new value.
function migrateMailLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('iban-warnung')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_iban_warnung_typ');
    db.exec(`
      CREATE TABLE mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung')),
        job_id INTEGER REFERENCES jobs(id),
        empfaenger TEXT NOT NULL,
        betreff TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
        fehler_details TEXT,
        versucht_am TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_iban_warnung_typ
    `);
    db.exec('DROP TABLE mail_log_pre_iban_warnung_typ');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

```javascript
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateMailLogTable(db);
  return db;
}
```

- [ ] **Step 5: Add the new admin_config default**

In `src/db/adminConfigRepo.js`, add one line to `DEFAULTS` (anywhere, e.g. after `sync_fehler_empfaenger`):

```javascript
  iban_abweichung_empfaenger: 'gruppe:admin',
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- test/unit/db.test.js`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 7: Run the full test suite to check nothing else broke**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/index.js src/db/adminConfigRepo.js test/unit/db.test.js
git commit -m "feat: add QR-bill columns, debitor_ibans table, and widen freigaben/mail_log CHECK constraints"
```

---

## Task 2: `debitorIbanRepo.js` (IBAN↔Lieferant mapping CRUD)

**Files:**
- Create: `src/db/debitorIbanRepo.js`
- Test: `test/unit/debitorIbanRepo.test.js`

**Interfaces:**
- Consumes: `debitor_ibans` table from Task 1.
- Produces: `createDebitorIban(db, { debitorId, iban, quelle })`, `deleteDebitorIban(db, id)`, `getDebitorIbanById(db, id)`, `listDebitorIbansByDebitor(db, debitorId)`, `listDebitorIbansAll(db)`, `findDebitorIbanByIban(db, iban)` — consumed by Tasks 7, 8, 9.

- [ ] **Step 1: Write the failing test**

Create `test/unit/debitorIbanRepo.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createDebitor } from '../../src/db/debitorenRepo.js';
import {
  createDebitorIban,
  deleteDebitorIban,
  getDebitorIbanById,
  listDebitorIbansByDebitor,
  listDebitorIbansAll,
  findDebitorIbanByIban,
} from '../../src/db/debitorIbanRepo.js';

function seedDebitor(db, name = 'Muster AG') {
  return createDebitor(db, { name, kontoId: null });
}

test('createDebitorIban inserts and getDebitorIbanById reads it back', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012', quelle: 'manuell' });
  const row = getDebitorIbanById(db, id);
  assert.equal(row.iban, 'CH4431999123000889012');
  assert.equal(row.debitor_id, debitorId);
  assert.equal(row.quelle, 'manuell');
  db.close();
});

test('createDebitorIban defaults quelle to manuell when not given', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  assert.equal(getDebitorIbanById(db, id).quelle, 'manuell');
  db.close();
});

test('the iban UNIQUE constraint rejects a duplicate insert, even for a different debitor', () => {
  const db = openDatabase(':memory:');
  const debitorA = seedDebitor(db, 'A AG');
  const debitorB = seedDebitor(db, 'B AG');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  assert.throws(() => createDebitorIban(db, { debitorId: debitorB, iban: 'CH4431999123000889012' }));
  db.close();
});

test('deleteDebitorIban removes the row', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  const id = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  deleteDebitorIban(db, id);
  assert.equal(getDebitorIbanById(db, id), null);
  db.close();
});

test('listDebitorIbansByDebitor returns only that debitor's IBANs, sorted', () => {
  const db = openDatabase(':memory:');
  const debitorA = seedDebitor(db, 'A AG');
  const debitorB = seedDebitor(db, 'B AG');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH1234567890123456789' });
  createDebitorIban(db, { debitorId: debitorB, iban: 'CH9999999999999999999' });
  const rows = listDebitorIbansByDebitor(db, debitorA);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.debitor_id === debitorA));
  db.close();
});

test('listDebitorIbansAll returns every mapping', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  createDebitorIban(db, { debitorId, iban: 'CH1234567890123456789' });
  assert.equal(listDebitorIbansAll(db).length, 2);
  db.close();
});

test('findDebitorIbanByIban finds an existing mapping and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const debitorId = seedDebitor(db);
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  assert.ok(findDebitorIbanByIban(db, 'CH4431999123000889012'));
  assert.equal(findDebitorIbanByIban(db, 'CH0000000000000000000'), null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/debitorIbanRepo.test.js`
Expected: FAIL with "Cannot find module '../../src/db/debitorIbanRepo.js'".

- [ ] **Step 3: Write the implementation**

Create `src/db/debitorIbanRepo.js`:

```javascript
export function createDebitorIban(db, { debitorId, iban, quelle = 'manuell' }) {
  const result = db
    .prepare('INSERT INTO debitor_ibans (debitor_id, iban, quelle, erstellt_am) VALUES (?, ?, ?, ?)')
    .run(debitorId, iban, quelle, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function deleteDebitorIban(db, id) {
  db.prepare('DELETE FROM debitor_ibans WHERE id = ?').run(id);
}

export function getDebitorIbanById(db, id) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE id = ?').get(id) ?? null;
}

export function listDebitorIbansByDebitor(db, debitorId) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE debitor_id = ? ORDER BY iban').all(debitorId);
}

export function listDebitorIbansAll(db) {
  return db.prepare('SELECT * FROM debitor_ibans ORDER BY iban').all();
}

export function findDebitorIbanByIban(db, iban) {
  return db.prepare('SELECT * FROM debitor_ibans WHERE iban = ?').get(iban) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/debitorIbanRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/debitorIbanRepo.js test/unit/debitorIbanRepo.test.js
git commit -m "feat: add debitorIbanRepo for IBAN-to-Lieferant mappings"
```

---

## Task 3: `jobsRepo.setQrDaten`

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `jobs.qr_*` columns from Task 1.
- Produces: `setQrDaten(db, jobId, { qrIban, qrReferenz, qrBetrag, qrWaehrung, qrCreditorName })` — consumed by Task 6 (ingest wiring). Only ever called when a QR-bill was actually decoded; a job with no decodable QR simply never has this called, so its six `qr_*` columns (including `qr_erkannt_am`) stay `NULL`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/jobsRepo.test.js`:

```javascript
import { setQrDaten } from '../../src/db/jobsRepo.js'; // add to the existing jobsRepo import line instead if one already exists

test('setQrDaten stores the decoded QR-bill fields and sets qr_erkannt_am', () => {
  const db = openDatabase(':memory:');
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setQrDaten(db, id, {
    qrIban: 'CH4431999123000889012',
    qrReferenz: '210000000003139471430009017',
    qrBetrag: '1949.75',
    qrWaehrung: 'CHF',
    qrCreditorName: 'Muster AG',
  });
  const job = getJobById(db, id);
  assert.equal(job.qr_iban, 'CH4431999123000889012');
  assert.equal(job.qr_referenz, '210000000003139471430009017');
  assert.equal(job.qr_betrag, '1949.75');
  assert.equal(job.qr_waehrung, 'CHF');
  assert.equal(job.qr_creditor_name, 'Muster AG');
  assert.ok(job.qr_erkannt_am, 'qr_erkannt_am should be set');
  db.close();
});
```

(Check the top of `test/unit/jobsRepo.test.js` first — add `setQrDaten` to whatever existing `import { ... } from '../../src/db/jobsRepo.js'` line is there rather than creating a second import line for the same module.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `setQrDaten is not a function` / `qr_iban` undefined.

- [ ] **Step 3: Implement `setQrDaten`**

Add to `src/db/jobsRepo.js`, near `setThumbnailPfad` (same style — a narrow, single-purpose setter):

```javascript
export function setQrDaten(db, id, { qrIban, qrReferenz, qrBetrag, qrWaehrung, qrCreditorName }) {
  db.prepare(
    `UPDATE jobs SET qr_iban = ?, qr_referenz = ?, qr_betrag = ?, qr_waehrung = ?, qr_creditor_name = ?, qr_erkannt_am = ?
     WHERE id = ?`
  ).run(qrIban ?? null, qrReferenz ?? null, qrBetrag ?? null, qrWaehrung ?? null, qrCreditorName ?? null, new Date().toISOString(), id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add jobsRepo.setQrDaten for storing decoded QR-bill data"
```

---

## Task 4: `qrBill.js` — pure SPC-payload parser

**Files:**
- Create: `src/services/qrBill.js`
- Test: `test/unit/qrBill.test.js`

**Interfaces:**
- Consumes: nothing (pure function, operates on a decoded QR text string).
- Produces: `parseQrBillPayload(text)` → `{ iban, creditorName, betrag, waehrung, referenz } | null`. Consumed by Task 5 (`qrBillScan.js`).

**Context:** The Swiss QR-bill payload (SIX/SPC "Swiss Payments Code" text format embedded in the QR code) is a fixed-order, newline-separated list of fields. This task hand-derives the field order from the public spec; **Task 5's test generates a real payload via the `swissqrbill` library and is the authoritative cross-check** — if Task 5's test fails on field extraction, the line-index constants below are what's wrong and must be corrected there, not worked around.

- [ ] **Step 1: Write the failing test**

Create `test/unit/qrBill.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQrBillPayload } from '../../src/services/qrBill.js';

// 31 lines, in SPC payload order: header, version, coding type, IBAN, creditor address block
// (7 lines), ultimate-creditor block (7 lines, reserved/blank), amount, currency, ultimate-debtor
// block (7 lines), reference type, reference, unstructured message, trailer.
function buildSpcPayload(overrides = {}) {
  const lines = [
    'SPC', '0200', '1',
    overrides.iban ?? 'CH4431999123000889012',
    'S', overrides.creditorName ?? 'Muster AG', 'Musterstrasse', '7', '1234', 'Musterstadt', 'CH',
    '', '', '', '', '', '', '',
    overrides.betrag ?? '1949.75', overrides.waehrung ?? 'CHF',
    '', '', '', '', '', '', '',
    overrides.referenzTyp ?? 'QRR', overrides.referenz ?? '210000000003139471430009017',
    'Vielen Dank für Ihren Einkauf', 'EPD',
  ];
  return lines.join('\r\n');
}

test('parses a full QRR-referenced payload', () => {
  const result = parseQrBillPayload(buildSpcPayload());
  assert.deepEqual(result, {
    iban: 'CH4431999123000889012',
    creditorName: 'Muster AG',
    betrag: '1949.75',
    waehrung: 'CHF',
    referenz: '210000000003139471430009017',
  });
});

test('parses a SCOR-referenced payload', () => {
  const result = parseQrBillPayload(buildSpcPayload({ referenzTyp: 'SCOR', referenz: 'RF18539007547034' }));
  assert.equal(result.referenz, 'RF18539007547034');
});

test('parses a NON-referenced payload with referenz set to null', () => {
  const result = parseQrBillPayload(buildSpcPayload({ referenzTyp: 'NON', referenz: '' }));
  assert.equal(result.referenz, null);
});

test('parses a payload with no amount (betrag is null)', () => {
  const result = parseQrBillPayload(buildSpcPayload({ betrag: '' }));
  assert.equal(result.betrag, null);
});

test('returns null for text that is not a QR-bill payload at all', () => {
  assert.equal(parseQrBillPayload('irgendein anderer QR-Code-Inhalt'), null);
});

test('returns null for empty or missing text', () => {
  assert.equal(parseQrBillPayload(''), null);
  assert.equal(parseQrBillPayload(null), null);
});

test('returns null when the IBAN line is empty', () => {
  assert.equal(parseQrBillPayload(buildSpcPayload({ iban: '' })), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/qrBill.test.js`
Expected: FAIL with "Cannot find module '../../src/services/qrBill.js'".

- [ ] **Step 3: Write the implementation**

Create `src/services/qrBill.js`:

```javascript
// Line order per the Swiss "Style Guide QR-bill" (SIX/SPC v2.x) payload format embedded in a
// Swiss QR-Bill's QR code. Only the lines this parser actually reads are named; everything else
// (detailed creditor/debtor address lines, the still-reserved "Ultimate Creditor" block) is
// skipped over. Cross-checked against a real payload generated by the `swissqrbill` library in
// qrBillScan.test.js — if that test disagrees with the field extraction here, these indices are
// what's wrong.
const LINE = {
  HEADER: 0,
  IBAN: 3,
  CREDITOR_NAME: 5,
  AMOUNT: 18,
  CURRENCY: 19,
  REFERENCE_TYPE: 27,
  REFERENCE: 28,
};
const MIN_LINES = 31;
const EXPECTED_HEADER = 'SPC';

export function parseQrBillPayload(text) {
  if (!text) return null;
  const zeilen = text.split(/\r\n|\r|\n/);
  if (zeilen.length < MIN_LINES) return null;
  if (zeilen[LINE.HEADER].trim() !== EXPECTED_HEADER) return null;

  const iban = zeilen[LINE.IBAN].trim().toUpperCase();
  if (!iban) return null;

  const referenzTyp = zeilen[LINE.REFERENCE_TYPE].trim();
  const referenz = zeilen[LINE.REFERENCE].trim();
  const betrag = zeilen[LINE.AMOUNT].trim();
  const waehrung = zeilen[LINE.CURRENCY].trim();
  const creditorName = zeilen[LINE.CREDITOR_NAME].trim();

  return {
    iban,
    creditorName: creditorName || null,
    betrag: betrag || null,
    waehrung: waehrung || null,
    referenz: referenzTyp !== 'NON' && referenz ? referenz : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/qrBill.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/qrBill.js test/unit/qrBill.test.js
git commit -m "feat: add pure SPC/Swiss-QR-Bill payload parser"
```

---

## Task 5: `qrBillScan.js` — mupdf + jsQR decode from a PDF

**Files:**
- Modify: `package.json` (add `jsqr` dependency; add `swissqrbill` + `pdfkit` devDependencies)
- Create: `src/services/qrBillScan.js`
- Create: `test/helpers/qrBillFixture.js`
- Test: `test/unit/qrBillScan.test.js`

**Interfaces:**
- Consumes: `parseQrBillPayload` from Task 4 (`src/services/qrBill.js`); `mupdf` (existing dependency, same API as `src/services/thumbnail.js`); `jsqr` (new dependency).
- Produces: `scanQrBill(pdfBuffer)` → `{ iban, creditorName, betrag, waehrung, referenz } | null`. Consumed by Task 6 (ingest wiring).

- [ ] **Step 1: Add the dependencies**

```bash
npm install jsqr
npm install --save-dev swissqrbill pdfkit
```

Verify `package.json` now lists `"jsqr"` under `"dependencies"` and `"swissqrbill"` + `"pdfkit"` under `"devDependencies"`.

- [ ] **Step 2: Write the test fixture helper**

Create `test/helpers/qrBillFixture.js`:

```javascript
import PDFDocument from 'pdfkit';
import { SwissQRBill } from 'swissqrbill/pdf';

// Real Swiss QR-Bill PDF generator, used only in tests — produces a PDF with a genuine, scannable
// QR code so qrBillScan.js's mupdf+jsQR decode path is exercised against real bytes instead of a
// hand-mocked one. Mirrors the Buffer-returning convention of test/helpers/pdfFixture.js.
export async function buildQrBillPdfFixture(data, { onDocument } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    if (onDocument) onDocument(doc);
    new SwissQRBill(data).attachTo(doc);
    doc.end();
  });
}
```

- [ ] **Step 3: Write the failing test**

Create `test/unit/qrBillScan.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { scanQrBill } from '../../src/services/qrBillScan.js';
import { buildQrBillPdfFixture } from '../helpers/qrBillFixture.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

const QR_BILL_DATA = {
  amount: 1949.75,
  creditor: {
    account: 'CH4431999123000889012',
    address: 'Musterstrasse',
    buildingNumber: 7,
    city: 'Musterstadt',
    country: 'CH',
    name: 'Muster AG',
    zip: 1234,
  },
  currency: 'CHF',
  debtor: {
    address: 'Musterstrasse',
    buildingNumber: 1,
    city: 'Musterstadt',
    country: 'CH',
    name: 'Peter Muster',
    zip: 1234,
  },
  reference: '210000000003139471430009017',
};

test('scanQrBill decodes a real Swiss QR-bill PDF on page 1', async () => {
  const pdf = await buildQrBillPdfFixture(QR_BILL_DATA);
  const result = scanQrBill(pdf);
  assert.ok(result, 'expected a decoded QR-bill payload');
  assert.equal(result.iban, 'CH4431999123000889012');
  assert.equal(result.creditorName, 'Muster AG');
  assert.equal(result.betrag, '1949.75');
  assert.equal(result.waehrung, 'CHF');
  assert.equal(result.referenz, '210000000003139471430009017');
});

test('scanQrBill falls back to the last page when the QR-Code is not on page 1', async () => {
  const qrBillPdf = await buildQrBillPdfFixture(QR_BILL_DATA);

  const combined = await PdfLibDocument.create();
  combined.addPage([595, 842]); // blank cover page — no QR code here

  const qrDoc = await PdfLibDocument.load(qrBillPdf);
  const qrPages = await combined.copyPages(qrDoc, qrDoc.getPageIndices());
  qrPages.forEach((page) => combined.addPage(page));

  const pdf = Buffer.from(await combined.save());
  const result = scanQrBill(pdf);
  assert.ok(result, 'expected the QR-Code on a later page to be found via the last-page fallback');
  assert.equal(result.iban, 'CH4431999123000889012');
});

test('scanQrBill returns null for a PDF without any QR-Code', async () => {
  const pdf = await buildPdfFixture(['Ganz normale Rechnung ohne QR-Code']);
  assert.equal(scanQrBill(pdf), null);
});

test('scanQrBill throws a defined Error for a corrupt PDF, does not crash', () => {
  const corrupt = Buffer.from('%PDF-1.4\n%not-a-real-pdf-body\n');
  assert.throws(() => scanQrBill(corrupt), Error);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/unit/qrBillScan.test.js`
Expected: FAIL with "Cannot find module '../../src/services/qrBillScan.js'".

- [ ] **Step 5: Write the implementation**

Create `src/services/qrBillScan.js`:

```javascript
import * as mupdf from 'mupdf';
import jsQR from 'jsqr';
import { parseQrBillPayload } from './qrBill.js';

// Much higher than thumbnail.js's 200px preview width — a Swiss QR-Bill's code occupies roughly
// the bottom-left quarter of an A4 page, and jsQR needs real pixel resolution per module to
// decode reliably, especially for scanned (not born-digital) invoices.
const SCAN_WIDTH_PX = 1200;

function decodePageAsQrText(doc, pageIndex) {
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    const width = bounds[2] - bounds[0];
    const scale = SCAN_WIDTH_PX / width;
    // alpha=true (unlike thumbnail.js's alpha=false): jsQR requires RGBA pixel data.
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
    try {
      const pixels = pixmap.getPixels();
      const result = jsQR(pixels, pixmap.getWidth(), pixmap.getHeight());
      return result ? result.data : null;
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

export function scanQrBill(pdfBuffer) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  } catch (err) {
    throw new Error(`PDF konnte für die QR-Code-Erkennung nicht geöffnet werden: ${err.message}`);
  }
  try {
    const pageCount = doc.countPages();
    let qrText = decodePageAsQrText(doc, 0);
    if (!qrText && pageCount > 1) {
      qrText = decodePageAsQrText(doc, pageCount - 1);
    }
    if (!qrText) return null;
    return parseQrBillPayload(qrText);
  } finally {
    doc.destroy();
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/unit/qrBillScan.test.js`
Expected: PASS. If the first test's field assertions fail while a QR code is clearly being found (i.e., `result` is truthy but fields are wrong/shifted), the `LINE` index constants in `src/services/qrBill.js` (Task 4) are off by however many lines — correct them there and re-run both `qrBill.test.js` and `qrBillScan.test.js`.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/services/qrBillScan.js test/helpers/qrBillFixture.js test/unit/qrBillScan.test.js
git commit -m "feat: add qrBillScan (mupdf + jsQR) to decode Swiss QR-Bills from PDFs"
```

---

## Task 6: Wire QR decode into ingest (`POST /n8n/jobs`)

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Test: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `scanQrBill` (Task 5), `setQrDaten` (Task 3).
- Produces: every newly-ingested job has its `qr_*` columns populated when a QR-bill is found; unaffected (all `NULL`) otherwise. Consumed by Task 7 (Kontierung GET prefill).

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/n8n/jobs.test.js`:

```javascript
test('POST /api/n8n/jobs decodes a real Swiss QR-Bill PDF and stores the qr_* fields', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildQrBillPdfFixture } = await import('../../helpers/qrBillFixture.js');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const qrBillPdf = await buildQrBillPdfFixture({
    amount: 1949.75,
    creditor: { account: 'CH4431999123000889012', address: 'Musterstrasse', buildingNumber: 7, city: 'Musterstadt', country: 'CH', name: 'Muster AG', zip: 1234 },
    currency: 'CHF',
    debtor: { address: 'Musterstrasse', buildingNumber: 1, city: 'Musterstadt', country: 'CH', name: 'Peter Muster', zip: 1234 },
    reference: '210000000003139471430009017',
  });

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', qrBillPdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.qr_iban, 'CH4431999123000889012');
  assert.equal(job.qr_creditor_name, 'Muster AG');
  assert.equal(job.qr_betrag, '1949.75');
  assert.equal(job.qr_waehrung, 'CHF');
  assert.equal(job.qr_referenz, '210000000003139471430009017');
  assert.ok(job.qr_erkannt_am);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs still creates the job with qr_* columns null when the PDF has no QR-Code', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.qr_iban, null);
  assert.equal(job.qr_erkannt_am, null);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — `job.qr_iban` is `undefined`/`null` for the real-QR-bill case (nothing decodes it yet).

- [ ] **Step 3: Wire the decode step into `src/routes/n8n/jobs.js`**

Add the import at the top:

```javascript
import { scanQrBill } from '../../services/qrBillScan.js';
```

Add `setQrDaten` to the existing `jobsRepo.js` import line:

```javascript
import { createJob, getJobById, findJobByDateiHash, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setQrDaten } from '../../db/jobsRepo.js';
```

Right after the existing thumbnail `try/catch` block (after `setThumbnailPfad(db, id, thumbnailPfad);` / its `catch`), add a second, equally non-fatal block:

```javascript
        try {
          const qrDaten = scanQrBill(req.file.buffer);
          if (qrDaten) {
            setQrDaten(db, id, {
              qrIban: qrDaten.iban,
              qrReferenz: qrDaten.referenz,
              qrBetrag: qrDaten.betrag,
              qrWaehrung: qrDaten.waehrung,
              qrCreditorName: qrDaten.creditorName,
            });
          }
        } catch (err) {
          console.error(`QR-Code-Erkennung fehlgeschlagen für Job ${id}:`, err.message);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "feat: decode Swiss QR-Bill at ingest, non-fatally, alongside the thumbnail step"
```

---

## Task 7: Kontierung GET — QR prefill & three-way reconciliation

**Files:**
- Modify: `src/routes/kontierung.js`
- Modify: `views/kontierung.ejs`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `findDebitorIbanByIban`, `listDebitorIbansByDebitor` (Task 2); `job.qr_*` fields (Tasks 1, 6); `getDebitorById` (already imported in `kontierung.js`).
- Produces: a `qrInfo` object (or `null`) computed by a new `buildQrInfo(db, job)` helper and a `pruefeIbanAbgleich(db, debitorId, qrIban)` helper, both module-scope in `kontierung.js`. `qrInfo` is passed to every `res.render('kontierung', ...)` call (GET success, and — from Task 8 onward — POST error re-renders). `pruefeIbanAbgleich` is reused, unmodified, by Task 8's POST handler.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/kontierung.test.js` (reuse the file's existing `seedKontoAndPersonen`/`buildTestApp` helpers):

```javascript
test('GET /kontierung/:id shows the QR-decoded suggestion and prefills Betrag when no Betrag is saved yet', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: '210000000003139471430009017', qrBetrag: '1949.75', qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /CH4431999123000889012/);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, /value="1949\.75"/);
  db.close();
});

test('GET /kontierung/:id pre-selects a Lieferant found via QR-IBAN when no Absender-Regel assigned one', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { createDebitorIban } = await import('../../src/db/debitorIbanRepo.js');
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const debitorId = createDebitor(db, { name: 'Erkannte AG', kontoId: null });
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: null, qrWaehrung: null, qrCreditorName: 'Erkannte AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<option value="${debitorId}" selected>Erkannte AG</option>`));
  db.close();
});

test('GET /kontierung/:id warns when the QR-IBAN resolves to a different Lieferant than already assigned', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { createDebitorIban } = await import('../../src/db/debitorIbanRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const zugewiesenerDebitor = createDebitor(db, { name: 'Zugewiesen AG', kontoId });
  const erkannterDebitor = createDebitor(db, { name: 'Erkannte AG', kontoId: null });
  createDebitorIban(db, { debitorId: erkannterDebitor, iban: 'CH4431999123000889012' });
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  updateKontierungMetadaten(db, id, { absender: null, betrag: null, zahlungsziel: null, rechnungsnummer: null, lieferant: 'Zugewiesen AG', debitorId: zugewiesenerDebitor });
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: null, qrWaehrung: null, qrCreditorName: 'Erkannte AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Erkannte AG/);
  assert.match(res.text, /bitte prüfen/i);
  db.close();
});

test('GET /kontierung/:id shows no QR box at all when no QR-Code was decoded', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Aus QR-Code erkannt/);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — no `qrInfo`/QR box rendered yet.

- [ ] **Step 3: Add the reconciliation helpers and wire them into the GET handler in `src/routes/kontierung.js`**

Add to the imports at the top:

```javascript
import { findDebitorIbanByIban, listDebitorIbansByDebitor } from '../db/debitorIbanRepo.js';
```

Add two module-scope helper functions (place them near the top of the file, after `neuerDateipfad`, before `createKontierungRouter`):

```javascript
function pruefeIbanAbgleich(db, debitorId, qrIban) {
  const hinterlegte = listDebitorIbansByDebitor(db, debitorId);
  if (hinterlegte.length === 0) return { status: 'kein_abgleich' };
  return { status: hinterlegte.some((row) => row.iban === qrIban) ? 'match' : 'mismatch' };
}

function buildQrInfo(db, job) {
  if (!job.qr_erkannt_am) return null;
  const ibanMapping = job.qr_iban ? findDebitorIbanByIban(db, job.qr_iban) : null;
  const vorschlagDebitor = ibanMapping ? getDebitorById(db, ibanMapping.debitor_id) : null;
  const debitorFuerAbgleich = job.debitor_id ? getDebitorById(db, job.debitor_id) : vorschlagDebitor;
  const abgleich = job.qr_iban && debitorFuerAbgleich ? pruefeIbanAbgleich(db, debitorFuerAbgleich.id, job.qr_iban) : null;
  return {
    iban: job.qr_iban,
    referenz: job.qr_referenz,
    betrag: job.qr_betrag,
    waehrung: job.qr_waehrung,
    creditorName: job.qr_creditor_name,
    vorschlagDebitor,
    debitorFuerAbgleich,
    konfliktMitZugewiesenemDebitor: Boolean(vorschlagDebitor) && Boolean(job.debitor_id) && vorschlagDebitor.id !== job.debitor_id,
    abgleich,
  };
}
```

Inside `createKontierungRouter`, update the `GET /:id` handler:

```javascript
  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = ladeKontenFuerJob(req, job);
    const qrInfo = buildQrInfo(db, job);
    res.render('kontierung', {
      job,
      konten,
      debitoren: listDebitoren(db),
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values: {
        kontoId: job.konto_id ? String(job.konto_id) : '',
        interessenskonflikt: '',
        begruendung: '',
        absender: job.absender || '',
        betrag: job.betrag || (qrInfo ? qrInfo.betrag || '' : ''),
        zahlungsziel: job.zahlungsziel || '',
        rechnungsnummer: job.rechnungsnummer || '',
        debitorId: job.debitor_id ? String(job.debitor_id) : (qrInfo && qrInfo.vorschlagDebitor ? String(qrInfo.vorschlagDebitor.id) : ''),
      },
      qrInfo,
      errors: [],
      auditLog: buildAuditLog(db, job.id),
    });
  });
```

- [ ] **Step 4: Render the QR info in `views/kontierung.ejs`**

Add, right after the opening `<div class="card-body">` and before the existing `<% if (errors.length > 0) { %>` block. Every check is guarded with `typeof qrInfo !== 'undefined'` (same defensive pattern as `_audit_log.ejs`'s `typeof auditLog !== 'undefined'`) — this view is also rendered from the POST handler's error paths in `kontierung.js`, and not all of those pass `qrInfo` until Task 8 wires it through, so the guard keeps this task's change from breaking those existing render calls in the meantime:

```html
            <% if (typeof qrInfo !== 'undefined' && qrInfo) { %>
              <div class="alert alert-info">
                <strong>Aus QR-Code erkannt:</strong>
                IBAN <%= qrInfo.iban %><% if (qrInfo.creditorName) { %> (<%= qrInfo.creditorName %>)<% } %>
                <% if (qrInfo.betrag) { %>, Betrag <%= qrInfo.betrag %> <%= qrInfo.waehrung || '' %><% } %>
                <% if (qrInfo.referenz) { %>, Referenz <%= qrInfo.referenz %><% } %>
                <% if (qrInfo.abgleich && qrInfo.abgleich.status === 'match') { %>
                  <div class="mt-1 text-success">IBAN stimmt mit hinterlegten Daten überein.</div>
                <% } %>
              </div>
            <% } %>
            <% if (typeof qrInfo !== 'undefined' && qrInfo && qrInfo.konfliktMitZugewiesenemDebitor) { %>
              <div class="alert alert-warning">
                QR-Code deutet auf Lieferant <strong><%= qrInfo.vorschlagDebitor.name %></strong> hin, aktuell zugewiesen ist ein anderer Lieferant — bitte prüfen.
              </div>
            <% } %>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/kontierung.js views/kontierung.ejs test/integration/kontierung.test.js
git commit -m "feat: prefill Betrag/Referenz/IBAN from QR-Code and reconcile against Absender-Regel"
```

---

## Task 8: Kontierung POST — IBAN mismatch warning (mail + audit-log) & opt-in "IBAN merken"

**Files:**
- Modify: `src/routes/kontierung.js`
- Modify: `views/kontierung.ejs`
- Modify: `src/services/auditLog.js`
- Test: `test/integration/kontierung.test.js`
- Test: `test/unit/auditLog.test.js`

**Interfaces:**
- Consumes: `pruefeIbanAbgleich` (Task 7, same file); `createDebitorIban`, `findDebitorIbanByIban` (Task 2); `getConfigValue` (existing `adminConfigRepo.js`); `resolveEmpfaenger`, `sendNotification` (existing `notify.js`); `createFreigabe` (existing `freigabenRepo.js`).
- Produces: on a mismatch, a `freigaben` row with `rolle: 'iban_abweichung'` (rendered by the existing audit-log timeline via a new `EREIGNIS_LABEL` entry) plus mail(s) of `typ: 'iban-warnung'`; on first-time confirmation, an opt-in-created `debitor_ibans` row with `quelle: 'bestaetigt'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/auditLog.test.js`:

```javascript
test('buildAuditLog labels an iban_abweichung rolle as "IBAN-Abweichung festgestellt"', () => {
  const db = openDatabase(':memory:');
  const jobId = seedJobMitFreigabe(db, '2026-08-22T08:30:00.000Z');
  createFreigabe(db, { jobId, personId: '1', rolle: 'iban_abweichung', zeitpunkt: '2026-08-22T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: 'QR-IBAN weicht ab', eskaliertVon: null });
  const log = buildAuditLog(db, jobId);
  assert.equal(log[1].ereignis, 'IBAN-Abweichung festgestellt');
  assert.equal(log[1].kommentar, 'QR-IBAN weicht ab');
  db.close();
});
```

Append to `test/integration/kontierung.test.js`:

```javascript
test('POST /kontierung/:id sends an IBAN-Abweichung warning mail and logs it to the audit log on mismatch', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { createDebitorIban } = await import('../../src/db/debitorIbanRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createDebitorIban(db, { debitorId, iban: 'CH0000000000000000000' }); // hinterlegte IBAN weicht ab
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: '100.00', qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), betrag: '100.00', interessenskonflikt: 'nein', begruendung: '', aktion: 'kontieren' });

  assert.equal(res.status, 302, 'Kontierung must still complete despite the mismatch');
  const mailLog = listMailLog(db).filter((m) => m.typ === 'iban-warnung');
  assert.ok(mailLog.length > 0, 'expected at least one iban-warnung mail to be logged');
  assert.ok(mailer.sent.some((m) => /IBAN-Abweichung/.test(m.subject)));

  const auditEintrag = db.prepare("SELECT * FROM freigaben WHERE job_id = ? AND rolle = 'iban_abweichung'").get(id);
  assert.ok(auditEintrag, 'expected an iban_abweichung freigaben row');
  db.close();
});

test('POST /kontierung/:id sends no IBAN-Abweichung mail when the QR-IBAN matches the hinterlegte IBAN', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { createDebitorIban } = await import('../../src/db/debitorIbanRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: '100.00', qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), betrag: '100.00', interessenskonflikt: 'nein', begruendung: '', aktion: 'kontieren' });

  assert.equal(res.status, 302);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'iban-warnung').length, 0);
  db.close();
});

test('POST /kontierung/:id with ibanMerken checked creates a bestaetigt debitor_ibans row for a Lieferant with no IBAN on file yet', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { listDebitorIbansByDebitor } = await import('../../src/db/debitorIbanRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: '100.00', qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), betrag: '100.00', interessenskonflikt: 'nein', begruendung: '', aktion: 'kontieren', ibanMerken: 'on' });

  assert.equal(res.status, 302);
  const rows = listDebitorIbansByDebitor(db, debitorId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iban, 'CH4431999123000889012');
  assert.equal(rows[0].quelle, 'bestaetigt');
  db.close();
});

test('POST /kontierung/:id without ibanMerken checked creates no debitor_ibans row', async () => {
  const { setQrDaten } = await import('../../src/db/jobsRepo.js');
  const { listDebitorIbansByDebitor } = await import('../../src/db/debitorIbanRepo.js');
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const id = createJob(db, { eingangAm: '2026-08-22T08:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  setQrDaten(db, id, { qrIban: 'CH4431999123000889012', qrReferenz: null, qrBetrag: '100.00', qrWaehrung: 'CHF', qrCreditorName: 'Muster AG' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), debitorId: String(debitorId), betrag: '100.00', interessenskonflikt: 'nein', begruendung: '', aktion: 'kontieren' });

  assert.equal(res.status, 302);
  assert.equal(listDebitorIbansByDebitor(db, debitorId).length, 0);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/auditLog.test.js test/integration/kontierung.test.js`
Expected: FAIL — no `iban_abweichung` label, no mismatch mail/audit-log row, no opt-in save.

- [ ] **Step 3: Add the `iban_abweichung` label to `src/services/auditLog.js`**

```javascript
export const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1 erteilt',
  freigeber2: 'Freigabe 2 erteilt',
  ablehnung: 'Abgelehnt',
  freigabe1_eskalation: 'Freigabe 1: Interessenskonflikt gemeldet',
  freigabe2_eskalation: 'Freigabe 2: Interessenskonflikt gemeldet',
  iban_abweichung: 'IBAN-Abweichung festgestellt',
};
```

- [ ] **Step 4: Add the match/mismatch/opt-in logic to the POST handler in `src/routes/kontierung.js`**

Add to the imports:

```javascript
import { findDebitorIbanByIban, listDebitorIbansByDebitor, createDebitorIban } from '../db/debitorIbanRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
```

Compute `qrInfo` once near the top of the POST handler (right after `const job = loadAuthorizedJob(req, res); if (!job) return;`):

```javascript
      const job = loadAuthorizedJob(req, res);
      if (!job) return;
      const konten = ladeKontenFuerJob(req, job);
      const debitoren = listDebitoren(db);
      const qrInfo = buildQrInfo(db, job);
```

Then add `qrInfo,` (right after `values,` or `values` in each) to the three existing `res.render('kontierung', ...)` call sites already in this handler:

```javascript
        if (!begruendung) {
          return res.status(400).render('kontierung', {
            job,
            konten,
            debitoren,
            previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
            values,
            qrInfo,
            errors: ['Bei einer Ablehnung ist eine Begründung Pflicht.'],
            auditLog: buildAuditLog(db, job.id),
          });
        }
```

```javascript
        if (!abgelehnt) {
          return res.status(409).render('kontierung', {
            job,
            konten,
            debitoren,
            previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
            values,
            qrInfo,
            errors: ['Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.'],
            auditLog: buildAuditLog(db, job.id),
          });
        }
```

```javascript
      if (errors.length > 0) {
        return res.status(400).render('kontierung', {
          job,
          konten,
          debitoren,
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          values,
          qrInfo,
          errors,
          auditLog: buildAuditLog(db, job.id),
        });
      }
```

Right after the main transaction's `db.exec('COMMIT');` (the one inside the non-`ablehnen` branch, immediately after the `try { ... } catch (err) { db.exec('ROLLBACK'); throw err; }` block that calls `setKontierung`/`updateKontierungMetadaten`/`createFreigabe`), and **before** the existing `if (eskaliertAnAdmin) { ... } else if (hatKonflikt) { ... } else { ... }` mail-sending block, insert:

```javascript
      if (job.qr_iban && debitor) {
        const { status } = pruefeIbanAbgleich(db, debitor.id, job.qr_iban);
        if (status === 'mismatch') {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'iban_abweichung',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: `QR-IBAN ${job.qr_iban} weicht von der/den für ${debitor.name} hinterlegten IBAN(s) ab.`,
            eskaliertVon: null,
          });
          const zusatzEmpfaenger = new Set(resolveEmpfaenger(db, config, getConfigValue(db, 'iban_abweichung_empfaenger')));
          zusatzEmpfaenger.add(req.currentPerson.email);
          const freigeber1 = getPersonById(db, konto.freigeber1_id);
          const freigeber2 = getPersonById(db, konto.freigeber2_id);
          if (freigeber1) zusatzEmpfaenger.add(freigeber1.email);
          if (freigeber2) zusatzEmpfaenger.add(freigeber2.email);
          for (const email of zusatzEmpfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
              text: `Bei der Kontierung von "${job.dateiname}" (Lieferant: ${debitor.name}) weicht die im QR-Code gefundene IBAN (${job.qr_iban}) von der hinterlegten IBAN ab. Bitte prüfen: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'iban-warnung',
              jobId: job.id,
            });
          }
        } else if (status === 'kein_abgleich' && req.body.ibanMerken === 'on' && !findDebitorIbanByIban(db, job.qr_iban)) {
          createDebitorIban(db, { debitorId: debitor.id, iban: job.qr_iban, quelle: 'bestaetigt' });
        }
      }
```

(`debitor` and `konto` are already in scope at this point in the existing handler — `const debitor = debitorId ? getDebitorById(db, debitorId) : null;` runs earlier in the same function, and `konto` is resolved near the top via `konten.find(...)`.)

- [ ] **Step 5: Add the opt-in checkbox to `views/kontierung.ejs`**

Add inside `<form id="kontierung-form" ...>`, right before the "Interessenskonflikt" `<div class="mb-3">` block:

```html
              <% if (typeof qrInfo !== 'undefined' && qrInfo && qrInfo.abgleich && qrInfo.abgleich.status === 'kein_abgleich') { %>
                <div class="form-check mb-3">
                  <input class="form-check-input" type="checkbox" id="ibanMerken" name="ibanMerken" checked>
                  <label class="form-check-label" for="ibanMerken">IBAN <%= qrInfo.iban %> künftig automatisch <%= qrInfo.debitorFuerAbgleich.name %> zuordnen</label>
                </div>
              <% } %>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/auditLog.test.js test/integration/kontierung.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/kontierung.js views/kontierung.ejs src/services/auditLog.js test/integration/kontierung.test.js test/unit/auditLog.test.js
git commit -m "feat: warn (mail + audit-log) on IBAN mismatch, add opt-in IBAN-merken at Kontierung"
```

---

## Task 9: Admin — manage Lieferanten-IBANs

**Files:**
- Modify: `src/routes/admin/debitoren.js`
- Modify: `views/admin/debitoren-liste.ejs`
- Test: `test/integration/admin/debitoren.test.js`

**Interfaces:**
- Consumes: `createDebitorIban`, `deleteDebitorIban`, `listDebitorIbansAll`, `findDebitorIbanByIban` (Task 2).
- Produces: `POST /admin/debitoren/ibans` (create), `POST /admin/debitoren/ibans/:id/loeschen` (delete) — admin-only, same authorization as the rest of the router.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/admin/debitoren.test.js`:

```javascript
test('every /admin/debitoren/ibans route returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const res of [
    await request(app).post('/admin/debitoren/ibans'),
    await request(app).post('/admin/debitoren/ibans/1/loeschen'),
  ]) {
    assert.equal(res.status, 401);
  }
  db.close();
});

test('POST /admin/debitoren/ibans creates a mapping with quelle manuell, listed on the Debitoren page', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH44 3199 9123 0008 8901 2', debitorId: String(debitorId) });

  assert.equal(res.status, 302);
  const { listDebitorIbansAll } = await import('../../../src/db/debitorIbanRepo.js');
  const rows = listDebitorIbansAll(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].iban, 'CH4431999123000889012');
  assert.equal(rows[0].quelle, 'manuell');

  const listRes = await request(app).get('/admin/debitoren').set('x-test-person-id', '99');
  assert.match(listRes.text, /CH4431999123000889012/);
  db.close();
});

test('POST /admin/debitoren/ibans rejects an invalid IBAN', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'NICHT-EINE-IBAN', debitorId: String(debitorId) });

  assert.equal(res.status, 400);
  assert.match(res.text, /gültige Schweizer IBAN/);
  db.close();
});

test('POST /admin/debitoren/ibans rejects an IBAN already mapped to another Lieferant', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorA = createDebitor(db, { name: 'A AG', kontoId });
  const debitorB = createDebitor(db, { name: 'B AG', kontoId });
  const { createDebitorIban } = await import('../../../src/db/debitorIbanRepo.js');
  createDebitorIban(db, { debitorId: debitorA, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/debitoren/ibans')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ iban: 'CH4431999123000889012', debitorId: String(debitorB) });

  assert.equal(res.status, 400);
  assert.match(res.text, /bereits einem Lieferanten zugeordnet/);
  db.close();
});

test('POST /admin/debitoren/ibans/:id/loeschen removes the mapping', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const kontoId = seedKonto(db);
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  const { createDebitorIban, getDebitorIbanById } = await import('../../../src/db/debitorIbanRepo.js');
  const ibanId = createDebitorIban(db, { debitorId, iban: 'CH4431999123000889012' });
  const app = buildTestApp(db);

  const res = await request(app).post(`/admin/debitoren/ibans/${ibanId}/loeschen`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getDebitorIbanById(db, ibanId), null);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/debitoren.test.js`
Expected: FAIL — routes don't exist yet (404).

- [ ] **Step 3: Add the routes to `src/routes/admin/debitoren.js`**

Add to the imports:

```javascript
import { createDebitorIban, deleteDebitorIban, listDebitorIbansAll, findDebitorIbanByIban } from '../../db/debitorIbanRepo.js';
```

```javascript
const IBAN_PATTERN = /^CH\d{2}[0-9A-Z]{17}$/;
```

Extend `renderListe` to include `ibans`/`ibanErrors`/`ibanValues`:

```javascript
  function renderListe(req, res, status, overrides = {}) {
    const konten = listKonten(db, { includeInactive: true });
    const debitoren = listDebitoren(db, { includeInactive: true }).map((debitor) => ({
      ...debitor,
      konto: debitor.konto_id ? konten.find((k) => k.id === debitor.konto_id) : null,
    }));
    const regeln = listZuweisungsregeln(db).map((regel) => ({
      ...regel,
      debitor: getDebitorById(db, regel.debitor_id),
    }));
    const ibans = listDebitorIbansAll(db).map((row) => ({
      ...row,
      debitor: getDebitorById(db, row.debitor_id),
    }));
    res.status(status).render('admin/debitoren-liste', {
      debitoren,
      regeln,
      ibans,
      konten: listKonten(db),
      aktiveDebitoren: listDebitoren(db),
      debitorErrors: [],
      debitorValues: {},
      regelErrors: [],
      regelValues: {},
      ibanErrors: [],
      ibanValues: {},
      gespeichert: req.query.gespeichert === '1',
      ...overrides,
    });
  }
```

Add the two new routes right after the existing `/regeln*` block (before `router.get('/:id/bearbeiten', ...)`) — same "register before the generic `/:id` routes" reasoning as `/regeln`:

```javascript
  router.post('/ibans', (req, res) => {
    const { iban, debitorId } = req.body;
    const normalizedIban = (iban || '').replace(/\s/g, '').toUpperCase();
    const errors = [];
    if (!normalizedIban) {
      errors.push('IBAN ist ein Pflichtfeld.');
    } else if (!IBAN_PATTERN.test(normalizedIban)) {
      errors.push('IBAN muss eine gültige Schweizer IBAN sein (z. B. "CH93 0076 2011 6238 5295 7").');
    } else if (findDebitorIbanByIban(db, normalizedIban)) {
      errors.push('Diese IBAN ist bereits einem Lieferanten zugeordnet.');
    }
    if (!debitorId) errors.push('Lieferant ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return renderListe(req, res, 400, { ibanErrors: errors, ibanValues: { iban, debitorId } });
    }

    createDebitorIban(db, { debitorId: Number(debitorId), iban: normalizedIban, quelle: 'manuell' });
    res.redirect('/admin/debitoren?gespeichert=1');
  });

  router.post('/ibans/:id/loeschen', (req, res) => {
    deleteDebitorIban(db, Number(req.params.id));
    res.redirect('/admin/debitoren');
  });
```

- [ ] **Step 4: Add the "Lieferanten-IBANs" section to `views/admin/debitoren-liste.ejs`**

Add after the existing Zuweisungsregeln section (after its closing `</form>`, before `</main>`):

```html
    <h2 class="h4 mt-4">Lieferanten-IBANs</h2>
    <p class="text-muted">Hinterlegt pro Lieferant die erwartete(n) IBAN(s). Weicht die im QR-Code einer Rechnung gefundene IBAN davon ab, warnt das Portal bei der Kontierung.</p>
    <% if (ibanErrors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% ibanErrors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <div class="table-responsive mb-3">
      <table class="table align-middle">
        <thead><tr><th>IBAN</th><th>Lieferant</th><th>Quelle</th><th></th></tr></thead>
        <tbody>
          <% ibans.forEach((row) => { %>
            <tr>
              <td><%= row.iban %></td>
              <td><%= row.debitor ? row.debitor.name : '—' %></td>
              <td><span class="badge <%= row.quelle === 'bestaetigt' ? 'text-bg-info' : 'text-bg-secondary' %>"><%= row.quelle === 'bestaetigt' ? 'bestätigt' : 'manuell' %></span></td>
              <td>
                <form method="post" action="/admin/debitoren/ibans/<%= row.id %>/loeschen" class="d-inline">
                  <button type="submit" class="btn btn-outline-danger btn-sm">Löschen</button>
                </form>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
    <form method="post" action="/admin/debitoren/ibans" class="row g-2 align-items-end">
      <div class="col-auto">
        <label class="form-label" for="ibanIban">IBAN</label>
        <input type="text" class="form-control" id="ibanIban" name="iban" value="<%= ibanValues.iban || '' %>" placeholder="z.B. CH93 0076 2011 6238 5295 7" required>
      </div>
      <div class="col-auto">
        <label class="form-label" for="ibanDebitorId">Lieferant</label>
        <select class="form-select" id="ibanDebitorId" name="debitorId" required>
          <option value="">— wählen —</option>
          <% aktiveDebitoren.forEach((d) => { %>
            <option value="<%= d.id %>" <%= String(d.id) === String(ibanValues.debitorId) ? 'selected' : '' %>><%= d.name %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto">
        <button type="submit" class="btn btn-primary">IBAN hinzufügen</button>
      </div>
    </form>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/admin/debitoren.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin/debitoren.js views/admin/debitoren-liste.ejs test/integration/admin/debitoren.test.js
git commit -m "feat: admin UI to manage Lieferanten-IBANs"
```

---

## Task 10: Admin — configurable IBAN-Abweichungs-Empfänger

**Files:**
- Modify: `src/routes/admin/eskalation.js`
- Modify: `views/admin/eskalation-form.ejs`
- Test: `test/integration/admin/eskalation.test.js`

**Interfaces:**
- Consumes: `getConfigValue`/`setConfigValue` (existing `adminConfigRepo.js`), `validateEmpfaengerListe` (existing, same file).
- Produces: the `iban_abweichung_empfaenger` admin_config value that Task 8's POST handler reads via `getConfigValue(db, 'iban_abweichung_empfaenger')`.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/admin/eskalation.test.js` (mirror its existing test shapes for `reminderEmpfaenger`/`eskalationEmpfaenger`):

```javascript
test('GET /admin/eskalation shows the current IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  setConfigValue(db, 'iban_abweichung_empfaenger', 'gruppe:admin');
  const app = buildTestApp(db);

  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /gruppe:admin/);
  db.close();
});

test('POST /admin/eskalation saves a valid IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '24', eskalationStunden: '48', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'gruppe:buchhaltung', ibanAbweichungEmpfaenger: 'admin@example.org' });

  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'iban_abweichung_empfaenger'), 'admin@example.org');
  db.close();
});

test('POST /admin/eskalation rejects an invalid IBAN-Abweichungs-Empfänger value', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '24', eskalationStunden: '48', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'gruppe:buchhaltung', ibanAbweichungEmpfaenger: 'nicht-valide' });

  assert.equal(res.status, 400);
  assert.match(res.text, /IBAN-Abweichungs-Empfänger/);
  db.close();
});
```

The file already imports `getConfigValue` from `../../../src/db/adminConfigRepo.js` (line 6) but not `setConfigValue` — add it to that same import line (`import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';`). Reuse the file's existing `buildTestApp`/`seedAdmin` helpers rather than redefining them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: FAIL — field not rendered, not saved, not validated.

- [ ] **Step 3: Extend `src/routes/admin/eskalation.js`**

```javascript
  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      reminderEmpfaenger: getConfigValue(db, 'reminder_empfaenger'),
      eskalationEmpfaenger: getConfigValue(db, 'eskalation_empfaenger'),
      ibanAbweichungEmpfaenger: getConfigValue(db, 'iban_abweichung_empfaenger'),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
    const { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(reminderEmpfaenger, 'Reminder-Empfänger', errors);
    validateEmpfaengerListe(eskalationEmpfaenger, 'Eskalations-Empfänger', errors);
    validateEmpfaengerListe(ibanAbweichungEmpfaenger, 'IBAN-Abweichungs-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger, errors, gespeichert: false });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    setConfigValue(db, 'iban_abweichung_empfaenger', ibanAbweichungEmpfaenger.trim());
    res.redirect('/admin/eskalation?gespeichert=1');
  });
```

- [ ] **Step 4: Add the field to `views/admin/eskalation-form.ejs`**

Add right after the `eskalationEmpfaenger` `<div class="mb-3">` block, before the `<button type="submit" ...>`:

```html
      <div class="mb-3">
        <label class="form-label" for="ibanAbweichungEmpfaenger">IBAN-Abweichungs-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:buchhaltung"/"gruppe:admin") <span class="text-muted">— zusätzlich zur kontierenden Person und den Freigebern des betroffenen Kontos</span></label>
        <textarea class="form-control" id="ibanAbweichungEmpfaenger" name="ibanAbweichungEmpfaenger" rows="4"><%= ibanAbweichungEmpfaenger || '' %></textarea>
      </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin/eskalation.js views/admin/eskalation-form.ejs test/integration/admin/eskalation.test.js
git commit -m "feat: make the IBAN-Abweichung notification recipients admin-configurable"
```

---

## Final check

- [ ] Run `npm test` once more, in full, after all ten tasks are committed. Expected: PASS, no regressions.
- [ ] Manually smoke-test in a browser (per the `run` skill/project convention, if available): create a Debitor, add an IBAN for it via `/admin/debitoren`, submit a real Swiss-QR-Bill PDF through `POST /api/n8n/jobs` (e.g. one generated with `test/helpers/qrBillFixture.js` via a throwaway script, or `curl`), open `/kontierung/:id` and confirm the QR info box, prefilled Betrag, and (with a deliberately different on-file IBAN) the mismatch warning + mail all appear as designed.
