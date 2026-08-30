# Kombinierter Bexio-Export für Splitgruppen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aufgesplittete Rechnungen (mehrere Konten) als ein einziges, gemeinsam gestempeltes und zeitgestempeltes PDF an n8n/Bexio übergeben, statt wie heute als N separate Einzel-Exporte — inklusive eines neuen Freitextfelds "Position auf der Rechnung" je Splitzeile.

**Architecture:** Eine neue Vollständigkeitsprüfung läuft automatisch nach jedem Freigabe-2-Abschluss eines Splitkindes (und nach dem Löschen einer blockierenden abgelehnten Zeile); sind alle Geschwister eines Elternjobs `abgeschlossen`, merged eine neue Orchestrierungsfunktion die Original-Rechnungsseiten des Elternjobs mit den Beleg-Seiten aller Kinder, stempelt eine kombinierte Konten/Freigaben/Verlauf-Seite drauf, setzt einen frischen RFC3161-Zeitstempel, und hinterlegt das Ergebnis auf dem Elternjob. `/n8n/jobs/abholbereit` bietet Splitkinder danach nicht mehr einzeln an, sondern liefert stattdessen einen Gruppen-Eintrag mit allen Positionen; `/abholung-bestaetigen` räumt bei Bestätigung die ganze Gruppe auf.

**Tech Stack:** Node.js/Express, `node:sqlite` (`DatabaseSync`), `pdf-lib` für PDF-Merge/Stempel, `pdf-rfc3161` für RFC3161-Zeitstempel, EJS-Views, `node:test` + `node:assert/strict` + `supertest` für Tests.

**Spec:** [docs/superpowers/specs/2026-08-29-splitgruppen-bexio-export-design.md](../specs/2026-08-29-splitgruppen-bexio-export-design.md)

## Global Constraints

- Testframework ist Node's eingebauter `node:test`-Runner mit `node:assert/strict` — kein mocha/jest. Test-Kommando für eine einzelne Datei: `node --test test/pfad/datei.test.js`. Volle Suite: `npm test`.
- Alle neuen Bezeichner, UI-Texte und Fehlermeldungen sind Deutsch, exakt im bestehenden Stil des Codebases (siehe z.B. `pdfStamp.js`, `freigabe2.js`).
- SQLite-Schemaänderungen brauchen **immer zwei** Stellen: `src/db/schema.sql` (frische DB) UND eine idempotente Migration in `src/db/index.js` (bestehende DB) — reines Hinzufügen von `schema.sql` reicht nicht, da `CREATE TABLE IF NOT EXISTS` auf einer bereits existierenden Tabelle no-opt.
- Ein SQLite-`CHECK`-Constraint kann nicht per `ALTER TABLE` erweitert werden — jede Erweiterung einer `CHECK(... IN (...))`-Liste (hier: `cron_log.job`) braucht das bestehende Rename→Recreate→Copy→Drop-Migrationsmuster aus `migrateCronLogTable` (`src/db/index.js:184-211`).
- PDF-Manipulation ausschliesslich über `pdf-lib` (bereits Projektabhängigkeit), keine neue Abhängigkeit.
- Fehlerbehandlung folgt dem bestehenden Best-effort-Muster: sekundäre/asynchrone Schritte (Merge, Zeitstempel) loggen per `console.error` und lassen den primären Request-Flow unverändert durchlaufen; nichts darf einen laufenden Freigabe-2-Abschluss oder eine Löschung zum Scheitern bringen.
- Datei-Schreibvorgänge auf bereits produktiv genutzte Pfade laufen immer über das Muster Tempdatei schreiben → `renameSync` (atomarer Swap), nie direktes Überschreiben.

---

## Task 1: Datenbank-Schema — neue Spalten und CHECK-Erweiterung

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Produces: vier neue Spalten auf `jobs` (`rechnungsposition TEXT`, `gruppe_pdf_pfad TEXT`, `gruppe_zeitstempel_gesetzt_am TEXT`, `gruppe_zeitstempel_datei_hash TEXT`), zwei neue Manipulationsschutz-Trigger (`trg_gruppe_zeitstempel_hash_unveraenderlich`, `trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich`), erweiterten `cron_log.job`-CHECK inkl. `'split-gruppen-nachholen'`. Alle nachfolgenden Tasks bauen auf diesen Spalten auf.

- [ ] **Step 1: Write the failing test**

In `test/unit/jobsRepo.test.js`, am Ende der Datei anfügen:

```js
test('jobs table has the new Splitgruppen columns and immutability triggers on the gruppe_zeitstempel_* pair', () => {
  const db = openDatabase(':memory:');
  const spalten = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  assert.ok(spalten.has('rechnungsposition'));
  assert.ok(spalten.has('gruppe_pdf_pfad'));
  assert.ok(spalten.has('gruppe_zeitstempel_gesetzt_am'));
  assert.ok(spalten.has('gruppe_zeitstempel_datei_hash'));

  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET gruppe_zeitstempel_gesetzt_am = '2026-08-01T00:00:00.000Z', gruppe_zeitstempel_datei_hash = 'abc' WHERE id = ?").run(id);

  assert.throws(
    () => db.prepare("UPDATE jobs SET gruppe_zeitstempel_datei_hash = 'anders' WHERE id = ?").run(id),
    /unveraenderlich/
  );
  assert.throws(
    () => db.prepare("UPDATE jobs SET gruppe_zeitstempel_gesetzt_am = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(id),
    /unveraenderlich/
  );
  db.close();
});

test('cron_log accepts split-gruppen-nachholen as a valid job name', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO cron_log (job, gestartet_am, status) VALUES ('split-gruppen-nachholen', '2026-08-01T00:00:00.000Z', 'laufend')").run();
  const row = db.prepare("SELECT * FROM cron_log WHERE job = 'split-gruppen-nachholen'").get();
  assert.ok(row);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `rechnungsposition`/`gruppe_pdf_pfad` columns don't exist yet, and the `cron_log` INSERT fails the CHECK constraint.

- [ ] **Step 3: Update `schema.sql`**

In `src/db/schema.sql`, extend the `jobs` table's column list (right after `qr_erkannt_am TEXT`):

```sql
  qr_erkannt_am TEXT,
  rechnungsposition TEXT,
  gruppe_pdf_pfad TEXT,
  gruppe_zeitstempel_gesetzt_am TEXT,
  gruppe_zeitstempel_datei_hash TEXT
);
```

Directly after the two existing `trg_zeitstempel_*_unveraenderlich` triggers (after line 161's `END;`), add:

```sql
CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_hash_unveraenderlich
BEFORE UPDATE OF gruppe_zeitstempel_datei_hash ON jobs
WHEN OLD.gruppe_zeitstempel_datei_hash IS NOT NULL
  AND NEW.gruppe_zeitstempel_datei_hash IS NOT NULL
  AND NEW.gruppe_zeitstempel_datei_hash <> OLD.gruppe_zeitstempel_datei_hash
BEGIN
  SELECT RAISE(ABORT, 'gruppe_zeitstempel_datei_hash ist unveraenderlich, sobald gesetzt');
END;

CREATE TRIGGER IF NOT EXISTS trg_gruppe_zeitstempel_gesetzt_am_unveraenderlich
BEFORE UPDATE OF gruppe_zeitstempel_gesetzt_am ON jobs
WHEN OLD.gruppe_zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.gruppe_zeitstempel_gesetzt_am IS NOT NULL
  AND NEW.gruppe_zeitstempel_gesetzt_am <> OLD.gruppe_zeitstempel_gesetzt_am
BEGIN
  SELECT RAISE(ABORT, 'gruppe_zeitstempel_gesetzt_am ist unveraenderlich, sobald gesetzt');
END;
```

In the `cron_log` `CREATE TABLE` (schema.sql, the `job TEXT NOT NULL CHECK(...)` line), widen the list:

```sql
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
```

- [ ] **Step 4: Update `src/db/index.js` migrations**

In `JOBS_TABLE_MIGRATIONS` (after the `typ` entry), add:

```js
  { column: 'rechnungsposition', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsposition TEXT' },
  { column: 'gruppe_pdf_pfad', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_pdf_pfad TEXT' },
  { column: 'gruppe_zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_gesetzt_am TEXT' },
  { column: 'gruppe_zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_datei_hash TEXT' },
```

In `migrateJobsTable`, right after the two existing `db.exec(...)` calls that create `trg_zeitstempel_hash_unveraenderlich`/`trg_zeitstempel_gesetzt_am_unveraenderlich`, add the two new triggers (same SQL as Step 3's new triggers, wrapped in `db.exec(\`...\`)` the same way as the existing pair).

Add a new migration function mirroring `migrateCronLogTable`, right after it:

```js
// Same rationale/pattern as migrateCronLogTable above, one more CHECK widening for the new
// 'split-gruppen-nachholen' cron job. Marker value moves forward again the next time this CHECK
// needs widening -- check the CREATE TABLE below for what it currently allows, not this comment.
function migrateCronLogTableSplitGruppen(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('split-gruppen-nachholen')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_split_gruppen_nachholen');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_split_gruppen_nachholen
    `);
    db.exec('DROP TABLE cron_log_pre_split_gruppen_nachholen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

In `openDatabase`, add the call after `migrateCronLogTable(db);`:

```js
  migrateCronLogTable(db);
  migrateCronLogTableSplitGruppen(db);
  return db;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/jobsRepo.test.js
git commit -m "feat: add Splitgruppen columns and cron_log job type for combined Bexio export"
```

---

## Task 2: jobsRepo.js — Repo-Funktionen für Splitgruppen

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `listSplitKinder(db, parentJobId)` (bereits vorhanden, `jobsRepo.js:587`), `getJobById(db, id)`.
- Produces: `createSplitJob(db, parentJob, { ..., position })` (erweitert um `position`, persistiert in `rechnungsposition`), `pruefeSplitGruppenVollstaendigkeit(db, parentJobId) → { vollstaendig: boolean, blockiert: boolean, kinder: Job[] }`, `markGruppeExportiert(db, parentJobId, { pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash })`, `listAbholbereitGruppen(db, staleAfterMs?, nurMitZeitstempel?) → Job[]`, `istGruppenElternjob(db, id) → boolean`, `confirmGruppenAbholung(db, parentJobId, nurMitZeitstempel?) → { parent, kinder } | null`, `listSplitGruppenAusstehend(db) → Job[]`. `listAbholbereitJobs` gibt Splitkinder ab sofort nicht mehr zurück.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/jobsRepo.test.js`:

```js
test('createSplitJob persists an optional position (rechnungsposition) on the split child', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  const parentJob = getJobById(db, parentId);

  const kindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/b.pdf', kontoId, betrag: '10.00', zugewiesenAn: '1', position: 'Pos. 2' });
  assert.equal(getJobById(db, kindId).rechnungsposition, 'Pos. 2');

  const kindOhnePosition = createSplitJob(db, parentJob, { pdfPfad: '/tmp/c.pdf', kontoId, betrag: '5.00', zugewiesenAn: '1' });
  assert.equal(getJobById(db, kindOhnePosition).rechnungsposition, null);
  db.close();
});

function abschliesseKind(db, kindId) {
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kindId);
}

