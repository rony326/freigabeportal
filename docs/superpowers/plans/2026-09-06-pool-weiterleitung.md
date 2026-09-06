# Pool-Weiterleitung und strikte Freigeber1-Prüfung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a defined "Triage-Team" forward an unassigned Pool invoice directly to a specific person (no Kontierung by the forwarder) with a way to send it back with a remark, and — to close the self-approval trap this opens — add an admin-configurable rule that only the Konto's real Freigeber1/Stellvertreter1 can actually grant Freigabe 1 during Kontierung.

**Architecture:** Both features reuse the existing `jobs`/`freigaben`/`admin_config`/`person_berechtigungen` machinery — no new tables, no new job status. Feature 1 adds three nullable `jobs` columns (Rückläufer marker) and a new additive permission `pool_zuweisen`. Feature 2 adds one `admin_config` boolean and a branch inside the existing Kontierung POST handler. Both add new `freigaben.rolle` values (informational audit entries, same pattern as `iban_abweichung`).

**Tech Stack:** Node.js, Express, `node:sqlite` (better-sqlite3-style synchronous API), EJS views, `node:test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-09-06-pool-weiterleitung-design.md`

## Global Constraints

- No new job `status` value — both features stay within `unzugewiesen`/`zugewiesen`.
- SQLite CHECK constraints cannot be widened with `ALTER TABLE` — every CHECK change requires the existing rebuild-in-a-transaction pattern (see Task 1).
- `admin_config` boolean convention: `'1'` = on, `'0'`/anything else = off; an unchecked HTML checkbox submits no field, so `Boolean(req.body.fieldName)` is the "off" case.
- New permission `pool_zuweisen` follows the existing additive-permission system exactly (`GRANTABLE_BERECHTIGUNGEN`/`BERECHTIGUNG_LABELS`/`person_berechtigungen` CHECK) — superadmin/manager get it implicitly via `personHasPermission`.
- Every new POST route needs CSRF protection and a `csrfSweep.test.js` entry (Task 12).
- German identifiers/strings throughout, matching the existing codebase.

---

### Task 1: Datenbank-Migrationen

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js`
- Test: `test/unit/db.test.js`

**Interfaces:**
- Produces: `jobs.pool_rueckgesendet_bemerkung`/`pool_rueckgesendet_von`/`pool_rueckgesendet_am` columns; `freigaben.rolle` accepts `'pool_zuweisung'`, `'pool_ruecksendung'`, `'freigabe1_weiterleitung'`; `person_berechtigungen.berechtigung` accepts `'pool_zuweisen'`.

- [ ] **Step 1: Write the failing migration tests**

Add to `test/unit/db.test.js`, right after the existing test `'openDatabase further widens the freigaben table rolle CHECK to include rechnungsnummer_duplikat, even for a database already migrated to include iban_abweichung'` (ends around line 402):

```js
test('openDatabase adds the pool_rueckgesendet_* columns via ALTER TABLE to an existing on-disk database that predates them', () => {
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
  for (const expected of ['pool_rueckgesendet_bemerkung', 'pool_rueckgesendet_von', 'pool_rueckgesendet_am']) {
    assert.ok(columns.includes(expected), `ALTER TABLE should have added ${expected} to the pre-existing table`);
  }
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase further widens the freigaben table rolle CHECK to include pool_zuweisung/pool_ruecksendung/freigabe1_weiterleitung, even for a database already migrated to include rechnungsnummer_duplikat', () => {
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
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO personen (churchtools_person_id, vorname, nachname, email) VALUES ('1', 'Frei', 'Geber', 'f@example.org');
    INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad) VALUES ('2026-08-15T08:00:00.000Z', 'scanner', NULL, 'a.pdf', '/tmp/a.pdf');
    INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      VALUES (1, '1', 'rechnungsnummer_duplikat', '2026-08-15T09:00:00.000Z', '1.2.3.4', 0, 'Rechnungsnummer bereits erfasst', NULL);
  `);
  legacyDb.close();

  const migratedDb = openDatabase(dbPath);
  const preserved = migratedDb.prepare('SELECT * FROM freigaben WHERE id = 1').get();
  assert.equal(preserved.rolle, 'rechnungsnummer_duplikat', 'existing rows must survive the rebuild');
  for (const rolle of ['pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung']) {
    assert.doesNotThrow(() =>
      migratedDb
        .prepare(
          `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
           VALUES (1, '1', ?, '2026-08-15T09:30:00.000Z', '1.2.3.4', 0, NULL, NULL)`
        )
        .run(rolle),
      `the widened CHECK constraint must accept ${rolle}`
    );
  }
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase rebuilds the person_berechtigungen table to widen its berechtigung CHECK constraint to include pool_zuweisen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE personen (churchtools_person_id TEXT PRIMARY KEY, vorname TEXT NOT NULL, nachname TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE person_berechtigungen (
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      berechtigung TEXT NOT NULL CHECK (berechtigung IN (
        'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
        'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen'
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
    migratedDb.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'pool_zuweisen')").run(),
    'the widened CHECK constraint must accept pool_zuweisen'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: the three new tests FAIL — the columns/CHECK values don't exist yet.

- [ ] **Step 3: Widen `schema.sql`**

In `src/db/schema.sql`, change the `person_berechtigungen` CHECK (around line 19):

```sql
  berechtigung TEXT NOT NULL CHECK (berechtigung IN (
    'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
    'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen', 'pool_zuweisen'
  )),
```

Change the `jobs` table (around line 152-157), appending the three new columns right after `rechnungsdatum TEXT`:

```sql
  rechnungsdatum TEXT,
  pool_rueckgesendet_bemerkung TEXT,
  pool_rueckgesendet_von TEXT REFERENCES personen(churchtools_person_id),
  pool_rueckgesendet_am TEXT
);
```

Change the `freigaben` CHECK (around line 204):

```sql
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung')),
```

- [ ] **Step 4: Add the three plain-column entries to `JOBS_TABLE_MIGRATIONS`**

In `src/db/index.js`, append to the `JOBS_TABLE_MIGRATIONS` array, right after the `rechnungsdatum` entry:

```js
  { column: 'rechnungsdatum', ddl: 'ALTER TABLE jobs ADD COLUMN rechnungsdatum TEXT' },
  { column: 'pool_rueckgesendet_bemerkung', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_bemerkung TEXT' },
  { column: 'pool_rueckgesendet_von', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_von TEXT REFERENCES personen(churchtools_person_id)' },
  { column: 'pool_rueckgesendet_am', ddl: 'ALTER TABLE jobs ADD COLUMN pool_rueckgesendet_am TEXT' },
];
```

- [ ] **Step 5: Widen `migrateFreigabenTable`'s marker and CHECK**

In `src/db/index.js`, in `migrateFreigabenTable`, change the marker check and the rebuilt CREATE TABLE:

```js
function migrateFreigabenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'freigaben'").get();
  if (!tableSql || tableSql.sql.includes('freigabe1_weiterleitung')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE freigaben RENAME TO freigaben_pre_freigabe1_weiterleitung_rolle');
    db.exec(`
      CREATE TABLE freigaben (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung')),
        zeitpunkt TEXT NOT NULL,
        ip TEXT NOT NULL,
        interessenskonflikt INTEGER NOT NULL DEFAULT 0,
        kommentar TEXT,
        eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
      )
    `);
    db.exec(`
      INSERT INTO freigaben (id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von)
      SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von FROM freigaben_pre_freigabe1_weiterleitung_rolle
    `);
    db.exec('DROP TABLE freigaben_pre_freigabe1_weiterleitung_rolle');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

Update the comment above the function: replace `'rechnungsnummer_duplikat'` with `'freigabe1_weiterleitung'` as "the marker value this function checks for".

- [ ] **Step 6: Widen `migratePersonBerechtigungenTable`'s marker and CHECK**

In `src/db/index.js`, in `migratePersonBerechtigungenTable`:

```js
function migratePersonBerechtigungenTable(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_berechtigungen'").get();
  if (!tableSql || tableSql.sql.includes('pool_zuweisen')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE person_berechtigungen RENAME TO person_berechtigungen_pre_pool_zuweisen');
    db.exec(`
      CREATE TABLE person_berechtigungen (
        person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
        berechtigung TEXT NOT NULL CHECK (berechtigung IN (
          'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
          'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen', 'pool_zuweisen'
        )),
        PRIMARY KEY (person_id, berechtigung)
      )
    `);
    db.exec(`
      INSERT INTO person_berechtigungen (person_id, berechtigung)
      SELECT person_id, berechtigung FROM person_berechtigungen_pre_pool_zuweisen
    `);
    db.exec('DROP TABLE person_berechtigungen_pre_pool_zuweisen');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: all tests PASS, including the pre-existing ones (regression check).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat(db): add pool_rueckgesendet_* columns, pool_zuweisen permission and pool/freigabe1-weiterleitung freigaben roles

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Neues Recht `pool_zuweisen`

**Files:**
- Modify: `src/middleware/permissions.js`
- Test: `test/unit/permissions.test.js`

**Interfaces:**
- Consumes: nothing new (uses existing `personHasBerechtigung`, `personHasRole`).
- Produces: `GRANTABLE_BERECHTIGUNGEN` includes `'pool_zuweisen'`; `BERECHTIGUNG_LABELS.pool_zuweisen`.

- [ ] **Step 1: Write the failing test**

In `test/unit/permissions.test.js`, replace the existing "exactly the seven catalog permissions" test:

```js
test('GRANTABLE_BERECHTIGUNGEN lists exactly the eight catalog permissions', () => {
  assert.deepEqual(
    [...GRANTABLE_BERECHTIGUNGEN].sort(),
    ['abgelehnt_verwalten', 'audit_log_einsehen', 'debitoren_verwalten', 'geplante_jobs_verwalten', 'konten_verwalten', 'mails_einsehen', 'pool_zuweisen', 'sync_einsehen']
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/permissions.test.js`
Expected: FAIL — actual list has seven entries, no `pool_zuweisen`.

- [ ] **Step 3: Add the permission**

In `src/middleware/permissions.js`:

```js
export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'debitoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
  'audit_log_einsehen',
  'pool_zuweisen',
];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  debitoren_verwalten: 'Debitoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
  audit_log_einsehen: 'Globales Audit-Log einsehen',
  pool_zuweisen: 'Pool-Belege an Personen zuweisen',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/permissions.test.js`
Expected: PASS. Also run `node --test test/integration/admin/personen.test.js` (if present) to confirm the generic checkbox-rendering page still works with eight entries — no changes needed there since it iterates `GRANTABLE_BERECHTIGUNGEN` generically.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/permissions.js test/unit/permissions.test.js
git commit -m "feat(auth): add pool_zuweisen as a grantable permission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Zweiter Schalter auf `/admin/module` — strikte Freigeber1-Prüfung

**Files:**
- Modify: `src/db/adminConfigRepo.js`
- Modify: `src/routes/admin/module.js`
- Modify: `views/admin/module-form.ejs`
- Modify: `test/integration/admin/module.test.js`

**Interfaces:**
- Produces: `admin_config` key `kontierung_strikte_freigeber1_pruefung` (default `'0'`); GET `/admin/module` exposes `strikteFreigeber1Pruefung` boolean; POST accepts `strikteFreigeber1Pruefung` checkbox field.

- [ ] **Step 1: Write the failing tests**

In `test/unit/adminConfigRepo.test.js`, add after the `modul_spesen_aktiv` default test:

```js
test('seedDefaults sets kontierung_strikte_freigeber1_pruefung default (off out of the box)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung'), '0');
  db.close();
});
```

In `test/integration/admin/module.test.js`, add:

```js
test('GET /admin/module shows the strikte Freigeber1-Prüfung checkbox unchecked by default', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/module').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /name="strikteFreigeber1Pruefung"[^>]*checked/);
  db.close();
});

