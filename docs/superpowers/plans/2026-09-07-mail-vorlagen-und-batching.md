# Mail-Vorlagen und Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 7 mail types admin-editable via `%variable%` templates, and add a global toggle between immediate sends and a daily per-recipient digest.

**Architecture:** A new `mailTemplates.js` renders `admin_config`-stored templates with caller-supplied variables. `sendNotification`'s signature changes from `{to, subject, text, typ, jobId}` to `{to, typ, jobId, variablen}` — it renders the template itself, then either sends immediately (`sendRenderedMail`, extracted from today's `sendNotification` body) or queues a `mail_log` row with a new `status = 'geplant'`. A new `runMailDigestJob` (same scheduler/cron pattern as the existing 6 jobs) periodically groups `geplant` rows by recipient into one digest mail each. All ~27 existing `sendNotification` call sites are converted to pass `variablen` instead of building `subject`/`text` strings.

**Tech Stack:** Node.js/Express, `node:sqlite`, EJS, `node --test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-09-07-mail-vorlagen-und-batching-design.md`

## Global Constraints

- Platzhalter-Syntax: `%variable%` (simple string replace, no HTML escaping).
- `sendNotification`'s new signature is `sendNotification(db, mailer, { to, typ, jobId, variablen })` — `subject`/`text` are gone from the public call, callers pass `variablen` instead.
- `sync-fehler` and `iban-warnung` are ALWAYS sent immediately, regardless of `mail_batching_aktiv` — never queued.
- `/admin/mail-einstellungen` is `requireRole(config, 'superadmin')` only — same hard lock as `/admin/eskalation`/`/admin/erscheinungsbild`/`/admin/zeitstempel`/`/admin/backup`.
- "Erneut versenden" (`/admin/mails/:id/erneut-versenden`) always resends immediately via the new `sendRenderedMail` primitive, bypassing both templating and the batching queue — it replays the exact `betreff`/`text` already stored in the row.
- **Deviation from the spec's variable table**, decided while writing this plan against the actual code (documented here so later tasks don't reintroduce the dropped variable): `iban-warnung` drops `%erwarteteIban%` — the current code never fetches/prints the stored Debitor IBAN, only the QR-detected one (`job.qr_iban`), and pulling in the expected IBAN would require changing `pruefeIbanAbgleich`'s return shape, which is out of scope. Final `iban-warnung` variables: `%jobDateiname%`, `%debitorName%`, `%tatsaechlicheIban%`, `%link%`. `rechnungsnummer-warnung` gains `%dupJobIds%` (the duplicate Job-IDs list, e.g. `"Job #12, #15"`) to preserve information the original text had. `ablehnung` is split into `%grund%` (a fixed framing sentence ending in `:`, e.g. `"Deine Rechnung wurde abgelehnt:"`) and `%begruendung%` (the actual rejection reason text) — this preserves the original two distinct wordings (self vs. admin-eskaliert) without needing two ablehnung templates.
- For mail recipients resolved from a group token (`resolveEmpfaenger(db, config, 'gruppe:admin'|'gruppe:buchhaltung')`), no `Person` object is available — only an email string. Use the fixed literal `%empfaengerName%` value `'Portal-Admin-Team'` for `gruppe:admin` loops and `'Buchhaltungs-Team'` for `gruppe:buchhaltung` loops. Every other recipient is a specific `Person` — use `` `${person.vorname} ${person.nachname}` ``.
- Every new `admin_config` key must be added to `DEFAULTS` in `src/db/adminConfigRepo.js` (Task 1) — nothing later depends on a key existing outside that object.

---

### Task 1: Schema migrations + admin_config defaults

**Files:**
- Modify: `src/db/schema.sql` (the `mail_log` and `cron_log` `CREATE TABLE` statements)
- Modify: `src/db/index.js` (add two migration functions + call them from `openDatabase`)
- Modify: `src/db/adminConfigRepo.js` (add 19 new `DEFAULTS` keys)
- Test: `test/unit/db.test.js` (two new migration tests)
- Test: `test/unit/adminConfigRepo.test.js` (two new default tests)

**Interfaces:**
- Produces: `mail_log.status` CHECK now includes `'geplant'`. `cron_log.job` CHECK now includes `'mail-digest'`. `admin_config` DEFAULTS gains the 16 template keys (`mail_vorlage_<infix>_betreff`/`_text` for `zuweisung`, `reminder`, `eskalation`, `ablehnung`, `sync_fehler`, `iban_warnung`, `rechnungsnummer_warnung`, `digest`) plus `mail_batching_aktiv` (`'0'`), `mail_batching_stunde` (`'7'`), `mail_batching_minute` (`'0'`).

- [ ] **Step 1: Update `src/db/schema.sql`'s `mail_log` and `cron_log` CREATE TABLE statements**

Find the `mail_log` table (around line 215) and change:
```sql
  status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
```
to:
```sql
  status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen', 'geplant')),
```

Find the `cron_log` table (around line 54) and change:
```sql
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
```
to:
```sql
  job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest')),
```

- [ ] **Step 2: Write the failing migration tests**

Add to `test/unit/db.test.js` (near the existing `rechnungsnummer-warnung`/`datenbank-sicherung` migration tests):

```js
test('openDatabase widens the mail_log table status CHECK to include geplant, even for a database already migrated to include rechnungsnummer-warnung', () => {
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
         VALUES ('zuweisung', 1, 'b@example.org', 'Betreff', 'Text', 'geplant', '2026-08-15T09:00:00.000Z')`
      )
      .run(),
    'the widened CHECK constraint must accept status = geplant'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDatabase widens the cron_log table job CHECK to include mail-digest, even for a database already migrated to include split-gruppen-nachholen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-test-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE cron_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen')),
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
        `INSERT INTO cron_log (job, gestartet_am, status) VALUES ('mail-digest', '2026-08-15T07:00:00.000Z', 'erfolg')`
      )
      .run(),
    'the widened CHECK constraint must accept job = mail-digest'
  );
  migratedDb.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/unit/db.test.js`
Expected: FAIL — both new tests throw a SQLite CHECK constraint violation on the `INSERT` (the migration functions don't exist yet).

- [ ] **Step 4: Add the two migration functions to `src/db/index.js`**

Add these two functions right after `migrateCronLogTableSplitGruppen` (same file, same section):

```js
// Same pattern as migrateMailLogTable above: an already-running database predating the
// batching feature has mail_log.status CHECK'd to only 'versendet'/'fehlgeschlagen' — sendNotification
// now needs a third value, 'geplant', for rows queued for the daily digest instead of sent immediately.
function migrateMailLogTableGeplantStatus(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_log'").get();
  if (!tableSql || tableSql.sql.includes('geplant')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE mail_log RENAME TO mail_log_pre_geplant_status');
    db.exec(`
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
      )
    `);
    db.exec(`
      INSERT INTO mail_log (id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
      SELECT id, typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am FROM mail_log_pre_geplant_status
    `);
    db.exec('DROP TABLE mail_log_pre_geplant_status');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Same pattern as migrateCronLogTableSplitGruppen above, one more CHECK widening for the new
// 'mail-digest' cron job (the daily per-recipient batching digest).
function migrateCronLogTableMailDigest(db) {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_log'").get();
  if (!tableSql || tableSql.sql.includes('mail-digest')) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE cron_log RENAME TO cron_log_pre_mail_digest');
    db.exec(`
      CREATE TABLE cron_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL CHECK(job IN ('pool-erinnerungen', 'pdf-bereinigung', 'zeitstempel-nachholen', 'datenbank-sicherung', 'split-gruppen-nachholen', 'mail-digest')),
        gestartet_am TEXT NOT NULL,
        beendet_am TEXT,
        status TEXT NOT NULL CHECK(status IN ('erfolg', 'fehler', 'laufend')),
        details TEXT
      )
    `);
    db.exec(`
      INSERT INTO cron_log (id, job, gestartet_am, beendet_am, status, details)
      SELECT id, job, gestartet_am, beendet_am, status, details FROM cron_log_pre_mail_digest
    `);
    db.exec('DROP TABLE cron_log_pre_mail_digest');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Then update `openDatabase` (append both calls at the end of the existing chain):
```js
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrateJobsTableQuelleCheck(db);
  migrateJobsTable(db);
  migrateFreigabenTable(db);
  migrateMailLogTable(db);
  migrateCronLogTable(db);
  migratePersonBerechtigungenTable(db);
  migrateCronLogTableSplitGruppen(db);
  migrateMailLogTableGeplantStatus(db);
  migrateCronLogTableMailDigest(db);
  return db;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/db.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 6: Write the failing adminConfigRepo tests**

Add to `test/unit/adminConfigRepo.test.js`:

```js
test('seedDefaults sets the 8 mail template defaults (betreff + text each)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_betreff'), 'Freigabeportal: Neue Rechnung zur Bearbeitung');
  assert.equal(getConfigValue(db, 'mail_vorlage_reminder_betreff'), 'Freigabeportal: Rechnung wartet im Pool');
  assert.equal(getConfigValue(db, 'mail_vorlage_eskalation_betreff'), 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht');
  assert.equal(getConfigValue(db, 'mail_vorlage_ablehnung_betreff'), 'Freigabeportal: Rechnung abgelehnt');
  assert.equal(getConfigValue(db, 'mail_vorlage_sync_fehler_betreff'), 'Freigabeportal: ChurchTools-Sync fehlgeschlagen');
  assert.equal(getConfigValue(db, 'mail_vorlage_iban_warnung_betreff'), 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt');
  assert.equal(getConfigValue(db, 'mail_vorlage_rechnungsnummer_warnung_betreff'), 'Freigabeportal: Doppelte Rechnungsnummer festgestellt');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_betreff'), 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)');
  assert.match(getConfigValue(db, 'mail_vorlage_zuweisung_text'), /%empfaengerName%/);
  assert.match(getConfigValue(db, 'mail_vorlage_digest_text'), /%eintraege%/);
  db.close();
});

test('seedDefaults sets mail_batching_aktiv default (off out of the box)', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '7');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '0');
  db.close();
});
```

- [ ] **Step 7: Run to verify they fail**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: FAIL — the new keys don't exist in `DEFAULTS` yet, `getConfigValue` returns `null`.

- [ ] **Step 8: Add the 19 new keys to `DEFAULTS` in `src/db/adminConfigRepo.js`**

Add these entries to the `DEFAULTS` object (after `kontierung_strikte_freigeber1_pruefung: '0',`):

```js
  mail_vorlage_zuweisung_betreff: 'Freigabeportal: Neue Rechnung zur Bearbeitung',
  mail_vorlage_zuweisung_text: 'Hallo %empfaengerName%,\n\n%grund%\n\nBeleg: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_reminder_betreff: 'Freigabeportal: Rechnung wartet im Pool',
  mail_vorlage_reminder_text: 'Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_eskalation_betreff: 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht',
  mail_vorlage_eskalation_text: 'Diese Rechnung ist seit mehr als %stunden% Stunden unbeansprucht im Pool und wurde eskaliert: %jobDateiname%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_ablehnung_betreff: 'Freigabeportal: Rechnung abgelehnt',
  mail_vorlage_ablehnung_text: 'Hallo %empfaengerName%,\n\n%grund% %jobDateiname%\n\nGrund: %begruendung%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_sync_fehler_betreff: 'Freigabeportal: ChurchTools-Sync fehlgeschlagen',
  mail_vorlage_sync_fehler_text: 'Der ChurchTools-Personen-Sync konnte nicht erfolgreich abgeschlossen werden (%zeitpunkt%): %fehlerDetails%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_iban_warnung_betreff: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
  mail_vorlage_iban_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %debitorName%) weicht die im QR-Code gefundene IBAN (%tatsaechlicheIban%) von der hinterlegten IBAN ab.\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_rechnungsnummer_warnung_betreff: 'Freigabeportal: Doppelte Rechnungsnummer festgestellt',
  mail_vorlage_rechnungsnummer_warnung_text: 'Bei der Kontierung von "%jobDateiname%" (Lieferant: %debitorName%) wurde die Rechnungsnummer "%rechnungsnummer%" bereits bei einem anderen Job erfasst (%dupJobIds%).\n\nBitte prüfen: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_vorlage_digest_betreff: 'Freigabeportal: Tägliche Zusammenfassung (%anzahl% Ereignisse)',
  mail_vorlage_digest_text: 'Hallo %empfaengerName%,\n\nfolgende Ereignisse warten auf dich:\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
  mail_batching_aktiv: '0',
  mail_batching_stunde: '7',
  mail_batching_minute: '0',
