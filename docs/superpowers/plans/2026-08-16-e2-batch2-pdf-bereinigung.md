# Sub-Phase E2, Batch 2 – PDF-Bereinigung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cron-triggered PDF-retention sweep (`POST /internal/cron/pdf-bereinigung`) that archives `abgeholt` jobs once their files are confirmed deleted, cleans up orphaned `.tmp` stamping artifacts, and prunes aged `mail_log` rows — closing DATA-1/DATA-2/DATA-3/DATA-4 from the E2 security audit and the Lastenheft's `... → abgeholt → archiviert` lifecycle gap.

**Architecture:** Three independent sweeps live behind one new cron route, following the existing `pool-erinnerungen` route's pattern of bundling related periodic work into a single handler. `src/routes/n8n/jobs.js`'s immediate best-effort delete-on-pickup stays as the primary path (now crash-safe); the sweep is the safety net that also catches every pre-existing orphan. No new files beyond the route addition — the three sweeps' data-layer logic lives in the existing `jobsRepo.js` and `mailLogRepo.js` repo modules, matching how `pool-erinnerungen` reuses `jobsRepo.js` functions rather than inlining SQL into the route.

**Tech Stack:** Same as all prior phases — Node.js/Express, `node:sqlite`, `node:fs` (`existsSync`, `unlinkSync`, `readdirSync`, `statSync`), `node:test` + `supertest`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-e2-batch2-pdf-bereinigung-design.md`

## Global Constraints

- Only `status = 'abgeholt'` jobs are ever deletion/archival candidates. `abgelehnt`, blocked, or never-claimed pool jobs are **never** touched by any sweep in this batch — this is a hard scope boundary from the design, not an oversight.
- The sweep is idempotent: re-running it with nothing new to do must report zero for every counter and change nothing.
- No error from any single job/file/row inside a sweep may abort the sweep or crash the process — every per-item failure is caught, logged via `console.error`, and the sweep continues with the next item.
- The route responds `{ status: 'erfolg', archiviert: N, tmpGeloescht: N, mailLogGeloescht: N }` on success (same shape family as `pool-erinnerungen`'s `{ status: 'erfolg', reminder: N, eskalation: N }`).
- The route is mounted under the existing `/internal/cron` blanket guard (`machineLimiter` + `requireCronSecret`) already applied once in `src/app.js` — the new route needs no route-level guard of its own.
- `mail_log_aufbewahrung_tage` is admin-configurable via `admin_config`, default `'90'`.
- Tmp-file age threshold is a fixed constant, 1 hour — not admin-configurable (an ops constant, not a business rule, per the spec's explicit scope exclusion).
- All user-facing/log text in German, matching every other file's existing copy style.

---

### Task 1: `jobsRepo.js` — `archiviert_am` column, `listAbgeholtJobs`, `archivierenJob`

**Files:**
- Modify: `src/db/schema.sql` (add `archiviert_am TEXT` to the `jobs` table)
- Modify: `src/db/jobsRepo.js` (add two new exported functions)
- Test: `test/unit/jobsRepo.test.js` (add tests for both)

**Interfaces:**
- Consumes: nothing new — reuses the existing `jobs` table and `getJobById`.
- Produces (for Task 4):
  - `listAbgeholtJobs(db)` → array of full job rows where `status = 'abgeholt'`
  - `archivierenJob(db, id)` → sets `status = 'archiviert'`, `archiviert_am = <now ISO>` for the job with that id, guarded `WHERE id = ? AND status = 'abgeholt'`; returns `true` if a row was updated, `false` otherwise (mirrors `claimJob`/`releaseJob`'s boolean-return convention for guarded updates)

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.sql`, in the `jobs` table definition, add a new column after `eskalation_gesendet_at TEXT`:

```sql
  reminder_gesendet_at TEXT,
  eskalation_gesendet_at TEXT,
  archiviert_am TEXT
);
```

