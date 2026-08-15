# Freigabeportal Phase C: n8n-Schnittstelle & Job-Datenmodell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Job data model and the three-way API surface Phase D's UI will sit on: n8n job ingestion + two-phase pickup, an atomic human "beanspruchen" endpoint for the pool, and short-lived HMAC-signed PDF download links.

**Architecture:** Pure JSON/data API, no browser UI. Three cleanly separated auth mechanisms per endpoint group (n8n: `X-API-Key`; pool: ChurchTools session + `buchhaltung` role; downloads: HMAC signature embedded in the URL, no header auth at all). Two new SQLite tables (`jobs`, `freigaben`, the latter unused until Phase D). Zuweisungsregel-based auto-assignment (Phase B's `absender_muster` matching logic, deliberately deferred to this phase) runs at job-creation time.

**Tech Stack:** Same as Phases A/B (Node ≥22.13.0, Express, `node:sqlite`, `node:test`, `supertest`, `multer` already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-14-phase-c-n8n-jobs-design.md`

## Global Constraints

- Three auth mechanisms, never mixed: `requireApiKey` (Phase A) for `/api/n8n/*`; `requireRole(config, 'buchhaltung')` (Phase A) for `/api/pool/*`; HMAC signature in the query string for `/downloads/*` (no session, no API key).
- PDF upload: magic-bytes check on the real `%PDF` header (first 4 bytes), not just the client-declared `Content-Type`. Max 20 MB.
- Zuweisungsregel-Matching: exact email address wins over domain-suffix match; domain match includes subdomains (`lieferant.ch` matches `sub.lieferant.ch` but not `notlieferant.ch`); a matched Konto must be `aktiv` or the job falls back to the pool.
- "Beanspruchen" is atomic (`UPDATE ... WHERE status = 'unzugewiesen'`); a race loses with 409, never 500.
- Two-phase pickup: a claim (`fetched_by_n8n_at`) expires after 15 minutes and is re-offered; confirming is only possible while `status = 'abgeschlossen'`, then flips to `abgeholt` and actively deletes the PDF from disk.
- Signed downloads: HMAC-SHA256 over `${jobId}.${expires}`, compared with `crypto.timingSafeEqual`; expired and tampered signatures return the identical generic 403 message (no oracle).
- All nine job status values (`unzugewiesen, zugewiesen, kontiert, freigabe1, freigabe2, abgeschlossen, abgeholt, archiviert, abgelehnt`) are defined in the schema `CHECK` constraint now, even though this phase only ever sets `unzugewiesen`, `zugewiesen`, and (in tests, to exercise pickup) `abgeschlossen`/`abgeholt`.
- No outbound email in this phase (Phase D's job). No browser UI in this phase — every route returns JSON except the download stream.
- Tests: real HTTP via `supertest` against a real in-memory `node:sqlite` DB, real PDF-byte fixtures, no mocking of this project's own business logic.
- `npm test` runs `node --test 'test/**/*.test.js'` — do not change this script.

---

### Task 1: Schema additions + config

**Files:**
- Modify: `src/db/schema.sql` — add `jobs` and `freigaben` tables
- Modify: `src/config/env.js` — add `jobsDir`, `downloadSigningSecret`
- Modify: `.env.example` — document `JOBS_DIR`, `DOWNLOAD_SIGNING_SECRET`
- Modify: `test/unit/db.test.js` — assert the two new tables exist
- Modify: `test/unit/env.test.js` — assert `jobsDir` default and `downloadSigningSecret` required

**Interfaces:**
- Consumes: nothing new.
- Produces: `jobs` table, `freigaben` table. `config.jobsDir` (string, default `./data/jobs`). `config.downloadSigningSecret` (string, required — throws like `sessionSecret`/`cronSecret` if missing).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/db.test.js` (extend the existing table-name loop):

```js
test('openDatabase creates all expected tables', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln', 'jobs', 'freigaben']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});
```

Add to `test/unit/env.test.js`:

```js
test('loadConfig defaults jobsDir and requires downloadSigningSecret', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.jobsDir, './data/jobs');
  const { DOWNLOAD_SIGNING_SECRET, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: DOWNLOAD_SIGNING_SECRET/);
});
```

Also add `DOWNLOAD_SIGNING_SECRET: 'download-signing-secret'` to the `FULL_ENV` object at the top
of `test/unit/env.test.js` (it must be present for every other existing test in that file to keep
passing once `downloadSigningSecret` becomes required).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js test/unit/env.test.js`
Expected: FAIL — `jobs`/`freigaben` tables don't exist yet, `jobsDir`/`downloadSigningSecret` aren't in `loadConfig`'s return value yet.

- [ ] **Step 3: Update `src/db/schema.sql`** — append at the end of the file

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eingang_am TEXT NOT NULL,
  quelle TEXT NOT NULL CHECK (quelle IN ('scanner', 'lieferant')),
  absender TEXT,
  dateiname TEXT NOT NULL,
  pdf_pfad TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'unzugewiesen','zugewiesen','kontiert','freigabe1','freigabe2',
    'abgeschlossen','abgeholt','archiviert','abgelehnt'
  )) DEFAULT 'unzugewiesen',
  konto_id INTEGER REFERENCES konten(id),
  zugewiesen_an TEXT REFERENCES personen(churchtools_person_id),
  abgelehnt_von TEXT REFERENCES personen(churchtools_person_id),
  ablehnungsgrund TEXT,
  fetched_by_n8n_at TEXT
);

