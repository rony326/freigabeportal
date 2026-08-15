# Freigabeportal Sub-Phase D2: Freigabe-Workflow-UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the human-facing browser workflow — Pool overview, Kontierung + Freigabe 1,
Freigabe-2 split-view — and wire D1's `stampAndFinalize` in at the point a job is fully
approved.

**Architecture:** Three new server-rendered EJS pages under session auth
(`requireRole(config, 'buchhaltung')`, plus a per-job identity check on the two action pages),
backed by a new `freigabenRepo.js` and several small, narrowly-named `jobsRepo`/`kontenRepo`
additions that each perform one state transition (mirroring the existing `claimJob`/
`confirmAbholung` style — no generic "update job" function). PDF viewing everywhere reuses the
existing signed `/downloads/:jobId` URL via a plain `<iframe>`/`<embed>` — no new rendering
code. All multi-write state transitions run inside a single `db.exec('BEGIN')`/`COMMIT`/
`ROLLBACK` block, following the pattern already established in `src/services/sync.js`.

**Tech Stack:** Same as Phases A–D1 (Node ≥22.13.0, Express, `node:sqlite`, `node:test`,
`supertest`, EJS). No new dependencies — `mupdf`/`pdf-lib` are already installed (D1).

**Spec:** `docs/superpowers/specs/2026-08-15-phase-d2-freigabe-workflow-ui-design.md`

**One deliberate addition beyond the literal spec text:** a "Zurück in den Pool legen" release
action on the Kontierung page. The spec's Konto-Dropdown-Beschränkung (only Konten where the
current person is `freigeber1_id`/`stellvertreter1_id`) means a pool-claim by someone whose
Konten don't include this particular invoice would otherwise dead-end with no way out — an
empty dropdown and no path back to the pool. This is a small, mechanical fix (one repo function,
one route, one button), not a design change, so it's folded into Task 4 rather than reopening
spec approval.

## Global Constraints

- Konto-Dropdown in der Kontierung ist auf Konten beschränkt, bei denen die aktuelle Person
  `freigeber1_id` **oder** `stellvertreter1_id` ist — eine echte Zugriffsgrenze, keine
  Routing-Empfehlung.
- Freigabe 2 ist auf die aktuell wirksame Identität beschränkt: `konto.freigeber2_id`, oder nach
  einer Eskalation `konto.stellvertreter2_id`. Jede andere Person (auch mit `buchhaltung`-Rolle)
  bekommt 403.
- Kontierung + Freigabe 1 passieren "aus einer Hand": die Zwischenstatus `kontiert`/`freigabe1`
  aus dem Phase-C-Schema werden nie persistent erreicht. Ein Submit ohne Konflikt bewegt den Job
  direkt von `zugewiesen` nach `freigabe2`.
- Kein "Ablehnen"-Button in der Freigabe-2-Ansicht — nur "Freigeben". Der Rückweg bei Ablehnung
  ist explizit D3s Aufgabe.
- PDF-Anzeige überall via `<iframe>`/`<embed>` auf die bestehende signierte
  `/downloads/:jobId`-URL (`buildSignedDownloadUrl`, Phase C) — kein neuer Rendering-Code, kein
  serverseitiges Rendern einzelner Seiten.
- Alle mehrstufigen Statusänderungen pro Formular-Submit laufen in einer einzigen
  `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK`-Transaktion (Muster aus `src/services/sync.js`).
- Schlägt das Stempeln beim Abschluss von Freigabe 2 fehl, wird nichts committet — weder die
  neue `freigaben`-Zeile noch der Statuswechsel. Der Job bleibt unverändert in `freigabe2`.
- Tests: echte HTTP-Requests via `supertest`, echte In-Memory-SQLite-DB, echte PDF-Fixtures
  (`buildPdfFixture` aus `test/helpers/pdfFixture.js`, D1), keine Mocks der eigenen
  Business-Logik.
- `npm test` läuft `node --test 'test/**/*.test.js'` — dieses Skript nicht ändern.
- Client-seitiges JavaScript (Beanspruchen-Button, Thumbnail-Vorschau-Dialog) wird nicht
  automatisiert getestet — dieses Projekt hat kein Browser-/JS-Testsetup (nur `supertest` gegen
  den Server). Tests decken den serverseitig gerenderten HTML-Output ab (richtige Daten-Attribute,
  Bild-`src`, Tabelleninhalte), nicht das Klickverhalten selbst.

---

### Task 1: Datenmodell — `freigabenRepo`, neue `jobsRepo`-/`kontenRepo`-Funktionen

**Files:**
- Modify: `src/db/schema.sql` — vier neue Spalten auf `jobs`
- Create: `src/db/freigabenRepo.js`
- Modify: `src/db/jobsRepo.js` — sieben neue Funktionen
- Modify: `src/db/kontenRepo.js` — eine neue Funktion
- Test: `test/unit/db.test.js`, `test/unit/freigabenRepo.test.js` (neu), `test/unit/jobsRepo.test.js`, `test/unit/kontenRepo.test.js`

