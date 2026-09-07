# Freigabe2-Reminder und -Eskalation bei Untätigkeit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job stuck in `freigabe2` (Freigabe 1 already granted) with an inactive responsible person now gets a personal reminder mail after a configurable number of hours, and is automatically handed to the Admin group after a further configurable number of hours — mirroring the existing `pool-erinnerungen` mechanism but scoped to `freigabe2` and its actually-responsible person.

**Architecture:** New `freigabe2_seit` timestamp column tracks when the current responsibility began; two new gating columns (`freigabe2_reminder_gesendet_at`, `freigabe2_eskalation_gesendet_at`) prevent double sends, exactly like the existing pool columns. A new cron job function `runFreigabe2ErinnerungenJob` runs in two phases per invocation (reminder, then escalation), reusing `forceEskalierenFreigabe2AnAdmin` for the actual handover. Two new admin-editable mail types (`freigabe2-reminder`, `freigabe2-eskalation`) and three new `admin_config` keys drive it, wired into the existing `/admin/eskalation`, `/admin/geplante-jobs`, and `/admin/mail-einstellungen` pages and the in-process scheduler — all following patterns already used by `pool-erinnerungen` and `mail-digest`.

**Tech Stack:** Node.js (native `node:sqlite`, native `node:test` + `node:assert/strict`), Express, EJS views, Bootstrap forms — no new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-07-freigabe2-erinnerung-eskalation-design.md](../specs/2026-09-07-freigabe2-erinnerung-eskalation-design.md)

## Global Constraints

