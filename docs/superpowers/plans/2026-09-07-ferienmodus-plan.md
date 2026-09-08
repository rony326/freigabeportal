# Ferienmodus (Vacation Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any person set a self-service "Ferienmodus" (a date range + a chosen Stellvertreter) so that, additively and without any database reassignment, their Kontierung/Freigeber1/Freigeber2 duties also become reachable, visible, and mail-notified to that Stellvertreter for the duration.

**Architecture:** Three new nullable columns on `personen` (`ferienmodus_von`, `ferienmodus_bis`, `ferienmodus_stellvertreter_id`) drive a single small resolver service (`src/services/vertretung.js`) that every existing per-job authorization check, dashboard list query, and notification call site is additively extended to consult. A new `freigaben.vertretung_fuer` column records, per audit-log entry, when an action was actually taken by an active Stellvertreter rather than the nominally responsible person.

**Tech Stack:** Node.js, Express, `node:sqlite` (via `src/db/index.js`'s `openDatabase`), EJS views, Bootstrap 5, `node:test` + `supertest` for tests.

**Spec:** [docs/superpowers/specs/2026-09-07-ferienmodus-design.md](../specs/2026-09-07-ferienmodus-design.md)

## Global Constraints

- No new tables — only new columns on `personen` and `freigaben` (per spec's Datenmodell section).
- Ferienmodus is purely additive: `zugewiesen_an`, `konten.freigeber1_id`/`freigeber2_id` etc. are never rewritten; the absent person keeps their own access unchanged.
- "Aktiv" is always computed from `ferienmodus_von`/`ferienmodus_bis` against `date('now')` — never stored as a separate boolean/flag.
- Self-service only: no admin UI writes Ferienmodus for another person (per the design's explicit "Explizit ausserhalb des Umfangs" section). Admin → Personen only ever displays it.
- Every new/changed SQL statement follows this codebase's existing handwritten-SQL-per-repo style (`src/db/*Repo.js`) — no ORM.
- New DB columns need both a `schema.sql` change (fresh databases) AND an idempotent `ALTER TABLE` migration in `src/db/index.js` (existing on-disk databases) — see Task 1.
- All new/changed POST routes go through the existing `csrfProtection` middleware and must be added to `SESSION_POST_ROUTES` in `test/integration/csrfSweep.test.js` (see Task 16).
- German-language UI/labels throughout, matching the rest of the app (`Ferienmodus`, `Stellvertreter`, `Von`, `Bis`, etc.).

---

## Task 1: Data model — new columns on `personen` and `freigaben`

**Files:**
- Modify: `src/db/schema.sql` (the `personen` CREATE TABLE at lines 1-11, the `freigaben` CREATE TABLE at lines 203-213)
- Modify: `src/db/index.js` (add two migration functions, register them in `openDatabase`)
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `personen.ferienmodus_von TEXT`, `personen.ferienmodus_bis TEXT`, `personen.ferienmodus_stellvertreter_id TEXT`, `freigaben.vertretung_fuer TEXT` — every later task reads/writes these via plain `db.prepare(...)` SQL.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/db.test.js` (append near the other "adds columns via ALTER TABLE" tests, e.g. after the qr_* tests around line 313):

```js
test('personen table has the three ferienmodus columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(personen)').all().map((c) => c.name);
  for (const expected of ['ferienmodus_von', 'ferienmodus_bis', 'ferienmodus_stellvertreter_id']) {
    assert.ok(columns.includes(expected), `personen table is missing ${expected}`);
  }
  db.close();
});

test('freigaben table has a vertretung_fuer column', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(freigaben)').all().map((c) => c.name);
  assert.ok(columns.includes('vertretung_fuer'), 'freigaben table is missing vertretung_fuer');
  db.close();
});

test('openDatabase adds the ferienmodus columns via ALTER TABLE to an existing on-disk database that predates them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (
      churchtools_person_id TEXT PRIMARY KEY,
      vorname TEXT NOT NULL,
      nachname TEXT NOT NULL,
      email TEXT NOT NULL,
      aktiv INTEGER NOT NULL DEFAULT 1,
      gruppen TEXT NOT NULL DEFAULT '[]',
      ct_person_unresolved INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      last_login_at TEXT
    )
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const columns = migratedDb.prepare('PRAGMA table_info(personen)').all().map((c) => c.name);
  for (const expected of ['ferienmodus_von', 'ferienmodus_bis', 'ferienmodus_stellvertreter_id']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected}`);
  }
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: the three new tests FAIL (columns don't exist yet); all pre-existing tests in the file still PASS.

- [ ] **Step 3: Implement the schema change**

In `src/db/schema.sql`, change the `personen` table (lines 1-11) to:

```sql
CREATE TABLE IF NOT EXISTS personen (
  churchtools_person_id TEXT PRIMARY KEY,
  vorname TEXT NOT NULL,
  nachname TEXT NOT NULL,
  email TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1,
  gruppen TEXT NOT NULL DEFAULT '[]',
  ct_person_unresolved INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_login_at TEXT,
  ferienmodus_von TEXT,
  ferienmodus_bis TEXT,
  ferienmodus_stellvertreter_id TEXT REFERENCES personen(churchtools_person_id)
);
```

And the `freigaben` table (lines 203-213) to:

```sql
CREATE TABLE IF NOT EXISTS freigaben (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung')),
  zeitpunkt TEXT NOT NULL,
  ip TEXT NOT NULL,
  interessenskonflikt INTEGER NOT NULL DEFAULT 0,
  kommentar TEXT,
  eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
  vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)
);
```

(`vertretung_fuer` is a plain new column, not part of the `rolle` CHECK — no table-rebuild migration needed, unlike `migrateFreigabenTable`'s CHECK-widening.)

In `src/db/index.js`, add two migration functions near the top (after `JOBS_TABLE_MIGRATIONS`/`migrateJobsTableQuelleCheck`, before `migrateJobsTable`, following the exact same idempotent-ALTER-TABLE pattern `migrateJobsTable` already uses):

```js
const PERSONEN_TABLE_MIGRATIONS = [
  { column: 'ferienmodus_von', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_von TEXT' },
  { column: 'ferienmodus_bis', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_bis TEXT' },
  { column: 'ferienmodus_stellvertreter_id', ddl: 'ALTER TABLE personen ADD COLUMN ferienmodus_stellvertreter_id TEXT REFERENCES personen(churchtools_person_id)' },
];

function migratePersonenTable(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(personen)').all().map((col) => col.name));
  for (const { column, ddl } of PERSONEN_TABLE_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}

const FREIGABEN_TABLE_VERTRETUNG_MIGRATIONS = [
  { column: 'vertretung_fuer', ddl: 'ALTER TABLE freigaben ADD COLUMN vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)' },
];

function migrateFreigabenTableVertretung(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(freigaben)').all().map((col) => col.name));
  for (const { column, ddl } of FREIGABEN_TABLE_VERTRETUNG_MIGRATIONS) {
    if (!existing.has(column)) db.exec(ddl);
  }
}
```

Register both in `openDatabase` (after the existing `migrateCronLogTableMailDigest(db);` line):

```js
  migrateCronLogTableMailDigest(db);
  migratePersonenTable(db);
  migrateFreigabenTableVertretung(db);
  return db;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: PASS (all tests, including the three new ones and every pre-existing test in the file).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(ferienmodus): add ferienmodus columns to personen and vertretung_fuer to freigaben

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `personenRepo.js` — set/clear Ferienmodus

**Files:**
- Modify: `src/db/personenRepo.js`
- Test: `test/unit/personenRepo.test.js`

**Interfaces:**
- Consumes: Task 1's `personen.ferienmodus_von`/`ferienmodus_bis`/`ferienmodus_stellvertreter_id` columns.
- Produces: `setFerienmodus(db, personId, { von, bis, stellvertreterId })`, `clearFerienmodus(db, personId)`. `getPersonById(db, id)` (already exists, unchanged) already returns these three fields as part of its `SELECT *` — no new getter needed.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/personenRepo.test.js`:

```js
test('setFerienmodus stores the vacation period and stellvertreter on the person row', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });

  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-09-10');
  assert.equal(person.ferienmodus_bis, '2026-09-24');
  assert.equal(person.ferienmodus_stellvertreter_id, '2');
  db.close();
});

test('setFerienmodus overwrites a previously set period', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '3', vorname: 'Cé', nachname: 'Muster', email: 'ce@example.org', gruppen: ['10'], loggedInNow: true });

  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });
  setFerienmodus(db, '1', { von: '2026-10-01', bis: '2026-10-05', stellvertreterId: '3' });

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-10-01');
  assert.equal(person.ferienmodus_stellvertreter_id, '3');
  db.close();
});