```

- [ ] **Step 9: Run to verify they pass**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: PASS

- [ ] **Step 10: Run the full suite and commit**

Run: `npm test`
Expected: PASS (no other file references these new columns/keys yet, so nothing else should break)

```bash
git add src/db/schema.sql src/db/index.js src/db/adminConfigRepo.js test/unit/db.test.js test/unit/adminConfigRepo.test.js
git commit -m "feat(mail): add mail_log.geplant status, cron_log.mail-digest job, and 19 new admin_config defaults for mail templates + batching"
```

---

### Task 2: `renderTemplate` + `getVorlage`

**Files:**
- Create: `src/services/mailTemplates.js`
- Test: `test/unit/mailTemplates.test.js`

**Interfaces:**
- Consumes: `getConfigValue` from `src/db/adminConfigRepo.js` (Task 1).
- Produces: `renderTemplate(vorlage, variablen)` — `(string, object) => string`. `getVorlage(db, typ)` — `(db, string) => { betreff: string, text: string }`, where `typ` is one of `'zuweisung'`, `'reminder'`, `'eskalation'`, `'ablehnung'`, `'sync-fehler'`, `'iban-warnung'`, `'rechnungsnummer-warnung'`, `'digest'`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/mailTemplates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { renderTemplate, getVorlage } from '../../src/services/mailTemplates.js';

test('renderTemplate replaces every occurrence of a known placeholder', () => {
  const result = renderTemplate('Hallo %name%, %name% hat Post.', { name: 'Erika' });
  assert.equal(result, 'Hallo Erika, Erika hat Post.');
});

test('renderTemplate leaves unknown placeholders untouched', () => {
  const result = renderTemplate('Hallo %name%, dein %unbekannt% bleibt stehen.', { name: 'Erika' });
  assert.equal(result, 'Hallo Erika, dein %unbekannt% bleibt stehen.');
});

test('renderTemplate coerces non-string variable values to strings', () => {
  const result = renderTemplate('Anzahl: %anzahl%', { anzahl: 3 });
  assert.equal(result, 'Anzahl: 3');
});

test('getVorlage reads betreff and text for a given typ from admin_config', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'reminder');
  assert.equal(vorlage.betreff, 'Freigabeportal: Rechnung wartet im Pool');
  assert.match(vorlage.text, /%stunden%/);
  db.close();
});

test('getVorlage reflects an admin-edited template', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_vorlage_reminder_betreff', 'Angepasster Betreff');
  const vorlage = getVorlage(db, 'reminder');
  assert.equal(vorlage.betreff, 'Angepasster Betreff');
  db.close();
});

test('getVorlage maps hyphenated typ values to their underscore admin_config key', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'sync-fehler');
  assert.equal(vorlage.betreff, 'Freigabeportal: ChurchTools-Sync fehlgeschlagen');
  db.close();
});

test('getVorlage supports the digest pseudo-typ', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'digest');
  assert.match(vorlage.text, /%eintraege%/);
  db.close();
});

test('getVorlage throws for an unknown typ', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.throws(() => getVorlage(db, 'unbekannt'));
  db.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/mailTemplates.test.js`
Expected: FAIL with "Cannot find module '../../src/services/mailTemplates.js'"

- [ ] **Step 3: Create `src/services/mailTemplates.js`**

```js
import { getConfigValue } from '../db/adminConfigRepo.js';

const TYP_ZU_KEY_INFIX = {
  zuweisung: 'zuweisung',
  reminder: 'reminder',
  eskalation: 'eskalation',
  ablehnung: 'ablehnung',
  'sync-fehler': 'sync_fehler',
  'iban-warnung': 'iban_warnung',
  'rechnungsnummer-warnung': 'rechnungsnummer_warnung',
  digest: 'digest',
};

export function renderTemplate(vorlage, variablen) {
  return vorlage.replace(/%([a-zA-Z0-9_]+)%/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variablen, key) ? String(variablen[key]) : match
  );
}

export function getVorlage(db, typ) {
  const infix = TYP_ZU_KEY_INFIX[typ];
  if (!infix) {
    throw new Error(`Unbekannter Mail-Vorlagen-Typ: ${typ}`);
  }
  return {
    betreff: getConfigValue(db, `mail_vorlage_${infix}_betreff`),
    text: getConfigValue(db, `mail_vorlage_${infix}_text`),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/unit/mailTemplates.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/mailTemplates.js test/unit/mailTemplates.test.js
git commit -m "feat(mail): add renderTemplate + getVorlage for admin-editable mail templates"
```

---

### Task 3: `sendNotification` refactor (templating + batching decision)

**Files:**
- Modify: `src/services/notify.js`
- Modify: `test/unit/notify.test.js`