(This repo has no migration system — every prior phase added columns by editing `schema.sql` directly, since `openDatabase()` always runs the full `CREATE TABLE IF NOT EXISTS` against a fresh or in-memory database and the app has not yet been deployed anywhere. No `ALTER TABLE` needed.)

- [ ] **Step 2: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`. First, extend the import line to add `listAbgeholtJobs` and `archivierenJob`:

```javascript
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson, listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet, listAbgeholtJobs, archivierenJob } from '../../src/db/jobsRepo.js';
```

Then append these tests at the end of the file:

```javascript
test('listAbgeholtJobs returns only abgeholt jobs', () => {
  const db = openDatabase(':memory:');
  const abgeholtId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(abgeholtId);
  createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });

  const rows = listAbgeholtJobs(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, abgeholtId);
  db.close();
});

test('archivierenJob transitions an abgeholt job to archiviert and sets archiviert_am', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const result = archivierenJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'archiviert');
  assert.ok(job.archiviert_am);
  db.close();
});

test('archivierenJob refuses to archive a job that is not abgeholt', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });

  const result = archivierenJob(db, jobId);
  assert.equal(result, false);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
  db.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `listAbgeholtJobs is not a function` / `archivierenJob is not a function`

- [ ] **Step 4: Implement the two functions**

In `src/db/jobsRepo.js`, add after `markEskalationGesendet`:

```javascript
export function listAbgeholtJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgeholt' ORDER BY id").all();
}

export function archivierenJob(db, id) {
  const result = db
    .prepare("UPDATE jobs SET status = 'archiviert', archiviert_am = ? WHERE id = ? AND status = 'abgeholt'")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add archiviert_am column, listAbgeholtJobs, archivierenJob"
```

---

### Task 2: `mailLogRepo.js` prune function + `mail_log_aufbewahrung_tage` admin default

**Files:**
- Modify: `src/db/mailLogRepo.js` (add `pruneMailLogOlderThan`)
- Modify: `src/db/adminConfigRepo.js` (add default)
- Test: `test/unit/mailLogRepo.test.js` (new test)
- Test: `test/unit/adminConfigRepo.test.js` (new test)

**Interfaces:**
- Consumes: nothing new — reuses the existing `mail_log` table and `admin_config` table.
- Produces (for Task 4):
  - `pruneMailLogOlderThan(db, isoThreshold)` → deletes every `mail_log` row with `versucht_am < isoThreshold`; returns the number of rows deleted (`Number`)
  - `admin_config` key `mail_log_aufbewahrung_tage`, default `'90'`, readable via the existing `getConfigValue(db, 'mail_log_aufbewahrung_tage')`

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/adminConfigRepo.test.js`:

```javascript
test('seedDefaults sets mail_log_aufbewahrung_tage default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'mail_log_aufbewahrung_tage'), '90');
  db.close();
});
```

Add to `test/unit/mailLogRepo.test.js`. Extend the import line to add `pruneMailLogOlderThan`:

```javascript
import { logMailAttempt, listMailLog, getMailLogById, pruneMailLogOlderThan } from '../../src/db/mailLogRepo.js';
```

Then append:

```javascript
test('pruneMailLogOlderThan deletes only rows older than the threshold and returns the count deleted', () => {
  const db = openDatabase(':memory:');
  const oldId = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'old@example.org', betreff: 'B', text: 'T', status: 'versendet' });
  db.prepare('UPDATE mail_log SET versucht_am = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', oldId);
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'new@example.org', betreff: 'B', text: 'T', status: 'versendet' });

  const deleted = pruneMailLogOlderThan(db, '2025-01-01T00:00:00.000Z');
  assert.equal(deleted, 1);
  const remaining = listMailLog(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].empfaenger, 'new@example.org');
  db.close();
});

