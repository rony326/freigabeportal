# Globales durchsuchbares Audit-Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `/admin/audit-log` page that aggregates `freigaben` (all jobs) and `job_loeschungen` into one searchable, filterable, paginated admin view.

**Architecture:** A new SQL-level aggregation service (`queryGlobalAuditLog`) UNIONs the two source tables into a normalized row shape and pushes all filtering/pagination down into SQL (no in-memory loading of the full table). A new additive permission (`audit_log_einsehen`) gates a new route + view, wired into the existing permission/nav/admin-mount infrastructure exactly like `mails_einsehen`/`sync_einsehen`.

**Tech Stack:** Node.js, Express, EJS views, `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict` + `supertest` for tests.

**Spec:** `docs/superpowers/specs/2026-08-29-globales-audit-log-design.md`

## Global Constraints

- All filters are optional and AND-combined (see spec's Filter-Semantik section).
- Pagination is server-side, hard-capped at 50 entries/page — no client-supplied page-size override.
- No CSV export, no additional data sources beyond `freigaben`/`job_loeschungen` (explicitly out of scope in the spec).
- `job_loeschungen`/`jobs`/`konten` joins are `LEFT JOIN` (job/konto rows are not guaranteed to exist, even though in practice they do via soft-delete — see spec's Datenquellen-Abschnitt).
- Follow existing repo conventions exactly: `db.prepare(...).all(...)/.get(...)/.run(...)` with positional `?` placeholders, one function per concern, additive migrations use the rename→create→copy→drop pattern (never `ALTER TABLE ... CHECK`, which SQLite doesn't support).

---

## Task 1: Widen `person_berechtigungen` CHECK constraint to allow `audit_log_einsehen`

**Files:**
- Modify: `src/db/schema.sql:14-24` (comment + CHECK list, for fresh databases)
- Modify: `src/db/index.js:212-224` (`openDatabase`, add migration call)
- Modify: `src/db/index.js` (new function `migratePersonBerechtigungenTable`, add near the other `migrate*Table` functions, after `migrateCronLogTable`)
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `person_berechtigungen.berechtigung` CHECK now accepts `'audit_log_einsehen'` in addition to the existing six values, on both fresh and pre-existing (migrated) databases.

- [ ] **Step 1: Write the failing migration test**

Add to `test/unit/db.test.js` (same file already imports `DatabaseSync`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `openDatabase` — reuse those, don't re-import):

```javascript
test('openDatabase rebuilds the person_berechtigungen table to widen its berechtigung CHECK constraint to include audit_log_einsehen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE person_berechtigungen (
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      berechtigung TEXT NOT NULL CHECK (berechtigung IN (
        'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
        'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen'
      )),
      PRIMARY KEY (person_id, berechtigung)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Nur', 'Sync', 'n@example.org');
    INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'sync_einsehen');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM person_berechtigungen WHERE person_id = ?').get('1');
  assert.equal(preserved.berechtigung, 'sync_einsehen', 'existing rows must survive the rebuild');
  assert.doesNotThrow(() =>
    migratedDb.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'audit_log_einsehen')").run(),
    'the widened CHECK constraint must accept audit_log_einsehen'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase is a no-op on the person_berechtigungen table when it already has the widened berechtigung CHECK constraint', () => {
  const db = openDatabase(':memory:');
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get().sql;
  const dbAgain = openDatabase(':memory:');
  const after = dbAgain.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get().sql;
  assert.equal(before, after);
  db.close();
  dbAgain.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: the first new test FAILS with a CHECK constraint violation (`CHECK constraint failed`) on the `INSERT ... 'audit_log_einsehen'` line, since the migration doesn't exist yet.

- [ ] **Step 3: Widen the CHECK in `schema.sql`**

In `src/db/schema.sql`, update the comment and `CREATE TABLE IF NOT EXISTS person_berechtigungen` block (lines 11-24):

```sql
-- Additive Einzelrechte pro Person, unabhängig von der ChurchTools-Rolle (superadmin/manager).
-- Nur die sieben vergebbaren Rechte sind hier zulässig -- die drei hart gesperrten Admin-Bereiche
-- (Eskalationszeiten, Erscheinungsbild, Zeitstempel) sowie das Bearbeiten dieser Tabelle selbst
-- sind strukturell nicht einfügbar, unabhängig von der Anwendungslogik.
CREATE TABLE IF NOT EXISTS person_berechtigungen (
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  berechtigung TEXT NOT NULL CHECK (berechtigung IN (
    'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
    'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen'
  )),
  PRIMARY KEY (person_id, berechtigung)
);
```

- [ ] **Step 4: Add the migration function in `src/db/index.js`**

Insert directly after `migrateCronLogTable` (before `export function openDatabase`):

```javascript
// Same rationale as migrateFreigabenTable above: an already-existing person_berechtigungen table
// (any database whose berechtigung CHECK predates 'audit_log_einsehen') keeps its original,
// narrower CHECK forever otherwise, since `CREATE TABLE IF NOT EXISTS` in schema.sql no-ops on it.
function migratePersonBerechtigungenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get();
  if (!tableSql || tableSql.sql.includes('audit_log_einsehen')) return;

  // See the matching comment in migrateFreigabenTable above: node:sqlite enforces
  // `PRAGMA foreign_keys` by default, so a single person_berechtigungen row referencing a
  // personen.churchtools_person_id that no longer exists would otherwise abort this INSERT.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE person_berechtigungen RENAME TO person_berechtigungen_pre_audit_log_einsehen');
    db.exec(`
      CREATE TABLE person_berechtigungen (
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        berechtigung TEXT NOT NULL CHECK (berechtigung IN (
          'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
          'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen'
        )),
        PRIMARY KEY (person_id, berechtigung)
      )
    `);
    db.exec(`
      INSERT INTO person_berechtigungen (person_id, berechtigung)
      SELECT person_id, berechtigung FROM person_berechtigungen_pre_audit_log_einsehen
    `);
    db.exec('DROP TABLE person_berechtigungen_pre_audit_log_einsehen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

Then register it in `openDatabase` (`src/db/index.js:212-224`):

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
  migrateCronLogTable(db);
  migratePersonBerechtigungenTable(db);
  return db;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat: widen person_berechtigungen CHECK to allow audit_log_einsehen"
```

---

## Task 2: Add `audit_log_einsehen` to the permission catalog

**Files:**
- Modify: `src/middleware/permissions.js:4-18`
- Test: `test/unit/permissions.test.js:13-18`

**Interfaces:**
- Consumes: nothing new (uses Task 1's widened CHECK indirectly, since `setBerechtigungenForPerson`/`personHasBerechtigung` from `src/db/personBerechtigungenRepo.js` insert into that table).
- Produces: `GRANTABLE_BERECHTIGUNGEN` includes `'audit_log_einsehen'`; `BERECHTIGUNG_LABELS.audit_log_einsehen === 'Globales Audit-Log einsehen'`.

- [ ] **Step 1: Update the failing test**

In `test/unit/permissions.test.js`, change the existing test (lines 13-18) to expect seven permissions:

```javascript
test('GRANTABLE_BERECHTIGUNGEN lists exactly the seven catalog permissions', () => {
  assert.deepEqual(
    [...GRANTABLE_BERECHTIGUNGEN].sort(),
    ['abgelehnt_verwalten', 'audit_log_einsehen', 'debitoren_verwalten', 'geplante_jobs_verwalten', 'konten_verwalten', 'mails_einsehen', 'sync_einsehen']
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/permissions.test.js`
Expected: FAIL — actual array is missing `'audit_log_einsehen'`.

- [ ] **Step 3: Add the permission to the catalog**

In `src/middleware/permissions.js`, update lines 4-18:

```javascript
export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'debitoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
  'audit_log_einsehen',
];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  debitoren_verwalten: 'Debitoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
  audit_log_einsehen: 'Globales Audit-Log einsehen',
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/permissions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/permissions.js test/unit/permissions.test.js
git commit -m "feat: add audit_log_einsehen to the grantable permission catalog"
```

---

## Task 3: Export shared audit-log helpers, add the `loeschung` event label

**Files:**
- Modify: `src/services/auditLog.js:5-22`
- Test: `test/unit/auditLog.test.js`

**Interfaces:**
- Produces: `export function personName(db, personId)`, `export function formatZeitpunkt(iso, lokaleZeit)`, `EREIGNIS_LABEL.loeschung === 'Job gelöscht'` — all consumed by Task 4's `globalAuditLog.js`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/auditLog.test.js` (it already imports `openDatabase`, `upsertPerson`; add `personName`, `formatZeitpunkt` to the existing `buildAuditLog` import line):

```javascript
import { buildAuditLog, EREIGNIS_LABEL, personName, formatZeitpunkt } from '../../src/services/auditLog.js';
```

```javascript
test('EREIGNIS_LABEL includes a loeschung label for the global audit log', () => {
  assert.equal(EREIGNIS_LABEL.loeschung, 'Job gelöscht');
});

test('personName and formatZeitpunkt are exported for reuse by the global audit log service', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [], loggedInNow: false });
  assert.equal(personName(db, '1'), 'Frei Geber');
  assert.equal(personName(db, 'unbekannt'), 'Unbekannt');
  assert.equal(formatZeitpunkt('2026-08-15T08:30:00.000Z', false), '2026-08-15T08:30:00.000Z');
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/auditLog.test.js`
Expected: FAIL — `personName`/`formatZeitpunkt` are `undefined` (not exported), and `EREIGNIS_LABEL.loeschung` is `undefined`.

- [ ] **Step 3: Export the helpers and add the label**

In `src/services/auditLog.js`, update the `EREIGNIS_LABEL` map (lines 5-12) and the two function declarations (lines 19, 28):

```javascript
export const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1 erteilt',
  freigeber2: 'Freigabe 2 erteilt',
  ablehnung: 'Abgelehnt',
  freigabe1_eskalation: 'Freigabe 1: Interessenskonflikt gemeldet',
  freigabe2_eskalation: 'Freigabe 2: Interessenskonflikt gemeldet',
  iban_abweichung: 'IBAN-Abweichung festgestellt',
  loeschung: 'Job gelöscht',
};
```

```javascript
export function personName(db, personId) {
  const person = getPersonById(db, personId);
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}
```

```javascript
export function formatZeitpunkt(iso, lokaleZeit) {
```

(only the `export` keywords are added to the two existing function declarations — bodies stay exactly as they are.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/auditLog.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/services/auditLog.js test/unit/auditLog.test.js
git commit -m "feat: export personName/formatZeitpunkt and add a loeschung event label"
```

---

## Task 4: `queryGlobalAuditLog` service — SQL UNION with filters and pagination

**Files:**
- Create: `src/services/globalAuditLog.js`
- Test: `test/unit/globalAuditLog.test.js`

**Interfaces:**
- Consumes: `personName`, `formatZeitpunkt`, `EREIGNIS_LABEL` from `src/services/auditLog.js` (Task 3); `getConfigValue` from `src/db/adminConfigRepo.js`.
- Produces: `export function queryGlobalAuditLog(db, filter = {}, { seite = 1, proSeite = 50 } = {})` returning `{ eintraege: Array<{ zeitpunkt, ereignis, person, jobId, dateiname, kontoBezeichnung, kommentar, jobStatus }>, gesamtAnzahl, seite, proSeite }`. `filter` accepts `{ personId, kontoId, von, bis, ereignisTyp, suchbegriff }`, all optional.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/globalAuditLog.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, setKontierung } from '../../src/db/jobsRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { logJobLoeschung } from '../../src/db/jobLoeschungenRepo.js';
import { queryGlobalAuditLog } from '../../src/services/globalAuditLog.js';

function seedGrundstock(db) {
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'f@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Andrea', nachname: 'Admin', email: 'a@example.org', gruppen: [], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '1000', bezeichnung: 'Büromaterial', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '2', stellvertreter2Id: '2' });
  return { kontoId };
}

test('queryGlobalAuditLog merges freigaben and job_loeschungen, sorted zeitpunkt DESC, with no filter', () => {
  const db = openDatabase(':memory:');
  const { kontoId } = seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobA, kontoId);
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: 'ok', eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const { eintraege, gesamtAnzahl } = queryGlobalAuditLog(db);
  assert.equal(gesamtAnzahl, 2);
  assert.equal(eintraege.length, 2);
  assert.equal(eintraege[0].dateiname, 'b.pdf', 'the later job_loeschungen row must come first (DESC)');
  assert.equal(eintraege[0].ereignis, 'Job gelöscht');
  assert.equal(eintraege[0].person, 'Andrea Admin');
  assert.equal(eintraege[0].kommentar, 'Duplikat');
  assert.equal(eintraege[1].dateiname, 'a.pdf');
  assert.equal(eintraege[1].ereignis, 'Freigabe 1 erteilt');
  assert.equal(eintraege[1].kontoBezeichnung, 'Büromaterial');
  db.close();
});

test('queryGlobalAuditLog filters by personId (the acting person on both sources)', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const { eintraege } = queryGlobalAuditLog(db, { personId: '2' });
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by kontoId', () => {
  const db = openDatabase(':memory:');
  const { kontoId } = seedGrundstock(db);
  const jobMitKonto = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'mit-konto.pdf', pdfPfad: '/tmp/x.pdf' });
  setKontierung(db, jobMitKonto, kontoId);
  createFreigabe(db, { jobId: jobMitKonto, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobOhneKonto = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'ohne-konto.pdf', pdfPfad: '/tmp/y.pdf' });
  createFreigabe(db, { jobId: jobOhneKonto, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-02T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const { eintraege } = queryGlobalAuditLog(db, { kontoId });
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'mit-konto.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by von/bis (inclusive) on zeitpunkt', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber2', zeitpunkt: '2026-08-10T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const nurErste = queryGlobalAuditLog(db, { von: '2026-08-01', bis: '2026-08-05' });
  assert.equal(nurErste.eintraege.length, 1);
  assert.equal(nurErste.eintraege[0].ereignis, 'Freigabe 1 erteilt');

  const beide = queryGlobalAuditLog(db, { von: '2026-08-01', bis: '2026-08-10T23:59:59.999Z' });
  assert.equal(beide.eintraege.length, 2);
  db.close();
});

test('queryGlobalAuditLog filters by ereignisTyp, including the loeschung pseudo-type', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Duplikat' });

  const nurLoeschung = queryGlobalAuditLog(db, { ereignisTyp: 'loeschung' });
  assert.equal(nurLoeschung.eintraege.length, 1);
  assert.equal(nurLoeschung.eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog filters by suchbegriff across kommentar and dateiname (case-insensitive)', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-swisscom.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'b.pdf', geloeschtVon: '2', begruendung: 'Verdacht auf Duplikat' });

  const perDateiname = queryGlobalAuditLog(db, { suchbegriff: 'SWISSCOM' });
  assert.equal(perDateiname.eintraege.length, 1);
  assert.equal(perDateiname.eintraege[0].dateiname, 'rechnung-swisscom.pdf');

  const perKommentar = queryGlobalAuditLog(db, { suchbegriff: 'duplikat' });
  assert.equal(perKommentar.eintraege.length, 1);
  assert.equal(perKommentar.eintraege[0].dateiname, 'b.pdf');
  db.close();
});

test('queryGlobalAuditLog paginates: proSeite limits results, seite 2 returns the remainder', () => {
  const db = openDatabase(':memory:');
  seedGrundstock(db);
  const job = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  for (let i = 0; i < 3; i += 1) {
    createFreigabe(db, { jobId: job, personId: '1', rolle: 'freigeber1', zeitpunkt: `2026-08-0${i + 1}T09:00:00.000Z`, ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  }

  const seite1 = queryGlobalAuditLog(db, {}, { seite: 1, proSeite: 2 });
  assert.equal(seite1.eintraege.length, 2);
  assert.equal(seite1.gesamtAnzahl, 3);

  const seite2 = queryGlobalAuditLog(db, {}, { seite: 2, proSeite: 2 });
  assert.equal(seite2.eintraege.length, 1);
  assert.equal(seite2.gesamtAnzahl, 3);
  db.close();
});

test('queryGlobalAuditLog returns an empty result without error when nothing matches', () => {
  const db = openDatabase(':memory:');
  const { eintraege, gesamtAnzahl } = queryGlobalAuditLog(db, { suchbegriff: 'nirgends-vorhanden' });
  assert.deepEqual(eintraege, []);
  assert.equal(gesamtAnzahl, 0);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/globalAuditLog.test.js`
Expected: FAIL — `Cannot find module '../../src/services/globalAuditLog.js'` (module doesn't exist yet).

- [ ] **Step 3: Implement `src/services/globalAuditLog.js`**

```javascript
import { getConfigValue } from '../db/adminConfigRepo.js';
import { EREIGNIS_LABEL, personName, formatZeitpunkt } from './auditLog.js';

const BASE_QUERY = `
  WITH audit AS (
    SELECT
      f.zeitpunkt AS zeitpunkt,
      f.rolle AS ereignis_typ,
      f.person_id AS person_id,
      f.job_id AS job_id,
      j.dateiname AS dateiname,
      j.konto_id AS konto_id,
      k.bezeichnung AS konto_bezeichnung,
      f.kommentar AS kommentar,
      j.status AS job_status
    FROM freigaben f
    LEFT JOIN jobs j ON j.id = f.job_id
    LEFT JOIN konten k ON k.id = j.konto_id
    UNION ALL
    SELECT
      jl.zeitpunkt AS zeitpunkt,
      'loeschung' AS ereignis_typ,
      jl.geloescht_von AS person_id,
      jl.job_id AS job_id,
      jl.dateiname AS dateiname,
      j.konto_id AS konto_id,
      k.bezeichnung AS konto_bezeichnung,
      jl.begruendung AS kommentar,
      j.status AS job_status
    FROM job_loeschungen jl
    LEFT JOIN jobs j ON j.id = jl.job_id
    LEFT JOIN konten k ON k.id = j.konto_id
  )
`;

function buildWhere(filter) {
  const clauses = [];
  const params = [];
  if (filter.personId) {
    clauses.push('person_id = ?');
    params.push(filter.personId);
  }
  if (filter.kontoId) {
    clauses.push('konto_id = ?');
    params.push(filter.kontoId);
  }
  if (filter.von) {
    clauses.push('zeitpunkt >= ?');
    params.push(filter.von);
  }
  if (filter.bis) {
    clauses.push('zeitpunkt <= ?');
    params.push(filter.bis);
  }
  if (filter.ereignisTyp) {
    clauses.push('ereignis_typ = ?');
    params.push(filter.ereignisTyp);
  }
  if (filter.suchbegriff) {
    clauses.push('(kommentar LIKE ? OR dateiname LIKE ?)');
    const muster = `%${filter.suchbegriff}%`;
    params.push(muster, muster);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Aggregiert freigaben (alle Jobs) und job_loeschungen zu einer gemeinsamen, durchsuchbaren
// Zeitleiste. Filter/Pagination laufen komplett in SQL (nicht in JS über geladene Zeilen) --
// entscheidend für eine global wachsende Tabelle, im Gegensatz zum job-lokalen buildAuditLog.
export function queryGlobalAuditLog(db, filter = {}, { seite = 1, proSeite = 50 } = {}) {
  const { where, params } = buildWhere(filter);
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';

  const gesamtAnzahl = db.prepare(`${BASE_QUERY} SELECT COUNT(*) AS anzahl FROM audit ${where}`).get(...params).anzahl;

  const offset = (seite - 1) * proSeite;
  const rows = db
    .prepare(`${BASE_QUERY} SELECT * FROM audit ${where} ORDER BY zeitpunkt DESC LIMIT ? OFFSET ?`)
    .all(...params, proSeite, offset);

  const eintraege = rows.map((row) => ({
    zeitpunkt: formatZeitpunkt(row.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[row.ereignis_typ] || row.ereignis_typ,
    person: personName(db, row.person_id),
    jobId: row.job_id,
    dateiname: row.dateiname,
    kontoBezeichnung: row.konto_bezeichnung,
    kommentar: row.kommentar,
    jobStatus: row.job_status,
  }));

  return { eintraege, gesamtAnzahl, seite, proSeite };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/globalAuditLog.test.js`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/globalAuditLog.js test/unit/globalAuditLog.test.js
git commit -m "feat: add queryGlobalAuditLog aggregating freigaben and job_loeschungen"
```

---

## Task 5: Route + view for `/admin/audit-log`

**Files:**
- Create: `src/routes/admin/auditLog.js`
- Create: `views/admin/audit-log.ejs`
- Test: `test/integration/admin/auditLog.test.js`

**Interfaces:**
- Consumes: `queryGlobalAuditLog` (Task 4), `listAllPersons` (`src/db/personenRepo.js:62`), `listKonten` (`src/db/kontenRepo.js:73`), `EREIGNIS_LABEL` (`src/services/auditLog.js`).
- Produces: `export function createAuditLogRouter({ db })` returning an Express `Router` with `GET /`.

- [ ] **Step 1: Write the failing integration tests**

Create `test/integration/admin/auditLog.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createJob } from '../../../src/db/jobsRepo.js';
import { createFreigabe } from '../../../src/db/freigabenRepo.js';
import { logJobLoeschung } from '../../../src/db/jobLoeschungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { createAuditLogRouter } from '../../../src/routes/admin/auditLog.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/audit-log returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/audit-log returns 403 for a logged-in person without the permission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ohne', nachname: 'Recht', email: 'o@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/audit-log returns 200 and lists freigaben and job_loeschungen entries for Superadmin', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'rechnung-b.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /rechnung-a\.pdf/);
  assert.match(res.text, /rechnung-b\.pdf/);
  assert.match(res.text, /Job gelöscht/);
  db.close();
});

test('GET /admin/audit-log?typ=loeschung filters to only job_loeschungen entries', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const jobA = createJob(db, { eingangAm: '2026-08-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId: jobA, personId: '99', rolle: 'freigeber1', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const jobB = createJob(db, { eingangAm: '2026-08-02T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung-b.pdf', pdfPfad: '/tmp/b.pdf' });
  logJobLoeschung(db, { jobId: jobB, dateiname: 'rechnung-b.pdf', geloeschtVon: '99', begruendung: 'Duplikat' });

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log?typ=loeschung').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /rechnung-a\.pdf/);
  assert.match(res.text, /rechnung-b\.pdf/);
  db.close();
});

test('GET /admin/audit-log returns 200 for a plain person with exactly the audit_log_einsehen grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Audit', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['audit_log_einsehen']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/audit-log with no entries shows an empty-state message instead of erroring', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/audit-log').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Keine Einträge gefunden/);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/admin/auditLog.test.js`
Expected: FAIL — `Cannot find module '../../../src/routes/admin/auditLog.js'`.

- [ ] **Step 3: Implement the route**

Create `src/routes/admin/auditLog.js`:

```javascript
import { Router } from 'express';
import { queryGlobalAuditLog } from '../../services/globalAuditLog.js';
import { listAllPersons } from '../../db/personenRepo.js';
import { listKonten } from '../../db/kontenRepo.js';
import { EREIGNIS_LABEL } from '../../services/auditLog.js';

// Ein Von-Datum ("2026-08-01") ist als reiner Tages-Präfix bereits inklusiv (String-Vergleich:
// "2026-08-01T09:00:00Z" > "2026-08-01"). Ein Bis-Datum muss dagegen auf das Tagesende erweitert
// werden, sonst schneidet "zeitpunkt <= '2026-08-01'" jeden Eintrag mit Uhrzeit an diesem Tag ab.
function bisEndeDesTages(bis) {
  if (!bis) return null;
  return bis.length === 10 ? `${bis}T23:59:59.999Z` : bis;
}

export function createAuditLogRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const filter = {
      personId: req.query.person || null,
      kontoId: req.query.konto ? Number(req.query.konto) : null,
      von: req.query.von || null,
      bis: bisEndeDesTages(req.query.bis || null),
      ereignisTyp: req.query.typ || null,
      suchbegriff: req.query.q || null,
    };
    const seite = Math.max(1, Number(req.query.seite) || 1);
    const { eintraege, gesamtAnzahl, proSeite } = queryGlobalAuditLog(db, filter, { seite });

    res.render('admin/audit-log', {
      eintraege,
      gesamtAnzahl,
      seite,
      proSeite,
      gesamtSeiten: Math.max(1, Math.ceil(gesamtAnzahl / proSeite)),
      query: req.query,
      personen: listAllPersons(db),
      konten: listKonten(db, { includeInactive: true }),
      ereignisLabels: EREIGNIS_LABEL,
    });
  });

  return router;
}
```

- [ ] **Step 4: Implement the view**

Create `views/admin/audit-log.ejs`:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Audit-Log — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Globales Audit-Log</h1>

    <form method="get" class="row g-2 mb-3">
      <div class="col-auto">
        <select class="form-select" name="person">
          <option value="">Alle Personen</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.churchtools_person_id %>" <%= query.person === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto">
        <select class="form-select" name="konto">
          <option value="">Alle Konten</option>
          <% konten.forEach((k) => { %>
            <option value="<%= k.id %>" <%= String(query.konto) === String(k.id) ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto">
        <select class="form-select" name="typ">
          <option value="">Alle Ereignisse</option>
          <% Object.keys(ereignisLabels).forEach((typ) => { %>
            <option value="<%= typ %>" <%= query.typ === typ ? 'selected' : '' %>><%= ereignisLabels[typ] %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto">
        <input type="date" class="form-control" name="von" value="<%= query.von || '' %>" placeholder="Von">
      </div>
      <div class="col-auto">
        <input type="date" class="form-control" name="bis" value="<%= query.bis || '' %>" placeholder="Bis">
      </div>
      <div class="col-auto">
        <input type="text" class="form-control" name="q" value="<%= query.q || '' %>" placeholder="Suche in Kommentar/Dateiname">
      </div>
      <div class="col-auto">
        <button type="submit" class="btn btn-primary">Filtern</button>
      </div>
    </form>

    <% if (eintraege.length === 0) { %>
      <p>Keine Einträge gefunden.</p>
    <% } else { %>
      <div class="table-responsive">
        <table class="table align-middle">
          <thead><tr><th>Zeitpunkt</th><th>Ereignis</th><th>Person</th><th>Job</th><th>Konto</th><th>Kommentar/Begründung</th></tr></thead>
          <tbody>
            <% eintraege.forEach((eintrag) => { %>
              <tr>
                <td><%= eintrag.zeitpunkt %></td>
                <td><%= eintrag.ereignis %></td>
                <td><%= eintrag.person %></td>
                <td><%= eintrag.dateiname %> (#<%= eintrag.jobId %>)</td>
                <td><%= eintrag.kontoBezeichnung || '—' %></td>
                <td><%= eintrag.kommentar || '' %></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>

      <nav aria-label="Seiten">
        <ul class="pagination">
          <li class="page-item <%= seite <= 1 ? 'disabled' : '' %>">
            <a class="page-link" href="?<%= new URLSearchParams({ ...query, seite: seite - 1 }).toString() %>">Zurück</a>
          </li>
          <li class="page-item disabled"><span class="page-link">Seite <%= seite %> von <%= gesamtSeiten %></span></li>
          <li class="page-item <%= seite >= gesamtSeiten ? 'disabled' : '' %>">
            <a class="page-link" href="?<%= new URLSearchParams({ ...query, seite: seite + 1 }).toString() %>">Weiter</a>
          </li>
        </ul>
      </nav>
    <% } %>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/admin/auditLog.test.js`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/auditLog.js views/admin/audit-log.ejs test/integration/admin/auditLog.test.js
git commit -m "feat: add /admin/audit-log route and view"
```

---

## Task 6: Wire into nav, app mount, and the authz sweep

**Files:**
- Modify: `src/middleware/nav.js:11-23`
- Modify: `views/admin/_nav.ejs`
- Modify: `src/app.js` (imports + mount)
- Modify: `test/unit/nav.test.js:40-57`
- Modify: `test/integration/admin/authz-sweep.test.js`

**Interfaces:**
- Consumes: `createAuditLogRouter` (Task 5), `requirePermission` (already imported in `app.js`).
- Produces: `res.locals.adminNav.auditLog` computed from `personHasPermission(db, config, person, 'audit_log_einsehen')`; `/admin/audit-log` reachable through the real `createApp` wiring.

- [ ] **Step 1: Update the failing nav test**

In `test/unit/nav.test.js`, add one assertion to the existing Manager test (after line 51, `assert.equal(res.locals.adminNav.personen, true);`):

```javascript
  assert.equal(res.locals.adminNav.auditLog, true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/nav.test.js`
Expected: FAIL — `res.locals.adminNav.auditLog` is `undefined`, not `true`.

- [ ] **Step 3: Add the nav flag**

In `src/middleware/nav.js`, add one line to the `adminNav` object (after `abgelehnt`):

```javascript
    res.locals.adminNav = {
      konten: hasPermission('konten_verwalten'),
      debitoren: hasPermission('debitoren_verwalten'),
      eskalation: res.locals.isSuperadmin,
      erscheinungsbild: res.locals.isSuperadmin,
      zeitstempel: res.locals.isSuperadmin,
      personen: res.locals.isSuperadmin || res.locals.isManager,
      mails: hasPermission('mails_einsehen'),
      sync: hasPermission('sync_einsehen'),
      geplanteJobs: hasPermission('geplante_jobs_verwalten'),
      abgelehnt: hasPermission('abgelehnt_verwalten'),
      auditLog: hasPermission('audit_log_einsehen'),
      backup: res.locals.isSuperadmin,
    };
```

- [ ] **Step 4: Add the nav link**

In `views/admin/_nav.ejs`, add a new `<li>` after the `abgelehnt` entry:

```html
  <% if (adminNav.abgelehnt) { %><li class="nav-item"><a class="nav-link" href="/admin/abgelehnt">Abgelehnte Rechnungen</a></li><% } %>
  <% if (adminNav.auditLog) { %><li class="nav-item"><a class="nav-link" href="/admin/audit-log">Audit-Log</a></li><% } %>
```

- [ ] **Step 5: Mount the route in `src/app.js`**

Add the import near the other admin router imports (after `createAdminAbgelehntRouter`):

```javascript
import { createAdminAbgelehntRouter } from './routes/admin/abgelehnt.js';
import { createAuditLogRouter } from './routes/admin/auditLog.js';
```

Add the mount after the `/admin/abgelehnt` mount:

```javascript
  app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db, csrfProtection }));
  app.use('/admin/audit-log', requirePermission(db, config, 'audit_log_einsehen'), createAuditLogRouter({ db }));