**Interfaces:**
- Consumes: `getVorlage`, `renderTemplate` from `src/services/mailTemplates.js` (Task 2). `getConfigValue` from `src/db/adminConfigRepo.js`.
- Produces: `sendRenderedMail(db, mailer, { to, subject, text, typ, jobId })` — the low-level immediate-send-and-log primitive (same behavior as today's `sendNotification`), used by Task 4's resend route. `sendNotification(db, mailer, { to, typ, jobId, variablen })` — renders the template for `typ`, then either sends immediately via `sendRenderedMail` or logs a `status: 'geplant'` row, per the batching rules below. `resolveEmpfaenger` is unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the first three tests in `test/unit/notify.test.js` (the ones calling the old `{to, subject, text, typ, jobId}` signature) with:

```js
import { setConfigValue, seedDefaults } from '../../src/db/adminConfigRepo.js';
```
(add this import at the top, alongside the existing imports)

```js
test('sendRenderedMail logs a versendet row on success and calls the mailer with the right fields', async () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  await sendRenderedMail(db, mailer, { to: 'x@example.org', subject: 'Betreff', text: 'Text', typ: 'zuweisung', jobId });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');
  assert.equal(mailer.sent[0].subject, 'Betreff');
  assert.equal(mailer.sent[0].text, 'Text');

  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'versendet');
  assert.equal(rows[0].typ, 'zuweisung');
  assert.equal(rows[0].job_id, jobId);
  db.close();
});

test('sendRenderedMail logs a fehlgeschlagen row on failure and never throws', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer({ shouldFail: true });
  await assert.doesNotReject(() =>
    sendRenderedMail(db, mailer, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Testfehler');
  db.close();
});

test('sendRenderedMail degrades gracefully when mailer is undefined', async () => {
  const db = openDatabase(':memory:');
  await assert.doesNotReject(() =>
    sendRenderedMail(db, undefined, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  db.close();
});

test('sendNotification renders the configured template and sends immediately when batching is off', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'x@example.org',
    typ: 'zuweisung',
    jobId,
    variablen: { empfaengerName: 'Erika Muster', jobDateiname: 'a.pdf', grund: 'Dir wurde eine neue Rechnung zugewiesen.', link: 'http://portal.example.org/kontierung/1' },
  });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, 'Freigabeportal: Neue Rechnung zur Bearbeitung');
  assert.match(mailer.sent[0].text, /Erika Muster/);
  assert.match(mailer.sent[0].text, /Dir wurde eine neue Rechnung zugewiesen\./);

  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'versendet');
  assert.equal(rows[0].typ, 'zuweisung');
  db.close();
});

test('sendNotification queues a geplant row instead of sending when batching is active', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'x@example.org',
    typ: 'zuweisung',
    jobId: null,
    variablen: { empfaengerName: 'Erika Muster', jobDateiname: 'a.pdf', grund: 'G', link: 'L' },
  });

  assert.equal(mailer.sent.length, 0, 'no SMTP call while queued');
  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'geplant');
  assert.equal(rows[0].empfaenger, 'x@example.org');
  assert.match(rows[0].text, /Erika Muster/, 'the row already holds the fully-rendered text');
  db.close();
});

test('sendNotification ignores the batching switch for sync-fehler and always sends immediately', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'a@example.org',
    typ: 'sync-fehler',
    jobId: null,
    variablen: { fehlerDetails: 'Boom', zeitpunkt: '2026-09-07T10:00:00.000Z', link: 'http://portal.example.org/admin/sync' },
  });
  assert.equal(mailer.sent.length, 1);
  assert.equal(listMailLog(db)[0].status, 'versendet');
  db.close();
});

test('sendNotification ignores the batching switch for iban-warnung and always sends immediately', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, {
    to: 'a@example.org',
    typ: 'iban-warnung',
    jobId: null,
    variablen: { jobDateiname: 'a.pdf', debitorName: 'ACME', tatsaechlicheIban: 'CH00', link: 'L' },
  });
  assert.equal(mailer.sent.length, 1);
  assert.equal(listMailLog(db)[0].status, 'versendet');
  db.close();
});
```

Also update the import line to bring in `sendRenderedMail`:
```js
import { sendNotification, sendRenderedMail, resolveEmpfaenger } from '../../src/services/notify.js';
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/notify.test.js`
Expected: FAIL — `sendRenderedMail` doesn't exist yet, and `sendNotification` still expects `{subject, text}`.

- [ ] **Step 3: Rewrite `src/services/notify.js`**

Replace the file's `sendNotification` export (keep `resolveEmpfaenger` and its two constants unchanged) with:

```js
import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup } from '../db/personenRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';
const GRUPPE_ADMIN_TOKEN = 'gruppe:admin';

// sync-fehler (ChurchTools-Ausfall) und iban-warnung (Betrugsverdacht) sind betriebs-/
// sicherheitskritisch und ignorieren den globalen Batching-Schalter -- sie warten nie auf den
// nächsten Digest-Lauf.
const IMMER_SOFORT_TYPEN = new Set(['sync-fehler', 'iban-warnung']);

// The low-level "send now and log the attempt" primitive -- what sendNotification used to be
// before templating/batching existed. Kept as its own export because /admin/mails' "erneut
// versenden" replays an already-rendered mail_log row verbatim and must bypass both the template
// layer (there's no `variablen` to re-render from) and the batching queue (a manual resend is
// always immediate).
export async function sendRenderedMail(db, mailer, { to, subject, text, typ, jobId }) {
  try {
    await mailer.sendMail({ to, subject, text });
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'versendet' });
  } catch (err) {
    try {
      logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'fehlgeschlagen', fehlerDetails: err.message });
    } catch (logErr) {
      console.error('sendRenderedMail: logMailAttempt failed while recording a failed send', logErr);
    }
  }
}

export async function sendNotification(db, mailer, { to, typ, jobId, variablen = {} }) {
  const vorlage = getVorlage(db, typ);
  const portalName = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
  const alleVariablen = { ...variablen, portalName };
  const subject = renderTemplate(vorlage.betreff, alleVariablen);
  const text = renderTemplate(vorlage.text, alleVariablen);

  const batchingAktiv = getConfigValue(db, 'mail_batching_aktiv') === '1';
  if (!batchingAktiv || IMMER_SOFORT_TYPEN.has(typ)) {
    await sendRenderedMail(db, mailer, { to, subject, text, typ, jobId });
    return;
  }

  // Batching aktiv: nur protokollieren, kein SMTP-Call -- runMailDigestJob sammelt diese Zeile
  // später ein und verschickt sie als Teil der Digest-Mail des Empfängers.
  logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'geplant' });
}

export function resolveEmpfaenger(db, config, konfigWert) {
  if (!konfigWert) return [];
  const zeilen = konfigWert
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
  const empfaenger = new Set();
  for (const zeile of zeilen) {
    if (zeile === GRUPPE_BUCHHALTUNG_TOKEN) {
      for (const person of listActivePersonsInGroup(db, config.churchtools.groupIdBuchhaltung)) {
        empfaenger.add(person.email);
      }
    } else if (zeile === GRUPPE_ADMIN_TOKEN) {
      for (const person of listActivePersonsInGroup(db, config.churchtools.groupIdAdmin)) {
        empfaenger.add(person.email);
      }
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/unit/notify.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notify.js test/unit/notify.test.js
git commit -m "feat(mail): sendNotification renders admin-editable templates and queues geplant rows when batching is active"
```

**Note for the controller/reviewer:** after this task, every other file that calls `sendNotification` with the old `{subject, text}` shape is now broken (it will throw inside `getVorlage`/`renderTemplate` since `variablen` is missing the fields those templates need, or silently render `%placeholder%` literally into the sent text). This is expected and fixed by Tasks 5-8. Do not attempt to run `test/integration/mailversandEndToEnd.test.js`, `test/integration/kontierung.test.js`, `test/integration/freigabe2.test.js`, `test/integration/spesenFreigabe1.test.js`, `test/integration/spesen.test.js`, `test/integration/poolPage.test.js`, `test/integration/n8n/jobs.test.js`, or `test/unit/cronJobs.test.js` as a pass/fail gate for this task — they are expected red until Tasks 5-8 land. `npm test` as a whole will show these failures; that's fine, don't try to fix them here.

---

### Task 4: `/admin/mails` resend uses `sendRenderedMail`

**Files:**
- Modify: `src/routes/admin/mails.js`

**Interfaces:**
- Consumes: `sendRenderedMail` from `src/services/notify.js` (Task 3).

- [ ] **Step 1: Update the import and the resend call**

In `src/routes/admin/mails.js`, change:
```js
import { sendNotification } from '../../services/notify.js';
```
to:
```js
import { sendRenderedMail } from '../../services/notify.js';
```

And change the body of `router.post('/:id/erneut-versenden', ...)`:
```js
      await sendNotification(db, mailer, {
        to: eintrag.empfaenger,
        subject: eintrag.betreff,
        text: eintrag.text,
        typ: eintrag.typ,
        jobId: eintrag.job_id,
      });
```
to:
```js
      await sendRenderedMail(db, mailer, {
        to: eintrag.empfaenger,
        subject: eintrag.betreff,
        text: eintrag.text,
        typ: eintrag.typ,
        jobId: eintrag.job_id,
      });
```

- [ ] **Step 2: Run the existing admin/mails tests**

Run: `node --test test/integration/admin/mails.test.js`
Expected: PASS unchanged — `test/integration/admin/mails.test.js` asserts on HTTP status and row counts, not on which function was called internally, so no test changes are needed. This step is a verification, not a TDD red/green cycle (there's no new behavior here, only a swapped internal call).

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/mails.js
git commit -m "fix(mail): resend uses sendRenderedMail so it replays stored text verbatim, bypassing templates and the batching queue"
```

---

### Task 5: Convert `src/routes/kontierung.js` call sites

**Files:**
- Modify: `src/routes/kontierung.js` (13 `sendNotification` call sites)
- Modify: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `sendNotification(db, mailer, { to, typ, jobId, variablen })` (Task 3).

- [ ] **Step 1: Convert the 13 call sites**

For each, replace the old `{ to, subject, text, typ, jobId }` call with the new `{ to, typ, jobId, variablen }` shape. Below is every exact replacement (old block → new block), in file order.

**5a. ablehnung-eskaliert-an-admin:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
              text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
```

**5b. iban-warnung:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
              text: `Bei der Kontierung von "${job.dateiname}" (Lieferant: ${debitor.name}) weicht die im QR-Code gefundene IBAN (${job.qr_iban}) von der hinterlegten IBAN ab. Bitte prüfen: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'iban-warnung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'iban-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                debitorName: debitor.name,
                tatsaechlicheIban: job.qr_iban,
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
```

**5c. rechnungsnummer-duplikat:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Doppelte Rechnungsnummer festgestellt',
              text: `Bei der Kontierung von "${job.dateiname}" (Lieferant: ${debitor.name}) wurde die Rechnungsnummer "${rechnungsnummer}" bereits bei einem anderen Job erfasst (Job ${duplikate.map((d) => `#${d.id}`).join(', ')}). Bitte prüfen: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'rechnungsnummer-warnung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'rechnungsnummer-warnung',
              jobId: job.id,
              variablen: {
                jobDateiname: job.dateiname,
                debitorName: debitor.name,
                rechnungsnummer,
                dupJobIds: duplikate.map((d) => `#${d.id}`).join(', '),
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
```

**5d. interessenskonflikt-admin (`eskaliertAnAdmin` branch):**
```js
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: 'Portal-Admin-Team',
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
```

**5e. interessenskonflikt-stellvertreter1 (`hatKonflikt` branch):**
```js
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
```

**5f. freigabe1-weiterleitung (`wirdWeitergeleitet` branch):**
```js
          await sendNotification(db, mailer, {
            to: echterFreigeber1.email,
            subject: 'Freigabeportal: Rechnung kontiert — wartet auf deine Freigabe 1',
            text: `Eine Rechnung wurde von ${req.currentPerson.vorname} ${req.currentPerson.nachname} kontiert und wartet auf deine Freigabe 1: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: echterFreigeber1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${echterFreigeber1.vorname} ${echterFreigeber1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde von ${req.currentPerson.vorname} ${req.currentPerson.nachname} kontiert und wartet auf deine Freigabe 1.`,
              link: `${config.publicBaseUrl}/kontierung/${job.id}`,
            },
          });
```

**5g. freigabe2-wartend (`else` branch):**
```js
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
            typ: 'zuweisung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${freigeber2.vorname} ${freigeber2.nachname}`,
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
              link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
            },
          });
```

**5h. zurueck-in-pool-mit-hinweis:**
```js
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            subject: 'Freigabeportal: Rechnung vermutlich für dein Konto — bitte aus dem Pool holen',
            text: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${gueltigerHinweis.kontonummer} — ${gueltigerHinweis.bezeichnung} bestimmt ist: ${job.dateiname}\n\nBitte im Freigabeportal anmelden und aus dem Pool holen: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            typ: 'zuweisung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${gueltigerHinweis.kontonummer} — ${gueltigerHinweis.bezeichnung} bestimmt ist.`,
              link: `${config.publicBaseUrl}/pool`,
            },
          });
```

**5i. Aufsplitten — selbstFreigegeben loop:**
```js
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${kindJob.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
            typ: 'zuweisung',
            jobId: kindJob.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            typ: 'zuweisung',
            jobId: kindJob.id,
            variablen: {
              empfaengerName: `${freigeber2.vorname} ${freigeber2.nachname}`,
              jobDateiname: kindJob.dateiname,
              grund: 'Eine Rechnung wartet auf deine Freigabe 2.',
              link: `${config.publicBaseUrl}/freigabe2/${kindJob.id}`,
            },
          });
```

**5j. Aufsplitten — eskaliert (Stellvertreter1) loop:**
```js
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${kindId}`,
            typ: 'zuweisung',
            jobId: kindId,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            typ: 'zuweisung',
            jobId: kindId,
            variablen: {
              empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
              link: `${config.publicBaseUrl}/kontierung/${kindId}`,
            },
          });
```

