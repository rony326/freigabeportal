# Sub-Phase D4 – Mailversand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the previously dead-code `src/services/mailer.js` so the app actually sends German notification emails for every silent hand-off point in the approval workflow, plus admin-configurable reminder/escalation emails for stale pool jobs — all logged to a retry-capable queue, none of it ever blocking the core approval transactions.

**Architecture:** One new service module (`src/services/notify.js`) is the sole caller of the mailer; every route that needs to notify someone calls it as a fire-and-log post-commit side effect. A new `mail_log` table is both the audit trail and the admin-retriggerable retry queue. A new cron endpoint sweeps stale pool jobs for reminder/escalation mail, gated by two new idempotency columns on `jobs`.

**Tech Stack:** Same as Phases A–D3 — Node.js/Express, `node:sqlite` (`DatabaseSync`), EJS views, `nodemailer` (already a dependency, via the existing `mailer.js`), `supertest`/real in-memory SQLite/no mocking of this project's own logic.

**Spec:** `docs/superpowers/specs/2026-08-15-phase-d4-mailversand-design.md`

## Global Constraints

- `node:sqlite`'s `DatabaseSync` only — never better-sqlite3.
- Real HTTP via supertest, real in-memory SQLite, no mocking of this project's own business logic. The external boundary here is SMTP itself: every router that sends mail receives `mailer` as an explicit dependency-injected parameter (same pattern as `db`/`config`), so tests pass a stub `{ sendMail: async (mail) => {...} }` instead of the real nodemailer-backed one.
- `sendNotification` (this plan's central service function) **never throws** — every call site fires it as a post-commit side effect and does not need its own try/catch around the call itself. It is always awaited so tests can deterministically assert on `mail_log` state right after the request completes.
- All user-facing text and email content in German, matching each file's existing copy style.
- Existing routers whose signature gains a new `mailer` parameter must tolerate `mailer` being `undefined` (old test files that construct these routers directly, without passing `mailer`, must keep passing unmodified — `sendNotification(db, undefined, {...})` degrades gracefully to a logged `fehlgeschlagen` row rather than crashing, so no test file outside this plan's own new/modified tests needs to change).
- Any Express route handler that becomes `async` (to `await sendNotification`) and did not already have Express-4 async-crash protection **must** be wrapped in try/catch → `next(err)`, matching the established pattern in `src/routes/freigabe2.js` (fixed during D2's final review). Converting a handler to `async` without this wrapper is a regression, not a simplification.
- Schema changes are made in place inside `CREATE TABLE IF NOT EXISTS` (no live database exists yet — matches the accepted precedent from D1–D3).
- Mail is a post-commit side effect: every `sendNotification` call happens **after** its associated `db.exec('COMMIT')`, never inside the transaction and never gating whether the transaction commits.

---

### Task 1: Datenmodell — `mail_log`, Job-Idempotenz-Spalten, Empfänger-Konfiguration

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/jobsRepo.js`
- Modify: `src/db/personenRepo.js`
- Create: `src/db/mailLogRepo.js`
- Modify: `src/db/adminConfigRepo.js`
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Test: `test/unit/jobsRepo.test.js`
- Test: `test/unit/personenRepo.test.js`
- Test: `test/unit/mailLogRepo.test.js` (new)
- Test: `test/unit/adminConfigRepo.test.js`
- Test: `test/unit/env.test.js`

**Interfaces:**
- Consumes: nothing new — reuses `openDatabase`, `upsertPerson`, `createJob`, `claimJob`, `releaseJob` (all pre-existing).
- Produces (for later tasks):
  - `listPoolJobsForReminder(db, stunden)` → `Array<job row>`
  - `markReminderGesendet(db, jobId)` → `void`
  - `listPoolJobsForEskalation(db, stunden)` → `Array<job row>`
  - `markEskalationGesendet(db, jobId)` → `void`
  - `listActivePersonsInGroup(db, groupId)` → `Array<{ churchtools_person_id, vorname, nachname, email, gruppen: string[], ... }>`
  - `logMailAttempt(db, { typ, jobId, empfaenger, betreff, text, status, fehlerDetails })` → `number` (new row id)
  - `listMailLog(db)` → `Array<mail_log row>` (newest first)
  - `getMailLogById(db, id)` → `mail_log row | null`
  - `config.publicBaseUrl` (from `loadConfig`)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/jobsRepo.test.js` (add `listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet` to the existing destructured import from `'../../src/db/jobsRepo.js'`):

```javascript
test('listPoolJobsForReminder returns only unzugewiesen jobs older than the threshold with no reminder sent yet', () => {
  const db = openDatabase(':memory:');
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const freshJobId = createJob(db, { eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: 'neu.pdf', pdfPfad: '/tmp/b.pdf' });

  const results = listPoolJobsForReminder(db, 24);
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(oldJobId));
  assert.ok(!ids.includes(freshJobId));
  db.close();
});

test('listPoolJobsForReminder excludes a job whose reminder was already sent', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  assert.equal(listPoolJobsForReminder(db, 24).length, 0);
  db.close();
});

test('listPoolJobsForReminder excludes a claimed (non-pool) job even if old', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  assert.equal(listPoolJobsForReminder(db, 24).length, 0);
  db.close();
});

test('listPoolJobsForEskalation returns only unzugewiesen jobs older than the threshold with no escalation sent yet', () => {
  const db = openDatabase(':memory:');
  const oldJobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const results = listPoolJobsForEskalation(db, 48);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, oldJobId);
  db.close();
});

test('markReminderGesendet and markEskalationGesendet each gate only their own list', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  assert.equal(listPoolJobsForReminder(db, 24).length, 0, 'reminder list excludes it once marked');
  assert.equal(listPoolJobsForEskalation(db, 48).length, 1, 'escalation list is independent, still includes it');
  db.close();
});

test('releaseJob clears reminder_gesendet_at and eskalation_gesendet_at so a fresh pool cycle starts clean', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  markReminderGesendet(db, jobId);
  markEskalationGesendet(db, jobId);
  claimJob(db, jobId, '1');

  releaseJob(db, jobId, '1');
  const job = getJobById(db, jobId);
  assert.equal(job.reminder_gesendet_at, null);
  assert.equal(job.eskalation_gesendet_at, null);
  db.close();
});
```

Append to `test/unit/personenRepo.test.js` (check its existing imports first and add `listActivePersonsInGroup`):

```javascript
test('listActivePersonsInGroup returns only active persons who belong to the given group', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'In', nachname: 'Gruppe', email: 'in@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Nicht', nachname: 'Gruppe', email: 'nicht@example.org', gruppen: ['20'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Auch', nachname: 'Gruppe', email: 'auch@example.org', gruppen: ['10', '20'], loggedInNow: false });
  deactivatePerson(db, '3');

  const result = listActivePersonsInGroup(db, '10');
  assert.equal(result.length, 1);
  assert.equal(result[0].email, 'in@example.org');
  db.close();
});
```

Create `test/unit/mailLogRepo.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { logMailAttempt, listMailLog, getMailLogById } from '../../src/db/mailLogRepo.js';

test('logMailAttempt inserts a versendet row with all fields, getMailLogById returns it', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const id = logMailAttempt(db, { typ: 'zuweisung', jobId, empfaenger: 'x@example.org', betreff: 'Betreff', text: 'Text', status: 'versendet' });
  assert.equal(typeof id, 'number');
  const row = getMailLogById(db, id);
  assert.equal(row.typ, 'zuweisung');
  assert.equal(row.job_id, jobId);
  assert.equal(row.empfaenger, 'x@example.org');
  assert.equal(row.betreff, 'Betreff');
  assert.equal(row.text, 'Text');
  assert.equal(row.status, 'versendet');
  assert.equal(row.fehler_details, null);
  assert.ok(row.versucht_am);
  db.close();
});

test('logMailAttempt records fehlgeschlagen with fehler_details', () => {
  const db = openDatabase(':memory:');
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP-Fehler' });
  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Fehler');
  assert.equal(rows[0].job_id, null);
  db.close();
});

test('listMailLog returns rows newest first', () => {
  const db = openDatabase(':memory:');
  const id1 = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'a@example.org', betreff: 'B1', text: 'T1', status: 'versendet' });
  const id2 = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'b@example.org', betreff: 'B2', text: 'T2', status: 'versendet' });
  const rows = listMailLog(db);
  assert.equal(rows[0].id, id2);
  assert.equal(rows[1].id, id1);
  db.close();
});

test('getMailLogById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getMailLogById(db, 999), null);
  db.close();
});
```

Append to `test/unit/adminConfigRepo.test.js`:

```javascript
test('seedDefaults sets reminder_empfaenger and eskalation_empfaenger defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'eskalation_empfaenger'), 'gruppe:buchhaltung');
  db.close();
});
```

Modify `test/unit/env.test.js`: add `PUBLIC_BASE_URL: 'https://portal.example.org'` to `FULL_ENV` (line 5-21 block), and append:

```javascript
test('loadConfig throws a German error when PUBLIC_BASE_URL is missing', () => {
  const { PUBLIC_BASE_URL, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: PUBLIC_BASE_URL/);
});

test('loadConfig exposes publicBaseUrl', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.publicBaseUrl, 'https://portal.example.org');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js test/unit/personenRepo.test.js test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js test/unit/env.test.js`
Expected: FAIL — none of the new functions/columns/config exist yet.

- [ ] **Step 3: Extend `src/db/schema.sql`**

Add two columns to the existing `jobs` table (inside the `CREATE TABLE IF NOT EXISTS jobs (...)` block, after `freigabe2_eskalationsgrund TEXT`):

```sql
  freigabe2_eskalationsgrund TEXT,
  reminder_gesendet_at TEXT,
  eskalation_gesendet_at TEXT
);
```

Add a new table after the existing `freigaben` table:

```sql

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung')),
  job_id INTEGER REFERENCES jobs(id),
  empfaenger TEXT NOT NULL,
  betreff TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('versendet', 'fehlgeschlagen')),
  fehler_details TEXT,
  versucht_am TEXT NOT NULL
);
```

- [ ] **Step 4: Add the four new functions to `src/db/jobsRepo.js`**

Insert after `listAbgelehntJobsForPerson` (before `listZugewiesenJobsForPerson`):

```javascript
export function listPoolJobsForReminder(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND reminder_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

export function markReminderGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET reminder_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}

export function listPoolJobsForEskalation(db, stunden) {
  const schwelle = new Date(Date.now() - stunden * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'unzugewiesen' AND eskalation_gesendet_at IS NULL AND eingang_am < ? ORDER BY eingang_am"
    )
    .all(schwelle);
}

export function markEskalationGesendet(db, jobId) {
  db.prepare('UPDATE jobs SET eskalation_gesendet_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}
```

Modify `releaseJob` to also clear the two new columns — replace it in full:

```javascript
export function releaseJob(db, jobId, personId) {
  // Also clears freigabe1_eskaliert_von/-grund: a stellvertreter1 who was escalated to can
  // release the job too (loadAuthorizedJob only checks current zugewiesen_an), and a fresh
  // claimer must not inherit a stale escalation record from a previous claim cycle. Also
  // clears reminder_gesendet_at/eskalation_gesendet_at so a fresh pool cycle after release
  // is eligible for its own reminder/escalation mail rather than being silently skipped
  // because the *previous* cycle already sent one.
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND zugewiesen_an = ? AND status = 'zugewiesen'`
    )
    .run(jobId, personId);
  return result.changes > 0;
}
```

- [ ] **Step 5: Add `listActivePersonsInGroup` to `src/db/personenRepo.js`**

Insert after `listActivePersons`:

```javascript
export function listActivePersonsInGroup(db, groupId) {
  return db
    .prepare('SELECT * FROM personen WHERE aktiv = 1')
    .all()
    .map((row) => ({ ...row, gruppen: JSON.parse(row.gruppen) }))
    .filter((person) => person.gruppen.includes(String(groupId)));
}
```

- [ ] **Step 6: Create `src/db/mailLogRepo.js`**

```javascript
export function logMailAttempt(db, { typ, jobId, empfaenger, betreff, text, status, fehlerDetails }) {
  const result = db
    .prepare(
      `INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, fehler_details, versucht_am)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(typ, jobId ?? null, empfaenger, betreff, text, status, fehlerDetails ?? null, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function listMailLog(db) {
  return db.prepare('SELECT * FROM mail_log ORDER BY id DESC').all();
}

export function getMailLogById(db, id) {
  return db.prepare('SELECT * FROM mail_log WHERE id = ?').get(id) ?? null;
}
```

- [ ] **Step 7: Extend `src/db/adminConfigRepo.js`'s `DEFAULTS`**

```javascript
const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  reminder_empfaenger: 'gruppe:buchhaltung',
  eskalation_empfaenger: 'gruppe:buchhaltung',
  branding_farbe_primaer: '#2f4858',
  branding_farbe_sekundaer: '#4d7ea8',
  branding_theme_default: 'system',
  visum_seite_position: 'letzte',
};
```

- [ ] **Step 8: Add `PUBLIC_BASE_URL` to `src/config/env.js`**

Add this line inside the returned object, right after `downloadSigningSecret: required(env, 'DOWNLOAD_SIGNING_SECRET'),`:

```javascript
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
```

- [ ] **Step 9: Document the new env var in `.env.example`**

Add after the `DOWNLOAD_SIGNING_SECRET=...` line:

```
# Oeffentliche Basis-URL des Portals (fuer Links in Benachrichtigungs-Mails)
PUBLIC_BASE_URL=https://portal.musterkirche.ch
```

Also update the existing SMTP comment block to mention the reminder/escalation cron, replacing:

```
# Portal-eigener SMTP-Versand (getrennt von n8n/Bexio-Mailpfad)
# Optional bis SMTP-Zugang final ist: die App startet auch ohne diese Werte,
# der Mailer verweigert lediglich den Betrieb bis sie gesetzt sind.
```

with:

```
# Portal-eigener SMTP-Versand (getrennt von n8n/Bexio-Mailpfad): Zuweisungs-/
# Reminder-/Eskalations-/Ablehnungs-Mails. Optional bis SMTP-Zugang final ist:
# die App startet auch ohne diese Werte, faellt aber auf einen Mailer zurueck,
# der jeden Sendeversuch fehlschlagen laesst (sichtbar in /admin/mails).
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js test/unit/personenRepo.test.js test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js test/unit/env.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 11: Run the full suite to confirm no regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: FAIL only in files that construct config objects by hand for `loadConfig` — check carefully: this should be limited to none, since every other test file builds its config object directly rather than calling `loadConfig()`. If anything else fails, investigate before proceeding — do not assume it's unrelated.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.sql src/db/jobsRepo.js src/db/personenRepo.js src/db/mailLogRepo.js src/db/adminConfigRepo.js src/config/env.js .env.example test/unit/jobsRepo.test.js test/unit/personenRepo.test.js test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js test/unit/env.test.js
git commit -m "feat: add mail_log table, job reminder/eskalation idempotency columns, recipient-list defaults"
```

---

### Task 2: `notify.js` — zentrale Sende-/Empfänger-Auflösungs-Logik

**Files:**
- Create: `src/services/notify.js`
- Test: `test/unit/notify.test.js`

**Interfaces:**
- Consumes: `logMailAttempt` (Task 1), `listActivePersonsInGroup` (Task 1).
- Produces (for Tasks 3–8): `sendNotification(db, mailer, { to, subject, text, typ, jobId })` → `Promise<void>` (never rejects); `resolveEmpfaenger(db, config, konfigWert)` → `Array<string>` (deduplicated email addresses).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/notify.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger } from '../../src/services/notify.js';

function createStubMailer({ shouldFail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      sent.push(mail);
      if (shouldFail) throw new Error('SMTP-Testfehler');
    },
  };
}

test('sendNotification logs a versendet row on success and calls the mailer with the right fields', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer();
  await sendNotification(db, mailer, { to: 'x@example.org', subject: 'Betreff', text: 'Text', typ: 'zuweisung', jobId: 5 });

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');
  assert.equal(mailer.sent[0].subject, 'Betreff');
  assert.equal(mailer.sent[0].text, 'Text');

  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'versendet');
  assert.equal(rows[0].typ, 'zuweisung');
  assert.equal(rows[0].job_id, 5);
  db.close();
});