CREATE TABLE IF NOT EXISTS freigaben (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2')),
  zeitpunkt TEXT NOT NULL,
  ip TEXT NOT NULL,
  interessenskonflikt INTEGER NOT NULL DEFAULT 0,
  kommentar TEXT,
  eskaliert_von TEXT REFERENCES personen(churchtools_person_id)
);
```

- [ ] **Step 4: Update `src/config/env.js`** — add both fields to the object `loadConfig` returns

```js
export function loadConfig(env = process.env) {
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    sessionSecret: required(env, 'SESSION_SECRET'),
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    brandingDir: env.BRANDING_DIR || './data/branding',
    jobsDir: env.JOBS_DIR || './data/jobs',
    downloadSigningSecret: required(env, 'DOWNLOAD_SIGNING_SECRET'),
    churchtools: {
      // ... unchanged
    },
    // ... unchanged
  };
}
```

- [ ] **Step 5: Update `.env.example`** — add near `BRANDING_DIR`

```
# Speicherort fuer hochgeladene Rechnungs-PDFs (n8n-Schnittstelle)
JOBS_DIR=./data/jobs
# Signing-Secret fuer kurzlebige, signierte PDF-Download-Links (getrennt von SESSION_SECRET etc.)
DOWNLOAD_SIGNING_SECRET=changeme-long-random-string
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js test/unit/env.test.js`
Expected: PASS

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS (adding `DOWNLOAD_SIGNING_SECRET` to `FULL_ENV` must not break any other existing env test)

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql src/config/env.js .env.example test/unit/db.test.js test/unit/env.test.js
git commit -m "feat: jobs/freigaben schema and job-related config (jobsDir, downloadSigningSecret)"
```

---

### Task 2: Signed download URL service

**Files:**
- Create: `src/services/downloadUrl.js`
- Test: `test/unit/downloadUrl.test.js`

**Interfaces:**
- Consumes: nothing (pure function, only needs `config.downloadSigningSecret`).
- Produces: `buildSignedDownloadUrl(config, jobId, ttlSeconds)` → `string` (a `/downloads/:jobId?expires=...&signature=...` path). `verifySignedDownload(config, jobId, expires, signature)` → `boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/downloadUrl.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedDownloadUrl, verifySignedDownload } from '../../src/services/downloadUrl.js';

function testConfig() {
  return { downloadSigningSecret: 'test-signing-secret' };
}

function parseUrl(url) {
  const [, query] = url.split('?');
  const params = new URLSearchParams(query);
  return { expires: params.get('expires'), signature: params.get('signature') };
}

test('buildSignedDownloadUrl produces a path containing the job id, an expiry and a 64-char hex signature', () => {
  const url = buildSignedDownloadUrl(testConfig(), 42, 900);
  assert.match(url, /^\/downloads\/42\?/);
  const { expires, signature } = parseUrl(url);
  assert.ok(Number(expires) > Math.floor(Date.now() / 1000));
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test('verifySignedDownload accepts a freshly built, unexpired URL', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, signature), true);
});

test('verifySignedDownload rejects an expired URL even with a correct signature', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, -10);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, signature), false);
});

test('verifySignedDownload rejects a tampered signature', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 42, expires, 'a'.repeat(64)), false);
});

test('verifySignedDownload rejects a signature built for a different job id', () => {
  const config = testConfig();
  const url = buildSignedDownloadUrl(config, 42, 900);
  const { expires, signature } = parseUrl(url);
  assert.equal(verifySignedDownload(config, 99, expires, signature), false);
});

test('verifySignedDownload rejects a missing or malformed signature without throwing', () => {
  const config = testConfig();
  assert.equal(verifySignedDownload(config, 42, String(Math.floor(Date.now() / 1000) + 900), undefined), false);
  assert.equal(verifySignedDownload(config, 42, String(Math.floor(Date.now() / 1000) + 900), 'not-hex!!'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/downloadUrl.test.js`