**5k. Aufsplitten — eskaliertAnAdmin loop:**
```js
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${kindId}`,
            typ: 'zuweisung',
            jobId: kindId,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: email,
            typ: 'zuweisung',
            jobId: kindId,
            variablen: {
              empfaengerName: 'Portal-Admin-Team',
              jobDateiname: job.dateiname,
              grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
              link: `${config.publicBaseUrl}/kontierung/${kindId}`,
            },
          });
```

**5l. Aufsplitten — fremdeKonten (Hinweis) loop:**
```js
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            subject: 'Freigabeportal: Rechnung vermutlich für dein Konto — bitte aus dem Pool holen',
            text: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${konto.kontonummer} — ${konto.bezeichnung} bestimmt ist: ${job.dateiname}\n\nBitte im Freigabeportal anmelden und aus dem Pool holen: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: kindId,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: freigeber1.email,
            typ: 'zuweisung',
            jobId: kindId,
            variablen: {
              empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
              jobDateiname: job.dateiname,
              grund: `Eine Rechnung wurde mit dem Hinweis in den Pool zurückgelegt, dass sie vermutlich für dein Konto ${konto.kontonummer} — ${konto.bezeichnung} bestimmt ist.`,
              link: `${config.publicBaseUrl}/pool`,
            },
          });
```

**5m. Aufsplitten — iban-warnung (parent job):**
```js
              await sendNotification(db, mailer, {
                to: email,
                subject: 'Freigabeportal: IBAN-Abweichung bei Rechnung festgestellt',
                text: `Bei der Kontierung von "${job.dateiname}" (Lieferant: ${debitor.name}) weicht die im QR-Code gefundene IBAN (${job.qr_iban}) von der hinterlegten IBAN ab. Bitte prüfen: ${config.publicBaseUrl}/kontierung/${job.id}`,
                typ: 'iban-warnung',
                jobId: job.id,
              });
```
→
```js
              await sendNotification(db, mailer, {
                to: email,
                typ: 'iban-warnung',
                jobId: job.id,
                variablen: {
                  jobDateiname: job.dateiname,
                  debitorName: debitor.name,
                  tatsaechlicheIban: job.qr_iban,
                  link: `${config.publicBaseUrl}/kontierung/${job.id}`,
                },
              });
```

- [ ] **Step 2: Run the existing kontierung tests**

Run: `node --test test/integration/kontierung.test.js`
Expected: likely some FAIL — any test asserting the literal old `subject`/`text` strings (e.g. `assert.equal(mail.betreff, 'Freigabeportal: Neue Rechnung zur Freigabe 2')`, `assert.match(mail.text, /wartet auf deine Freigabe 2/)`) needs updating to the new unified subject and rendered template wording. Search the file for `.betreff`, `.text`, `assert.match(.*mail` and `subject:`/`text:` assertions and update each to match the new default template output (e.g. betreff becomes `'Freigabeportal: Neue Rechnung zur Bearbeitung'` for `zuweisung`-typ assertions, and body assertions should match against the `grund` sentence rather than the old inline sentence, since the wording is preserved verbatim in `grund`).

- [ ] **Step 3: Fix any failing assertions, then re-run to verify all pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "refactor(mail): convert kontierung.js's 13 sendNotification call sites to the templated variablen API"
```

---

### Task 6: Convert `freigabe2.js` and `spesenFreigabe1.js` call sites

**Files:**
- Modify: `src/routes/freigabe2.js` (4 call sites)
- Modify: `src/routes/spesenFreigabe1.js` (4 call sites)
- Modify: `test/integration/freigabe2.test.js`
- Modify: `test/integration/spesenFreigabe1.test.js`

**Interfaces:**
- Consumes: `sendNotification(db, mailer, { to, typ, jobId, variablen })` (Task 3).

- [ ] **Step 1: Convert `freigabe2.js`'s 4 call sites**

**6a. interessenskonflikt-admin:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an Portal-Admin eskaliert',
              text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
                link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
              },
            });
```

**6b. interessenskonflikt-stellvertreter2:**
```js
            await sendNotification(db, mailer, {
              to: stellvertreter2.email,
              subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an dich übergeben',
              text: `Eine Rechnung wurde dir zur Freigabe 2 übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: stellvertreter2.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${stellvertreter2.vorname} ${stellvertreter2.nachname}`,
                jobDateiname: job.dateiname,
                grund: `Eine Rechnung wurde dir zur Freigabe 2 übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
                link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
              },
            });
```

**6c. ablehnung-admin-eskaliert:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
              text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
```

**6d. ablehnung-normal:**
```js
            await sendNotification(db, mailer, {
              to: besitzer.email,
              subject: 'Freigabeportal: Rechnung abgelehnt',
              text: `Deine Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: besitzer.email,
              typ: 'ablehnung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${besitzer.vorname} ${besitzer.nachname}`,
                jobDateiname: job.dateiname,
                grund: 'Deine Rechnung wurde abgelehnt:',
                begruendung,
                link: `${config.publicBaseUrl}/abgelehnt/${job.id}`,
              },
            });
```

- [ ] **Step 2: Convert `spesenFreigabe1.js`'s 4 call sites**

**6e. ablehnung:**
```js
          await sendNotification(db, mailer, {
            to: einreicher.email,
            subject: 'Freigabeportal: Spesen-Position abgelehnt',
            text: `Deine Spesen-Position wurde abgelehnt: ${job.dateiname}\n\nBegründung: ${begruendung}`,
            typ: 'ablehnung',
            jobId: job.id,
          });
```
→
```js
          await sendNotification(db, mailer, {
            to: einreicher.email,
            typ: 'ablehnung',
            jobId: job.id,
            variablen: {
              empfaengerName: `${einreicher.vorname} ${einreicher.nachname}`,
              jobDateiname: job.dateiname,
              grund: 'Deine Spesen-Position wurde abgelehnt:',
              begruendung,
              link: `${config.publicBaseUrl}/meine-spesen`,
            },
          });
```

**6f. interessenskonflikt-admin:**
```js
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – an Portal-Admin eskaliert',
              text: `Eine Spesen-Position wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: 'Portal-Admin-Team',
                jobDateiname: job.dateiname,
                grund: 'Eine Spesen-Position wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat.',
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
            });
```

**6g. interessenskonflikt-stellvertreter1:**
```js
            await sendNotification(db, mailer, {
              to: stellvertreter1.email,
              subject: 'Freigabeportal: Interessenskonflikt bei Spesen-Freigabe 1 – Prüfung an dich übergeben',
              text: `Eine Spesen-Position wurde dir zur Prüfung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: stellvertreter1.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${stellvertreter1.vorname} ${stellvertreter1.nachname}`,
                jobDateiname: job.dateiname,
                grund: `Eine Spesen-Position wurde dir zur Prüfung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat.`,
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
            });
```

**6h. freigabe2-wartend:**
```js
        await sendNotification(db, mailer, {
          to: freigeber2.email,
          subject: 'Freigabeportal: Neue Spesen-Position zur Freigabe 2',
          text: `Eine Spesen-Position wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/freigabe2/${job.id}`,
          typ: 'zuweisung',
          jobId: job.id,
        });
```
→
```js
        await sendNotification(db, mailer, {
          to: freigeber2.email,
          typ: 'zuweisung',
          jobId: job.id,
          variablen: {
            empfaengerName: `${freigeber2.vorname} ${freigeber2.nachname}`,
            jobDateiname: job.dateiname,
            grund: 'Eine Spesen-Position wartet auf deine Freigabe 2.',
            link: `${config.publicBaseUrl}/freigabe2/${job.id}`,
          },
        });
```

- [ ] **Step 3: Run both test files, fix any subject/text assertions to match the new templates, re-run**

Run: `node --test test/integration/freigabe2.test.js test/integration/spesenFreigabe1.test.js`
Expected: initial FAIL on any literal subject/text assertion; after updating those assertions to the new unified betreff (`'Freigabeportal: Neue Rechnung zur Bearbeitung'` / `'Freigabeportal: Rechnung abgelehnt'`) and checking body content against the preserved `grund`/`begruendung` wording, PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/freigabe2.js src/routes/spesenFreigabe1.js test/integration/freigabe2.test.js test/integration/spesenFreigabe1.test.js
git commit -m "refactor(mail): convert freigabe2.js and spesenFreigabe1.js sendNotification call sites to the templated variablen API"
```

---

### Task 7: Convert `spesen.js`, `poolPage.js`, `n8n/jobs.js` call sites

**Files:**
- Modify: `src/routes/spesen.js` (1 call site)
- Modify: `src/routes/poolPage.js` (1 call site)
- Modify: `src/routes/n8n/jobs.js` (1 call site)
- Modify: `test/integration/spesen.test.js`
- Modify: `test/integration/poolPage.test.js`
- Modify: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `sendNotification(db, mailer, { to, typ, jobId, variablen })` (Task 3).

- [ ] **Step 1: Convert `src/routes/spesen.js`'s call site**

```js
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
```
→
```js
            await sendNotification(db, mailer, {
              to: zustaendig.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${zustaendig.vorname} ${zustaendig.nachname}`,
                jobDateiname: job.dateiname,
                grund: istEskaliert
                  ? `Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1). Grund für die Zuweisung an dich: ${job.freigabe1_eskalationsgrund}`
                  : 'Eine Spesen-Position wartet auf deine Prüfung (Freigabe 1).',
                link: `${config.publicBaseUrl}/spesen-freigabe1/${job.id}`,
              },
            });
```

- [ ] **Step 2: Convert `src/routes/poolPage.js`'s call site**

```js
      await sendNotification(db, mailer, {
        to: zielPerson.email,
        subject: 'Freigabeportal: Neue Rechnung zur Kontierung zugewiesen',
        text: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
        typ: 'zuweisung',
        jobId: job.id,
      });
```
→
```js
      await sendNotification(db, mailer, {
        to: zielPerson.email,
        typ: 'zuweisung',
        jobId: job.id,
        variablen: {
          empfaengerName: `${zielPerson.vorname} ${zielPerson.nachname}`,
          jobDateiname: job.dateiname,
          grund: `Eine Rechnung wurde dir von ${req.currentPerson.vorname} ${req.currentPerson.nachname} zur Kontierung zugewiesen.`,
          link: `${config.publicBaseUrl}/kontierung/${job.id}`,
        },
      });
```

- [ ] **Step 3: Convert `src/routes/n8n/jobs.js`'s call site**

```js
            await sendNotification(db, mailer, {
              to: freigeber1.email,
              subject: 'Freigabeportal: Neue Rechnung zur Kontierung',
              text: `Eine neue Rechnung wurde dir automatisch zugewiesen: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/kontierung/${job.id}`,
              typ: 'zuweisung',
              jobId: job.id,
            });
```
→
```js
            await sendNotification(db, mailer, {
              to: freigeber1.email,
              typ: 'zuweisung',
              jobId: job.id,
              variablen: {
                empfaengerName: `${freigeber1.vorname} ${freigeber1.nachname}`,
                jobDateiname: job.dateiname,
                grund: 'Eine neue Rechnung wurde dir automatisch zugewiesen.',
                link: `${config.publicBaseUrl}/kontierung/${job.id}`,
              },
            });
```

- [ ] **Step 4: Run all three test files, fix any subject/text assertions, re-run**

Run: `node --test test/integration/spesen.test.js test/integration/poolPage.test.js test/integration/n8n/jobs.test.js`
Expected: initial FAIL on literal subject/text assertions, PASS after updating them to match the new unified betreff/rendered `grund` text.

- [ ] **Step 5: Commit**

```bash
git add src/routes/spesen.js src/routes/poolPage.js src/routes/n8n/jobs.js test/integration/spesen.test.js test/integration/poolPage.test.js test/integration/n8n/jobs.test.js
git commit -m "refactor(mail): convert spesen.js, poolPage.js, n8n/jobs.js sendNotification call sites to the templated variablen API"
```

---

### Task 8: Convert `cronJobs.js` call sites

**Files:**
- Modify: `src/services/cronJobs.js` (3 call sites: `benachrichtigeSyncFehler`, reminder, eskalation)
- Modify: `test/unit/cronJobs.test.js` (only if it turns out to assert mail content — verify first)

**Interfaces:**
- Consumes: `sendNotification(db, mailer, { to, typ, jobId, variablen })` (Task 3).

- [ ] **Step 1: Convert `benachrichtigeSyncFehler`**

```js
async function benachrichtigeSyncFehler(db, config, mailer, meldung) {
  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sync_fehler_empfaenger'));
  for (const email of empfaenger) {
    await sendNotification(db, mailer, {
      to: email,
      subject: 'Freigabeportal: ChurchTools-Sync fehlgeschlagen',
      text: `Der ChurchTools-Personen-Sync konnte nicht erfolgreich abgeschlossen werden: ${meldung}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/admin/sync`,
      typ: 'sync-fehler',
      jobId: null,
    });
  }
}
```
→
```js
async function benachrichtigeSyncFehler(db, config, mailer, meldung) {
  const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sync_fehler_empfaenger'));
  for (const email of empfaenger) {
    await sendNotification(db, mailer, {
      to: email,
      typ: 'sync-fehler',
      jobId: null,
      variablen: {
        fehlerDetails: meldung,
        zeitpunkt: new Date().toISOString(),
        link: `${config.publicBaseUrl}/admin/sync`,
      },
    });
  }
}
```

- [ ] **Step 2: Convert the reminder send in `runPoolErinnerungenJob`**

```js
        await sendNotification(db, mailer, {
          to: email,
          subject: 'Freigabeportal: Rechnung wartet im Pool',
          text: `Diese Rechnung ist seit mehr als ${reminderStunden} Stunden unbeansprucht im Pool: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
          typ: 'reminder',
          jobId: job.id,
        });