test('sendNotification logs a fehlgeschlagen row on failure and never throws', async () => {
  const db = openDatabase(':memory:');
  const mailer = createStubMailer({ shouldFail: true });
  await assert.doesNotReject(() =>
    sendNotification(db, mailer, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  assert.equal(rows[0].fehler_details, 'SMTP-Testfehler');
  db.close();
});

test('sendNotification degrades gracefully when mailer is undefined, for routers that have not been updated to pass one', async () => {
  const db = openDatabase(':memory:');
  await assert.doesNotReject(() =>
    sendNotification(db, undefined, { to: 'x@example.org', subject: 'B', text: 'T', typ: 'reminder', jobId: null })
  );
  const rows = listMailLog(db);
  assert.equal(rows[0].status, 'fehlgeschlagen');
  db.close();
});

test('resolveEmpfaenger returns an empty array for a null/empty config value', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  assert.deepEqual(resolveEmpfaenger(db, config, null), []);
  assert.deepEqual(resolveEmpfaenger(db, config, ''), []);
  db.close();
});

test('resolveEmpfaenger expands gruppe:buchhaltung to every active group member and keeps literal addresses', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'C', nachname: 'D', email: 'c@example.org', gruppen: ['20'], loggedInNow: false });

  const result = resolveEmpfaenger(db, config, 'gruppe:buchhaltung\nmanuell@example.org');
  assert.equal(result.length, 2);
  assert.ok(result.includes('a@example.org'));
  assert.ok(result.includes('manuell@example.org'));
  assert.ok(!result.includes('c@example.org'));
  db.close();
});

