# Sub-Phase E2, Batch 4 – Autorisierungsmodell-Entscheidung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Buchhaltung/Portal-Admin group gate from `/kontierung`, `/freigabe2`, and `/abgelehnt` (relying on the existing per-job assignment checks instead), and fix a related bug where a Stellvertreter1's declared conflict of interest doesn't survive a Freigabe-2 rejection and rework cycle.

**Architecture:** A new `requireLogin()` middleware replaces the group-based mount gate on the three routes. `abschliessenFreigabe1` stops clearing the SYNC-8 admin-exclusion flag on completion, so it persists for the life of the job. `ablehnung.js` becomes flag-aware like its sibling routes, and the rejection notification + the assignee's own job list both route correctly once the flag is set.

**Tech Stack:** Node.js, Express, `node:sqlite` (synchronous, FK constraints enforced), EJS views, `node:test` + `supertest` for tests (`npm test` runs `node --test 'test/**/*.test.js'`).

**Spec:** docs/superpowers/specs/2026-08-16-e2-batch4-authz-modell-design.md

## Global Constraints

- No migration system exists — `schema.sql` is edited directly (not relevant to this batch: no schema changes).
- `node:sqlite`'s FK constraints are actively enforced — every `createKonto`/`createJob`/`createFreigabe` call in tests needs its referenced `personen` rows to already exist via `upsertPerson`.
- EJS views: `<%- %>` only for trusted includes, `<%= %>` for all real data (not relevant to this batch: no view changes).
- All new/changed authorization logic must be covered by both a positive test (the intended actor succeeds) and a negative test (an excluded actor is rejected) — matches this codebase's existing convention throughout `kontierung.test.js`/`freigabe2.test.js`/`ablehnung.test.js`.
- German-language strings throughout (route messages, email subjects/bodies) — match the existing tone exactly when copying patterns from `kontierung.js`/`freigabe2.js`.

---

### Task 1: `requireLogin()` middleware

**Files:**
- Modify: `src/middleware/roles.js`
- Test: `test/unit/roles.test.js`