test('POST /admin/module with strikteFreigeber1Pruefung checked activates it, independently of spesenAktiv', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/module')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ spesenAktiv: '1', strikteFreigeber1Pruefung: '1' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung'), '1');
  assert.equal(getConfigValue(db, 'modul_spesen_aktiv'), '1');
  db.close();
});

test('POST /admin/module without strikteFreigeber1Pruefung (unchecked) turns it off', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/module').set('x-test-person-id', '99').type('form').send({ spesenAktiv: '1' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung'), '0');
  db.close();
});
```

(`setConfigValue` is already imported in this file via Feature 1's earlier work — if not, add `setConfigValue` to the existing `import { seedDefaults, getConfigValue, setConfigValue } from '../../../src/db/adminConfigRepo.js';` line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/adminConfigRepo.test.js test/integration/admin/module.test.js`
Expected: FAIL — key doesn't exist yet, checkbox not rendered, POST doesn't persist it.

- [ ] **Step 3: Add the default**

In `src/db/adminConfigRepo.js`, in `DEFAULTS`, add after `modul_spesen_aktiv: '1',`:

```js
  modul_spesen_aktiv: '1',
  kontierung_strikte_freigeber1_pruefung: '0',
};
```

- [ ] **Step 4: Extend the route**

In `src/routes/admin/module.js`:

```js
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

export function createModuleRouter({ db, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/module-form', {
      spesenAktiv: getConfigValue(db, 'modul_spesen_aktiv') !== '0',
      strikteFreigeber1Pruefung: getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1',
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    setConfigValue(db, 'modul_spesen_aktiv', req.body.spesenAktiv ? '1' : '0');
    setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', req.body.strikteFreigeber1Pruefung ? '1' : '0');
    res.redirect('/admin/module?gespeichert=1');
  });

  return router;
}
```

- [ ] **Step 5: Extend the view**

In `views/admin/module-form.ejs`, add a second `form-check` block right after the `spesenAktiv` one, before the "Speichern" button:

```html
      <div class="form-check mb-3">
        <input type="checkbox" class="form-check-input" id="strikteFreigeber1Pruefung" name="strikteFreigeber1Pruefung" value="1"<% if (strikteFreigeber1Pruefung) { %> checked<% } %>>
        <label class="form-check-label" for="strikteFreigeber1Pruefung">Strikte Freigeber1-Prüfung bei der Kontierung</label>
        <div class="form-text">Wenn aktiv, gilt Freigabe 1 bei der Kontierung nur noch als erteilt, wenn die kontierende Person tatsächlich Freigeber1 (oder bei laufender Eskalation: Stellvertreter1) des gewählten Kontos ist. Andernfalls wird die Rechnung nach der Kontierung direkt an den echten Freigeber1 weitergereicht.</div>
      </div>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/adminConfigRepo.test.js test/integration/admin/module.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/adminConfigRepo.js src/routes/admin/module.js views/admin/module-form.ejs test/integration/admin/module.test.js test/unit/adminConfigRepo.test.js
git commit -m "feat(admin): add strikte Freigeber1-Prüfung toggle to /admin/module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `kontenRepo.listPersonenMitFreigeberRolle`

**Files:**
- Modify: `src/db/kontenRepo.js`
- Test: `test/unit/kontenRepo.test.js`

**Interfaces:**
- Consumes: `listKontoReferencedPersonIds(db)` (existing, same file), `listActivePersons(db)` (`src/db/personenRepo.js`).
- Produces: `listPersonenMitFreigeberRolle(db)` → array of `{ churchtools_person_id, vorname, nachname, email }`, sorted by `nachname, vorname`, only active persons referenced by any role on an active Konto.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/kontenRepo.test.js`, after the existing `listKontoReferencedPersonIds` tests:

```js
test('listPersonenMitFreigeberRolle returns only active persons holding any of the four roles on an active Konto, sorted by name', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivatePerson(db, '4');

  const { listPersonenMitFreigeberRolle } = await import('../../src/db/kontenRepo.js');
  const personen = listPersonenMitFreigeberRolle(db);
  assert.deepEqual(
    personen.map((p) => p.churchtools_person_id).sort(),
    ['1', '2', '3']
  );
  db.close();
});

test('listPersonenMitFreigeberRolle ignores deactivated Konten', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, kontoId);

  const { listPersonenMitFreigeberRolle } = await import('../../src/db/kontenRepo.js');
  assert.deepEqual(listPersonenMitFreigeberRolle(db), []);
  db.close();
});
```

Check the top of the file for `deactivatePerson`'s import source — if not already imported, add `import { deactivatePerson } from '../../src/db/personenRepo.js';` (the `listKontoReferencedPersonIds` tests already import `seedPersonen`, `createKonto`, `deactivateKonto` from the local `seedPersonen` helper and `kontenRepo.js`; only `deactivatePerson` may be missing — check first with `grep -n deactivatePerson test/unit/kontenRepo.test.js` and add the import only if absent). Mark the first test `async` since it uses a dynamic `await import(...)` like its neighbors.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: FAIL — `listPersonenMitFreigeberRolle` is not exported.

- [ ] **Step 3: Implement**

In `src/db/kontenRepo.js`, update the top import and add the function after `listKontoReferencedPersonIds`:

```js
import { getPersonById, listActivePersons } from './personenRepo.js';
```

```js
export function listPersonenMitFreigeberRolle(db) {
  const ids = new Set(listKontoReferencedPersonIds(db));
  return listActivePersons(db).filter((person) => ids.has(person.churchtools_person_id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/kontenRepo.js test/unit/kontenRepo.test.js
git commit -m "feat(konten): add listPersonenMitFreigeberRolle for pool-assignment target lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `jobsRepo` — Zuweisung + Pool-Sichtbarkeit

**Files:**
- Modify: `src/db/jobsRepo.js`
- Modify: `src/services/auditLog.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Produces: `assignJobToPerson(db, jobId, personId)` → boolean; `listPoolJobs(db)` now excludes Rückläufer; `listPoolRuecklaeufer(db)` → array of jobs; `EREIGNIS_LABEL.pool_zuweisung`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, after the `claimJob` test (around line 225):

```js
test('assignJobToPerson assigns an unzugewiesen job to a chosen person, clearing any Rückläufer marker', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET pool_rueckgesendet_bemerkung = 'falsche Person', pool_rueckgesendet_von = '2', pool_rueckgesendet_am = '2026-09-06T09:00:00.000Z' WHERE id = ?").run(jobId);

  const assigned = assignJobToPerson(db, jobId, '3');
  assert.equal(assigned, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '3');
  assert.equal(job.pool_rueckgesendet_bemerkung, null);
  assert.equal(job.pool_rueckgesendet_von, null);
  assert.equal(job.pool_rueckgesendet_am, null);
  db.close();
});

test('assignJobToPerson refuses a job that is no longer unzugewiesen', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const assigned = assignJobToPerson(db, jobId, '3');
  assert.equal(assigned, false);
  db.close();
});

test('listPoolJobs excludes a Rückläufer (pool_rueckgesendet_bemerkung set)', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const normalId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const rueckId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET pool_rueckgesendet_bemerkung = 'falsche Person' WHERE id = ?").run(rueckId);

  const ids = listPoolJobs(db).map((j) => j.id);
  assert.deepEqual(ids, [normalId]);
  db.close();
});

test('listPoolRuecklaeufer returns only jobs with a Rückläufer marker, ordered by pool_rueckgesendet_am', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const normalId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const rueckId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET pool_rueckgesendet_bemerkung = 'falsche Person', pool_rueckgesendet_von = '2', pool_rueckgesendet_am = '2026-09-06T09:00:00.000Z' WHERE id = ?").run(rueckId);

  const ruecklaeufer = listPoolRuecklaeufer(db);
  assert.deepEqual(ruecklaeufer.map((j) => j.id), [rueckId]);
  assert.equal(ruecklaeufer[0].pool_rueckgesendet_bemerkung, 'falsche Person');
  void normalId;
  db.close();
});
```

Add `assignJobToPerson` and `listPoolRuecklaeufer` to the existing giant import line at the top of `test/unit/jobsRepo.test.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — functions not exported, `listPoolJobs` doesn't exclude Rückläufer yet.

- [ ] **Step 3: Implement in `jobsRepo.js`**

Change `listPoolJobs` (around line 116-118):

```js
export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' AND quelle != 'spesen' AND pool_rueckgesendet_bemerkung IS NULL ORDER BY eingang_am").all();
}

export function listPoolRuecklaeufer(db) {
  return db
    .prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' AND quelle != 'spesen' AND pool_rueckgesendet_bemerkung IS NOT NULL ORDER BY pool_rueckgesendet_am")
    .all();
}
```

Add `assignJobToPerson` right after `claimJob` (around line 125):

```js
export function assignJobToPerson(db, jobId, personId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'zugewiesen', zugewiesen_an = ?,
           pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL
       WHERE id = ? AND status = 'unzugewiesen'`
    )
    .run(personId, jobId);
  return result.changes > 0;
}
```

- [ ] **Step 4: Add the audit-log label**

In `src/services/auditLog.js`, in `EREIGNIS_LABEL`, add after `rechnungsnummer_duplikat: 'Doppelte Rechnungsnummer festgestellt',`:

```js
  pool_zuweisung: 'An Person weitergeleitet',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js src/services/auditLog.js test/unit/jobsRepo.test.js
git commit -m "feat(pool): add assignJobToPerson and hide Rückläufer from the general Pool listing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `jobsRepo` — Rücksendung mit Bemerkung

**Files:**
- Modify: `src/db/jobsRepo.js`
- Modify: `src/services/auditLog.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sendJobBackToGroup(db, jobId, currentZugewiesenAn, { bemerkung })` → boolean; `EREIGNIS_LABEL.pool_ruecksendung`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, after the `releaseJob` tests block (after the test ending around line 656 in the current file, i.e. right after `'releaseJob puts a zugewiesen job claimed by this person back into the pool'`):

```js
test('sendJobBackToGroup releases a zugewiesen job back to unzugewiesen with a Rückläufer marker', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const sent = sendJobBackToGroup(db, jobId, '1', { bemerkung: 'Falsche Person, bitte an Buchhaltung' });
  assert.equal(sent, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.pool_rueckgesendet_bemerkung, 'Falsche Person, bitte an Buchhaltung');
  assert.equal(job.pool_rueckgesendet_von, '1');
  assert.ok(job.pool_rueckgesendet_am);
  db.close();
});