test('clearFerienmodus resets all three fields to null', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  setFerienmodus(db, '1', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  clearFerienmodus(db, '1');

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  assert.equal(person.ferienmodus_bis, null);
  assert.equal(person.ferienmodus_stellvertreter_id, null);
  db.close();
});
```

Add `setFerienmodus, clearFerienmodus` to the existing `import { ... } from '../../src/db/personenRepo.js'` line at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/personenRepo.test.js`
Expected: FAIL with "setFerienmodus is not a function" (or similar import error).

- [ ] **Step 3: Implement**

Append to `src/db/personenRepo.js`:

```js
export function setFerienmodus(db, personId, { von, bis, stellvertreterId }) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = ?, ferienmodus_bis = ?, ferienmodus_stellvertreter_id = ? WHERE churchtools_person_id = ?'
  ).run(von, bis, stellvertreterId, personId);
}

export function clearFerienmodus(db, personId) {
  db.prepare(
    'UPDATE personen SET ferienmodus_von = NULL, ferienmodus_bis = NULL, ferienmodus_stellvertreter_id = NULL WHERE churchtools_person_id = ?'
  ).run(personId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/personenRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/personenRepo.js test/unit/personenRepo.test.js
git commit -m "feat(ferienmodus): add setFerienmodus/clearFerienmodus to personenRepo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `kontenRepo.js` — Vertretungs-Kandidaten

**Files:**
- Modify: `src/db/kontenRepo.js`
- Test: `test/unit/kontenRepo.test.js`

**Interfaces:**
- Consumes: `listActivePersons(db)` (already imported in `kontenRepo.js` from `./personenRepo.js`).
- Produces: `listKontenForPersonAnyRole(db, personId)` → `Konto[]`; `listVertretungsKandidaten(db, personId)` → `Person[]` (each `{ churchtools_person_id, vorname, nachname, email }`, same shape as `listActivePersons`).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/kontenRepo.test.js` (check the top of the file for its existing `seedKonto`-style helpers and import list first, then add):

```js
test('listKontenForPersonAnyRole matches all four role columns, not just freigeber1/stellvertreter1', () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  for (const id of ['1', '2', '3', '4']) {
    const konten = listKontenForPersonAnyRole(db, id);
    assert.equal(konten.length, 1, `person ${id} should be matched via one of the four role columns`);
    assert.equal(konten[0].id, kontoId);
  }
  assert.equal(listKontenForPersonAnyRole(db, '5').length, 0);
  db.close();
});

test('listVertretungsKandidaten returns the other active role-holders on shared Konten, excluding the person themself', () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  // Person 5 has no Konto role in common with person 1 — must not be a candidate.

  const kandidaten = listVertretungsKandidaten(db, '1').map((p) => p.churchtools_person_id).sort();
  assert.deepEqual(kandidaten, ['2', '3', '4']);
  db.close();
});

test('listVertretungsKandidaten excludes inactive persons', () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  upsertPerson(db, { id: '3', vorname: 'Person3', nachname: 'Muster', email: 'p3@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '4', vorname: 'Person4', nachname: 'Muster', email: 'p4@example.org', gruppen: ['10'], loggedInNow: true });
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivatePerson(db, '3');

  const kandidaten = listVertretungsKandidaten(db, '1').map((p) => p.churchtools_person_id).sort();
  assert.deepEqual(kandidaten, ['2', '4']);
  db.close();
});
```

Add `listKontenForPersonAnyRole, listVertretungsKandidaten` to the `kontenRepo.js` import line, and `deactivatePerson` to the `personenRepo.js` import line, at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: FAIL with "listKontenForPersonAnyRole is not a function".

- [ ] **Step 3: Implement**

Append to `src/db/kontenRepo.js`:

```js
export function listKontenForPersonAnyRole(db, personId) {
  return db
    .prepare(
      `SELECT * FROM konten WHERE aktiv = 1
       AND (freigeber1_id = ? OR stellvertreter1_id = ? OR freigeber2_id = ? OR stellvertreter2_id = ?)
       ORDER BY kontonummer`
    )
    .all(personId, personId, personId, personId);
}

// Candidates for a person's self-chosen Ferienmodus-Stellvertreter: anyone who already holds one
// of the four Konto roles on at least one Konto this person also holds a role on — prevents
// picking a substitute with no domain relationship to the accounts they'd be standing in for.
export function listVertretungsKandidaten(db, personId) {
  const ids = new Set();
  for (const konto of listKontenForPersonAnyRole(db, personId)) {
    ids.add(konto.freigeber1_id);
    ids.add(konto.stellvertreter1_id);
    ids.add(konto.freigeber2_id);
    ids.add(konto.stellvertreter2_id);
  }
  ids.delete(personId);
  return listActivePersons(db).filter((person) => ids.has(person.churchtools_person_id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/kontenRepo.js test/unit/kontenRepo.test.js
git commit -m "feat(ferienmodus): add listKontenForPersonAnyRole/listVertretungsKandidaten to kontenRepo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `src/services/vertretung.js` — the core resolver

**Files:**
- Create: `src/services/vertretung.js`
- Test: Create `test/unit/vertretung.test.js`

**Interfaces:**
- Consumes: Task 1's `personen.ferienmodus_*` columns directly via SQL.
- Produces: `getAktivenVertreter(db, personId)` → `stellvertreterId | null`. `istAktiveVertretungFuer(db, kandidatId, urspruenglichePersonId)` → `boolean`. Both are consumed by Tasks 8-13.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/vertretung.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setFerienmodus } from '../../src/db/personenRepo.js';
import { getAktivenVertreter, istAktiveVertretungFuer } from '../../src/services/vertretung.js';

function heutePlusTage(tage) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

function seedZweiPersonen(db) {
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
}

test('getAktivenVertreter returns null when no Ferienmodus is set', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns the stellvertreter when today falls within the period', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), '2');
  db.close();
});

test('getAktivenVertreter returns null when the period is in the future', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(5), bis: heutePlusTage(10), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null when the period is in the past', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-10), bis: heutePlusTage(-5), stellvertreterId: '2' });
  assert.equal(getAktivenVertreter(db, '1'), null);
  db.close();
});

test('getAktivenVertreter returns null for an unknown person id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getAktivenVertreter(db, 'missing'), null);
  db.close();
});

test('istAktiveVertretungFuer is true only for the currently active stellvertreter', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(istAktiveVertretungFuer(db, '2', '1'), true);
  assert.equal(istAktiveVertretungFuer(db, '1', '1'), false);
  db.close();
});

test('istAktiveVertretungFuer is false when either id is missing/null', () => {
  const db = openDatabase(':memory:');
  seedZweiPersonen(db);
  setFerienmodus(db, '1', { von: heutePlusTage(-1), bis: heutePlusTage(1), stellvertreterId: '2' });
  assert.equal(istAktiveVertretungFuer(db, '2', null), false);
  assert.equal(istAktiveVertretungFuer(db, null, '1'), false);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vertretung.test.js`
Expected: FAIL — `src/services/vertretung.js` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/services/vertretung.js`:

```js
// Ferienmodus is purely additive (see docs/superpowers/specs/2026-09-07-ferienmodus-design.md):
// nothing in jobs/konten is ever reassigned. "Active" is always computed against today's date,
// never stored as a separate flag — no cron job needed to flip it off again.
export function getAktivenVertreter(db, personId) {
  const row = db
    .prepare('SELECT ferienmodus_von, ferienmodus_bis, ferienmodus_stellvertreter_id FROM personen WHERE churchtools_person_id = ?')
    .get(personId);
  if (!row || !row.ferienmodus_stellvertreter_id || !row.ferienmodus_von || !row.ferienmodus_bis) return null;
  const heute = new Date().toISOString().slice(0, 10);
  if (heute < row.ferienmodus_von || heute > row.ferienmodus_bis) return null;
  return row.ferienmodus_stellvertreter_id;
}