test('resolveEmpfaenger deduplicates when a manual address matches a resolved group member', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });

  const result = resolveEmpfaenger(db, config, 'gruppe:buchhaltung\na@example.org');
  assert.equal(result.length, 1);
  db.close();
});

test('resolveEmpfaenger ignores blank lines', () => {
  const db = openDatabase(':memory:');
  const config = { churchtools: { groupIdBuchhaltung: '10' } };
  const result = resolveEmpfaenger(db, config, '\n\nx@example.org\n\n');
  assert.deepEqual(result, ['x@example.org']);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/notify.test.js`
Expected: FAIL — `src/services/notify.js` doesn't exist yet.

- [ ] **Step 3: Create `src/services/notify.js`**

```javascript
import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup } from '../db/personenRepo.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';

export async function sendNotification(db, mailer, { to, subject, text, typ, jobId }) {
  try {
    await mailer.sendMail({ to, subject, text });
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'versendet' });
  } catch (err) {
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'fehlgeschlagen', fehlerDetails: err.message });
  }
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
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}
```

Note: `mailer` being `undefined` is handled naturally — `undefined.sendMail(...)` throws a `TypeError` synchronously inside the `try` block, which the `catch` block catches exactly like any other send failure (its `err.message` will be something like `"Cannot read properties of undefined (reading 'sendMail')"`, which is an acceptable, non-crashing failure mode for the not-yet-updated test files this protects).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/notify.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions (this task adds a new, self-contained service with no callers yet).

- [ ] **Step 6: Commit**

```bash
git add src/services/notify.js test/unit/notify.test.js
git commit -m "feat: add notify.js (sendNotification, resolveEmpfaenger)"
```

---

### Task 3: Zuweisungs-Mail bei Job-Erstellung (n8n) + Mailer-Verdrahtung in `app.js`

**Files:**
- Modify: `src/routes/n8n/jobs.js`
- Modify: `src/app.js`
- Test: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `sendNotification` (Task 2), `getPersonById` (pre-existing, `src/db/personenRepo.js`).
- Produces: nothing new consumed by later tasks — this task's own significance is establishing the `mailer` instance in `app.js`, which Tasks 4–8 each thread into one more router mount.

This task is also where the app-wide `mailer` instance gets created, since this is the first router that needs it. `createMailer(config.smtp)` throws synchronously if SMTP isn't fully configured (including when `config.smtp` itself is `undefined`, which is the case in several existing test files like `test/integration/app.test.js` and `test/integration/cron.test.js` that never set an `smtp` field) — `app.js` wraps this in try/catch so the app always boots, falling back to a mailer whose `sendMail` always throws, making every `sendNotification` call log a `fehlgeschlagen` row rather than crashing anything.

- [ ] **Step 1: Write the failing test**

Add `getJobById` is already imported in `test/integration/n8n/jobs.test.js`; add `getPersonById` import from `'../../../src/db/personenRepo.js'`, `createKonto` from `'../../../src/db/kontenRepo.js'`, `createZuweisungsregel` from `'../../../src/db/zuweisungsregelnRepo.js'`, and `listMailLog` from `'../../../src/db/mailLogRepo.js'`. Update `buildTestApp` to accept and pass through a `mailer`:

```javascript
function buildTestApp(db, config, mailer) {
  const app = express();
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  return app;
}

function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}
```

(This changes the existing `buildTestApp(db, config)` signature to take a third parameter — update the file's existing call sites, e.g. `buildTestApp(db, testConfig(jobsDir))`, to `buildTestApp(db, testConfig(jobsDir), createStubMailer())`, so every existing test in this file keeps passing unchanged in behavior, just with an explicit stub instead of `undefined`.)

Append this test:

```javascript
test('POST /api/n8n/jobs with a matching Zuweisungsregel sends a Zuweisungs-Mail to freigeber1', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { upsertPerson } = await import('../../../src/db/personenRepo.js');
  const { createKonto } = await import('../../../src/db/kontenRepo.js');
  const { createZuweisungsregel } = await import('../../../src/db/zuweisungsregelnRepo.js');
  const { listMailLog } = await import('../../../src/db/mailLogRepo.js');

  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-mail-test-'));
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });

  const config = { ...testConfig(jobsDir), publicBaseUrl: 'https://portal.example.org' };
  const mailer = createStubMailer();
  const app = buildTestApp(db, config, mailer);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org');
  assert.match(mailer.sent[0].text, /rechnung\.pdf/);
  assert.match(mailer.sent[0].text, /https:\/\/portal\.example\.org\/pool/);

  const rows = listMailLog(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].typ, 'zuweisung');
  assert.equal(rows[0].status, 'versendet');
  db.close();
});