```
→
```js
        await sendNotification(db, mailer, {
          to: email,
          typ: 'reminder',
          jobId: job.id,
          variablen: {
            jobDateiname: job.dateiname,
            stunden: reminderStunden,
            link: `${config.publicBaseUrl}/pool`,
          },
        });
```

- [ ] **Step 3: Convert the eskalation send in `runPoolErinnerungenJob`**

```js
        await sendNotification(db, mailer, {
          to: email,
          subject: 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht',
          text: `Diese Rechnung ist seit mehr als ${eskalationStunden} Stunden unbeansprucht im Pool und wurde eskaliert: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
          typ: 'eskalation',
          jobId: job.id,
        });
```
→
```js
        await sendNotification(db, mailer, {
          to: email,
          typ: 'eskalation',
          jobId: job.id,
          variablen: {
            jobDateiname: job.dateiname,
            stunden: eskalationStunden,
            link: `${config.publicBaseUrl}/pool`,
          },
        });
```

- [ ] **Step 4: Check whether `test/unit/cronJobs.test.js` asserts mail subject/text content**

Run: `grep -n "subject\|text:\|assert.*mail" test/unit/cronJobs.test.js`

If this returns no matches inside the reminder/eskalation/sync-fehler test bodies (it did not, when this plan was written), no test changes are needed here. If it does, update the assertion to match the new default template output the same way as Tasks 5-7.

- [ ] **Step 5: Run the tests**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/cronJobs.js
git commit -m "refactor(mail): convert cronJobs.js sendNotification call sites to the templated variablen API"
```

---

### Task 9: Run and fix the remaining full-suite regressions

**Files:**
- Modify: `test/integration/mailversandEndToEnd.test.js` (only if needed — verify first)
- Modify: any other test file `npm test` reveals as still red

**Interfaces:**
- Consumes: everything from Tasks 1-8.

This task exists because Tasks 5-8 fixed the test files known in advance to assert mail content; `npm test`'s full run may surface others (e.g. a test that checks `mail_log` row counts across a multi-step flow, which should NOT need changes since `typ`/count logic is unchanged — only content-string assertions are at risk).

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: a list of any remaining failures, all content-assertion failures (wrong subject/text expected), not behavioral failures (wrong counts, wrong status, wrong recipients — those would indicate a real bug introduced in Tasks 3-8, not a stale assertion).

- [ ] **Step 2: Fix each remaining failure**

For each failure: if it's a content-string assertion (comparing `.betreff`/`.text` against old hardcoded wording), update the expected string to match the new default template output (unified betreff per typ, `grund`/`begruendung` wording preserved verbatim inside the body). If it's a count/status/recipient assertion failing, STOP and investigate — that indicates a real regression in one of Tasks 3-8's conversions, not a stale test.

- [ ] **Step 3: Re-run until the full suite is green**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "test(mail): fix remaining content assertions after the templated variablen API conversion"
```

(Skip this commit if Step 1 came back green already — nothing to commit.)

---

### Task 10: `runMailDigestJob` + scheduler registration

**Files:**
- Modify: `src/services/cronJobs.js` (add `runMailDigestJob`)
- Modify: `src/services/scheduler.js` (register it)
- Test: `test/unit/cronJobs.test.js`
- Test: `test/unit/scheduler.test.js` (only if this file exists and tests job registration the same way as the other 6 — verify first; if it doesn't test individual job wiring this way, skip and note it in the commit)

**Interfaces:**
- Consumes: `listMailLog`-adjacent grouping query (new, see Step 3), `getVorlage`/`renderTemplate` (Task 2), `sendRenderedMail` (Task 3), `startCronLauf`/`finishCronLauf`/`hasRecentRunningCronLauf` from `src/db/cronLogRepo.js` (existing), `getConfigValue` (existing).
- Produces: `runMailDigestJob(db, config, mailer)` — `async (db, config, mailer) => { status, versendet, empfaenger, fehlgeschlagen }`, following the exact result-object convention of the other 6 job functions.

- [ ] **Step 1: Add a grouping query to `src/db/mailLogRepo.js`**

Add this function:
```js
export function listGeplantMailsGruppiertNachEmpfaenger(db) {
  const rows = db.prepare("SELECT * FROM mail_log WHERE status = 'geplant' ORDER BY versucht_am").all();
  const gruppen = new Map();
  for (const row of rows) {
    if (!gruppen.has(row.empfaenger)) gruppen.set(row.empfaenger, []);
    gruppen.get(row.empfaenger).push(row);
  }
  return gruppen;
}
```

- [ ] **Step 2: Write the failing test for `listGeplantMailsGruppiertNachEmpfaenger`**

Add to `test/unit/mailLogRepo.test.js`:
```js
test('listGeplantMailsGruppiertNachEmpfaenger groups geplant rows by empfaenger and ignores other statuses', () => {
  const db = openDatabase(':memory:');
  logMailAttempt(db, { typ: 'zuweisung', jobId: null, empfaenger: 'a@example.org', betreff: 'B1', text: 'T1', status: 'geplant' });
  logMailAttempt(db, { typ: 'ablehnung', jobId: null, empfaenger: 'a@example.org', betreff: 'B2', text: 'T2', status: 'geplant' });
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'b@example.org', betreff: 'B3', text: 'T3', status: 'geplant' });
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'c@example.org', betreff: 'B4', text: 'T4', status: 'versendet' });

  const gruppen = listGeplantMailsGruppiertNachEmpfaenger(db);
  assert.equal(gruppen.size, 2);
  assert.equal(gruppen.get('a@example.org').length, 2);
  assert.equal(gruppen.get('b@example.org').length, 1);
  assert.ok(!gruppen.has('c@example.org'), 'versendet rows are excluded');
  db.close();
});
```
(Add `listGeplantMailsGruppiertNachEmpfaenger` to the existing import line at the top of `test/unit/mailLogRepo.test.js`.)

- [ ] **Step 3: Run to verify it fails, then implement, then verify it passes**

Run: `node --test test/unit/mailLogRepo.test.js` → FAIL (function doesn't exist) → apply Step 1's code → PASS.

- [ ] **Step 4: Write the failing tests for `runMailDigestJob`**

Add to `test/unit/cronJobs.test.js` (adjust the import line at the top to include `runMailDigestJob` alongside the other job imports, and `setConfigValue`/`seedDefaults` from adminConfigRepo, and `logMailAttempt`/`listMailLog` from mailLogRepo, and a stub mailer matching the style already used elsewhere in this file):

```js
test('runMailDigestJob sends one digest mail per recipient, grouping their geplant rows', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = createStubMailer();
  logMailAttempt(db, { typ: 'zuweisung', jobId: null, empfaenger: 'a@example.org', betreff: 'Freigabeportal: Neue Rechnung zur Bearbeitung', text: 'Hallo Erika,...', status: 'geplant' });
  logMailAttempt(db, { typ: 'ablehnung', jobId: null, empfaenger: 'a@example.org', betreff: 'Freigabeportal: Rechnung abgelehnt', text: 'Hallo Erika,...', status: 'geplant' });
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'b@example.org', betreff: 'Freigabeportal: Rechnung wartet im Pool', text: '...', status: 'geplant' });

  const config = { publicBaseUrl: 'http://portal.example.org' };
  const result = await runMailDigestJob(db, config, mailer);

  assert.equal(result.status, 'erfolg');
  assert.equal(mailer.sent.length, 2, 'one digest mail per distinct recipient');
  const anA = mailer.sent.find((m) => m.to === 'a@example.org');
  assert.match(anA.subject, /2 Ereignisse/);
  assert.match(anA.text, /Freigabeportal: Neue Rechnung zur Bearbeitung/);
  assert.match(anA.text, /Freigabeportal: Rechnung abgelehnt/);

  const rows = listMailLog(db);
  assert.ok(rows.every((r) => r.status === 'versendet'), 'all queued rows flip to versendet on success');
  db.close();
});

test('runMailDigestJob marks every row in a failed group as fehlgeschlagen, without affecting other recipients', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const failingMailer = {
    sent: [],
    async sendMail(mail) {
      if (mail.to === 'fail@example.org') throw new Error('SMTP down');
      this.sent.push(mail);
    },
  };
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'fail@example.org', betreff: 'B', text: 'T', status: 'geplant' });
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'ok@example.org', betreff: 'B', text: 'T', status: 'geplant' });

  const config = { publicBaseUrl: 'http://portal.example.org' };
  await runMailDigestJob(db, config, failingMailer);

  const rows = listMailLog(db);
  assert.equal(rows.find((r) => r.empfaenger === 'fail@example.org').status, 'fehlgeschlagen');
  assert.equal(rows.find((r) => r.empfaenger === 'ok@example.org').status, 'versendet');
  db.close();
});

test('runMailDigestJob is a no-op returning erfolg when no rows are geplant', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const mailer = createStubMailer();
  const result = await runMailDigestJob(db, { publicBaseUrl: 'http://portal.example.org' }, mailer);
  assert.equal(result.status, 'erfolg');
  assert.equal(result.empfaenger, 0);
  assert.equal(mailer.sent.length, 0);
  db.close();
});
```

Check `test/unit/cronJobs.test.js`'s existing `createStubMailer` helper (or equivalent) — if the file doesn't already define one, add it matching `test/unit/notify.test.js`'s shape:
```js
function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}
```

- [ ] **Step 5: Run to verify they fail**

Run: `node --test test/unit/cronJobs.test.js`
Expected: FAIL — `runMailDigestJob` doesn't exist yet.

- [ ] **Step 6: Implement `runMailDigestJob` in `src/services/cronJobs.js`**

Add this import at the top (alongside the existing ones — the existing `import { sendNotification, resolveEmpfaenger } from './notify.js';` line does NOT need to change, `runMailDigestJob` calls `mailer.sendMail` directly and updates existing `mail_log` rows in place, it never calls `sendNotification`/`sendRenderedMail`):
```js
import { listGeplantMailsGruppiertNachEmpfaenger } from '../db/mailLogRepo.js';
import { getVorlage, renderTemplate } from './mailTemplates.js';
```

Add the function (after `runSplitGruppenNachholenJob`, same file):

```js
// Sammelt alle wegen aktivem Batching (admin_config['mail_batching_aktiv']) nur protokollierten,
// aber noch nicht versendeten mail_log-Zeilen (status = 'geplant') pro Empfänger und verschickt
// dafür eine einzige Digest-Mail. Läuft mit Überlappungsschutz wie datenbank-sicherung/
// zeitstempel-nachholen, da pro Empfänger ein echter SMTP-Roundtrip stattfindet.
export async function runMailDigestJob(db, config, mailer) {
  if (hasRecentRunningCronLauf(db, 'mail-digest')) {
    return { status: 'uebersprungen', versendet: 0, empfaenger: 0, meldung: 'Ein Mail-Digest-Lauf ist bereits aktiv' };
  }

  const laufId = startCronLauf(db, 'mail-digest');
  try {
    const gruppen = listGeplantMailsGruppiertNachEmpfaenger(db);
    const portalName = getConfigValue(db, 'seiten_titel') || 'Freigabeportal';
    let versendet = 0;
    let fehlgeschlagen = 0;

    for (const [empfaenger, zeilen] of gruppen) {
      const vorlage = getVorlage(db, 'digest');
      const variablen = {
        empfaengerName: empfaenger,
        anzahl: zeilen.length,
        eintraege: zeilen.map((z) => `- ${z.betreff}`).join('\n'),
        link: `${config.publicBaseUrl}/pool`,
        portalName,
      };
      const subject = renderTemplate(vorlage.betreff, variablen);
      const text = renderTemplate(vorlage.text, variablen);

      try {
        await mailer.sendMail({ to: empfaenger, subject, text });
        for (const zeile of zeilen) {
          db.prepare("UPDATE mail_log SET status = 'versendet', versucht_am = ? WHERE id = ?").run(new Date().toISOString(), zeile.id);
        }
        versendet += 1;
      } catch (err) {
        for (const zeile of zeilen) {
          db.prepare("UPDATE mail_log SET status = 'fehlgeschlagen', fehler_details = ?, versucht_am = ? WHERE id = ?").run(err.message, new Date().toISOString(), zeile.id);
        }
        fehlgeschlagen += 1;
      }
    }

    const ergebnis = { status: 'erfolg', versendet, fehlgeschlagen, empfaenger: gruppen.size };
    finishCronLauf(db, laufId, {
      beendetAm: new Date().toISOString(),
      status: 'erfolg',
      details: `Digest-Mails versendet: ${versendet}, fehlgeschlagen: ${fehlgeschlagen}, Empfänger insgesamt: ${gruppen.size}`,
    });
    return ergebnis;
  } catch (err) {
    finishCronLauf(db, laufId, { beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
```

`empfaengerName` in the digest is the recipient's email address itself, not a real name — `mail_log.empfaenger` only ever stores an email, no name is recoverable from it at digest time. This is an accepted simplification (documented as a ledger ruling, not a spec amendment — the spec's digest example used a placeholder name but never guaranteed a resolvable one).

- [ ] **Step 7: Run to verify they pass**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS

- [ ] **Step 8: Register the job in `src/services/scheduler.js`**

Add to the imports:
```js
import { runSyncPersonenJob, runPoolErinnerungenJob, runPdfBereinigungJob, runZeitstempelNachholenJob, runDatenbankSicherungJob, runSplitGruppenNachholenJob, runMailDigestJob } from './cronJobs.js';
```

Add `runMailDigestJob` to the `startScheduler` destructured parameter (both the inner destructure and its default object):
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
    runMailDigestJob: mailDigestJob,
  } = {
    runSyncPersonenJob,
    runPoolErinnerungenJob,
    runPdfBereinigungJob,
    runZeitstempelNachholenJob,
    runDatenbankSicherungJob,
    runSplitGruppenNachholenJob,
    runMailDigestJob,
  },
}) {
```

Add a new `scheduleDaily` block at the end of `startScheduler`, after the `datenbank-sicherung` block:
```js
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'mail_batching_stunde'), 7),
    () => zahlOderStandard(getConfigValue(db, 'mail_batching_minute'), 0),
    async () => {
      const result = await mailDigestJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter mail-digest-Lauf fehlgeschlagen:', result.error);
    }
  );