export function istAktiveVertretungFuer(db, kandidatId, urspruenglichePersonId) {
  if (!kandidatId || !urspruenglichePersonId) return false;
  return getAktivenVertreter(db, urspruenglichePersonId) === kandidatId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/vertretung.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/vertretung.js test/unit/vertretung.test.js
git commit -m "feat(ferienmodus): add vertretung.js resolver (getAktivenVertreter/istAktiveVertretungFuer)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `freigabenRepo.js` — record `vertretung_fuer`

**Files:**
- Modify: `src/db/freigabenRepo.js`
- Test: `test/unit/freigabenRepo.test.js`

**Interfaces:**
- Consumes: Task 1's `freigaben.vertretung_fuer` column.
- Produces: `createFreigabe(db, { ..., vertretungFuer })` — new optional field, defaults to `null`, fully backward compatible with every existing call site that doesn't pass it.

- [ ] **Step 1: Write the failing test**

Check the top of `test/unit/freigabenRepo.test.js` for its existing helpers/imports, then append:

```js
test('createFreigabe stores vertretung_fuer when provided, and defaults to null otherwise', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const idMitVertretung = createFreigabe(db, {
    jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-09-07T10:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null, vertretungFuer: '1',
  });
  const idOhneVertretung = createFreigabe(db, {
    jobId, personId: '1', rolle: 'freigeber2', zeitpunkt: '2026-09-07T10:05:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null,
  });

  const rows = listFreigabenByJob(db, jobId);
  assert.equal(rows.find((r) => r.id === idMitVertretung).vertretung_fuer, '1');
  assert.equal(rows.find((r) => r.id === idOhneVertretung).vertretung_fuer, null);
  db.close();
});
```

(Add `upsertPerson` from `../../src/db/personenRepo.js` and `createJob` from `../../src/db/jobsRepo.js` to the test file's imports if not already present — check first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/freigabenRepo.test.js`
Expected: FAIL — `vertretung_fuer` comes back `undefined`/insert errors on the extra bind.

- [ ] **Step 3: Implement**

Replace `createFreigabe` in `src/db/freigabenRepo.js`:

```js
export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon, vertretungFuer = null }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null, vertretungFuer ?? null);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/freigabenRepo.test.js`
Expected: PASS. Also run `node --test test/unit/jobsRepo.test.js test/integration/kontierung.test.js test/integration/freigabe2.test.js` to confirm every pre-existing `createFreigabe(...)` call site (which never passes `vertretungFuer`) still works unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/db/freigabenRepo.js test/unit/freigabenRepo.test.js
git commit -m "feat(ferienmodus): add optional vertretungFuer to createFreigabe

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `auditLog.js` + `_audit_log.ejs` — render the Vertretungs-Vermerk

**Files:**
- Modify: `src/services/auditLog.js`
- Modify: `views/_audit_log.ejs`
- Test: `test/unit/auditLog.test.js`

**Interfaces:**
- Consumes: Task 5's `freigaben.vertretung_fuer`, `personName(db, personId)` (already exported from `auditLog.js`).
- Produces: `buildAuditLog(...)` entries gain a `vertretungFuerPerson: string | null` field.

- [ ] **Step 1: Write the failing test**

Check `test/unit/auditLog.test.js`'s existing imports/helpers (it already tests `buildAuditLog` against `eskaliertVonPerson`), then append a test following the same shape:

```js
test('buildAuditLog resolves vertretungFuerPerson to a display name when vertretung_fuer is set', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, {
    jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-09-07T10:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null, vertretungFuer: '1',
  });

  const [eintrag] = buildAuditLog(db, jobId);
  assert.equal(eintrag.vertretungFuerPerson, 'Ana Muster');
  db.close();
});

test('buildAuditLog leaves vertretungFuerPerson null when vertretung_fuer is not set', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, {
    jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-09-07T10:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: null, eskaliertVon: null,
  });

  const [eintrag] = buildAuditLog(db, jobId);
  assert.equal(eintrag.vertretungFuerPerson, null);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/auditLog.test.js`
Expected: FAIL — `vertretungFuerPerson` is `undefined`.

- [ ] **Step 3: Implement**

In `src/services/auditLog.js`, extend the object returned inside `buildAuditLog`'s `.map(...)`:

```js
export function buildAuditLog(db, jobId) {
  const lokaleZeit = getConfigValue(db, 'audit_log_lokale_zeit') === '1';
  return listFreigabenByJob(db, jobId).map((eintrag) => ({
    zeitpunkt: formatZeitpunkt(eintrag.zeitpunkt, lokaleZeit),
    ereignis: EREIGNIS_LABEL[eintrag.rolle] || eintrag.rolle,
    person: personName(db, eintrag.person_id),
    interessenskonflikt: Boolean(eintrag.interessenskonflikt),
    kommentar: eintrag.kommentar,
    eskaliertVonPerson: eintrag.eskaliert_von ? personName(db, eintrag.eskaliert_von) : null,
    vertretungFuerPerson: eintrag.vertretung_fuer ? personName(db, eintrag.vertretung_fuer) : null,
  }));
}
```

In `views/_audit_log.ejs`, extend line 9 to render it next to the existing eskaliert-von note:

```html
<strong><%= eintrag.ereignis %></strong> — <%= eintrag.person %><% if (eintrag.eskaliertVonPerson) { %> (eskaliert von <%= eintrag.eskaliertVonPerson %>)<% } %><% if (eintrag.vertretungFuerPerson) { %> (als Stellvertreter für <%= eintrag.vertretungFuerPerson %>)<% } %>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/auditLog.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/auditLog.js views/_audit_log.ejs test/unit/auditLog.test.js
git commit -m "feat(ferienmodus): render Vertretungs-Vermerk in the audit log

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `notify.js` — `sendNotificationMitVertretung`

**Files:**
- Modify: `src/services/notify.js`
- Test: `test/unit/notify.test.js`

**Interfaces:**
- Consumes: `getAktivenVertreter` (Task 4), `getPersonById` (existing, `src/db/personenRepo.js`), `sendNotification` (existing, same file).
- Produces: `sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen })` — used by Tasks 11-14 in place of direct `sendNotification(db, mailer, { to: person.email, ... })` calls.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/notify.test.js` (mirroring the existing `sendNotification` tests' `createStubMailer`/`seedDefaults` setup):

```js
test('sendNotificationMitVertretung sends only to the person when no Ferienmodus is active', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  const mailer = createStubMailer();

  await sendNotificationMitVertretung(db, mailer, {
    person: { churchtools_person_id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org' },
    typ: 'zuweisung',
    jobId: null,
    variablen: { jobDateiname: 'a.pdf', grund: 'Test', link: 'https://portal.example.org/x' },
  });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'ana@example.org');
  db.close();
});

test('sendNotificationMitVertretung also sends to the active Stellvertreter, with an adjusted grund', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const mailer = createStubMailer();

  await sendNotificationMitVertretung(db, mailer, {
    person: { churchtools_person_id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org' },
    typ: 'zuweisung',
    jobId: null,
    variablen: { jobDateiname: 'a.pdf', grund: 'Eine Rechnung wartet auf deine Freigabe 2.', link: 'https://portal.example.org/x' },
  });

  assert.equal(mailer.sent.length, 2);
  assert.equal(mailer.sent[0].to, 'ana@example.org');
  assert.equal(mailer.sent[1].to, 'bo@example.org');
  assert.match(mailer.sent[1].text, /Stellvertreter für Ana Muster/);
  assert.match(mailer.sent[1].text, /Eine Rechnung wartet auf deine Freigabe 2\./);
  db.close();
});
```

Add `sendNotificationMitVertretung` to the `notify.js` import line and `setFerienmodus` to the `personenRepo.js` import line at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/notify.test.js`
Expected: FAIL — `sendNotificationMitVertretung is not a function`.

- [ ] **Step 3: Implement**

In `src/services/notify.js`, add the import and the new function (append near the bottom, after `resolveEmpfaenger`):

```js
import { getPersonById } from '../db/personenRepo.js';
import { getAktivenVertreter } from './vertretung.js';
```

```js
// Wraps sendNotification so every call site that currently mails "the person responsible for
// this job" also reaches their active Ferienmodus-Stellvertreter, without each call site having
// to know about Ferienmodus itself. See docs/superpowers/specs/2026-09-07-ferienmodus-design.md.
export async function sendNotificationMitVertretung(db, mailer, { person, typ, jobId, variablen }) {
  await sendNotification(db, mailer, {
    to: person.email,
    typ,
    jobId,
    variablen: { ...variablen, empfaengerName: `${person.vorname} ${person.nachname}` },
  });

  const vertreterId = getAktivenVertreter(db, person.churchtools_person_id);
  if (!vertreterId) return;
  const vertreter = getPersonById(db, vertreterId);
  if (!vertreter) return;

  await sendNotification(db, mailer, {
    to: vertreter.email,
    typ,
    jobId,
    variablen: {
      ...variablen,
      empfaengerName: `${vertreter.vorname} ${vertreter.nachname}`,
      grund: `(Als Stellvertreter für ${person.vorname} ${person.nachname} im Ferienmodus) ${variablen.grund}`,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/notify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/notify.js test/unit/notify.test.js
git commit -m "feat(ferienmodus): add sendNotificationMitVertretung wrapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `jobsRepo.js` — dashboard visibility for the Stellvertreter

**Files:**
- Modify: `src/db/jobsRepo.js` (`listZugewiesenJobsForPerson` at line 475, `listFreigabe2JobsForPerson` at line 491)
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: Task 1's `personen.ferienmodus_*` columns.
- Produces: unchanged signatures for `listZugewiesenJobsForPerson(db, personId)` and `listFreigabe2JobsForPerson(db, personId)` — both now also match jobs belonging to whoever `personId` is currently the active Stellvertreter for.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/jobsRepo.test.js` (near the existing `listZugewiesenJobsForPerson`/`listFreigabe2JobsForPerson` tests around lines 880-921; add `setFerienmodus` to the `personenRepo.js` import if not already imported — check the top of the file):

```js
test('listZugewiesenJobsForPerson also includes jobs assigned to someone this person is actively vertretung for', () => {
  const db = openDatabase(':memory:');
  seedKonto(db); // persons '1'..'4'
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const rows = listZugewiesenJobsForPerson(db, '2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, jobId);
  db.close();
});

test('listZugewiesenJobsForPerson does not include a job vertreten for someone once the Ferienmodus period has ended', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2000-01-31', stellvertreterId: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  assert.equal(listZugewiesenJobsForPerson(db, '2').length, 0);
  db.close();
});

test('listFreigabe2JobsForPerson also includes jobs whose freigeber2 is actively vertreten by this person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '1' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  assert.equal(listFreigabe2JobsForPerson(db, '1').length, 1);
  db.close();
});

test('listFreigabe2JobsForPerson also includes jobs whose escalated stellvertreter2 is actively vertreten by this person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // stellvertreter2Id: '4'
  setFerienmodus(db, '4', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '1' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });

  assert.equal(listFreigabe2JobsForPerson(db, '1').length, 1);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — the four new assertions return `0` rows where `1` is expected.

- [ ] **Step 3: Implement**

In `src/db/jobsRepo.js`, add a shared subquery constant near the top of the file (after the imports) and rewrite the two functions:

```js
// Reused by listZugewiesenJobsForPerson/listFreigabe2JobsForPerson below: matches any person
// whose active Ferienmodus (today falls within ferienmodus_von..ferienmodus_bis) names the bound
// parameter as their Stellvertreter. See src/services/vertretung.js for the single-job version
// of this same check.
const VERTRETUNG_ZIEL_SUBQUERY = `
  SELECT churchtools_person_id FROM personen
  WHERE ferienmodus_stellvertreter_id = ?
    AND ferienmodus_von IS NOT NULL
    AND date('now') BETWEEN ferienmodus_von AND ferienmodus_bis
`;
```

```js
export function listZugewiesenJobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'zugewiesen' AND freigabe1_eskaliert_an_admin = 0 AND quelle != 'spesen'
       AND (zugewiesen_an = ? OR zugewiesen_an IN (${VERTRETUNG_ZIEL_SUBQUERY}))
       ORDER BY eingang_am`
    )
    .all(personId, personId);
}
```

```js
export function listFreigabe2JobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT jobs.* FROM jobs
       JOIN konten ON konten.id = jobs.konto_id
       WHERE jobs.status = 'freigabe2'
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (
           (jobs.freigabe2_eskaliert_von IS NULL AND (konten.freigeber2_id = ? OR konten.freigeber2_id IN (${VERTRETUNG_ZIEL_SUBQUERY})))
           OR (jobs.freigabe2_eskaliert_von IS NOT NULL AND (konten.stellvertreter2_id = ? OR konten.stellvertreter2_id IN (${VERTRETUNG_ZIEL_SUBQUERY})))
         )
         AND NOT (jobs.quelle = 'spesen' AND jobs.eingereicht_von = ?)
       ORDER BY jobs.eingang_am`
    )
    .all(personId, personId, personId, personId, personId);
}
```

Keep every existing comment above both functions (the Spesen-submitter exclusion rationale) — only the SQL body and this function's own doc comment change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS — including all pre-existing tests for these two functions (the added `OR ... IN (...)` clause must not change behavior when no Ferienmodus is set).

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat(ferienmodus): extend dashboard queries to include vertretung jobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: `jobAuthorization.js` — `canViewJobPdf` extension

**Files:**
- Modify: `src/services/jobAuthorization.js`
- Test: Create `test/unit/jobAuthorization.test.js`

**Interfaces:**
- Consumes: `istAktiveVertretungFuer` (Task 4).
- Produces: `canViewJobPdf(db, config, currentPerson, job)` — unchanged signature, additively permissive.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/jobAuthorization.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung } from '../../src/db/jobsRepo.js';
import { canViewJobPdf } from '../../src/services/jobAuthorization.js';

function config() {
  return { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
}

function seedKontoUndPersonen(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('canViewJobPdf allows the active Stellvertreter of zugewiesen_an on a zugewiesen job', () => {
  const db = openDatabase(':memory:');
  seedKontoUndPersonen(db);
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const job = { id: jobId, status: 'zugewiesen', zugewiesen_an: '1', eingereicht_von: null, konto_id: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '2'), job), true);
  db.close();
});

test('canViewJobPdf denies someone who is not (yet/anymore) an active Stellvertreter', () => {
  const db = openDatabase(':memory:');
  seedKontoUndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const job = { id: jobId, status: 'zugewiesen', zugewiesen_an: '1', eingereicht_von: null, konto_id: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '2'), job), false);
  db.close();
});