test('POST /api/n8n/jobs with no matching Zuweisungsregel sends no mail (job lands in the pool, no specific owner yet)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listMailLog } = await import('../../../src/db/mailLogRepo.js');

  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-mail-test-'));
  const config = { ...testConfig(jobsDir), publicBaseUrl: 'https://portal.example.org' };
  const mailer = createStubMailer();
  const app = buildTestApp(db, config, mailer);

  const res = await request(app)
    .post('/api/n8n/jobs')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(mailer.sent.length, 0);
  assert.equal(listMailLog(db).length, 0);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — the trigger doesn't exist yet, and `buildTestApp`'s new signature isn't matched by production code.

- [ ] **Step 3: Implement the trigger in `src/routes/n8n/jobs.js`**

Add imports at the top:

```javascript
import { getPersonById } from '../../db/personenRepo.js';
import { sendNotification } from '../../services/notify.js';
```

Change the function signature and wrap the multer callback in an async function with a try/catch → `next(err)` (Express 4 does not forward async rejections from a non-Express-managed callback):

```javascript
export function createN8nJobsRouter({ db, config, mailer }) {
  const router = Router();

  router.post('/', (req, res, next) => {
    upload.single('pdf')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die PDF-Datei darf höchstens 20 MB gross sein.' : 'Fehler beim Datei-Upload.';
          return res.status(400).json({ error: message });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'PDF-Datei (Feld "pdf") fehlt.' });
        }
        if (!isPdf(req.file.buffer)) {
          return res.status(400).json({ error: 'Datei ist keine gültige PDF-Datei.' });
        }

        const { quelle, absender, dateiname } = req.body;
        if (!VALID_QUELLEN.has(quelle)) {
          return res.status(400).json({ error: 'quelle muss "scanner" oder "lieferant" sein.' });
        }
        if (!dateiname) {
          return res.status(400).json({ error: 'dateiname ist ein Pflichtfeld.' });
        }

        const eingangAm = req.body.eingang_am || new Date().toISOString();

        mkdirSync(config.jobsDir, { recursive: true });
        const pdfPfad = join(config.jobsDir, `job-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
        writeFileSync(pdfPfad, req.file.buffer);

        const id = createJob(db, { eingangAm, quelle, absender: absender || null, dateiname, pdfPfad });
        const visumSeitePosition = getConfigValue(db, 'visum_seite_position') || 'letzte';
        try {
          const thumbnailPng = renderFirstPageThumbnail(req.file.buffer, visumSeitePosition);
          const thumbnailPfad = pdfPfad.replace(/\.pdf$/, '.png');
          writeFileSync(thumbnailPfad, thumbnailPng);
          setThumbnailPfad(db, id, thumbnailPfad);
        } catch (err) {
          console.error(`Thumbnail-Rendering fehlgeschlagen für Job ${id}:`, err.message);
        }
        const job = getJobById(db, id);

        if (job.status === 'zugewiesen') {
          const freigeber1 = getPersonById(db, job.zugewiesen_an);
          if (freigeber1) {
            await sendNotification(db, mailer, {
              to: freigeber1.email,
              subject: 'Freigabeportal: Neue Rechnung zur Kontierung',
              text: `Eine neue Rechnung wurde dir automatisch zugewiesen: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        }

        res.status(201).json({ id: job.id, status: job.status });
      } catch (err) {
        next(err);
      }
    });
  });

  router.get('/abholbereit', (req, res) => {
    const jobs = listAbholbereitJobs(db);
    const payload = jobs.map((job) => ({
      id: job.id,
      eingang_am: job.eingang_am,
      quelle: job.quelle,
      absender: job.absender,
      dateiname: job.dateiname,
      konto_id: job.konto_id,
      download_url: buildSignedDownloadUrl(config, job.id, ABHOLEN_TTL_SECONDS),
    }));
    res.json(payload);
  });

  router.post('/:id/abholung-bestaetigen', (req, res) => {
    const job = confirmAbholung(db, Number(req.params.id));
    if (!job) {
      return res.status(409).json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt.' });
    }
    if (job.pdf_pfad && existsSync(job.pdf_pfad)) {
      unlinkSync(job.pdf_pfad);
    }
    if (job.thumbnail_pfad && existsSync(job.thumbnail_pfad)) {
      unlinkSync(job.thumbnail_pfad);
    }
    res.json({ id: job.id, status: job.status });
  });

  return router;
}
```

(Only the `POST /` handler and the function signature changed — `GET /abholbereit` and `POST /:id/abholung-bestaetigen` are unchanged, reproduced above only for completeness of the full-file replacement.)

- [ ] **Step 4: Wire the mailer into `src/app.js`**

Add the import near the top, after the other service-adjacent imports:

```javascript
import { createMailer } from './services/mailer.js';
```

Inside `createApp`, right after `app.use(loadCurrentPerson(db));` and before the `/branding` mount, add:

```javascript
  let mailer;
  try {
    mailer = createMailer(config.smtp);
  } catch (err) {
    console.error('Mailer konnte nicht initialisiert werden, E-Mail-Versand ist deaktiviert:', err.message);
    mailer = {
      async sendMail() {
        throw new Error('SMTP ist nicht konfiguriert.');
      },
    };
  }
```

Change the n8n mount line from:

```javascript
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
```

to:

```javascript
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS. In particular, `test/integration/app.test.js` and `test/integration/cron.test.js` (whose `testConfig()` helpers have no `smtp` field at all) must still pass unchanged — confirming the try/catch fallback in `app.js` works for `config.smtp === undefined`, not just an incomplete object.

- [ ] **Step 7: Commit**

```bash
git add src/routes/n8n/jobs.js src/app.js test/integration/n8n/jobs.test.js
git commit -m "feat: Zuweisungs-Mail on auto-assigned job creation, wire mailer into app.js"
```

---

### Task 4: Zuweisungs-Mail bei Freigabe-1-Eskalation und -Abschluss

**Files:**
- Modify: `src/routes/kontierung.js`
- Modify: `src/app.js`
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Consumes: `sendNotification` (Task 2), `getPersonById` (pre-existing).
- Produces: nothing new consumed by later tasks.

**Important:** `kontierung.js`'s `POST /:id` handler is currently synchronous. Making it `async` (required to `await sendNotification`) without also wrapping its body in try/catch → `next(err)` would reintroduce the exact Express-4 async-crash bug that was fixed in `freigabe2.js` during D2's final review — any thrown error (e.g. from `db.exec('BEGIN')` failing) would become an unhandled promise rejection and crash the whole Node process for every user, not just this request. This task's Step 3 below wraps the entire handler body accordingly; do not skip that wrapper.

- [ ] **Step 1: Write the failing tests**

Add `getKontoById` to the existing import from `'../../src/db/kontenRepo.js'` in `test/integration/kontierung.test.js` (it becomes `import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';`), and add a mailer parameter to `buildTestApp`:

```javascript
function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function buildTestApp(db, mailer) {
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
  app.use(loadCurrentPerson(db));
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config, mailer }));
  return app;
}
```

(This changes the existing `buildTestApp(db)` signature — update every existing call site in the file from `buildTestApp(db)` to `buildTestApp(db, createStubMailer())`, so all existing tests keep passing with an explicit stub instead of an implicit `undefined`.)

Append these tests:

```javascript
test('POST /kontierung/:id with a conflict sends a Zuweisungs-Mail to stellvertreter1', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db); // freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4'
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p2@example.org');
  assert.match(mailer.sent[0].text, /rechnung\.pdf/);
  db.close();
});

test('POST /kontierung/:id without a conflict sends a Zuweisungs-Mail to freigeber2', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKontoAndPersonen(db);
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app)
    .post(`/kontierung/${id}`)
    .set('x-test-person-id', '1')
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p3@example.org');
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js`
Expected: FAIL — no trigger exists yet, and `buildTestApp`'s new signature isn't matched.

- [ ] **Step 3: Implement the triggers in `src/routes/kontierung.js`**

Add imports:

```javascript
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification } from '../services/notify.js';
```

Change the signature and the `POST /:id` handler:

```javascript
export function createKontierungRouter({ db, config, mailer }) {
  const router = Router();
```

Replace the `router.post('/:id', ...)` handler in full:

```javascript
  router.post('/:id', async (req, res, next) => {
    try {
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
      if (hatKonflikt && job.freigabe1_eskaliert_von) {
        errors.push('Diese Aufgabe wurde bereits eskaliert und kann nicht erneut eskaliert werden. Bitte lege sie zurück in den Pool oder wende dich an den Portal-Admin.');
      }
      if (hatKonflikt && konto && konto.stellvertreter1_id === req.currentPerson.churchtools_person_id) {
        errors.push('Du bist bereits die Stellvertretung für dieses Konto und kannst nicht an dich selbst eskalieren. Bitte lege den Job zurück in den Pool oder wende dich an den Portal-Admin.');
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

      if (hatKonflikt) {
        const stellvertreter1 = getPersonById(db, konto.stellvertreter1_id);
        if (stellvertreter1) {
          await sendNotification(db, mailer, {
            to: stellvertreter1.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – Kontierung an dich übergeben',
            text: `Eine Rechnung wurde dir zur Kontierung übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else {
        const freigeber2 = getPersonById(db, konto.freigeber2_id);
        if (freigeber2) {
          await sendNotification(db, mailer, {
            to: freigeber2.email,
            subject: 'Freigabeportal: Neue Rechnung zur Freigabe 2',
            text: `Eine Rechnung wartet auf deine Freigabe 2: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      }

      res.redirect('/pool');
    } catch (err) {
      next(err);
    }
  });
```

(`GET /:id` and `POST /:id/zurueck-in-pool` are unchanged.)

- [ ] **Step 4: Thread `mailer` into `src/app.js`'s Kontierung mount**

Change:

```javascript
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config }));
```

to:

```javascript
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config, mailer }));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/kontierung.js src/app.js test/integration/kontierung.test.js
git commit -m "feat: Zuweisungs-Mail on Freigabe-1 escalation and completion"
```

---

### Task 5: Zuweisungs-Mail bei Freigabe-2-Eskalation und Ablehnungs-Benachrichtigung

**Files:**
- Modify: `src/routes/freigabe2.js`
- Modify: `src/app.js`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Consumes: `sendNotification` (Task 2). `getPersonById` is already imported in `freigabe2.js`.
- Produces: nothing new consumed by later tasks.

`freigabe2.js`'s `POST /:id` handler is already `async` and already wrapped in try/catch → `next(err)` (fixed during D2's final review) — the new `await sendNotification(...)` calls added in this task go inside that existing try block, no new safety wrapper needed.

- [ ] **Step 1: Write the failing tests**

Add a mailer parameter to `buildTestApp` in `test/integration/freigabe2.test.js`:

```javascript
function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

function buildTestApp(db, { withErrorHandler = false, mailer } = {}) {
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
  app.use(loadCurrentPerson(db));
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config, mailer }));
  if (withErrorHandler) {
    app.use((err, req, res, next) => {
      res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
    });
  }
  return app;
}
```

(This changes `buildTestApp`'s second parameter from `{ withErrorHandler = false }` to `{ withErrorHandler = false, mailer }` — every existing call site that used `buildTestApp(db)` or `buildTestApp(db, { withErrorHandler: true })` keeps working unchanged, since `mailer` simply stays `undefined` for tests that don't care about it, degrading gracefully per this plan's Global Constraints. Only the new tests below pass an explicit stub.)

Append these tests:

```javascript
test('POST /freigabe2/:id with a conflict sends a Zuweisungs-Mail to stellvertreter2', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' }); // freigeber2Id: '3', stellvertreter2Id: '4'
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'ja', begruendung: 'Befangen' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p4@example.org');
  db.close();
});

test('POST /freigabe2/:id with aktion=ablehnen sends an Ablehnungs-Benachrichtigung to the job owner, including the reason', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-mail-ablehnen-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'p1@example.org'); // seedFreigabe2Job's zugewiesen_an is person '1'
  assert.match(mailer.sent[0].text, /Falsches Konto gewählt/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /freigabe2/:id with aktion=freigeben (no conflict, no rejection) sends no mail — job completion needs no human notification', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-mail-freigeben-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });

  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 0);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — no triggers exist yet, and `buildTestApp`'s options object doesn't accept `mailer` in production code (it's ignored, not passed through).

- [ ] **Step 3: Implement the triggers in `src/routes/freigabe2.js`**

Add the import:

```javascript
import { sendNotification } from '../services/notify.js';
```

Change the signature:

```javascript
export function createFreigabe2Router({ db, config, mailer }) {
```

In the `hatKonflikt` branch (inside `router.post('/:id', async (req, res, next) => { try { ... }`), replace:

```javascript
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
```

with:

```javascript
      if (hatKonflikt) {
        db.exec('BEGIN');
        try {
          eskalierenFreigabe2(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        const stellvertreter2 = getPersonById(db, konto.stellvertreter2_id);
        if (stellvertreter2) {
          await sendNotification(db, mailer, {
            to: stellvertreter2.email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an dich übergeben',
            text: `Eine Rechnung wurde dir zur Freigabe 2 übergeben, da ${req.currentPerson.vorname} ${req.currentPerson.nachname} einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
        return res.redirect('/pool');
      }
```

Replace the `aktion === 'ablehnen'` branch:

```javascript
      if (aktion === 'ablehnen') {
        if (!begruendung) {
          return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, ['Bei einer Ablehnung ist eine Begründung Pflicht.']);
        }
        db.exec('BEGIN');
        try {
          const abgelehnt = ablehnenJob(db, job.id, { abgelehntVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          if (!abgelehnt) {
            db.exec('ROLLBACK');
            return renderForm(req, res, 409, result, { interessenskonflikt, begruendung }, [
              'Diese Freigabe wurde inzwischen bereits von einem anderen Vorgang bearbeitet.',
            ]);
          }
          createFreigabe(db, {
            jobId: job.id,
            personId: req.currentPerson.churchtools_person_id,
            rolle: 'ablehnung',
            zeitpunkt: new Date().toISOString(),
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
        const besitzer = getPersonById(db, job.zugewiesen_an);
        if (besitzer) {
          await sendNotification(db, mailer, {
            to: besitzer.email,
            subject: 'Freigabeportal: Rechnung abgelehnt',
            text: `Deine Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/pool`,
            typ: 'ablehnung',
            jobId: job.id,
          });
        }
        return res.redirect('/pool');
      }
```

The plain `freigeben`-and-complete path (rest of the handler, unchanged) sends no mail, per the design ("job completion needs no human notification — the job goes to n8n pickup, not to a human").

- [ ] **Step 4: Thread `mailer` into `src/app.js`'s Freigabe-2 mount**

Change:

```javascript
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config }));
```

to:

```javascript
  app.use('/freigabe2', requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config, mailer }));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/freigabe2.js src/app.js test/integration/freigabe2.test.js
git commit -m "feat: Zuweisungs-Mail on Freigabe-2 escalation, Ablehnungs-Benachrichtigung"
```

---

### Task 6: Reminder-/Eskalations-Sweep (Cron)

**Files:**
- Modify: `src/routes/cron.js`
- Modify: `src/app.js`
- Test: `test/integration/cron.test.js`

**Interfaces:**
- Consumes: `listPoolJobsForReminder`, `markReminderGesendet`, `listPoolJobsForEskalation`, `markEskalationGesendet` (Task 1); `sendNotification`, `resolveEmpfaenger` (Task 2); `getConfigValue` (pre-existing).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/cron.test.js` (add `seedDefaults, setConfigValue` to the `adminConfigRepo.js` import if not already present — check the file's current imports first and add what's missing; add imports for `createJob`, `getJobById` from `'../../src/db/jobsRepo.js'`, `listMailLog` from `'../../src/db/mailLogRepo.js'`):

```javascript
function createStubMailer() {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); } };
}

test('POST /internal/cron/pool-erinnerungen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/pool-erinnerungen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends one reminder mail per stale pool job and marks it sent, is idempotent on a second run', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reminder, 1);
  assert.equal(getJobById(db, jobId).reminder_gesendet_at !== null, true);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);

  const res2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reminder, 0, 'the same job must not be reminded twice');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  db.close();
});

test('POST /internal/cron/pool-erinnerungen sends escalation mail independently of reminder, both can fire for the same very-stale job', async () => {
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const db = openDatabase(':memory:');
  seedDefaults(db);
  createJob(db, { eingangAm: '2020-01-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'alt.pdf', pdfPfad: '/tmp/a.pdf' });
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const config = { ...testConfig(), publicBaseUrl: 'https://portal.example.org' };
  const app = createApp({ db, config });

  const res = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 200);
  assert.equal(res.body.reminder, 1);
  assert.equal(res.body.eskalation, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'reminder').length, 1);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'eskalation').length, 1);
  db.close();
});
```

Note: `testConfig()` in this file has no `smtp`/`publicBaseUrl` fields — the app-wide `mailer` fallback from Task 3 handles the missing `smtp` gracefully (mail attempts get logged as `fehlgeschlagen` rather than crashing), and these tests only assert on `mail_log` row counts/types, not on `versendet` vs. `fehlgeschlagen` status, so they remain valid regardless of whether real SMTP is configured in the test environment. `publicBaseUrl` is added explicitly per-test via `{ ...testConfig(), publicBaseUrl: ... }` where the mail body content matters.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/cron.test.js`
Expected: FAIL — the `/pool-erinnerungen` route doesn't exist yet.

- [ ] **Step 3: Implement the sweep in `src/routes/cron.js`**

Replace the file in full:

```javascript
import { Router } from 'express';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { requireCronSecret } from '../middleware/cronAuth.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet } from '../db/jobsRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

export function createCronRouter({ db, config, mailer }) {
  const router = Router();

  router.post('/sync-personen', requireCronSecret(config), async (req, res) => {
    if (hasRecentRunningSync(db)) {
      return res.status(409).json({ error: 'Ein Sync-Lauf ist bereits aktiv' });
    }
    try {
      const result = await runPersonenSync(db, config.churchtools, config.churchtools.syncServiceToken);
      res.json({ status: 'erfolg', ...result });
    } catch (err) {
      res.status(500).json({ status: 'fehler', error: err.message });
    }
  });

  router.post('/pool-erinnerungen', requireCronSecret(config), async (req, res, next) => {
    try {
      const reminderStunden = Number(getConfigValue(db, 'reminder_stunden'));
      const eskalationStunden = Number(getConfigValue(db, 'eskalation_stunden'));

      const reminderJobs = listPoolJobsForReminder(db, reminderStunden);
      for (const job of reminderJobs) {
        const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'reminder_empfaenger'));
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Rechnung wartet im Pool',
            text: `Diese Rechnung ist seit mehr als ${reminderStunden} Stunden unbeansprucht im Pool: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'reminder',
            jobId: job.id,
          });
        }
        markReminderGesendet(db, job.id);
      }

      const eskalationJobs = listPoolJobsForEskalation(db, eskalationStunden);
      for (const job of eskalationJobs) {
        const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'eskalation_empfaenger'));
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Eskalation – Rechnung seit langem unbeansprucht',
            text: `Diese Rechnung ist seit mehr als ${eskalationStunden} Stunden unbeansprucht im Pool und wurde eskaliert: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'eskalation',
            jobId: job.id,
          });
        }
        markEskalationGesendet(db, job.id);
      }

      res.json({ status: 'erfolg', reminder: reminderJobs.length, eskalation: eskalationJobs.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Thread `mailer` into `src/app.js`'s cron mount**

Change:

```javascript
  app.use('/internal/cron', createCronRouter({ db, config }));
```

to:

```javascript
  app.use('/internal/cron', createCronRouter({ db, config, mailer }));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/cron.test.js`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/cron.js src/app.js test/integration/cron.test.js
git commit -m "feat: pool reminder/escalation cron sweep"
```

---

### Task 7: Admin-Bereich — Empfänger-Listen für Reminder/Eskalation

**Files:**
- Modify: `src/routes/admin/eskalation.js`
- Modify: `views/admin/eskalation-form.ejs`
- Modify: `test/integration/admin/eskalation.test.js`

**Interfaces:**
- Consumes: `getConfigValue`, `setConfigValue` (pre-existing).
- Produces: nothing new consumed by later tasks (`resolveEmpfaenger`, Task 2, is what actually reads these config values at send time).

This task replaces the single required `eskalationFallbackEmail` field with two multi-line, multi-target textareas. It is a breaking change to the existing form's fields, so the existing test file needs a full rewrite of its POST-body-dependent assertions, not just additions.

- [ ] **Step 1: Write the failing tests**

Replace `test/integration/admin/eskalation.test.js` in full:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createEskalationRouter } from '../../../src/routes/admin/eskalation.js';

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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/eskalation', requireRole(config, 'portal-admin'), createEskalationRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ESKALATION_ROUTES = [
  { method: 'get', path: '/admin/eskalation' },
  { method: 'post', path: '/admin/eskalation' },
];

const VALID_BODY = { reminderStunden: '1', eskalationStunden: '2', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'x@example.org' };

test('every Eskalation route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ESKALATION_ROUTES) {
    const res = await request(app)[method](path).type('form').send(VALID_BODY);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  db.close();
});

test('every Eskalation route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ESKALATION_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send(VALID_BODY);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/eskalation shows the seeded defaults pre-filled', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /value="24"/);
  assert.match(res.text, /value="48"/);
  assert.match(res.text, /gruppe:buchhaltung/);
  db.close();
});