**Interfaces:**
- Produces: `requireLogin()` — Express middleware factory, no parameters. Returns `(req, res, next)`. Behavior: if `req.currentPerson` is missing or `!aktiv`, responds `401` rendering `error` with `{ message: 'Bitte melde dich an, um fortzufahren.' }` (identical message to `requireRole`/`requireAnyRole`'s own 401). Otherwise calls `next()` unconditionally — no group check of any kind.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `test/unit/roles.test.js` (after the existing `requireAnyRole` tests, which end at line 111):

```javascript
function runRequireLogin(db, personId) {
  return new Promise((resolve) => {
    const req = { session: { personId }, currentPerson: null };
    const res = {
      locals: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      render(view, locals) {
        resolve({ statusCode: this.statusCode, view, locals });
      },
    };
    loadCurrentPerson(db)(req, res, () => {
      requireLogin()(req, res, () => resolve({ statusCode: 200, next: true }));
    });
  });
}

test('requireLogin allows a logged-in active person with no group memberships at all', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: false });
  const result = await runRequireLogin(db, '1');
  assert.equal(result.next, true);
  db.close();
});

test('requireLogin returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const result = await runRequireLogin(db, undefined);
  assert.equal(result.statusCode, 401);
  db.close();
});

test('requireLogin returns 401 for a deactivated person', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const result = await runRequireLogin(db, '1');
  assert.equal(result.statusCode, 401);
  db.close();
});
```

Also update the import line at the top of the file (line 5) from:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole } from '../../src/middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from '../../src/middleware/roles.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="requireLogin"`
Expected: FAIL with `requireLogin is not a function` (or a `ReferenceError`/`TypeError`, since the import resolves to `undefined`).

- [ ] **Step 3: Implement `requireLogin()`**

Add to `src/middleware/roles.js`, after `requireAnyRole` (the file currently ends at line 55):

```javascript
export function requireLogin() {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="requireLogin"`
Expected: PASS (3 new tests), plus the full `roles.test.js` file still green (`npm test test/unit/roles.test.js` if your runner supports a path filter, or just `npm test` for the whole suite).

- [ ] **Step 5: Commit**

```bash
git add src/middleware/roles.js test/unit/roles.test.js
git commit -m "feat: add requireLogin middleware (session + active person only, no group check)"
```

---

### Task 2: AUTHZ-3 — remove the group gate from `/kontierung`, `/freigabe2`, `/abgelehnt`

**Files:**
- Modify: `src/app.js`
- Modify: `test/integration/kontierung.test.js`
- Modify: `test/integration/freigabe2.test.js`
- Modify: `test/integration/ablehnung.test.js`
- Modify: `test/integration/app.test.js`

**Interfaces:**
- Consumes: `requireLogin()` from Task 1 (`src/middleware/roles.js`).
- Produces: nothing new for later tasks — this task only changes which middleware gates the three mounts, not any route's own logic.

- [ ] **Step 1: Write the failing tests**

In `test/integration/kontierung.test.js`, add this test after the existing `seedKontoAndPersonen` helper (around line 88, before the first `test(...)` block):

```javascript
test('GET /kontierung/:id is reachable for the assigned person with no group membership at all', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Frei', nachname: 'Geber', email: 'frei@example.org', gruppen: [], loggedInNow: true });
  for (const id of ['2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, id, '1');
  const app = buildTestApp(db, createStubMailer());
  const res = await request(app).get(`/kontierung/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});
```

`claimJob` and `createKonto` are already imported in this file (lines 7-8). This test will fail (403) until Step 3 rewires `buildTestApp`.

In `test/integration/freigabe2.test.js`, add this test after `seedFreigabe2Job` (around line 106, before the first `test(...)` block):

```javascript
test('GET /freigabe2/:id is reachable for the effective freigeber2 with no group membership at all', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2Job(db, { pdfPfad: '/tmp/a.pdf' });
  upsertPerson(db, { id: '3', vorname: 'Person3', nachname: 'Muster', email: 'p3@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get(`/freigabe2/${id}`).set('x-test-person-id', '3');
  assert.equal(res.status, 200);
  db.close();
});
```

In `test/integration/ablehnung.test.js`, add this test after `seedAbgelehntJob` (around line 54, before the first `test(...)` block):

```javascript
test('GET /abgelehnt/:id is reachable for zugewiesen_an with no group membership at all', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJob(db);
  upsertPerson(db, { id: '1', vorname: 'Person1', nachname: 'Muster', email: 'p1@example.org', gruppen: [], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});
```

In `test/integration/app.test.js`, add these imports after the existing ones (after line 6):

```javascript
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, claimJob } from '../../src/db/jobsRepo.js';
```

Then add this test after the `'GET /pool returns 200 for a Portal-Admin...'` test (after line 193, before the `'Phase C routes are gated exactly as wired in the real app'` test):

```javascript
test('GET /kontierung/:id is reachable through the real app for the assigned person, even without Buchhaltung or Portal-Admin group membership', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 5, firstName: 'Frei', lastName: 'Geber', email: 'frei@example.org' } });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  for (const id of ['5', '6', '7']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '6' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '5');

  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get(`/kontierung/${jobId}`);
  assert.equal(res.status, 200);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the 4 new tests FAIL with `403` (kontierung/freigabe2/ablehnung standalone tests, since `buildTestApp` still mounts the old `requireRole(config, 'buchhaltung')`) or `401`/`403` (the app.test.js test, since `app.js` still mounts `requireAnyRole`). All other tests still pass.

- [ ] **Step 3: Wire `requireLogin()` into the three mounts and update the test harnesses**

In `src/app.js`, change the import line (around line 11) from:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole } from './middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
```

Then change lines 108-110 from:

```javascript
  app.use('/kontierung', sessionLimiter, requireAnyRole(config, ['buchhaltung', 'portal-admin']), createKontierungRouter({ db, config, mailer }));
  app.use('/freigabe2', sessionLimiter, requireAnyRole(config, ['buchhaltung', 'portal-admin']), createFreigabe2Router({ db, config, mailer }));
  app.use('/abgelehnt', sessionLimiter, requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));
```

to:

```javascript
  app.use('/kontierung', sessionLimiter, requireLogin(), createKontierungRouter({ db, config, mailer }));
  app.use('/freigabe2', sessionLimiter, requireLogin(), createFreigabe2Router({ db, config, mailer }));
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db }));
```

(`/pool` and `/api/pool`, the two lines directly above, are untouched — they keep `requireAnyRole`/`requireRole` per the spec.)

In `test/integration/kontierung.test.js`, change the import on line 10 from:

```javascript
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
```

Change line 79 from:

```javascript
  app.use('/kontierung', requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config, mailer }));
```

to:

```javascript
  app.use('/kontierung', requireLogin(), createKontierungRouter({ db, config, mailer }));
```

Update the stale comment above `buildTestApp` (lines 20-22) from:

```javascript
// Full-app helpers (matching freigabeWorkflowEndToEnd.test.js conventions) — used by the SYNC-8
// tests below, which need the real /auth login flow so a Portal-Admin (not necessarily in
// Buchhaltung) can reach the route via requireAnyRole at the HTTP gate.
```

to:

```javascript
// Full-app helpers (matching freigabeWorkflowEndToEnd.test.js conventions) — used by the SYNC-8
// tests below, which need the real /auth login flow so a Portal-Admin (verified via group
// membership inside the route's own per-job authorization) can reach an admin-escalated job.
```

In `test/integration/freigabe2.test.js`, apply the identical three edits: import on line 11 (`requireRole` → `requireLogin`), the mount on line 82 (`requireRole(config, 'buchhaltung')` → `requireLogin()`), and the same comment wording fix on lines 23-25.

In `test/integration/ablehnung.test.js`, change the import on line 10 from:

```javascript
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
```

Change line 28 from:

```javascript
  app.use('/abgelehnt', requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));
```

to:

```javascript
  app.use('/abgelehnt', requireLogin(), createAblehnungRouter({ db }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app.js test/integration/kontierung.test.js test/integration/freigabe2.test.js test/integration/ablehnung.test.js test/integration/app.test.js
git commit -m "fix(authz): drop Buchhaltung/Portal-Admin group gate from /kontierung, /freigabe2, /abgelehnt (AUTHZ-3)"
```

---

### Task 3: `abschliessenFreigabe1` stops clearing the admin-exclusion flag

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon, grund })`, `abschliessenFreigabe1(db, jobId)`, `getJobById(db, id)` — all pre-existing, unchanged signatures.
- Produces: `abschliessenFreigabe1`'s behavior change — `jobs.freigabe1_eskaliert_an_admin` is no longer reset to `0` by this function. Later tasks (4, 5, 6) rely on this: a job that was ever escalated stays flagged for the rest of its life unless `releaseJob`/`forceReleaseJob` fully resets it.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, after the existing `'listAbgelehntJobsForPerson returns only abgelehnt jobs assigned to that person'` test (ends around line 611):

```javascript
test('abschliessenFreigabe1 leaves freigabe1_eskaliert_an_admin set when it was already 1 (the exclusion survives Freigabe 1 completing)', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });

  abschliessenFreigabe1(db, jobId);

  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe1_eskaliert_von, null, 'the named-person escalation record is still cleared — only the admin-exclusion flag must survive');
  assert.equal(job.freigabe1_eskaliert_an_admin, 1, 'the conflict-of-interest exclusion must survive Freigabe 1 completing, so a later reject+rework cycle stays admin-gated');
  db.close();
});