test('sendJobBackToGroup refuses a job claimed by someone else', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');

  const sent = sendJobBackToGroup(db, jobId, '2', { bemerkung: 'x' });
  assert.equal(sent, false);
  db.close();
});
```

Add `sendJobBackToGroup` to the top import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `sendJobBackToGroup` not exported.

- [ ] **Step 3: Implement**

In `src/db/jobsRepo.js`, add right after `releaseJob` (around line 319):

```js
export function sendJobBackToGroup(db, jobId, currentZugewiesenAn, { bemerkung }) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL,
           pool_rueckgesendet_bemerkung = ?, pool_rueckgesendet_von = ?, pool_rueckgesendet_am = ?
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(bemerkung, currentZugewiesenAn, new Date().toISOString(), jobId, currentZugewiesenAn);
  return result.changes > 0;
}
```

- [ ] **Step 4: Add the audit-log label**

In `src/services/auditLog.js`, add after `pool_zuweisung: 'An Person weitergeleitet',`:

```js
  pool_ruecksendung: 'An Gruppe zurückgesendet',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js src/services/auditLog.js test/unit/jobsRepo.test.js
git commit -m "feat(pool): add sendJobBackToGroup for the Rückläufer-mit-Bemerkung flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Route `POST /pool/:id/zuweisen` + GET `/pool` Erweiterung

**Files:**
- Modify: `src/routes/poolPage.js`
- Modify: `src/app.js`
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `listPersonenMitFreigeberRolle` (Task 4), `assignJobToPerson`, `listPoolRuecklaeufer` (Task 5), `personHasPermission` (`src/middleware/permissions.js`), `createFreigabe` (`src/db/freigabenRepo.js`), `sendNotification` (`src/services/notify.js`).
- Produces: `POST /pool/:id/zuweisen` (JSON API, mirrors `/api/pool/:id/beanspruchen`'s response shape); GET `/pool` now also passes `ruecklaeufer`, `kannZuweisen`, `zielPersonen` to the view.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/poolPage.test.js`. First, update the `buildTestApp` helper to accept a mailer and pass `csrfProtection`/`mailer`, and add a `seedZuweisungsberechtigtePerson` helper plus the target Konto's roles:

```js
function buildTestApp(db, mailer = { async sendMail() {} }) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, downloadSigningSecret: 'test-secret', publicBaseUrl: 'https://portal.example.org' };
  const csrfProtection = (req, res, next) => {
    if (req.body?._csrf === 'valid-token') return next();
    return res.status(403).send('invalid csrf');
  };
  app.use((req, res, next) => {
    res.locals.csrfToken = 'valid-token';
    next();
  });
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/pool', requireLogin(), createPoolPageRouter({ db, config, mailer, csrfProtection }));
  return app;
}
```

(`express.urlencoded` is new — required for the POST body; add it even though existing GET-only tests don't need it, it's harmless for them.)

Then add:

```js
test('POST /pool/:id/zuweisen returns 403 for a Buchhaltung person without the pool_zuweisen permission', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).post(`/pool/${jobId}/zuweisen`).set('x-test-person-id', '50').type('form').send({ _csrf: 'valid-token', personId: '1' });
  assert.equal(res.status, 403);
  db.close();
});

test('POST /pool/:id/zuweisen assigns the job to the chosen person, logs a freigaben entry and sends a mail', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  setBerechtigungenForPerson(db, '50', ['pool_zuweisen']);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  const app = buildTestApp(db, mailer);
  const res = await request(app).post(`/pool/${jobId}/zuweisen`).set('x-test-person-id', '50').type('form').send({ _csrf: 'valid-token', personId: '1' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: jobId, status: 'zugewiesen' });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'pool_zuweisung'), true);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org');
  db.close();
});

test('POST /pool/:id/zuweisen rejects a personId that has no Freigeber-role on any active Konto', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  setBerechtigungenForPerson(db, '50', ['pool_zuweisen']);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  upsertPerson(db, { id: '99', vorname: 'Ohne', nachname: 'Rolle', email: 'ohne@example.org', gruppen: [], loggedInNow: false });
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const app = buildTestApp(db);
  const res = await request(app).post(`/pool/${jobId}/zuweisen`).set('x-test-person-id', '50').type('form').send({ _csrf: 'valid-token', personId: '99' });
  assert.equal(res.status, 400);
  db.close();
});

test('GET /pool includes the Rückläufer section only for a person with pool_zuweisen', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  setBerechtigungenForPerson(db, '50', ['pool_zuweisen']);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET pool_rueckgesendet_bemerkung = 'Falsche Person, bitte prüfen' WHERE id = ?").run(jobId);

  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.match(res.text, /Falsche Person, bitte prüfen/);

  seedBuchhaltungPerson(db, '51');
  const resOhneRecht = await request(app).get('/pool').set('x-test-person-id', '51');
  assert.doesNotMatch(resOhneRecht.text, /Falsche Person, bitte prüfen/);
  db.close();
});
```

Add the missing imports at the top of `test/integration/poolPage.test.js`: `getJobById` and `assignJobToPerson` from `jobsRepo.js` (only if used directly — the tests above use `getJobById`, already check whether it's imported, add if not), `createKonto` (already imported), `setBerechtigungenForPerson` from `../../src/db/personBerechtigungenRepo.js`, `listFreigabenByJob` from `../../src/db/freigabenRepo.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — route doesn't exist (404/whatever Express does for an unmatched POST), Rückläufer section not rendered.

- [ ] **Step 3: Implement the route and GET extension**

In `src/routes/poolPage.js`:

```js
import { Router } from 'express';
import {
  listPoolJobs,
  listPoolRuecklaeufer,
  listZugewiesenJobsForPerson,
  listFreigabe2JobsForPerson,
  listAbgelehntJobsForPerson,
  listAdminEskalierteKontierungen,
  listAdminEskalierteFreigaben,
  listAdminEskalierteSpesenFreigaben,
  listSpesenFreigabe1JobsForPerson,
  getJobById,
  assignJobToPerson,
} from '../db/jobsRepo.js';
import { getKontoById, listPersonenMitFreigeberRolle } from '../db/kontenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { personHasRole } from '../middleware/roles.js';
import { personHasPermission, requirePermission } from '../middleware/permissions.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { sendNotification } from '../services/notify.js';
import { personName } from '../services/auditLog.js';

export function createPoolPageRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function enrich(jobs) {
    return jobs.map((job) => ({
      ...job,
      previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
      kontonummer: job.konto_id ? (getKontoById(db, job.konto_id)?.kontonummer ?? null) : null,
      hinweisKonto: job.hinweis_konto_id ? (getKontoById(db, job.hinweis_konto_id) ?? null) : null,
      rueckgesendetVonName: job.pool_rueckgesendet_von ? personName(db, job.pool_rueckgesendet_von) : null,
    }));
  }

  router.get('/', (req, res) => {
    const personId = req.currentPerson.churchtools_person_id;
    const zeigtPool = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'superadmin');
    const istSuperadmin = personHasRole(req.currentPerson, config, 'superadmin');
    const kannZuweisen = personHasPermission(db, config, req.currentPerson, 'pool_zuweisen');
    res.render('pool', {
      poolJobs: zeigtPool ? enrich(listPoolJobs(db)) : [],
      ruecklaeufer: kannZuweisen ? enrich(listPoolRuecklaeufer(db)) : [],
      kannZuweisen,
      zielPersonen: kannZuweisen ? listPersonenMitFreigeberRolle(db) : [],
      meineKontierungen: enrich(listZugewiesenJobsForPerson(db, personId)),
      meineSpesenFreigaben: enrich(listSpesenFreigabe1JobsForPerson(db, personId)),
      meineFreigaben: enrich(listFreigabe2JobsForPerson(db, personId)),
      meineAbgelehnten: enrich(listAbgelehntJobsForPerson(db, personId)),
      adminEskalierteKontierungen: istSuperadmin ? enrich(listAdminEskalierteKontierungen(db)) : [],
      adminEskalierteFreigaben: istSuperadmin ? enrich(listAdminEskalierteFreigaben(db)) : [],
      adminEskalierteSpesenFreigaben: istSuperadmin ? enrich(listAdminEskalierteSpesenFreigaben(db)) : [],
    });
  });

  router.post('/:id/zuweisen', requirePermission(db, config, 'pool_zuweisen'), csrfProtection, async (req, res, next) => {
    try {
      const job = getJobById(db, Number(req.params.id));
      if (!job || job.status !== 'unzugewiesen') {
        return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
      }
      const zielPerson = listPersonenMitFreigeberRolle(db).find((p) => p.churchtools_person_id === req.body.personId);
      if (!zielPerson) {
        return res.status(400).json({ error: 'Bitte eine gültige Zielperson auswählen.' });
      }
      const zugewiesen = assignJobToPerson(db, job.id, zielPerson.churchtools_person_id);
      if (!zugewiesen) {
        return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
      }
      createFreigabe(db, {
        jobId: job.id,
        personId: req.currentPerson.churchtools_person_id,
        rolle: 'pool_zuweisung',
        zeitpunkt: new Date().toISOString(),
        ip: req.ip,
        interessenskonflikt: false,
        kommentar: `Zugewiesen an ${zielPerson.vorname} ${zielPerson.nachname}`,
        eskaliertVon: null,
      });
      await sendNotification(db, mailer, {
        to: zielPerson.email,
        subject: 'Freigabeportal: Neue Rechnung zur Kontierung zugewiesen',
        text: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
        typ: 'zuweisung',
        jobId: job.id,
      });
      res.json({ id: job.id, status: 'zugewiesen' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Wire up `csrfProtection`/`mailer` in `app.js`**

In `src/app.js`, change the `/pool` mount (around line 164):

```js
  app.use('/pool', sessionLimiter, requireLogin(), createPoolPageRouter({ db, config, mailer, csrfProtection }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS. Then run `node --test` (full suite) to confirm nothing else regressed from the `app.js` change.

- [ ] **Step 6: Commit**

```bash
git add src/routes/poolPage.js src/app.js test/integration/poolPage.test.js
git commit -m "feat(pool): add POST /pool/:id/zuweisen and expose Rückläufer to /pool for pool_zuweisen holders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Route `POST /kontierung/:id/an-gruppe-zurueck`

**Files:**
- Modify: `src/routes/kontierung.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `sendJobBackToGroup` (Task 6), `loadAuthorizedJob` (existing, same file).
- Produces: `POST /kontierung/:id/an-gruppe-zurueck` (redirect-based, mirrors `/:id/zurueck-in-pool`).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/kontierung.test.js`, near the existing `zurueck-in-pool` tests (search for `'/zurueck-in-pool'` to find them):

```js
test('POST /kontierung/:id/an-gruppe-zurueck requires a non-empty Bemerkung', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const app = buildTestApp(db, { async sendMail() {} });
  const res = await request(app).post(`/kontierung/${jobId}/an-gruppe-zurueck`).set('x-test-person-id', '1').type('form').send({ bemerkung: '  ' });
  assert.equal(res.status, 400);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen', 'a rejected empty Bemerkung must not release the job');
  db.close();
});

test('POST /kontierung/:id/an-gruppe-zurueck sends the job back to unzugewiesen with the Bemerkung stored, no mail', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  const app = buildTestApp(db, mailer);
  const res = await request(app)
    .post(`/kontierung/${jobId}/an-gruppe-zurueck`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ bemerkung: 'Falsche Person, bitte an Buchhaltung' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.pool_rueckgesendet_bemerkung, 'Falsche Person, bitte an Buchhaltung');
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'pool_ruecksendung'), true);
  assert.equal(mailer.sent.length, 0);
  db.close();
});