test('pruefeSplitGruppenVollstaendigkeit reports unvollstaendig while a sibling is still open, vollstaendig once all are abgeschlossen, and blockiert on a rejected sibling', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  const parentJob = getJobById(db, parentId);
  const kind1 = createSplitJob(db, parentJob, { pdfPfad: '/tmp/b.pdf', kontoId, betrag: '10.00', zugewiesenAn: '1' });
  const kind2 = createSplitJob(db, parentJob, { pdfPfad: '/tmp/c.pdf', kontoId, betrag: '5.00', zugewiesenAn: '1' });

  assert.equal(pruefeSplitGruppenVollstaendigkeit(db, parentId).vollstaendig, false);

  abschliesseKind(db, kind1);
  assert.equal(pruefeSplitGruppenVollstaendigkeit(db, parentId).vollstaendig, false);

  abschliesseKind(db, kind2);
  const vollstaendig = pruefeSplitGruppenVollstaendigkeit(db, parentId);
  assert.equal(vollstaendig.vollstaendig, true);
  assert.equal(vollstaendig.blockiert, false);
  assert.equal(vollstaendig.kinder.length, 2);

  db.prepare("UPDATE jobs SET status = 'abgelehnt' WHERE id = ?").run(kind2);
  const blockiert = pruefeSplitGruppenVollstaendigkeit(db, parentId);
  assert.equal(blockiert.vollstaendig, false);
  assert.equal(blockiert.blockiert, true);

  db.prepare("UPDATE jobs SET status = 'geloescht' WHERE id = ?").run(kind2);
  const nachLoeschung = pruefeSplitGruppenVollstaendigkeit(db, parentId);
  assert.equal(nachLoeschung.blockiert, false);
  assert.equal(nachLoeschung.vollstaendig, true);
  assert.equal(nachLoeschung.kinder.length, 1);
  db.close();
});

test('pruefeSplitGruppenVollstaendigkeit blocks completeness while a sibling is still an unclaimed hinweis_konto_id-only row (fremdes Konto, not yet via Kontierung geclaimt)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  const parentJob = getJobById(db, parentId);
  const kind1 = createSplitJob(db, parentJob, { pdfPfad: '/tmp/b.pdf', kontoId, betrag: '10.00', zugewiesenAn: '1' });
  const hinweisKindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/c.pdf', hinweisKontoId: kontoId, betrag: '10.00' });
  abschliesseKind(db, kind1);

  // The hinweis-only sibling is still 'unzugewiesen' -- not yet claimed via Kontierung by its
  // actual Freigeber 1 -- so the group must NOT be considered complete yet.
  const nochOffen = pruefeSplitGruppenVollstaendigkeit(db, parentId);
  assert.equal(nochOffen.vollstaendig, false);
  assert.equal(nochOffen.kinder.length, 2, 'the unclaimed row still counts toward the group, it just is not abgeschlossen yet');

  // Once it's claimed (konto_id set) and driven through to abgeschlossen like any normal job,
  // the group becomes complete.
  db.prepare("UPDATE jobs SET konto_id = ?, status = 'abgeschlossen' WHERE id = ?").run(kontoId, hinweisKindId);
  const vollstaendig = pruefeSplitGruppenVollstaendigkeit(db, parentId);
  assert.equal(vollstaendig.vollstaendig, true);
  assert.equal(vollstaendig.kinder.length, 2);
  db.close();
});

test('markGruppeExportiert persists the merged file path and Zeitstempel fields on the parent job', () => {
  const db = openDatabase(':memory:');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: '2026-08-01T01:00:00.000Z', zeitstempelDateiHash: 'deadbeef' });
  const job = getJobById(db, parentId);
  assert.equal(job.gruppe_pdf_pfad, '/tmp/gruppe.pdf');
  assert.equal(job.gruppe_zeitstempel_gesetzt_am, '2026-08-01T01:00:00.000Z');
  assert.equal(job.gruppe_zeitstempel_datei_hash, 'deadbeef');
  db.close();
});

test('listAbholbereitJobs no longer returns Splitkinder even once abgeschlossen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  const parentJob = getJobById(db, parentId);
  const kindId = createSplitJob(db, parentJob, { pdfPfad: '/tmp/b.pdf', kontoId, betrag: '10.00', zugewiesenAn: '1' });
  abschliesseKind(db, kindId);

  const normalerJobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'n.pdf', pdfPfad: '/tmp/n.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(normalerJobId);

  const abholbereit = listAbholbereitJobs(db);
  assert.deepEqual(abholbereit.map((j) => j.id), [normalerJobId]);
  db.close();
});

test('listAbholbereitGruppen returns only parent jobs with a set gruppe_pdf_pfad, and marks them fetched', () => {
  const db = openDatabase(':memory:');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ?").run(parentId);

  assert.equal(listAbholbereitGruppen(db).length, 0);

  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: null, zeitstempelDateiHash: null });
  const gruppen = listAbholbereitGruppen(db);
  assert.equal(gruppen.length, 1);
  assert.equal(gruppen[0].id, parentId);
  assert.ok(gruppen[0].fetched_by_n8n_at);

  const nurMitZeitstempel = listAbholbereitGruppen(db, 15 * 60 * 1000, true);
  assert.equal(nurMitZeitstempel.length, 0, 'group has no Zeitstempel yet, must be excluded when nurMitZeitstempel is required');
  db.close();
});

test('istGruppenElternjob is true only for a job with a set gruppe_pdf_pfad', () => {
  const db = openDatabase(':memory:');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(istGruppenElternjob(db, parentId), false);
  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: null, zeitstempelDateiHash: null });
  assert.equal(istGruppenElternjob(db, parentId), true);
  db.close();
});

test('confirmGruppenAbholung sets every abgeschlossen child to abgeholt and returns parent+kinder, no-ops for a non-group job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  const parentJob = getJobById(db, parentId);
  const kind1 = createSplitJob(db, parentJob, { pdfPfad: '/tmp/b.pdf', kontoId, betrag: '10.00', zugewiesenAn: '1' });
  const kind2 = createSplitJob(db, parentJob, { pdfPfad: '/tmp/c.pdf', kontoId, betrag: '5.00', zugewiesenAn: '1' });
  abschliesseKind(db, kind1);
  abschliesseKind(db, kind2);
  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: '2026-08-01T02:00:00.000Z', zeitstempelDateiHash: 'abc' });

  const einzelnerJobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'n.pdf', pdfPfad: '/tmp/n.pdf' });
  assert.equal(confirmGruppenAbholung(db, einzelnerJobId), null);

  const ergebnis = confirmGruppenAbholung(db, parentId);
  assert.equal(ergebnis.parent.id, parentId);
  assert.deepEqual(ergebnis.kinder.map((k) => k.id).sort(), [kind1, kind2].sort());
  assert.equal(getJobById(db, kind1).status, 'abgeholt');
  assert.equal(getJobById(db, kind2).status, 'abgeholt');
  db.close();
});

test('confirmGruppenAbholung refuses when nurMitZeitstempel is required but the group has no Zeitstempel', () => {
  const db = openDatabase(':memory:');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: null, zeitstempelDateiHash: null });
  assert.equal(confirmGruppenAbholung(db, parentId, true), null);
  assert.ok(confirmGruppenAbholung(db, parentId, false));
  db.close();
});

test('listSplitGruppenAusstehend returns aufgesplittet parents without a merged PDF yet', () => {
  const db = openDatabase(':memory:');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'aufgesplittet' WHERE id = ?").run(parentId);
  assert.deepEqual(listSplitGruppenAusstehend(db).map((j) => j.id), [parentId]);

  markGruppeExportiert(db, parentId, { pdfPfad: '/tmp/gruppe.pdf', zeitstempelGesetztAm: null, zeitstempelDateiHash: null });
  assert.deepEqual(listSplitGruppenAusstehend(db), []);
  db.close();
});
```

Add the new names (`pruefeSplitGruppenVollstaendigkeit`, `markGruppeExportiert`, `listAbholbereitGruppen`, `istGruppenElternjob`, `confirmGruppenAbholung`, `listSplitGruppenAusstehend`) to the file's existing top-of-file destructured import from `'../../src/db/jobsRepo.js'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — none of the new exports exist yet, `createSplitJob` doesn't accept `position`.

- [ ] **Step 3: Implement in `src/db/jobsRepo.js`**

Modify `createSplitJob`'s signature and INSERT (around line 557):

```js
export function createSplitJob(db, parentJob, { pdfPfad, thumbnailPfad, kontoId, hinweisKontoId, betrag, zugewiesenAn, position }) {
  const status = kontoId ? 'zugewiesen' : 'unzugewiesen';
  const result = db
    .prepare(
      `INSERT INTO jobs (
         eingang_am, quelle, absender, dateiname, pdf_pfad, thumbnail_pfad, status,
         konto_id, zugewiesen_an, hinweis_konto_id, betrag, zahlungsziel, rechnungsnummer, lieferant, debitor_id, aufgesplittet_von, rechnungsposition
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      parentJob.eingang_am,
      parentJob.quelle,
      parentJob.absender,
      parentJob.dateiname,
      pdfPfad,
      thumbnailPfad ?? null,
      status,
      kontoId ?? null,
      zugewiesenAn ?? null,
      hinweisKontoId ?? null,
      betrag,
      parentJob.zahlungsziel,
      parentJob.rechnungsnummer,
      parentJob.lieferant,
      parentJob.debitor_id,
      parentJob.id,
      position || null
    );
  return Number(result.lastInsertRowid);
}
```

Modify `listAbholbereitJobs` (line 125) to add `AND aufgesplittet_von IS NULL`:

```js
export function listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000, nurMitZeitstempel = false) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const zeitstempelBedingung = nurMitZeitstempel ? ' AND zeitstempel_gesetzt_am IS NOT NULL' : '';
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgeschlossen' AND aufgesplittet_von IS NULL
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)${zeitstempelBedingung}`
    )
    .all(staleThreshold);

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}
```