**Interfaces:**
- Consumes: nichts Neues.
- Produces:
  - `createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon })` → `id` (number)
  - `listFreigabenByJob(db, jobId)` → Array von Zeilen
  - `setKontierung(db, jobId, kontoId)` → void
  - `eskalierenFreigabe1(db, jobId, { eskaliertVon, grund, stellvertreterId })` → void
  - `abschliessenFreigabe1(db, jobId)` → void
  - `eskalierenFreigabe2(db, jobId, { eskaliertVon, grund })` → void
  - `abschliessenFreigabe2(db, jobId)` → void
  - `releaseJob(db, jobId, personId)` → boolean (true = erfolgreich freigegeben)
  - `listZugewiesenJobsForPerson(db, personId)` → Array von Job-Zeilen
  - `listFreigabe2JobsForPerson(db, personId)` → Array von Job-Zeilen
  - `getEffectiveFreigeber2Id(job, konto)` → string (pure Funktion, kein DB-Zugriff)
  - `listKontenForPerson(db, personId)` → Array von Konto-Zeilen (nur `aktiv=1`, gefiltert auf `freigeber1_id`/`stellvertreter1_id`)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/db.test.js`:

```js
test('jobs table has the four Freigabe-Eskalation columns', () => {
  const db = openDatabase(':memory:');
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const expected of ['freigabe1_eskaliert_von', 'freigabe1_eskalationsgrund', 'freigabe2_eskaliert_von', 'freigabe2_eskalationsgrund']) {
    assert.ok(columns.includes(expected), `jobs table is missing ${expected}`);
  }
  db.close();
});
```

Create `test/unit/freigabenRepo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';

function seedJob(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  return { kontoId, jobId };
}

test('createFreigabe inserts a row with all fields, listFreigabenByJob returns it', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  const id = createFreigabe(db, {
    jobId,
    personId: '1',
    rolle: 'freigeber1',
    zeitpunkt: '2026-08-15T09:00:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: false,
    kommentar: null,
    eskaliertVon: null,
  });
  assert.equal(typeof id, 'number');
  const rows = listFreigabenByJob(db, jobId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_id, '1');
  assert.equal(rows[0].rolle, 'freigeber1');
  assert.equal(rows[0].zeitpunkt, '2026-08-15T09:00:00.000Z');
  assert.equal(rows[0].ip, '1.2.3.4');
  assert.equal(rows[0].interessenskonflikt, 0);
  assert.equal(rows[0].kommentar, null);
  assert.equal(rows[0].eskaliert_von, null);
  db.close();
});

test('createFreigabe records interessenskonflikt, kommentar and eskaliertVon when set', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  createFreigabe(db, {
    jobId,
    personId: '2',
    rolle: 'freigeber1',
    zeitpunkt: '2026-08-15T09:00:00.000Z',
    ip: '1.2.3.4',
    interessenskonflikt: true,
    kommentar: 'Verwandtschaft mit Lieferant',
    eskaliertVon: '1',
  });
  const rows = listFreigabenByJob(db, jobId);
  assert.equal(rows[0].interessenskonflikt, 1);
  assert.equal(rows[0].kommentar, 'Verwandtschaft mit Lieferant');
  assert.equal(rows[0].eskaliert_von, '1');
  db.close();
});

test('listFreigabenByJob only returns rows for the given job', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seedJob(db);
  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId: otherJobId, personId: '3', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.equal(listFreigabenByJob(db, jobId).length, 1);
  assert.equal(listFreigabenByJob(db, otherJobId).length, 1);
  db.close();
});
```

Append to `test/unit/jobsRepo.test.js` (add the new function names to the existing import line
from `'../../src/db/jobsRepo.js'`):

```js
test('setKontierung sets konto_id on the job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  assert.equal(getJobById(db, jobId).konto_id, kontoId);
  db.close();
});

test('eskalierenFreigabe1 reassigns zugewiesen_an and records the escalation', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  const job = getJobById(db, jobId);
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Befangen');
  db.close();
});

test('abschliessenFreigabe1 sets status to freigabe2 and clears the escalation columns', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  abschliessenFreigabe1(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskalationsgrund, null);
  db.close();
});

test('eskalierenFreigabe2 records the escalation without changing status', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.equal(job.freigabe2_eskalationsgrund, 'Befangen');
  db.close();
});

test('abschliessenFreigabe2 sets status to abgeschlossen and clears the escalation columns', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  abschliessenFreigabe2(db, jobId);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'abgeschlossen');
  assert.equal(job.freigabe2_eskaliert_von, null);
  assert.equal(job.freigabe2_eskalationsgrund, null);
  db.close();
});

test('releaseJob puts a zugewiesen job claimed by this person back into the pool', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const released = releaseJob(db, jobId, '1');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.konto_id, null);
  db.close();
});

test('releaseJob refuses to release a job claimed by someone else', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const released = releaseJob(db, jobId, '2');
  assert.equal(released, false);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');
  db.close();
});

test('releaseJob clears a leftover freigabe1 escalation so a fresh claim starts clean', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  eskalierenFreigabe1(db, jobId, { eskaliertVon: '1', grund: 'Befangen', stellvertreterId: '2' });
  // person '2' (the stellvertreter this escalated to) decides they don't recognize it either
  const released = releaseJob(db, jobId, '2');
  assert.equal(released, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.freigabe1_eskaliert_von, null);
  assert.equal(job.freigabe1_eskalationsgrund, null);
  db.close();
});

test('listZugewiesenJobsForPerson returns only zugewiesen jobs assigned to that person', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const otherJobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  claimJob(db, jobId, '1');
  claimJob(db, otherJobId, '2');
  const rows = listZugewiesenJobsForPerson(db, '1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, jobId);
  db.close();
});

test('listFreigabe2JobsForPerson matches freigeber2_id when not escalated, stellvertreter2_id after escalation', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db); // freigeber2Id: '3', stellvertreter2Id: '4'
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 1);
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 0);

  eskalierenFreigabe2(db, jobId, { eskaliertVon: '3', grund: 'Befangen' });
  assert.equal(listFreigabe2JobsForPerson(db, '3').length, 0);
  assert.equal(listFreigabe2JobsForPerson(db, '4').length, 1);
  db.close();
});