test('POST /kontierung/:id/an-gruppe-zurueck returns 403 for a job not assigned to the current person', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const app = buildTestApp(db, { async sendMail() {} });
  const res = await request(app).post(`/kontierung/${jobId}/an-gruppe-zurueck`).set('x-test-person-id', '2').type('form').send({ bemerkung: 'x' });
  assert.equal(res.status, 403);
  db.close();
});
```

The existing `buildTestApp(db, mailer)` in this file already passes `mailer` to `createKontierungRouter`, so no signature change needed there — just make sure calls pass a mailer object (existing lightweight tests using `buildTestApp(db)` with only one arg would get `mailer === undefined`; check each new test above explicitly passes a stub mailer, as written).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement**

In `src/routes/kontierung.js`, add `sendJobBackToGroup` to the `jobsRepo.js` import list at the top, and add the route right after the existing `router.post('/:id/zurueck-in-pool', ...)` handler (after its closing `});`, before `function renderAufsplittenForm`):

```js
  router.post('/:id/an-gruppe-zurueck', csrfProtection, (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;

    const bemerkung = (req.body.bemerkung || '').trim();
    if (!bemerkung) {
      return res.status(400).render('error', { message: 'Bitte eine Bemerkung angeben.' });
    }

    sendJobBackToGroup(db, job.id, job.zugewiesen_an, { bemerkung });
    createFreigabe(db, {
      jobId: job.id,
      personId: req.currentPerson.churchtools_person_id,
      rolle: 'pool_ruecksendung',
      zeitpunkt: new Date().toISOString(),
      ip: req.ip,
      interessenskonflikt: false,
      kommentar: bemerkung,
      eskaliertVon: null,
    });
    res.redirect('/pool');
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "feat(kontierung): add POST /kontierung/:id/an-gruppe-zurueck

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: UI `/pool` — "An Person senden"-Formular + Rückläufer-Sektion

**Files:**
- Modify: `views/_job_table.ejs`
- Modify: `views/pool.ejs`
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Consumes: `kannZuweisen`, `zielPersonen`, `ruecklaeufer` (produced by Task 7's GET `/pool`).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/poolPage.test.js`:

```js
test('GET /pool shows the An-Person-senden form on Pool rows for a pool_zuweisen holder, not for a plain Buchhaltung person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db, '50');
  setBerechtigungenForPerson(db, '50', ['pool_zuweisen']);
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '50');
  assert.match(res.text, /class="zuweisen-form"/);
  assert.match(res.text, /Person1 Muster/);

  seedBuchhaltungPerson(db, '51');
  const resOhneRecht = await request(app).get('/pool').set('x-test-person-id', '51');
  assert.doesNotMatch(resOhneRecht.text, /class="zuweisen-form"/);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/poolPage.test.js`
Expected: FAIL — no such markup yet.

- [ ] **Step 3: Extend `_job_table.ejs`**

Replace the action `<td>` block (the `idPrefix === 'pool'` branch) with:

```html
            <td>
              <% if (typeof istPoolArtig !== 'undefined' && istPoolArtig) { %>
                <button type="button" class="beanspruchen-btn btn btn-primary btn-sm" data-job-id="<%= job.id %>">Beanspruchen</button>
                <% if (typeof kannZuweisen !== 'undefined' && kannZuweisen) { %>
                  <form class="zuweisen-form d-inline-flex gap-1 align-items-center mt-1" data-job-id="<%= job.id %>">
                    <select class="form-select form-select-sm" name="personId" style="width:auto" required>
                      <option value="">— an Person senden —</option>
                      <% zielPersonen.forEach((p) => { %>
                        <option value="<%= p.churchtools_person_id %>"><%= p.nachname %> <%= p.vorname %></option>
                      <% }) %>
                    </select>
                    <button type="submit" class="btn btn-outline-primary btn-sm">Senden</button>
                  </form>
                <% } %>
                <% if (job.pool_rueckgesendet_bemerkung) { %>
                  <div class="text-muted small mt-1">Rückläufer von <%= job.rueckgesendetVonName %>: „<%= job.pool_rueckgesendet_bemerkung %>“</div>
                <% } %>
              <% } else { %>
                <a href="<%= linkPrefix %>/<%= job.id %>" class="btn btn-outline-primary btn-sm"><%= aktionLabel %></a>
                <% if (idPrefix === 'kontierung') { %>
                  <form method="post" action="/kontierung/<%= job.id %>/zurueck-in-pool" class="d-inline">
                    <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
                    <button type="submit" class="btn btn-outline-secondary btn-sm">In den Pool legen</button>
                  </form>
                <% } %>
              <% } %>
            </td>
```

(`zielPersonen` must always be defined whenever `istPoolArtig` is passed — Task 4/9 guarantees this from `pool.ejs`'s two `_job_table` includes below; other pages never pass `istPoolArtig` so they fall into the `else` branch unchanged, exactly like before.)

- [ ] **Step 4: Extend `pool.ejs`**

Change the existing Pool section's include (around line 16) to pass the three new locals, and add a new Rückläufer section right after it:

```html
    <% if (typeof isBuchhaltung !== 'undefined' && (isBuchhaltung || isSuperadmin) && poolJobs.length > 0) { %>
      <h2 class="h4 mt-4">Pool</h2>
      <%- include('_job_table', { jobs: poolJobs, idPrefix: 'pool', istPoolArtig: true, kannZuweisen, zielPersonen }) %>
    <% } %>

    <% if (typeof kannZuweisen !== 'undefined' && kannZuweisen && ruecklaeufer.length > 0) { %>
      <h2 class="h4 mt-4">Rückläufer</h2>
      <%- include('_job_table', { jobs: ruecklaeufer, idPrefix: 'ruecklaeufer', istPoolArtig: true, kannZuweisen, zielPersonen }) %>
    <% } %>
```

Add the `.zuweisen-form` submit handler at the bottom `<script>` block, right after the existing `.beanspruchen-btn` handler:

```html
    document.querySelectorAll('.zuweisen-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const id = form.dataset.jobId;
        const personId = form.querySelector('select[name="personId"]').value;
        const res = await fetch(`/pool/${id}/zuweisen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': '<%= locals.csrfToken || '' %>' },
          body: new URLSearchParams({ personId }),
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Zuweisung fehlgeschlagen.');
      });
    });