test('POST /admin/eskalation with valid values persists them', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '12', eskalationStunden: '36', reminderEmpfaenger: 'gruppe:buchhaltung', eskalationEmpfaenger: 'kirchenpflege@musterkirche.ch\ngruppe:buchhaltung' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '36');
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'eskalation_empfaenger'), 'kirchenpflege@musterkirche.ch\ngruppe:buchhaltung');
  db.close();
});

test('POST /admin/eskalation with invalid Stunden values is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, reminderStunden: '-5' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  db.close();
});

test('POST /admin/eskalation with an empty Empfänger list is rejected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, reminderEmpfaenger: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Reminder-Empfänger/);
  db.close();
});

test('POST /admin/eskalation with an invalid Empfänger line (neither email nor gruppe:buchhaltung) is rejected', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ ...VALID_BODY, eskalationEmpfaenger: 'nicht-valide' });
  assert.equal(res.status, 400);
  assert.match(res.text, /nicht-valide/);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: FAIL — the route still uses the old single-email field.

- [ ] **Step 3: Rewrite `src/routes/admin/eskalation.js`**

```javascript
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GRUPPE_TOKEN = 'gruppe:buchhaltung';

function validateEmpfaengerListe(value, label, errors) {
  const zeilen = (value || '')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
  if (zeilen.length === 0) {
    errors.push(`${label} braucht mindestens ein Ziel.`);
    return;
  }
  for (const zeile of zeilen) {
    if (zeile !== GRUPPE_TOKEN && !EMAIL_PATTERN.test(zeile)) {
      errors.push(`${label}: "${zeile}" ist weder eine gültige E-Mail-Adresse noch "${GRUPPE_TOKEN}".`);
    }
  }
}

export function createEskalationRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      reminderEmpfaenger: getConfigValue(db, 'reminder_empfaenger'),
      eskalationEmpfaenger: getConfigValue(db, 'eskalation_empfaenger'),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger } = req.body;
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

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, errors });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    res.redirect('/admin/eskalation');
  });

  return router;
}
```