```

- [ ] **Step 9: Check for a scheduler registration test**

Run: `test -f test/unit/scheduler.test.js && grep -n "runDatenbankSicherungJob\|scheduleDaily" test/unit/scheduler.test.js`

If this file exists and has a test asserting each job gets registered/invoked (following the same style used for `runDatenbankSicherungJob`), add an equivalent test for `runMailDigestJob` using the same pattern (injected fake job via the `jobs` parameter, fake timers or a directly-invoked tick, asserting the fake was called). If no such per-job registration test exists for the other jobs either, skip this step — don't introduce a new testing pattern the file doesn't already have.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/services/cronJobs.js src/services/scheduler.js src/db/mailLogRepo.js test/unit/cronJobs.test.js test/unit/mailLogRepo.test.js
git commit -m "feat(mail): add runMailDigestJob (groups geplant rows by recipient, sends one digest each) and register it in the scheduler"
```

---

### Task 11: `/admin/mail-einstellungen` page

**Files:**
- Create: `src/routes/admin/mailEinstellungen.js`
- Create: `views/admin/mail-einstellungen-form.ejs`
- Modify: `src/app.js` (mount)
- Modify: `src/middleware/nav.js` (nav flag)
- Modify: `views/admin/_nav.ejs` (nav link)
- Test: `test/integration/admin/mailEinstellungen.test.js`

**Interfaces:**
- Consumes: `getConfigValue`/`setConfigValue` (`src/db/adminConfigRepo.js`), `listRecentCronLog` (`src/db/cronLogRepo.js`), `runMailDigestJob` (Task 10), `requireRole` (`src/middleware/roles.js`).

- [ ] **Step 1: Write the failing route tests**

Create `test/integration/admin/mailEinstellungen.test.js`, modeled directly on `test/integration/admin/eskalation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { createMailEinstellungenRouter } from '../../../src/routes/admin/mailEinstellungen.js';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' }, publicBaseUrl: 'http://portal.example.org' };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  const mailer = { sent: [], async sendMail(mail) { this.sent.push(mail); } };
  app.use('/admin/mail-einstellungen', requireRole(config, 'superadmin'), createMailEinstellungenRouter({ db, config, mailer }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const MAIL_EINSTELLUNGEN_ROUTES = [
  { method: 'get', path: '/admin/mail-einstellungen' },
  { method: 'post', path: '/admin/mail-einstellungen' },
];

const VALID_BODY = {
  zuweisungBetreff: 'B1', zuweisungText: 'T1',
  reminderBetreff: 'B2', reminderText: 'T2',
  eskalationBetreff: 'B3', eskalationText: 'T3',
  ablehnungBetreff: 'B4', ablehnungText: 'T4',
  syncFehlerBetreff: 'B5', syncFehlerText: 'T5',
  ibanWarnungBetreff: 'B6', ibanWarnungText: 'T6',
  rechnungsnummerWarnungBetreff: 'B7', rechnungsnummerWarnungText: 'T7',
  digestBetreff: 'B8', digestText: 'T8',
  batchingAktiv: '1',
  batchingStunde: '6',
  batchingMinute: '30',
};

test('every mail-einstellungen route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  db.close();
});

test('every mail-einstellungen route returns 403 for a logged-in non-superadmin (Manager)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of MAIL_EINSTELLUNGEN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '55').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-superadmin`);
  }
  db.close();
});

test('GET /admin/mail-einstellungen shows the current templates and batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/mail-einstellungen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Freigabeportal: Neue Rechnung zur Bearbeitung/);
  assert.match(res.text, /name="batchingAktiv"/);
});