```

Also update the empty-state condition (around line 56-58) to include `ruecklaeufer.length === 0` in the `&&` chain, so "Keine offenen Aufgaben" doesn't show while Rückläufer are waiting.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/poolPage.test.js`
Expected: PASS. Then run the full suite (`node --test`) — `_job_table.ejs` is shared by `freigabe2`, `spesen-freigabe1`, `meine-abgeschlossenen`, `abgelehnt`, none of which pass `istPoolArtig`, so they must be unaffected; confirm no regressions.

- [ ] **Step 6: Commit**

```bash
git add views/_job_table.ejs views/pool.ejs test/integration/poolPage.test.js
git commit -m "feat(pool): add An-Person-senden form and Rückläufer section to /pool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: UI `/kontierung/:id` — "An Gruppe zurücksenden"-Modal

**Files:**
- Modify: `views/kontierung.ejs`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: nothing new — posts to Task 8's route.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/kontierung.test.js`:

```js
test('GET /kontierung/:id renders the An-Gruppe-zurücksenden form', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  const app = buildTestApp(db, { async sendMail() {} });
  const res = await request(app).get(`/kontierung/${jobId}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /an-gruppe-zurueck-form/);
  assert.match(res.text, /name="bemerkung"/);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — markup doesn't exist.

- [ ] **Step 3: Implement**

In `views/kontierung.ejs`, add a new hidden form right after the existing `zurueck-in-pool-form` (around line 139):

```html
            <form id="an-gruppe-zurueck-form" method="post" action="/kontierung/<%= job.id %>/an-gruppe-zurueck">
              <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
            </form>
```

Add a new button next to "Zurück in den Pool legen" (around line 144):

```html
              <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-toggle="modal" data-bs-target="#an-gruppe-zurueck-modal">An Gruppe zurücksenden</button>
```

Add a new modal right after the `zurueck-in-pool-modal` (after its closing `</div>` around line 192):

```html
    <div class="modal fade" id="an-gruppe-zurueck-modal" tabindex="-1" aria-labelledby="an-gruppe-zurueck-modal-label" aria-hidden="true">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="an-gruppe-zurueck-modal-label">An Gruppe zurücksenden</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Schließen"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label" for="bemerkung-ruecksendung">Bemerkung <span class="text-muted">(Pflicht)</span></label>
              <textarea class="form-control" id="bemerkung-ruecksendung" name="bemerkung" form="an-gruppe-zurueck-form" required></textarea>
              <div class="form-text">Die Rechnung geht zurück an das Team, das Pool-Belege zuweisen kann, mit deiner Bemerkung.</div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Abbrechen</button>
            <button type="submit" form="an-gruppe-zurueck-form" class="btn btn-primary">An Gruppe zurücksenden</button>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add views/kontierung.ejs test/integration/kontierung.test.js
git commit -m "feat(kontierung): add An-Gruppe-zurücksenden modal to the Kontierung page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Strikte Freigeber1-Prüfung — Kontierung-POST-Handler

**Files:**
- Modify: `src/db/jobsRepo.js`
- Modify: `src/services/auditLog.js`
- Modify: `src/routes/kontierung.js`
- Test: `test/unit/jobsRepo.test.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Produces: `weiterleitenAnEchtenFreigeber1(db, jobId, freigeber1Id)`; `EREIGNIS_LABEL.freigabe1_weiterleitung`; new branch inside the existing `router.post('/:id', ...)` handler, gated by `admin_config` key `kontierung_strikte_freigeber1_pruefung` (Task 3).

- [ ] **Step 1: Write the failing unit test for the repo function**

Add to `test/unit/jobsRepo.test.js`, after `abschliessenFreigabe1`'s tests (search for `abschliessenFreigabe1` to find them):

```js
test('weiterleitenAnEchtenFreigeber1 reassigns zugewiesen_an without touching status or escalation fields', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '3');
  setKontierung(db, jobId, 1);

  weiterleitenAnEchtenFreigeber1(db, jobId, '1');
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.equal(job.freigabe1_eskaliert_von, null);
  db.close();
});
```

Add `weiterleitenAnEchtenFreigeber1` to the top import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the repo function**

In `src/db/jobsRepo.js`, add right after `eskalierenFreigabe1` (around line 214):

```js
export function weiterleitenAnEchtenFreigeber1(db, jobId, freigeber1Id) {
  db.prepare('UPDATE jobs SET zugewiesen_an = ? WHERE id = ?').run(freigeber1Id, jobId);
}
```

- [ ] **Step 4: Add the audit-log label**

In `src/services/auditLog.js`, add after `pool_ruecksendung: 'An Gruppe zurückgesendet',`:

```js
  freigabe1_weiterleitung: 'An Freigeber 1 weitergeleitet (Kontierung durch andere Person)',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS.

- [ ] **Step 6: Write the failing integration tests**

Add to `test/integration/kontierung.test.js`. These need `setConfigValue` — add `import { setConfigValue } from '../../src/db/adminConfigRepo.js';` at the top if not already present.

```js
test('POST /kontierung/:id: toggle off (default) — a non-Freigeber1 person still grants Freigabe 1 directly, unchanged behavior', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db); // Konto 3000: freigeber1=1, stellvertreter1=2, freigeber2=3, stellvertreter2=4
  upsertPerson(db, { id: '99', vorname: 'Ohne', nachname: 'Rolle', email: 'ohne@example.org', gruppen: ['10'], loggedInNow: true });
  const { createDebitor } = await import('../../src/db/debitorenRepo.js');
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: 1 });
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '99');
  const app = buildTestApp(db, { async sendMail() {} });

  const res = await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ aktion: 'kontieren', kontoId: '1', absender: 'Muster AG', debitorId: String(debitorId), rechnungsnummer: 'RE-1', betrag: '10.00', zahlungsziel: '2026-10-01', typ: 'rechnung', interessenskonflikt: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2', 'toggle off must keep the old behavior: any kontierende person without a declared conflict grants Freigabe 1');
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'freigeber1' && f.person_id === '99'), true);
  db.close();
});
```

```js
test('POST /kontierung/:id: toggle on — the real Freigeber1 kontiert grants Freigabe 1 as usual', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  const { createDebitor } = await import('../../src/db/debitorenRepo.js');
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: 1 });
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1'); // person '1' IS Konto 3000's freigeber1
  const app = buildTestApp(db, { async sendMail() {} });

  const res = await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ aktion: 'kontieren', kontoId: '1', absender: 'Muster AG', debitorId: String(debitorId), rechnungsnummer: 'RE-1', betrag: '10.00', zahlungsziel: '2026-10-01', typ: 'rechnung', interessenskonflikt: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'freigeber1'), true);
  db.close();
});