test('canViewJobPdf allows the active Stellvertreter of the effective Freigeber2 on a freigabe2 job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoUndPersonen(db); // freigeber2Id: '3'
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '1' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  const job = { id: jobId, status: 'freigabe2', zugewiesen_an: null, eingereicht_von: null, konto_id: kontoId, freigabe2_eskaliert_von: null };

  assert.equal(canViewJobPdf(db, config(), getPersonById(db, '1'), job), true);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobAuthorization.test.js`
Expected: FAIL on the two "allows" tests (currently `false`).

- [ ] **Step 3: Implement**

Replace `canViewJobPdf` in `src/services/jobAuthorization.js`:

```js
import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { personHasRole } from '../middleware/roles.js';
import { istAktiveVertretungFuer } from './vertretung.js';

export function canViewJobPdf(db, config, currentPerson, job) {
  if (personHasRole(currentPerson, config, 'superadmin')) return true;
  if (job.status === 'unzugewiesen') return personHasRole(currentPerson, config, 'buchhaltung');
  const personId = currentPerson.churchtools_person_id;
  if (job.zugewiesen_an === personId) return true;
  if (job.zugewiesen_an && istAktiveVertretungFuer(db, personId, job.zugewiesen_an)) return true;
  if (job.eingereicht_von === personId) return true;
  if (job.konto_id) {
    const konto = getKontoById(db, job.konto_id);
    if (konto) {
      const freigeber2Id = getEffectiveFreigeber2Id(job, konto);
      if (freigeber2Id === personId) return true;
      if (freigeber2Id && istAktiveVertretungFuer(db, personId, freigeber2Id)) return true;
    }
  }
  return false;
}
```

(Keep the existing explanatory comments above the function body — only the logic inside changes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobAuthorization.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/jobAuthorization.js test/unit/jobAuthorization.test.js
git commit -m "feat(ferienmodus): extend canViewJobPdf to cover active Ferienmodus-Stellvertreter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Self-service route, view, and nav entry

**Files:**
- Create: `src/routes/ferienmodus.js`
- Create: `views/ferienmodus.ejs`
- Modify: `views/_header.ejs` (nav dropdown, after the "Meine Spesen" entry at line 67)
- Modify: `src/app.js` (import + mount)
- Test: Create `test/integration/ferienmodus.test.js`

**Interfaces:**
- Consumes: `setFerienmodus`, `clearFerienmodus` (Task 2), `listVertretungsKandidaten` (Task 3), `req.currentPerson` (existing `loadCurrentPerson` middleware).
- Produces: `createFerienmodusRouter({ db, csrfProtection })` mounted at `/ferienmodus`.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/ferienmodus.test.js` (mirrors the lightweight `buildTestApp` pattern used in `test/integration/kontierung.test.js`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { createFerienmodusRouter } from '../../src/routes/ferienmodus.js';

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
  app.use(loadCurrentPerson(db));
  app.use('/ferienmodus', requireLogin(), createFerienmodusRouter({ db }));
  return app;
}

function seedKontoAndPersonen(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  // Person 5 shares no Konto role with person 1 — not a valid Stellvertreter candidate for them.
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /ferienmodus shows no active period by default', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app).get('/ferienmodus').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /kein Ferienmodus/i);
  db.close();
});