Add the new functions right after `listSplitKinder` (end of file area, after line 589):

```js
// Eine per hinweis_konto_id angelegte Zeile (Konto ausserhalb der Freigabe-Befugnis der
// aufsplittenden Person, siehe kontierung.js's istEigenesKonto-Zweig) ist NICHT dauerhaft
// ausgenommen -- sie steht nur vorübergehend 'unzugewiesen', bis die zuständige Person sie über
// die normale Kontierung claimt und sie danach den ganz normalen Weg bis 'abgeschlossen' geht.
// Bis dahin zählt sie ganz normal als "noch offen", genau wie jede andere nicht-abgeschlossene
// Zeile -- nur eine mit status='geloescht' aufgelöste (vormals abgelehnte) Zeile wird ignoriert.
export function pruefeSplitGruppenVollstaendigkeit(db, parentJobId) {
  const kinder = listSplitKinder(db, parentJobId).filter((k) => k.status !== 'geloescht');
  if (kinder.length === 0) return { vollstaendig: false, blockiert: false, kinder: [] };
  const blockiert = kinder.some((k) => k.status === 'abgelehnt');
  const vollstaendig = !blockiert && kinder.every((k) => k.status === 'abgeschlossen');
  return { vollstaendig, blockiert, kinder };
}

export function markGruppeExportiert(db, parentJobId, { pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash }) {
  db.prepare(
    'UPDATE jobs SET gruppe_pdf_pfad = ?, gruppe_zeitstempel_gesetzt_am = ?, gruppe_zeitstempel_datei_hash = ? WHERE id = ?'
  ).run(pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash, parentJobId);
}

// Mirrors listAbholbereitJobs's stale/refetch semantics, scoped to Splitgruppen-Elternjobs
// (status bleibt 'aufgesplittet', nie 'abgeschlossen' -- daher eine eigene Query statt eines
// Filters auf listAbholbereitJobs).
export function listAbholbereitGruppen(db, staleAfterMs = 15 * 60 * 1000, nurMitZeitstempel = false) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const zeitstempelBedingung = nurMitZeitstempel ? ' AND gruppe_zeitstempel_gesetzt_am IS NOT NULL' : '';
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'aufgesplittet' AND gruppe_pdf_pfad IS NOT NULL
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)${zeitstempelBedingung}`
    )
    .all(staleThreshold);

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

export function istGruppenElternjob(db, id) {
  const job = getJobById(db, id);
  return Boolean(job && job.gruppe_pdf_pfad);
}

// Analog zu confirmAbholung, aber für eine ganze Splitgruppe: setzt jedes abgeschlossene Kind auf
// 'abgeholt' und liefert Eltern- und Kind-Datensätze zurück, damit der Aufrufer (n8n-Route) alle
// betroffenen Dateien (Kind-PDFs, Kind-Thumbnails, Gruppen-PDF) von der Platte löschen kann.
export function confirmGruppenAbholung(db, parentJobId, nurMitZeitstempel = false) {
  const parent = getJobById(db, parentJobId);
  if (!parent || !parent.gruppe_pdf_pfad) return null;
  if (nurMitZeitstempel && !parent.gruppe_zeitstempel_gesetzt_am) return null;

  const kinder = listSplitKinder(db, parentJobId).filter((k) => k.status === 'abgeschlossen');
  for (const kind of kinder) {
    db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ? AND status = 'abgeschlossen'").run(kind.id);
  }
  return { parent, kinder };
}