test('POST /kontierung/:id: toggle on — a person who only holds Freigeber2 on the chosen Konto is forwarded to the real Freigeber1 instead of granting Freigabe 1', async () => {
  const db = openDatabase(':memory:');
  seedKontoAndPersonen(db);
  setConfigValue(db, 'kontierung_strikte_freigeber1_pruefung', '1');
  const { createDebitor } = await import('../../src/db/debitorenRepo.js');
  const debitorId = createDebitor(db, { name: 'Muster AG', kontoId: 1 });
  const jobId = createJob(db, { eingangAm: '2026-09-06T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '3'); // person '3' is Konto 3000's freigeber2, NOT freigeber1
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'kontieren', kontoId: '1', absender: 'Muster AG', debitorId: String(debitorId), rechnungsnummer: 'RE-1', betrag: '10.00', zahlungsziel: '2026-10-01', typ: 'rechnung', interessenskonflikt: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen', 'must NOT advance to freigabe2 — Freigabe 1 was not granted');
  assert.equal(job.zugewiesen_an, '1', 'must be handed to the real Freigeber1');
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'freigeber1'), false);
  assert.equal(listFreigabenByJob(db, jobId).some((f) => f.rolle === 'freigabe1_weiterleitung'), true);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org');

  // The real Freigeber1 now kontiert the same job and grants Freigabe 1 normally.
  const res2 = await request(app)
    .post(`/kontierung/${jobId}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ aktion: 'kontieren', kontoId: '1', absender: 'Muster AG', debitorId: String(debitorId), rechnungsnummer: 'RE-1', betrag: '10.00', zahlungsziel: '2026-10-01', typ: 'rechnung', interessenskonflikt: '' });
  assert.equal(res2.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2');
  db.close();
});
```

(Add `createDebitor` to the top imports if missing, and `setConfigValue` as noted.)

- [ ] **Step 7: Run tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — the toggle-on tests currently behave like toggle-off (instant Freigabe 1 for anyone).

- [ ] **Step 8: Implement the branch in `kontierung.js`**

Add `weiterleitenAnEchtenFreigeber1` to the `jobsRepo.js` import list at the top of the file (`getConfigValue` is already imported).

In the main `router.post('/:id', ...)` handler, the existing code (immediately after the `if (errors.length > 0) { return renderFehler(errors); }` check) reads exactly:

```js
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        updateKontierungMetadaten(db, job.id, {
          absender,
          betrag: betrag ? betrag.replace(',', '.') : null,
          zahlungsziel,
          rechnungsnummer,
          lieferant: debitor ? debitor.name : null,
          debitorId: debitor ? debitor.id : null,
          typ: jobTyp,
        });
        if (eskaliertAnAdmin) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
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
          });
          abschliessenFreigabe1(db, job.id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
```

Use `Edit` with this exact block as `old_string`, replaced by (only the `eskaliertAnAdmin` line gains two new `const`s right after it, and only the final `else` arm becomes an `if`/`else`; every other line — `hatKonflikt` arm included — is unchanged):

```js
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
      const strikteFreigeber1Pruefung = getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') === '1';
      const istEchterFreigeber1 =
        konto.freigeber1_id === req.currentPerson.churchtools_person_id ||
        (Boolean(job.freigabe1_eskaliert_von) && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);
      const wirdWeitergeleitet = !hatKonflikt && !eskaliertAnAdmin && strikteFreigeber1Pruefung && !job.freigabe1_eskaliert_an_admin && !istEchterFreigeber1;

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        updateKontierungMetadaten(db, job.id, {
          absender,
          betrag: betrag ? betrag.replace(',', '.') : null,
          zahlungsziel,
          rechnungsnummer,
          lieferant: debitor ? debitor.name : null,
          debitorId: debitor ? debitor.id : null,
          typ: jobTyp,
        });
        if (eskaliertAnAdmin) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'freigabe1_eskalation',
            zeitpunkt: new Date().toISOString(),
            ip: req.ip,
            interessenskonflikt: true,
            kommentar: begruendung,
            eskaliertVon: job.freigabe1_eskaliert_von,
          });
          eskalierenFreigabe1(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung, stellvertreterId: konto.stellvertreter1_id });
        } else if (wirdWeitergeleitet) {
          weiterleitenAnEchtenFreigeber1(db, job.id, konto.freigeber1_id);
          createFreigabe(db, { jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'freigabe1_weiterleitung', zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: begruendung || null, eskaliertVon: job.freigabe1_eskaliert_von });
        } else {
          createFreigabe(db, { jobId: job.id, personId: req.currentPerson.churchtools_person_id, rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip: req.ip, interessenskonflikt: false, kommentar: begruendung || null, eskaliertVon: job.freigabe1_eskaliert_von });
          abschliessenFreigabe1(db, job.id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
```

And the mail section's final `else` (this whole block replaces the existing `if (eskaliertAnAdmin) { ... } else if (hatKonflikt) { ... } else { ... }` mail block — the `eskaliertAnAdmin` and `hatKonflikt` arms are copied verbatim from the current file, unchanged; only a new `wirdWeitergeleitet` arm is inserted before the final `else`):

```js
      if (eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else if (wirdWeitergeleitet) {
        const echterFreigeber1 = getPersonById(db, konto.freigeber1_id);
        if (echterFreigeber1) {
          await sendNotification(db, mailer, {
            to: echterFreigeber1.email,
            subject: 'Freigabeportal: Rechnung kontiert — wartet auf deine Freigabe 1',
            text: `Eine Rechnung wurde von ${req.currentPerson.vorname} ${req.currentPerson.nachname} kontiert und wartet auf deine Freigabe 1: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else {
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      }
```

Both replacements (the transaction body and this mail block) sit inside the existing `router.post('/:id', ...)` handler in `src/routes/kontierung.js` — use `Read` on the file first to get precise line numbers for the `Edit` tool (they shift slightly once Step 8's first replacement is applied), then match the exact current text shown in this task's earlier exploration (the `eskaliertAnAdmin`/`hatKonflikt`/final-`else` blocks) as the `old_string`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS, including every pre-existing test in this file (regression check — toggle defaults to `'0'`, so untouched tests must behave exactly as before).

- [ ] **Step 10: Run the full suite**

Run: `node --test`
Expected: PASS. This is the highest-risk change in the plan (edits the core Kontierung transaction) — do not skip this full-suite run.

- [ ] **Step 11: Commit**

```bash
git add src/db/jobsRepo.js src/services/auditLog.js src/routes/kontierung.js test/unit/jobsRepo.test.js test/integration/kontierung.test.js
git commit -m "feat(kontierung): add configurable strict Freigeber1 check, forwarding non-Freigeber1 Kontierungen to the real Freigeber1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: `csrfSweep.test.js` Ergänzung

**Files:**
- Modify: `test/integration/csrfSweep.test.js`

**Interfaces:**
- Consumes: the two new POST routes from Tasks 7 and 8.

- [ ] **Step 1: Write the failing assertion**

In `test/integration/csrfSweep.test.js`, add to `SESSION_POST_ROUTES` (after `'/admin/module'` from the earlier Spesenmodul work):

```js
  '/pool/1/zuweisen',
  '/kontierung/1/an-gruppe-zurueck',
```

Update the sanity-check count (currently `41`) to `43`.

Note: `/pool/1/zuweisen` requires the logged-in sweep person to hold `pool_zuweisen` — check how `loginAs`/the sweep's single test person is granted permissions (search for where `setBerechtigungenForPerson` or similar is called for the sweep's superadmin test person; a superadmin already gets `pool_zuweisen` implicitly via `personHasPermission`, so no extra grant should be needed as long as the sweep's person is logged in as superadmin — confirm this against the existing sweep person's `gruppen` in `loginAs(app, client, { ..., gruppen: ['10', '20'] })`, which already includes group `20` = superadmin).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/csrfSweep.test.js`
Expected: FAIL initially (count mismatch or a route not yet rejecting missing CSRF correctly — should actually PASS immediately once the count is right, since both routes already call `csrfProtection` before business logic per Tasks 7/8; if it doesn't fail at all, that's fine — this is a consistency check more than new behavior, verify by temporarily reverting the count bump and confirming the sweep fails with a clear "wrong route count" message, then restore).

- [ ] **Step 3: Run full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/csrfSweep.test.js
git commit -m "test(csrf): add the two new pool/kontierung POST routes to the CSRF sweep

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Dokumentation

**Files:**
- Modify: `docs/rechnungs-workflow.md`
- Modify: `docs/auth-und-rechte.md`
- Modify: `docs/admin-bereich.md`

- [ ] **Step 1: `docs/rechnungs-workflow.md`**

In the state diagram (the ` ```mermaid stateDiagram-v2 ``` ` block), add two annotated self-loops right after the existing `zugewiesen --> unzugewiesen: zurück in den Pool legen` line:

```
    unzugewiesen --> zugewiesen: Pool-Weiterleitung an Person\n(Triage-Team, kein Kontieren)
    zugewiesen --> unzugewiesen: an Gruppe zurücksenden\nmit Bemerkung (Rückläufer)
    zugewiesen --> zugewiesen: Weiterleitung an echten Freigeber1\n(falls strikte Prüfung aktiv, kein Konflikt erklärt)
```

Add a short new subsection right before "## 2. Kontierung (Status `zugewiesen`)":

```markdown
## 1a. Pool-Weiterleitung an Personen

Ein additives Einzelrecht `pool_zuweisen` (siehe
[auth-und-rechte.md](auth-und-rechte.md)) erlaubt es, einen
`unzugewiesen`-Pool-Beleg direkt einer Person zuzuweisen
(`POST /pool/:id/zuweisen`), ohne selbst zu kontieren — identisch zum
Ergebnis von "Beanspruchen", nur mit fremder Zielperson. Wählbar sind
aktive Personen mit einer der vier Konto-Rollen (Freigeber1/2,
Stellvertreter1/2) auf mindestens einem aktiven Konto. Die Zielperson
kann den Beleg mit einer Pflicht-Bemerkung an die Gruppe zurücksenden
(`POST /kontierung/:id/an-gruppe-zurueck`) — er landet als "Rückläufer"
(drei `pool_rueckgesendet_*`-Spalten gesetzt) nicht in der normalen
Pool-Liste, sondern in einer eigenen Rückläufer-Sektion, nur für
`pool_zuweisen`-Inhaber sichtbar.
```

Add a short note in the Kontierung section (right after the existing paragraph about "Rechnung oder Gutschrift", before "Zusätzlich, unabhängig vom Ausgang"):

```markdown
**Strikte Freigeber1-Prüfung (optional, `/admin/module`)**: ist der
Schalter `kontierung_strikte_freigeber1_pruefung` aktiv, gilt Freigabe 1
nur noch als erteilt, wenn die kontierende Person tatsächlich Freigeber1
(oder bei laufender Eskalation: Stellvertreter1) des gewählten Kontos
ist. Andernfalls bleiben die erfassten Daten gespeichert, der Job bleibt
`zugewiesen`, wechselt aber zum echten Freigeber1 (`freigaben`-Eintrag
`freigabe1_weiterleitung`, Mail an ihn) — SYNC-8-Admin-Eskalationen
bleiben davon ausgenommen. Per Default deaktiviert (`'0'`).
```

- [ ] **Step 2: `docs/auth-und-rechte.md`**

Find the additive-permissions table/list (search for `konten_verwalten` or `audit_log_einsehen`) and add a row/entry for `pool_zuweisen`: "Pool-Belege an Personen zuweisen — erlaubt `POST /pool/:id/zuweisen`".

- [ ] **Step 3: `docs/admin-bereich.md`**

In the "Module (`/admin/module`)" section added by the earlier Spesenmodul work, add a second bullet describing the new toggle:

```markdown
Zweiter Schalter: **Strikte Freigeber1-Prüfung** (`kontierung_strikte_freigeber1_pruefung`, Default aus) — siehe
[rechnungs-workflow.md](rechnungs-workflow.md#2-kontierung-status-zugewiesen).
```

- [ ] **Step 4: Commit**

```bash
git add docs/rechnungs-workflow.md docs/auth-und-rechte.md docs/admin-bereich.md
git commit -m "docs: document Pool-Weiterleitung an Personen and strikte Freigeber1-Prüfung

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Feature 1 — Berechtigung (Task 2), Datenmodell (Task 1), Ziel-Personen-Auswahl (Task 4), Workflow A (Tasks 5, 7, 9), Workflow B (Tasks 6, 8, 9/10), Benachrichtigungen (Tasks 7, 8), Tests (every task), Doku (Task 13) — all covered. Feature 2 — Geltungsbereich/Admin-Konfiguration (Task 3), Mechanik (Task 11), Doku (Task 13) — all covered.
- **Placeholder scan:** no TBD/TODO/vague steps; Task 11 Step 8 inlines the complete exact "before" and "after" code for both the transaction body and the mail block (no `/* unchanged */` elisions).
- **Type consistency:** `assignJobToPerson(db, jobId, personId)`, `sendJobBackToGroup(db, jobId, currentZugewiesenAn, { bemerkung })`, `weiterleitenAnEchtenFreigeber1(db, jobId, freigeber1Id)`, `listPersonenMitFreigeberRolle(db)`, `listPoolRuecklaeufer(db)` are named and typed identically everywhere they're referenced across tasks.