test('getEffectiveFreigeber2Id returns freigeber2_id normally, stellvertreter2_id after escalation', () => {
  const konto = { freigeber2_id: '3', stellvertreter2_id: '4' };
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: null }, konto), '3');
  assert.equal(getEffectiveFreigeber2Id({ freigabe2_eskaliert_von: '3' }, konto), '4');
});
```

Append to `test/unit/kontenRepo.test.js`:

```js
test('listKontenForPerson returns only active Konten where the person is freigeber1 or stellvertreter1', () => {
  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoA = createKonto(db, { kontonummer: '3000', bezeichnung: 'A', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoB = createKonto(db, { kontonummer: '3100', bezeichnung: 'B', freigeber1Id: '5', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoC = createKonto(db, { kontonummer: '3200', bezeichnung: 'C', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, kontoB);

  const rows = listKontenForPerson(db, '1');
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(kontoA), 'should include Konto where person is freigeber1');
  assert.ok(!ids.includes(kontoB), 'should exclude an inactive Konto even if person is stellvertreter1');
  assert.ok(!ids.includes(kontoC), 'should exclude a Konto the person has no role on');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js test/unit/freigabenRepo.test.js test/unit/jobsRepo.test.js test/unit/kontenRepo.test.js`
Expected: FAIL — new columns/functions/file don't exist yet.

- [ ] **Step 3: Modify `src/db/schema.sql`**

In the `CREATE TABLE IF NOT EXISTS jobs (...)` block, add four columns right after
`thumbnail_pfad TEXT`:

```sql
  thumbnail_pfad TEXT,
  freigabe1_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
  freigabe1_eskalationsgrund TEXT,
  freigabe2_eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
  freigabe2_eskalationsgrund TEXT
```

(i.e. add a comma after `thumbnail_pfad TEXT` and the four new lines before the closing `);`).

- [ ] **Step 4: Create `src/db/freigabenRepo.js`**

```js
export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null);
  return Number(result.lastInsertRowid);
}

export function listFreigabenByJob(db, jobId) {
  return db.prepare('SELECT * FROM freigaben WHERE job_id = ? ORDER BY id').all(jobId);
}
```

- [ ] **Step 5: Add the new functions to `src/db/jobsRepo.js`**

Append at the end of the file:

```js
export function setKontierung(db, jobId, kontoId) {
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);
}

export function eskalierenFreigabe1(db, jobId, { eskaliertVon, grund, stellvertreterId }) {
  db.prepare(
    'UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(stellvertreterId, eskaliertVon, grund, jobId);
}

export function abschliessenFreigabe1(db, jobId) {
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
}

export function eskalierenFreigabe2(db, jobId, { eskaliertVon, grund }) {
  db.prepare('UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ? WHERE id = ?').run(eskaliertVon, grund, jobId);
}

export function abschliessenFreigabe2(db, jobId) {
  db.prepare(
    "UPDATE jobs SET status = 'abgeschlossen', freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
}

export function releaseJob(db, jobId, personId) {
  // Also clears freigabe1_eskaliert_von/-grund: a stellvertreter1 who was escalated to can
  // release the job too (loadAuthorizedJob only checks current zugewiesen_an), and a fresh
  // claimer must not inherit a stale escalation record from a previous claim cycle.
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(jobId, personId);
  return result.changes > 0;
}

export function listZugewiesenJobsForPerson(db, personId) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'zugewiesen' AND zugewiesen_an = ? ORDER BY eingang_am").all(personId);
}

export function listFreigabe2JobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT jobs.* FROM jobs
       JOIN konten ON konten.id = jobs.konto_id
       WHERE jobs.status = 'freigabe2'
         AND (
           (jobs.freigabe2_eskaliert_von IS NULL AND konten.freigeber2_id = ?)
           OR (jobs.freigabe2_eskaliert_von IS NOT NULL AND konten.stellvertreter2_id = ?)
         )
       ORDER BY jobs.eingang_am`
    )
    .all(personId, personId);
}

export function getEffectiveFreigeber2Id(job, konto) {
  return job.freigabe2_eskaliert_von ? konto.stellvertreter2_id : konto.freigeber2_id;
}
```

- [ ] **Step 6: Add `listKontenForPerson` to `src/db/kontenRepo.js`**

Append at the end of the file:

```js
export function listKontenForPerson(db, personId) {
  return db
    .prepare('SELECT * FROM konten WHERE aktiv = 1 AND (freigeber1_id = ? OR stellvertreter1_id = ?) ORDER BY kontonummer')
    .all(personId, personId);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js test/unit/freigabenRepo.test.js test/unit/jobsRepo.test.js test/unit/kontenRepo.test.js`
Expected: PASS

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/freigabenRepo.js src/db/jobsRepo.js src/db/kontenRepo.js test/unit/db.test.js test/unit/freigabenRepo.test.js test/unit/jobsRepo.test.js test/unit/kontenRepo.test.js
git commit -m "feat: freigabenRepo and job/konto repo functions for the Freigabe-Workflow"
```

---

### Task 2: Thumbnail-Serving-Route (`GET /api/pool/:id/thumbnail`)

**Files:**
- Modify: `src/routes/pool.js`
- Modify: `test/integration/pool.test.js`

**Interfaces:**
- Consumes: `getJobById(db, id)` (existing, `src/db/jobsRepo.js`).
- Produces: nothing new for later tasks — the Pool page (Task 3) references this URL directly
  as a plain string (`/api/pool/${job.id}/thumbnail`), no shared helper needed.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/pool.test.js`. Add `getJobById, setThumbnailPfad` to the existing
import from `'../../src/db/jobsRepo.js'`, and add the new route to the `POOL_ROUTES` 401/403
sweep array:

```js
const POOL_ROUTES = [
  { method: 'get', path: '/api/pool' },
  { method: 'post', path: '/api/pool/1/beanspruchen' },
  { method: 'get', path: '/api/pool/1/thumbnail' },
];
```

Then append these tests:

```js
test('GET /api/pool/:id/thumbnail serves the PNG bytes when a thumbnail exists', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const dir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
  const thumbnailPfad = join(dir, 'a.png');
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(thumbnailPfad, pngBytes);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setThumbnailPfad(db, id, thumbnailPfad);
  const app = buildTestApp(db);

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(Buffer.compare(res.body, pngBytes), 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/pool/:id/thumbnail returns 404 when the job has no thumbnail', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get(`/api/pool/${id}/thumbnail`).set('x-test-person-id', '50');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /api/pool/:id/thumbnail returns 404 for a nonexistent job id', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const app = buildTestApp(db);

  const res = await request(app).get('/api/pool/999999/thumbnail').set('x-test-person-id', '50');
  assert.equal(res.status, 404);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/pool.test.js`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Modify `src/routes/pool.js`**

Add `createReadStream, existsSync` and `getJobById` imports at the top:

```js
import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { listPoolJobs, claimJob, getJobById } from '../db/jobsRepo.js';
```

Add this route (order doesn't matter relative to the other two, but place it after `beanspruchen`
for readability):

```js
  router.get('/:id/thumbnail', (req, res) => {
    const job = getJobById(db, Number(req.params.id));
    if (!job || !job.thumbnail_pfad || !existsSync(job.thumbnail_pfad)) {
      return res.status(404).json({ error: 'Kein Thumbnail vorhanden.' });
    }
    res.type('image/png');
    createReadStream(job.thumbnail_pfad).pipe(res);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/pool.test.js`
Expected: PASS (all tests, including the three new ones)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/pool.js test/integration/pool.test.js
git commit -m "feat: serve job thumbnails over the existing session-authenticated pool API"
```

---

### Task 3: Pool-Übersicht-Seite (`GET /pool`)

**Files:**
- Create: `src/routes/poolPage.js`
- Create: `views/pool.ejs`
- Modify: `src/services/downloadUrl.js` — export a shared preview TTL constant
- Modify: `src/app.js`
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `listPoolJobs`, `listZugewiesenJobsForPerson`, `listFreigabe2JobsForPerson` (Task 1,
  `src/db/jobsRepo.js`), `buildSignedDownloadUrl` (Phase C, `src/services/downloadUrl.js`),
  `requireRole`, `loadCurrentPerson` (Phase A, `src/middleware/roles.js`).
- Produces: `createPoolPageRouter({ db, config })` → Router with `GET /`. `PDF_PREVIEW_TTL_SECONDS`
  exported from `src/services/downloadUrl.js`, reused by Task 4 and Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/integration/poolPage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, setKontierung } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createPoolPageRouter } from '../../src/routes/poolPage.js';

function buildTestApp(db) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use('/pool', requireRole(config, 'buchhaltung'), createPoolPageRouter({ db, config }));
  return app;
}

function seedBuchhaltungPerson(db, id = '50') {
  upsertPerson(db, { id, vorname: 'Buch', nachname: 'Halter', email: `${id}@example.org`, gruppen: ['10'], loggedInNow: true });
}

test('GET /pool returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/pool');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /pool returns 403 for a logged-in person without the buchhaltung group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Admin', nachname: 'Only', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /pool lists an unzugewiesen job in the Pool section with a thumbnail src and preview URL', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/api/pool/${id}/thumbnail`));
  assert.match(res.text, /rechnung\.pdf/);
  // EJS's <%= %> HTML-escapes output, so the "&" between query params is rendered as "&amp;"
  // in the actual page source — this asserts the real escaped form, not the raw URL string.
  assert.match(res.text, /\/downloads\/\d+\?expires=\d+&amp;signature=[0-9a-f]{64}/);
  assert.match(res.text, new RegExp(`data-job-id="${id}"`));
  db.close();
});