test('POST /ferienmodus sets the period and stellvertreter, then GET reflects it', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const postRes = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });
  assert.equal(postRes.status, 302);

  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, '2026-09-10');
  assert.equal(person.ferienmodus_stellvertreter_id, '2');

  const getRes = await request(app).get('/ferienmodus').set('x-test-person-id', '1');
  assert.match(getRes.text, /2026-09-10/);
  assert.match(getRes.text, /Person2 Muster/);
  db.close();
});

test('POST /ferienmodus with aktion=beenden clears the period', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);
  await request(app).post('/ferienmodus').set('x-test-person-id', '1').type('form').send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '2' });

  const res = await request(app).post('/ferienmodus').set('x-test-person-id', '1').type('form').send({ aktion: 'beenden' });
  assert.equal(res.status, 302);
  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  db.close();
});

test('POST /ferienmodus rejects a stellvertreter outside the candidate list', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '5' });
  assert.equal(res.status, 400);
  assert.match(res.text, /gültigen Stellvertreter/);
  const person = getPersonById(db, '1');
  assert.equal(person.ferienmodus_von, null);
  db.close();
});

test('POST /ferienmodus rejects bis before von', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/ferienmodus')
    .set('x-test-person-id', '1')
    .type('form')
    .send({ von: '2026-09-24', bis: '2026-09-10', stellvertreterId: '2' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Bis-Datum/);
  db.close();
});
```

(No `csrfProtection` is passed to `createFerienmodusRouter` here — it defaults to a no-op, matching every other route test file's lightweight-app convention; the real CSRF wiring is proven separately by Task 16's sweep test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/ferienmodus.test.js`
Expected: FAIL — `src/routes/ferienmodus.js` does not exist yet.

- [ ] **Step 3: Implement the route**

Create `src/routes/ferienmodus.js`:

```js
import { Router } from 'express';
import { setFerienmodus, clearFerienmodus } from '../db/personenRepo.js';
import { listVertretungsKandidaten } from '../db/kontenRepo.js';

const DATUM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function createFerienmodusRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    const person = req.currentPerson;
    res.render('ferienmodus', {
      person,
      kandidaten: listVertretungsKandidaten(db, person.churchtools_person_id),
      values: {
        von: person.ferienmodus_von || '',
        bis: person.ferienmodus_bis || '',
        stellvertreterId: person.ferienmodus_stellvertreter_id || '',
      },
      errors: [],
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const person = req.currentPerson;
    const kandidaten = listVertretungsKandidaten(db, person.churchtools_person_id);
    const { von, bis, stellvertreterId, aktion } = req.body;

    if (aktion === 'beenden') {
      clearFerienmodus(db, person.churchtools_person_id);
      return res.redirect('/ferienmodus');
    }

    const errors = [];
    if (!von || !DATUM_PATTERN.test(von) || Number.isNaN(new Date(von).getTime())) {
      errors.push('Bitte ein gültiges Von-Datum angeben.');
    }
    if (!bis || !DATUM_PATTERN.test(bis) || Number.isNaN(new Date(bis).getTime())) {
      errors.push('Bitte ein gültiges Bis-Datum angeben.');
    }
    if (errors.length === 0 && bis < von) {
      errors.push('Das Bis-Datum darf nicht vor dem Von-Datum liegen.');
    }
    const stellvertreter = kandidaten.find((k) => k.churchtools_person_id === stellvertreterId);
    if (!stellvertreter) {
      errors.push('Bitte einen gültigen Stellvertreter aus der Liste auswählen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('ferienmodus', {
        person,
        kandidaten,
        values: { von: von || '', bis: bis || '', stellvertreterId: stellvertreterId || '' },
        errors,
      });
    }

    setFerienmodus(db, person.churchtools_person_id, { von, bis, stellvertreterId });
    res.redirect('/ferienmodus');
  });

  return router;
}
```

Create `views/ferienmodus.ejs` (mirrors `views/spesen-neu.ejs`'s card/form layout and `views/kontierung.ejs`'s error-list convention):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Ferienmodus — <%= branding.seitenTitel %></title>
</head>
<body>
  <%- include('_header') %>
  <main class="container py-4">
    <div class="row justify-content-center">
      <div class="col-lg-6">
        <h1 class="h3">Ferienmodus</h1>
        <p class="text-muted">
          Während eines aktiven Zeitraums erhält dein Stellvertreter zusätzlichen Zugriff auf deine
          Kontierungs- und Freigabe-Aufgaben (Freigeber 1/2) sowie die zugehörigen Mails — du selbst
          behältst deinen eigenen Zugriff unverändert.
        </p>

        <% if (person.ferienmodus_von) { %>
          <div class="alert alert-info">
            Aktueller Ferienmodus: <strong><%= person.ferienmodus_von %> – <%= person.ferienmodus_bis %></strong>,
            Stellvertreter: <strong><%= kandidaten.find((k) => k.churchtools_person_id === person.ferienmodus_stellvertreter_id)?.vorname %> <%= kandidaten.find((k) => k.churchtools_person_id === person.ferienmodus_stellvertreter_id)?.nachname %></strong>
          </div>
          <form method="post" action="/ferienmodus" class="mb-4">
            <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
            <input type="hidden" name="aktion" value="beenden">
            <button type="submit" class="btn btn-outline-danger btn-sm">Ferienmodus beenden</button>
          </form>
        <% } else { %>
          <p>Aktuell kein Ferienmodus aktiv.</p>
        <% } %>

        <% if (errors.length > 0) { %>
          <div class="alert alert-danger">
            <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
          </div>
        <% } %>

        <div class="card">
          <div class="card-body">
            <h2 class="h6">Ferienmodus setzen</h2>
            <form method="post" action="/ferienmodus">
              <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
              <div class="mb-3">
                <label class="form-label" for="von">Von</label>
                <input type="date" class="form-control" id="von" name="von" value="<%= values.von %>" required>
              </div>
              <div class="mb-3">
                <label class="form-label" for="bis">Bis</label>
                <input type="date" class="form-control" id="bis" name="bis" value="<%= values.bis %>" required>
              </div>
              <div class="mb-3">
                <label class="form-label" for="stellvertreterId">Stellvertreter</label>
                <select class="form-select" id="stellvertreterId" name="stellvertreterId" required>
                  <option value="">— bitte wählen —</option>
                  <% kandidaten.forEach((k) => { %>
                    <option value="<%= k.churchtools_person_id %>" <%= values.stellvertreterId === k.churchtools_person_id ? 'selected' : '' %>><%= k.vorname %> <%= k.nachname %></option>
                  <% }) %>
                </select>
                <% if (kandidaten.length === 0) { %>
                  <div class="form-text text-warning">Keine Stellvertreter-Kandidaten gefunden — du hast aktuell keine gemeinsame Konto-Rolle mit einer anderen Person.</div>
                <% } %>
              </div>
              <button type="submit" class="btn btn-primary">Speichern</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </main>
  <%- include('_footer') %>
</body>
</html>
```

Add the nav entry in `views/_header.ejs` right after the "Meine Spesen" `<li>` (line 67):

```html
          <li><a class="dropdown-item<%= navAktuellerPfad === '/ferienmodus' ? ' active' : '' %>" href="/ferienmodus">Ferienmodus</a></li>
