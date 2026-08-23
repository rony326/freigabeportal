# Hash-Abgleich + Zertifikats-Ansicht für Zeitstempel-Prüfung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing RFC3161 timestamp verification (`/zeitstempel-pruefen`) with a job-scoped SHA-256 hash comparison (proving the file on disk really is *this job's* file, not just any validly-stamped PDF) and a formal, printable "Prüfbescheinigung" page for revisor-facing proof.

**Architecture:** A new `jobs.zeitstempel_datei_hash` column stores the SHA-256 of the final, already-stamped PDF bytes, written at the same two call sites that already set `zeitstempel_gesetzt_am` (`freigabe2.js`'s completion path, `cronJobs.js`'s `runZeitstempelNachholenJob` retry). `verifyZeitstempel()` gains an optional `erwarteterHash` parameter and always returns the freshly computed `dateiHash` plus a `hashUebereinstimmung` tri-state (`true`/`false`/`null` — `null` when there's nothing to compare against, e.g. the generic upload tool or a job stamped before this feature existed). The existing status card on `/zeitstempel-pruefen` becomes a checklist with an overall verdict banner and, for job-linked results, a link to a new standalone route+view (`/zeitstempel-pruefen/zertifikat?jobId=`) styled as a formal bescheinigung with full hash values and browser-print CSS — no server-side PDF generation, no new dependency.

**Tech Stack:** Node.js, Express, `node:sqlite`, EJS views, `node:crypto`'s `createHash('sha256')` (already used the same way in `src/routes/n8n/jobs.js`), `node:test` + `supertest` (`npm test` runs `node --test 'test/**/*.test.js'`).

**Spec:** docs/superpowers/specs/2026-08-23-zeitstempel-hash-zertifikat-design.md

## Global Constraints

- No migration system exists beyond the `JOBS_TABLE_MIGRATIONS` idempotent `ALTER TABLE ADD COLUMN` array in `src/db/index.js` — this plan only adds one nullable `TEXT` column, which that pattern already covers fully (no CHECK-constraint change, no rename-recreate-copy-drop needed).
- `node:sqlite`'s FK constraints are actively enforced — every `createKonto`/`createJob` call in tests needs its referenced `personen` rows to already exist via `upsertPerson`.
- EJS views: `<%- %>` only for trusted includes, `<%= %>` for all real data.
- German-language strings throughout (labels, messages) — match the existing tone exactly when copying patterns.
- Hash is always SHA-256, lowercase hex, via `createHash('sha256').update(buffer).digest('hex')` — identical style to the existing `datei_hash` computation in `src/routes/n8n/jobs.js:46`.
- `markZeitstempelGesetzt(db, jobId, zeitpunkt, hash = null)` keeps `hash` defaulted so the two pre-existing test call-sites in `test/unit/jobsRepo.test.js` (lines 508 and 1148, both calling it with 3 arguments) keep working unmodified.
- The hash comparison is only ever meaningful for the job-linked verification path (`?jobId=`) — the generic upload tool (`POST /zeitstempel-pruefen`, no job) always calls `verifyZeitstempel` with no `erwarteterHash`, and must keep behaving exactly as it does today.

---

### Task 1: `jobs.zeitstempel_datei_hash` column + `markZeitstempelGesetzt` hash parameter

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/index.js`
- Modify: `src/db/jobsRepo.js:405-407`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Produces: `markZeitstempelGesetzt(db, jobId, zeitpunkt, hash = null)` — now writes `zeitstempel_datei_hash` alongside `zeitstempel_gesetzt_am` in the same `UPDATE`. Existing 3-argument call sites store `NULL` for the hash, unchanged from today's behavior for `zeitstempel_gesetzt_am`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

Extend the existing test in `test/unit/jobsRepo.test.js` (around line 1141) to also cover the hash, and add a new test for the reset-to-null case right after it:

```javascript
test('markZeitstempelGesetzt sets zeitstempel_gesetzt_am and zeitstempel_datei_hash together', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);

  assert.equal(getJobById(db, jobId).zeitstempel_gesetzt_am, null);
  assert.equal(getJobById(db, jobId).zeitstempel_datei_hash, null);
  markZeitstempelGesetzt(db, jobId, '2026-08-21T10:00:00.000Z', 'abc123');
  assert.equal(getJobById(db, jobId).zeitstempel_gesetzt_am, '2026-08-21T10:00:00.000Z');
  assert.equal(getJobById(db, jobId).zeitstempel_datei_hash, 'abc123');
  db.close();
});