```

- [ ] **Step 6: Run the nav test to verify it passes**

Run: `node --test test/unit/nav.test.js`
Expected: PASS.

- [ ] **Step 7: Update the authz sweep test**

In `test/integration/admin/authz-sweep.test.js`:

a) Add a route entry to `ADMIN_ROUTES`, after the `abgelehnt` group:

```javascript
  // abgelehnt (3)
  { method: 'get', path: '/admin/abgelehnt' },
  { method: 'get', path: '/admin/abgelehnt/1' },
  { method: 'post', path: '/admin/abgelehnt/1/loeschen' },
  // audit-log (1)
  { method: 'get', path: '/admin/audit-log' },
  // geplante-jobs (5)
```

b) Update the count assertion (was 31, now 32):

```javascript
test('the real createApp wiring returns 401 on all 32 admin route/method combinations with no session present', async () => {
  assert.equal(ADMIN_ROUTES.length, 32, 'sanity check: this sweep should cover exactly 32 route/method combinations');
```

c) Add `/admin/audit-log` to the `VERGEBBAR` list in the Manager-bundle test (Manager gets it automatically, same as `mails`/`sync`):

```javascript
  const VERGEBBAR = [
    { method: 'get', path: '/admin/konten' },
    { method: 'get', path: '/admin/debitoren' },
    { method: 'get', path: '/admin/mails' },
    { method: 'get', path: '/admin/sync' },
    { method: 'get', path: '/admin/abgelehnt' },
    { method: 'get', path: '/admin/geplante-jobs' },
    { method: 'get', path: '/admin/audit-log' },
  ];
```

- [ ] **Step 8: Run the full test suite to verify everything passes**

Run: `npm test`
Expected: PASS — every test file, including `test/integration/admin/authz-sweep.test.js` and all tests from Tasks 1-5.

- [ ] **Step 9: Commit**

```bash
git add src/middleware/nav.js views/admin/_nav.ejs src/app.js test/unit/nav.test.js test/integration/admin/authz-sweep.test.js
git commit -m "feat: wire /admin/audit-log into nav, app mount, and the authz sweep"
```

---

## Task 7: Manual verification in the running app

**Files:** none (manual QA pass, no code changes expected unless a bug surfaces)

- [ ] **Step 1: Start the dev server**

Run: `npm start` (or whatever the project's existing dev-start script is — check `package.json`'s `scripts` section if unsure)

- [ ] **Step 2: Log in as Superadmin and open `/admin/audit-log`**

Confirm: the nav shows an "Audit-Log" link; the page loads with the filter form and, if any Freigabe/Löschung data exists in the dev database, a populated table sorted newest-first.

- [ ] **Step 3: Exercise each filter**

Confirm: Person, Konto, Ereignis-Typ, Von/Bis, and free-text search each narrow the list as expected, and the filter values stay selected/filled after submitting (round-tripped through the query string).

- [ ] **Step 4: Exercise pagination**

If there are more than 50 entries in the dev database, confirm "Weiter"/"Zurück" navigate correctly and stay within the currently applied filters. If fewer than 50 exist, seed a few more test entries (via the normal Freigabe/Ablehnung-Löschen workflow in the UI) to verify pagination controls disable correctly at the first/last page.

- [ ] **Step 5: Confirm permission gating in the browser**

Log in as a person with no permissions — confirm no "Audit-Log" link appears and `/admin/audit-log` returns the 403 error page directly.

---

## Self-Review Notes

- **Spec coverage:** Datenquellen/Normalisierung → Task 4; Berechtigung → Tasks 1-2, 6; Route+View → Task 5; UI-Filter → Task 5's view; Tests (unit query/migration, integration permission+filter) → Tasks 1, 4, 5. "Nicht Teil von diesem Design" items (kein CSV-Export, keine weiteren Datenquellen, keine Änderung an buildAuditLog) are respected — no task touches them.
- **Type/name consistency checked:** `queryGlobalAuditLog(db, filter, { seite, proSeite })` signature is identical between Task 4's implementation and Task 5's route usage. `EREIGNIS_LABEL`, `personName`, `formatZeitpunkt` export names match between Task 3 and their Task 4 imports. `adminNav.auditLog` key matches between Task 6's `nav.js` change and its `_nav.ejs`/test usages.
- **No placeholders:** every step has literal, runnable code — no "add appropriate handling" or "similar to Task N" shortcuts.
