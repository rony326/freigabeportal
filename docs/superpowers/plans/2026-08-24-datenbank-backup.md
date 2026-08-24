# Datenbank-Backup & Wiederherstellung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a superadmin-only backup/restore feature for the Freigabeportal: manual + scheduled backups of the SQLite DB plus `JOBS_DIR`/`BRANDING_DIR` as a single ZIP archive, local retention, download/delete, a confirmation-gated restore path, and an n8n-pull endpoint for offsite delivery.

**Architecture:** A new `src/services/backup.js` builds/validates/restores ZIP archives (SQLite `VACUUM INTO` + `adm-zip`). A new scheduled job (`services/cronJobs.js` + `services/scheduler.js`, same three-trigger-path pattern as the existing jobs) produces backups into a new `BACKUP_DIR`. A new superadmin-only admin page (`/admin/backup`) exposes schedule config, manual trigger, download/delete, and restore. A new `GET /api/n8n/backup/latest` (same `X-API-Key` guard as `/api/n8n/jobs`) lets an external n8n workflow pull the newest backup for offsite storage — no native WebDAV client is built (see spec's "Nicht Teil von diesem Design").

**Tech Stack:** Node.js/Express, `node:sqlite` (`DatabaseSync`), EJS, `adm-zip` (new dependency), `multer` (existing dependency, memory storage), `node --test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-08-24-datenbank-backup-design.md`

## Global Constraints

- Node.js ≥22.13.0, `node:sqlite` (no `--experimental-sqlite` flag needed) — see `package.json` `engines`.
- All new admin_config keys, table/column names, and route paths use the same German naming convention as the rest of the codebase (see existing repos/routes).
- `/admin/backup` is superadmin-only (`requireRole(config, 'superadmin')`), **not** a grantable individual permission — matches `/admin/eskalation`, `/admin/erscheinungsbild`, `/admin/zeitstempel`.
- No `process.exit()` and no attempt to swap the running `db` connection during restore — file-level replace only, with a clear "restart manually" instruction in the UI. See spec's "Kontext" section for why.
- Every new CHECK-constraint widening on an existing table follows the established rebuild-in-a-transaction pattern in `src/db/index.js` (SQLite cannot `ALTER TABLE` a `CHECK`).
- Test files go under `test/unit/` (pure logic, e.g. services/db) or `test/integration/admin/` and `test/integration/n8n/` (routes), matching the existing directory split.

---

## Task 1: Config & dependency setup

**Files:**
- Modify: `package.json` (add `adm-zip` dependency)
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `src/db/adminConfigRepo.js`
- Test: `test/unit/env.test.js`

**Interfaces:**
- Produces: `config.backupDir` (string, default `'./data/backups'`) — consumed by every later task.
- Produces: `admin_config` defaults `backup_cron_stunde` (`'3'`), `backup_cron_minute` (`'0'`), `backup_aufbewahrung_anzahl` (`'14'`) — consumed by Tasks 5–7.

- [ ] **Step 1: Install the new dependency**

Run: `npm install adm-zip@^0.6.0`

Expected: `package.json` gains `"adm-zip": "^0.6.0"` under `dependencies`, `package-lock.json` updates, `node_modules/adm-zip` exists.

- [ ] **Step 2: Write the failing test for `backupDir` config**

Add to `test/unit/env.test.js` (after the existing `loadConfig returns full config...` test):

```js
test('loadConfig defaults backupDir to ./data/backups and honors BACKUP_DIR', () => {
  const defaultConfig = loadConfig(FULL_ENV);
  assert.equal(defaultConfig.backupDir, './data/backups');

  const customConfig = loadConfig({ ...FULL_ENV, BACKUP_DIR: '/srv/backups' });
  assert.equal(customConfig.backupDir, '/srv/backups');
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `node --test test/unit/env.test.js`
Expected: FAIL — `defaultConfig.backupDir` is `undefined`.

- [ ] **Step 3: Add `backupDir` to `loadConfig`**

In `src/config/env.js`, in the object returned by `loadConfig`, right after the existing `jobsDir` line:

```js
    jobsDir: env.JOBS_DIR || './data/jobs',
    backupDir: env.BACKUP_DIR || './data/backups',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/env.test.js`
Expected: PASS

- [ ] **Step 5: Add the three new `admin_config` defaults**

In `src/db/adminConfigRepo.js`, add to `DEFAULTS` (after `zeitstempel_warnung_ab_stunden`):

```js
  backup_cron_stunde: '3',
  backup_cron_minute: '0',
  backup_aufbewahrung_anzahl: '14',
```

No dedicated test here — Task 5/6/7 exercise these values directly; `adminConfigRepo.test.js` already covers `seedDefaults`/`getConfigValue` generically.

- [ ] **Step 6: Document `BACKUP_DIR` in `.env.example`**

In `.env.example`, right after the existing `JOBS_DIR` line:

```
# Speicherort fuer hochgeladene Rechnungs-PDFs (n8n-Schnittstelle)
JOBS_DIR=./data/jobs
# Speicherort fuer Datenbank-Backups (manuell + geplant, siehe Admin -> Datenbank-Backup)
BACKUP_DIR=./data/backups
```

- [ ] **Step 7: Document `BACKUP_DIR` in README's Datenverzeichnisse bullet**

In `README.md`, find:

```
- **Datenverzeichnisse** (`DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`, siehe
  unten): alle drei werden von der App beim ersten Zugriff automatisch
```

Replace with:

```
- **Datenverzeichnisse** (`DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`,
  `BACKUP_DIR`, siehe unten): alle vier werden von der App beim ersten
  Zugriff automatisch
```

- [ ] **Step 8: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS (same failure/pass count as before this task, plus the new env test)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/config/env.js .env.example README.md src/db/adminConfigRepo.js test/unit/env.test.js
git commit -m "feat: add BACKUP_DIR config and admin_config defaults for scheduled backups"
```

---

## Task 2: `backup_wiederherstellungen` audit table + repo

**Files:**
- Modify: `src/db/schema.sql`
- Create: `src/db/backupWiederherstellungenRepo.js`
- Test: `test/unit/db.test.js` (table existence)
- Test: Create `test/unit/backupWiederherstellungenRepo.test.js`

**Interfaces:**
- Produces: `logBackupWiederherstellung(db, { dateiname, wiederhergestelltVon })` → `number` (inserted id)
- Produces: `listBackupWiederherstellungen(db)` → array of rows (`id`, `dateiname`, `wiederhergestellt_von`, `zeitpunkt`), newest first
- Consumed by: Task 3 (`services/backup.js`), Task 7 (admin route's history view)

- [ ] **Step 1: Write the failing table-existence test**

Add to `test/unit/db.test.js`, inside the existing `'openDatabase creates all expected tables'` test, add `'backup_wiederherstellungen'` to the array of expected table names:

```js
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln', 'jobs', 'freigaben', 'mail_log', 'job_loeschungen', 'cron_log', 'backup_wiederherstellungen']) {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/db.test.js`
Expected: FAIL — `missing table backup_wiederherstellungen`

- [ ] **Step 3: Add the table to `schema.sql`**

In `src/db/schema.sql`, append after the existing `job_loeschungen` table definition:

```sql

-- Audit-Trail für Datenbank-Wiederherstellungen (Admin -> Datenbank-Backup). Eigene, schlanke
-- Tabelle statt Zweckentfremdung von cron_log: anders als bei den geplanten Jobs muss hier
-- festgehalten werden, welche Person eine Wiederherstellung ausgelöst hat.
CREATE TABLE IF NOT EXISTS backup_wiederherstellungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dateiname TEXT NOT NULL,
  wiederhergestellt_von TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  zeitpunkt TEXT NOT NULL
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/db.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing repo test**

Create `test/unit/backupWiederherstellungenRepo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { logBackupWiederherstellung, listBackupWiederherstellungen } from '../../src/db/backupWiederherstellungenRepo.js';

test('logBackupWiederherstellung inserts a row and listBackupWiederherstellungen returns it newest first', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Portal', email: 'a@example.org', gruppen: [], loggedInNow: false });

  const id1 = logBackupWiederherstellung(db, { dateiname: 'erstes-backup.zip', wiederhergestelltVon: '1' });
  const id2 = logBackupWiederherstellung(db, { dateiname: 'zweites-backup.zip', wiederhergestelltVon: '1' });

  assert.ok(id2 > id1);
  const eintraege = listBackupWiederherstellungen(db);
  assert.equal(eintraege.length, 2);
  assert.equal(eintraege[0].dateiname, 'zweites-backup.zip', 'newest first');
  assert.equal(eintraege[0].wiederhergestellt_von, '1');
  assert.ok(eintraege[0].zeitpunkt);
  db.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/unit/backupWiederherstellungenRepo.test.js`
Expected: FAIL — module `src/db/backupWiederherstellungenRepo.js` not found.

- [ ] **Step 7: Implement the repo**

Create `src/db/backupWiederherstellungenRepo.js`:

```js
export function logBackupWiederherstellung(db, { dateiname, wiederhergestelltVon }) {
  const result = db
    .prepare(
      `INSERT INTO backup_wiederherstellungen (dateiname, wiederhergestellt_von, zeitpunkt)
       VALUES (?, ?, ?)`
    )
    .run(dateiname, wiederhergestelltVon, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listBackupWiederherstellungen(db) {
  return db.prepare('SELECT * FROM backup_wiederherstellungen ORDER BY id DESC').all();
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/unit/backupWiederherstellungenRepo.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/backupWiederherstellungenRepo.js test/unit/db.test.js test/unit/backupWiederherstellungenRepo.test.js
git commit -m "feat: add backup_wiederherstellungen audit table and repo"
```

---

## Task 3: `services/backup.js` — build, validate, restore

**Files:**
- Create: `src/services/backup.js`
- Test: Create `test/unit/backup.test.js`

**Interfaces:**
- Consumes: `logBackupWiederherstellung` from Task 2 (`src/db/backupWiederherstellungenRepo.js`)
- Consumes: `config.jobsDir`, `config.brandingDir`, `config.backupDir`, `config.dbPath` from Task 1
- Produces: `backupDateiname(date = new Date())` → `string`, matching `BACKUP_DATEINAME_PATTERN`
- Produces: `BACKUP_DATEINAME_PATTERN` → `RegExp`, exported for reuse in Tasks 5, 7, 9
- Produces: `class BackupValidationError extends Error {}`, exported
- Produces: `buildBackupArchive(db, config)` → `Buffer` (zip bytes) — consumed by Tasks 5, 7 (safety snapshot happens internally in `restoreBackupArchive`, not called directly elsewhere)
- Produces: `validateBackupArchive(buffer)` → `{ zip: AdmZip, manifest: object }`, throws `BackupValidationError` — consumed internally and by Task 8's route error handling (via `restoreBackupArchive`)
- Produces: `restoreBackupArchive(buffer, db, config, { wiederhergestelltVon, quellDateiname })` → `{ sicherheitsSnapshotDateiname: string }`, throws `BackupValidationError` — consumed by Task 8

- [ ] **Step 1: Write the failing filename-format test**

Create `test/unit/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listBackupWiederherstellungen } from '../../src/db/backupWiederherstellungenRepo.js';
import {
  buildBackupArchive,
  validateBackupArchive,
  restoreBackupArchive,
  backupDateiname,
  BACKUP_DATEINAME_PATTERN,
  BackupValidationError,
} from '../../src/services/backup.js';

test('backupDateiname produces a filesystem-safe name matching BACKUP_DATEINAME_PATTERN', () => {
  const name = backupDateiname(new Date('2026-08-24T13:05:00.123Z'));
  assert.equal(name, 'backup-2026-08-24T13-05-00-123Z.zip');
  assert.match(name, BACKUP_DATEINAME_PATTERN);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/backup.test.js`
Expected: FAIL — module `src/services/backup.js` not found.

- [ ] **Step 3: Implement `src/services/backup.js`**

Create `src/services/backup.js`:

```js
import AdmZip from 'adm-zip';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, renameSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logBackupWiederherstellung } from '../db/backupWiederherstellungenRepo.js';

const REQUIRED_TABLES = ['jobs', 'personen', 'konten'];
const FORMAT_VERSION = 1;

export const BACKUP_DATEINAME_PATTERN = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

export function backupDateiname(date = new Date()) {
  return `backup-${date.toISOString().replace(/[:.]/g, '-')}.zip`;
}

export class BackupValidationError extends Error {}

// SQLite-eigener Online-Backup-Mechanismus (funktioniert bei laufendem Betrieb, kein Lock auf der
// Live-Verbindung nötig) -- VACUUM INTO verlangt einen noch nicht existierenden Zielpfad, daher
// ein frisches Tempverzeichnis statt eines festen Dateinamens.
export function buildBackupArchive(db, config) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-backup-'));
  try {
    const dbSnapshotPfad = join(tmpDir, 'db.sqlite');
    db.prepare('VACUUM INTO ?').run(dbSnapshotPfad);

    const zip = new AdmZip();
    zip.addLocalFile(dbSnapshotPfad, '', 'db.sqlite');
    if (existsSync(config.jobsDir)) zip.addLocalFolder(config.jobsDir, 'jobs');
    if (existsSync(config.brandingDir)) zip.addLocalFolder(config.brandingDir, 'branding');
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ formatVersion: FORMAT_VERSION, erstelltAm: new Date().toISOString() }, null, 2))
    );
    return zip.toBuffer();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Validiert vollständig, BEVOR restoreBackupArchive irgendetwas Live anfasst -- wirft
// BackupValidationError mit einer für Admins verständlichen deutschen Meldung statt eines
// generischen Fehlers.
export function validateBackupArchive(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new BackupValidationError('Datei ist kein gültiges ZIP-Archiv.');
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new BackupValidationError('Archiv enthält keine manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch {
    throw new BackupValidationError('manifest.json ist kein gültiges JSON.');
  }

  const dbEntry = zip.getEntry('db.sqlite');
  if (!dbEntry) throw new BackupValidationError('Archiv enthält keine db.sqlite.');

  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-restore-validate-'));
  try {
    zip.extractEntryTo(dbEntry, tmpDir, false, true, false, 'db.sqlite');
    const tmpDbPfad = join(tmpDir, 'db.sqlite');
    let testDb;
    try {
      testDb = new DatabaseSync(tmpDbPfad);
    } catch {
      throw new BackupValidationError('db.sqlite im Archiv lässt sich nicht als SQLite-Datenbank öffnen.');
    }
    try {
      const tables = new Set(testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const required of REQUIRED_TABLES) {
        if (!tables.has(required)) {
          throw new BackupValidationError(`db.sqlite im Archiv hat keine Tabelle "${required}" — kein gültiges Freigabeportal-Backup.`);
        }
      }
    } finally {
      testDb.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { zip, manifest };
}

function ersetzeVerzeichnisInhalt(zielVerzeichnis, quellVerzeichnis) {
  mkdirSync(zielVerzeichnis, { recursive: true });
  for (const name of readdirSync(zielVerzeichnis)) {
    rmSync(join(zielVerzeichnis, name), { recursive: true, force: true });
  }
  if (existsSync(quellVerzeichnis)) {
    for (const name of readdirSync(quellVerzeichnis)) {
      cpSync(join(quellVerzeichnis, name), join(zielVerzeichnis, name), { recursive: true });
    }
  }
}

// Kein process.exit(), kein Versuch, die laufende `db`-Verbindung live auszutauschen -- siehe
// Design-Spec (docs/superpowers/specs/2026-08-24-datenbank-backup-design.md, Abschnitt "Kontext").
// `db` wird hier nur für den Sicherheits-Snapshot (VACUUM INTO vom noch unveränderten Live-Stand)
// gebraucht.
export function restoreBackupArchive(buffer, db, config, { wiederhergestelltVon, quellDateiname }) {
  const { zip } = validateBackupArchive(buffer);

  const sicherheitsSnapshot = buildBackupArchive(db, config);
  mkdirSync(config.backupDir, { recursive: true });
  const sicherheitsDateiname = backupDateiname(new Date());
  writeFileSync(join(config.backupDir, sicherheitsDateiname), sicherheitsSnapshot);

  const tmpDir = mkdtempSync(join(tmpdir(), 'freigabeportal-restore-'));
  try {
    zip.extractAllTo(tmpDir, true);

    // Neue DB-Datei komplett schreiben, dann atomar per renameSync an DB_PATH -- niemals in-place
    // über die von der laufenden DatabaseSync-Verbindung offen gehaltene Datei schreiben.
    const dbTmpPfad = `${config.dbPath}.restore-${randomUUID()}.tmp`;
    copyFileSync(join(tmpDir, 'db.sqlite'), dbTmpPfad);
    renameSync(dbTmpPfad, config.dbPath);

    ersetzeVerzeichnisInhalt(config.jobsDir, join(tmpDir, 'jobs'));
    ersetzeVerzeichnisInhalt(config.brandingDir, join(tmpDir, 'branding'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // `db` (die lang laufende Verbindung des aufrufenden Prozesses) zeigt weiterhin auf die alte
  // Datei -- renameSync tauscht nur den Verzeichniseintrag, das offene File-Handle bleibt am alten
  // Inode. Ein Log-Eintrag über `db` würde also in eine Datei geschrieben, die beim nächsten
  // Prozess-Neustart verworfen wird, sobald die gerade wiederhergestellte Datei übernommen wird.
  // Eine frische, kurzlebige Verbindung direkt auf die neue Datei ist der einzige Weg, wie dieser
  // Audit-Eintrag den Neustart übersteht.
  const restoredDb = new DatabaseSync(config.dbPath);
  try {
    logBackupWiederherstellung(restoredDb, { dateiname: quellDateiname, wiederhergestelltVon });
  } finally {
    restoredDb.close();
  }

  return { sicherheitsSnapshotDateiname: sicherheitsDateiname };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/backup.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing roundtrip test (highest-value test per spec)**

Append to `test/unit/backup.test.js`:

```js
test('buildBackupArchive + restoreBackupArchive roundtrip: DB rows and files survive identically into a fresh location', () => {
  const quellDir = mkdtempSync(join(tmpdir(), 'backup-quelle-'));
  const zielDir = mkdtempSync(join(tmpdir(), 'backup-ziel-'));
  const quellConfig = {
    jobsDir: join(quellDir, 'jobs'),
    brandingDir: join(quellDir, 'branding'),
    backupDir: join(quellDir, 'backups'),
    dbPath: join(quellDir, 'quelle.sqlite'),
  };
  const zielConfig = {
    jobsDir: join(zielDir, 'jobs'),
    brandingDir: join(zielDir, 'branding'),
    backupDir: join(zielDir, 'backups'),
    dbPath: join(zielDir, 'ziel.sqlite'),
  };

  mkdirSync(quellConfig.jobsDir, { recursive: true });
  mkdirSync(quellConfig.brandingDir, { recursive: true });
  writeFileSync(join(quellConfig.jobsDir, 'rechnung.pdf'), 'pdf-inhalt');
  writeFileSync(join(quellConfig.brandingDir, 'logo.png'), 'logo-inhalt');

  const quellDb = openDatabase(quellConfig.dbPath);
  seedDefaults(quellDb);
  upsertPerson(quellDb, { id: '1', vorname: 'Test', nachname: 'Person', email: 't@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(quellDb, {
    eingangAm: '2026-08-01T00:00:00.000Z',
    quelle: 'scanner',
    absender: null,
    dateiname: 'rechnung.pdf',
    pdfPfad: join(quellConfig.jobsDir, 'rechnung.pdf'),
  });

  const archiv = buildBackupArchive(quellDb, quellConfig);
  quellDb.close();

  const zielDb = openDatabase(zielConfig.dbPath);
  const { sicherheitsSnapshotDateiname } = restoreBackupArchive(archiv, zielDb, zielConfig, {
    wiederhergestelltVon: '1',
    quellDateiname: 'hochgeladenes-backup.zip',
  });
  zielDb.close();

  // Sicherheits-Snapshot des (leeren) Ziel-Standes vor dem Überschreiben wurde geschrieben.
  assert.match(sicherheitsSnapshotDateiname, BACKUP_DATEINAME_PATTERN);
  assert.ok(readdirSync(zielConfig.backupDir).includes(sicherheitsSnapshotDateiname));

  // DB-Inhalt kam vollständig an.
  const wiederhergestellteDb = openDatabase(zielConfig.dbPath);
  const wiederhergestellterJob = getJobById(wiederhergestellteDb, jobId);
  assert.equal(wiederhergestellterJob.dateiname, 'rechnung.pdf');

  // Der Restore-Audit-Eintrag wurde direkt in die wiederhergestellte Datei geschrieben (siehe
  // Kommentar in restoreBackupArchive).
  const eintraege = listBackupWiederherstellungen(wiederhergestellteDb);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'hochgeladenes-backup.zip');
  assert.equal(eintraege[0].wiederhergestellt_von, '1');
  wiederhergestellteDb.close();

  // Dateien kamen vollständig an.
  assert.equal(readFileSync(join(zielConfig.jobsDir, 'rechnung.pdf'), 'utf8'), 'pdf-inhalt');
  assert.equal(readFileSync(join(zielConfig.brandingDir, 'logo.png'), 'utf8'), 'logo-inhalt');

  rmSync(quellDir, { recursive: true, force: true });
  rmSync(zielDir, { recursive: true, force: true });
});

test('validateBackupArchive throws BackupValidationError for a non-ZIP buffer', () => {
  assert.throws(() => validateBackupArchive(Buffer.from('not a zip file')), BackupValidationError);
});

test('validateBackupArchive throws BackupValidationError for a ZIP missing db.sqlite', () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  assert.throws(() => validateBackupArchive(zip.toBuffer()), BackupValidationError);
});
```

These tests (filename format, roundtrip, the two `validateBackupArchive` throw-cases) already cover the spec's testing requirements for this module ("kaputtes/fremdes ZIP wird abgelehnt") — no further validation-error test is needed, since `openDatabase` always produces the three `REQUIRED_TABLES` and there's no cheap way to produce a "real SQLite file missing those tables" without hand-rolling schema, which would test `REQUIRED_TABLES` plumbing rather than anything a real backup file could ever violate.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/unit/backup.test.js`
Expected: PASS (4 tests: filename format, roundtrip, non-ZIP, missing db.sqlite)

- [ ] **Step 7: Commit**

```bash
git add src/services/backup.js test/unit/backup.test.js
git commit -m "feat: add backup archive build/validate/restore service"
```

---

## Task 4: Widen `cron_log.job` CHECK to include `'datenbank-sicherung'`

**Files:**
- Modify: `src/db/index.js`
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `cron_log` accepts `job = 'datenbank-sicherung'` — consumed by Task 5 (`startCronLauf`/`finishCronLauf`/`hasRecentRunningCronLauf`)

- [ ] **Step 1: Write the failing test**

Add to `test/unit/db.test.js` (after the existing cron_log migration tests):

```js
test('openDatabase rebuilds the cron_log table to widen its job CHECK constraint to include datenbank-sicherung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen')),
      gestartet_am TEXT NOT NULL,
      beendet_am TEXT,
      status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
      details TEXT
    );
    INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details)
      VALUES ('zeitstempel-nachholen', '2026-08-15T08:00:00.000Z', '2026-08-15T08:00:05.000Z', 'erfolg', 'Nachgeholt: 1');
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);

  const preserved = migratedDb.prepare('SELECT * FROM cron_log WHERE id = 1').get();
  assert.ok(preserved, 'existing rows must survive the rebuild');
  assert.equal(preserved.job, 'zeitstempel-nachholen');

  assert.doesNotThrow(
    () =>
      migratedDb
        .prepare("INSERT INTO cron_log (job, gestartet_am, beendet_am, status, details) VALUES ('datenbank-sicherung', '2026-08-24T03:00:00.000Z', NULL, 'laufend', NULL)")
        .run(),
    'the widened CHECK constraint must accept datenbank-sicherung'
  );

  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/db.test.js`
Expected: FAIL — the current `migrateCronLogTable` early-returns because the legacy table already contains `'zeitstempel-nachholen'` and `'laufend'`, so it never widens further; the `INSERT` with `'datenbank-sicherung'` throws a CHECK-constraint error.

- [ ] **Step 3: Update `migrateCronLogTable` in `src/db/index.js`**

Replace the whole function (the marker check moves forward to the newest value, per the pattern documented in this same function's comment and in `migrateFreigabenTable`):

```js
// Same rationale as migrateFreigabenTable above: an already-existing cron_log table (any database
// that predates the 'datenbank-sicherung' job name) keeps its original, narrower schema forever
// otherwise, and startCronLauf('datenbank-sicherung', ...) would fail on it. The marker value this
// function checks for moves forward each time the CHECK is widened again -- check the CREATE TABLE
// below for what it currently allows, not this comment.
function migrateCronLogTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('datenbank-sicherung')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_datenbank_sicherung');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_datenbank_sicherung
    `);
    db.exec('DROP TABLE cron_log_pre_datenbank_sicherung');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

This still correctly migrates a table that predates `'laufend'`/`'zeitstempel-nachholen'` too (an ancient table): the marker check only looks for `'datenbank-sicherung'`, so any table missing it gets fully rebuilt to the current shape regardless of how old it is — the column list is unchanged between all these migrations, only the `job` CHECK's value list differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/db.test.js`
Expected: PASS (all cron_log migration tests, including the pre-existing ones for the `'zeitstempel-nachholen'` widening — verify those still pass too, since the marker changed).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/index.js test/unit/db.test.js
git commit -m "feat: widen cron_log job CHECK constraint to accept datenbank-sicherung"
```

---

## Task 5: `runDatenbankSicherungJob` in `services/cronJobs.js`

**Files:**
- Modify: `src/services/cronJobs.js`
- Test: `test/unit/cronJobs.test.js` (check the existing file's import/helper style before adding — mirror it)

**Interfaces:**
- Consumes: `buildBackupArchive`, `backupDateiname`, `BACKUP_DATEINAME_PATTERN` from Task 3 (`src/services/backup.js`)
- Consumes: `startCronLauf`, `finishCronLauf`, `hasRecentRunningCronLauf` from `src/db/cronLogRepo.js` (existing)
- Consumes: `getConfigValue` for `backup_aufbewahrung_anzahl` from Task 1
- Produces: `runDatenbankSicherungJob(db, config)` → `{ status: 'erfolg' | 'fehler' | 'uebersprungen', dateiname?, groesseBytes?, bereinigt?, error?, meldung? }` — consumed by Task 6 (scheduler) and Task 7 (admin route's manual trigger)

- [ ] **Step 1: Write the failing test**

`test/unit/cronJobs.test.js` currently starts with these imports (verified — do not assume, this is the exact current content):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listRecentCronLog, startCronLauf } from '../../src/db/cronLogRepo.js';
import { runZeitstempelNachholenJob } from '../../src/services/cronJobs.js';
import { setupMockTsa } from '../helpers/mockTsa.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';
```

`openDatabase`, `setConfigValue`, `listRecentCronLog`, `mkdtempSync`/`rmSync`/`tmpdir`/`join` are already imported — only three additions are needed:

1. Add `readdirSync` to the existing `node:fs` import: `import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';`
2. Add `runDatenbankSicherungJob` to the existing cronJobs.js import: `import { runZeitstempelNachholenJob, runDatenbankSicherungJob } from '../../src/services/cronJobs.js';`
3. Add a new import line: `import { BACKUP_DATEINAME_PATTERN } from '../../src/services/backup.js';`

Then append this test to the file (no `seedDefaults` needed — `setConfigValue` upserts regardless of whether a default row exists, matching this file's existing minimal-setup style):

```js
test('runDatenbankSicherungJob writes a backup file, logs to cron_log, and prunes beyond the retention count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cronjobs-backup-test-'));
  const config = {
    jobsDir: join(dir, 'jobs'),
    brandingDir: join(dir, 'branding'),
    backupDir: join(dir, 'backups'),
    dbPath: join(dir, 'db.sqlite'),
  };
  const db = openDatabase(config.dbPath);
  setConfigValue(db, 'backup_aufbewahrung_anzahl', '2');

  const erstesErgebnis = runDatenbankSicherungJob(db, config);
  assert.equal(erstesErgebnis.status, 'erfolg');
  assert.match(erstesErgebnis.dateiname, BACKUP_DATEINAME_PATTERN);
  assert.ok(erstesErgebnis.groesseBytes > 0);
  assert.equal(erstesErgebnis.bereinigt, 0);

  runDatenbankSicherungJob(db, config);
  const drittesErgebnis = runDatenbankSicherungJob(db, config);
  assert.equal(drittesErgebnis.bereinigt, 1, 'retention of 2 must prune the oldest of 3 backups');

  const uebrig = readdirSync(config.backupDir).filter((name) => BACKUP_DATEINAME_PATTERN.test(name));
  assert.equal(uebrig.length, 2);
  assert.ok(!uebrig.includes(erstesErgebnis.dateiname), 'the oldest backup must have been pruned');

  const log = listRecentCronLog(db, 'datenbank-sicherung', 10);
  assert.equal(log.length, 3);
  assert.equal(log[0].status, 'erfolg');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/cronJobs.test.js`
Expected: FAIL — `runDatenbankSicherungJob` is not exported.

- [ ] **Step 3: Implement `runDatenbankSicherungJob`**

In `src/services/cronJobs.js`:

1. `src/services/cronJobs.js` currently starts with:

```js
import { existsSync, unlinkSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
```

`readdirSync`, `writeFileSync`, and `join` are already imported (verified — do not re-add any of these, a duplicate import declaration is a syntax error). Only `mkdirSync` (from `node:fs`) and everything from `./backup.js` are new. Add `mkdirSync` to the existing `node:fs` import line, and add one new import line for `./backup.js`, right after the `node:crypto` import line:

```js
import { existsSync, unlinkSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { buildBackupArchive, backupDateiname, BACKUP_DATEINAME_PATTERN } from './backup.js';
```

2. Append the new function at the end of the file, after `runZeitstempelNachholenJob`:

```js

// Läuft wie zeitstempel-nachholen mit Zwei-Phasen-Logging (Overlap-Guard) statt des
// Einzelschuss-logCronLauf der schnellen Jobs -- das Zippen von JOBS_DIR/BRANDING_DIR kann bei
// vielen Dateien länger dauern als pool-erinnerungen/pdf-bereinigung.
export function runDatenbankSicherungJob(db, config) {
  if (hasRecentRunningCronLauf(db, 'datenbank-sicherung')) {
    return { status: 'uebersprungen', meldung: 'Ein Backup-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'datenbank-sicherung');
  try {
    mkdirSync(config.backupDir, { recursive: true });
    const archiv = buildBackupArchive(db, config);
    const dateiname = backupDateiname(new Date());
    writeFileSync(join(config.backupDir, dateiname), archiv);

    const aufbewahrungAnzahl = Number(getConfigValue(db, 'backup_aufbewahrung_anzahl')) || 14;
    const vorhandene = readdirSync(config.backupDir)
      .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
      .sort();
    let bereinigt = 0;
    const zuLoeschendeAnzahl = vorhandene.length - aufbewahrungAnzahl;
    for (let i = 0; i < zuLoeschendeAnzahl; i += 1) {
      unlinkSync(join(config.backupDir, vorhandene[i]));
      bereinigt += 1;
    }

    const ergebnis = { status: 'erfolg', dateiname, groesseBytes: archiv.length, bereinigt };
    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Datei: ${dateiname}, Grösse: ${archiv.length} Bytes, Bereinigt: ${bereinigt}`,
    });
    return ergebnis;
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/cronJobs.js test/unit/cronJobs.test.js
git commit -m "feat: add runDatenbankSicherungJob with retention pruning"
```

---

## Task 6: Wire the scheduled job into `services/scheduler.js`

**Files:**
- Modify: `src/services/scheduler.js`
- Modify: `docs/geplante-jobs-und-benachrichtigungen.md`
- Test: `test/scheduler.test.js` (check its exact current path with `find test -iname scheduler.test.js` before editing — it lives at repo-root `test/`, not `test/unit/`)

**Interfaces:**
- Consumes: `runDatenbankSicherungJob` from Task 5
- Produces: `startScheduler` now also runs the backup job daily, reading `backup_cron_stunde`/`backup_cron_minute` from `admin_config` on every tick (same pattern as `cron_pdf_bereinigung_stunde`/`_minute`)

- [ ] **Step 1: Write the failing test**

In `test/scheduler.test.js`, add `runDatenbankSicherungJob: () => ({ status: 'erfolg' })` to the `fakeJobs()` helper's returned object. Then add a new test, using `t.mock.timers.enable`'s `now` option (verified available in this Node version — pins `Date.now()`/`new Date()` for the duration of the test, exactly like the `enable({ apis: [...] })` calls elsewhere in this file, just with a fixed starting instant so the "how far to 03:00" delay is deterministic):

```js
test('startScheduler runs the daily datenbank-sicherung job at the configured time (default 03:00)', async (t) => {
  // 2026-01-15T00:00:00Z is 01:00 in Zurich (CET, UTC+1) -- 03:00 is 2 hours away.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-01-15T00:00:00.000Z') });
  const db = seededDb();
  let calls = 0;
  startScheduler({
    db,
    config: {},
    mailer: {},
    jobs: fakeJobs({ runDatenbankSicherungJob: () => { calls += 1; return { status: 'erfolg' }; } }),
  });

  t.mock.timers.tick(2 * 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler.test.js`
Expected: FAIL — `calls` stays `0` (the job is never invoked because `startScheduler` doesn't know about it yet).

- [ ] **Step 3: Wire it into `startScheduler`**

In `src/services/scheduler.js`:

1. Update the import at the top:

```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runDatenbankSicherungJob } from './cronJobs.js';
```

2. Update the `startScheduler` destructured parameter (both the renamed-binding list and the default object) to add the fifth job:

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
  } = {
    runSyncPersonenJob,
    runPoolErinnerungenJob,
    runPdfBereinigungJob,
    runZeitstempelNachholenJob,
    runDatenbankSicherungJob,
  },
}) {
```

3. Add a fifth `scheduleDaily` call, after the existing `zeitstempel-nachholen` `scheduleInterval` block, at the end of the function body (before the closing `}`):

```js

  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'backup_cron_stunde'), 3),
    () => zahlOderStandard(getConfigValue(db, 'backup_cron_minute'), 0),
    () => {
      const result = sicherungJob(db, config);
      if (result.status === 'fehler') console.error('Geplanter datenbank-sicherung-Lauf fehlgeschlagen:', result.error);
    }
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Update `docs/geplante-jobs-und-benachrichtigungen.md`**

Change the section heading `## Die vier Jobs` to `## Die fünf Jobs`, and add a row to the existing table:

```
| `datenbank-sicherung` | täglich 03:00 | DB + `JOBS_DIR` + `BRANDING_DIR` als ZIP nach `BACKUP_DIR` sichern, alte Backups über die konfigurierte Aufbewahrung hinaus löschen |
```

After the existing `### zeitstempel-nachholen` subsection, add:

```markdown

### `datenbank-sicherung`

Sichert DB + `JOBS_DIR` + `BRANDING_DIR` als ein ZIP-Archiv nach
`BACKUP_DIR`, löscht danach alte Backups über die konfigurierte
Aufbewahrung (Default: die letzten 14) hinaus. Läuft mit demselben
Überlappungsschutz wie `zeitstempel-nachholen`. Anders als die anderen
vier Jobs lebt die Konfiguration (Zeitplan, Aufbewahrung) **nicht** unter
**Admin → Geplante Jobs**, sondern auf einer eigenen, superadmin-only
Seite **Admin → Datenbank-Backup** — das Archiv enthält Geheimnisse im
Klartext (u. a. das RFC3161-TSA-Passwort), siehe
[admin-bereich.md](admin-bereich.md#datenbank-backup-adminbackup).
```

- [ ] **Step 7: Commit**

```bash
git add src/services/scheduler.js test/scheduler.test.js docs/geplante-jobs-und-benachrichtigungen.md
git commit -m "feat: schedule datenbank-sicherung as the fifth in-process background job"
```

---

## Task 7: Admin page `/admin/backup` — list, schedule, manual trigger, download, delete

**Files:**
- Create: `src/routes/admin/backup.js`
- Create: `views/admin/backup.ejs`
- Modify: `src/app.js`
- Modify: `src/middleware/nav.js`
- Modify: `views/admin/_nav.ejs`
- Test: Create `test/integration/admin/backup.test.js`

**Interfaces:**
- Consumes: `runDatenbankSicherungJob` (Task 5), `BACKUP_DATEINAME_PATTERN` (Task 3), `listBackupWiederherstellungen` (Task 2)
- Produces: `createBackupRouter({ db, config })` → Express `Router`, mounted at `/admin/backup` — the restore endpoint is added to this same router file in Task 8
- Produces: `res.locals.adminNav.backup` (boolean) — consumed by `views/admin/_nav.ejs`

- [ ] **Step 1: Write the failing route tests**

Create `test/integration/admin/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requireRole } from '../../../src/middleware/roles.js';
import { createBackupRouter } from '../../../src/routes/admin/backup.js';

function buildTestApp(db, config) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null, seitenTitel: 'Test' };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/admin/backup', requireRole(config, 'superadmin'), createBackupRouter({ db, config }));
  return app;
}

function seedSuperadmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

function testConfig(dir) {
  return {
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
    backupDir: join(dir, 'backups'),
    jobsDir: join(dir, 'jobs'),
    brandingDir: join(dir, 'branding'),
  };
}

test('GET /admin/backup returns 401 without a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup');
  assert.equal(res.status, 401);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup returns 403 for a Manager (superadmin-only, not manager-accessible)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'm@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup').set('x-test-person-id', '55');
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup returns 200 for a superadmin with the configured schedule pre-filled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));
  const res = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="cronStunde"[^>]*value="3"/);
  assert.match(res.text, /id="aufbewahrungAnzahl"[^>]*value="14"/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup persists a valid schedule and rejects an out-of-range hour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  const ok = await request(app)
    .post('/admin/backup')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ cronStunde: '4', cronMinute: '30', aufbewahrungAnzahl: '7' });
  assert.equal(ok.status, 302);
  assert.equal(getConfigValue(db, 'backup_cron_stunde'), '4');
  assert.equal(getConfigValue(db, 'backup_aufbewahrung_anzahl'), '7');

  const bad = await request(app)
    .post('/admin/backup')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ cronStunde: '24', cronMinute: '30', aufbewahrungAnzahl: '7' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Ganzzahl zwischen 0 und 23/);
  assert.equal(getConfigValue(db, 'backup_cron_stunde'), '4', 'rejected POST must not touch config');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/jetzt-ausfuehren creates a backup file and shows a success banner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  const triggerRes = await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(triggerRes.status, 302);
  assert.equal(triggerRes.headers.location, '/admin/backup?getriggert=1');

  const res = await request(app).get(triggerRes.headers.location).set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /alert-success/);
  assert.match(res.text, /Erfolgreich gesichert/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/backup/dateien/:name downloads an existing backup and 404s on a path-traversal attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  const list = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  const [, dateiname] = list.text.match(/\/admin\/backup\/dateien\/([^"]+)"/);

  const okRes = await request(app).get(`/admin/backup/dateien/${dateiname}`).set('x-test-person-id', '99');
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers['content-type'], 'application/zip');

  const traversalRes = await request(app)
    .get('/admin/backup/dateien/..%2F..%2Fetc%2Fpasswd')
    .set('x-test-person-id', '99');
  assert.equal(traversalRes.status, 404);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/dateien/:name/loeschen removes the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-route-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedSuperadmin(db);
  const app = buildTestApp(db, testConfig(dir));

  await request(app).post('/admin/backup/jetzt-ausfuehren').set('x-test-person-id', '99');
  const before = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  const [, dateiname] = before.text.match(/\/admin\/backup\/dateien\/([^"]+)"/);

  const delRes = await request(app).post(`/admin/backup/dateien/${dateiname}/loeschen`).set('x-test-person-id', '99');
  assert.equal(delRes.status, 302);

  const after = await request(app).get('/admin/backup').set('x-test-person-id', '99');
  assert.doesNotMatch(after.text, new RegExp(dateiname));

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/backup.test.js`
Expected: FAIL — module `src/routes/admin/backup.js` not found, and `views/admin/backup` doesn't exist.

- [ ] **Step 3: Implement the router**

Create `src/routes/admin/backup.js`:

```js
import { Router } from 'express';
import { readdirSync, statSync, unlinkSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { listBackupWiederherstellungen } from '../../db/backupWiederherstellungenRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { runDatenbankSicherungJob } from '../../services/cronJobs.js';
import { BACKUP_DATEINAME_PATTERN } from '../../services/backup.js';

const SICHERUNG_LOG_LIMIT = 10;

export function createBackupRouter({ db, config }) {
  const router = Router();

  function listeLokalerBackups() {
    if (!existsSync(config.backupDir)) return [];
    return readdirSync(config.backupDir)
      .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
      .map((dateiname) => {
        const stat = statSync(join(config.backupDir, dateiname));
        return { dateiname, groesseBytes: stat.size, erstelltAm: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.dateiname < b.dateiname ? 1 : -1));
  }

  function listeWiederherstellungen() {
    return listBackupWiederherstellungen(db).map((w) => {
      const person = getPersonById(db, w.wiederhergestellt_von);
      return { ...w, personName: person ? `${person.vorname} ${person.nachname}` : w.wiederhergestellt_von };
    });
  }

  function ladeState({ getriggert = null, wiederhergestellt = false } = {}) {
    return {
      cronStunde: getConfigValue(db, 'backup_cron_stunde'),
      cronMinute: getConfigValue(db, 'backup_cron_minute'),
      aufbewahrungAnzahl: getConfigValue(db, 'backup_aufbewahrung_anzahl'),
      backups: listeLokalerBackups(),
      sicherungLog: listRecentCronLog(db, 'datenbank-sicherung', SICHERUNG_LOG_LIMIT),
      wiederherstellungen: listeWiederherstellungen(),
      getriggert,
      wiederhergestellt,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/backup', {
      ...ladeState({ getriggert: req.query.getriggert || null }),
      errors: [],
      restoreErrors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
    const { cronStunde, cronMinute, aufbewahrungAnzahl } = req.body;
    const errors = [];

    function ganzzahlImBereich(wert, min, max, label) {
      const num = Number(wert);
      if (!Number.isInteger(num) || num < min || num > max) {
        errors.push(`${label} muss eine Ganzzahl zwischen ${min} und ${max} sein.`);
      }
      return num;
    }

    const stundeNum = ganzzahlImBereich(cronStunde, 0, 23, 'Stunde');
    const minuteNum = ganzzahlImBereich(cronMinute, 0, 59, 'Minute');
    const aufbewahrungNum = Number(aufbewahrungAnzahl);
    if (!Number.isInteger(aufbewahrungNum) || aufbewahrungNum < 1) {
      errors.push('Aufbewahrung muss eine positive Ganzzahl sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/backup', {
        ...ladeState(),
        cronStunde,
        cronMinute,
        aufbewahrungAnzahl,
        errors,
        restoreErrors: [],
        gespeichert: false,
      });
    }

    setConfigValue(db, 'backup_cron_stunde', String(stundeNum));
    setConfigValue(db, 'backup_cron_minute', String(minuteNum));
    setConfigValue(db, 'backup_aufbewahrung_anzahl', String(aufbewahrungNum));
    res.redirect('/admin/backup?gespeichert=1');
  });

  router.post('/jetzt-ausfuehren', (req, res, next) => {
    try {
      runDatenbankSicherungJob(db, config);
      res.redirect('/admin/backup?getriggert=1');
    } catch (err) {
      next(err);
    }
  });

  router.get('/dateien/:name', (req, res) => {
    const { name } = req.params;
    if (!BACKUP_DATEINAME_PATTERN.test(name)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    const pfad = join(config.backupDir, name);
    if (!existsSync(pfad)) {
      return res.status(404).render('error', { message: 'Backup nicht gefunden.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/zip');
    res.setHeader('Content-Length', statSync(pfad).size);
    createReadStream(pfad).pipe(res);
  });

  router.post('/dateien/:name/loeschen', (req, res) => {
    const { name } = req.params;
    if (BACKUP_DATEINAME_PATTERN.test(name)) {
      const pfad = join(config.backupDir, name);
      if (existsSync(pfad)) unlinkSync(pfad);
    }
    res.redirect('/admin/backup');
  });

  return router;
}
```

- [ ] **Step 4: Create the view**

Create `views/admin/backup.ejs`:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Datenbank-Backup — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Datenbank-Backup</h1>
    <div class="alert alert-warning">
      Jedes Backup-Archiv enthält sämtliche Rechnungsdaten und Geheimnisse im Klartext (u. a. das RFC3161-TSA-Passwort) — Downloads entsprechend sicher aufbewahren.
    </div>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>

    <h2 class="h5 mt-3">Zeitplan &amp; Aufbewahrung</h2>
    <form method="post" action="/admin/backup" class="col-12 col-lg-8">
      <div class="row g-2 mb-3">
        <div class="col-6 col-md-3">
          <label class="form-label" for="cronStunde">Stunde (0–23)</label>
          <input type="number" min="0" max="23" class="form-control" id="cronStunde" name="cronStunde" value="<%= cronStunde %>" required>
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label" for="cronMinute">Minute (0–59)</label>
          <input type="number" min="0" max="59" class="form-control" id="cronMinute" name="cronMinute" value="<%= cronMinute %>" required>
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label" for="aufbewahrungAnzahl">Aufbewahrung (Anzahl Backups)</label>
          <input type="number" min="1" class="form-control" id="aufbewahrungAnzahl" name="aufbewahrungAnzahl" value="<%= aufbewahrungAnzahl %>" required>
        </div>
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 ps-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>

    <hr class="my-4">

    <h2 class="h5">Manuelle Sicherung</h2>
    <form method="post" action="/admin/backup/jetzt-ausfuehren" class="mb-2">
      <button type="submit" class="btn btn-outline-secondary btn-sm">Jetzt sichern</button>
    </form>
    <% if (getriggert === '1') { %>
      <% const letzterLauf = sicherungLog[0]; %>
      <% if (letzterLauf) { %>
        <div class="alert <%= letzterLauf.status === 'erfolg' ? 'alert-success' : letzterLauf.status === 'laufend' ? 'alert-info' : 'alert-danger' %>">
          <% if (letzterLauf.status === 'erfolg') { %>
            Erfolgreich gesichert: <%= letzterLauf.details %>
          <% } else if (letzterLauf.status === 'laufend') { %>
            Ein Backup-Lauf war bereits aktiv — dieser Trigger wurde übersprungen.
          <% } else { %>
            Fehlgeschlagen: <%= letzterLauf.details || letzterLauf.status %>
          <% } %>
        </div>
      <% } %>
    <% } %>

    <h2 class="h5 mt-4">Lokale Backups</h2>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Datei</th><th>Grösse</th><th>Erstellt</th><th></th></tr></thead>
        <tbody>
          <% backups.forEach((b) => { %>
            <tr>
              <td><%= b.dateiname %></td>
              <td><%= b.groesseBytes %> Bytes</td>
              <td><%= b.erstelltAm %></td>
              <td class="text-end">
                <a class="btn btn-outline-secondary btn-sm" href="/admin/backup/dateien/<%= encodeURIComponent(b.dateiname) %>">Download</a>
                <form method="post" action="/admin/backup/dateien/<%= encodeURIComponent(b.dateiname) %>/loeschen" class="d-inline" onsubmit="return confirm('Backup wirklich löschen?');">
                  <button type="submit" class="btn btn-outline-danger btn-sm">Löschen</button>
                </form>
              </td>
            </tr>
          <% }) %>
          <% if (backups.length === 0) { %>
            <tr><td colspan="4" class="text-muted">Noch keine Backups vorhanden.</td></tr>
          <% } %>
        </tbody>
      </table>
    </div>

    <hr class="my-4">

    <h2 class="h5">Wiederherstellen</h2>
    <div class="alert alert-danger">
      Eine Wiederherstellung überschreibt Datenbank und Dateien vollständig. Die Oberfläche zeigt bis zum manuellen Neustart der App (Infomaniak-Manager) weiterhin die alten Daten.
    </div>
    <% if (restoreErrors && restoreErrors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% restoreErrors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <% if (wiederhergestellt) { %>
      <div class="alert alert-success">Wiederherstellung auf Dateiebene abgeschlossen. Bitte die App jetzt manuell neu starten.</div>
    <% } %>
    <form method="post" action="/admin/backup/wiederherstellen" enctype="multipart/form-data" class="col-12 col-lg-8">
      <div class="mb-3">
        <label class="form-label" for="backup">Backup-Datei (.zip)</label>
        <input type="file" class="form-control" id="backup" name="backup" accept=".zip" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="bestaetigung">Zur Bestätigung "WIEDERHERSTELLEN" eintippen</label>
        <input type="text" class="form-control" id="bestaetigung" name="bestaetigung" required>
      </div>
      <button type="submit" class="btn btn-danger">Wiederherstellen</button>
    </form>

    <h2 class="h5 mt-4">Wiederherstellungs-Verlauf</h2>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Datei</th><th>Von</th><th>Zeitpunkt</th></tr></thead>
        <tbody>
          <% wiederherstellungen.forEach((w) => { %>
            <tr><td><%= w.dateiname %></td><td><%= w.personName %></td><td><%= w.zeitpunkt %></td></tr>
          <% }) %>
          <% if (wiederherstellungen.length === 0) { %>
            <tr><td colspan="3" class="text-muted">Noch keine Wiederherstellung durchgeführt.</td></tr>
          <% } %>
        </tbody>
      </table>
    </div>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

- [ ] **Step 5: Mount the router in `src/app.js`**

Add the import near the other admin router imports:

```js
import { createBackupRouter } from './routes/admin/backup.js';
```

Add the mount line right after the `/admin/geplante-jobs` mount:

```js
  app.use('/admin/backup', requireRole(config, 'superadmin'), createBackupRouter({ db, config }));
```

- [ ] **Step 6: Add the nav flag**

In `src/middleware/nav.js`, add to the `adminNav` object:

```js
      backup: res.locals.isSuperadmin,
```

In `views/admin/_nav.ejs`, add a list item (after the `zeitstempel` one, keeping the hard-locked-superadmin-only items grouped):

```html
  <% if (adminNav.backup) { %><li class="nav-item"><a class="nav-link" href="/admin/backup">Datenbank-Backup</a></li><% } %>
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/integration/admin/backup.test.js`
Expected: PASS

- [ ] **Step 8: Add a `nav.test.js` assertion**

In `test/unit/nav.test.js`, in the existing superadmin test, add `assert.equal(res.locals.adminNav.backup, true);`, and in the Manager test add `assert.equal(res.locals.adminNav.backup, false);` alongside the other hard-locked assertions.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Update `docs/admin-bereich.md`**

Add a row to the Rechte-Matrix table (after the Zeitstempel row):

```
| Datenbank-Backup | `/admin/backup` | **nur** `superadmin` |
```

Add a new section after `## Zeitstempel (\`/admin/zeitstempel\`)`:

```markdown

## Datenbank-Backup (`/admin/backup`)

Manuelle und geplante (täglich, Default 03:00) Sicherung von DB +
`JOBS_DIR` + `BRANDING_DIR` als ein ZIP-Archiv nach `BACKUP_DIR`, mit
konfigurierbarer Aufbewahrung (Default: die letzten 14). Download/Löschen
einzelner lokaler Backups, sowie eine Wiederherstellung (Datei-Upload +
Pflicht-Bestätigungstext "WIEDERHERSTELLEN"), die einen automatischen
Sicherheits-Snapshot des vorherigen Standes anlegt, bevor sie Live-Dateien
ersetzt. **Nur `superadmin`** — kein vergebbares Einzelrecht, strenger
eingestuft als die drei bereits gesperrten Bereiche, weil das Archiv das
RFC3161-TSA-Passwort im Klartext enthält. Details:
[2026-08-24-datenbank-backup-design.md](superpowers/specs/2026-08-24-datenbank-backup-design.md).
```

- [ ] **Step 11: Commit**

```bash
git add src/routes/admin/backup.js views/admin/backup.ejs src/app.js src/middleware/nav.js views/admin/_nav.ejs test/integration/admin/backup.test.js test/unit/nav.test.js docs/admin-bereich.md
git commit -m "feat: add /admin/backup page (schedule, manual trigger, download, delete)"
```

---

## Task 8: Restore endpoint (`POST /admin/backup/wiederherstellen`)

**Files:**
- Modify: `src/routes/admin/backup.js`
- Test: `test/integration/admin/backup.test.js`

**Interfaces:**
- Consumes: `restoreBackupArchive`, `BackupValidationError` from Task 3
- Consumes: `req.currentPerson.churchtools_person_id` (set by `loadCurrentPerson`, already used throughout the codebase)
- Produces: nothing new consumed elsewhere — this is the plan's terminal write-path task

**Important test setup note:** restore replaces the on-disk DB file via `renameSync`, which is meaningless against `':memory:'`. Every test in this task must use `openDatabase(<real temp file path>)`, not `openDatabase(':memory:')`.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/admin/backup.test.js`:

```js
test('POST /admin/backup/wiederherstellen rejects a wrong confirmation phrase without touching any file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-restore-test-'));
  const dbPath = join(dir, 'live.sqlite');
  const db = openDatabase(dbPath);
  seedDefaults(db);
  seedSuperadmin(db);
  const config = testConfig(dir);
  config.dbPath = dbPath;
  const app = buildTestApp(db, config);

  const res = await request(app)
    .post('/admin/backup/wiederherstellen')
    .set('x-test-person-id', '99')
    .field('bestaetigung', 'falsch')
    .attach('backup', Buffer.from('irrelevant'), { filename: 'x.zip', contentType: 'application/zip' });

  assert.equal(res.status, 400);
  assert.match(res.text, /WIEDERHERSTELLEN/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/wiederherstellen rejects an invalid ZIP even with the correct confirmation phrase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-restore-test-'));
  const dbPath = join(dir, 'live.sqlite');
  const db = openDatabase(dbPath);
  seedDefaults(db);
  seedSuperadmin(db);
  const config = testConfig(dir);
  config.dbPath = dbPath;
  const app = buildTestApp(db, config);

  const res = await request(app)
    .post('/admin/backup/wiederherstellen')
    .set('x-test-person-id', '99')
    .field('bestaetigung', 'WIEDERHERSTELLEN')
    .attach('backup', Buffer.from('not a real zip'), { filename: 'x.zip', contentType: 'application/zip' });

  assert.equal(res.status, 400);
  assert.match(res.text, /ZIP-Archiv/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('POST /admin/backup/wiederherstellen with a valid backup and correct confirmation replaces the live DB file and logs the restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-restore-test-'));
  const dbPath = join(dir, 'live.sqlite');
  const db = openDatabase(dbPath);
  seedDefaults(db);
  seedSuperadmin(db);
  const config = testConfig(dir);
  config.dbPath = dbPath;
  const app = buildTestApp(db, config);

  // Build a real, valid backup archive of the current (superadmin-seeded) state to upload back in.
  const { buildBackupArchive } = await import('../../../src/services/backup.js');
  const archivBuffer = buildBackupArchive(db, config);

  const res = await request(app)
    .post('/admin/backup/wiederherstellen')
    .set('x-test-person-id', '99')
    .field('bestaetigung', 'WIEDERHERSTELLEN')
    .attach('backup', archivBuffer, { filename: 'mein-upload.zip', contentType: 'application/zip' });

  assert.equal(res.status, 200);
  assert.match(res.text, /Wiederherstellung auf Dateiebene abgeschlossen/);

  // The restore audit entry lands in the freshly-restored file on disk, not in the still-open
  // `db` handle from before the restore (see services/backup.js's restoreBackupArchive comment) --
  // open a fresh connection to verify it, exactly like the roundtrip test in backup.test.js does.
  const { openDatabase: reopen } = await import('../../../src/db/index.js');
  const { listBackupWiederherstellungen } = await import('../../../src/db/backupWiederherstellungenRepo.js');
  const wiederhergestellteDb = reopen(dbPath);
  const eintraege = listBackupWiederherstellungen(wiederhergestellteDb);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].dateiname, 'mein-upload.zip');
  assert.equal(eintraege[0].wiederhergestellt_von, '99');
  wiederhergestellteDb.close();

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/backup.test.js`
Expected: FAIL — `POST /admin/backup/wiederherstellen` doesn't exist yet (404 from the catch-all, not 400/200).

- [ ] **Step 3: Implement the restore endpoint**

In `src/routes/admin/backup.js`:

1. Add imports:

```js
import multer from 'multer';
import { restoreBackupArchive, BackupValidationError } from '../../services/backup.js';
```

2. Add constants near the top (after `SICHERUNG_LOG_LIMIT`):

```js
const MAX_RESTORE_UPLOAD_SIZE = 500 * 1024 * 1024;
const BESTAETIGUNGSTEXT = 'WIEDERHERSTELLEN';
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESTORE_UPLOAD_SIZE } });
```

3. Add the route, inside `createBackupRouter`, right before `return router;`:

```js
  router.post('/wiederherstellen', (req, res, next) => {
    uploadBackup.single('backup')(req, res, (uploadErr) => {
      try {
        if (uploadErr) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Backup-Datei ist zu gross.' : 'Fehler beim Datei-Upload.'],
            gespeichert: false,
          });
        }
        if (!req.file) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: ['Backup-Datei fehlt.'],
            gespeichert: false,
          });
        }
        if (req.body.bestaetigung !== BESTAETIGUNGSTEXT) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [`Zur Bestätigung muss exakt "${BESTAETIGUNGSTEXT}" eingetippt werden.`],
            gespeichert: false,
          });
        }

        restoreBackupArchive(req.file.buffer, db, config, {
          wiederhergestelltVon: req.currentPerson.churchtools_person_id,
          quellDateiname: req.file.originalname,
        });
        res.render('admin/backup', { ...ladeState(), errors: [], restoreErrors: [], gespeichert: false, wiederhergestellt: true });
      } catch (err) {
        if (err instanceof BackupValidationError) {
          return res.status(400).render('admin/backup', {
            ...ladeState(),
            errors: [],
            restoreErrors: [err.message],
            gespeichert: false,
          });
        }
        next(err);
      }
    });
  });