test('markZeitstempelGesetzt with null, null clears both fields again', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET konto_id = ? WHERE id = ?').run(kontoId, jobId);

  markZeitstempelGesetzt(db, jobId, '2026-08-21T10:00:00.000Z', 'abc123');
  markZeitstempelGesetzt(db, jobId, null, null);
  assert.equal(getJobById(db, jobId).zeitstempel_gesetzt_am, null);
  assert.equal(getJobById(db, jobId).zeitstempel_datei_hash, null);
  db.close();
});
```

(These replace the single old test `'markZeitstempelGesetzt sets zeitstempel_gesetzt_am, leaves it null until called'` — delete that one, its coverage is now the first of the two new tests plus the reset test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `SQLITE_ERROR: no such column: zeitstempel_datei_hash` (or the assertion on `zeitstempel_datei_hash` fails with `undefined`), since the column doesn't exist yet.

- [ ] **Step 3: Add the column to `schema.sql`**

In `src/db/schema.sql`, in the `jobs` table definition, add the new column right after `zeitstempel_gesetzt_am`:

```sql
  zeitstempel_gesetzt_am TEXT,
  zeitstempel_datei_hash TEXT,
  abgeschlossen_am TEXT,
```

- [ ] **Step 4: Add the migration entry to `src/db/index.js`**

In `JOBS_TABLE_MIGRATIONS` (around line 23), add a new entry right after `zeitstempel_gesetzt_am`:

```javascript
  { column: 'zeitstempel_gesetzt_am', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_gesetzt_am TEXT' },
  { column: 'zeitstempel_datei_hash', ddl: 'ALTER TABLE jobs ADD COLUMN zeitstempel_datei_hash TEXT' },
  { column: 'abgeschlossen_am', ddl: 'ALTER TABLE jobs ADD COLUMN abgeschlossen_am TEXT' },
```

- [ ] **Step 5: Update `markZeitstempelGesetzt`**

In `src/db/jobsRepo.js`, replace:

```javascript
export function markZeitstempelGesetzt(db, jobId, zeitpunkt) {
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ? WHERE id = ?').run(zeitpunkt, jobId);
}
```

with:

```javascript
export function markZeitstempelGesetzt(db, jobId, zeitpunkt, hash = null) {
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ?, zeitstempel_datei_hash = ? WHERE id = ?').run(zeitpunkt, hash, jobId);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS (in particular `test/integration/freigabe2.test.js` and `test/unit/cronJobs.test.js`, whose existing 3-argument `markZeitstempelGesetzt` calls must be unaffected by the new default parameter)

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/db/index.js src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add jobs.zeitstempel_datei_hash column"
```

---

### Task 2: `verifyZeitstempel` — hash computation and comparison

**Files:**
- Modify: `src/services/zeitstempel.js`
- Test: `test/unit/zeitstempel.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (this is pure PDF logic, no DB).
- Produces: `verifyZeitstempel(pdfBuffer, erwarteterHash = null)` → `Promise<{ vorhanden, gueltig, zeitpunkt, tsaPolicy, dateiHash, hashUebereinstimmung }>`. `dateiHash` is always the SHA-256 hex digest of `pdfBuffer`, computed regardless of whether a timestamp is found. `hashUebereinstimmung` is `true`/`false` when `erwarteterHash` is given (non-null), otherwise `null`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/zeitstempel.test.js`, replace the existing exact-shape test:

```javascript
test('verifyZeitstempel reports vorhanden:false for a PDF with no timestamp', async () => {
  const plain = await buildPdfFixture(['Kein Zeitstempel hier.']);
  const result = await verifyZeitstempel(plain);
  assert.deepEqual(result, { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null });
});
```

with:

```javascript
test('verifyZeitstempel reports vorhanden:false for a PDF with no timestamp, and still computes dateiHash', async () => {
  const plain = await buildPdfFixture(['Kein Zeitstempel hier.']);
  const result = await verifyZeitstempel(plain);
  assert.equal(result.vorhanden, false);
  assert.equal(result.gueltig, false);
  assert.equal(result.zeitpunkt, null);
  assert.equal(result.tsaPolicy, null);
  assert.equal(result.dateiHash, createHash('sha256').update(plain).digest('hex'));
  assert.equal(result.hashUebereinstimmung, null, 'no erwarteterHash was given, so there is nothing to compare');
});
```

Add three new tests right after the existing `'verifyZeitstempel reports gueltig:false when the PDF content was altered after timestamping'` test:

```javascript
test('verifyZeitstempel reports hashUebereinstimmung:true when the given hash matches the file', async () => {
  const erwarteterHash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF, erwarteterHash);
  assert.equal(result.dateiHash, erwarteterHash);
  assert.equal(result.hashUebereinstimmung, true);
});

test('verifyZeitstempel reports hashUebereinstimmung:false when the given hash does not match the file', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF, 'ein-falscher-hash');
  assert.equal(result.hashUebereinstimmung, false);
});