Expected: FAIL — `src/services/downloadUrl.js` does not exist yet.

- [ ] **Step 3: Implement `src/services/downloadUrl.js`**

```js
import crypto from 'node:crypto';

function sign(secret, jobId, expires) {
  return crypto.createHmac('sha256', secret).update(`${jobId}.${expires}`).digest('hex');
}

export function buildSignedDownloadUrl(config, jobId, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(config.downloadSigningSecret, jobId, expires);
  return `/downloads/${jobId}?expires=${expires}&signature=${signature}`;
}

export function verifySignedDownload(config, jobId, expires, signature) {
  const expiresNum = Number(expires);
  if (!Number.isInteger(expiresNum)) return false;
  if (Math.floor(Date.now() / 1000) > expiresNum) return false;

  const expected = sign(config.downloadSigningSecret, jobId, expiresNum);
  let providedBuf;
  let expectedBuf;
  try {
    providedBuf = Buffer.from(String(signature ?? ''), 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/downloadUrl.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/downloadUrl.js test/unit/downloadUrl.test.js
git commit -m "feat: HMAC-signed, short-lived PDF download URL service"
```

---

### Task 3: jobsRepo.js — Zuweisungsregel matching, job creation, pool, atomic claim

**Files:**
- Create: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `getKontoById` (Phase B, `src/db/kontenRepo.js`); `listZuweisungsregeln` (Phase B, `src/db/zuweisungsregelnRepo.js`); `openDatabase` (Phase A).
- Produces: `findMatchingZuweisungsregel(db, absender)` → row or `null`. `createJob(db, { eingangAm, quelle, absender, dateiname, pdfPfad })` → `number` (new id). `getJobById(db, id)` → row or `null`. `listPoolJobs(db)` → `array` (only `status = 'unzugewiesen'`). `claimJob(db, id, personId)` → `boolean` (true iff the row was actually claimed).

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/jobsRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto, deactivateKonto } from '../../src/db/kontenRepo.js';
import { createZuweisungsregel } from '../../src/db/zuweisungsregelnRepo.js';
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob } from '../../src/db/jobsRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('findMatchingZuweisungsregel: exact email address matches', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', kontoId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern matches a subdomain sender', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@sub.lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('findMatchingZuweisungsregel: domain pattern does not match an unrelated domain sharing a suffix', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.equal(findMatchingZuweisungsregel(db, 'rechnungen@notlieferant.ch'), null);
  db.close();
});

test('findMatchingZuweisungsregel: exact address wins over a domain rule that would also match', () => {
  const db = openDatabase(':memory:');
  const kontoId1 = seedKonto(db);
  upsertPerson(db, { id: '5', vorname: 'P5', nachname: 'Muster', email: 'p5@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '6', vorname: 'P6', nachname: 'Muster', email: 'p6@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId2 = createKonto(db, { kontonummer: '3001', bezeichnung: 'Spezial', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '1', stellvertreter2Id: '2' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId: kontoId1 });
  createZuweisungsregel(db, { absenderMuster: 'rechnungen@lieferant.ch', kontoId: kontoId2 });
  const regel = findMatchingZuweisungsregel(db, 'rechnungen@lieferant.ch');
  assert.equal(regel.konto_id, kontoId2);
  db.close();
});

test('findMatchingZuweisungsregel: returns null without a sender or without any match', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  assert.equal(findMatchingZuweisungsregel(db, null), null);
  assert.equal(findMatchingZuweisungsregel(db, 'unbekannt@anderswo.ch'), null);
  db.close();
});

test('createJob auto-assigns via a matching Zuweisungsregel', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/x.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  assert.equal(job.zugewiesen_an, '1');
  db.close();
});

test('createJob leaves a job unzugewiesen when no Zuweisungsregel matches', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'scan.pdf', pdfPfad: '/tmp/y.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  assert.equal(job.zugewiesen_an, null);
  db.close();
});