// Arbeitsliste für den split-gruppen-nachholen Cron-Job: Elternjobs, deren Splitgruppe noch nicht
// gemergt wurde (unabhängig davon, ob sie schon vollständig ist -- die Vollständigkeitsprüfung
// passiert im Aufrufer, pruefeUndFinalisiereSplitGruppe).
export function listSplitGruppenAusstehend(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'aufgesplittet' AND gruppe_pdf_pfad IS NULL").all();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add jobsRepo functions for Splitgruppen completeness and combined export"
```

---

## Task 3: Aufsplitten-Formular — Feld "Position auf der Rechnung"

**Files:**
- Modify: `views/kontierung-aufsplitten.ejs`
- Modify: `src/routes/kontierung.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `createSplitJob(db, parentJob, { ..., position })` from Task 2.
- Produces: neues Formularfeld `teilPosition` (Freitext, optional) pro Splitzeile, durchgereicht bis zur DB.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/kontierung.test.js` (folgt den Konventionen bestehender Aufsplitten-Tests in derselben Datei — `openDatabase`, `createApp`/Router-Setup, `request(app).post(...)`, CSRF-Token via `fetchCsrfToken`):

```js
test('POST /kontierung/:id/aufsplitten persists teilPosition as rechnungsposition on each split child', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoMitFreigebern(db, { freigeber1Id: '1', freigeber2Id: '2' }); // use whatever seed helper this file already defines for a fully-authorized Konto
  const { id: jobId } = await seedZugewiesenJob(db, { kontoId }); // use this file's existing seed helper for a job ready to aufsplitten

  const agent = request.agent(buildTestApp(db));
  const csrfToken = await fetchCsrfToken(agent, `/kontierung/${jobId}/aufsplitten`);

  const res = await agent
    .post(`/kontierung/${jobId}/aufsplitten`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({
      _csrf: csrfToken,
      gesamtbetrag: '100.00',
      teilKontoId: [String(kontoId), String(kontoId)],
      teilBetrag: ['60.00', '40.00'],
      teilInteressenskonflikt: ['false', 'false'],
      teilPosition: ['Pos. 1', 'Pos. 2'],
    });

  assert.equal(res.status, 302);
  const kinder = listSplitKinder(db, jobId);
  assert.equal(kinder.length, 2);
  assert.deepEqual(kinder.map((k) => k.rechnungsposition).sort(), ['Pos. 1', 'Pos. 2']);
  db.close();
});
```

Add `listSplitKinder` to this test file's existing `jobsRepo.js` import if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — `rechnungsposition` stays `null` for both children (field not parsed/threaded through yet).

- [ ] **Step 3: Add the field to `views/kontierung-aufsplitten.ejs`**

In the static per-row block (inside `.teil-zeile`, right after the existing `<div class="col-3">...teilBetrag...</div>`), add:

```html
            <div class="col-2">
              <input type="text" class="form-control" name="teilPosition" value="<%= teil.position || '' %>" placeholder="Position, z.B. Pos. 2">
            </div>
```

Reduce the following `Konflikt`-block's column width from `col-2` to `col-1` and the `Entfernen`-button's from `col-2` to `col-1` so the row still totals 12 columns (`col-5` Konto + `col-3` Betrag + `col-2` Position + `col-1` Konflikt + `col-1` Entfernen = 12).

In the same file's `<script>` block, inside the `zeile-hinzufuegen` click handler's template string, add the matching markup right after the `teilBetrag` `<div>` and adjust the `Konflikt`/`Entfernen` `<div>` classes the same way:

```js
          '<div class="col-3"><input type="text" inputmode="decimal" class="form-control" name="teilBetrag" placeholder="Teilbetrag, z.B. 61.75"></div>' +
          '<div class="col-2"><input type="text" class="form-control" name="teilPosition" placeholder="Position, z.B. Pos. 2"></div>' +
          '<div class="col-1 form-check"><input type="checkbox" class="form-check-input konflikt-checkbox"><label class="form-check-label small">Konflikt</label><input type="hidden" name="teilInteressenskonflikt" value="false"></div>' +
          '<div class="col-1"><button type="button" class="btn btn-outline-danger btn-sm zeile-entfernen">Entfernen</button></div>' +
```

- [ ] **Step 4: Parse and thread the field through in `src/routes/kontierung.js`**

Right after the existing `const konflikte = [].concat(req.body.teilInteressenskonflikt || []);` line, add:

```js
    const positionen = [].concat(req.body.teilPosition || []);
```

In the `teileEingabe` map, add `position` to each row's object:

```js
    const teileEingabe = kontoIds.map((kontoId, i) => ({
      kontoId,
      betrag: betraege[i] || '',
      interessenskonflikt: konflikte[i] === 'true',
      position: (positionen[i] || '').trim() || null,
    }));
```

In the `aufgeloesteTeile.push(...)` call inside `teileEingabe.forEach(...)`, add `position: teil.position`:

```js
    aufgeloesteTeile.push({ konto, betrag: teil.betrag.replace(',', '.'), interessenskonflikt: teil.interessenskonflikt, position: teil.position, originalIndex });
```

In both `createSplitJob(db, job, { ... })` call sites inside the transaction loop, add `position: teil.position` to the options object.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS

- [ ] **Step 6: Run the full suite to check for regressions in the Aufsplitten flow**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS (no regressions in existing Aufsplitten tests — the new field is optional, so rows without `teilPosition` in the request body must behave exactly as before)

- [ ] **Step 7: Commit**

```bash
git add views/kontierung-aufsplitten.ejs src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "feat: add optional Position-auf-der-Rechnung field to the Aufsplitten form"
```

---

## Task 4: pdfStamp.js — kombinierte Stempelseite für Splitgruppen

**Files:**
- Modify: `src/services/pdfStamp.js`
- Test: `test/unit/pdfStamp.test.js`

**Interfaces:**
- Produces: `stampGruppenDokument(pdfBuffer, { jobId, positionen, verlauf }) → Promise<Buffer>`, wobei `positionen: Array<{ kontoNummer, kontoBezeichnung, betrag, position, freigeber1, freigeber2 }>` (`freigeber1`/`freigeber2` im selben Format wie `stampAndFinalize`s `stampData.freigeber1`/`.freigeber2`) und `verlauf` im selben Format wie `stampAndFinalize`s `stampData.verlauf` (bereits mit Konto/Positions-Präfix im `rolleLabel`, siehe Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/pdfStamp.test.js` (folgt den Konventionen der bestehenden `stampAndFinalize`-Tests in derselben Datei: `buildPdfFixture`, `extractedText`/mupdf zum Auslesen des gestempelten Textes):

```js
function samplePosition(overrides = {}) {
  return {
    kontoNummer: '6500',
    kontoBezeichnung: 'Unterhalt Gebäude',
    betrag: '60.00',
    position: 'Pos. 1',
    freigeber1: sampleFreigeber1(),
    freigeber2: sampleFreigeber2(),
    ...overrides,
  };
}

test('stampGruppenDokument appends a stamp page listing every Position with its own Konto/Betrag/Freigeber blocks', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const positionen = [
    samplePosition({ kontoNummer: '6500', betrag: '60.00', position: 'Pos. 1' }),
    samplePosition({ kontoNummer: '6600', betrag: '40.00', position: 'Pos. 2' }),
  ];
  const verlauf = [
    { rolleLabel: 'Konto 6500 (Pos. 1) — Freigabe 2', name: 'Erika Beispiel', identitaet: 'ct-456', zeitpunkt: '2026-08-15T09:15:00.000Z', ip: '5.6.7.8', interessenskonflikt: false, kommentar: null },
  ];

  const gestempelt = await stampGruppenDokument(pdf, { jobId: 99, positionen, verlauf });

  const seite1 = extractedText(gestempelt, 1);
  assert.match(seite1, /6500/);
  assert.match(seite1, /Unterhalt Gebäude/);
  assert.match(seite1, /60\.00/);
  assert.match(seite1, /Pos\. 1/);
  assert.match(seite1, /6600/);
  assert.match(seite1, /40\.00/);
  assert.match(seite1, /Pos\. 2/);
  assert.match(seite1, /Max Muster/);
  assert.match(seite1, /Erika Beispiel/);
});

test('stampGruppenDokument overflows onto further pages for many Positionen without losing any of them', async () => {
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  const positionen = Array.from({ length: 5 }, (_, i) =>
    samplePosition({ kontoNummer: `100${i}`, betrag: `${i + 1}0.00`, position: `Pos. ${i + 1}` })
  );

  const gestempelt = await stampGruppenDokument(pdf, { jobId: 1, positionen, verlauf: [] });
  const doc = await PDFDocument.load(gestempelt);
  assert.ok(doc.getPageCount() > 2, 'five full Freigabe-1+2 blocks must not fit on a single stamp page');

  const allText = doc.getPages().map((_, i) => extractedText(gestempelt, i)).join('\n');
  for (let i = 0; i < 5; i++) {
    assert.match(allText, new RegExp(`Pos\\. ${i + 1}`));
  }
});

test('stampGruppenDokument throws the standard German error for a corrupt PDF', async () => {
  await assert.rejects(
    () => stampGruppenDokument(NOT_REALLY_A_PDF, { jobId: 1, positionen: [samplePosition()], verlauf: [] }),
    /konnte nicht gestempelt werden/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: FAIL — `stampGruppenDokument` is not exported yet.

- [ ] **Step 3: Implement `stampGruppenDokument` in `src/services/pdfStamp.js`**

Add right after `stampAndFinalize`'s closing brace:

```js
// Combined stamp page for a Splitgruppe: one Konto/Betrag/Position/Freigabe-1+2 block per split
// line instead of stampAndFinalize's single Konto block, plus one shared Verlauf covering every
// child's freigaben (caller pre-sorts/pre-labels it, see splitGruppenExport.js). Reuses
// drawFreigabeBlock/drawVerlauf/wrapLine verbatim -- only the loop over multiple Positionen is new.
export async function stampGruppenDokument(pdfBuffer, gruppenData) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    throw new Error('PDF konnte nicht geladen werden – Datei ist beschädigt oder kein gültiges PDF.');
  }

  try {
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error('PDF enthält keine Seiten und kann nicht gestempelt werden.');
    }

    const { width, height } = pages[pages.length - 1].getSize();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = width - PAGE_MARGIN;
    const POSITION_BOTTOM_MARGIN = 220; // roughly the height a single Konto+Freigabe-1+2 block needs

    let stampPage = doc.addPage([width, height]);
    let y = height - 50;
    if (gruppenData.jobId != null) {
      stampPage.drawText(`Splitgruppe — Job-ID: ${gruppenData.jobId}`, { x: 60, y, size: 14, font: boldFont, color: rgb(0, 0, 0) });
      y -= 30;
    }

    for (const position of gruppenData.positionen) {
      if (y < POSITION_BOTTOM_MARGIN) {
        stampPage = doc.addPage([width, height]);
        y = height - 50;
      }
      const titelTeile = [`Konto: ${position.kontoNummer} — ${position.kontoBezeichnung}`, `Betrag: ${position.betrag}`];
      if (position.position) titelTeile.push(`Position: ${position.position}`);
      for (const line of wrapLine(boldFont, titelTeile.join(' — '), 13, maxWidth)) {
        stampPage.drawText(line, { x: 60, y, size: 13, font: boldFont, color: rgb(0, 0, 0) });
        y -= 17;
      }
      y -= 10;
      y = drawFreigabeBlock(stampPage, font, 'Freigabe 1', position.freigeber1, y, maxWidth);
      y -= BLOCK_GAP;
      y = drawFreigabeBlock(stampPage, font, 'Freigabe 2', position.freigeber2, y, maxWidth);
      y -= BLOCK_GAP + 10;
    }

    if (y < VERLAUF_BOTTOM_MARGIN + 20) {
      stampPage = doc.addPage([width, height]);
      y = height - 50;
    }
    drawVerlauf(doc, font, gruppenData.verlauf, stampPage, y, width, height);

    return Buffer.from(await doc.save());
  } catch {
    throw new Error('PDF konnte nicht gestempelt werden – Dokument ist ungültig oder enthält Zeichen, die nicht dargestellt werden können.');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/pdfStamp.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/pdfStamp.js test/unit/pdfStamp.test.js
git commit -m "feat: add stampGruppenDokument for combined Splitgruppen stamp pages"
```

---

## Task 5: splitGruppenExport.js — Merge-Orchestrierung

**Files:**
- Create: `src/services/splitGruppenExport.js`
- Test: `test/unit/splitGruppenExport.test.js`

**Interfaces:**
- Consumes: `getJobById`, `listSplitKinder`, `pruefeSplitGruppenVollstaendigkeit`, `markGruppeExportiert` (Task 2, `jobsRepo.js`), `getKontoById` (`kontenRepo.js`), `getPersonById` (`personenRepo.js`), `listFreigabenByJob` (`freigabenRepo.js`), `getConfigValue` (`adminConfigRepo.js`), `stampGruppenDokument` (Task 4, `pdfStamp.js`), `setZeitstempel` (`zeitstempel.js`).
- Produces: `pruefeUndFinalisiereSplitGruppe(db, config, parentJobId) → Promise<{ status: 'uebersprungen' | 'unvollstaendig' | 'blockiert' | 'exportiert' | 'fehler', pdfPfad?, error? }>`. Consumed by Task 6 (Freigabe-2-/Löschung-Hooks) and Task 7 (Nachhol-Cron).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/splitGruppenExport.test.js`:

```js
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
  const kontoId = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', freigeber2Id: '2' });

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
```

`upsertPerson`/`createKonto` above use these repos' real signatures (`upsertPerson(db, { id, vorname, nachname, email, gruppen, loggedInNow })`, `createKonto(db, { kontonummer, bezeichnung, freigeber1Id, freigeber2Id, ... })`), matching the pattern already used throughout `test/integration/admin/abgelehnt.test.js` and `test/integration/freigabe2.test.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/splitGruppenExport.test.js`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `src/services/splitGruppenExport.js`**

```js
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getJobById, listSplitKinder, pruefeSplitGruppenVollstaendigkeit, markGruppeExportiert } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampGruppenDokument } from './pdfStamp.js';
import { setZeitstempel } from './zeitstempel.js';

const EREIGNIS_LABEL = {
  freigeber1: 'Freigabe 1',
  freigeber2: 'Freigabe 2',
  ablehnung: 'Ablehnung',
  freigabe1_eskalation: 'Eskalation Freigabe 1',
  freigabe2_eskalation: 'Eskalation Freigabe 2',
  iban_abweichung: 'IBAN-Abweichung',
};

function buildFreigabeEintrag(person, freigabe) {
  return {
    name: `${person.vorname} ${person.nachname}`,
    identitaet: person.churchtools_person_id,
    zeitpunkt: freigabe.zeitpunkt,
    ip: freigabe.ip,
    interessenskonflikt: Boolean(freigabe.interessenskonflikt),
    kommentar: freigabe.kommentar,
  };
}

// mergeBelegInPdf (belegAnhaengen.js) always APPENDS Beleg-Seiten after a job's existing pages,
// never inserts them -- so any pages beyond the Elternjob's own (Beleg-freie) Seitenzahl on a
// Kind-PDF are exactly that Kind's attached Beleg, in order. Copies them onto gruppenDoc.
async function haengeBelegSeitenAn(gruppenDoc, kindPdfPfad, basisSeitenzahl) {
  const kindDoc = await PDFDocument.load(readFileSync(kindPdfPfad));
  const kindSeitenzahl = kindDoc.getPageCount();
  if (kindSeitenzahl <= basisSeitenzahl) return;
  const belegIndices = kindDoc.getPageIndices().slice(basisSeitenzahl);
  const copiedPages = await gruppenDoc.copyPages(kindDoc, belegIndices);
  copiedPages.forEach((page) => gruppenDoc.addPage(page));
}

// Merges a complete Splitgruppe (alle Kinder abgeschlossen) into one stamped, zeitgestempelten
// PDF and records it on the Elternjob. Best-effort and idempotent by construction: no-ops
// whenever the group is not (yet) complete, is blocked by a rejected sibling, or has already been
// exported (gruppe_pdf_pfad already set) -- safe to call repeatedly from multiple trigger points
// (Freigabe-2-Abschluss, Löschung einer blockierenden Zeile, der Nachhol-Cron-Job).
//
// Deliberately DOES block the whole export on a configured-but-unreachable TSA (unlike
// freigabe2.js's per-job stampAndFinalize, which proceeds without a Zeitstempel on TSA failure):
// this merged document's entire purpose is the paperless archival copy handed to Paperless-ngx,
// so shipping it without the Zeitstempel it was built for would defeat that purpose. Retried
// later by the split-gruppen-nachholen cron job (cronJobs.js) exactly because gruppe_pdf_pfad
// stays unset on failure.
export async function pruefeUndFinalisiereSplitGruppe(db, config, parentJobId) {
  const parent = getJobById(db, parentJobId);
  if (!parent || parent.gruppe_pdf_pfad) return { status: 'uebersprungen' };

  const { vollstaendig, blockiert, kinder } = pruefeSplitGruppenVollstaendigkeit(db, parentJobId);
  if (blockiert) return { status: 'blockiert' };
  if (!vollstaendig) return { status: 'unvollstaendig' };

  try {
    const basisBuffer = readFileSync(parent.pdf_pfad);
    const basisDoc = await PDFDocument.load(basisBuffer);
    const basisSeitenzahl = basisDoc.getPageCount();
    const gruppenDoc = await PDFDocument.load(basisBuffer);

    const positionen = [];
    const verlauf = [];
    for (const kind of listSplitKinder(db, parentJobId).filter((k) => kinder.some((c) => c.id === k.id))) {
      const konto = getKontoById(db, kind.konto_id);
      const freigaben = listFreigabenByJob(db, kind.id);
      const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
      const freigabe2 = freigaben.findLast((f) => f.rolle === 'freigeber2');

      positionen.push({
        kontoNummer: konto.kontonummer,
        kontoBezeichnung: konto.bezeichnung,
        betrag: kind.betrag,
        position: kind.rechnungsposition,
        freigeber1: buildFreigabeEintrag(getPersonById(db, freigabe1.person_id), freigabe1),
        freigeber2: buildFreigabeEintrag(getPersonById(db, freigabe2.person_id), freigabe2),
      });

      const praefix = `Konto ${konto.kontonummer}${kind.rechnungsposition ? ` (Pos. ${kind.rechnungsposition})` : ''}`;
      for (const f of freigaben) {
        const person = getPersonById(db, f.person_id);
        verlauf.push({
          rolleLabel: `${praefix} — ${EREIGNIS_LABEL[f.rolle] || f.rolle}`,
          name: `${person.vorname} ${person.nachname}`,
          identitaet: f.person_id,
          zeitpunkt: f.zeitpunkt,
          ip: f.ip,
          interessenskonflikt: Boolean(f.interessenskonflikt),
          kommentar: f.kommentar,
        });
      }

      await haengeBelegSeitenAn(gruppenDoc, kind.pdf_pfad, basisSeitenzahl);
    }
    verlauf.sort((a, b) => (a.zeitpunkt < b.zeitpunkt ? -1 : a.zeitpunkt > b.zeitpunkt ? 1 : 0));

    const gruppenPdfMitBelegen = Buffer.from(await gruppenDoc.save());
    let gestempelt = await stampGruppenDokument(gruppenPdfMitBelegen, { jobId: parent.id, positionen, verlauf });

    let zeitstempelGesetztAm = null;
    let zeitstempelDateiHash = null;
    const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
    if (tsaUrl) {
      gestempelt = await setZeitstempel(gestempelt, {
        url: tsaUrl,
        user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
        passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
      });
      zeitstempelGesetztAm = new Date().toISOString();
      zeitstempelDateiHash = createHash('sha256').update(gestempelt).digest('hex');
    }

    const zielPfad = parent.pdf_pfad.replace(/\.pdf$/, `-gruppe-${randomUUID()}.pdf`);
    const tmpPfad = `${zielPfad}.tmp`;
    writeFileSync(tmpPfad, gestempelt);
    renameSync(tmpPfad, zielPfad);

    markGruppeExportiert(db, parent.id, { pdfPfad: zielPfad, zeitstempelGesetztAm, zeitstempelDateiHash });
    return { status: 'exportiert', pdfPfad: zielPfad };
  } catch (err) {
    console.error(`Splitgruppen-Export für Elternjob ${parentJobId} fehlgeschlagen, wird nachgeholt:`, err.message);
    return { status: 'fehler', error: err.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/splitGruppenExport.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/splitGruppenExport.js test/unit/splitGruppenExport.test.js
git commit -m "feat: add pruefeUndFinalisiereSplitGruppe to merge and stamp completed Splitgruppen"
```

---

## Task 6: Trigger verdrahten — Freigabe 2 und Löschung einer blockierenden Zeile

**Files:**
- Modify: `src/routes/freigabe2.js`
- Modify: `src/routes/admin/abgelehnt.js`
- Test: `test/integration/freigabe2.test.js`
- Test: `test/integration/admin/abgelehnt.test.js`

**Interfaces:**
- Consumes: `pruefeUndFinalisiereSplitGruppe(db, config, parentJobId)` (Task 5).

- [ ] **Step 1: Write the failing test for the Freigabe-2 hook**

Append to `test/integration/freigabe2.test.js`, reusing its existing `seedFreigabe2Job(db, { pdfPfad }) → { id, kontoId }` and `buildTestApp(db, { mailer })` helpers verbatim (both already defined near the top of the file — `seedFreigabe2Job` seeds persons `'1'`-`'4'`, one Konto with `freigeber1Id: '1'`/`freigeber2Id: '3'`, and a job already in status `'freigabe2'`, `zugewiesen_an: '1'`; auth in this file's test app is the plain `x-test-person-id` header, no CSRF):

```js
test('POST /freigabe2/:id triggers the Splitgruppe merge once the LAST sibling completes, and does nothing while a sibling remains open', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-splitgruppe-test-'));
  const kindPfad2 = join(dir, 'kind2.pdf');
  writeFileSync(kindPfad2, await buildPdfFixture(['Rechnung Seite 1']));
  const { id: kind2, kontoId } = await seedFreigabe2Job(db, { pdfPfad: kindPfad2 });

  const parentPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: parentPfad });
  db.prepare('UPDATE jobs SET aufgesplittet_von = ?, rechnungsposition = ? WHERE id = ?').run(parentId, 'Pos. 2', kind2);

  // kind1 shares the same Konto/Freigeber (person '1' = freigeber1, person '3' = freigeber2) and
  // has already been through the auto-Freigabe-1 path (see kontierung.js's istEigenesKonto
  // branch, Task 3), landing it in 'freigabe2' too -- exactly like a real Aufsplitten result.
  const kindPfad1 = join(dir, 'kind1.pdf');
  writeFileSync(kindPfad1, await buildPdfFixture(['Rechnung Seite 1']));
  const parentJob = getJobById(db, parentId);
  const kind1 = createSplitJob(db, parentJob, { pdfPfad: kindPfad1, kontoId, betrag: '10.00', zugewiesenAn: '1', position: 'Pos. 1' });
  createFreigabe(db, { jobId: kind1, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(kind1);

  const app = buildTestApp(db);

  // Completing kind1's Freigabe 2 first -- kind2 is still open, so the group must NOT export yet.
  const res1 = await request(app).post(`/freigabe2/${kind1}`).set('x-test-person-id', '3').type('form').send({ interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(res1.status, 302);
  assert.equal(getJobById(db, parentId).gruppe_pdf_pfad, null);

  // Completing kind2's Freigabe 2 (the last remaining sibling) must trigger the merge.
  const res2 = await request(app).post(`/freigabe2/${kind2}`).set('x-test-person-id', '3').type('form').send({ interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(res2.status, 302);
  assert.ok(getJobById(db, parentId).gruppe_pdf_pfad, 'the group must be merged and exported once the last sibling completes Freigabe 2');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Extend this file's existing imports with `mkdtempSync, rmSync` (`node:fs`, alongside the already-imported `readFileSync`/`writeFileSync`), `tmpdir` (`node:os`), `join` (`node:path`), and `createSplitJob` from `jobsRepo.js` (extend the existing import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — `gruppe_pdf_pfad` stays `null` even after the last sibling completes.

- [ ] **Step 3: Wire the hook into `src/routes/freigabe2.js`**

Add the import at the top of the file (alongside the other service imports):

```js
import { pruefeUndFinalisiereSplitGruppe } from '../services/splitGruppenExport.js';
```

Insert right after the existing `renameSync(tmpPfad, job.pdf_pfad)` try/catch block (i.e. right before the pre-existing `res.redirect('/pool');`):

```js
      if (job.aufgesplittet_von) {
        try {
          await pruefeUndFinalisiereSplitGruppe(db, config, job.aufgesplittet_von);
        } catch (err) {
          // Never let a Splitgruppen-Merge-Fehler die bereits abgeschlossene Freigabe 2 dieses
          // einzelnen Kindes scheitern lassen -- der Nachhol-Cron-Job holt einen fehlgeschlagenen
          // Merge später nach.
          console.error(`Splitgruppen-Prüfung für Elternjob ${job.aufgesplittet_von} fehlgeschlagen:`, err.message);
        }
      }

      res.redirect('/pool');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing test for the Löschung hook**

Append to `test/integration/admin/abgelehnt.test.js`, reusing this file's own `buildTestApp`/`seedAdmin` helpers (both already defined near the top of the file) and following `seedAbgelehntJob`'s exact pattern for constructing the rejected sibling:

```js
test('deleting the last blocking abgelehnt sibling of an otherwise complete Splitgruppe triggers the merge', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'abgelehnt-splitgruppe-test-'));
  seedAdmin(db);
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });

  const parentPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const parentId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad: parentPfad });
  const parentJob = getJobById(db, parentId);

  // Sibling A: already abgeschlossen, with a full Freigabe-1+2 Verlauf.
  const kindAPfad = join(dir, 'kindA.pdf');
  writeFileSync(kindAPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const kindAId = createSplitJob(db, parentJob, { pdfPfad: kindAPfad, kontoId, betrag: '60.00', zugewiesenAn: '1', position: 'Pos. 1' });
  createFreigabe(db, { jobId: kindAId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-15T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId: kindAId, personId: '3', rolle: 'freigeber2', zeitpunkt: '2026-08-15T10:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kindAId);

  // Sibling B: rejected by Freigeber 2 (person '3') -- this is the blocking row an admin (id '99',
  // not person '3') is allowed to delete.
  const kindBPfad = join(dir, 'kindB.pdf');
  writeFileSync(kindBPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const kindBId = createSplitJob(db, parentJob, { pdfPfad: kindBPfad, kontoId, betrag: '40.00', zugewiesenAn: '1', position: 'Pos. 2' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(kindBId);
  ablehnenJob(db, kindBId, { abgelehntVon: '3', grund: 'Falsches Konto' });
  createFreigabe(db, { jobId: kindBId, personId: '3', rolle: 'ablehnung', zeitpunkt: '2026-08-15T10:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'Falsches Konto', eskaliertVon: null });

  const app = buildTestApp(db);
  const agent = request.agent(app);
  const res = await agent
    .post(`/admin/abgelehnt/${kindBId}/loeschen`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ begruendung: 'Doppelt erfasst, Konto von Sibling A deckt die ganze Rechnung ab.', bestaetigung: 'ja' });

  assert.equal(res.status, 302);
  assert.equal(getJobById(db, kindBId).status, 'geloescht');
  assert.ok(getJobById(db, parentId).gruppe_pdf_pfad, 'resolving the last blocking Ablehnung must trigger the Splitgruppen-Merge');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Extend this test file's top-of-file imports with `mkdtempSync, rmSync` (from `node:fs`, alongside the already-imported `writeFileSync`/`existsSync`), `tmpdir` (`node:os`), `join` (already imported), `createSplitJob, getJobById` and `pruefeSplitGruppenVollstaendigkeit`-adjacent exports as needed from `jobsRepo.js` (extend the existing import line rather than adding a second one), and `buildPdfFixture` from `'../../helpers/pdfFixture.js'`.

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/integration/admin/abgelehnt.test.js`
Expected: FAIL

- [ ] **Step 7: Wire the hook into `src/routes/admin/abgelehnt.js`**

Add the import at the top:

```js
import { pruefeUndFinalisiereSplitGruppe } from '../../services/splitGruppenExport.js';
```

The router factory needs `config` — check its call site (`src/app.js` or wherever `createAdminAbgelehntRouter` is invoked) and add `config` to the destructured factory parameter if it isn't already passed; if `config` is not currently threaded to this router, add it there too.

Right after the `res.redirect('/admin/abgelehnt?gespeichert=1');` line's preceding logic — i.e. right after the `if (!geloescht) { ... }` block and before the `res.redirect(...)` call — insert:

```js
      if (geloescht.aufgesplittet_von) {
        try {
          await pruefeUndFinalisiereSplitGruppe(db, config, geloescht.aufgesplittet_von);
        } catch (err) {
          console.error(`Splitgruppen-Prüfung für Elternjob ${geloescht.aufgesplittet_von} fehlgeschlagen:`, err.message);
        }
      }

      res.redirect('/admin/abgelehnt?gespeichert=1');
```

Since the route handler was synchronous (`(req, res, next) => { ... }`), change its signature to `async (req, res, next) => { ... }` to allow the `await`.

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/integration/admin/abgelehnt.test.js`
Expected: PASS

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/routes/freigabe2.js src/routes/admin/abgelehnt.js test/integration/freigabe2.test.js test/integration/admin/abgelehnt.test.js
git commit -m "feat: trigger Splitgruppen-Merge after the last sibling's Freigabe 2 and after resolving a blocking Ablehnung"
```

---

## Task 7: Nachhol-Cron-Job für fehlgeschlagene/verzögerte Merges

**Files:**
- Modify: `src/services/cronJobs.js`
- Modify: `src/db/adminConfigRepo.js`
- Modify: `src/services/scheduler.js`
- Test: `test/unit/cronJobs.test.js`

**Interfaces:**
- Consumes: `listSplitGruppenAusstehend(db)` (Task 2), `pruefeUndFinalisiereSplitGruppe(db, config, parentJobId)` (Task 5), `startCronLauf`/`finishCronLauf`/`hasRecentRunningCronLauf` (`cronLogRepo.js`, bereits vorhanden).
- Produces: `runSplitGruppenNachholenJob(db, config) → Promise<{ status, nachgeholt?, fehlgeschlagen?, uebersprungen?, error? }>`, neuer `admin_config`-Schlüssel `cron_split_gruppen_nachholen_intervall_minuten` (Default `'15'`), Scheduler-Registrierung.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/cronJobs.test.js` (folgt exakt dem Muster der bestehenden `runZeitstempelNachholenJob`-Tests oben in derselben Datei — `openDatabase`, `mkdtempSync`, `buildPdfFixture`, `setupMockTsa`, `listRecentCronLog`):

```js
async function seedUnvollstaendigeGruppe(db, dir) {
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createFreigabe } = await import('../../src/db/freigabenRepo.js');
  upsertPerson(db, { id: '1', vorname: 'Max', nachname: 'Muster', email: 'max@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Erika', nachname: 'Beispiel', email: 'erika@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', freigeber2Id: '2' });

  const parentPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPfad, await buildPdfFixture(['Rechnung']));
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: parentPfad });
  const { createSplitJob } = await import('../../src/db/jobsRepo.js');
  const kindPfad = join(dir, 'kind.pdf');
  writeFileSync(kindPfad, await buildPdfFixture(['Rechnung']));
  const kindId = createSplitJob(db, getJobById(db, parentId), { pdfPfad: kindPfad, kontoId, betrag: '10.00', zugewiesenAn: '1' });
  createFreigabe(db, { jobId: kindId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-08-01T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: 0 });
  createFreigabe(db, { jobId: kindId, personId: '2', rolle: 'freigeber2', zeitpunkt: '2026-08-01T09:00:00.000Z', ip: '5.6.7.8', interessenskonflikt: 0 });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kindId);
  return { parentId };
}