test('GET /pool lists a job assigned to the current person under "Meine offenen Kontierungen"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'zu-kontieren.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '50');
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /zu-kontieren\.pdf/);
  assert.match(res.text, new RegExp(`/kontierung/${id}`));
  db.close();
});

test('GET /pool lists a job awaiting this person\'s Freigabe 2 under "Meine Freigaben"', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '50', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'freizugeben.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  const app = buildTestApp(db);

  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.match(res.text, /freizugeben\.pdf/);
  assert.match(res.text, new RegExp(`/freigabe2/${id}`));
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — `src/routes/poolPage.js` and `views/pool.ejs` don't exist yet.

- [ ] **Step 3: Add the preview TTL constant to `src/services/downloadUrl.js`**

Add near the top of the file:

```js
export const PDF_PREVIEW_TTL_SECONDS = 30 * 60;
```

- [ ] **Step 4: Create `views/pool.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Aufgaben — Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <h1>Aufgaben</h1>

  <h2>Pool</h2>
  <% if (poolJobs.length === 0) { %>
    <p>Keine offenen Rechnungen im Pool.</p>
  <% } else { %>
    <table>
      <thead><tr><th>Vorschau</th><th>Dateiname</th><th>Eingang</th><th></th></tr></thead>
      <tbody>
        <% poolJobs.forEach((job) => { %>
          <tr id="pool-row-<%= job.id %>">
            <td><img class="thumbnail-preview" src="/api/pool/<%= job.id %>/thumbnail" data-preview-url="<%= job.previewUrl %>" alt="Vorschau" height="60" style="cursor:pointer"></td>
            <td><%= job.dateiname %></td>
            <td><%= job.eingang_am %></td>
            <td><button type="button" class="beanspruchen-btn" data-job-id="<%= job.id %>">Beanspruchen</button></td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  <% } %>

  <h2>Meine offenen Kontierungen</h2>
  <% if (meineKontierungen.length === 0) { %>
    <p>Keine offenen Kontierungen.</p>
  <% } else { %>
    <ul>
      <% meineKontierungen.forEach((job) => { %>
        <li><a href="/kontierung/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
      <% }) %>
    </ul>
  <% } %>

  <h2>Meine Freigaben</h2>
  <% if (meineFreigaben.length === 0) { %>
    <p>Keine offenen Freigaben.</p>
  <% } else { %>
    <ul>
      <% meineFreigaben.forEach((job) => { %>
        <li><a href="/freigabe2/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
      <% }) %>
    </ul>
  <% } %>

  <dialog id="preview-dialog">
    <button type="button" id="preview-dialog-close">Schließen</button>
    <iframe id="preview-frame" src="" style="width:80vw;height:80vh;border:none"></iframe>
  </dialog>

  <script>
    document.querySelectorAll('.beanspruchen-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.jobId;
        const res = await fetch(`/api/pool/${id}/beanspruchen`, { method: 'POST' });
        if (res.ok) {
          window.location.href = `/kontierung/${id}`;
          return;
        }
        const body = await res.json().catch(() => ({}));
        const row = document.getElementById(`pool-row-${id}`);
        if (row) {
          const msg = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 4;
          cell.textContent = body.error || 'Job ist nicht mehr verfügbar.';
          msg.appendChild(cell);
          row.replaceWith(msg);
        }
      });
    });

    document.querySelectorAll('.thumbnail-preview').forEach((img) => {
      img.addEventListener('click', () => {
        document.getElementById('preview-frame').src = img.dataset.previewUrl;
        document.getElementById('preview-dialog').showModal();
      });
    });
    document.getElementById('preview-dialog-close').addEventListener('click', () => {
      document.getElementById('preview-dialog').close();
      document.getElementById('preview-frame').src = '';
    });
  </script>
</body>
</html>
```

- [ ] **Step 5: Create `src/routes/poolPage.js`**

```js
import { Router } from 'express';
import { listPoolJobs, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson } from '../db/jobsRepo.js';
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
    });
  });

  return router;
}
```

- [ ] **Step 6: Modify `src/app.js`**

Add the import near the other route imports:

```js
import { createPoolPageRouter } from './routes/poolPage.js';
```

Add the mount line near the other `/api/pool` mount:

```js
app.use('/pool', requireRole(config, 'buchhaltung'), createPoolPageRouter({ db, config }));
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS (5 tests)

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/routes/poolPage.js views/pool.ejs src/services/downloadUrl.js src/app.js test/integration/poolPage.test.js
git commit -m "feat: Pool-Übersicht page with Meine-Aufgaben sections and thumbnail preview"
```

---

### Task 4: Kontierung + Freigabe 1 (`GET/POST /kontierung/:id`, `POST /kontierung/:id/zurueck-in-pool`)

**Files:**
- Create: `src/routes/kontierung.js`
- Create: `views/kontierung.ejs`
- Modify: `src/app.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `getJobById`, `setKontierung`, `eskalierenFreigabe1`, `abschliessenFreigabe1`,
  `releaseJob` (Task 1, `src/db/jobsRepo.js`), `listKontenForPerson` (Task 1,
  `src/db/kontenRepo.js`), `createFreigabe` (Task 1, `src/db/freigabenRepo.js`),
  `buildSignedDownloadUrl`, `PDF_PREVIEW_TTL_SECONDS` (Task 3, `src/services/downloadUrl.js`).
- Produces: `createKontierungRouter({ db, config })` → Router with `GET /:id`, `POST /:id`,
  `POST /:id/zurueck-in-pool`. Not consumed by any later task directly.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/kontierung.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob, getJobById } from '../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createKontierungRouter } from '../../src/routes/kontierung.js';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config }));
  return app;
}

function seedKontoAndPersonen(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('GET /kontierung/:id returns 403 for a person the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /kontierung/:id returns 403 once the job has left status zugewiesen', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, id);
  const app = buildTestApp(db);
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /kontierung/:id shows only the assigned person\'s own Konten', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /3000/);
  db.close();
});

test('GET /kontierung/:id shows an empty Konto dropdown for a pool-claim by someone with no Konten of their own, and they can release it back to the pool', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db); // Konto 3000 belongs to persons '1'/'2'/'3'/'4' only
  upsertPerson(db, { id: '5', vorname: 'Ohne', nachname: 'Konto', email: 'p5@example.org', gruppen: ['10'], loggedInNow: true });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '5');
  const app = buildTestApp(db);

  const getRes = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '5');
  assert.equal(getRes.status, 200);
  assert.doesNotMatch(getRes.text, /3000/, 'person 5 has no role on Konto 3000, so it must not appear in their dropdown');

  const releaseRes = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '5');
  assert.equal(releaseRes.status, 302);
  assert.equal(releaseRes.headers.location, '/pool');
  assert.equal(getJobById(db, id).status, 'unzugewiesen');
  db.close();
});

test('POST /kontierung/:id without a conflict creates the Freigabe-1 row and advances status to freigabe2', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.konto_id, kontoId);
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.length, 1);
  assert.equal(freigaben[0].rolle, 'freigeber1');
  assert.equal(freigaben[0].person_id, '1');
  assert.equal(freigaben[0].interessenskonflikt, 0);
  db.close();
});

test('POST /kontierung/:id with a conflict reassigns to stellvertreter1, creates no Freigabe row', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  assert.equal(job.zugewiesen_an, '2');
  assert.equal(job.freigabe1_eskaliert_von, '1');
  assert.equal(job.freigabe1_eskalationsgrund, 'Befangen');
  assert.equal(listFreigabenByJob(db, id).length, 0);
  db.close();
});

test('POST /kontierung/:id with a conflict but no Begründung is rejected, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, null);
  db.close();
});

test('POST /kontierung/:id with a Konto the person has no role on is rejected, nothing persisted', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const anderesKontoId = createKonto(db, { kontonummer: '9999', bezeichnung: 'Fremd', freigeber1Id: '3', stellvertreter1Id: '4', freigeber2Id: '1', stellvertreter2Id: '2' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(anderesKontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  assert.equal(getJobById(db, id).konto_id, null);
  db.close();
});

test('POST /kontierung/:id/zurueck-in-pool releases the job and redirects to /pool', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  db.close();
});

test('POST /kontierung/:id/zurueck-in-pool returns 403 for a person the job is not assigned to', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db);

  const res = await request(app).post(`/kontierung/${id}/zurueck-in-pool`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  assert.equal(getJobById(db, id).status, 'zugewiesen');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — `src/routes/kontierung.js` and the view don't exist yet.

- [ ] **Step 3: Create `views/kontierung.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Kontierung — Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <h1>Kontierung: <%= job.dateiname %></h1>

  <iframe src="<%= previewUrl %>" style="width:100%;height:60vh;border:1px solid #ccc"></iframe>

  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>

  <form method="post" action="/kontierung/<%= job.id %>">
    <label>Konto
      <select name="kontoId" required>
        <option value="">— wählen —</option>
        <% konten.forEach((k) => { %>
          <option value="<%= k.id %>" <%= String(k.id) === values.kontoId ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
        <% }) %>
      </select>
    </label><br>

    <label><input type="radio" name="interessenskonflikt" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>> Kein Interessenskonflikt</label><br>
    <label><input type="radio" name="interessenskonflikt" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>> Interessenskonflikt</label><br>
    <label>Begründung <textarea name="begruendung"><%= values.begruendung || '' %></textarea></label><br>

    <button type="submit">Kontieren und Freigabe 1 erteilen</button>
  </form>

  <form method="post" action="/kontierung/<%= job.id %>/zurueck-in-pool">
    <button type="submit">Zurück in den Pool legen</button>
  </form>
</body>
</html>
```

- [ ] **Step 4: Create `src/routes/kontierung.js`**

```js
import { Router } from 'express';
import { getJobById, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, releaseJob } from '../db/jobsRepo.js';
import { listKontenForPerson } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createKontierungRouter({ db, config }) {
  const router = Router();

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.zugewiesen_an !== req.currentPerson.churchtools_person_id || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    res.render('kontierung', {
      job,
      konten,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      values: { kontoId: job.konto_id ? String(job.konto_id) : '', interessenskonflikt: '', begruendung: '' },
      errors: [],
    });
  });

  router.post('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const konten = listKontenForPerson(db, req.currentPerson.churchtools_person_id);
    const { kontoId, interessenskonflikt, begruendung } = req.body;
    const errors = [];

    const konto = konten.find((k) => String(k.id) === kontoId);
    if (!konto) {
      errors.push('Bitte ein gültiges Konto aus der Liste auswählen.');
    }
    const hatKonflikt = interessenskonflikt === 'ja';
    if (hatKonflikt && !begruendung) {
      errors.push('Bei einem Interessenskonflikt ist eine Begründung Pflicht.');
    }

    if (errors.length > 0) {
      return res.status(400).render('kontierung', {
        job,
        konten,
        previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
        values: { kontoId, interessenskonflikt, begruendung },
        errors,
      });
    }

    db.exec('BEGIN');
    try {
      setKontierung(db, job.id, konto.id);
      if (hatKonflikt) {
        eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
      } else {
        createFreigabe(db, {
          jobId: job.id,
          personId: req.currentPerson.churchtools_person_id,
          rolle: 'freigeber1',
          zeitpunkt: new Date().toISOString(),
          ip: req.ip,
          interessenskonflikt: false,
          kommentar: null,
          eskaliertVon: job.freigabe1_eskaliert_von,
        });
        abschliessenFreigabe1(db, job.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.redirect('/pool');
  });

  router.post('/:id/zurueck-in-pool', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    releaseJob(db, job.id, req.currentPerson.churchtools_person_id);
    res.redirect('/pool');
  });

  return router;
}
```

- [ ] **Step 5: Modify `src/app.js`**

Add the import:

```js
import { createKontierungRouter } from './routes/kontierung.js';
```

Add the mount line:

```js
app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS (10 tests)

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/routes/kontierung.js views/kontierung.ejs src/app.js test/integration/kontierung.test.js
git commit -m "feat: Kontierung + Freigabe 1 page, with pool-release escape hatch"
```

---

### Task 5: Freigabe 2 + Abschluss (`GET/POST /freigabe2/:id`)

**Files:**
- Create: `src/routes/freigabe2.js`
- Create: `views/freigabe2.ejs`
- Modify: `src/app.js`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Consumes: `getJobById`, `eskalierenFreigabe2`, `abschliessenFreigabe2`, `getEffectiveFreigeber2Id`
  (Task 1, `src/db/jobsRepo.js`), `getKontoById` (existing, `src/db/kontenRepo.js`),
  `createFreigabe`, `listFreigabenByJob` (Task 1, `src/db/freigabenRepo.js`), `getPersonById`
  (existing, `src/db/personenRepo.js`), `getConfigValue` (existing, `src/db/adminConfigRepo.js`),
  `stampAndFinalize` (D1, `src/services/pdfStamp.js`), `buildSignedDownloadUrl`,
  `PDF_PREVIEW_TTL_SECONDS` (Task 3, `src/services/downloadUrl.js`).
- Produces: `createFreigabe2Router({ db, config })` → Router with `GET /:id`, `POST /:id`. This
  is the last consumer of `stampAndFinalize` in D2.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/freigabe2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, setKontierung, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import * as mupdf from 'mupdf';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret' };
  app.use(loadCurrentPerson(db));
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
  return app;
}

async function seedFreigabe2Job(db, { pdfPfad }) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(id);
  return { id, kontoId };
}

test('GET /freigabe2/:id returns 403 for the wrong person even with the buchhaltung role', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /freigabe2/:id returns 403 when the job is not in status freigabe2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen' WHERE id = ?").run(id);
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /freigabe2/:id shows the Kontierung summary to the correct freigeber2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  assert.match(res.text, /3000/);
  assert.match(res.text, /Person1/);
  db.close();
});

test('POST /freigabe2/:id without conflict approves, stamps the PDF and completes the job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgeschlossen');
  const freigaben = listFreigabenByJob(db, id);
  assert.equal(freigaben.length, 2);
  assert.equal(freigaben[1].rolle, 'freigeber2');
  assert.equal(freigaben[1].person_id, '3');

  const { readFileSync } = await import('node:fs');
  const stampedBytes = readFileSync(pdfPfad);
  const mdoc = mupdf.Document.openDocument(stampedBytes, 'application/pdf');
  const lastPageText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(lastPageText, /Person1/);
  assert.match(lastPageText, /Person3/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with a conflict reassigns to stellvertreter2, creates no Freigabe-2 row', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_von, '3');
  assert.equal(job.freigabe2_eskalationsgrund, 'Befangen');
  assert.equal(listFreigabenByJob(db, id).length, 1);

  const followUp = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(followUp.status, 403);
  const nowAllowed = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '4');
  assert.equal(nowAllowed.status, 200);

  db.close();
});

test('POST /freigabe2/:id with an unstampable PDF leaves the job in freigabe2, creates no row', async () => {
  const { mkdtempSync, rmSync, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-fail-test-'));
  const pdfPfad = join(dir, 'kaputt.pdf');
  write(pdfPfad, Buffer.alloc(0));
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const app = buildTestApp(db);

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 400);
  const job = getJobById(db, id);
  assert.equal(job.status, 'freigabe2');
  assert.equal(listFreigabenByJob(db, id).length, 1);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — `src/routes/freigabe2.js` and the view don't exist yet.

- [ ] **Step 3: Create `views/freigabe2.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Freigabe 2 — Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <div style="display:flex;gap:1em">
    <div style="flex:1;overflow:auto">
      <iframe src="<%= previewUrl %>" style="width:100%;height:85vh;border:1px solid #ccc"></iframe>
    </div>
    <div style="width:320px;flex-shrink:0">
      <h1>Freigabe 2</h1>
      <p><strong>Konto:</strong> <%= konto.kontonummer %> — <%= konto.bezeichnung %></p>
      <p><strong>Freigeber 1:</strong> <%= freigeber1Person.vorname %> <%= freigeber1Person.nachname %></p>
      <p><strong>Interessenskonflikt Freigeber 1:</strong> <%= freigabe1.interessenskonflikt ? 'Ja' : 'Nein' %></p>
      <% if (freigabe1.kommentar) { %><p><strong>Begründung:</strong> <%= freigabe1.kommentar %></p><% } %>

      <% if (errors.length > 0) { %>
        <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      <% } %>

      <form method="post" action="/freigabe2/<%= job.id %>">
        <label><input type="radio" name="interessenskonflikt" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>> Kein Interessenskonflikt</label><br>
        <label><input type="radio" name="interessenskonflikt" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>> Interessenskonflikt</label><br>
        <label>Begründung <textarea name="begruendung"><%= values.begruendung || '' %></textarea></label><br>
        <button type="submit">Freigeben</button>
      </form>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 4: Create `src/routes/freigabe2.js`**