- Default `freigabe2_reminder_stunden = '24'`, `freigabe2_eskalation_stunden = '48'` (same numeric defaults as the pool equivalents), `freigabe2_eskalation_empfaenger = 'gruppe:admin'` (not `gruppe:buchhaltung` — see spec's "Admin-Konfiguration" section).
- Default `cron_freigabe2_erinnerungen_intervall_minuten = '60'`.
- New mail types `freigabe2-reminder` / `freigabe2-eskalation` are **not** added to `IMMER_SOFORT_TYPEN` in `src/services/notify.js:12` — they participate in digest batching like `reminder`/`eskalation` already do.
- Every new migration function follows the exact rebuild-in-transaction pattern already used in `src/db/index.js` (rename table, `CREATE TABLE` with the widened `CHECK`, `INSERT ... SELECT`, `DROP TABLE`, commit/rollback) — never attempt `ALTER TABLE ... ADD CONSTRAINT`, SQLite does not support it.
- All new German-facing strings/labels follow existing casing and terminology in the same file (`Reminder`, `Eskalation`, `Erinnerungen`, `Freigabe 2`).

---

### Task 1: `jobs` table — three new columns (`freigabe2_seit`, `freigabe2_reminder_gesendet_at`, `freigabe2_eskalation_gesendet_at`)

**Files:**
- Modify: `src/db/schema.sql` (jobs `CREATE TABLE` block, after `pool_rueckgesendet_am`)
- Modify: `src/db/index.js:14-33` (`JOBS_TABLE_MIGRATIONS` array)
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: three new nullable TEXT columns on `jobs`, usable by every later task via plain `PRAGMA table_info(jobs)` / `SELECT`/`UPDATE`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/db.test.js` (anywhere near the other "jobs table has an X column" tests, e.g. right after the `abgeschlossen_am` test at line 57-62):

```js
test('jobs table has the three freigabe2-Erinnerung columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['freigabe2_seit', 'freigabe2_reminder_gesendet_at', 'freigabe2_eskalation_gesendet_at']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});

test('openDatabase adds the freigabe2-Erinnerung columns via ALTER TABLE to an existing on-disk database that predates them', () => {
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
  for (const expected of ['freigabe2_seit', 'freigabe2_reminder_gesendet_at', 'freigabe2_eskalation_gesendet_at']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected} to the pre-existing table`);
  }
  assert.doesNotThrow(() =>
    migratedDb
      .prepare('UPDATE jobs SET freigabe2_seit = ?, freigabe2_reminder_gesendet_at = ?, freigabe2_eskalation_gesendet_at = ? WHERE id = 1')
      .run('2026-09-07T08:00:00.000Z', '2026-09-08T08:00:00.000Z', '2026-09-09T08:00:00.000Z')
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: both new tests FAIL (columns don't exist yet).

- [ ] **Step 3: Add the columns to `schema.sql`**

In `src/db/schema.sql`, inside the `jobs` `CREATE TABLE` block, change the tail from:

```sql
  pool_rueckgesendet_bemerkung TEXT,
  pool_rueckgesendet_von TEXT REFERENCES personen(churchtools_person_id),
  pool_rueckgesendet_am TEXT
);
```

to:

```sql
  pool_rueckgesendet_bemerkung TEXT,
  pool_rueckgesendet_von TEXT REFERENCES personen(churchtools_person_id),
  pool_rueckgesendet_am TEXT,
  freigabe2_seit TEXT,
  freigabe2_reminder_gesendet_at TEXT,
  freigabe2_eskalation_gesendet_at TEXT
);
```

- [ ] **Step 4: Add the columns to `JOBS_TABLE_MIGRATIONS`**

In `src/db/index.js`, after the `pool_rueckgesendet_am` entry (currently the last entry, line 33):

```js
  { column: 'pool_rueckgesendet_am', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_am TEXT' },
  { column: 'freigabe2_seit', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_seit TEXT' },
  { column: 'freigabe2_reminder_gesendet_at', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_reminder_gesendet_at TEXT' },
  { column: 'freigabe2_eskalation_gesendet_at', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_eskalation_gesendet_at TEXT' },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: PASS (all tests in the file, not just the two new ones — this file has ~35 tests, watch for regressions).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(db): add freigabe2_seit and freigabe2 reminder/eskalation gate columns to jobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `mail_log.typ` CHECK — widen to accept `freigabe2-reminder` / `freigabe2-eskalation`

**Files:**
- Modify: `src/db/schema.sql` (`mail_log` `CREATE TABLE` block)
- Modify: `src/db/index.js` (new `migrateMailLogTableFreigabe2` function + registration in `openDatabase`)
- Test: `test/unit/db.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mail_log.typ` CHECK now accepts `'freigabe2-reminder'` and `'freigabe2-eskalation'` — required before Task 6's `TYP_ZU_KEY_INFIX` entries or Task 8's `sendNotification` calls can log those types without throwing.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/db.test.js`, after the `mail-digest`/cron_log widening test (end of file, after line 902):

```js
test('openDatabase widens the mail_log table typ CHECK to include freigabe2-reminder and freigabe2-eskalation, even for a database already migrated to include geplant status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, eingang_am TEXT NOT NULL, quelle TEXT NOT NULL, absender TEXT, dateiname TEXT NOT NULL, pdf_pfad TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unzugewiesen');
    CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
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
         VALUES ('freigabe2-reminder', 1, 'b@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T09:00:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept typ = freigabe2-reminder'
  );
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am)
         VALUES ('freigabe2-eskalation', 1, 'c@example.org', 'Betreff', 'Text', 'versendet', '2026-08-15T09:05:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept typ = freigabe2-eskalation'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/db.test.js`
Expected: FAIL (`CHECK constraint failed: typ`).

- [ ] **Step 3: Add the values to `schema.sql`**

In `src/db/schema.sql`, change the `mail_log` `typ` CHECK line from:

```sql
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung')),
```

to:

```sql
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation')),
```

- [ ] **Step 4: Add the migration function to `src/db/index.js`**

Directly after `migrateCronLogTableMailDigest` (currently ends at line 506, right before `export function openDatabase`):

```js
// Same pattern as migrateMailLogTableGeplantStatus above, one more CHECK widening for the two
// new 'freigabe2-reminder'/'freigabe2-eskalation' mail types (freigabe2-erinnerungen cron job).
function migrateMailLogTableFreigabe2(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('freigabe2-reminder')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_freigabe2');
    db.exec(`
      CREATE TABLE mail_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation')),
        job_id INTEGER REFERENCES jobs(id),
        empfaenger TEXT NOT NULL,
        betreff TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
        fehler_details TEXT,
        versucht_am TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_freigabe2
    `);
    db.exec('DROP TABLE mail_log_pre_freigabe2');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

Then register it in `openDatabase` (after `migrateCronLogTableMailDigest(db);`, currently line 523):

```js
  migrateCronLogTableMailDigest(db);
  migrateMailLogTableFreigabe2(db);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/db.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(db): widen mail_log.typ CHECK to accept freigabe2-reminder/freigabe2-eskalation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `cron_log.job` CHECK — widen to accept `freigabe2-erinnerungen`

**Files:**
- Modify: `src/db/schema.sql` (`cron_log` `CREATE TABLE` block)
- Modify: `src/db/index.js` (new `migrateCronLogTableFreigabe2Erinnerungen` function + registration)
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `cron_log.job` CHECK now accepts `'freigabe2-erinnerungen'` — required before Task 8's `logCronLauf(db, { job: 'freigabe2-erinnerungen', ... })` calls can succeed.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/db.test.js`, after Task 2's test:

```js
test('openDatabase widens the cron_log table job CHECK to include freigabe2-erinnerungen, even for a database already migrated to include mail-digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    );
    INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES ('pdf-bereinigung', '2026-08-15T02:30:00.000Z', '2026-08-15T02:30:05.000Z', 'erfolg', 'ok');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM cron_log WHERE id = 1').get();
  assert.equal(preserved.details, 'ok', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb
      .prepare(
        `INSERT INTO cron_log (job, gestartet_am, status) VALUES ('freigabe2-erinnerungen', '2026-08-15T07:00:00.000Z', 'erfolg')`
      )
      .run(),
    'the widened CHECK constraint must accept job = freigabe2-erinnerungen'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/db.test.js`
Expected: FAIL (`CHECK constraint failed: job`).

- [ ] **Step 3: Add the value to `schema.sql`**

In `src/db/schema.sql`, change the `cron_log` `job` CHECK line from:

```sql
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest')),
```

to:

```sql
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen')),
```

- [ ] **Step 4: Add the migration function to `src/db/index.js`**

Directly after `migrateMailLogTableFreigabe2` (added in Task 2, right before `export function openDatabase`):

```js
// Same pattern as migrateCronLogTableMailDigest above, one more CHECK widening for the new
// 'freigabe2-erinnerungen' cron job (reminder + escalation for stalled freigabe2 jobs).
function migrateCronLogTableFreigabe2Erinnerungen(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('freigabe2-erinnerungen')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_freigabe2_erinnerungen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest', 'freigabe2-erinnerungen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_freigabe2_erinnerungen
    `);
    db.exec('DROP TABLE cron_log_pre_freigabe2_erinnerungen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Register it in `openDatabase`, after `migrateMailLogTableFreigabe2(db);`:

```js
  migrateMailLogTableFreigabe2(db);
  migrateCronLogTableFreigabe2Erinnerungen(db);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/db.test.js`
Expected: PASS — run the whole file once more here since this is the last of three migration tasks touching it.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(db): widen cron_log.job CHECK to accept freigabe2-erinnerungen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `jobsRepo` — set/reset `freigabe2_seit`

**Files:**
- Modify: `src/db/jobsRepo.js:243-259` (`abschliessenFreigabe1`, `eskalierenFreigabe2`)
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `freigabe2_seit`/`freigabe2_reminder_gesendet_at`/`freigabe2_eskalation_gesendet_at` columns from Task 1.
- Produces: `freigabe2_seit` is guaranteed set whenever `status = 'freigabe2'`, and reset (with the two gate columns cleared) whenever responsibility moves to Stellvertreter2 via `eskalierenFreigabe2`. Task 5's list queries depend on this being reliably populated.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, near the existing `abschliessenFreigabe1`/`eskalierenFreigabe2` tests (search the file for `test('abschliessenFreigabe1` to find the right neighborhood):

```js
test('abschliessenFreigabe1 sets freigabe2_seit to the current time', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  const before = new Date().toISOString();
  abschliessenFreigabe1(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.ok(job.freigabe2_seit >= before, 'freigabe2_seit should be set to roughly now');
  db.close();
});

test('eskalierenFreigabe2 resets freigabe2_seit and clears both gesendet_at markers so the new Stellvertreter2 gets a fresh clock', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z', freigabe2_reminder_gesendet_at = '2020-01-02T00:00:00.000Z', freigabe2_eskalation_gesendet_at = '2020-01-03T00:00:00.000Z' WHERE id = ?"
  ).run(kontoId, jobId);

  const before = new Date().toISOString();
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Interessenkonflikt' });
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.ok(job.freigabe2_seit >= before, 'freigabe2_seit must restart for the new responsible person');
  assert.equal(job.freigabe2_reminder_gesendet_at, null);
  assert.equal(job.freigabe2_eskalation_gesendet_at, null);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `job.freigabe2_seit` is `null` in both.

- [ ] **Step 3: Update `abschliessenFreigabe1`**

In `src/db/jobsRepo.js:252-254`, change:

```js
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
```

to:

```js
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe2_seit = ? WHERE id = ?"
  ).run(new Date().toISOString(), jobId);
```

- [ ] **Step 4: Update `eskalierenFreigabe2`**

In `src/db/jobsRepo.js:257-259`, change:

```js
export function eskalierenFreigabe2(db, jobId, { eskaliertVon, grund }) {
  db.prepare('UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ? WHERE id = ?').run(eskaliertVon, grund, jobId);
}
```

to:

```js
export function eskalierenFreigabe2(db, jobId, { eskaliertVon, grund }) {
  // freigabe2_seit restarts here (and both gesendet_at markers clear): responsibility just moved
  // to Stellvertreter2, so the reminder/eskalation clock for the *new* responsible person must
  // start from zero rather than inheriting however long the original Freigeber2 already sat on it.
  db.prepare(
    'UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ?, freigabe2_seit = ?, freigabe2_reminder_gesendet_at = NULL, freigabe2_eskalation_gesendet_at = NULL WHERE id = ?'
  ).run(eskaliertVon, grund, new Date().toISOString(), jobId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS (this file has 100+ tests — watch for any regression in unrelated `abschliessenFreigabe1`/`eskalierenFreigabe2` tests elsewhere in the file, e.g. ones asserting exact column values).

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat(jobsRepo): track freigabe2_seit, reset it on Stellvertreter2 handoff

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `jobsRepo` — reminder/eskalation list queries and markers

**Files:**
- Modify: `src/db/jobsRepo.js` (new functions, placed directly after `listPoolJobsForEskalation`/`markEskalationGesendet` at line 458)
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `freigabe2_seit`, `freigabe2_reminder_gesendet_at`, `freigabe2_eskalation_gesendet_at` (Task 1), `freigabe2_eskaliert_an_admin` (existing column).
- Produces:
  - `listFreigabe2JobsForReminder(db, stunden): Job[]`
  - `markFreigabe2ReminderGesendet(db, jobId): void`
  - `listFreigabe2JobsForEskalation(db, stunden): Job[]`
  - `markFreigabe2EskalationGesendet(db, jobId): void`

  All four consumed by Task 8's `runFreigabe2ErinnerungenJob`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, after the existing `markReminderGesendet and markEskalationGesendet each gate only their own list` test (around line 1323):

```js
test('listFreigabe2JobsForReminder returns only freigabe2 jobs older than the threshold with no reminder sent yet, excludes jobs already escalated to admin', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, oldJobId);
  const freshJobId = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'neu.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = ? WHERE id = ?").run(kontoId, new Date().toISOString(), freshJobId);
  const eskaliertJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'admin.pdf', pdfPfad: '/tmp/c.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z', freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(kontoId, eskaliertJobId);

  const ids = listFreigabe2JobsForReminder(db, 24).map((j) => j.id);
  assert.deepEqual(ids, [oldJobId]);
  db.close();
});

test('listFreigabe2JobsForReminder excludes a job whose reminder was already sent', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);
  markFreigabe2ReminderGesendet(db, jobId);
  assert.equal(listFreigabe2JobsForReminder(db, 24).length, 0);
  db.close();
});

test('listFreigabe2JobsForEskalation returns only freigabe2 jobs older than the threshold with no escalation sent yet, excludes jobs already escalated to admin', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, oldJobId);
  const eskaliertJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'admin.pdf', pdfPfad: '/tmp/c.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z', freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(kontoId, eskaliertJobId);

  const results = listFreigabe2JobsForEskalation(db, 48);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, oldJobId);
  db.close();
});