test('verifyZeitstempel reports hashUebereinstimmung:null when no erwarteterHash is given at all', async () => {
  const result = await verifyZeitstempel(RFC3161_TIMESTAMPED_PDF);
  assert.equal(result.hashUebereinstimmung, null);
});
```

Add the `createHash` import at the top of the test file:

```javascript
import { createHash } from 'node:crypto';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/zeitstempel.test.js`
Expected: FAIL — `result.dateiHash` / `result.hashUebereinstimmung` are `undefined`, and the first rewritten test fails on the new assertions.

- [ ] **Step 3: Implement the hash logic in `verifyZeitstempel`**

In `src/services/zeitstempel.js`, add the import:

```javascript
import { createHash } from 'node:crypto';
```

Replace the whole `verifyZeitstempel` function:

```javascript
// Never throws: a PDF with no timestamp, a corrupt/unreadable PDF, or a cryptographically invalid
// timestamp are all normal, displayable outcomes for the verification UI (dashboard link, upload
// tool) — not error conditions the caller needs to catch.
//
// erwarteterHash lets a caller with a DB-stored hash (a job's zeitstempel_datei_hash) ask "is this
// really that exact file?" — independent of the RFC3161 result. RFC3161 alone proves "this file is
// unchanged since it was stamped", but not "this is the file that belongs to this job": a job's
// pdf_pfad could be swapped for a different, separately valid, stamped PDF without RFC3161 alone
// noticing. dateiHash is always computed, whether or not a timestamp is present, since the hash
// comparison is an independent fact about the bytes, not a sub-step of the RFC3161 check.
export async function verifyZeitstempel(pdfBuffer, erwarteterHash = null) {
  const dateiHash = createHash('sha256').update(pdfBuffer).digest('hex');
  const hashUebereinstimmung = erwarteterHash != null ? dateiHash === erwarteterHash : null;
  const basis = { dateiHash, hashUebereinstimmung };

  let extrahiert;
  try {
    extrahiert = await extractTimestamps(pdfBuffer);
  } catch {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  if (extrahiert.length === 0) {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  const verifiziert = await verifyTimestamp(extrahiert[0], { pdf: pdfBuffer });
  return {
    vorhanden: true,
    gueltig: verifiziert.verified,
    zeitpunkt: verifiziert.info.genTime.toISOString(),
    tsaPolicy: verifiziert.info.policy,
    ...basis,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/zeitstempel.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/zeitstempel.js test/unit/zeitstempel.test.js
git commit -m "feat: verifyZeitstempel compares a caller-supplied hash against the file"
```

---

### Task 3: Store the hash at Freigabe-2 completion (`freigabe2.js`)

**Files:**
- Modify: `src/routes/freigabe2.js:1-4,258-333`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Consumes: `markZeitstempelGesetzt(db, jobId, zeitpunkt, hash)` (Task 1), `createHash` from `node:crypto`.
- Produces: nothing new for later tasks — `jobs.zeitstempel_datei_hash` is now populated for every job stamped via Freigabe-2 completion.

- [ ] **Step 1: Write the failing tests**

In `test/integration/freigabe2.test.js`, extend the existing test `'POST /freigabe2/:id sets zeitstempel_gesetzt_am when a TSA is configured and reachable'` (around line 348) to also assert the hash, and add the expected value:

```javascript
test('POST /freigabe2/:id sets zeitstempel_gesetzt_am when a TSA is configured and reachable', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'freigabe2-zeitstempel-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  const pdf = await buildPdfFixture(['Rechnung Seite 1']);
  writeFileSync(pdfPfad, pdf);
  const { id } = await seedFreigabe2Job(db, { pdfPfad });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');

  const rfc3161Response = readFileSync(new URL('../fixtures/rfc3161-response.der', import.meta.url));
  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, rfc3161Response, { headers: { 'content-type': 'application/timestamp-reply' } });

  const app = buildTestApp(db);
  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ interessenskonflikt: 'nein', begruendung: '' });

  assert.equal(res.status, 302);
  const job = getJobById(db, id);
  assert.equal(job.status, 'abgeschlossen');
  assert.ok(job.zeitstempel_gesetzt_am, 'zeitstempel_gesetzt_am must be set after a successful TSA call');
  assert.match(job.zeitstempel_datei_hash, /^[0-9a-f]{64}$/, 'zeitstempel_datei_hash must be a sha256 hex digest');
  assert.equal(job.zeitstempel_datei_hash, createHash('sha256').update(readFileSync(pdfPfad)).digest('hex'), 'the stored hash must match the final bytes on disk');

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Also extend the existing test `'POST /freigabe2/:id clears zeitstempel_gesetzt_am again when the stamped PDF cannot be renamed into place'` (around line 380) to also assert the hash is cleared — add this assertion right after the existing `zeitstempel_gesetzt_am` one (around line 431):

```javascript
  assert.equal(
    job.zeitstempel_datei_hash,
    null,
    'zeitstempel_datei_hash must be cleared right alongside zeitstempel_gesetzt_am — a hash without a matching timestamp claim would be meaningless'
  );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — `job.zeitstempel_datei_hash` is `undefined`/`null` where a hex string is expected.

- [ ] **Step 3: Implement the hash computation in `freigabe2.js`**

In `src/routes/freigabe2.js`, change the import on line 3:

```javascript
import { randomUUID, createHash } from 'node:crypto';
```

Replace the block from the existing comment through the `if (tsaUrl) { ... }` (lines 258–275):

```javascript
      // Non-blocking, best-effort: a TSA outage must never prevent Freigabe 2 from completing.
      // Deliberately outside the DB transaction below — that transaction always commits the
      // Freigabe itself; a failed timestamp attempt is simply retried later by the
      // zeitstempel-nachholen cron job (see cronJobs.js) rather than rolled back here.
      const tsaUrl = getConfigValue(db, 'zeitstempel_tsa_url');
      let zeitstempelGesetztAm = null;
      let zeitstempelDateiHash = null;
      if (tsaUrl) {
        try {
          stamped = await setZeitstempel(stamped, {
            url: tsaUrl,
            user: getConfigValue(db, 'zeitstempel_tsa_user') || undefined,
            passwort: getConfigValue(db, 'zeitstempel_tsa_passwort') || undefined,
          });
          zeitstempelGesetztAm = new Date().toISOString();
          zeitstempelDateiHash = createHash('sha256').update(stamped).digest('hex');
        } catch (err) {
          console.error(`Zeitstempel für Job ${job.id} fehlgeschlagen, wird nachgeholt:`, err.message);
        }
      }
```

Replace the success-path call (line 300-302):

```javascript
        if (zeitstempelGesetztAm) {
          markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm);
        }
```

with:

```javascript
        if (zeitstempelGesetztAm) {
          markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm, zeitstempelDateiHash);
        }