```js
import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { getJobById, eskalierenFreigabe2, abschliessenFreigabe2, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';

export function createFreigabe2Router({ db, config }) {
  const router = Router();

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'freigabe2') {
      res.status(403).render('error', { message: 'Für diesen Job ist aktuell keine Freigabe 2 möglich.' });
      return null;
    }
    const konto = getKontoById(db, job.konto_id);
    if (!konto || getEffectiveFreigeber2Id(job, konto) !== req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', { message: 'Du bist für die Freigabe 2 dieses Jobs nicht zuständig.' });
      return null;
    }
    return { job, konto };
  }

  function renderForm(req, res, status, { job, konto }, values, errors) {
    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.find((f) => f.rolle === 'freigeber1');
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

  router.get('/:id', (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    renderForm(req, res, 200, result, { interessenskonflikt: '', begruendung: '' }, []);
  });

  router.post('/:id', async (req, res) => {
    const result = loadAuthorized(req, res);
    if (!result) return;
    const { job, konto } = result;
    const { interessenskonflikt, begruendung } = req.body;
    const hatKonflikt = interessenskonflikt === 'ja';

    if (hatKonflikt && !begruendung) {
      return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einem Interessenskonflikt ist eine Begründung Pflicht.']);
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

    const freigaben = listFreigabenByJob(db, job.id);
    const freigabe1 = freigaben.find((f) => f.rolle === 'freigeber1');
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
    };

    let stamped;
    try {
      const pdfBuffer = readFileSync(job.pdf_pfad);
      const position = getConfigValue(db, 'visum_seite_position') || 'letzte';
      stamped = await stampAndFinalize(pdfBuffer, stampData, position);
    } catch (err) {
      return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [err.message]);
    }

    const tmpPfad = `${job.pdf_pfad}.tmp`;
    writeFileSync(tmpPfad, stamped);
    renameSync(tmpPfad, job.pdf_pfad);

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
      abschliessenFreigabe2(db, job.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.redirect('/pool');
  });

  return router;
}
```