test('markFreigabe2ReminderGesendet and markFreigabe2EskalationGesendet each gate only their own list', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);
  markFreigabe2ReminderGesendet(db, jobId);
  assert.equal(listFreigabe2JobsForReminder(db, 24).length, 0, 'reminder list excludes it once marked');
  assert.equal(listFreigabe2JobsForEskalation(db, 48).length, 1, 'escalation list is independent, still includes it');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `listFreigabe2JobsForReminder is not defined` (not yet exported).

- [ ] **Step 3: Add the import to the test file's header**

In `test/unit/jobsRepo.test.js:10`, add the four new names to the big `import { ... } from '../../src/db/jobsRepo.js'` line (append right after `forceEskalierenFreigabe2AnAdmin,`):

```js
forceEskalierenFreigabe2AnAdmin, listFreigabe2JobsForReminder, markFreigabe2ReminderGesendet, listFreigabe2JobsForEskalation, markFreigabe2EskalationGesendet,
```

- [ ] **Step 4: Implement the four functions in `jobsRepo.js`**

In `src/db/jobsRepo.js`, directly after `markEskalationGesendet` (line 456-458):

```js
export function listFreigabe2JobsForReminder(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0 " +
      "AND freigabe2_reminder_gesendet_at IS NULL AND freigabe2_seit < ? ORDER BY freigabe2_seit"
    )
    .all(schwelle);
}

export function markFreigabe2ReminderGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET freigabe2_reminder_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}

export function listFreigabe2JobsForEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0 " +
      "AND freigabe2_eskalation_gesendet_at IS NULL AND freigabe2_seit < ? ORDER BY freigabe2_seit"
    )
    .all(schwelle);
}

export function markFreigabe2EskalationGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET freigabe2_eskalation_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat(jobsRepo): add listFreigabe2JobsForReminder/Eskalation + markers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `admin_config` defaults + mail-template type mapping

**Files:**
- Modify: `src/db/adminConfigRepo.js` (`DEFAULTS` object)
- Modify: `src/services/mailTemplates.js:3-12` (`TYP_ZU_KEY_INFIX`)
- Test: `test/unit/adminConfigRepo.test.js`, `test/unit/mailTemplates.test.js`

**Interfaces:**
- Produces: `getConfigValue(db, 'freigabe2_reminder_stunden')` etc. resolve to real defaults after `seedDefaults(db)`; `getVorlage(db, 'freigabe2-reminder')` / `getVorlage(db, 'freigabe2-eskalation')` resolve without throwing. Required by Task 8 (`getConfigValue`/`sendNotification` calls) and Task 10/12 (admin forms reading these keys).

- [ ] **Step 1: Check the existing test shape**

Run: `grep -n "reminder_stunden\|mail_vorlage_reminder" test/unit/adminConfigRepo.test.js test/unit/mailTemplates.test.js`

This tells you whether these files assert on individual `DEFAULTS` keys by name (if so, mirror that style for the new keys) or just smoke-test `seedDefaults` broadly. Adjust Step 2's tests to match whichever style you find — the assertions below assume the simple "assert the value after seedDefaults" style already used elsewhere in `adminConfigRepo.test.js` for `reminder_stunden`.

- [ ] **Step 2: Write the failing tests**

Add to `test/unit/adminConfigRepo.test.js` (near existing `reminder_stunden`/`eskalation_stunden` assertions):

```js
test('seedDefaults sets freigabe2 reminder/eskalation defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'freigabe2_reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_stunden'), '48');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_empfaenger'), 'gruppe:admin');
  assert.equal(getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'), '60');
  db.close();
});
```

Add to `test/unit/mailTemplates.test.js` (near existing `getVorlage` tests):

```js
test('getVorlage resolves freigabe2-reminder and freigabe2-eskalation after seedDefaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const reminder = getVorlage(db, 'freigabe2-reminder');
  assert.ok(reminder.betreff.length > 0);
  assert.ok(reminder.text.includes('%stunden%'));
  const eskalation = getVorlage(db, 'freigabe2-eskalation');
  assert.ok(eskalation.betreff.length > 0);
  assert.ok(eskalation.text.includes('%stunden%'));
  db.close();
});
```

(Check the file's existing imports — it likely already imports `openDatabase`, `seedDefaults`, `getVorlage` from the same modules used elsewhere in that file; add only what's missing.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/unit/adminConfigRepo.test.js test/unit/mailTemplates.test.js`
Expected: FAIL (`getConfigValue` returns `undefined`/`null`, `getVorlage` throws `Unbekannter Mail-Vorlagen-Typ`).

- [ ] **Step 4: Add the new keys to `DEFAULTS` in `src/db/adminConfigRepo.js`**

Add these entries to the `DEFAULTS` object — group them near the existing `reminder_stunden`/`eskalation_stunden` keys at the top, and near the other `mail_vorlage_*` keys respectively:

```js
  freigabe2_reminder_stunden: '24',
  freigabe2_eskalation_stunden: '48',
  freigabe2_eskalation_empfaenger: 'gruppe:admin',
  cron_freigabe2_erinnerungen_intervall_minuten: '60',
```