```

Wire the router in `src/app.js`: add the import next to the other route imports (after `import { createMeineSpesenRouter } from './routes/meineSpesen.js';`):

```js
import { createFerienmodusRouter } from './routes/ferienmodus.js';
```

And mount it next to `/meine-spesen` (after the `app.use('/meine-spesen', ...)` line):

```js
  app.use('/ferienmodus', sessionLimiter, requireLogin(), createFerienmodusRouter({ db, csrfProtection }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/ferienmodus.test.js`
Expected: PASS.

Then run: `node --test` (full suite) to confirm `app.js`'s route registration didn't break anything else (e.g. `test/integration/app.test.js`, `test/unit/nav.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/routes/ferienmodus.js views/ferienmodus.ejs views/_header.ejs src/app.js test/integration/ferienmodus.test.js
git commit -m "feat(ferienmodus): add self-service /ferienmodus page and nav entry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 11: `kontierung.js` — authorization, audit vermerk, and mail wiring

**Files:**
- Modify: `src/routes/kontierung.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `istAktiveVertretungFuer` (Task 4), `sendNotificationMitVertretung` (Task 7).
- Produces: no signature changes — `loadAuthorizedJob`, the strict-Freigeber1 check, the `freigeber1`/`ablehnung` `createFreigabe` calls, and the Freigabe-2-fällig mail all become Ferienmodus-aware.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/kontierung.test.js` (using its existing `buildTestApp`, `seedKontoAndPersonen`, `createStubMailer` helpers — add `setFerienmodus` to the `personenRepo.js` import):

```js
test('a Ferienmodus-Stellvertreter can open and submit /kontierung/:id for the absent zugewiesene person', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer();
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id: '1', freigeber2Id: '3'
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const app = buildTestApp(db, mailer);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.org', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const getRes = await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '2');
  assert.equal(getRes.status, 200);

  const postRes = await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '2')
    .type('form')
    .send({
      kontoId: String(kontoId), typ: 'rechnung', interessenskonflikt: 'nein', absender: 'Lieferant AG',
      betrag: '100.00', zahlungsziel: '2026-12-31', rechnungsnummer: 'RE-1', debitorId: '',
    });
  assert.equal(postRes.status, 302);

  const freigaben = listFreigabenByJob(db, jobId);
  const freigeber1Eintrag = freigaben.find((f) => f.rolle === 'freigeber1');
  assert.equal(freigeber1Eintrag.person_id, '2');
  assert.equal(freigeber1Eintrag.vertretung_fuer, '1');
  db.close();
});

test('the Freigabe-2-fällig mail also reaches the Freigeber2\'s active Stellvertreter', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer();
  const kontoId = seedKontoAndPersonen(db); // freigeber2Id: '3'
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '4' });
  const app = buildTestApp(db, mailer);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.org', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      kontoId: String(kontoId), typ: 'rechnung', interessenskonflikt: 'nein', absender: 'Lieferant AG',
      betrag: '100.00', zahlungsziel: '2026-12-31', rechnungsnummer: 'RE-2', debitorId: '',
    });

  const freigabe2Mails = mailer.sent.filter((m) => /Freigabe 2/.test(m.text));
  assert.equal(freigabe2Mails.length, 2);
  assert.ok(freigabe2Mails.some((m) => m.to === 'p3@example.org'));
  assert.ok(freigabe2Mails.some((m) => m.to === 'p4@example.org'));
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — the Stellvertreter gets 403 on both GET and POST; the `vertretung_fuer` assertion fails; only one Freigabe-2 mail is sent.

- [ ] **Step 3: Implement**

Add the import at the top of `src/routes/kontierung.js`:

```js
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { sendNotificationMitVertretung } from '../services/notify.js';
```

In `loadAuthorizedJob`, change the `authorized` computation:

```js
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isSuperadmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id ||
        istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an);
```

In the strict-Freigeber1-Prüfung block, change `istEchterFreigeber1`:

```js
      const istEchterFreigeber1 =
        konto.freigeber1_id === req.currentPerson.churchtools_person_id ||
        istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, konto.freigeber1_id) ||
        (Boolean(job.freigabe1_eskaliert_von) && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
```

For the plain-success `createFreigabe(db, { ..., rolle: 'freigeber1', ... })` call (the `else` branch after `wirdWeitergeleitet`), add `vertretungFuer`:

```js
        } else {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigeber1',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung || null,
            eskaliertVon: job.freigabe1_eskaliert_von,
            vertretungFuer: istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
          });
          abschliessenFreigabe1(db, job.id);
        }
```

For the `ablehnen`-branch `createFreigabe(db, { ..., rolle: 'ablehnung', ... })` call, add the same:

```js
          abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (abgelehnt) {
            createFreigabe(db, {
              jobId: job.id,
              personId: req.currentPerson.churchtools_person_id,
              rolle: 'ablehnung',
              zeitpunkt: new Date().toISOString(),
              ip: req.ip,
              interessenskonflikt: false,
              kommentar: begruendung,
              eskaliertVon: null,
              vertretungFuer: istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, job.zugewiesen_an) ? job.zugewiesen_an : null,
            });
          }
```

Finally, the Freigabe-2-fällig mail (the `else` branch at the end of the POST handler, after `wirdWeitergeleitet`/`hatKonflikt`/`eskaliertAnAdmin`):

```js
      } else {
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
        if (freigeber2) {
          await sendNotificationMitVertretung(db, mailer, {
            person: freigeber2,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
              link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
            },
          });
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS — including every pre-existing test in the file (the added `|| istAktiveVertretungFuer(...)` and mail-wrapper changes must not alter behavior when no Ferienmodus is active).

- [ ] **Step 5: Commit**

```bash
git add src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "feat(ferienmodus): make Kontierung authorization, audit trail, and Freigabe-2 mail vertretung-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 12: `freigabe2.js` — authorization, audit vermerk, and mail wiring

**Files:**
- Modify: `src/routes/freigabe2.js`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Consumes: `istAktiveVertretungFuer` (Task 4), `sendNotificationMitVertretung` (Task 7).
- Produces: no signature changes — `loadAuthorized`, the `freigeber2`/`ablehnung` `createFreigabe` calls, and the Ablehnungs-Mail to the job's `zugewiesen_an` all become Ferienmodus-aware.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/freigabe2.test.js`. This file already defines `buildTestApp(db, { withErrorHandler = false, mailer, churchtoolsConfig } = {})` — use that exact signature. Add `setFerienmodus` to its `personenRepo.js` import:

```js
test('a Ferienmodus-Stellvertreter of the effective Freigeber2 can open and submit /freigabe2/:id', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  setFerienmodus(db, '3', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '4' });
  const pdfBytes = buildPdfFixture();
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-vertretung-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, pdfBytes);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.org', dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, jobId, kontoId);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  const app = buildTestApp(db, { mailer });

  const getRes = await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '4');
  assert.equal(getRes.status, 200);

  const postRes = await request(app)
    .post(`/freigabe2/${jobId}`)
    .set('x-test-person-id', '4')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(postRes.status, 302);

  const freigaben = listFreigabenByJob(db, jobId);
  const freigeber2Eintrag = freigaben.find((f) => f.rolle === 'freigeber2');
  assert.equal(freigeber2Eintrag.person_id, '4');
  assert.equal(freigeber2Eintrag.vertretung_fuer, '3');
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the Ablehnungs-Mail also reaches the zugewiesenen person\'s active Stellvertreter', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer();
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const pdfBytes = buildPdfFixture();
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-ablehnung-vertretung-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, pdfBytes);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.org', dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(jobId);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  const app = buildTestApp(db, { mailer });

  await request(app)
    .post(`/freigabe2/${jobId}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Doppelt erfasst.' });

  const ablehnungsMails = mailer.sent.filter((m) => /abgelehnt/.test(m.text));
  assert.ok(ablehnungsMails.some((m) => m.to === 'p1@example.org'));
  assert.ok(ablehnungsMails.some((m) => m.to === 'p2@example.org'));
  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — Stellvertreter gets 403; `vertretung_fuer` is null; the second Ablehnungs-Mail is missing.

- [ ] **Step 3: Implement**

Add the import at the top of `src/routes/freigabe2.js`:

```js
import { istAktiveVertretungFuer } from '../services/vertretung.js';
import { sendNotificationMitVertretung } from '../services/notify.js';
```

In `loadAuthorized`, change the `authorized` computation:

```js
    const konto = getKontoById(db, job.konto_id);
    const effektiverFreigeber2 = konto ? getEffectiveFreigeber2Id(job, konto) : null;
    const authorized =
      konto &&
      (job.freigabe2_eskaliert_an_admin
        ? isSuperadmin(req.currentPerson)
        : effektiverFreigeber2 === req.currentPerson.churchtools_person_id ||
          istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, effektiverFreigeber2));
```

In the POST handler's successful-`freigeben` branch, find where `freigeber2Eintrag`/the `createFreigabe(db, { ..., rolle: 'freigeber2', ... })` call happens and add `vertretungFuer`:

```js
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber2',
          zeitpunkt,
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: begruendung || null,
          eskaliertVon: job.freigabe2_eskaliert_von,
          vertretungFuer: istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, getEffectiveFreigeber2Id(job, konto)) ? getEffectiveFreigeber2Id(job, konto) : null,
        });
```

In the `ablehnen` branch's `createFreigabe(db, { ..., rolle: 'ablehnung', ... })` call:

```js
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: false,
            kommentar: begruendung,
            eskaliertVon: null,
            vertretungFuer: istAktiveVertretungFuer(db, req.currentPerson.churchtools_person_id, getEffectiveFreigeber2Id(job, konto)) ? getEffectiveFreigeber2Id(job, konto) : null,
          });
```

And the Ablehnungs-Mail to the job's owner right after it (the `else` branch that mails `besitzer`):

```js
        } else {
          const besitzer = getPersonById(db, job.zugewiesen_an);
          if (besitzer) {
            await sendNotificationMitVertretung(db, mailer, {
              person: besitzer,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                grund: 'Deine Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
          }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/routes/freigabe2.js test/integration/freigabe2.test.js
git commit -m "feat(ferienmodus): make Freigabe-2 authorization, audit trail, and Ablehnungs-Mail vertretung-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 13: `poolPage.js` — Pool-Weiterleitung mail wiring

**Files:**
- Modify: `src/routes/poolPage.js`
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `sendNotificationMitVertretung` (Task 7).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

`test/integration/poolPage.test.js` already defines `buildTestApp(db, mailer = { async sendMail() {} })` (single mailer arg, a built-in `csrfProtection` stub that accepts `_csrf: 'valid-token'` in the body), `seedBuchhaltungPerson(db, id = '50')`, and imports `setBerechtigungenForPerson` from `../../src/db/personBerechtigungenRepo.js` already — reuse all of these exactly. Add `setFerienmodus` to its existing `personenRepo.js` import line, then append:

```js
test('assigning a Pool Beleg to a person on active Ferienmodus also mails their Stellvertreter', async () => {
  const db = openDatabase(':memory:');
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  seedBuchhaltungPerson(db, '50');
  setBerechtigungenForPerson(db, '50', ['pool_zuweisen']);
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });
  const app = buildTestApp(db, mailer);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'x@example.org', dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const res = await request(app).post(`/pool/${jobId}/zuweisen`).set('x-test-person-id', '50').type('form').send({ _csrf: 'valid-token', personId: '1' });
  assert.equal(res.status, 200);

  const zuweisungsMails = mailer.sent.filter((m) => /zur Kontierung zugewiesen/.test(m.text));
  assert.ok(zuweisungsMails.some((m) => m.to === 'p1@example.org'));
  assert.ok(zuweisungsMails.some((m) => m.to === 'p2@example.org'));
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — only one `zur Kontierung zugewiesen` mail is sent (to `p1@example.org`).

- [ ] **Step 3: Implement**

Add the import at the top of `src/routes/poolPage.js`:

```js
import { sendNotificationMitVertretung } from '../services/notify.js';
```

Replace the `sendNotification(...)` call inside `router.post('/:id/zuweisen', ...)`:

```js
      await sendNotificationMitVertretung(db, mailer, {
        person: zielPerson,
        typ: 'zuweisung',
        jobId: job.id,
        variablen: {
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen.`,
          link: `${config.publicBaseUrl}/kontierung/${job.id}`,
        },
      });