test('abschliessenFreigabe1 leaves freigabe1_eskaliert_an_admin at 0 for a normal (non-escalated) completion', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  abschliessenFreigabe1(db, jobId);

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 0);
  db.close();
});
```

`eskalierenFreigabe1AnAdmin` and `abschliessenFreigabe1` are already imported at the top of this file (line 7).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="abschliessenFreigabe1 leaves"`
Expected: the first new test FAILS — `job.freigabe1_eskaliert_an_admin` is `0`, not `1`, because the current code still clears it.

- [ ] **Step 3: Implement the fix**

In `src/db/jobsRepo.js`, change `abschliessenFreigabe1` (currently lines 150-160) from:

```javascript
export function abschliessenFreigabe1(db, jobId) {
  // Also clears freigabe1_eskaliert_an_admin: this is the one place Freigabe 1 legitimately
  // completes (regardless of whether an admin or a regular person did it), so it's the correct
  // single source to reset the admin-only authorization gate (see loadAuthorizedJob in
  // kontierung.js). Without this, a job that was ever escalated to admin would stay locked to
  // Portal-Admin-only access permanently, even across later, unrelated rework cycles after
  // wiederOeffnenJob re-enters status='zugewiesen'.
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0 WHERE id = ?"
  ).run(jobId);
}
```