test('runSplitGruppenNachholenJob merges a pending complete group and logs the run', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'split-nachholen-test-'));
  const { parentId } = await seedUnvollstaendigeGruppe(db, dir);

  const result = await runSplitGruppenNachholenJob(db, {});
  assert.equal(result.status, 'erfolg');
  assert.equal(result.nachgeholt, 1);
  assert.ok(getJobById(db, parentId).gruppe_pdf_pfad);
  assert.equal(listRecentCronLog(db, 'split-gruppen-nachholen', 10).length, 1);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('runSplitGruppenNachholenJob skips a group that is still incomplete without counting it as fehlgeschlagen', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO jobs (eingang_am, quelle, dateiname, pdf_pfad, status) VALUES ('2026-08-01T00:00:00.000Z', 'lieferant', 'r.pdf', '/tmp/x.pdf', 'aufgesplittet')").run();

  const result = await runSplitGruppenNachholenJob(db, {});
  assert.equal(result.status, 'erfolg');
  assert.equal(result.nachgeholt, 0);
  assert.equal(result.fehlgeschlagen, 0);
  assert.equal(result.uebersprungen, 1);
  db.close();
});
```

Add `runSplitGruppenNachholenJob` to the file's `cronJobs.js` import, and `createKonto`/`upsertPerson`/`createFreigabe`/`createSplitJob` as needed (or inline the dynamic `import()` calls exactly as sketched above if this file doesn't already import them at the top).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/cronJobs.test.js`
Expected: FAIL — `runSplitGruppenNachholenJob` not exported yet.