(place these right after the existing `eskalation_empfaenger: 'gruppe:buchhaltung',` line and the `cron_pool_erinnerungen_intervall_minuten: '60',` line respectively — or all four together right after `eskalation_empfaenger`, whichever reads more naturally; exact position doesn't matter, `DEFAULTS` is a flat object)

```js
  mail_vorlage_freigabe2_reminder_betreff: 'Freigabeportal: Offene Freigabe wartet auf Sie',
  mail_vorlage_freigabe2_reminder_text: 'Hallo %empfaengerName%,\n\ndiese Rechnung wartet seit mehr als %stunden% Stunden auf Ihre Freigabe: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_freigabe2_eskalation_betreff: 'Freigabeportal: Eskalation – Freigabe seit langem ausstehend',
  mail_vorlage_freigabe2_eskalation_text: 'Diese Rechnung wartet seit mehr als %stunden% Stunden auf Freigabe 2 und wurde an die Administration übergeben: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
```

(place these right after the existing `mail_vorlage_eskalation_text` entry, before `mail_vorlage_ablehnung_betreff`)

- [ ] **Step 5: Add the type mapping to `src/services/mailTemplates.js`**

In `TYP_ZU_KEY_INFIX` (lines 3-12), add:

```js
const TYP_ZU_KEY_INFIX = {
  zuweisung: 'zuweisung',
  reminder: 'reminder',
  eskalation: 'eskalation',
  ablehnung: 'ablehnung',
  'sync-fehler': 'sync_fehler',
  'iban-warnung': 'iban_warnung',
  'rechnungsnummer-warnung': 'rechnungsnummer_warnung',
  digest: 'digest',
  'freigabe2-reminder': 'freigabe2_reminder',
  'freigabe2-eskalation': 'freigabe2_eskalation',
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/adminConfigRepo.test.js test/unit/mailTemplates.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/adminConfigRepo.js src/services/mailTemplates.js test/unit/adminConfigRepo.test.js test/unit/mailTemplates.test.js
git commit -m "feat(mail): add freigabe2-reminder/freigabe2-eskalation config defaults and templates

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `cronJobs.js` — `runFreigabe2ErinnerungenJob`

**Files:**
- Modify: `src/services/cronJobs.js` (new function, placed directly after `runPoolErinnerungenJob`, i.e. after line 126)
- Test: none in this task — covered end-to-end by Task 8's HTTP integration tests, exactly mirroring how `runPoolErinnerungenJob` itself has no dedicated `cronJobs.test.js` unit test (verify with `grep -n "runPoolErinnerungenJob" test/unit/cronJobs.test.js` — expect zero matches before proceeding, confirming this is the established pattern, not an oversight to fix here).

**Interfaces:**
- Consumes: `listFreigabe2JobsForReminder`, `markFreigabe2ReminderGesendet`, `listFreigabe2JobsForEskalation`, `markFreigabe2EskalationGesendet` (Task 5), `forceEskalierenFreigabe2AnAdmin` (existing, `jobsRepo.js:632-637`), `getEffectiveFreigeber2Id` (existing, `jobsRepo.js:576-578`), `getKontoById` (existing, `kontenRepo.js:69-71`), `getPersonById` (existing, `personenRepo.js:26-30`), `sendNotification`/`resolveEmpfaenger` (existing, `notify.js`), `getConfigValue` (existing), `logCronLauf` (existing, `cronLogRepo.js`).
- Produces: `runFreigabe2ErinnerungenJob(db, config, mailer): Promise<{ status, reminder, eskalation } | { status: 'fehler', error }>` — same result shape as `runPoolErinnerungenJob`. Consumed by Task 8 (cron route), Task 9 (scheduler), Task 11 (manual-trigger admin route).

- [ ] **Step 1: Add the needed imports to `cronJobs.js`**

In `src/services/cronJobs.js`, extend the existing `import { ... } from '../db/jobsRepo.js'` block (lines 9-18) to add:

```js
  listFreigabe2JobsForReminder,
  markFreigabe2ReminderGesendet,
  listFreigabe2JobsForEskalation,
  markFreigabe2EskalationGesendet,
  forceEskalierenFreigabe2AnAdmin,
  getEffectiveFreigeber2Id,
```

Add a new import line for `getKontoById`:

```js
import { getKontoById } from '../db/kontenRepo.js';
```

Add a new import line for `getPersonById`:

```js
import { getPersonById } from '../db/personenRepo.js';
```

- [ ] **Step 2: Implement `runFreigabe2ErinnerungenJob`**

In `src/services/cronJobs.js`, directly after `runPoolErinnerungenJob` (after its closing `}` on line 126):

```js
export async function runFreigabe2ErinnerungenJob(db, config, mailer) {
  const gestartetAm = new Date().toISOString();
  try {
    const reminderStunden = Number(getConfigValue(db, 'freigabe2_reminder_stunden'));
    const eskalationStunden = Number(getConfigValue(db, 'freigabe2_eskalation_stunden'));

    let reminderCount = 0;
    for (const job of listFreigabe2JobsForReminder(db, reminderStunden)) {
      const konto = getKontoById(db, job.konto_id);
      if (!konto) continue; // deleted/unresolvable Konto -- listStalledJobs covers this separately
      const akteurId = getEffectiveFreigeber2Id(job, konto);
      const akteur = getPersonById(db, akteurId);
      if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) continue; // ditto -- inactive/unresolved actor

      await sendNotification(db, mailer, {
        to: akteur.email,
        typ: 'freigabe2-reminder',
        jobId: job.id,
        variablen: {
          empfaengerName: `${akteur.vorname} ${akteur.nachname}`,
          jobDateiname: job.dateiname,
          stunden: reminderStunden,
          link: `${config.publicBaseUrl}/freigabe2`,
        },
      });
      markFreigabe2ReminderGesendet(db, job.id);
      reminderCount += 1;
    }

    let eskalationCount = 0;
    for (const job of listFreigabe2JobsForEskalation(db, eskalationStunden)) {
      if (!forceEskalierenFreigabe2AnAdmin(db, job.id)) continue; // race: already handled between the query and here

      const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'freigabe2_eskalation_empfaenger'));
      for (const email of empfaenger) {
        await sendNotification(db, mailer, {
          to: email,
          typ: 'freigabe2-eskalation',
          jobId: job.id,
          variablen: {
            jobDateiname: job.dateiname,
            stunden: eskalationStunden,
            link: `${config.publicBaseUrl}/freigabe2`,
          },
        });
      }
      if (empfaenger.length > 0) {
        markFreigabe2EskalationGesendet(db, job.id);
      }
      eskalationCount += 1;
    }

    const ergebnis = { status: 'erfolg', reminder: reminderCount, eskalation: eskalationCount };
    logCronLauf(db, {
      job: 'freigabe2-erinnerungen',
      gestartetAm,
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Reminder: ${ergebnis.reminder}, Eskalation: ${ergebnis.eskalation}`,
    });
    return ergebnis;
  } catch (err) {
    logCronLauf(db, { job: 'freigabe2-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
```

Note the deliberate difference from `runPoolErinnerungenJob`'s escalation-count semantics: `eskalationCount` counts jobs actually handed to admin (gated by `forceEskalierenFreigabe2AnAdmin`'s own return value), not mail attempts — mirroring how the reminder loop only counts jobs where a real recipient existed. A job with zero resolved `freigabe2_eskalation_empfaenger` still gets hidden from admin (state changes, no marker set — so it's retried next sweep purely for the *mail*, `forceEskalierenFreigabe2AnAdmin`'s `WHERE freigabe2_eskaliert_an_admin = 0` guard naturally no-ops on the retry since the flag is already `1`) — this asymmetry is intentional per the spec's Fehlerfälle section and will be exercised directly in Task 8's tests.

- [ ] **Step 3: Sanity-check the file still parses and existing tests still pass**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS (no new tests added in this task; this just confirms the new function and imports didn't break anything already covered).

- [ ] **Step 4: Commit**

```bash
git add src/services/cronJobs.js
git commit -m "feat(cron): add runFreigabe2ErinnerungenJob (reminder + admin handover)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `routes/cron.js` — `POST /internal/cron/freigabe2-erinnerungen` + integration tests

**Files:**
- Modify: `src/routes/cron.js`
- Test: `test/integration/cron.test.js`

**Interfaces:**
- Consumes: `runFreigabe2ErinnerungenJob` (Task 7).
- Produces: `POST /internal/cron/freigabe2-erinnerungen`, gated by the same `requireCronSecret` mount-level guard as every other route in this router (see the file's header comment, lines 10-12) — consumed by Task 9 (scheduler still calls the function directly, not this route, but this task's tests are the real end-to-end verification of Task 7's logic) and Task 11 (admin manual-trigger button posts through `geplanteJobs.js`, not this route either — this route exists for external/manual triggering only, exactly like its four siblings).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/cron.test.js`, directly after the four existing `pool-erinnerungen` tests (after line 239, before the `pdf-bereinigung` tests begin):

```js
test('POST /internal/cron/freigabe2-erinnerungen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen sends one reminder mail to the effective Freigeber2 and marks it sent, is idempotent on a second run', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(getJobById(db, jobId).freigabe2_reminder_gesendet_at !== null, true);
  const mails = listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].empfaenger, 'p3@example.org', 'must go to the Konto Freigeber2, not a configured group');

  const res2 = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 0, 'the same job must not be reminded twice');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder').length, 1);
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen reminds the Stellvertreter2, not the original Freigeber2, once the job was escalated within freigabe2', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z', freigabe2_eskaliert_von = '3' WHERE id = ?"
  ).run(kontoId, jobId);

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 1);
  const mails = listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder');
  assert.equal(mails[0].empfaenger, 'p4@example.org', 'Stellvertreter2 (person 4), not the original Freigeber2 (person 3)');
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen hands a very-stale job to the admin group and sends the eskalation mail, independent of the reminder', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 1);
  assert.equal(res.body.eskalation, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder').length, 1);
  const eskalationMails = listMailLog(db).filter((m) => m.typ === 'freigabe2-eskalation');
  assert.equal(eskalationMails.length, 1);
  assert.equal(eskalationMails[0].empfaenger, 'admin@example.org');
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_an_admin, 1, 'job must actually be handed to the admin group, not just mailed about');
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen does not mark the reminder sent when the effective Freigeber2 is inactive, so a later sweep (or listStalledJobs) can still handle it', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 0, 'no valid recipient -> not counted as reminded');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder').length, 0);
  assert.equal(getJobById(db, jobId).freigabe2_reminder_gesendet_at, null, 'must stay eligible for retry once the person is reactivated');
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen does not mark the escalation sent when freigabe2_eskalation_empfaenger resolves to zero recipients, but still hands the job to admin', async () => {
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'freigabe2_reminder_stunden', '999999'); // suppress the reminder phase for this test
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  // Deliberately no group-20 (admin) members seeded -> resolveEmpfaenger('gruppe:admin') yields [].
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_seit = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(kontoId, jobId);

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(listMailLog(db).length, 0, 'zero recipients resolved -> no mail attempt');
  assert.equal(getJobById(db, jobId).freigabe2_eskalation_gesendet_at, null);
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_an_admin, 1, 'the handover itself must still happen even with nobody to notify');
  db.close();
});

test('POST /internal/cron/freigabe2-erinnerungen returns a JSON error body (not an HTML error page) when the handler throws', async () => {
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'freigabe2_reminder_stunden', 'kaputt');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/freigabe2-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'fehler');
  assert.equal(typeof res.body.error, 'string');
  assert.equal(res.type, 'application/json');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/cron.test.js`
Expected: FAIL — `POST /internal/cron/freigabe2-erinnerungen` returns 404 (route doesn't exist yet).

- [ ] **Step 3: Register the route**

In `src/routes/cron.js`, add the import:

```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runSplitGruppenNachholenJob, runFreigabe2ErinnerungenJob } from '../services/cronJobs.js';
```

Add the route, directly after the `pool-erinnerungen` route (after line 36, before `pdf-bereinigung`):

```js
  router.post('/freigabe2-erinnerungen', async (req, res, next) => {
    try {
      const result = await runFreigabe2ErinnerungenJob(db, config, mailer);
      res.status(httpStatusFuer(result.status)).json(result);
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/cron.test.js`
Expected: PASS — this exercises Task 7's implementation end-to-end for the first time, so also re-run `node --test test/unit/jobsRepo.test.js test/unit/db.test.js` once here to catch any interaction bug across tasks before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cron.js test/integration/cron.test.js
git commit -m "feat(cron): wire POST /internal/cron/freigabe2-erinnerungen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Scheduler registration

**Files:**
- Modify: `src/services/scheduler.js`
- Test: `test/unit/scheduler.test.js`

**Interfaces:**
- Consumes: `runFreigabe2ErinnerungenJob` (Task 7), `cron_freigabe2_erinnerungen_intervall_minuten` config key (Task 6).
- Produces: the in-process scheduler now also fires `runFreigabe2ErinnerungenJob` on its own interval, exactly like `pool-erinnerungen`.

- [ ] **Step 1: Add `runFreigabe2ErinnerungenJob` to the test file's `fakeJobs` helper**

In `test/unit/scheduler.test.js`, the `fakeJobs(overrides = {})` helper (lines 29-40) stubs every job function `startScheduler` can call; every existing scheduler test builds `jobs: fakeJobs({ ... })`, so any job missing from this default object would be `undefined` and crash `startScheduler` the moment this task registers a new `scheduleInterval` call for it. Add:

```js
function fakeJobs(overrides = {}) {
  return {
    runSyncPersonenJob: async () => ({ status: 'erfolg' }),
    runPoolErinnerungenJob: async () => ({ status: 'erfolg' }),
    runPdfBereinigungJob: () => ({ status: 'erfolg' }),
    runZeitstempelNachholenJob: async () => ({ status: 'erfolg' }),
    runDatenbankSicherungJob: () => ({ status: 'erfolg' }),
    runSplitGruppenNachholenJob: async () => ({ status: 'erfolg' }),
    runMailDigestJob: async () => ({ status: 'erfolg' }),
    runFreigabe2ErinnerungenJob: async () => ({ status: 'erfolg' }),
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

Add, directly after the existing `startScheduler picks up a saved cron_pool_erinnerungen_intervall_minuten change on the next tick` test (after line 98) — exact same structure as that pair of pool-erinnerungen tests, job name and config key swapped:

```js
test('startScheduler runs the freigabe2-erinnerungen job on the configured interval (default 60 minutes)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runFreigabe2ErinnerungenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  db.close();
});

test('startScheduler picks up a saved cron_freigabe2_erinnerungen_intervall_minuten change on the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runFreigabe2ErinnerungenJob: async () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  setConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten', '15');

  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  t.mock.timers.tick(15 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, 'run 3 must honor the shortened 15-minute interval, not wait another 60');
  db.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/unit/scheduler.test.js`
Expected: FAIL — the new job function is never called (not registered yet).

- [ ] **Step 4: Register the job in `scheduler.js`**

Update the import at the top:

```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runDatenbankSicherungJob, runSplitGruppenNachholenJob, runMailDigestJob, runFreigabe2ErinnerungenJob } from './cronJobs.js';
```

Add the destructured default in the function signature's `jobs` parameter (alongside the existing `runPoolErinnerungenJob: erinnerungenJob,` — give this one its own local alias too, e.g. `runFreigabe2ErinnerungenJob: freigabe2ErinnerungenJob,`), following the exact same pattern as lines 90-109.

Add a new `scheduleInterval` block, directly after the existing `pool-erinnerungen` block (after line 135):

```js
  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'), 60) * MINUTE_MS,
    async () => {
      const result = await freigabe2ErinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter freigabe2-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/scheduler.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/scheduler.js test/unit/scheduler.test.js
git commit -m "feat(cron): register freigabe2-erinnerungen on the in-process scheduler

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `/admin/eskalation` — three new fields

**Files:**
- Modify: `src/routes/admin/eskalation.js`
- Modify: `views/admin/eskalation-form.ejs`
- Test: `test/integration/admin/eskalation.test.js`

**Interfaces:**
- Consumes: `freigabe2_reminder_stunden`, `freigabe2_eskalation_stunden`, `freigabe2_eskalation_empfaenger` config keys (Task 6), `validateEmpfaengerListe` (existing, same file, lines 11-25).
- Produces: admin-editable `freigabe2_reminder_stunden`/`freigabe2_eskalation_stunden`/`freigabe2_eskalation_empfaenger`.

- [ ] **Step 1: Write the failing tests**

In `test/integration/admin/eskalation.test.js`, update `VALID_BODY` (line 37) to include the three new fields:

```js
const VALID_BODY = { reminderStunden: '1', eskalationStunden: '2', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'x@example.org', ibanAbweichungEmpfaenger: 'gruppe:admin', freigabe2ReminderStunden: '1', freigabe2EskalationStunden: '2', freigabe2EskalationEmpfaenger: 'gruppe:admin' };
```

(This single change makes every existing 401/403/validation test in the file exercise the new fields too, without further edits — same reason the file structures `VALID_BODY` as a shared constant.)

Add new tests after the existing `GET /admin/eskalation shows the seeded defaults pre-filled` test (after line 86):

```js
test('GET /admin/eskalation shows the seeded freigabe2 defaults pre-filled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /freigabe2ReminderStunden/);
  assert.match(res.text, /gruppe:admin/);
  db.close();
});

test('POST /admin/eskalation with valid values persists the freigabe2 fields', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2ReminderStunden: '30', freigabe2EskalationStunden: '72', freigabe2EskalationEmpfaenger: 'admin@musterkirche.ch' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'freigabe2_reminder_stunden'), '30');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_stunden'), '72');
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_empfaenger'), 'admin@musterkirche.ch');
  db.close();
});

test('POST /admin/eskalation with an invalid freigabe2 Stunden value is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2EskalationStunden: '0' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'freigabe2_eskalation_stunden'), '48');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: FAIL — new fields aren't rendered/validated/persisted yet; also the pre-existing `POST valid values persists them` test may now fail if the POST handler starts requiring the three new fields before you add them to `VALID_BODY` in step 1 — that's already handled above.

- [ ] **Step 3: Update `views/admin/eskalation-form.ejs`**

Add a new section after the existing `eskalationEmpfaenger` block (after line 36) and before the `ibanAbweichungEmpfaenger` block:

```html
      <hr class="my-3">
      <h2 class="h5">Freigabe 2 — Erinnerung bei Untätigkeit</h2>
      <div class="mb-3">
        <label class="form-label" for="freigabe2ReminderStunden">Reminder an Freigeber 2 nach (Stunden)</label>
        <input type="number" class="form-control" id="freigabe2ReminderStunden" name="freigabe2ReminderStunden" value="<%= freigabe2ReminderStunden %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="freigabe2EskalationStunden">Automatische Übergabe an Admin nach (Stunden)</label>
        <input type="number" class="form-control" id="freigabe2EskalationStunden" name="freigabe2EskalationStunden" value="<%= freigabe2EskalationStunden %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="freigabe2EskalationEmpfaenger">Empfänger der Übergabe-Benachrichtigung (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:admin"/"gruppe:buchhaltung")</label>
        <textarea class="form-control" id="freigabe2EskalationEmpfaenger" name="freigabe2EskalationEmpfaenger" rows="4"><%= freigabe2EskalationEmpfaenger || '' %></textarea>
      </div>
```

- [ ] **Step 4: Update `src/routes/admin/eskalation.js`**

In the `GET /` handler (lines 30-40), add to the render object:

```js
  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      reminderEmpfaenger: getConfigValue(db, 'reminder_empfaenger'),
      eskalationEmpfaenger: getConfigValue(db, 'eskalation_empfaenger'),
      ibanAbweichungEmpfaenger: getConfigValue(db, 'iban_abweichung_empfaenger'),
      freigabe2ReminderStunden: getConfigValue(db, 'freigabe2_reminder_stunden'),
      freigabe2EskalationStunden: getConfigValue(db, 'freigabe2_eskalation_stunden'),
      freigabe2EskalationEmpfaenger: getConfigValue(db, 'freigabe2_eskalation_empfaenger'),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });
```

In the `POST /` handler (lines 42-68), update the destructure, validation, and both `res.render`/`setConfigValue` calls:

```js
  router.post('/', csrfProtection, (req, res) => {
    const { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger, freigabe2ReminderStunden, freigabe2EskalationStunden, freigabe2EskalationEmpfaenger } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    const freigabe2ReminderNum = Number(freigabe2ReminderStunden);
    const freigabe2EskalationNum = Number(freigabe2EskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(freigabe2ReminderNum) || freigabe2ReminderNum <= 0) {
      errors.push('Freigabe 2 – Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(freigabe2EskalationNum) || freigabe2EskalationNum <= 0) {
      errors.push('Freigabe 2 – Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(reminderEmpfaenger, 'Reminder-Empfänger', errors);
    validateEmpfaengerListe(eskalationEmpfaenger, 'Eskalations-Empfänger', errors);
    validateEmpfaengerListe(ibanAbweichungEmpfaenger, 'IBAN-Abweichungs-Empfänger', errors);
    validateEmpfaengerListe(freigabe2EskalationEmpfaenger, 'Freigabe 2 – Übergabe-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, ibanAbweichungEmpfaenger, freigabe2ReminderStunden, freigabe2EskalationStunden, freigabe2EskalationEmpfaenger, errors, gespeichert: false });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    setConfigValue(db, 'iban_abweichung_empfaenger', ibanAbweichungEmpfaenger.trim());
    setConfigValue(db, 'freigabe2_reminder_stunden', String(freigabe2ReminderNum));
    setConfigValue(db, 'freigabe2_eskalation_stunden', String(freigabe2EskalationNum));
    setConfigValue(db, 'freigabe2_eskalation_empfaenger', freigabe2EskalationEmpfaenger.trim());
    res.redirect('/admin/eskalation?gespeichert=1');
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/eskalation.js views/admin/eskalation-form.ejs test/integration/admin/eskalation.test.js
git commit -m "feat(admin): add freigabe2 reminder/eskalation fields to /admin/eskalation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `/admin/geplante-jobs` — new section, interval config, manual trigger

**Files:**
- Modify: `src/routes/admin/geplanteJobs.js`
- Modify: `views/admin/geplante-jobs.ejs`
- Test: `test/integration/admin/geplanteJobs.test.js`

**Interfaces:**
- Consumes: `runFreigabe2ErinnerungenJob` (Task 7), `cron_freigabe2_erinnerungen_intervall_minuten` (Task 6), `listRecentCronLog` (existing, `cronLogRepo.js`).
- Produces: `POST /admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren` (consumed by Task 13's CSRF sweep list).

- [ ] **Step 1: Write the failing tests**

In `test/integration/admin/geplanteJobs.test.js`, add the new field to `VALID_BODY` (line 56-64):

```js
const VALID_BODY = {
  syncPersonenStunde: '3',
  syncPersonenMinute: '15',
  poolErinnerungenIntervallMinuten: '30',
  pdfBereinigungStunde: '4',
  pdfBereinigungMinute: '45',
  zeitstempelNachholenIntervallMinuten: '10',
  splitGruppenNachholenIntervallMinuten: '20',
  freigabe2ErinnerungenIntervallMinuten: '15',
};
```

Add new tests, mirroring the existing `poolErinnerungenIntervallMinuten` ones (search for `poolErinnerungenIntervallMinuten` in the test file to find their exact neighborhood):

```js
test('POST /admin/geplante-jobs with an invalid freigabe2ErinnerungenIntervallMinuten value is rejected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/geplante-jobs')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2ErinnerungenIntervallMinuten: '0' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/geplante-jobs with valid values persists freigabe2ErinnerungenIntervallMinuten', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/geplante-jobs').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'), '15');
  db.close();
});

test('POST /admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren triggers the job and redirects with getriggert marker', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/geplante-jobs?getriggert=freigabe2-erinnerungen');
  db.close();
});
```

(Check the file's imports — `getConfigValue` from `adminConfigRepo.js` is very likely already imported for the existing interval assertions; add only what's missing.)

Also add the new route to whatever `*_ROUTES` array or 401/403 sweep list already exists in the file (mirror the existing `pool-erinnerungen/jetzt-ausfuehren` entry).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/geplanteJobs.test.js`
Expected: FAIL — new field/route don't exist yet.

- [ ] **Step 3: Update `src/routes/admin/geplanteJobs.js`**

Add the import:

```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runSplitGruppenNachholenJob, runFreigabe2ErinnerungenJob } from '../../services/cronJobs.js';
```

In `ladeState` (lines 12-28), add:

```js
      cronFreigabe2ErinnerungenIntervallMinuten: getConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten'),
      freigabe2ErinnerungenLog: listRecentCronLog(db, 'freigabe2-erinnerungen', LOG_LIMIT),
```

(add both alongside the existing `cronPoolErinnerungenIntervallMinuten`/`poolErinnerungenLog` lines)

In the `POST /` handler (lines 38-103): add `freigabe2ErinnerungenIntervallMinuten` to the destructure, validate it the same way as `splitGruppenNachholenIntervallMinuten` (`ganzzahlImBereich` isn't used for these interval fields — they use the plain `Number(...) > 0` check like `poolErinnerungenIntervallMinuten`/`zeitstempelNachholenIntervallMinuten`/`splitGruppenNachholenIntervallMinuten`), add it to both the error-path `res.render` object and the success-path `setConfigValue` call:

```js
    const {
      syncPersonenStunde,
      syncPersonenMinute,
      poolErinnerungenIntervallMinuten,
      pdfBereinigungStunde,
      pdfBereinigungMinute,
      zeitstempelNachholenIntervallMinuten,
      splitGruppenNachholenIntervallMinuten,
      freigabe2ErinnerungenIntervallMinuten,
    } = req.body;
```

```js
    const freigabe2ErinnerungenIntervallNum = Number(freigabe2ErinnerungenIntervallMinuten);
    if (!Number.isInteger(freigabe2ErinnerungenIntervallNum) || freigabe2ErinnerungenIntervallNum <= 0) {
      errors.push('Freigabe2-Erinnerungen: Intervall muss eine positive Ganzzahl (Minuten) sein.');
    }
```

(place this block right after the existing `splitGruppenNachholenIntervallNum` validation)

```js
    if (errors.length > 0) {
      return res.status(400).render('admin/geplante-jobs', {
        cronSyncPersonenStunde: syncPersonenStunde,
        cronSyncPersonenMinute: syncPersonenMinute,
        cronPoolErinnerungenIntervallMinuten: poolErinnerungenIntervallMinuten,
        cronPdfBereinigungStunde: pdfBereinigungStunde,
        cronPdfBereinigungMinute: pdfBereinigungMinute,
        cronZeitstempelNachholenIntervallMinuten: zeitstempelNachholenIntervallMinuten,
        cronSplitGruppenNachholenIntervallMinuten: splitGruppenNachholenIntervallMinuten,
        cronFreigabe2ErinnerungenIntervallMinuten: freigabe2ErinnerungenIntervallMinuten,
        syncLog: listRecentSyncLogs(db, LOG_LIMIT),
        poolErinnerungenLog: listRecentCronLog(db, 'pool-erinnerungen', LOG_LIMIT),
        pdfBereinigungLog: listRecentCronLog(db, 'pdf-bereinigung', LOG_LIMIT),
        zeitstempelNachholenLog: listRecentCronLog(db, 'zeitstempel-nachholen', LOG_LIMIT),
        splitGruppenNachholenLog: listRecentCronLog(db, 'split-gruppen-nachholen', LOG_LIMIT),
        freigabe2ErinnerungenLog: listRecentCronLog(db, 'freigabe2-erinnerungen', LOG_LIMIT),
        getriggert: null,
        errors,
        gespeichert: false,
      });
    }

    setConfigValue(db, 'cron_sync_personen_stunde', String(syncStundeNum));
    setConfigValue(db, 'cron_sync_personen_minute', String(syncMinuteNum));
    setConfigValue(db, 'cron_pool_erinnerungen_intervall_minuten', String(intervallNum));
    setConfigValue(db, 'cron_pdf_bereinigung_stunde', String(pdfStundeNum));
    setConfigValue(db, 'cron_pdf_bereinigung_minute', String(pdfMinuteNum));
    setConfigValue(db, 'cron_zeitstempel_nachholen_intervall_minuten', String(zeitstempelIntervallNum));
    setConfigValue(db, 'cron_split_gruppen_nachholen_intervall_minuten', String(splitGruppenNachholenIntervallNum));
    setConfigValue(db, 'cron_freigabe2_erinnerungen_intervall_minuten', String(freigabe2ErinnerungenIntervallNum));
    res.redirect('/admin/geplante-jobs?gespeichert=1');
```

Add the manual-trigger route, directly after `split-gruppen-nachholen/jetzt-ausfuehren` (after line 153):

```js
  router.post('/freigabe2-erinnerungen/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runFreigabe2ErinnerungenJob(db, config, mailer);
      res.redirect('/admin/geplante-jobs?getriggert=freigabe2-erinnerungen');
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: Update `views/admin/geplante-jobs.ejs`**

Add a new form section, directly after the existing "Splitgruppen-Nachholen" section (after line 60, before "PDF-Bereinigung"):

```html
      <h2 class="h5 mt-3">Freigabe2-Erinnerungen</h2>
      <div class="row g-2 mb-3">
        <div class="col-6 col-md-3">
          <label class="form-label" for="freigabe2ErinnerungenIntervallMinuten">Intervall (Minuten)</label>
          <input type="number" min="1" class="form-control" id="freigabe2ErinnerungenIntervallMinuten" name="freigabe2ErinnerungenIntervallMinuten" value="<%= cronFreigabe2ErinnerungenIntervallMinuten %>" required>
        </div>
      </div>
      <p class="text-muted small">Die Reminder-/Eskalations-<strong>Schwellen</strong> werden separat unter <a href="/admin/eskalation">Eskalationszeiten</a> eingestellt — hier nur, wie oft diese Prüfung läuft.</p>
```

Add a new history section, directly after the existing "Splitgruppen-Nachholen — Verlauf" block (after line 244, before `</main>`):

```html
    <h2 class="h4 mt-4">Freigabe2-Erinnerungen — Verlauf</h2>
    <form method="post" action="/admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren" class="mb-2">
      <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
      <button type="submit" class="btn btn-outline-secondary btn-sm">Jetzt ausführen</button>
    </form>
    <% if (getriggert === 'freigabe2-erinnerungen' && freigabe2ErinnerungenLog.length > 0) { %>
      <% const letzteFreigabe2Erinnerung = freigabe2ErinnerungenLog[0]; %>
      <div class="alert <%= letzteFreigabe2Erinnerung.status === 'erfolg' ? 'alert-success' : 'alert-danger' %>">
        <%= letzteFreigabe2Erinnerung.status === 'erfolg' ? 'Erfolgreich ausgeführt. ' + letzteFreigabe2Erinnerung.details : 'Fehlgeschlagen: ' + letzteFreigabe2Erinnerung.details %>
      </div>
    <% } %>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Gestartet</th><th>Beendet</th><th>Status</th><th>Details</th></tr></thead>
        <tbody>
          <% freigabe2ErinnerungenLog.forEach((eintrag) => { %>
            <tr>
              <td><%= eintrag.gestartet_am %></td>
              <td><%= eintrag.beendet_am %></td>
              <td><%= eintrag.status %></td>
              <td><%= eintrag.details || '' %></td>
            </tr>
          <% }) %>
          <% if (freigabe2ErinnerungenLog.length === 0) { %><tr><td colspan="4">Noch keine Läufe.</td></tr><% } %>
        </tbody>
      </table>
    </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/admin/geplanteJobs.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/geplanteJobs.js views/admin/geplante-jobs.ejs test/integration/admin/geplanteJobs.test.js
git commit -m "feat(admin): add Freigabe2-Erinnerungen section to /admin/geplante-jobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: `/admin/mail-einstellungen` — two new template fields

**Files:**
- Modify: `src/routes/admin/mailEinstellungen.js`
- Modify: `views/admin/mail-einstellungen-form.ejs`
- Test: `test/integration/admin/mailEinstellungen.test.js`

**Interfaces:**
- Consumes: `mail_vorlage_freigabe2_reminder_betreff`/`_text`, `mail_vorlage_freigabe2_eskalation_betreff`/`_text` (Task 6).
- Produces: admin-editable freigabe2 mail templates.

- [ ] **Step 1: Write the failing tests**

In `test/integration/admin/mailEinstellungen.test.js`, update `VALID_BODY` (line 42-54) to include the four new fields:

```js
const VALID_BODY = {
  zuweisungBetreff: 'B1', zuweisungText: 'T1',
  reminderBetreff: 'B2', reminderText: 'T2',
  eskalationBetreff: 'B3', eskalationText: 'T3',
  ablehnungBetreff: 'B4', ablehnungText: 'T4',
  syncFehlerBetreff: 'B5', syncFehlerText: 'T5',
  ibanWarnungBetreff: 'B6', ibanWarnungText: 'T6',
  rechnungsnummerWarnungBetreff: 'B7', rechnungsnummerWarnungText: 'T7',
  digestBetreff: 'B8', digestText: 'T8',
  freigabe2ReminderBetreff: 'B9', freigabe2ReminderText: 'T9',
  freigabe2EskalationBetreff: 'B10', freigabe2EskalationText: 'T10',
  batchingAktiv: '1',
  batchingStunde: '6',
  batchingMinute: '30',
};
```

Add a test after the existing `POST ... with valid values persists them` test:

```js
test('POST /admin/mail-einstellungen persists the freigabe2 template fields', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_betreff'), 'B9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_reminder_text'), 'T9');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_betreff'), 'B10');
  assert.equal(getConfigValue(db, 'mail_vorlage_freigabe2_eskalation_text'), 'T10');
  db.close();
});

test('POST /admin/mail-einstellungen rejects an empty freigabe2ReminderBetreff', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/mail-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, freigabe2ReminderBetreff: '' });
  assert.equal(res.status, 400);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/mailEinstellungen.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `VORLAGEN_FELDER` in `src/routes/admin/mailEinstellungen.js`**

Add to the array (lines 8-25), after the `digestText` entry:

```js
  ['freigabe2ReminderBetreff', 'mail_vorlage_freigabe2_reminder_betreff'],
  ['freigabe2ReminderText', 'mail_vorlage_freigabe2_reminder_text'],
  ['freigabe2EskalationBetreff', 'mail_vorlage_freigabe2_eskalation_betreff'],
  ['freigabe2EskalationText', 'mail_vorlage_freigabe2_eskalation_text'],
```

No other change needed in this file — `ladeState`, the `GET`, and the `POST` handler all iterate `VORLAGEN_FELDER` generically (see lines 30-43, 53-93), unlike `/admin/eskalation`.

- [ ] **Step 4: Update `views/admin/mail-einstellungen-form.ejs`**

Add a new field block, directly after the existing `digestText` block (after line 89, before the `<button type="submit">`):

```html
      <div class="mb-3">
        <label class="form-label" for="freigabe2ReminderBetreff">Freigabe 2 – Reminder — Betreff</label>
        <input type="text" class="form-control" id="freigabe2ReminderBetreff" name="freigabe2ReminderBetreff" value="<%= freigabe2ReminderBetreff %>" required>
        <label class="form-label mt-2" for="freigabe2ReminderText">Freigabe 2 – Reminder — Text</label>
        <textarea class="form-control" id="freigabe2ReminderText" name="freigabe2ReminderText" rows="4" required><%= freigabe2ReminderText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="freigabe2EskalationBetreff">Freigabe 2 – Eskalation — Betreff</label>
        <input type="text" class="form-control" id="freigabe2EskalationBetreff" name="freigabe2EskalationBetreff" value="<%= freigabe2EskalationBetreff %>" required>
        <label class="form-label mt-2" for="freigabe2EskalationText">Freigabe 2 – Eskalation — Text</label>
        <textarea class="form-control" id="freigabe2EskalationText" name="freigabe2EskalationText" rows="4" required><%= freigabe2EskalationText %></textarea>
      </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/admin/mailEinstellungen.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/mailEinstellungen.js views/admin/mail-einstellungen-form.ejs test/integration/admin/mailEinstellungen.test.js
git commit -m "feat(admin): add freigabe2-reminder/eskalation templates to /admin/mail-einstellungen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: CSRF sweep coverage

**Files:**
- Modify: `test/integration/csrfSweep.test.js`

**Interfaces:**
- Consumes: `POST /admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren` (Task 11) — the only genuinely new route added across this whole plan (`/admin/eskalation` and `/admin/mail-einstellungen` already have sweep entries from before this feature; their new fields don't add new routes).

- [ ] **Step 1: Add the route to the sweep list**

In `test/integration/csrfSweep.test.js`, add to the route array, directly after the existing `'/admin/geplante-jobs/split-gruppen-nachholen/jetzt-ausfuehren',` entry (line 101):

```js
  '/admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren',
```

- [ ] **Step 2: Run the sweep test**

Run: `node --test test/integration/csrfSweep.test.js`
Expected: PASS — this test enumerates the array and asserts each POST route rejects a request without a valid CSRF token; it should pass immediately since Task 11 already wired `csrfProtection` onto the new route via the same router-level middleware every other route in that file uses.

- [ ] **Step 3: Commit**

```bash
git add test/integration/csrfSweep.test.js
git commit -m "test: extend CSRF sweep to the new freigabe2-erinnerungen trigger route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/geplante-jobs-und-benachrichtigungen.md`
- Modify: `docs/rechnungs-workflow.md`
- Modify: `docs/admin-bereich.md`

**Interfaces:** none — documentation only, no code/tests.

- [ ] **Step 1: Update `docs/geplante-jobs-und-benachrichtigungen.md`**

Read the file first to find the existing "Pool-Erinnerungen" section and match its structure/heading level exactly. Add a new section "Freigabe2-Erinnerungen" describing: the two-phase reminder/escalation mechanism, that it targets the actually-responsible person (not a configured group) for the reminder, that escalation performs a real handover via `forceEskalierenFreigabe2AnAdmin` (not just a mail), the two new config keys' locations (`/admin/eskalation` for thresholds/recipients, `/admin/geplante-jobs` for the run interval), and the interaction with `listStalledJobs`/Personen-Sync (this new mechanism handles an active-but-idle person; the stale-actor mechanism still separately handles a deactivated/unresolvable one). If the doc has a Mermaid flow diagram for pool-erinnerungen, add an analogous one here reusing the diagram from the spec file's "Neuer Cron-Job" section.

- [ ] **Step 2: Update `docs/rechnungs-workflow.md`**

Find the `freigabe2` section of the state-machine writeup. Add a short paragraph noting that a job sitting in `freigabe2` now escalates on a timer instead of waiting indefinitely — link to `docs/geplante-jobs-und-benachrichtigungen.md`'s new section for the mechanics.

- [ ] **Step 3: Update `docs/admin-bereich.md`**

In the `/admin/mail-einstellungen` description, add the two new mail types (`freigabe2-reminder`, `freigabe2-eskalation`) to whatever list/table already enumerates the existing ones. In the `/admin/eskalation` description, add the three new fields.

- [ ] **Step 4: Commit**

```bash
git add docs/geplante-jobs-und-benachrichtigungen.md docs/rechnungs-workflow.md docs/admin-bereich.md
git commit -m "docs: document freigabe2-erinnerungen mechanism, config, and mail types

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Verification

After all 14 tasks:

- [ ] Run the full test suite: `npm test` (or `node --test` across the whole `test/` tree, matching however `package.json`'s `test` script invokes it — check `package.json` if unsure). Expected: all tests PASS, no regressions anywhere (this feature touches shared files — `jobsRepo.js`, `cronJobs.js`, `scheduler.js`, `db/index.js`, `schema.sql` — used by dozens of unrelated test files).
- [ ] Manually smoke-test in a running instance (per this project's CLAUDE.md guidance on testing UI changes before claiming completion): start the app, seed a `freigabe2` job with an old `freigabe2_seit`, POST `/admin/geplante-jobs/freigabe2-erinnerungen/jetzt-ausfuehren` as a superadmin, confirm the reminder mail appears in `/admin/mails`, confirm `/admin/eskalation` and `/admin/mail-einstellungen` render and save the new fields correctly.