```

Replace the rename-failure reset call (lines 326-332):

```javascript
        if (zeitstempelGesetztAm) {
          try {
            markZeitstempelGesetzt(db, job.id, null);
          } catch (clearErr) {
            console.error(`Zurücksetzen von zeitstempel_gesetzt_am für Job ${job.id} fehlgeschlagen:`, clearErr.message);
          }
        }
```

with:

```javascript
        if (zeitstempelGesetztAm) {
          try {
            markZeitstempelGesetzt(db, job.id, null, null);
          } catch (clearErr) {
            console.error(`Zurücksetzen von zeitstempel_gesetzt_am für Job ${job.id} fehlgeschlagen:`, clearErr.message);
          }
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/freigabe2.js test/integration/freigabe2.test.js
git commit -m "feat: store the stamped PDF's hash at Freigabe-2 completion"
```

---

### Task 4: Store the hash in the Zeitstempel-Nachholen cron job (`cronJobs.js`)

**Files:**
- Modify: `src/services/cronJobs.js:1-20,227-234`
- Test: `test/unit/cronJobs.test.js`

**Interfaces:**
- Consumes: `markZeitstempelGesetzt(db, jobId, zeitpunkt, hash)` (Task 1), `createHash` from `node:crypto`.
- Produces: nothing new for later tasks — `jobs.zeitstempel_datei_hash` is now also populated for jobs stamped via the retry path.

- [ ] **Step 1: Write the failing test**

In `test/unit/cronJobs.test.js`, extend the existing test `'runZeitstempelNachholenJob sets zeitstempel_gesetzt_am for a pending abgeschlossen job and logs the run'` (around line 35):

```javascript
test('runZeitstempelNachholenJob sets zeitstempel_gesetzt_am for a pending abgeschlossen job and logs the run', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'nachholen-test-'));
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://tsa.example.org/tsr');
  const { id, pdfPfad } = await seedAbgeschlossenJob(db, dir);

  const client = setupMockTsa('https://tsa.example.org/tsr');
  client.intercept({ path: '/tsr', method: 'POST' }).reply(200, RFC3161_RESPONSE, { headers: { 'content-type': 'application/timestamp-reply' } });

  const result = await runZeitstempelNachholenJob(db, {});
  assert.equal(result.status, 'erfolg');
  assert.equal(result.nachgeholt, 1);
  assert.equal(result.fehlgeschlagen, 0);
  assert.equal(result.dateiFehlt, 0);
  const job = getJobById(db, id);
  assert.ok(job.zeitstempel_gesetzt_am);
  assert.equal(job.zeitstempel_datei_hash, createHash('sha256').update(readFileSync(pdfPfad)).digest('hex'), 'the stored hash must match the final stamped bytes on disk');

  const log = listRecentCronLog(db, 'zeitstempel-nachholen', 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'erfolg');
  assert.match(log[0].details, /Nachgeholt: 1/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Add the `createHash` import at the top of the test file:

```javascript
import { createHash } from 'node:crypto';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/cronJobs.test.js`
Expected: FAIL — `job.zeitstempel_datei_hash` is `null`, not a hex digest.

- [ ] **Step 3: Implement the hash computation in `runZeitstempelNachholenJob`**

In `src/services/cronJobs.js`, change the `node:crypto` import on line 3:

```javascript
import { randomUUID, createHash } from 'node:crypto';
```

Replace the loop body (lines 227-234):

```javascript
      try {
        const pdfBuffer = readFileSync(job.pdf_pfad);
        const stamped = await setZeitstempel(pdfBuffer, tsaConfig);
        const tmpPfad = `${job.pdf_pfad}.${randomUUID()}.tmp`;
        writeFileSync(tmpPfad, stamped);
        renameSync(tmpPfad, job.pdf_pfad);
        markZeitstempelGesetzt(db, job.id, new Date().toISOString(), createHash('sha256').update(stamped).digest('hex'));
        nachgeholt += 1;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/cronJobs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/cronJobs.js test/unit/cronJobs.test.js
git commit -m "feat: store the stamped PDF's hash when the nachholen cron job retries a timestamp"
```

---

### Task 5: Wire the hash comparison into `/zeitstempel-pruefen` + checklist UI

**Files:**
- Modify: `src/routes/zeitstempelPruefen.js:26`
- Modify: `views/zeitstempel-pruefen.ejs`
- Test: `test/integration/zeitstempelPruefen.test.js`

**Interfaces:**
- Consumes: `verifyZeitstempel(pdfBuffer, erwarteterHash)` (Task 2).
- Produces: the `job`-linked verification result (`ergebnis`) now carries `dateiHash`/`hashUebereinstimmung`, rendered in the view. Later Task 6 reuses this same `ergebnis` shape for the certificate page.

- [ ] **Step 1: Write the failing tests**

In `test/integration/zeitstempelPruefen.test.js`, extend the existing job-linked success test (around line 94) with a hash-match assertion, and add two new tests right after it — one for a mismatch (file tampered on disk after stamping) and one for a job with no stored hash at all (pre-feature job):

```javascript
test('GET /zeitstempel-pruefen?jobId= shows a matching hash for an unaltered file', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ? WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Hash stimmt mit Datenbank überein/);
  assert.match(res.text, /Zertifikat anzeigen/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows a mismatched hash and a red banner when the file was swapped after stamping', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-mismatch-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = 'ein-anderer-hash' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Datei weicht vom in der Datenbank hinterlegten Original ab/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('GET /zeitstempel-pruefen?jobId= shows "kein Vergleichswert" for a job with no stored hash', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-pruefen-hash-none-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /kein Vergleichswert vorhanden/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

Also extend the existing upload-tool test `'POST /zeitstempel-pruefen with a validly timestamped PDF reports it as valid, with the timestamp'` (around line 70) with one more assertion, confirming the generic path shows no hash-comparison claim:

```javascript
  assert.match(res.text, /kein Vergleichswert vorhanden/);
```

(add this line right after the existing `assert.match(res.text, /2026-08-21T07:21:19\.000Z/);`)

**The new checklist markup (Step 4 below) no longer renders the exact phrase "Gültiger Zeitstempel vorhanden"** — it replaces the old one-line result with a checklist plus a separate banner. Two pre-existing tests assert on that exact phrase and must be updated in this same step, or they will fail after Step 4 regardless of whether the new behavior is correct:

- Line ~79, in `'POST /zeitstempel-pruefen with a validly timestamped PDF reports it as valid, with the timestamp'`: replace
  ```javascript
  assert.match(res.text, /Gültiger Zeitstempel vorhanden/);
  ```
  with
  ```javascript
  assert.match(res.text, /Kryptografisch gültig \(RFC3161\)/);
  assert.match(res.text, /Diese Datei ist nachweislich unverändert/);
  ```
- Line ~112, in `'GET /zeitstempel-pruefen?jobId= verifies the job\'s own PDF directly for an authorized person, no upload form'`: same replacement (this job has no `zeitstempel_datei_hash` set, so `hashUebereinstimmung` is `null` — still `!== false`, so the green banner still applies).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/zeitstempelPruefen.test.js`
Expected: FAIL — the view doesn't render any of "Hash stimmt mit Datenbank überein" / "Datei weicht vom in der Datenbank hinterlegten Original ab" / "kein Vergleichswert vorhanden" / "Zertifikat anzeigen" / "Diese Datei ist nachweislich unverändert" yet, and the route doesn't pass a hash to `verifyZeitstempel` at all yet.

- [ ] **Step 3: Pass the job's stored hash into `verifyZeitstempel`**

In `src/routes/zeitstempelPruefen.js`, replace line 26:

```javascript
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad));
```

with:

```javascript
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
```

- [ ] **Step 4: Rewrite the status card in `views/zeitstempel-pruefen.ejs`**

Replace the whole result `<div class="card ...">...</div>` block (currently lines 32-43) with:

```html
      <div class="card col-12 col-lg-6">
        <div class="card-body">
          <% if (!ergebnis.vorhanden) { %>
            <p class="mb-0">⚠️ Kein Zeitstempel in dieser Datei gefunden.</p>
          <% } else { %>
            <ul class="list-unstyled mb-3">
              <li><%= ergebnis.vorhanden ? '✓' : '✗' %> Zeitstempel vorhanden</li>
              <li><%= ergebnis.gueltig ? '✓' : '✗' %> Kryptografisch gültig (RFC3161)</li>
              <li>
                <% if (ergebnis.hashUebereinstimmung === true) { %>✓ Hash stimmt mit Datenbank überein
                <% } else if (ergebnis.hashUebereinstimmung === false) { %>✗ Hash weicht von der Datenbank ab
                <% } else { %>– kein Vergleichswert vorhanden
                <% } %>
              </li>
            </ul>
            <% if (ergebnis.gueltig && ergebnis.hashUebereinstimmung !== false) { %>
              <p class="mb-3"><strong class="text-success">✓ Diese Datei ist nachweislich unverändert.</strong></p>
            <% } else if (!ergebnis.gueltig) { %>
              <p class="mb-3 text-danger"><strong>✗ Zeitstempel vorhanden, aber ungültig — die Datei wurde nach dem Zeitstempel verändert.</strong></p>
            <% } else { %>
              <p class="mb-3 text-danger"><strong>✗ Datei weicht vom in der Datenbank hinterlegten Original ab.</strong></p>
            <% } %>
            <p class="text-muted small mb-0">Zeitpunkt: <%= ergebnis.zeitpunkt %><% if (ergebnis.tsaPolicy) { %> · TSA-Policy: <%= ergebnis.tsaPolicy %><% } %></p>
            <% if (job && ergebnis.vorhanden) { %>
              <p class="mt-3 mb-0"><a href="/zeitstempel-pruefen/zertifikat?jobId=<%= job.id %>" class="btn btn-outline-primary btn-sm">Zertifikat anzeigen</a></p>
            <% } %>
          <% } %>
        </div>
      </div>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/zeitstempelPruefen.test.js`
Expected: PASS

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/zeitstempelPruefen.js views/zeitstempel-pruefen.ejs test/integration/zeitstempelPruefen.test.js
git commit -m "feat: show hash comparison on the Zeitstempel-Prüfung status card"
```

---

### Task 6: Certificate page (`/zeitstempel-pruefen/zertifikat`)

**Files:**
- Modify: `src/routes/zeitstempelPruefen.js`
- Create: `views/zeitstempel-zertifikat.ejs`
- Test: `test/integration/zeitstempelPruefen.test.js`

**Interfaces:**
- Consumes: `canViewJobPdf` (existing), `verifyZeitstempel(pdfBuffer, erwarteterHash)` (Task 2), the checklist markup pattern from Task 5.
- Produces: `GET /zeitstempel-pruefen/zertifikat?jobId=<id>` — no interface other code depends on; this is the plan's final task.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/zeitstempelPruefen.test.js`:

```javascript
test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/zeitstempel-pruefen/zertifikat?jobId=1');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 403 for a person not authorized to view that job', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '2');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= returns 404 when the job\'s PDF file no longer exists', async () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/nonexistent/gone.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeholt', zugewiesen_an = '1' WHERE id = ?").run(id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 404);
  db.close();
});

test('GET /zeitstempel-pruefen/zertifikat?jobId= renders the Prüfbescheinigung with job context and hash values', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '3');
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '1', freigeber2Id: '3', stellvertreter2Id: '3' });
  const dir = mkdtempSync(join(tmpdir(), 'zeitstempel-zertifikat-test-'));
  const pdfPfad = join(dir, 'a.pdf');
  writeFileSync(pdfPfad, RFC3161_TIMESTAMPED_PDF);
  const hash = createHash('sha256').update(RFC3161_TIMESTAMPED_PDF).digest('hex');
  const id = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', zugewiesen_an = '1', zeitstempel_datei_hash = ?, rechnungsnummer = 'RE-2026-042', lieferant = 'Muster AG', betrag = '123.45' WHERE id = ?").run(hash, id);

  const app = buildTestApp(db);
  const res = await request(app).get(`/zeitstempel-pruefen/zertifikat?jobId=${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Prüfbescheinigung/);
  assert.match(res.text, /RE-2026-042/);
  assert.match(res.text, /Muster AG/);
  assert.match(res.text, new RegExp(hash));
  assert.match(res.text, /window\.print\(\)/);

  rmSync(dir, { recursive: true, force: true });
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/zeitstempelPruefen.test.js`
Expected: FAIL — `GET /zeitstempel-pruefen/zertifikat` doesn't exist yet (404 for all, or an Express routing error).

- [ ] **Step 3: Add the route**

In `src/routes/zeitstempelPruefen.js`, add a new route right after the existing `GET /` handler (after its closing `});`, before `router.post('/', ...)`):

```javascript
  router.get('/zertifikat', async (req, res, next) => {
    try {
      const jobId = Number(req.query.jobId);
      const job = jobId ? getJobById(db, jobId) : null;
      if (!job || !canViewJobPdf(db, config, req.currentPerson, job)) {
        return res.status(403).render('error', { message: 'Kein Zugriff auf diesen Job.' });
      }
      if (!job.pdf_pfad || !existsSync(job.pdf_pfad)) {
        return res.status(404).render('error', { message: 'PDF-Datei für diesen Job ist nicht mehr vorhanden.' });
      }
      const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
      res.render('zeitstempel-zertifikat', { ergebnis, job, erstelltAm: new Date().toISOString(), erstelltVon: `${req.currentPerson.vorname} ${req.currentPerson.nachname}` });
    } catch (err) {
      next(err);
    }
  });