- [ ] **Step 3: Implement `runSplitGruppenNachholenJob` in `src/services/cronJobs.js`**

Add the needed imports at the top (extend the existing `jobsRepo.js`/service imports):

```js
import { listSplitGruppenAusstehend } from '../db/jobsRepo.js';
import { pruefeUndFinalisiereSplitGruppe } from './splitGruppenExport.js';
```

Add the function, following `runZeitstempelNachholenJob`'s exact structure:

```js
// Nachholt Splitgruppen, deren Merge beim ersten Versuch (Freigabe-2-Abschluss des letzten
// Kindes, oder Löschung einer blockierenden abgelehnten Zeile) fehlgeschlagen ist -- TSA-Ausfall,
// beschädigtes Kind-PDF -- oder die zum Zeitpunkt des letzten Auslösers noch unvollständig war.
// Jede Gruppe wird unabhängig versucht: ein fehlerhaftes Kind-PDF in einer Gruppe darf die
// anderen Gruppen im selben Lauf nicht blockieren.
export async function runSplitGruppenNachholenJob(db, config) {
  if (hasRecentRunningCronLauf(db, 'split-gruppen-nachholen')) {
    return { status: 'uebersprungen', nachgeholt: 0, meldung: 'Ein Splitgruppen-Nachholen-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'split-gruppen-nachholen');
  try {
    const ausstehend = listSplitGruppenAusstehend(db);
    let nachgeholt = 0;
    let fehlgeschlagen = 0;
    let uebersprungen = 0;
    for (const parent of ausstehend) {
      const ergebnis = await pruefeUndFinalisiereSplitGruppe(db, config, parent.id);
      if (ergebnis.status === 'exportiert') nachgeholt += 1;
      else if (ergebnis.status === 'fehler') fehlgeschlagen += 1;
      else uebersprungen += 1;
    }

    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Nachgeholt: ${nachgeholt}, Fehlgeschlagen: ${fehlgeschlagen}, Übersprungen: ${uebersprungen}`,
    });
    return { status: 'erfolg', nachgeholt, fehlgeschlagen, uebersprungen };
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS

- [ ] **Step 5: Register the admin_config default**

In `src/db/adminConfigRepo.js`, add to `DEFAULTS` (right after `cron_zeitstempel_nachholen_intervall_minuten: '5',`):

```js
  cron_split_gruppen_nachholen_intervall_minuten: '15',
```

- [ ] **Step 6: Wire the scheduler in `src/services/scheduler.js`**

Update the top-level import to add `runSplitGruppenNachholenJob`:

```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runDatenbankSicherungJob, runSplitGruppenNachholenJob } from './cronJobs.js';
```

In `startScheduler`'s destructured `jobs` parameter, add the new entry to both the aliasing list and its default object:

```js
export function startScheduler({
  db,
  config,
  mailer,
  jobs: {
    runSyncPersonenJob: syncJob,
    runPoolErinnerungenJob: erinnerungenJob,
    runPdfBereinigungJob: bereinigungJob,
    runZeitstempelNachholenJob: zeitstempelJob,
    runDatenbankSicherungJob: sicherungJob,
    runSplitGruppenNachholenJob: splitGruppenJob,
  } = {
    runSyncPersonenJob,
    runPoolErinnerungenJob,
    runPdfBereinigungJob,
    runZeitstempelNachholenJob,
    runDatenbankSicherungJob,
    runSplitGruppenNachholenJob,
  },
}) {
```

Add a new `scheduleInterval(...)` registration right after the existing `zeitstempel-nachholen` one:

```js
  scheduleInterval(
    () => zahlOderStandard(getConfigValue(db, 'cron_split_gruppen_nachholen_intervall_minuten'), 15) * MINUTE_MS,
    async () => {
      const result = await splitGruppenJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter split-gruppen-nachholen-Lauf fehlgeschlagen:', result.error);
    }
  );
```

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/services/cronJobs.js src/db/adminConfigRepo.js src/services/scheduler.js test/unit/cronJobs.test.js
git commit -m "feat: add split-gruppen-nachholen cron job for delayed/failed Splitgruppen merges"
```

---

## Task 8: n8n-Schnittstelle — Gruppen-Einträge in /abholbereit und gruppierte Abholbestätigung

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Test: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `listAbholbereitJobs` (Task 2, bereits ohne Splitkinder), `listAbholbereitGruppen`, `istGruppenElternjob`, `confirmGruppenAbholung`, `listSplitKinder` (alle Task 2/bereits vorhanden).
- Produces: `GET /n8n/jobs/abholbereit` liefert zusätzlich Gruppen-Einträge mit einem `positionen`-Array; `POST /n8n/jobs/:id/abholung-bestaetigen` erkennt Gruppen-Eltern-IDs und löscht alle zugehörigen Dateien.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/n8n/jobs.test.js`. This file already defines `buildTestApp(db, config, mailer)` (mounts the router at `/api/n8n/jobs` with `requireApiKey(config)`), `testConfig(jobsDir)` (provides `n8nApiKey`), and `createStubMailer()` — reuse all three exactly as the file's existing `/abholbereit` tests do, and authenticate with the `X-API-Key` header (see `src/middleware/apiKey.js`), not a made-up header:

```js
test('GET /api/n8n/jobs/abholbereit includes a group entry with a positionen array for a completed Splitgruppe, and no individual entries for its children', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'n8n-gruppe-test-'));
  const kontoId = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', freigeber2Id: '2' });
  const parentPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPfad, 'x');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'r.pdf', pdfPfad: parentPfad });
  const parentJob = getJobById(db, parentId);
  const kindPfad1 = join(dir, 'k1.pdf');
  const kindPfad2 = join(dir, 'k2.pdf');
  writeFileSync(kindPfad1, 'x');
  writeFileSync(kindPfad2, 'x');
  const kind1 = createSplitJob(db, parentJob, { pdfPfad: kindPfad1, kontoId, betrag: '10.00', zugewiesenAn: '1', position: 'Pos. 1' });
  const kind2 = createSplitJob(db, parentJob, { pdfPfad: kindPfad2, kontoId, betrag: '20.00', zugewiesenAn: '1', position: 'Pos. 2' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id IN (?, ?)").run(kind1, kind2);
  const gruppenPfad = join(dir, 'gruppe.pdf');
  writeFileSync(gruppenPfad, 'x');
  markGruppeExportiert(db, parentId, { pdfPfad: gruppenPfad, zeitstempelGesetztAm: null, zeitstempelDateiHash: null });

  const config = testConfig(dir);
  const app = buildTestApp(db, config, createStubMailer());
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', config.n8nApiKey);

  assert.equal(res.status, 200);
  const gruppenEintrag = res.body.find((e) => e.id === parentId);
  assert.ok(gruppenEintrag, 'the parent id must appear as a group entry');
  assert.equal(gruppenEintrag.positionen.length, 2);
  assert.deepEqual(gruppenEintrag.positionen.map((p) => p.position).sort(), ['Pos. 1', 'Pos. 2']);
  assert.ok(!res.body.some((e) => e.id === kind1 || e.id === kind2), 'Splitkinder must never appear as individual entries');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /api/n8n/jobs/abholbereit leaves a normal (non-split) job entry exactly in its current shape, with no positionen field', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'n8n-normal-test-'));
  const pdfPfad = join(dir, 'n.pdf');
  writeFileSync(pdfPfad, 'x');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'n.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);

  const config = testConfig(dir);
  const app = buildTestApp(db, config, createStubMailer());
  const res = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', config.n8nApiKey);
  const eintrag = res.body.find((e) => e.id === jobId);
  assert.ok(eintrag);
  assert.equal('positionen' in eintrag, false);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen on a group parent id deletes every child file and the group file, and marks children abgeholt', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'n8n-gruppe-bestaetigen-test-'));
  const kontoId = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', freigeber2Id: '2' });
  const parentPfad = join(dir, 'parent.pdf');
  writeFileSync(parentPfad, 'x');
  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: parentPfad });
  const parentJob = getJobById(db, parentId);

  const kindPfad = join(dir, 'k1.pdf');
  writeFileSync(kindPfad, 'x');
  const kindId = createSplitJob(db, parentJob, { pdfPfad: kindPfad, kontoId, betrag: '10.00', zugewiesenAn: '1' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(kindId);

  const gruppenPfad = join(dir, 'gruppe.pdf');
  writeFileSync(gruppenPfad, 'x');
  markGruppeExportiert(db, parentId, { pdfPfad: gruppenPfad, zeitstempelGesetztAm: null, zeitstempelDateiHash: null });

  const config = testConfig(dir);
  const app = buildTestApp(db, config, createStubMailer());
  const res = await request(app).post(`/api/n8n/jobs/${parentId}/abholung-bestaetigen`).set('X-API-Key', config.n8nApiKey);

  assert.equal(res.status, 200);
  assert.equal(getJobById(db, kindId).status, 'abgeholt');
  assert.equal(existsSync(kindPfad), false);
  assert.equal(existsSync(gruppenPfad), false);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Add `markGruppeExportiert`, `createSplitJob`, `createKonto` (from `kontenRepo.js`) to this test file's existing imports if missing — check the file's actual top-of-file import block first and extend it rather than re-declaring anything already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL

- [ ] **Step 3: Implement in `src/routes/n8n/jobs.js`**

Update the import line to add the new repo functions:

```js
import { createJob, getJobById, findJobByDateiHash, listAbholbereitJobs, listAbholbereitGruppen, confirmAbholung, confirmGruppenAbholung, istGruppenElternjob, listSplitKinder, setThumbnailPfad, setQrDaten } from '../../db/jobsRepo.js';
```

Replace the `/abholbereit` handler body:

```js
  router.get('/abholbereit', (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const jobs = listAbholbereitJobs(db, undefined, nurMitZeitstempel);
    const einzelPayload = jobs.map((job) => {
      const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
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
        qr_iban: job.qr_iban,
        qr_referenz: job.qr_referenz,
        qr_betrag: job.qr_betrag,
        qr_waehrung: job.qr_waehrung,
        qr_creditor_name: job.qr_creditor_name,
        qr_erkannt_am: job.qr_erkannt_am,
        download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
      };
    });

    const gruppen = listAbholbereitGruppen(db, undefined, nurMitZeitstempel);
    const gruppenPayload = gruppen.map((parent) => {
      // gruppe_pdf_pfad is only ever set once pruefeSplitGruppenVollstaendigkeit reported the
      // group complete, which already guarantees every non-geloescht sibling reached
      // 'abgeschlossen' (and therefore has a real konto_id, not just a hinweis_konto_id) -- so a
      // plain geloescht-filter is enough here, no separate konto_id check needed.
      const kinder = listSplitKinder(db, parent.id).filter((k) => k.status !== 'geloescht');
      const positionen = kinder.map((kind) => {
        const konto = getKontoById(db, kind.konto_id);
        return {
          konto_id: kind.konto_id,
          konto_kontonummer: konto?.kontonummer ?? null,
          konto_bezeichnung: konto?.bezeichnung ?? null,
          betrag: kind.betrag,
          position: kind.rechnungsposition,
        };
      });
      return {
        id: parent.id,
        eingang_am: parent.eingang_am,
        quelle: parent.quelle,
        absender: parent.absender,
        lieferant: parent.lieferant,
        rechnungsnummer: parent.rechnungsnummer,
        betrag: parent.betrag,
        zahlungsziel: parent.zahlungsziel,
        dateiname: parent.dateiname,
        positionen,
        download_url: buildSignedDownloadUrl(config, parent.id, ABHOLEN_TTL_SECONDS),
      };
    });

    res.json([...einzelPayload, ...gruppenPayload]);
  });