- [ ] **Step 5: Modify `src/app.js`**

Add the import:

```js
import { createFreigabe2Router } from './routes/freigabe2.js';
```

Add the mount line:

```js
app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS (6 tests)

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/routes/freigabe2.js views/freigabe2.ejs src/app.js test/integration/freigabe2.test.js
git commit -m "feat: Freigabe-2 split view, wires stampAndFinalize on completion"
```

---

### Task 6: Ende-zu-Ende-Test über den gesamten Workflow

**Files:**
- Test: `test/integration/freigabeWorkflowEndToEnd.test.js`

**Interfaces:**
- Consumes: `createApp` (Phase A, `src/app.js`) — the real, fully-wired application object
  graph, not a hand-built test app. No new production code in this task.
- Produces: nothing — this is the composition proof for the whole sub-phase.

This task exists because D1's own final whole-branch review found real defects only visible
once two already-reviewed-clean pieces were run together (a stamping function that worked in
isolation broke on data a different task had already proven acceptable). D2 touches far more
surface (five new routes, a repo, a schema change) than D1 did, so this test builds that
composition proof in directly rather than leaving it to be discovered at final review.

This test authenticates against the *real* `/auth/login` + `/auth/callback` flow (Phase A),
exactly like `test/integration/auth.test.js` does, using the same `setupMockChurchTools` /
`undici` `MockAgent` technique — not a second, hand-rolled session-injection mechanism. Each
`loginAs(...)` call below registers its own four mocked ChurchTools responses
(`/api/oauth/token`, `/api/whoami`, `/api/groups/10/members`, `/api/groups/20/members`) and
fully consumes them within that same call (login is awaited to completion before the next
`loginAs` call registers its own), so there is no cross-person interleaving to reason about.