test('createJob falls back to the pool when the matched Konto is inactive', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  deactivateKonto(db, kontoId);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'rechnung.pdf', pdfPfad: '/tmp/z.pdf' });
  const job = getJobById(db, id);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.konto_id, null);
  db.close();
});

test('getJobById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getJobById(db, 999), null);
  db.close();
});

test('listPoolJobs returns only unzugewiesen jobs', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const poolId = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: 'rechnungen@lieferant.ch', dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  const jobs = listPoolJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, poolId);
  db.close();
});

test('claimJob atomically assigns an unzugewiesen job and rejects a second claim', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const firstClaim = claimJob(db, id, '1');
  const secondClaim = claimJob(db, id, '2');
  assert.equal(firstClaim, true);
  assert.equal(secondClaim, false);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `src/db/jobsRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/jobsRepo.js`**

```js
import { getKontoById } from './kontenRepo.js';
import { listZuweisungsregeln } from './zuweisungsregelnRepo.js';

function extractDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

export function findMatchingZuweisungsregel(db, absender) {
  if (!absender) return null;
  const absenderLower = absender.toLowerCase();
  const domain = extractDomain(absenderLower);
  const regeln = listZuweisungsregeln(db);

  const exactMatch = regeln.find((r) => r.absender_muster.toLowerCase() === absenderLower);
  if (exactMatch) return exactMatch;

  if (domain) {
    const domainMatch = regeln.find((r) => {
      const muster = r.absender_muster.toLowerCase();
      if (muster.includes('@')) return false;
      return domain === muster || domain.endsWith(`.${muster}`);
    });
    if (domainMatch) return domainMatch;
  }

  return null;
}

export function createJob(db, { eingangAm, quelle, absender, dateiname, pdfPfad }) {
  const regel = findMatchingZuweisungsregel(db, absender);
  let kontoId = null;
  let zugewiesenAn = null;
  let status = 'unzugewiesen';

  if (regel) {
    const konto = getKontoById(db, regel.konto_id);
    if (konto && konto.aktiv) {
      kontoId = konto.id;
      zugewiesenAn = konto.freigeber1_id;
      status = 'zugewiesen';
    }
  }

  const result = db
    .prepare(
      `INSERT INTO jobs (eingang_am, quelle, absender, dateiname, pdf_pfad, status, konto_id, zugewiesen_an)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eingangAm, quelle, absender ?? null, dateiname, pdfPfad, status, kontoId, zugewiesenAn);

  return Number(result.lastInsertRowid);
}

export function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function listPoolJobs(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'unzugewiesen' ORDER BY eingang_am").all();
}

export function claimJob(db, id, personId) {
  const result = db
    .prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = ? WHERE id = ? AND status = 'unzugewiesen'")
    .run(personId, id);
  return result.changes > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: job creation with Zuweisungsregel auto-matching, pool listing, atomic claim"
```

---

### Task 4: jobsRepo.js — two-phase pickup (abholbereit / confirmAbholung)

**Files:**
- Modify: `src/db/jobsRepo.js` — append `listAbholbereitJobs`, `confirmAbholung`
- Modify: `test/unit/jobsRepo.test.js` — append their tests

**Interfaces:**
- Consumes: `getJobById` (Task 3, same file).
- Produces: `listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000)` → `array` of jobs with `status = 'abgeschlossen'` whose claim is absent or stale; marks each returned row's `fetched_by_n8n_at` to now as a side effect. `confirmAbholung(db, id)` → the updated job (`status: 'abgeholt'`) or `null` if the job isn't currently `abgeschlossen`.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/jobsRepo.test.js`