```

Replace the `/:id/abholung-bestaetigen` handler body:

```js
  router.post('/:id/abholung-bestaetigen', (req, res) => {
    const nurMitZeitstempel = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    const id = Number(req.params.id);

    if (istGruppenElternjob(db, id)) {
      const ergebnis = confirmGruppenAbholung(db, id, nurMitZeitstempel);
      if (!ergebnis) {
        return res
          .status(409)
          .json({ error: 'Splitgruppe ist nicht bereit zur Abholung, oder der Zeitstempel steht noch aus.' });
      }
      for (const kind of ergebnis.kinder) {
        try {
          if (kind.pdf_pfad && existsSync(kind.pdf_pfad)) unlinkSync(kind.pdf_pfad);
        } catch (err) {
          console.error(`Löschen der PDF für Splitkind ${kind.id} nach Abholung fehlgeschlagen:`, err.message);
        }
        try {
          if (kind.thumbnail_pfad && existsSync(kind.thumbnail_pfad)) unlinkSync(kind.thumbnail_pfad);
        } catch (err) {
          console.error(`Löschen des Thumbnails für Splitkind ${kind.id} nach Abholung fehlgeschlagen:`, err.message);
        }
      }
      try {
        if (existsSync(ergebnis.parent.gruppe_pdf_pfad)) unlinkSync(ergebnis.parent.gruppe_pdf_pfad);
      } catch (err) {
        console.error(`Löschen der Gruppen-PDF für Elternjob ${ergebnis.parent.id} nach Abholung fehlgeschlagen:`, err.message);
      }
      return res.json({ id: ergebnis.parent.id, status: 'abgeholt' });
    }

    const job = confirmAbholung(db, id, nurMitZeitstempel);
    if (!job) {
      return res
        .status(409)
        .json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt, oder der Zeitstempel steht noch aus.' });
    }
    try {
      if (job.pdf_pfad && existsSync(job.pdf_pfad)) {
        unlinkSync(job.pdf_pfad);
      }
    } catch (err) {
      console.error(`Löschen der PDF für Job ${job.id} nach Abholung fehlgeschlagen:`, err.message);
    }
    try {
      if (job.thumbnail_pfad && existsSync(job.thumbnail_pfad)) {
        unlinkSync(job.thumbnail_pfad);
      }
    } catch (err) {
      console.error(`Löschen des Thumbnails für Job ${job.id} nach Abholung fehlgeschlagen:`, err.message);
    }
    res.json({ id: job.id, status: job.status });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "feat: expose combined Splitgruppen entries in /abholbereit and handle grouped Abholung-Bestätigung"
```

---

## Task 9: Download-Route — Gruppen-PDF statt Einzel-PDF ausliefern

**Files:**
- Modify: `src/routes/downloads.js`
- Test: `test/integration/downloads.test.js`

**Interfaces:**
- Consumes: `getJobById` (bereits vorhanden). Kein neuer Repo-Export nötig — die Unterscheidung läuft direkt über `job.gruppe_pdf_pfad`.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/downloads.test.js` (folgt den Konventionen der bestehenden `GET /downloads/:jobId`-Tests in dieser Datei):

```js
test('GET /downloads/:jobId serves the merged Gruppen-PDF (not the Elternjob\'s own original PDF) for a job with gruppe_pdf_pfad set', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-gruppe-test-'));
  const originalPfad = join(dir, 'original.pdf');
  const gruppenPfad = join(dir, 'gruppe.pdf');
  writeFileSync(originalPfad, '%PDF-original');
  writeFileSync(gruppenPfad, '%PDF-gruppe');

  const parentId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'r.pdf', pdfPfad: originalPfad });
  markGruppeExportiert(db, parentId, { pdfPfad: gruppenPfad, zeitstempelGesetztAm: null, zeitstempelDateiHash: null });

  const app = buildTestDownloadsApp(db, config); // reuse this file's existing app/config builder
  const url = buildSignedDownloadUrl(config, parentId, 300);
  const res = await request(app).get(url);

  assert.equal(res.status, 200);
  assert.equal(res.text, '%PDF-gruppe');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Add `markGruppeExportiert` to this test file's `jobsRepo.js` import if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/downloads.test.js`
Expected: FAIL — the route still serves `originalPfad`'s bytes.

- [ ] **Step 3: Implement in `src/routes/downloads.js`**

In the `GET /:jobId` handler, right after `const job = getJobById(db, jobId);` and its existing `if (!job || !existsSync(job.pdf_pfad))` guard, introduce the conditional path and use it everywhere `job.pdf_pfad` was read for file bytes:

```js
    const job = getJobById(db, jobId);
    const pfad = job?.gruppe_pdf_pfad || job?.pdf_pfad;
    if (!job || !existsSync(pfad)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const stream = createReadStream(pfad);
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(403).type('json').json(GENERIC_DENIAL);
    });
    res.type('application/pdf');
    const safeName = job.dateiname.replace(/[\r\n"]/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Content-Length', statSync(pfad).size);
    stream.pipe(res);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/downloads.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS — in particular, existing single-job downloads (`gruppe_pdf_pfad` is `NULL`) must still serve `pdf_pfad` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/routes/downloads.js test/integration/downloads.test.js
git commit -m "feat: serve the merged Gruppen-PDF via the signed download route when present"
```

---

## Task 10: End-zu-Ende-Integrationstest

**Files:**
- Test: `test/integration/splitgruppen-e2e.test.js` (neu)

**Interfaces:**
- Consumes: die komplette Feature-Kette aus Tasks 1–9 über echte HTTP-Routen (kein direkter Repo-/Service-Aufruf), um Regressionen an den Nahtstellen zwischen den Tasks abzufangen, die die isolierten Unit-/Integrationstests einzelner Tasks nicht sehen können.

- [ ] **Step 1: Write the end-to-end test**

Create `test/integration/splitgruppen-e2e.test.js`. Drives one invoice through 3 Konten across the real routes end to end: `POST /kontierung/:id/aufsplitten` (with `teilPosition`) → each of the 3 resulting Splitkinder through the real `POST /freigabe2/:id` route (Freigabe 1 is auto-granted by the Aufsplitten submission itself, per `kontierung.js`'s `istEigenesKonto` branch — see Task 3/6) → confirms `GET /api/n8n/jobs/abholbereit` returns exactly one combined group entry with 3 `positionen` (never 3 individual entries) → `POST /api/n8n/jobs/:id/abholung-bestaetigen` on the group id → confirms all 3 children are `abgeholt` and every file (3 Kind-PDFs, the merged Gruppen-PDF) is gone from disk.

To keep the login/Konto setup manageable in one test, all three Konten share the same Freigeber 1 (person `'1'`, the person submitting the Aufsplitten form) with three different Freigeber 2 (persons `'2'`, `'3'`, `'4'`) — this exercises the ordinary, non-conflict `istEigenesKonto` branch for all three rows, matching `kontierung.js:646-690`. The hinweis_konto_id ("fremdes Konto") branch is already covered in isolation by Task 2's unit tests and is not repeated here.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, getJobById, listSplitKinder } from '../../src/db/jobsRepo.js';
import { createApp } from '../../src/app.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
import { fetchCsrfToken } from '../helpers/csrf.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

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
    jobsDir,
    publicBaseUrl: 'https://portal.example.org',
    downloadSigningSecret: 'download-secret',
  };
}

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

test('a 3-Konten Aufsplitten flow ends in a single combined Bexio export, with all Splitkind files cleaned up after Abholung', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'splitgruppen-e2e-test-'));
  const config = testConfig(dir);
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Drei', email: 'f3@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Freigeber', nachname: 'Vier', email: 'f4@example.org', gruppen: ['10'], loggedInNow: false });

  const kontoA = createKonto(db, { kontonummer: '6500', bezeichnung: 'Unterhalt', freigeber1Id: '1', freigeber2Id: '2' });
  const kontoB = createKonto(db, { kontonummer: '6600', bezeichnung: 'Reinigung', freigeber1Id: '1', freigeber2Id: '3' });
  const kontoC = createKonto(db, { kontonummer: '6700', bezeichnung: 'Reparaturen', freigeber1Id: '1', freigeber2Id: '4' });
  const kontoNummerById = new Map([[kontoA, '6500'], [kontoB, '6600'], [kontoC, '6700']]);
  const freigeber2ByKonto = new Map([[kontoA, { id: 2, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org' }], [kontoB, { id: 3, vorname: 'Freigeber', nachname: 'Drei', email: 'f3@example.org' }], [kontoC, { id: 4, vorname: 'Freigeber', nachname: 'Vier', email: 'f4@example.org' }]]);

  const pdfPfad = join(dir, 'rechnung.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung Seite 1']));
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'lieferant', absender: 'lief@example.org', dateiname: 'rechnung.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const p1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  const aufsplittenToken = await fetchCsrfToken(p1Agent, `/kontierung/${jobId}/aufsplitten`);
  const aufsplittenRes = await p1Agent
    .post(`/kontierung/${jobId}/aufsplitten`)
    .type('form')
    .send({
      gesamtbetrag: '180.00',
      teilKontoId: [String(kontoA), String(kontoB), String(kontoC)],
      teilBetrag: ['60.00', '60.00', '60.00'],
      teilInteressenskonflikt: ['false', 'false', 'false'],
      teilPosition: ['Pos. 1', 'Pos. 2', 'Pos. 3'],
      begruendung: '',
      _csrf: aufsplittenToken,
    });
  assert.equal(aufsplittenRes.status, 302);

  const kinder = listSplitKinder(db, jobId);
  assert.equal(kinder.length, 3);
  assert.ok(kinder.every((k) => k.status === 'freigabe2'), 'auto-granted Freigabe 1 must put every Splitkind straight into freigabe2');

  for (const [i, kind] of kinder.entries()) {
    const freigeber2 = freigeber2ByKonto.get(kind.konto_id);
    const f2Agent = await loginAs(app, client, freigeber2);
    const token = await fetchCsrfToken(f2Agent, `/freigabe2/${kind.id}`);
    const res = await f2Agent.post(`/freigabe2/${kind.id}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '', _csrf: token });
    assert.equal(res.status, 302);

    const parentZwischenstand = getJobById(db, jobId);
    if (i < kinder.length - 1) {
      assert.equal(parentZwischenstand.gruppe_pdf_pfad, null, 'the group must not be exported before every sibling has completed Freigabe 2');
    } else {
      assert.ok(parentZwischenstand.gruppe_pdf_pfad, 'the group must be exported right after the last sibling completes Freigabe 2');
    }
  }

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', config.n8nApiKey);
  assert.equal(abholbereitRes.status, 200);
  const gruppenEintraege = abholbereitRes.body.filter((e) => e.id === jobId);
  assert.equal(gruppenEintraege.length, 1, 'exactly one combined group entry, not one per Splitkind');
  assert.equal(gruppenEintraege[0].positionen.length, 3);
  assert.deepEqual(gruppenEintraege[0].positionen.map((p) => p.position).sort(), ['Pos. 1', 'Pos. 2', 'Pos. 3']);
  for (const kind of kinder) {
    assert.ok(!abholbereitRes.body.some((e) => e.id === kind.id), 'Splitkinder must never appear as individual abholbereit entries');
  }

  const parentVorAbholung = getJobById(db, jobId);
  const bestaetigenRes = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', config.n8nApiKey);
  assert.equal(bestaetigenRes.status, 200);

  for (const kind of kinder) {
    assert.equal(getJobById(db, kind.id).status, 'abgeholt');
    assert.equal(existsSync(kind.pdf_pfad), false, `Splitkind ${kind.id}'s own PDF must be deleted after Abholung`);
  }
  assert.equal(existsSync(parentVorAbholung.gruppe_pdf_pfad), false, 'the merged Gruppen-PDF must be deleted after Abholung');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/integration/splitgruppen-e2e.test.js`
Expected: PASS (write and iterate until green — this test exercises every task's integration points together, so a failure here points at a seam between tasks rather than a single unit)

- [ ] **Step 3: Run the entire suite one final time**

Run: `npm test`
Expected: PASS, zero regressions across the whole app.

- [ ] **Step 4: Commit**

```bash
git add test/integration/splitgruppen-e2e.test.js
git commit -m "test: add end-to-end coverage for the combined Splitgruppen Bexio export"
```

---

## Nicht Teil dieses Plans

Deckt sich mit der Spec's "Nicht Teil von diesem Batch": kein neuer `admin_config`-Umschalter (Verhalten ersetzt den Einzel-Export ersatzlos), keine Änderung am n8n-seitigen Bexio-/Paperless-ngx-Versandweg, kein manuelles Admin-UI zum Exportieren unvollständiger/blockierter Gruppen, keine Nachträgliche-Korrektur-Logik für ein bereits abgeholtes Gruppendokument.