- [ ] **Step 4: Rewrite `views/admin/eskalation-form.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Eskalationszeiten — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Eskalationszeiten</h1>
  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>
  <form method="post" action="/admin/eskalation">
    <label>Reminder nach (Stunden) <input type="number" name="reminderStunden" value="<%= reminderStunden %>" required></label><br>
    <label>Eskalation nach (Stunden) <input type="number" name="eskalationStunden" value="<%= eskalationStunden %>" required></label><br>
    <label>Reminder-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:buchhaltung")<br>
      <textarea name="reminderEmpfaenger" rows="4" cols="50"><%= reminderEmpfaenger || '' %></textarea>
    </label><br>
    <label>Eskalations-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:buchhaltung")<br>
      <textarea name="eskalationEmpfaenger" rows="4" cols="50"><%= eskalationEmpfaenger || '' %></textarea>
    </label><br>
    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin/eskalation.js views/admin/eskalation-form.ejs test/integration/admin/eskalation.test.js
git commit -m "feat: admin-configurable mixed group/individual recipient lists for reminder/eskalation"
```

---

### Task 8: Admin-Bereich — Mail-Protokoll & Retry

**Files:**
- Create: `src/routes/admin/mails.js`
- Create: `views/admin/mails.ejs`
- Modify: `views/admin/_nav.ejs`
- Modify: `src/app.js`
- Modify: `test/integration/admin/authz-sweep.test.js`
- Test: `test/integration/admin/mails.test.js` (new)