```js
function seedAbgeschlossenJob(db) {
  const kontoId = seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen', konto_id = ? WHERE id = ?").run(kontoId, id);
  return id;
}

test('listAbholbereitJobs returns an unclaimed abgeschlossen job and marks it claimed', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const jobs = listAbholbereitJobs(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.ok(jobs[0].fetched_by_n8n_at);
  const stored = getJobById(db, id);
  assert.ok(stored.fetched_by_n8n_at);
  db.close();
});

test('listAbholbereitJobs does not re-offer a job claimed within the stale window', () => {
  const db = openDatabase(':memory:');
  seedAbgeschlossenJob(db);
  listAbholbereitJobs(db);
  const secondCall = listAbholbereitJobs(db);
  assert.equal(secondCall.length, 0);
  db.close();
});

test('listAbholbereitJobs re-offers a job whose claim is older than staleAfterMs', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const oldTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(oldTimestamp, id);
  const jobs = listAbholbereitJobs(db, 15 * 60 * 1000);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  db.close();
});

test('listAbholbereitJobs ignores jobs that are not abgeschlossen', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(listAbholbereitJobs(db).length, 0);
  db.close();
});

test('confirmAbholung marks an abgeschlossen job abgeholt and returns it', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  const job = confirmAbholung(db, id);
  assert.equal(job.status, 'abgeholt');
  assert.equal(getJobById(db, id).status, 'abgeholt');
  db.close();
});

test('confirmAbholung returns null for a job that is not abgeschlossen', () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(confirmAbholung(db, id), null);
  db.close();
});

test('confirmAbholung returns null on a second confirmation attempt', () => {
  const db = openDatabase(':memory:');
  const id = seedAbgeschlossenJob(db);
  confirmAbholung(db, id);
  assert.equal(confirmAbholung(db, id), null);
  db.close();
});
```

Also add `listAbholbereitJobs, confirmAbholung` to the `import { ... } from '../../src/db/jobsRepo.js'` line at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `listAbholbereitJobs`/`confirmAbholung` are not exported yet.

- [ ] **Step 3: Append to `src/db/jobsRepo.js`**

```js
// listAbholbereitJobs runs entirely synchronously (node:sqlite has no async I/O), so the
// SELECT and the per-row claim UPDATE below cannot interleave with any other request in this
// single Node process — safe without an explicit transaction. This would need one under a
// multi-process deployment.
export function listAbholbereitJobs(db, staleAfterMs = 15 * 60 * 1000) {
  const staleThreshold = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'abgeschlossen'
       AND (fetched_by_n8n_at IS NULL OR fetched_by_n8n_at < ?)`
    )
    .all(staleThreshold);

  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare('UPDATE jobs SET fetched_by_n8n_at = ? WHERE id = ?').run(now, row.id);
    row.fetched_by_n8n_at = now;
  }
  return rows;
}

export function confirmAbholung(db, id) {
  const job = getJobById(db, id);
  if (!job || job.status !== 'abgeschlossen') {
    return null;
  }
  db.prepare("UPDATE jobs SET status = 'abgeholt' WHERE id = ?").run(id);
  return { ...job, status: 'abgeholt' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS (18 tests)

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: two-phase job pickup (listAbholbereitJobs claim + confirmAbholung)"
```

---

### Task 5: n8n job-creation endpoint

**Files:**
- Create: `src/routes/n8n/jobs.js`
- Modify: `src/app.js` — mount `/api/n8n/jobs` behind `requireApiKey(config)`
- Test: `test/integration/n8n/jobs.test.js`

**Interfaces:**
- Consumes: `createJob`, `getJobById` (Task 3); `requireApiKey(config)` (Phase A, `src/middleware/apiKey.js`).
- Produces: `createN8nJobsRouter({ db, config })` → Router with `POST /`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/n8n/jobs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { getJobById } from '../../../src/db/jobsRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nJobsRouter } from '../../../src/routes/n8n/jobs.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%test-fixture-not-a-real-pdf-body\n');

function buildTestApp(db, config) {
  const app = express();
  app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
  return app;
}

function testConfig(jobsDir) {
  return { n8nApiKey: 'n8n-key', jobsDir };
}

test('POST /api/n8n/jobs without a valid API key returns 401 and creates nothing', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 401);
  db.close();
});

test('POST /api/n8n/jobs with a valid PDF and API key creates a job', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'unzugewiesen');
  const job = getJobById(db, res.body.id);
  assert.equal(job.dateiname, 'scan.pdf');
  assert.equal(job.quelle, 'scanner');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects a file that is not a real PDF, creates nothing', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'scanner')
    .field('dateiname', 'fake.pdf')
    .attach('pdf', Buffer.from('not a pdf'), { filename: 'fake.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  assert.equal(readdirSync(jobsDir).length, 0);
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs rejects an invalid quelle value', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'irgendwas')
    .field('dateiname', 'scan.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'scan.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 400);
  db.close();
});

test('POST /api/n8n/jobs applies Zuweisungsregel matching and reports the resulting status', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { upsertPerson } = await import('../../../src/db/personenRepo.js');
  const { createKonto } = await import('../../../src/db/kontenRepo.js');
  const { createZuweisungsregel } = await import('../../../src/db/zuweisungsregelnRepo.js');

  const db = openDatabase(':memory:');
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });

  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const res = await request(app)
    .post('/api/n8n/jobs')
    .set('X-API-Key', 'n8n-key')
    .field('quelle', 'lieferant')
    .field('absender', 'rechnungen@lieferant.ch')
    .field('dateiname', 'rechnung.pdf')
    .attach('pdf', PDF_BYTES, { filename: 'rechnung.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'zugewiesen');
  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — `src/routes/n8n/jobs.js` does not exist yet.

- [ ] **Step 3: Create `src/routes/n8n/jobs.js`**

```js
import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createJob, getJobById } from '../../db/jobsRepo.js';

const MAX_PDF_SIZE = 20 * 1024 * 1024;
const VALID_QUELLEN = new Set(['scanner', 'lieferant']);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_SIZE } });