```

(`sendNotification` import can stay if still used elsewhere in the file; otherwise remove the now-unused import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/routes/poolPage.js test/integration/poolPage.test.js
git commit -m "feat(ferienmodus): make Pool-Weiterleitung mail vertretung-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 14: `n8n/jobs.js` — initial auto-assignment mail wiring

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Test: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `sendNotificationMitVertretung` (Task 7).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

`test/integration/n8n/jobs.test.js` already defines `buildTestApp(db, config, mailer)` (3 args), `createStubMailer()`, `testConfig(jobsDir)`, and a `PDF_BYTES` fixture at module scope, and its existing "POST /api/n8n/jobs applies Zuweisungsregel matching..." test (around line 278) already shows the exact Konto+Debitor+Zuweisungsregel seeding and multipart request shape. Add `setFerienmodus` to its `personenRepo.js` import (dynamic `await import(...)` style, matching that test) and append a new test modeled directly on it:

```js
test('the automatic Zuweisungsregel-assignment mail also reaches the Freigeber1\'s active Stellvertreter', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { upsertPerson, setFerienmodus } = await import('../../../src/db/personenRepo.js');
  const { createKonto } = await import('../../../src/db/kontenRepo.js');
  const { createDebitor } = await import('../../../src/db/debitorenRepo.js');
  const { createZuweisungsregel } = await import('../../../src/db/zuweisungsregelnRepo.js');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', debitorId });
  setFerienmodus(db, '1', { von: '2000-01-01', bis: '2999-01-01', stellvertreterId: '2' });

  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const mailer = createStubMailer();
  const app = buildTestApp(db, testConfig(jobsDir), mailer);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'zugewiesen');
  const zuweisungsMails = mailer.sent.filter((m) => /automatisch zugewiesen/.test(m.text));
  assert.ok(zuweisungsMails.some((m) => m.to === 'p1@example.org'));
  assert.ok(zuweisungsMails.some((m) => m.to === 'p2@example.org'));
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — only `p1@example.org` receives the mail.

- [ ] **Step 3: Implement**

Add the import at the top of `src/routes/n8n/jobs.js`:

```js
import { sendNotificationMitVertretung } from '../../services/notify.js';
```

Replace the `sendNotification(...)` call around line 105:

```js
        if (job.status === 'zugewiesen') {
          const freigeber1 = getPersonById(db, job.zugewiesen_an);
          if (freigeber1) {
            await sendNotificationMitVertretung(db, mailer, {
              person: freigeber1,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                grund: 'Eine neue Rechnung wurde dir automatisch zugewiesen.',
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "feat(ferienmodus): make the initial n8n auto-assignment mail vertretung-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 15: Admin → Personen — informational Ferienmodus badge

**Files:**
- Modify: `src/routes/admin/personen.js`
- Modify: `views/admin/personen-liste.ejs`
- Test: `test/integration/admin/personen.test.js`

**Interfaces:**
- Consumes: `personName` (existing, `src/services/auditLog.js`).
- Produces: each row in `listAllPersons(db).map(...)` gains `ferienmodusStellvertreterName: string | null` (the underlying `ferienmodus_von`/`ferienmodus_bis` fields are already present on `p` via `listAllPersons`'s `SELECT *`).

- [ ] **Step 1: Write the failing test**

Check `test/integration/admin/personen.test.js`'s existing login/seed helpers (`testConfig`, `loginAs`, `createApp` usage — copy the pattern from an existing test in the same file), then append:

```js
test('GET /admin/personen shows the Ferienmodus period and Stellvertreter name for a person with an active/planned vacation', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'admin-personen-ferienmodus-test-'));
  const app = createApp({ db, config: testConfig(dir) });
  const client = setupMockChurchTools(testConfig(dir).churchtools.baseUrl);
  upsertPerson(db, { id: '2', vorname: 'Bo', nachname: 'Muster', email: 'bo@example.org', gruppen: ['10'], loggedInNow: true });
  setFerienmodus(db, '2', { von: '2026-09-10', bis: '2026-09-24', stellvertreterId: '1' });
  const admin = await loginAs(app, client, { id: 1, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });

  const res = await admin.get('/admin/personen');
  assert.equal(res.status, 200);
  assert.match(res.text, /2026-09-10/);
  assert.match(res.text, /Admina Portal/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

Add `setFerienmodus` to the file's `personenRepo.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/personen.test.js`
Expected: FAIL — the page renders without the date/name.

- [ ] **Step 3: Implement**

In `src/routes/admin/personen.js`, add the import and extend the mapping:

```js
import { personName } from '../../services/auditLog.js';
```

```js
  router.get('/', (req, res) => {
    const bearbeitbar = personHasRole(req.currentPerson, config, 'superadmin');
    const personen = listAllPersons(db).map((p) => ({
      ...p,
      rolle: rolleVon(p, config),
      berechtigungen: listBerechtigungenForPerson(db, p.churchtools_person_id),
      ferienmodusStellvertreterName: p.ferienmodus_stellvertreter_id ? personName(db, p.ferienmodus_stellvertreter_id) : null,
    }));
    res.render('admin/personen-liste', {
      personen,
      bearbeitbar,
      grantableBerechtigungen: GRANTABLE_BERECHTIGUNGEN,
      berechtigungLabels: BERECHTIGUNG_LABELS,
    });
  });
```

In `views/admin/personen-liste.ejs`, add a column header (in the `<thead>` row, after `<th>Hinweis</th>`):

```html
<thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Rolle</th><th>Einzelrechte</th><th>Hinweis</th><th>Ferienmodus</th></tr></thead>
```

And a matching `<td>` at the end of each row (after the existing "Hinweis" `<td>`, before `</tr>`):

```html
              <td>
                <% if (p.ferienmodus_von) { %>
                  <span class="badge text-bg-info d-block"><%= p.ferienmodus_von %> – <%= p.ferienmodus_bis %></span>
                  <span class="text-muted small">Stellvertreter: <%= p.ferienmodusStellvertreterName %></span>
                <% } else { %>
                  <span class="text-muted small">—</span>
                <% } %>
              </td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/admin/personen.test.js`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/personen.js views/admin/personen-liste.ejs test/integration/admin/personen.test.js
git commit -m "feat(ferienmodus): show an informational Ferienmodus badge in Admin → Personen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 16: CSRF sweep coverage for `/ferienmodus`

**Files:**
- Modify: `test/integration/csrfSweep.test.js`

**Interfaces:**
- None — this task only extends an existing test's route list.

- [ ] **Step 1: Extend the route list (this IS the test — no separate "write failing test" step, since the sweep test itself already exists and exercises whatever is in the list)**

In `test/integration/csrfSweep.test.js`, add `'/ferienmodus'` to `SESSION_POST_ROUTES` (anywhere in the array — alphabetically near `'/freigabe2/1'` reads cleanest):

```js
  '/freigabe2/1',
  '/ferienmodus',
  '/abgelehnt/1/ueberarbeiten',
```

- [ ] **Step 2: Run the sweep test to verify it currently fails without Task 10's CSRF wiring, then passes with it**

Run: `node --test test/integration/csrfSweep.test.js`
Expected: PASS (Task 10 already wired `csrfProtection` into `POST /ferienmodus`, and the router is mounted with `sessionLimiter, requireLogin()` like every other session route in `app.js` — the login helper's admin+buchhaltung person clears `requireLogin()` trivially). If this fails, it means Task 10's `app.js` wiring is missing `csrfProtection` — go back and fix Task 10 rather than weakening this test.

- [ ] **Step 3: Commit**

```bash
git add test/integration/csrfSweep.test.js
git commit -m "test(ferienmodus): add /ferienmodus to the CSRF route sweep

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 17: Documentation

**Files:**
- Modify: `docs/rechnungs-workflow.md`
- Modify: `docs/auth-und-rechte.md`
- Modify: `docs/datenmodell.md`

**Interfaces:**
- None — documentation only, per this project's established convention (memory: "Umfassende Doku in docs/ ... keep in sync when routes/roles/workflow change").

- [ ] **Step 1: Update `docs/datenmodell.md`**

In the `personen` ER-diagram block, add the three new fields:

```
    personen {
        text churchtools_person_id PK
        text vorname
        text nachname
        text email
        int aktiv
        text gruppen "JSON-Array von Gruppen-IDs"
        int ct_person_unresolved
        text last_synced_at
        text last_login_at
        text ferienmodus_von
        text ferienmodus_bis
        text ferienmodus_stellvertreter_id FK
    }
```

In the `freigaben` ER-diagram block, add:

```
    freigaben {
        int id PK
        int job_id FK "kein enforced FK, siehe unten"
        text person_id FK
        text rolle "6 mögliche Werte"
        text zeitpunkt
        text ip
        int interessenskonflikt
        text kommentar
        text eskaliert_von FK
        text vertretung_fuer FK
    }
```

Add a new subsection under "### `personen`" (after its existing paragraph):

```markdown
**Ferienmodus** (`ferienmodus_von`, `ferienmodus_bis`, `ferienmodus_stellvertreter_id`):
selbstverwalteter, additiver Abwesenheits-Zeitraum mit gewähltem Stellvertreter — siehe
[Ferienmodus](rechnungs-workflow.md#ferienmodus-abwesenheits-stellvertretung). "Aktiv" wird nie
gespeichert, sondern bei jeder Prüfung aus dem heutigen Datum berechnet
(`src/services/vertretung.js`).
```

Add a note under "### `freigaben`" (after its existing paragraph):

```markdown
`vertretung_fuer` ist gesetzt, wenn die handelnde Person zum Zeitpunkt der Aktion aktiver
Ferienmodus-Stellvertreter der eigentlich zuständigen Person war — sonst `NULL`.
```

- [ ] **Step 2: Update `docs/auth-und-rechte.md`**

Add a new section after "## Job-Autorisierung (pro Rechnung)" (at the end of the file):

```markdown
## Ferienmodus — additive Abwesenheits-Stellvertretung

Zusätzlich zur Job-Autorisierung oben kann jede Person für sich selbst unter `/ferienmodus`
einen Zeitraum mit gewähltem Stellvertreter hinterlegen (`src/routes/ferienmodus.js`). Dies ist
**nicht** dasselbe wie der pro-Konto feste `stellvertreter1_id`/`stellvertreter2_id`
(Interessenskonflikt-Eskalation) — es ist ein zweiter, unabhängiger, personenbezogener
Mechanismus. Details: [rechnungs-workflow.md](rechnungs-workflow.md#ferienmodus-abwesenheits-stellvertretung).

Solange der Zeitraum aktiv ist (`istAktiveVertretungFuer`, `src/services/vertretung.js`), gilt
additiv — die abwesende Person behält ihren eigenen Zugriff unverändert:

- der Stellvertreter darf `/kontierung/:id` für Jobs öffnen/bearbeiten, die der abwesenden Person
  zugewiesen sind
- der Stellvertreter darf `/freigabe2/:id` für Jobs öffnen/bearbeiten, deren effektiver Freigeber2
  die abwesende Person ist
- beide Aufgaben erscheinen zusätzlich im eigenen `/pool`-Dashboard des Stellvertreters
- betroffene Zuweisungs-/Freigabe-2-fällig-/Ablehnungs-Mails gehen zusätzlich an den
  Stellvertreter (`sendNotificationMitVertretung`, `src/services/notify.js`)
- im Audit-Log wird vermerkt, wenn eine Aktion als Stellvertreter ausgeführt wurde
  (`freigaben.vertretung_fuer`)

Auswählbar als Stellvertreter sind nur aktive Personen, die mit der eigenen Person mindestens ein
Konto teilen (`listVertretungsKandidaten`, `src/db/kontenRepo.js`). Admin → Personen zeigt einen
gesetzten Ferienmodus rein informativ an — Verwaltung bleibt Selbstbedienung.
```

- [ ] **Step 3: Update `docs/rechnungs-workflow.md`**

Add a new section after "## \"Stalled Jobs\" — blockierte Rechnungen" (at the end of the file):

```markdown
## Ferienmodus — Abwesenheits-Stellvertretung

Unabhängig vom oben beschriebenen Status-Modell kann jede Person unter `/ferienmodus` einen
Zeitraum mit gewähltem Stellvertreter hinterlegen (`personen.ferienmodus_von`/`ferienmodus_bis`/
`ferienmodus_stellvertreter_id`). Solange der Zeitraum läuft, gilt additiv — kein Job wird
umgeschrieben (`zugewiesen_an`, `konten.freigeber1_id`/`freigeber2_id` bleiben unverändert):

- der Stellvertreter kann `zugewiesen`-Jobs der abwesenden Person kontieren
- der Stellvertreter kann `freigabe2`-Jobs freigeben, deren effektiver Freigeber2 die abwesende
  Person ist
- beide Aufgaben erscheinen im `/pool`-Dashboard des Stellvertreters, zusätzlich zu dessen eigenen
- die abwesende Person behält währenddessen ihren eigenen Zugriff unverändert

Details zur Autorisierung: [auth-und-rechte.md](auth-und-rechte.md#ferienmodus--additive-abwesenheits-stellvertretung).
```

- [ ] **Step 4: Verify the docs build/render sensibly**

Run: `grep -rn "ferienmodus" docs/*.md` to confirm all three files were actually touched and the anchors referenced (`#ferienmodus-abwesenheits-stellvertretung`, `#ferienmodus--additive-abwesenheits-stellvertretung`) match the exact heading text added above (GitHub/most Markdown renderers slugify headings by lowercasing and replacing spaces with `-`, keeping existing `-`; double-check the double-dash in the auth-und-rechte.md anchor matches its `## Ferienmodus — additive ...` heading, which contains an em dash that slugifies to a double hyphen).

- [ ] **Step 5: Commit**

```bash
git add docs/rechnungs-workflow.md docs/auth-und-rechte.md docs/datenmodell.md
git commit -m "docs(ferienmodus): document the vacation-mode substitute feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:**
- Datenmodell → Task 1
- Self-Service UI → Task 10
- Autorisierung & Sichtbarkeit (Kontierung, Freigabe2, canViewJobPdf, dashboard lists) → Tasks 8, 9, 11, 12
- Benachrichtigungen (all five listed call sites: n8n initial assignment, Pool-Weiterleitung, Freigabe-2-fällig, Ablehnung) → Tasks 11, 12, 13, 14, via the shared Task 7 helper
- Audit-Vermerk → Tasks 5, 6, wired at the freigeber1/freigeber2/ablehnung call sites in Tasks 11-12
- Admin-Übersicht → Task 15
- "Explizit ausserhalb des Umfangs" (no admin-side editing, no change to Konto-escalation mails, no reassignment, no chaining) → respected throughout; no task violates these
- "Betroffene Dateien" list in the spec → every file listed there has a corresponding task

**Full regression check (run once all 17 tasks are complete):**

Run: `node --test`
Expected: the entire existing suite still passes — every change in this plan is additive (`OR istAktiveVertretungFuer(...)`, `OR ... IN (subquery)`, a new optional `vertretungFuer` parameter defaulting to `null`), so no pre-existing behavior should change when no Ferienmodus is ever set.