**Interfaces:**
- Consumes: `listMailLog`, `getMailLogById` (Task 1), `sendNotification` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/admin/mails.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { logMailAttempt, listMailLog } from '../../../src/db/mailLogRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createMailsRouter } from '../../../src/routes/admin/mails.js';

function createStubMailer({ shouldFail = false } = {}) {
  const sent = [];
  return { sent, async sendMail(mail) { sent.push(mail); if (shouldFail) throw new Error('SMTP-Testfehler'); } };
}

function buildTestApp(db, mailer) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/mails', requireRole(config, 'portal-admin'), createMailsRouter({ db, mailer }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/mails returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get('/admin/mails');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/mails lists logged attempts with an Erneut-versenden button only for fehlgeschlagen rows', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'ok@example.org', betreff: 'Erfolg', text: 'T', status: 'versendet' });
  logMailAttempt(db, { typ: 'eskalation', jobId: null, empfaenger: 'fail@example.org', betreff: 'Fehler', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP down' });
  const app = buildTestApp(db, createStubMailer());

  const res = await request(app).get('/admin/mails').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /ok@example\.org/);
  assert.match(res.text, /fail@example\.org/);
  assert.match(res.text, /SMTP down/);
  db.close();
});

test('POST /admin/mails/:id/erneut-versenden resends and appends a new versendet row', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP down' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app).post(`/admin/mails/${id}/erneut-versenden`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');

  const rows = listMailLog(db);
  assert.equal(rows.length, 2, 'the original failed row stays, a new row is appended');
  assert.equal(rows[0].status, 'versendet', 'the newest row (retry) is versendet');
  db.close();
});

test('POST /admin/mails/:id/erneut-versenden for an unknown id returns 404', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).post('/admin/mails/999/erneut-versenden').set('x-test-person-id', '99');
  assert.equal(res.status, 404);
  db.close();
});
```

Modify `test/integration/admin/authz-sweep.test.js`: update the sanity-check count from `19` to `21` (line 68), add two rows to `ADMIN_ROUTES` (after the `pdf-einstellungen` block):

```javascript
  // mails (2)
  { method: 'get', path: '/admin/mails' },
  { method: 'post', path: '/admin/mails/1/erneut-versenden' },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/admin/mails.test.js test/integration/admin/authz-sweep.test.js`
Expected: FAIL — `src/routes/admin/mails.js` doesn't exist yet.

- [ ] **Step 3: Create `src/routes/admin/mails.js`**

```javascript
import { Router } from 'express';
import { listMailLog, getMailLogById } from '../../db/mailLogRepo.js';
import { sendNotification } from '../../services/notify.js';