- [ ] **Step 1: Write the failing test**

Create `test/integration/freigabeWorkflowEndToEnd.test.js`:

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

// Logs a person in through the real /auth/login + /auth/callback flow, mocking exactly the
// ChurchTools calls that flow makes (see src/routes/auth.js + src/services/churchtools.js).
// Registers and fully consumes its four mocked responses before returning, so sequential calls
// for different people never race over the same intercepted path.
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

test('Pool → Beanspruchen → Kontierung → Freigabe 2 completes the job with a stamped, downloadable PDF', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;
  assert.equal(createRes.body.status, 'unzugewiesen');

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const claimRes = await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  assert.equal(claimRes.status, 200);

  const kontierungRes = await freigeber1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(kontierungRes.status, 302);

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigabe2Res = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigabe2Res.status, 302);

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.status, 200);
  assert.equal(abholbereitRes.body.length, 1);
  assert.equal(abholbereitRes.body[0].id, jobId);

  const downloadRes = await request(app).get(abholbereitRes.body[0].download_url);
  assert.equal(downloadRes.status, 200);
  const mdoc = mupdf.Document.openDocument(downloadRes.body, 'application/pdf');
  const lastPageText = mdoc.loadPage(mdoc.countPages() - 1).toStructuredText().asText();
  assert.match(lastPageText, /Eins/);
  assert.match(lastPageText, /Zwei/);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/freigabeWorkflowEndToEnd.test.js`
Expected: FAIL — either at the `claimRes` assertion (if any earlier step in the chain has a
wiring gap) or at a later assertion. Read the actual failure carefully: this test exercises six
already-individually-tested pieces (Phase C job creation, Phase A login, Task 2/3 pool claim,
Task 4 Kontierung, Task 5 Freigabe 2, Phase C pickup + download) composed together for the first
time — a failure here is exactly the kind of cross-task gap a single task's own tests cannot
see, so don't assume it's a typo in this test file without checking the actual response body/
status first.

- [ ] **Step 3: Fix whatever the failure reveals, or confirm the test passes as-is**

If the test fails because of an actual defect in Task 1–5's code (not a mistake in this test
file), fix it in the relevant file from that task and note in the commit message which task's
code the fix touched. If it fails because of a mistake in this test file itself (wrong field
name, wrong status code expectation), fix the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/integration/freigabeWorkflowEndToEnd.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add test/integration/freigabeWorkflowEndToEnd.test.js
git commit -m "test: end-to-end Freigabe-Workflow proof against the real app"
```