to:

```javascript
export function abschliessenFreigabe1(db, jobId) {
  // freigabe1_eskaliert_an_admin is deliberately NOT reset here (Batch 4 correction — an
  // earlier version of this function did clear it). A declared conflict of interest belongs to
  // the invoice, not to one Kontierung attempt: if Freigabe 2 later rejects this job for an
  // unrelated reason and it's reopened via wiederOeffnenJob, the excluded Stellvertreter1 must
  // still be excluded — same principle already applied to freigabe2_eskaliert_von (see
  // wiederOeffnenJob's own comment). The flag is only ever cleared by a genuine full reset to
  // the pool (releaseJob, forceReleaseJob), where the job effectively starts over, possibly even
  // under a different Konto.
  db.prepare(
    "UPDATE jobs SET status = 'freigabe2', freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL WHERE id = ?"
  ).run(jobId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular, re-run the existing Batch-3 tests that exercise `abschliessenFreigabe1` indirectly (e.g. anything in `kontierung.test.js` covering the non-conflict completion path) to confirm nothing else assumed the flag gets cleared here.

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "fix(jobsRepo): stop clearing freigabe1_eskaliert_an_admin on Freigabe-1 completion"
```

---

### Task 4: `ablehnung.js` becomes flag-aware

**Files:**
- Modify: `src/routes/ablehnung.js`
- Modify: `src/app.js`
- Test: `test/integration/ablehnung.test.js`

**Interfaces:**
- Consumes: `job.freigabe1_eskaliert_an_admin` (persists correctly now, per Task 3), `config.churchtools.groupIdAdmin` (already available wherever `config` is passed).
- Produces: `createAblehnungRouter({ db, config })` — signature change from `{ db }`. Later tasks don't depend on this directly, but any future caller must pass `config`.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/ablehnung.test.js`, a new seed helper after `seedAbgelehntJob` (after line 54) and three new tests after the existing `'GET /abgelehnt/:id returns 401 without a session'` test (end of file, line 152):