```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/admin/backup.test.js`
Expected: PASS (all tests in the file, including the ones from Task 7)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/backup.js test/integration/admin/backup.test.js
git commit -m "feat: add confirmation-gated restore endpoint to /admin/backup"
```

---

## Task 9: n8n-pull endpoint (`GET /api/n8n/backup/latest`)

**Files:**
- Create: `src/routes/n8n/backup.js`
- Modify: `src/app.js`
- Modify: `docs/n8n-schnittstelle.md`
- Test: Create `test/integration/n8n/backup.test.js`

**Interfaces:**
- Consumes: `BACKUP_DATEINAME_PATTERN` from Task 3
- Produces: `createN8nBackupRouter({ config })` → Express `Router`, mounted at `/api/n8n/backup`

- [ ] **Step 1: Write the failing tests**

Create `test/integration/n8n/backup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nBackupRouter } from '../../../src/routes/n8n/backup.js';

function buildTestApp(config) {
  const app = express();
  app.use('/api/n8n/backup', requireApiKey(config), createN8nBackupRouter({ config }));
  return app;
}

test('GET /api/n8n/backup/latest without a valid API key returns 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest');
  assert.equal(res.status, 401);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest returns 404 when no backup exists yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir: join(dir, 'backups') });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 404);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/n8n/backup/latest streams the lexicographically newest matching backup file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-backup-test-'));
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'backup-2026-08-20T03-00-00-000Z.zip'), 'alt');
  writeFileSync(join(backupDir, 'backup-2026-08-24T03-00-00-000Z.zip'), 'neu');
  writeFileSync(join(backupDir, 'nicht-passend.txt'), 'ignorieren');

  const app = buildTestApp({ n8nApiKey: 'n8n-key', backupDir });
  const res = await request(app).get('/api/n8n/backup/latest').set('X-API-Key', 'n8n-key');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="backup-2026-08-24T03-00-00-000Z.zip"');
  // supertest/superagent doesn't reliably populate res.text for a non-text content type like
  // application/zip -- res.body (as a Buffer) is the precedent this codebase already uses for
  // asserting on streamed binary responses, see test/integration/downloads.test.js.
  assert.ok(Buffer.from(res.body).equals(Buffer.from('neu')) || res.text === 'neu');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/n8n/backup.test.js`
Expected: FAIL — module `src/routes/n8n/backup.js` not found.

- [ ] **Step 3: Implement the router**

Create `src/routes/n8n/backup.js`:

```js
import { Router } from 'express';
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DATEINAME_PATTERN } from '../../services/backup.js';