test('POST /admin/mail-einstellungen saves all 8 templates and the batching config', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(VALID_BODY);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_vorlage_zuweisung_betreff'), 'B1');
  assert.equal(getConfigValue(db, 'mail_vorlage_digest_text'), 'T8');
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '1');
  assert.equal(getConfigValue(db, 'mail_batching_stunde'), '6');
  assert.equal(getConfigValue(db, 'mail_batching_minute'), '30');
  db.close();
});

test('POST /admin/mail-einstellungen with batchingAktiv absent (checkbox unchecked) turns batching off', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const body = { ...VALID_BODY };
  delete body.batchingAktiv;
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send(body);
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'mail_batching_aktiv'), '0');
  db.close();
});

test('POST /admin/mail-einstellungen rejects a non-integer batchingStunde', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen').set('x-test-person-id', '99').type('form').send({ ...VALID_BODY, batchingStunde: 'abc' });
  assert.equal(res.status, 400);
  db.close();
});

test('POST /admin/mail-einstellungen/jetzt-ausfuehren triggers runMailDigestJob and redirects back', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).post('/admin/mail-einstellungen/jetzt-ausfuehren').set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/mail-einstellungen?getriggert=1');
  db.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/integration/admin/mailEinstellungen.test.js`
Expected: FAIL — the module and view don't exist yet.

- [ ] **Step 3: Create `src/routes/admin/mailEinstellungen.js`**

```js
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentCronLog } from '../../db/cronLogRepo.js';
import { runMailDigestJob } from '../../services/cronJobs.js';

const LOG_LIMIT = 10;

const VORLAGEN_FELDER = [
  ['zuweisungBetreff', 'mail_vorlage_zuweisung_betreff'],
  ['zuweisungText', 'mail_vorlage_zuweisung_text'],
  ['reminderBetreff', 'mail_vorlage_reminder_betreff'],
  ['reminderText', 'mail_vorlage_reminder_text'],
  ['eskalationBetreff', 'mail_vorlage_eskalation_betreff'],
  ['eskalationText', 'mail_vorlage_eskalation_text'],
  ['ablehnungBetreff', 'mail_vorlage_ablehnung_betreff'],
  ['ablehnungText', 'mail_vorlage_ablehnung_text'],
  ['syncFehlerBetreff', 'mail_vorlage_sync_fehler_betreff'],
  ['syncFehlerText', 'mail_vorlage_sync_fehler_text'],
  ['ibanWarnungBetreff', 'mail_vorlage_iban_warnung_betreff'],
  ['ibanWarnungText', 'mail_vorlage_iban_warnung_text'],
  ['rechnungsnummerWarnungBetreff', 'mail_vorlage_rechnungsnummer_warnung_betreff'],
  ['rechnungsnummerWarnungText', 'mail_vorlage_rechnungsnummer_warnung_text'],
  ['digestBetreff', 'mail_vorlage_digest_betreff'],
  ['digestText', 'mail_vorlage_digest_text'],
];