```javascript
async function seedAbgelehntJobMitAdminEskalation(db) {
  for (const id of ['1', '2', '3']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  upsertPerson(db, { id: '4', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '2' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  setKontierung(db, id, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '1' WHERE id = ?").run(id);
  const { eskalierenFreigabe1AnAdmin } = await import('../../src/db/jobsRepo.js');
  eskalierenFreigabe1AnAdmin(db, id, { eskaliertVon: '2', grund: 'Auch befangen' });
  ablehnenJob(db, id, { abgelehntVon: '3', grund: 'Falsches Konto gewählt' });
  return { id, kontoId };
}

test('GET /abgelehnt/:id returns 403 for the originally-assigned person once freigabe1_eskaliert_an_admin is set', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJobMitAdminEskalation(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /abgelehnt/:id grants access to a Portal-Admin once freigabe1_eskaliert_an_admin is set, even though they are not zugewiesen_an', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedAbgelehntJobMitAdminEskalation(db);
  const app = buildTestApp(db);
  const res = await request(app).get(`/abgelehnt/${id}`).set('x-test-person-id', '4');
  assert.equal(res.status, 200);
  db.close();
});

test('POST /abgelehnt/:id/ueberarbeiten reopens the job for a Portal-Admin acting via freigabe1_eskaliert_an_admin', async () => {
  const db = openDatabase(':memory:');
  const { id, kontoId } = await seedAbgelehntJobMitAdminEskalation(db);
  const app = buildTestApp(db);
  const res = await request(app).post(`/abgelehnt/${id}/ueberarbeiten`).set('x-test-person-id', '4');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/kontierung/${id}`);
  const job = getJobById(db, id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.konto_id, kontoId);
  db.close();
});
```

Update `buildTestApp` (currently lines 13-30) to pass `config` to the router. Change:

```javascript
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/abgelehnt', requireLogin(), createAblehnungRouter({ db }));
```

to:

```javascript
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/abgelehnt', requireLogin(), createAblehnungRouter({ db, config }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="freigabe1_eskaliert_an_admin"`
Expected: the first new test (`returns 403 for the originally-assigned person...`) FAILS with `200` instead of `403` (current `loadAuthorizedJob` only checks `zugewiesen_an`, which still matches person `1`). The second and third new tests FAIL with `403`/`409` (person `4` isn't `zugewiesen_an` at all under the current code).

- [ ] **Step 3: Implement the fix**

In `src/routes/ablehnung.js`, replace the whole file with:

```javascript
import { Router } from 'express';
import { getJobById, wiederOeffnenJob } from '../db/jobsRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';

export function createAblehnungRouter({ db, config }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'abgelehnt') {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isPortalAdmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist für dich aktuell nicht zur Überarbeitung verfügbar.' });
      return null;
    }
    return job;
  }

  router.get('/:id', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    const abgelehntVonPerson = getPersonById(db, job.abgelehnt_von);
    const ablehnung = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'ablehnung');
    res.render('abgelehnt', { job, abgelehntVonPerson, ablehnung });
  });

  router.post('/:id/ueberarbeiten', (req, res) => {
    const job = loadAuthorizedJob(req, res);
    if (!job) return;
    // Use job.zugewiesen_an, not req.currentPerson.churchtools_person_id: wiederOeffnenJob's
    // guard requires zugewiesen_an to match the person passed in, and for a Portal-Admin
    // authorized via the freigabe1_eskaliert_an_admin branch, the admin's own ID never equals
    // job.zugewiesen_an (still the excluded Stellvertreter1's ID) — passing the admin's ID would
    // silently match zero rows while still returning the generic 409 as if a race had occurred.
    // For the ordinary (non-admin) path this is definitionally identical, since
    // loadAuthorizedJob already verified job.zugewiesen_an === req.currentPerson.churchtools_person_id
    // to get here. Mirrors the identical fix already applied to kontierung.js's zurueck-in-pool
    // route in Batch 3.
    const reopened = wiederOeffnenJob(db, job.id, job.zugewiesen_an);
    if (!reopened) {
      return res.status(409).render('error', { message: 'Diese Rechnung wurde inzwischen bereits von einem anderen Vorgang bearbeitet.' });
    }
    res.redirect(`/kontierung/${job.id}`);
  });

  return router;
}
```

In `src/app.js`, change line 110 (the `/abgelehnt` mount, already using `requireLogin()` from Task 2) from:

```javascript
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db }));
```

to:

```javascript
  app.use('/abgelehnt', sessionLimiter, requireLogin(), createAblehnungRouter({ db, config }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular re-run `test/integration/ablehnung.test.js` in full — the pre-existing `'POST /abgelehnt/:id/ueberarbeiten returns 403 for a person other than zugewiesen_an'` test must still pass (person `2`, a Stellvertreter but not `zugewiesen_an` and not admin-escalated, is still correctly blocked).

- [ ] **Step 5: Commit**

```bash
git add src/routes/ablehnung.js src/app.js test/integration/ablehnung.test.js
git commit -m "fix(ablehnung): recognize freigabe1_eskaliert_an_admin, fix ueberarbeiten's reopen-by-admin"
```

---

### Task 5: Rejection notification and job-list routing for the excluded person

**Files:**
- Modify: `src/routes/freigabe2.js`
- Modify: `src/db/jobsRepo.js`
- Test: `test/integration/freigabe2.test.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `resolveEmpfaenger(db, config, konfigWert)` (already imported in `freigabe2.js`), `job.freigabe1_eskaliert_an_admin`.
- Produces: no new exports — `listAbgelehntJobsForPerson`'s SQL gains a filter clause, its call signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`, after the `'listAbgelehntJobsForPerson returns only abgelehnt jobs assigned to that person'` test:

```javascript
test('listAbgelehntJobsForPerson excludes a job that has been admin-escalated past this person', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  claimJob(db, jobId, '1');
  setKontierung(db, jobId, kontoId);
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);
  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch befangen' });
  ablehnenJob(db, jobId, { abgelehntVon: '3', grund: 'Falsches Konto' });

  // zugewiesen_an still equals '1', but the job was escalated to Portal-Admin before it ever
  // reached Freigabe 2 — it must not show up in the excluded original assignee's own listing.
  assert.equal(listAbgelehntJobsForPerson(db, '1').length, 0);
  db.close();
});
```

`eskalierenFreigabe1AnAdmin` is already imported at the top of this file.

Add to `test/integration/freigabe2.test.js`, a new seed helper after `seedFreigabe2Job` and a new test after the existing `'GET and POST /freigabe2/:id reject the person who already approved Freigabe 1...'` test:

```javascript
async function seedFreigabe2JobMitAdminEskalation(db, { pdfPfad }) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  upsertPerson(db, { id: '5', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const id = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  setKontierung(db, id, kontoId);
  createFreigabe(db, { jobId: id, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-08-15T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: '1' });
  const { eskalierenFreigabe1AnAdmin } = await import('../../src/db/jobsRepo.js');
  eskalierenFreigabe1AnAdmin(db, id, { eskaliertVon: '2', grund: 'Auch befangen' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', zugewiesen_an = '2' WHERE id = ?").run(id);
  return { id, kontoId };
}

test('POST /freigabe2/:id ablehnen sends the rejection email to the admin group with a direct /abgelehnt link when freigabe1_eskaliert_an_admin is set', async () => {
  const db = openDatabase(':memory:');
  const { id } = await seedFreigabe2JobMitAdminEskalation(db, { pdfPfad: '/tmp/a.pdf' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, { mailer });
  const res = await request(app)
    .post(`/freigabe2/${id}`)
    .set('x-test-person-id', '3')
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto' });
  assert.equal(res.status, 302);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'admin@example.org');
  assert.match(mailer.sent[0].text, new RegExp(`/abgelehnt/${id}`));
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="admin-escalated|freigabe1_eskaliert_an_admin is set"`
Expected: the `listAbgelehntJobsForPerson` test FAILS (returns 1 row, not 0). The `freigabe2.test.js` test FAILS — `mailer.sent[0].to` is `'p2@example.org'` (the excluded person's email), not `'admin@example.org'`, and the link is `/pool`, not `/abgelehnt/<id>`.

- [ ] **Step 3: Implement the fixes**

In `src/db/jobsRepo.js`, change `listAbgelehntJobsForPerson` (currently line 251-253) from:

```javascript
export function listAbgelehntJobsForPerson(db, personId) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'abgelehnt' AND zugewiesen_an = ? ORDER BY eingang_am").all(personId);
}
```

to:

```javascript
export function listAbgelehntJobsForPerson(db, personId) {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'abgelehnt' AND zugewiesen_an = ? AND freigabe1_eskaliert_an_admin = 0 ORDER BY eingang_am"
    )
    .all(personId);
}
```

In `src/routes/freigabe2.js`, change the rejection-notification block inside the `aktion === 'ablehnen'` branch (currently lines 167-176) from:

```javascript
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
```

to:

```javascript
        if (job.freigabe1_eskaliert_an_admin) {
          const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
          for (const email of empfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Rechnung abgelehnt (an Portal-Admin eskaliert)',
              text: `Eine an die Portal-Admin-Gruppe eskalierte Rechnung wurde abgelehnt: ${job.dateiname}\n\nGrund: ${begruendung}\n\nBitte im Freigabeportal anmelden, um sie zu überarbeiten: ${config.publicBaseUrl}/abgelehnt/${job.id}`,
              typ: 'ablehnung',
              jobId: job.id,
            });
          }
        } else {
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
        }
        return res.redirect('/pool');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular re-run the pre-existing `'POST /freigabe2/:id ablehnen...'` tests (non-escalated path) to confirm the `else` branch still sends to the plain `besitzer.email` with the `/pool` link, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/routes/freigabe2.js src/db/jobsRepo.js test/integration/freigabe2.test.js test/unit/jobsRepo.test.js
git commit -m "fix(freigabe2): route rejection notice and pool listing to admin when freigabe1_eskaliert_an_admin is set"
```

---

### Task 6: End-to-end test across real routes

**Files:**
- Create: `test/integration/authzModellEndToEnd.test.js`

**Interfaces:**
- Consumes: `createApp`, the full real HTTP stack, everything built in Tasks 1-5. No new exports.

- [ ] **Step 1: Write the test**

Create `test/integration/authzModellEndToEnd.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

function testConfig() {
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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
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

test('a Freigabe-1 conflict escalated to admin survives a Freigabe-2 rejection: the excluded Stellvertreter1 stays locked out, the admin reworks it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = testConfig();
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-15T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  await stellvertreter1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Auch befangen.' });
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const kontierungRes = await adminAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(kontierungRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2');
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1, "the exclusion must survive Freigabe 1's own completion");

  // Freigeber 2 has no group membership at all — also proves AUTHZ-3's route-gate removal.
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: [] });
  const ablehnenRes = await freigeber2Agent
    .post(`/freigabe2/${jobId}`)
    .type('form')
    .send({ aktion: 'ablehnen', interessenskonflikt: 'nein', begruendung: 'Falsches Konto gewählt.' });
  assert.equal(ablehnenRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'abgelehnt');
  assert.ok(
    listMailLog(db).some((m) => m.typ === 'ablehnung' && m.empfaenger === 'admin@example.org' && m.text.includes(`/abgelehnt/${jobId}`)),
    'the rejection notice must go to the admin group with a direct link, not to the excluded Stellvertreter1'
  );

  // The originally-assigned, now-excluded Stellvertreter1 must not be able to see or rework it.
  const stellvertreter1BlockedRes = await stellvertreter1Agent.get(`/abgelehnt/${jobId}`);
  assert.equal(stellvertreter1BlockedRes.status, 403);

  // The admin reworks it instead.
  const adminAbgelehntRes = await adminAgent.get(`/abgelehnt/${jobId}`);
  assert.equal(adminAbgelehntRes.status, 200);
  const ueberarbeitenRes = await adminAgent.post(`/abgelehnt/${jobId}/ueberarbeiten`);
  assert.equal(ueberarbeitenRes.status, 302);
  assert.equal(ueberarbeitenRes.headers.location, `/kontierung/${jobId}`);
  assert.equal(getJobById(db, jobId).status, 'zugewiesen');

  // The excluded Stellvertreter1 still can't touch Kontierung after the reopen.
  const stellvertreter1StillBlockedRes = await stellvertreter1Agent.get(`/kontierung/${jobId}`);
  assert.equal(stellvertreter1StillBlockedRes.status, 403);

  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test test/integration/authzModellEndToEnd.test.js` (or `npm test -- --test-name-pattern="survives a Freigabe-2 rejection"` if your runner doesn't accept a file path)
Expected: on a clean checkout of Tasks 1-5, this should already PASS — it's a confirmation test, not a TDD-driver for new production code. If it fails, that means one of Tasks 1-5's fixes has a gap; investigate before proceeding rather than adjusting the test to match broken behavior.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, full suite green (this task adds no production code).

- [ ] **Step 4: Commit**

```bash
git add test/integration/authzModellEndToEnd.test.js
git commit -m "test: cover AUTHZ-3 route-gate removal and the Freigabe-1 exclusion surviving reject+rework end-to-end"
```