function isPdf(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

export function createN8nJobsRouter({ db, config }) {
  const router = Router();

  router.post('/', (req, res) => {
    upload.single('pdf')(req, res, (uploadErr) => {
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
      const job = getJobById(db, id);
      res.status(201).json({ id: job.id, status: job.status });
    });
  });

  return router;
}
```

- [ ] **Step 4: Modify `src/app.js`** — add imports and mount, alongside the other `/api`-style routes (after the `/admin/*` mounts, before `/auth`)

```js
import { requireApiKey } from './middleware/apiKey.js';
import { createN8nJobsRouter } from './routes/n8n/jobs.js';
// ...
app.use('/api/n8n/jobs', requireApiKey(config), createN8nJobsRouter({ db, config }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/n8n/jobs.js src/app.js test/integration/n8n/jobs.test.js
git commit -m "feat: n8n job-creation endpoint with PDF magic-bytes validation and Zuweisungsregel matching"
```

---

### Task 6: n8n two-phase pickup endpoints

**Files:**
- Modify: `src/routes/n8n/jobs.js` — append `GET /abholbereit`, `POST /:id/abholung-bestaetigen`
- Modify: `test/integration/n8n/jobs.test.js` — append their tests

**Interfaces:**
- Consumes: `listAbholbereitJobs`, `confirmAbholung` (Task 4); `buildSignedDownloadUrl` (Task 2).
- Produces: `GET /abholbereit` (mounted at `/api/n8n/jobs/abholbereit`) → JSON array of `{ id, eingang_am, quelle, absender, dateiname, konto_id, download_url }`. `POST /:id/abholung-bestaetigen` → `{ id, status: 'abgeholt' }` on success, 409 otherwise.

- [ ] **Step 1: Modify `testConfig` at the top of `test/integration/n8n/jobs.test.js`** to always
  include a signing secret (needed by the new endpoints below):

```js
function testConfig(jobsDir) {
  return { n8nApiKey: 'n8n-key', jobsDir, downloadSigningSecret: 'test-secret' };
}
```

- [ ] **Step 2: Write the failing tests** — add these two static imports at the top of
  `test/integration/n8n/jobs.test.js`, alongside the existing imports (this file is ESM —
  `"type": "module"` in `package.json` — so `require` is never used here):

```js
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
```

Then append the following helper and tests to the file:

```js
function seedAbgeschlossenJobWithFile(db, jobsDir) {
  const pdfPfad = join(jobsDir, `seed-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, PDF_BYTES);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'lieferant', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(id);
  return { id, pdfPfad };
}

test('GET /api/n8n/jobs/abholbereit without a valid API key returns 401', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));
  const res = await request(app).get('/api/n8n/jobs/abholbereit');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /api/n8n/jobs/abholbereit returns an abgeschlossen job with a signed download URL, then omits it on an immediate second call', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const { id } = seedAbgeschlossenJobWithFile(db, jobsDir);

  const firstRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.length, 1);
  assert.equal(firstRes.body[0].id, id);
  assert.match(firstRes.body[0].download_url, /^\/downloads\/\d+\?expires=\d+&signature=[0-9a-f]{64}$/);

  const secondRes = await request(app).get('/api/n8n/jobs/abholbereit').set('X-API-Key', 'n8n-key');
  assert.equal(secondRes.body.length, 0);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs/:id/abholung-bestaetigen confirms pickup, deletes the file, and rejects a second confirmation', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const db = openDatabase(':memory:');
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-test-'));
  const app = buildTestApp(db, testConfig(jobsDir));

  const { id, pdfPfad } = seedAbgeschlossenJobWithFile(db, jobsDir);
  assert.ok(existsSync(pdfPfad));

  const firstRes = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.status, 'abgeholt');
  assert.equal(existsSync(pdfPfad), false);

  const secondRes = await request(app).post(`/api/n8n/jobs/${id}/abholung-bestaetigen`).set('X-API-Key', 'n8n-key');
  assert.equal(secondRes.status, 409);

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: FAIL — `GET /abholbereit` and `POST /:id/abholung-bestaetigen` don't exist on the router yet.

- [ ] **Step 4: Append to `src/routes/n8n/jobs.js`**

```js
import { unlinkSync, existsSync } from 'node:fs';
import { createJob, getJobById, listAbholbereitJobs, confirmAbholung } from '../../db/jobsRepo.js';
import { buildSignedDownloadUrl } from '../../services/downloadUrl.js';

const ABHOLEN_TTL_SECONDS = 15 * 60;
```

(Replace the Task 5 import line `import { createJob, getJobById } from '../../db/jobsRepo.js';`
with the combined one above — do not have two import lines for the same module.)

Then, inside `createN8nJobsRouter`, after the existing `router.post('/', ...)` block and before
`return router;`:

```js
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
    res.json({ id: job.id, status: job.status });
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/n8n/jobs.test.js`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/n8n/jobs.js test/integration/n8n/jobs.test.js
git commit -m "feat: n8n two-phase pickup endpoints (abholbereit claim, abholung-bestaetigen confirm)"
```

---

### Task 7: Human pool endpoints

**Files:**
- Create: `src/routes/pool.js`
- Modify: `src/app.js` — mount `/api/pool` behind `requireRole(config, 'buchhaltung')`
- Test: `test/integration/pool.test.js`

**Interfaces:**
- Consumes: `listPoolJobs`, `claimJob` (Task 3); `requireRole(config, role)`, `loadCurrentPerson(db)` (Phase A).
- Produces: `createPoolRouter({ db })` → Router with `GET /`, `POST /:id/beanspruchen`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/pool.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { createPoolRouter } from '../../src/routes/pool.js';

function buildTestApp(db) {
  const app = express();
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/api/pool', requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
  return app;
}

function seedBuchhaltungPerson(db) {
  upsertPerson(db, { id: '50', vorname: 'Buch', nachname: 'Halter', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
}

const POOL_ROUTES = [
  { method: 'get', path: '/api/pool' },
  { method: 'post', path: '/api/pool/1/beanspruchen' },
];

test('every pool route returns 401 without any session', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  for (const { method, path } of POOL_ROUTES) {
    const res = await request(app)[method](path);
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  db.close();
});

test('every pool route returns 403 for a logged-in person without the buchhaltung group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Admin', nachname: 'Only', email: 'a@example.org', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of POOL_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77');
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 without the buchhaltung group`);
  }
  db.close();
});

test('GET /api/pool lists only unzugewiesen jobs', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).get('/api/pool').set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, id);
  db.close();
});

test('POST /api/pool/:id/beanspruchen claims the job for the requesting person', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const res = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '50');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'zugewiesen');
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  assert.equal(row.zugewiesen_an, '50');
  db.close();
});

test('a second beanspruchen attempt on the same job returns 409', async () => {
  const db = openDatabase(':memory:');
  seedBuchhaltungPerson(db);
  upsertPerson(db, { id: '51', vorname: 'Zweite', nachname: 'Person', email: 'z@example.org', gruppen: ['10'], loggedInNow: true });
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  const app = buildTestApp(db);
  const firstRes = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '50');
  const secondRes = await request(app).post(`/api/pool/${id}/beanspruchen`).set('x-test-person-id', '51');
  assert.equal(firstRes.status, 200);
  assert.equal(secondRes.status, 409);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/pool.test.js`
Expected: FAIL — `src/routes/pool.js` does not exist yet.

- [ ] **Step 3: Create `src/routes/pool.js`**

```js
import { Router } from 'express';
import { listPoolJobs, claimJob } from '../db/jobsRepo.js';

export function createPoolRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(listPoolJobs(db));
  });

  router.post('/:id/beanspruchen', (req, res) => {
    const claimed = claimJob(db, Number(req.params.id), req.currentPerson.churchtools_person_id);
    if (!claimed) {
      return res.status(409).json({ error: 'Job ist nicht mehr im Pool verfügbar.' });
    }
    res.json({ id: Number(req.params.id), status: 'zugewiesen' });
  });

  return router;
}
```

- [ ] **Step 4: Modify `src/app.js`** — add imports and mount, alongside the other `/api` mounts

```js
import { createPoolRouter } from './routes/pool.js';
// ...
app.use('/api/pool', requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/pool.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/pool.js src/app.js test/integration/pool.test.js
git commit -m "feat: human pool endpoints (list + atomic beanspruchen)"
```

---

### Task 8: Signed download route

**Files:**
- Create: `src/routes/downloads.js`
- Modify: `src/app.js` — mount `/downloads` (no auth middleware — signature-only)
- Test: `test/integration/downloads.test.js`

**Interfaces:**
- Consumes: `getJobById` (Task 3); `verifySignedDownload`, `buildSignedDownloadUrl` (Task 2).
- Produces: `createDownloadsRouter({ db, config })` → Router with `GET /:jobId`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/downloads.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { buildSignedDownloadUrl } from '../../src/services/downloadUrl.js';
import { createDownloadsRouter } from '../../src/routes/downloads.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%test-fixture\n');

function buildTestApp(db, config) {
  const app = express();
  app.use('/downloads', createDownloadsRouter({ db, config }));
  return app;
}

function testConfig() {
  return { downloadSigningSecret: 'test-secret' };
}

function seedJobWithFile(db, dir) {
  const pdfPfad = join(dir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(pdfPfad, PDF_BYTES);
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  return { id, pdfPfad };
}

test('a valid, unexpired signed URL serves the PDF bytes', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const url = buildSignedDownloadUrl(config, id, 900);
  const res = await request(app).get(url);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.ok(Buffer.from(res.body).equals(PDF_BYTES) || res.text === PDF_BYTES.toString());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an expired signed URL returns 403', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const url = buildSignedDownloadUrl(config, id, -10);
  const res = await request(app).get(url);
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a tampered signature returns 403 with the same message as an expired link', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const { id } = seedJobWithFile(db, dir);
  const app = buildTestApp(db, config);

  const expiredRes = await request(app).get(buildSignedDownloadUrl(config, id, -10));
  const tamperedRes = await request(app).get(`/downloads/${id}?expires=${Math.floor(Date.now() / 1000) + 900}&signature=${'a'.repeat(64)}`);

  assert.equal(tamperedRes.status, 403);
  assert.deepEqual(tamperedRes.body, expiredRes.body);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid signature for a job whose file no longer exists returns the same generic 403', async () => {
  const db = openDatabase(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'downloads-test-'));
  const config = testConfig();
  const id = createJob(db, { eingangAm: '2026-08-14T10:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: join(dir, 'does-not-exist.pdf') });
  const app = buildTestApp(db, config);

  const res = await request(app).get(buildSignedDownloadUrl(config, id, 900));
  assert.equal(res.status, 403);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/downloads.test.js`
Expected: FAIL — `src/routes/downloads.js` does not exist yet.

- [ ] **Step 3: Create `src/routes/downloads.js`**

```js
import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { getJobById } from '../db/jobsRepo.js';
import { verifySignedDownload } from '../services/downloadUrl.js';

const GENERIC_DENIAL = { error: 'Link ungültig oder abgelaufen.' };

export function createDownloadsRouter({ db, config }) {
  const router = Router();

  router.get('/:jobId', (req, res) => {
    const jobId = Number(req.params.jobId);
    const { expires, signature } = req.query;

    if (!verifySignedDownload(config, jobId, expires, signature)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    const job = getJobById(db, jobId);
    if (!job || !existsSync(job.pdf_pfad)) {
      return res.status(403).json(GENERIC_DENIAL);
    }

    res.type('application/pdf');
    createReadStream(job.pdf_pfad).pipe(res);
  });

  return router;
}
```

- [ ] **Step 4: Modify `src/app.js`** — add import and mount (no auth middleware; place near the other `/api`/`/downloads`-style mounts)

```js
import { createDownloadsRouter } from './routes/downloads.js';
// ...
app.use('/downloads', createDownloadsRouter({ db, config }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/downloads.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/downloads.js src/app.js test/integration/downloads.test.js
git commit -m "feat: signed, short-lived PDF download route"
```