export function createN8nBackupRouter({ config }) {
  const router = Router();

  router.get('/latest', (req, res) => {
    if (!existsSync(config.backupDir)) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const dateien = readdirSync(config.backupDir)
      .filter((name) => BACKUP_DATEINAME_PATTERN.test(name))
      .sort();
    if (dateien.length === 0) {
      return res.status(404).json({ error: 'Kein Backup vorhanden.' });
    }
    const neuesteDatei = dateien[dateien.length - 1];
    const pfad = join(config.backupDir, neuesteDatei);
    res.setHeader('Content-Disposition', `attachment; filename="${neuesteDatei}"`);
    res.type('application/zip');
    res.setHeader('Content-Length', statSync(pfad).size);
    createReadStream(pfad).pipe(res);
  });

  return router;
}
```

- [ ] **Step 4: Mount it in `src/app.js`**

Add the import near the other n8n router import:

```js
import { createN8nBackupRouter } from './routes/n8n/backup.js';
```

Add the mount line right after the `/api/n8n/jobs` mount:

```js
  app.use('/api/n8n/backup', machineLimiter, requireApiKey(config), createN8nBackupRouter({ config }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/n8n/backup.test.js`
Expected: PASS

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Update `docs/n8n-schnittstelle.md`**

Add a new section at the end of the file:

```markdown

## Backup-Abholung

`GET /api/n8n/backup/latest` (`X-API-Key`, dieselbe Absicherung wie
`/api/n8n/jobs`) liefert das jeweils neueste, unter `BACKUP_DIR`
liegende Backup-Archiv aus (`404` falls noch keines existiert). Kein
eigener Trigger-Mechanismus — die Datei wird vom internen Scheduler
ohnehin produziert (siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md)),
n8n holt sich nur ab, was bereits da ist. Ein n8n-Workflow ausserhalb
dieses Repos ist dafür verantwortlich, die Datei extern abzulegen
(WebDAV, Cloud-Speicher etc.) — eine native WebDAV-Anbindung im Portal
selbst wurde bewusst nicht gebaut, siehe
[2026-08-24-datenbank-backup-design.md](superpowers/specs/2026-08-24-datenbank-backup-design.md#nicht-teil-von-diesem-design).

**Achtung:** das Archiv enthält Geheimnisse im Klartext (u. a. das
RFC3161-TSA-Passwort) — der Workflow, der diese Route abruft, muss die
Datei entsprechend sicher handhaben.
```

- [ ] **Step 8: Commit**

```bash
git add src/routes/n8n/backup.js src/app.js test/integration/n8n/backup.test.js docs/n8n-schnittstelle.md
git commit -m "feat: add GET /api/n8n/backup/latest for offsite backup pickup"
```

---

## Task 10: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS, zero failures, no unhandled rejections or open-handle warnings.

- [ ] **Step 2: Manually sanity-check the new dependency is declared correctly**

Run: `node -e "require('adm-zip'); console.log('adm-zip loads OK')"`
Expected: prints `adm-zip loads OK` (confirms the dependency is really resolvable, not just present in `package.json`).

- [ ] **Step 3: Grep for any leftover TODO/FIXME introduced by this plan**

Run: `git diff master --name-only | xargs grep -nE "TODO|FIXME|XXX" 2>/dev/null || true`
Expected: no output.

- [ ] **Step 4: Review the full diff once, end to end**

Run: `git diff master --stat`

Expected: touches exactly the files listed across Tasks 1–9 (config, `db/schema.sql`, `db/index.js`, `db/backupWiederherstellungenRepo.js`, `services/backup.js`, `services/cronJobs.js`, `services/scheduler.js`, `routes/admin/backup.js`, `routes/n8n/backup.js`, `views/admin/backup.ejs`, `views/admin/_nav.ejs`, `middleware/nav.js`, `app.js`, the four docs files, `README.md`, `.env.example`, `package.json`/`package-lock.json`, and the new/modified test files) — no unrelated files.

No commit for this task — it's pure verification of the nine commits already made.