export function createMailsRouter({ db, mailer }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/mails', { mails: listMailLog(db) });
  });

  router.post('/:id/erneut-versenden', async (req, res, next) => {
    try {
      const eintrag = getMailLogById(db, Number(req.params.id));
      if (!eintrag) {
        return res.status(404).render('error', { message: 'Mail-Eintrag nicht gefunden.' });
      }
      await sendNotification(db, mailer, {
        to: eintrag.empfaenger,
        subject: eintrag.betreff,
        text: eintrag.text,
        typ: eintrag.typ,
        jobId: eintrag.job_id,
      });
      res.redirect('/admin/mails');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Create `views/admin/mails.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Mail-Protokoll — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Mail-Protokoll</h1>
  <table>
    <thead><tr><th>Zeitpunkt</th><th>Empfänger</th><th>Betreff</th><th>Typ</th><th>Status</th><th>Fehler</th><th></th></tr></thead>
    <tbody>
      <% mails.forEach((mail) => { %>
        <tr>
          <td><%= mail.versucht_am %></td>
          <td><%= mail.empfaenger %></td>
          <td><%= mail.betreff %></td>
          <td><%= mail.typ %></td>
          <td><%= mail.status %></td>
          <td><%= mail.fehler_details || '' %></td>
          <td>
            <% if (mail.status === 'fehlgeschlagen') { %>
              <form method="post" action="/admin/mails/<%= mail.id %>/erneut-versenden">
                <button type="submit">Erneut versenden</button>
              </form>
            <% } %>
          </td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 5: Add the nav entry to `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
  <a href="/admin/erscheinungsbild">Erscheinungsbild</a>
  <a href="/admin/personen">Personen</a>
  <a href="/admin/pdf-einstellungen">PDF-Einstellungen</a>
  <a href="/admin/mails">Mail-Protokoll</a>
</nav>
```

- [ ] **Step 6: Mount in `src/app.js`**

Add the import after the `createPdfEinstellungenRouter` import:

```javascript
import { createMailsRouter } from './routes/admin/mails.js';
```

Add the mount line after the `/admin/pdf-einstellungen` mount:

```javascript
  app.use('/admin/mails', createMailsRouter({ db, mailer }));
```

(No `requireRole` call needed here — the blanket `app.use('/admin', requireRole(config, 'portal-admin'))` mounted earlier already gates every `/admin/*` route, matching every other admin router in this file.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/integration/admin/mails.test.js test/integration/admin/authz-sweep.test.js`
Expected: PASS, all tests.

- [ ] **Step 8: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add src/routes/admin/mails.js views/admin/mails.ejs views/admin/_nav.ejs src/app.js test/integration/admin/mails.test.js test/integration/admin/authz-sweep.test.js
git commit -m "feat: admin Mail-Protokoll page with manual retry for failed sends"
```

---

### Task 9: Ende-zu-Ende-Test — vollständige Mail-Kette

**Files:**
- Create: `test/integration/mailversandEndToEnd.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–8, plus the pre-existing `createApp`, `loginAs`-style login helper (same technique as `test/integration/freigabeWorkflowEndToEnd.test.js` and `test/integration/ablehnungRueckwegEndToEnd.test.js`), `setupMockChurchTools`.
- Produces: nothing (final composition test, no production code).

This is the last task, modeled on D1/D2/D3's final tasks: a genuine end-to-end proof driving the real `createApp()` object graph through the full Zuweisungs-Mail chain (auto-assignment → Freigabe-1 escalation → Freigabe-1 completion → Freigabe-2 escalation → Ablehnung) and the reminder/escalation cron sweep, checked against real `mail_log` rows and a real admin retry — the one test that can catch any remaining cross-task defect between Tasks 1–8 before the final whole-branch review.

Since `createApp`'s `mailer` is created internally (not injectable from outside in production wiring — Task 3 built it with a try/catch around `createMailer(config.smtp)`), and this test needs to control success/failure deterministically, it uses `config.smtp` pointing at a real but unreachable host so every attempt genuinely fails through the app's normal fallback path — proving the whole "never blocks, always logs, admin can retry" story end-to-end without needing to reach into `createApp`'s internals. Retrying via the real `/admin/mails/:id/erneut-versenden` route will fail the same way (same broken SMTP config), so the retry assertion checks that a **new** `fehlgeschlagen` row was appended (proving the retry path itself works), not that it becomes `versendet` — this test does not need a working SMTP server to prove the queue/retry mechanism functions correctly.

- [ ] **Step 1: Write the test**

Create `test/integration/mailversandEndToEnd.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

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
    // Deliberately unreachable — proves the app's real, non-test-only fallback path (Task 3's
    // try/catch around createMailer, plus sendNotification's own catch) handles every attempt
    // gracefully, exactly as it would with a genuinely misconfigured production SMTP server.
    smtp: { host: '203.0.113.1', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' },
    publicBaseUrl: 'https://portal.example.org',
    brandingDir: jobsDir,
    jobsDir,
    downloadSigningSecret: 'download-secret',
  };
}

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

test('every Zuweisungs-Mail trigger across the full workflow logs a mail_log attempt, admin can view and retry', async () => {
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'mailversand-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  seedDefaults(db);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });

  // 1. Job creation with a matching Zuweisungsregel -> auto-assignment mail to freigeber1.
  const pdf = await buildPdfFixture(['Rechnung Seite 1', 'Visum / Rechnungsfreigabe']);
  const createRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', pdf, { filename: 'rechnung.pdf', contentType: 'application/pdf' });
  assert.equal(createRes.status, 201);
  const jobId = createRes.body.id;

  // 2. Freigeber 1 declares a conflict -> escalation mail to stellvertreter1.
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen' });

  // 3. Stellvertreter 1 completes Kontierung + Freigabe 1 -> handoff mail to freigeber2.
  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreter1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  // 4. Freigeber 2 declares a conflict -> escalation mail to stellvertreter2.
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Auch befangen' });

  // 5. Stellvertreter 2 rejects -> Ablehnungs-Benachrichtigung to the job owner (stellvertreter1, '2').
  const stellvertreter2Agent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  await stellvertreter2Agent.post(`/freigabe2/${jobId}`).type('form').send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto' });

  const zuweisungMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.job_id === jobId);
  const ablehnungMails = listMailLog(db).filter((m) => m.typ === 'ablehnung' && m.job_id === jobId);
  // 4, not 3: auto-assignment (step 1) + F1-escalation-to-stellvertreter1 (step 2) +
  // F1-completion-handoff-to-freigeber2 (step 3, the non-conflict branch also sends a
  // typ='zuweisung' mail) + F2-escalation-to-stellvertreter2 (step 4).
  assert.equal(zuweisungMails.length, 4, 'auto-assignment + F1-escalation + F1-completion-handoff + F2-escalation');
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 'f1@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 's1@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 'f2@example.org').length, 1);
  assert.equal(zuweisungMails.filter((m) => m.empfaenger === 's2@example.org').length, 1);
  assert.equal(ablehnungMails.length, 1);
  assert.match(ablehnungMails[0].text, /Falsches Konto/);
  assert.equal(ablehnungMails[0].empfaenger, 's1@example.org', 'notifies the current job owner (stellvertreter1), not the original freigeber1');

  // 6. Reminder/Eskalation sweep against a separately-seeded, very stale, still-unclaimed job.
  const staleJobRes = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'altfall.pdf')
    .field('eingang_am', '2020-01-01T00:00:00.000Z')
    .attach('pdf', pdf, { filename: 'altfall.pdf', contentType: 'application/pdf' });
  assert.equal(staleJobRes.status, 201);

  const sweepRes1 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweepRes1.status, 200);
  assert.equal(sweepRes1.body.reminder, 1);
  assert.equal(sweepRes1.body.eskalation, 1);

  const sweepRes2 = await request(app).post('/internal/cron/pool-erinnerungen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweepRes2.status, 200);
  assert.equal(sweepRes2.body.reminder, 0, 'idempotent: the same stale job is not reminded twice');
  assert.equal(sweepRes2.body.eskalation, 0);

  // 7. Every attempt above targeted an unreachable SMTP host -> all fehlgeschlagen. Admin views
  // the log and retries one -> a new fehlgeschlagen row is appended (proves the retry path
  // itself runs sendNotification again, without requiring a working SMTP server in this test).
  const allMails = listMailLog(db);
  assert.ok(allMails.length >= 6, 'zuweisung x3 + ablehnung x1 + reminder x1 + eskalation x1');
  assert.ok(allMails.every((m) => m.status === 'fehlgeschlagen'), 'unreachable SMTP host: every attempt failed, none crashed the app');

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const listRes = await adminAgent.get('/admin/mails');
  assert.equal(listRes.status, 200);
  assert.match(listRes.text, /Falsches Konto|Rechnung abgelehnt/);

  const countBeforeRetry = listMailLog(db).length;
  const retryRes = await adminAgent.post(`/admin/mails/${ablehnungMails[0].id}/erneut-versenden`);
  assert.equal(retryRes.status, 302);
  assert.equal(listMailLog(db).length, countBeforeRetry + 1, 'retry appends a new row rather than overwriting the original');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/integration/mailversandEndToEnd.test.js`
Expected: PASS. If it fails, investigate whether it's a genuine cross-task defect in Tasks 1–8 (fix it there, flag prominently) or a mistake in this test file itself — do not paper over a real defect by loosening an assertion.

- [ ] **Step 3: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS. Compare the total count against the baseline recorded at the start of Task 1 plus every test added across Tasks 1–9.

- [ ] **Step 4: Commit**

```bash
git add test/integration/mailversandEndToEnd.test.js
git commit -m "test: end-to-end Mailversand proof against the real app"
```