```

- [ ] **Step 4: Create the certificate view**

Create `views/zeitstempel-zertifikat.ejs`:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Prüfbescheinigung — <%= branding.seitenTitel %></title>
  <style>
    .bescheinigung { border: 2px solid #333; padding: 2rem; }
    .hash-wert { font-family: monospace; word-break: break-all; }
    @media print {
      .no-print { display: none !important; }
      .bescheinigung { border: 2px solid #000; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="no-print"><%- include('_header') %></div>
  <main class="container py-4">
    <p class="no-print"><a href="/zeitstempel-pruefen?jobId=<%= job.id %>">← Zurück zur Prüfung</a></p>

    <div class="bescheinigung col-12 col-lg-8">
      <h1>Prüfbescheinigung</h1>
      <p class="text-muted">Diese Bescheinigung ist kein rechtsverbindliches Signaturzertifikat. Sie fasst das Ergebnis der RFC3161-Zeitstempel- und Hash-Prüfung dieses Dokuments zusammen.</p>

      <h2 class="h5 mt-4">Beleg</h2>
      <p class="mb-1"><strong>Dateiname:</strong> <%= job.dateiname %></p>
      <% if (job.rechnungsnummer) { %><p class="mb-1"><strong>Rechnungsnummer:</strong> <%= job.rechnungsnummer %></p><% } %>
      <% if (job.lieferant) { %><p class="mb-1"><strong>Lieferant:</strong> <%= job.lieferant %></p><% } %>
      <% if (job.betrag) { %><p class="mb-1"><strong>Betrag:</strong> <%= job.betrag %></p><% } %>

      <h2 class="h5 mt-4">Prüfergebnis</h2>
      <ul class="list-unstyled">
        <li><%= ergebnis.vorhanden ? '✓' : '✗' %> Zeitstempel vorhanden</li>
        <li><%= ergebnis.gueltig ? '✓' : '✗' %> Kryptografisch gültig (RFC3161)</li>
        <li>
          <% if (ergebnis.hashUebereinstimmung === true) { %>✓ Hash stimmt mit Datenbank überein
          <% } else if (ergebnis.hashUebereinstimmung === false) { %>✗ Hash weicht von der Datenbank ab
          <% } else { %>– kein Vergleichswert vorhanden
          <% } %>
        </li>
      </ul>
      <p><strong>Zeitpunkt des Zeitstempels:</strong> <%= ergebnis.zeitpunkt || '—' %></p>
      <% if (ergebnis.tsaPolicy) { %><p><strong>TSA-Policy:</strong> <%= ergebnis.tsaPolicy %></p><% } %>

      <h2 class="h5 mt-4">Hash-Werte (SHA-256)</h2>
      <p class="mb-1"><strong>Aktuell berechneter Hash der Datei:</strong><br><span class="hash-wert"><%= ergebnis.dateiHash %></span></p>
      <p class="mb-1"><strong>In der Datenbank hinterlegter Hash:</strong><br><span class="hash-wert"><%= job.zeitstempel_datei_hash || '— kein Vergleichswert vorhanden' %></span></p>

      <p class="text-muted small mt-4">Diese Bescheinigung wurde erstellt am <%= erstelltAm %> durch <%= erstelltVon %>.</p>
    </div>

    <p class="no-print mt-3"><button type="button" class="btn btn-primary" onclick="window.print()">Drucken / als PDF speichern</button></p>
  </main>
  <div class="no-print"><%- include('_footer') %></div>
</body>
</html>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/integration/zeitstempelPruefen.test.js`
Expected: PASS

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/zeitstempelPruefen.js views/zeitstempel-zertifikat.ejs test/integration/zeitstempelPruefen.test.js
git commit -m "feat: add a printable Prüfbescheinigung page for job timestamp verification"
```