export function createMailEinstellungenRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function ladeState(getriggert) {
    const felder = {};
    for (const [feldName, configKey] of VORLAGEN_FELDER) {
      felder[feldName] = getConfigValue(db, configKey);
    }
    return {
      ...felder,
      batchingAktiv: getConfigValue(db, 'mail_batching_aktiv') === '1',
      batchingStunde: getConfigValue(db, 'mail_batching_stunde'),
      batchingMinute: getConfigValue(db, 'mail_batching_minute'),
      digestLog: listRecentCronLog(db, 'mail-digest', LOG_LIMIT),
      getriggert,
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/mail-einstellungen-form', {
      ...ladeState(req.query.getriggert || null),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', csrfProtection, (req, res) => {
    const errors = [];
    const felder = {};
    for (const [feldName] of VORLAGEN_FELDER) {
      const wert = (req.body[feldName] || '').trim();
      if (!wert) {
        errors.push(`${feldName} darf nicht leer sein.`);
      }
      felder[feldName] = wert;
    }

    const batchingAktiv = req.body.batchingAktiv === '1';
    const batchingStundeNum = Number(req.body.batchingStunde);
    const batchingMinuteNum = Number(req.body.batchingMinute);
    if (!Number.isInteger(batchingStundeNum) || batchingStundeNum < 0 || batchingStundeNum > 23) {
      errors.push('Uhrzeit (Stunde) muss eine Ganzzahl zwischen 0 und 23 sein.');
    }
    if (!Number.isInteger(batchingMinuteNum) || batchingMinuteNum < 0 || batchingMinuteNum > 59) {
      errors.push('Uhrzeit (Minute) muss eine Ganzzahl zwischen 0 und 59 sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/mail-einstellungen-form', {
        ...felder,
        batchingAktiv,
        batchingStunde: req.body.batchingStunde,
        batchingMinute: req.body.batchingMinute,
        digestLog: listRecentCronLog(db, 'mail-digest', LOG_LIMIT),
        getriggert: null,
        errors,
        gespeichert: false,
      });
    }

    for (const [feldName, configKey] of VORLAGEN_FELDER) {
      setConfigValue(db, configKey, felder[feldName]);
    }
    setConfigValue(db, 'mail_batching_aktiv', batchingAktiv ? '1' : '0');
    setConfigValue(db, 'mail_batching_stunde', String(batchingStundeNum));
    setConfigValue(db, 'mail_batching_minute', String(batchingMinuteNum));
    res.redirect('/admin/mail-einstellungen?gespeichert=1');
  });

  router.post('/jetzt-ausfuehren', csrfProtection, async (req, res, next) => {
    try {
      await runMailDigestJob(db, config, mailer);
      res.redirect('/admin/mail-einstellungen?getriggert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Create `views/admin/mail-einstellungen-form.ejs`**

Modeled on `views/admin/eskalation-form.ejs`, extended with 8 template pairs, the batching controls, and a run-history table (modeled on `views/admin/geplante-jobs.ejs`'s per-job history block):

```ejs
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Mail-Einstellungen — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Mail-Einstellungen</h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <form method="post" action="/admin/mail-einstellungen" class="col-12 col-lg-8">
      <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">

      <h2 class="h5 mt-3">Batching</h2>
      <div class="form-check mb-2">
        <input type="checkbox" class="form-check-input" id="batchingAktiv" name="batchingAktiv" value="1" <%= batchingAktiv ? 'checked' : '' %>>
        <label class="form-check-label" for="batchingAktiv">Mails gesammelt statt sofort versenden (eine tägliche Zusammenfassung pro Empfänger)</label>
      </div>
      <div class="row g-2 mb-4">
        <div class="col-6 col-md-3">
          <label class="form-label" for="batchingStunde">Versandzeit — Stunde</label>
          <input type="number" min="0" max="23" class="form-control" id="batchingStunde" name="batchingStunde" value="<%= batchingStunde %>" required>
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label" for="batchingMinute">Versandzeit — Minute</label>
          <input type="number" min="0" max="59" class="form-control" id="batchingMinute" name="batchingMinute" value="<%= batchingMinute %>" required>
        </div>
      </div>
      <p class="text-muted small">Sync-Fehler und IBAN-Abweichung ignorieren diesen Schalter und werden immer sofort verschickt.</p>

      <h2 class="h5 mt-4">Vorlagen</h2>
      <p class="text-muted small">Platzhalter: <code>%variable%</code>. Verfügbar je nach Vorlage u.a. <code>%empfaengerName%</code>, <code>%jobDateiname%</code>, <code>%grund%</code>, <code>%begruendung%</code>, <code>%link%</code>, <code>%portalName%</code>, <code>%stunden%</code>, <code>%fehlerDetails%</code>, <code>%zeitpunkt%</code>, <code>%debitorName%</code>, <code>%tatsaechlicheIban%</code>, <code>%rechnungsnummer%</code>, <code>%dupJobIds%</code>, <code>%anzahl%</code>, <code>%eintraege%</code> — siehe Doku für die genaue Liste pro Vorlage.</p>

      <div class="mb-3">
        <label class="form-label" for="zuweisungBetreff">Zuweisung — Betreff</label>
        <input type="text" class="form-control" id="zuweisungBetreff" name="zuweisungBetreff" value="<%= zuweisungBetreff %>" required>
        <label class="form-label mt-2" for="zuweisungText">Zuweisung — Text</label>
        <textarea class="form-control" id="zuweisungText" name="zuweisungText" rows="4" required><%= zuweisungText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="reminderBetreff">Reminder — Betreff</label>
        <input type="text" class="form-control" id="reminderBetreff" name="reminderBetreff" value="<%= reminderBetreff %>" required>
        <label class="form-label mt-2" for="reminderText">Reminder — Text</label>
        <textarea class="form-control" id="reminderText" name="reminderText" rows="4" required><%= reminderText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="eskalationBetreff">Eskalation — Betreff</label>
        <input type="text" class="form-control" id="eskalationBetreff" name="eskalationBetreff" value="<%= eskalationBetreff %>" required>
        <label class="form-label mt-2" for="eskalationText">Eskalation — Text</label>
        <textarea class="form-control" id="eskalationText" name="eskalationText" rows="4" required><%= eskalationText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="ablehnungBetreff">Ablehnung — Betreff</label>
        <input type="text" class="form-control" id="ablehnungBetreff" name="ablehnungBetreff" value="<%= ablehnungBetreff %>" required>
        <label class="form-label mt-2" for="ablehnungText">Ablehnung — Text</label>
        <textarea class="form-control" id="ablehnungText" name="ablehnungText" rows="4" required><%= ablehnungText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="syncFehlerBetreff">Sync-Fehler — Betreff</label>
        <input type="text" class="form-control" id="syncFehlerBetreff" name="syncFehlerBetreff" value="<%= syncFehlerBetreff %>" required>
        <label class="form-label mt-2" for="syncFehlerText">Sync-Fehler — Text</label>
        <textarea class="form-control" id="syncFehlerText" name="syncFehlerText" rows="4" required><%= syncFehlerText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="ibanWarnungBetreff">IBAN-Warnung — Betreff</label>
        <input type="text" class="form-control" id="ibanWarnungBetreff" name="ibanWarnungBetreff" value="<%= ibanWarnungBetreff %>" required>
        <label class="form-label mt-2" for="ibanWarnungText">IBAN-Warnung — Text</label>
        <textarea class="form-control" id="ibanWarnungText" name="ibanWarnungText" rows="4" required><%= ibanWarnungText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="rechnungsnummerWarnungBetreff">Rechnungsnummer-Warnung — Betreff</label>
        <input type="text" class="form-control" id="rechnungsnummerWarnungBetreff" name="rechnungsnummerWarnungBetreff" value="<%= rechnungsnummerWarnungBetreff %>" required>
        <label class="form-label mt-2" for="rechnungsnummerWarnungText">Rechnungsnummer-Warnung — Text</label>
        <textarea class="form-control" id="rechnungsnummerWarnungText" name="rechnungsnummerWarnungText" rows="4" required><%= rechnungsnummerWarnungText %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="digestBetreff">Digest (tägliche Zusammenfassung) — Betreff</label>
        <input type="text" class="form-control" id="digestBetreff" name="digestBetreff" value="<%= digestBetreff %>" required>
        <label class="form-label mt-2" for="digestText">Digest — Text</label>
        <textarea class="form-control" id="digestText" name="digestText" rows="4" required><%= digestText %></textarea>
      </div>

      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 ps-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>

    <h2 class="h4 mt-4">Mail-Digest — Verlauf</h2>
    <form method="post" action="/admin/mail-einstellungen/jetzt-ausfuehren" class="mb-2">
      <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
      <button type="submit" class="btn btn-outline-secondary btn-sm">Jetzt ausführen</button>
    </form>
    <% if (getriggert === '1' && digestLog.length > 0) { %>
      <% const letzterLauf = digestLog[0]; %>
      <div class="alert <%= letzterLauf.status === 'erfolg' ? 'alert-success' : 'alert-danger' %>">
        <%= letzterLauf.status === 'erfolg' ? 'Erfolgreich ausgeführt. ' + letzterLauf.details : 'Fehlgeschlagen: ' + letzterLauf.details %>
      </div>
    <% } %>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Gestartet</th><th>Beendet</th><th>Status</th><th>Details</th></tr></thead>
        <tbody>
          <% digestLog.forEach((eintrag) => { %>
            <tr>
              <td><%= eintrag.gestartet_am %></td>
              <td><%= eintrag.beendet_am %></td>
              <td><%= eintrag.status %></td>
              <td><%= eintrag.details || '' %></td>
            </tr>
          <% }) %>
          <% if (digestLog.length === 0) { %><tr><td colspan="4">Noch keine Läufe.</td></tr><% } %>
        </tbody>
      </table>
    </div>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

- [ ] **Step 5: Mount the router in `src/app.js`**

Add the import alongside the other admin router imports:
```js
import { createMailEinstellungenRouter } from './routes/admin/mailEinstellungen.js';
```

Add the mount alongside the other `requireRole(config, 'superadmin')` mounts (after the `/admin/module` line):
```js
  app.use('/admin/mail-einstellungen', requireRole(config, 'superadmin'), createMailEinstellungenRouter({ db, config, mailer, csrfProtection }));
```

- [ ] **Step 6: Add the nav flag in `src/middleware/nav.js`**

Find the block setting `res.locals.adminNav.eskalation = res.locals.isSuperadmin;` (or equivalent) and add a sibling line:
```js
  res.locals.adminNav.mailEinstellungen = res.locals.isSuperadmin;
```

- [ ] **Step 7: Add the nav link in `views/admin/_nav.ejs`**

Find the `<% if (adminNav.eskalation) { %>` block and add a sibling block right after it (matching its exact markup pattern):
```ejs
    <% if (adminNav.mailEinstellungen) { %>
      <li class="nav-item"><a class="nav-link" href="/admin/mail-einstellungen">Mail-Einstellungen</a></li>
    <% } %>
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/integration/admin/mailEinstellungen.test.js`
Expected: PASS

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/routes/admin/mailEinstellungen.js views/admin/mail-einstellungen-form.ejs src/app.js src/middleware/nav.js views/admin/_nav.ejs test/integration/admin/mailEinstellungen.test.js
git commit -m "feat(mail): add /admin/mail-einstellungen (superadmin) for editing mail templates and the batching schedule"
```

---

### Task 12: CSRF sweep + docs

**Files:**
- Modify: `test/integration/csrfSweep.test.js`
- Modify: `docs/geplante-jobs-und-benachrichtigungen.md`
- Modify: `docs/admin-bereich.md`

**Interfaces:**
- Consumes: the finished `/admin/mail-einstellungen` routes (Task 11).

- [ ] **Step 1: Add the two new routes to the CSRF sweep**

In `test/integration/csrfSweep.test.js`, add to `SESSION_POST_ROUTES` (anywhere in the list — order doesn't matter, but grouping near `/admin/module` keeps related routes together):
```js
  '/admin/mail-einstellungen',
  '/admin/mail-einstellungen/jetzt-ausfuehren',
```

Update the sanity-check count:
```js
  assert.equal(SESSION_POST_ROUTES.length, 45, 'sanity check: this sweep should cover exactly 45 routes');
```

The sweep test logs in with a superadmin+buchhaltung person (group `'20'` + `'10'`) already, so no login changes are needed — `requireRole(config, 'superadmin')` is already cleared by that identity.

- [ ] **Step 2: Run the sweep**

Run: `node --test test/integration/csrfSweep.test.js`
Expected: PASS

- [ ] **Step 3: Update `docs/geplante-jobs-und-benachrichtigungen.md`**

Change the heading `## Die sechs Jobs` to `## Die sieben Jobs`.

Add a row to the jobs table:
```markdown
| `mail-digest` | täglich 07:00 (Europe/Zürich) | fasst alle wegen aktivem Batching nur protokollierten (`mail_log.status = 'geplant'`) Mails pro Empfänger zu einer täglichen Zusammenfassung zusammen |
```

Add a new subsection after `### `datenbank-sicherung`` (before `### `sync-personen``):
```markdown
### `mail-digest`

Nur relevant, wenn **Admin → Mail-Einstellungen** den Batching-Schalter
aktiviert hat — dann protokolliert `sendNotification` (siehe unten) statt
sofort zu versenden nur eine Zeile mit `status = 'geplant'`. Dieser Job
gruppiert alle wartenden Zeilen nach Empfänger und verschickt pro
Empfänger eine gesammelte Digest-Mail; erfolgreiche/gescheiterte Zeilen
werden anschliessend auf `versendet`/`fehlgeschlagen` gesetzt (gleiche
Semantik wie ein Einzelversand). `sync-fehler` und `iban-warnung` werden
nie eingereiht, sondern ignorieren den Batching-Schalter und laufen immer
sofort — siehe unten. Läuft mit demselben Überlappungsschutz wie
`zeitstempel-nachholen`. Zeitplan, Vorlagen-Bearbeitung und manuelles
"Jetzt ausführen" leben — wie bei `datenbank-sicherung` — nicht unter
**Admin → Geplante Jobs**, sondern auf der eigenen Seite **Admin →
Mail-Einstellungen**.
```

Replace the "Benachrichtigungen (E-Mail)" section's opening paragraph and table:
```markdown
## Benachrichtigungen (E-Mail)

Jeder Mailversand läuft über `sendNotification` (`src/services/notify.js`)
und wird protokolliert (`mail_log`, `versendet`/`fehlgeschlagen`, oder bei
aktivem Batching zunächst `geplant` — niemals stumm verworfen).
`resolveEmpfaenger` löst die Tokens `gruppe:buchhaltung`/`gruppe:admin` zur
Versandzeit gegen die **aktuelle** Gruppenmitgliedschaft auf (keine feste
Liste, die veraltet). Betreff und Text jedes Typs kommen aus einer unter
**Admin → Mail-Einstellungen** editierbaren Vorlage mit `%variable%`-
Platzhaltern (`src/services/mailTemplates.js`), nicht mehr aus fest
codierten Strings.

| Typ | Auslöser |
|---|---|
| `zuweisung` | automatische Zuweisung beim Eingang, Übergabe an Freigeber 2, Interessenskonflikt-Übergabe, Hinweis-Konto |
| `reminder` | Pool-Rechnung länger als `reminder_stunden` unbeansprucht |
| `eskalation` | Pool-Rechnung länger als `eskalation_stunden` unbeansprucht |
| `ablehnung` | Rechnung bei Kontierung oder Freigabe 2 abgelehnt |
| `sync-fehler` | ChurchTools-Sync fehlgeschlagen oder abgebrochen — **immer sofort**, unabhängig vom Batching-Schalter |
| `iban-warnung` | QR-Code-IBAN weicht von der hinterlegten Lieferanten-IBAN ab — **immer sofort**, unabhängig vom Batching-Schalter |
| `rechnungsnummer-warnung` | Rechnungsnummer bei Kontierung bereits für denselben Debitor erfasst |

**Batching:** Ist unter **Admin → Mail-Einstellungen** aktiviert, werden
alle Typen ausser `sync-fehler`/`iban-warnung` nicht sofort verschickt,
sondern als `status = 'geplant'` protokolliert und vom `mail-digest`-Job
(siehe oben) einmal täglich pro Empfänger zu einer Sammel-Mail
zusammengefasst.

Der Mailer ist optional: fehlt eine vollständige SMTP-Konfiguration, fällt
das Portal automatisch auf einen No-Op-Mailer zurück, der jeden
Versandversuch als Fehlschlag protokolliert, statt den ganzen Prozess
abstürzen zu lassen (`createMailerOrFallback`).
```

- [ ] **Step 4: Update `docs/admin-bereich.md`**

Add a row to the Rechte-Matrix table (after the `Module` row):
```markdown
| Mail-Einstellungen | `/admin/mail-einstellungen` | **nur** `superadmin` |
```

Add a new section after `## Module`:
```markdown
## Mail-Einstellungen (`/admin/mail-einstellungen`)

Editierbare Betreff-/Text-Vorlagen (`%variable%`-Platzhalter) für alle 7
Mail-Typen plus die Digest-Vorlage, sowie der globale Batching-Schalter
(sofort vs. täglich gesammelt) mit Versandzeit und manuellem "Jetzt
ausführen" für den `mail-digest`-Job. **Nur `superadmin`**, wie
Eskalationszeiten/Erscheinungsbild/Zeitstempel/Backup. Details:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#benachrichtigungen-e-mail)
und
[2026-09-07-mail-vorlagen-und-batching-design.md](superpowers/specs/2026-09-07-mail-vorlagen-und-batching-design.md).
```

- [ ] **Step 5: Run the full suite one more time**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/integration/csrfSweep.test.js docs/geplante-jobs-und-benachrichtigungen.md docs/admin-bereich.md
git commit -m "docs(mail): document mail-digest job, templated mail texts, and /admin/mail-einstellungen; extend CSRF sweep to 45 routes"
```