test('pruneMailLogOlderThan deletes nothing and returns 0 when no rows are older than the threshold', () => {
  const db = openDatabase(':memory:');
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'new@example.org', betreff: 'B', text: 'T', status: 'versendet' });
  const deleted = pruneMailLogOlderThan(db, '2020-01-01T00:00:00.000Z');
  assert.equal(deleted, 0);
  assert.equal(listMailLog(db).length, 1);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js`
Expected: FAIL — `pruneMailLogOlderThan is not a function` / `mail_log_aufbewahrung_tage` assertion fails (`null !== '90'`)

- [ ] **Step 3: Implement**

In `src/db/adminConfigRepo.js`, add to the `DEFAULTS` object:

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
  mail_log_aufbewahrung_tage: '90',
};
```

In `src/db/mailLogRepo.js`, add:

```javascript
export function pruneMailLogOlderThan(db, isoThreshold) {
  const result = db.prepare('DELETE FROM mail_log WHERE versucht_am < ?').run(isoThreshold);
  return Number(result.changes);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/mailLogRepo.js src/db/adminConfigRepo.js test/unit/mailLogRepo.test.js test/unit/adminConfigRepo.test.js
git commit -m "feat: add pruneMailLogOlderThan and mail_log_aufbewahrung_tage default"
```

---

### Task 3: Crash-safe delete in the pickup-confirmation route (DATA-1)

**Files:**
- Modify: `src/routes/n8n/jobs.js:121-129` (the `POST /:id/abholung-bestaetigen` handler)
- Test: `test/integration/n8n/jobs.test.js` (new test)

**Interfaces:**
- Consumes: `confirmAbholung` (already imported, unchanged signature).
- Produces: nothing new for later tasks — this is a self-contained hardening fix. The route's response shape (`{ id, status }`) and status codes (200 on success, 409 on invalid transition) are unchanged.

Today, `unlinkSync` inside this handler is called unguarded — if it throws for any reason other than the file already being gone (e.g. a permissions error, a locked file, a filesystem hiccup), the whole request crashes with an unhandled exception, even though the job has *already* committed to `status = 'abgeholt'` in the database one line above. This task wraps each delete attempt individually so a failed delete never crashes the request; the job is already correctly `abgeholt` either way, and Task 4's sweep is the backstop that retries the file deletion later.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/n8n/jobs.test.js` (check the existing file's `testConfig`/import conventions first and match them — it already has tests for this same route). Add:

```javascript
test('POST /:id/abholung-bestaetigen still marks the job abgeholt even if deleting its PDF throws', async () => {
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'abholung-unlink-fail-test-'));
  const config = testConfig();
  const db = openDatabase(':memory:');
  const app = createApp({ db, config });

  // pdf_pfad points at a directory, not a file. unlinkSync() on a directory always throws
  // EISDIR/EPERM on every platform and every user (including root, unlike a chmod-based
  // permission-denial test, which root silently ignores) — a deterministic way to force the
  // route's delete step to fail without relying on filesystem permissions.
  const pdfPfad = join(dir, 'job-is-actually-a-dir.pdf');
  mkdirSync(pdfPfad);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);

  const res = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', 'test-n8n-key');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'abgeholt');
  assert.equal(getJobById(db, jobId).status, 'abgeholt');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Check the top of `test/integration/n8n/jobs.test.js` for the exact existing `import`/`testConfig`/`join`/`openDatabase`/`createJob`/`getJobById` names already in scope before adding this — reuse them rather than re-importing duplicates.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — the request throws/crashes (500 or an uncaught exception surfaced by supertest) instead of returning 200.

- [ ] **Step 3: Implement the fix**

In `src/routes/n8n/jobs.js`, replace the body of the `POST /:id/abholung-bestaetigen` handler:

```javascript
  router.post('/:id/abholung-bestaetigen', (req, res) => {
    const job = confirmAbholung(db, Number(req.params.id));
    if (!job) {
      return res.status(409).json({ error: 'Job ist nicht im Status "abgeschlossen" oder bereits abgeholt.' });
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS, including all pre-existing tests in the file (run the whole file, not just the new test, to confirm no regression).

- [ ] **Step 5: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "fix: don't crash abholung-bestaetigen when deleting job files fails"
```

---

### Task 4: `POST /internal/cron/pdf-bereinigung` — the three-sweep route

**Files:**
- Modify: `src/routes/cron.js`
- Test: `test/integration/cron.test.js`

**Interfaces:**
- Consumes:
  - `listAbgeholtJobs(db)`, `archivierenJob(db, id)` from Task 1
  - `pruneMailLogOlderThan(db, isoThreshold)` from Task 2, and `getConfigValue(db, 'mail_log_aufbewahrung_tage')` (already available via the existing `adminConfigRepo.js` import in `cron.js`)
  - `config.jobsDir` (already threaded into `createCronRouter({ db, config, mailer })`, unused by `cron.js` until now)
- Produces: nothing further downstream — this is Batch 2's terminal route. Mounted automatically under the existing `/internal/cron` guard in `app.js` (no `app.js` change needed).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/cron.test.js`. First check the file's existing `testConfig()` — it needs `jobsDir` added if not already present for these tests; pass it explicitly per-test via a helper the way `mailversandEndToEnd.test.js` does. Append these tests at the end of the file:

```javascript
test('POST /internal/cron/pdf-bereinigung without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/pdf-bereinigung');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/pdf-bereinigung archives an abgeholt job once its PDF and thumbnail are deleted', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  const thumbPfad = join(dir, 'job.png');
  writeFileSync(pdfPfad, 'pdf-bytes');
  writeFileSync(thumbPfad, 'png-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt', thumbnail_pfad = ? WHERE id = ?").run(thumbPfad, jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  assert.equal(res.body.archiviert, 1);
  assert.equal(existsSync(pdfPfad), false);
  assert.equal(existsSync(thumbPfad), false);
  assert.equal(getJobById(db, jobId).status, 'archiviert');
  assert.ok(getJobById(db, jobId).archiviert_am);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung archives an abgeholt job immediately if its files are already gone (idempotent, covers pre-existing orphans)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-gone-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  // pdf_pfad points at a file that never existed on disk — simulates a pre-Batch-2 orphan
  // whose file was already deleted (or never written) by the time the sweep first runs.
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: join(dir, 'missing.pdf') });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.archiviert, 1);
  assert.equal(getJobById(db, jobId).status, 'archiviert');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung never touches an abgelehnt job', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-abgelehnt-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, 'pdf-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgelehnt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.archiviert, 0);
  assert.equal(existsSync(pdfPfad), true);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung deletes .tmp files older than 1 hour but leaves recent ones', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-tmp-test-'));
  const oldTmp = join(dir, 'job-1.pdf.old-uuid.tmp');
  const freshTmp = join(dir, 'job-2.pdf.fresh-uuid.tmp');
  writeFileSync(oldTmp, 'stale-stamped-pdf');
  writeFileSync(freshTmp, 'fresh-stamped-pdf');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.tmpGeloescht, 1);
  assert.equal(existsSync(oldTmp), false);
  assert.equal(existsSync(freshTmp), true);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung prunes mail_log rows older than mail_log_aufbewahrung_tage', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { logMailAttempt, listMailLog } = await import('../../src/db/mailLogRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-maillog-test-'));
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_log_aufbewahrung_tage', '30');
  const oldId = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'old@example.org', betreff: 'B', text: 'T', status: 'versendet' });
  db.prepare('UPDATE mail_log SET versucht_am = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', oldId);
  logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'new@example.org', betreff: 'B', text: 'T', status: 'versendet' });

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.mailLogGeloescht, 1);
  assert.equal(listMailLog(db).length, 1);
  assert.equal(listMailLog(db)[0].empfaenger, 'new@example.org');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('POST /internal/cron/pdf-bereinigung is idempotent: a second run with nothing new to do reports all zeros', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createJob } = await import('../../src/db/jobsRepo.js');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');

  const dir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-idempotent-test-'));
  const pdfPfad = join(dir, 'job.pdf');
  writeFileSync(pdfPfad, 'pdf-bytes');

  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(jobId);

  const config = { ...testConfig(), jobsDir: dir };
  const app = createApp({ db, config });

  const res1 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res1.body.archiviert, 1);

  const res2 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.archiviert, 0);
  assert.equal(res2.body.tmpGeloescht, 0);
  assert.equal(res2.body.mailLogGeloescht, 0);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/cron.test.js`
Expected: FAIL with 404s (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

In `src/routes/cron.js`, add the new imports at the top:

```javascript
import { Router } from 'express';
import { existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import {
  listPoolJobsForReminder,
  markReminderGesendet,
  listPoolJobsForEskalation,
  markEskalationGesendet,
  listAbgeholtJobs,
  archivierenJob,
} from '../db/jobsRepo.js';
import { pruneMailLogOlderThan } from '../db/mailLogRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';
```

Add a module-level constant for the tmp-file age threshold, right below the imports:

```javascript
const TMP_MAX_ALTER_MS = 60 * 60 * 1000; // 1 Stunde
```

Then add the new route, after the closing `});` of `router.post('/pool-erinnerungen', ...)` and before `return router;`:

```javascript
  router.post('/pdf-bereinigung', (req, res) => {
    let archiviert = 0;
    for (const job of listAbgeholtJobs(db)) {
      let pdfWeg = true;
      if (job.pdf_pfad) {
        try {
          if (existsSync(job.pdf_pfad)) unlinkSync(job.pdf_pfad);
        } catch (err) {
          console.error(`Löschen der PDF für archivierten Job ${job.id} fehlgeschlagen:`, err.message);
          pdfWeg = !existsSync(job.pdf_pfad);
        }
      }
      let thumbnailWeg = true;
      if (job.thumbnail_pfad) {
        try {
          if (existsSync(job.thumbnail_pfad)) unlinkSync(job.thumbnail_pfad);
        } catch (err) {
          console.error(`Löschen des Thumbnails für archivierten Job ${job.id} fehlgeschlagen:`, err.message);
          thumbnailWeg = !existsSync(job.thumbnail_pfad);
        }
      }
      if (pdfWeg && thumbnailWeg) {
        if (archivierenJob(db, job.id)) archiviert += 1;
      }
    }

    let tmpGeloescht = 0;
    try {
      const schwelle = Date.now() - TMP_MAX_ALTER_MS;
      for (const name of readdirSync(config.jobsDir)) {
        if (!name.endsWith('.tmp')) continue;
        const pfad = join(config.jobsDir, name);
        try {
          if (statSync(pfad).mtimeMs < schwelle) {
            unlinkSync(pfad);
            tmpGeloescht += 1;
          }
        } catch (err) {
          console.error(`Löschen der verwaisten Tmp-Datei ${pfad} fehlgeschlagen:`, err.message);
        }
      }
    } catch (err) {
      console.error('Tmp-Sweep konnte jobsDir nicht lesen:', err.message);
    }

    const aufbewahrungTage = Number(getConfigValue(db, 'mail_log_aufbewahrung_tage'));
    const mailLogSchwelle = new Date(Date.now() - aufbewahrungTage * 24 * 60 * 60 * 1000).toISOString();
    const mailLogGeloescht = pruneMailLogOlderThan(db, mailLogSchwelle);

    res.json({ status: 'erfolg', archiviert, tmpGeloescht, mailLogGeloescht });
  });

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/cron.test.js`
Expected: PASS, all tests in the file including the 7 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cron.js test/integration/cron.test.js
git commit -m "feat: add POST /internal/cron/pdf-bereinigung sweep (archive, tmp cleanup, mail_log prune)"
```

---

### Task 5: End-to-end coverage — real job through Abholung to Archivierung

**Files:**
- Create: `test/integration/pdfBereinigungEndToEnd.test.js`

**Interfaces:**
- Consumes: the real routes exercised by `freigabeWorkflowEndToEnd.test.js` (`POST /api/n8n/jobs`, `/api/pool/:id/beanspruchen`, `/kontierung/:id`, `/freigabe2/:id`, `/api/n8n/jobs/abholbereit`, `/api/n8n/jobs/:id/abholung-bestaetigen`) plus the new `POST /internal/cron/pdf-bereinigung` from Task 4.
- Produces: nothing further — this is the batch's final verification task.

- [ ] **Step 1: Write the test**

Create `test/integration/pdfBereinigungEndToEnd.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { getJobById } from '../../src/db/jobsRepo.js';
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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
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

test('a job driven through the full workflow to Abholung is archived by the sweep, and a second run stays idempotent', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'pdf-bereinigung-e2e-test-'));
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

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/api/pool/${jobId}/beanspruchen`);
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '' });

  const abholbereitRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(abholbereitRes.body.length, 1);

  const bestaetigenRes = await request(app).post(`/api/n8n/jobs/${jobId}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(bestaetigenRes.status, 200);
  assert.equal(bestaetigenRes.body.status, 'abgeholt');

  const jobAfterAbholung = getJobById(db, jobId);
  assert.equal(existsSync(jobAfterAbholung.pdf_pfad), false, 'the immediate delete-on-pickup path already removed the PDF');

  const sweep1 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweep1.status, 200);
  assert.equal(sweep1.body.archiviert, 1);
  assert.equal(getJobById(db, jobId).status, 'archiviert');
  assert.ok(getJobById(db, jobId).archiviert_am);

  const sweep2 = await request(app).post('/internal/cron/pdf-bereinigung').set('X-Cron-Secret', 'cron-secret');
  assert.equal(sweep2.status, 200);
  assert.equal(sweep2.body.archiviert, 0, 'the job is already archiviert — nothing left for a second run to do');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test test/integration/pdfBereinigungEndToEnd.test.js`
Expected: PASS. (This test has no separate "fails first" step in the usual TDD sense — Tasks 1–4 already implemented and tested the underlying pieces; this task's job is integration coverage across the real, wired-together routes, matching how `freigabeWorkflowEndToEnd.test.js` and `ablehnungRueckwegEndToEnd.test.js` work in this codebase. It should pass on the first run; if it doesn't, that's a real integration gap between Tasks 1–4 to fix before proceeding.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, full suite green, no regressions in any previously-passing file.

- [ ] **Step 4: Commit**

```bash
git add test/integration/pdfBereinigungEndToEnd.test.js
git commit -m "test: cover the full Abholung-to-Archivierung path end to end"
```

---

## After All Tasks: Whole-Batch Review

Following Batch 1's precedent (a bounded-path batch that still added an optional whole-batch review before merge, given the security-sensitive nature of this work), dispatch one whole-branch code review before moving to `finishing-a-development-branch`. Pay particular attention to:

- Does the archive sweep ever transition a job to `archiviert` while either file still exists on disk? (Re-verify by reverting the `pdfWeg && thumbnailWeg` guard and confirming a test fails.)
- Does any per-item try/catch in the sweep swallow an error in a way that silently loses a job forever (as opposed to correctly leaving it for the next run)?
- Does the tmp-sweep's `.tmp` filter risk matching anything other than `freigabe2.js`'s stamping artifacts (e.g. a legitimately in-progress write from another part of the app)? Grep the codebase for every place a `.tmp` suffix is used to confirm the pattern is exclusive to the stamping flow.
- Confirm no code path anywhere newly deletes an `abgelehnt` job's PDF — re-run the "never touches an abgelehnt job" test with the status guard removed to prove it's load-bearing.
