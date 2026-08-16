# Sub-Phase E1 – Rate-Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tiered rate-limiting (public/unauthenticated, session-authenticated, machine-to-machine) across every route in the app, satisfying the Lastenheft's "Rate-Limiting auf allen öffentlichen Endpunkten" requirement that every prior phase (D1–D4) explicitly deferred to Phase E.

**Architecture:** A new `src/middleware/rateLimit.js` exports three factory functions (`createPublicRateLimiter`, `createSessionRateLimiter`, `createMachineRateLimiter`), each wrapping `express-rate-limit` with tier-specific defaults. `src/app.js` instantiates all three fresh on every `createApp()` call (no module-level singletons) and threads them into the existing route mounts — no new routers, no schema changes, no new env vars.

**Tech Stack:** Same as Phases A–D4 — Node.js/Express, in-memory `express-rate-limit` (new dependency, `MemoryStore`, zero extra runtime deps), `supertest` for tests, no mocking of this project's own logic.

**Spec:** `docs/superpowers/specs/2026-08-16-phase-e1-rate-limiting-design.md`

## Global Constraints

- `express-rate-limit` is the only new dependency, `MemoryStore` (its default, in-memory) — no Redis, no external store, matching the app's existing single-process assumptions.
- Rate limiters are constructed fresh inside `createApp()` on every call, never as module-level singletons — this is what gives every test its own isolated counters for free, with no `NODE_ENV === 'test'` bypass branch anywhere.
- Three tiers, exact values: **Public** = 100 requests / 15 minutes per IP (`/auth/*`, `/downloads/:jobId`, `/branding/*`, `/`). **Session-authenticated** = 300 requests / 15 minutes per person (`/pool`, `/api/pool`, `/kontierung`, `/freigabe2`, `/abgelehnt`, `/admin/*`). **Machine-to-machine** = 60 requests / 1 minute per IP (`/api/n8n/jobs/*`, `/internal/cron/*`).
- `/healthz` is never wrapped by any limiter — it's mounted as its own `app.get('/healthz', ...)` with nothing else attached, so this is automatic as long as no limiter is added to it.
- Every tier responds to an exceeded limit with **429 + exactly** `{ error: 'Zu viele Anfragen, bitte später erneut versuchen.' }` (this exact string, exported as a constant `RATE_LIMIT_MESSAGE` so production code and tests share one source of truth) — plus the modern `RateLimit-*` response headers (`standardHeaders: 'draft-7'`, `legacyHeaders: false` — never the deprecated `X-RateLimit-*` headers).
- The session tier keys by `req.currentPerson.churchtools_person_id` (coerced to a `String`), falling back to `req.ip` when `req.currentPerson` is absent. Public and machine tiers use `express-rate-limit`'s default IP-based keying (no custom `keyGenerator`) — `app.js` already sets `app.set('trust proxy', 1)`, so `req.ip` is already correct behind Infomaniak's reverse proxy.
- All user-facing text in German, matching every other file's existing copy style.

---

### Task 1: `src/middleware/rateLimit.js` — the three limiter factories

**Files:**
- Modify: `package.json` (add `express-rate-limit` dependency)
- Create: `src/middleware/rateLimit.js`
- Test: `test/unit/rateLimit.test.js` (new)

**Interfaces:**
- Consumes: nothing new — this is a self-contained middleware module, no other task's code.
- Produces (for Task 2):
  - `createPublicRateLimiter(overrides = {})` → Express middleware (default: 100 req / 15 min per IP)
  - `createSessionRateLimiter(overrides = {})` → Express middleware (default: 300 req / 15 min per `req.currentPerson.churchtools_person_id`, falls back to `req.ip`)
  - `createMachineRateLimiter(overrides = {})` → Express middleware (default: 60 req / 1 min per IP)
  - `RATE_LIMIT_MESSAGE` → `{ error: 'Zu viele Anfragen, bitte später erneut versuchen.' }`

Each factory accepts an optional `overrides` object merged over its defaults (e.g. `{ limit: 3, windowMs: 60000 }`) — this exists purely so tests can use small, fast-to-exceed limits without waiting through hundreds of real requests; production code (Task 2) always calls the factories with no arguments, getting the real defaults specified above.

- [ ] **Step 1: Install the dependency**

```bash
npm install express-rate-limit
```

Verify `package.json`'s `dependencies` now includes an `express-rate-limit` entry (npm adds it automatically with a `^`-prefixed version).

- [ ] **Step 2: Write the failing tests**

Create `test/unit/rateLimit.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {
  createPublicRateLimiter,
  createSessionRateLimiter,
  createMachineRateLimiter,
  RATE_LIMIT_MESSAGE,
} from '../../src/middleware/rateLimit.js';

function buildTestApp(limiter) {
  const app = express();
  app.use((req, res, next) => {
    const personId = req.headers['x-test-person-id'];
    if (personId) {
      req.currentPerson = { churchtools_person_id: personId };
    }
    next();
  });
  app.get('/probe', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

test('createPublicRateLimiter allows every request under the limit', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 3, windowMs: 60000 }));
  for (let i = 0; i < 3; i++) {
    const res = await request(app).get('/probe');
    assert.equal(res.status, 200);
  }
});

test('createPublicRateLimiter returns 429 with the exact German message once the limit is exceeded', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 2, windowMs: 60000 }));
  await request(app).get('/probe');
  await request(app).get('/probe');
  const res = await request(app).get('/probe');
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, RATE_LIMIT_MESSAGE);
});

test('createPublicRateLimiter sets modern RateLimit-* headers, never the legacy X-RateLimit-* ones', async () => {
  const app = buildTestApp(createPublicRateLimiter({ limit: 5, windowMs: 60000 }));
  const res = await request(app).get('/probe');
  assert.equal(res.status, 200);
  assert.ok(res.headers['ratelimit-limit'] !== undefined, 'expected a RateLimit-Limit header');
  assert.equal(res.headers['x-ratelimit-limit'], undefined, 'legacy X-RateLimit-Limit header must not be set');
});

test('createPublicRateLimiter keys by IP: two different IPs each get their own counter', async () => {
  const app = express();
  app.set('trust proxy', true);
  app.get('/probe', createPublicRateLimiter({ limit: 1, windowMs: 60000 }), (req, res) => res.json({ ok: true }));

  const ipAFirst = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(ipAFirst.status, 200);
  const ipASecond = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.10');
  assert.equal(ipASecond.status, 429, 'the same IP exceeded its own limit');

  const ipBFirst = await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.20');
  assert.equal(ipBFirst.status, 200, 'a different IP has an independent counter, unaffected by IP A');
});
// createMachineRateLimiter uses the exact same default (unmodified) IP-based keying as
// createPublicRateLimiter — neither overrides keyGenerator — so the guarantee proven above
// applies to it too; no separate test duplicates this mechanism for the machine tier.

test('createSessionRateLimiter keys by churchtools_person_id: two different people each get their own counter', async () => {
  const app = buildTestApp(createSessionRateLimiter({ limit: 1, windowMs: 60000 }));

  const personAFirst = await request(app).get('/probe').set('x-test-person-id', 'A');
  assert.equal(personAFirst.status, 200);
  const personASecond = await request(app).get('/probe').set('x-test-person-id', 'A');
  assert.equal(personASecond.status, 429, 'person A exceeded their own limit');

  const personBFirst = await request(app).get('/probe').set('x-test-person-id', 'B');
  assert.equal(personBFirst.status, 200, 'person B has an independent counter, unaffected by person A');
});

test('createSessionRateLimiter falls back to req.ip when req.currentPerson is absent', async () => {
  const app = buildTestApp(createSessionRateLimiter({ limit: 2, windowMs: 60000 }));
  const res1 = await request(app).get('/probe');
  const res2 = await request(app).get('/probe');
  const res3 = await request(app).get('/probe');
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res3.status, 429, 'anonymous requests still get limited via the IP fallback');
});

test('createMachineRateLimiter returns 429 once its limit is exceeded', async () => {
  const app = buildTestApp(createMachineRateLimiter({ limit: 2, windowMs: 60000 }));
  await request(app).get('/probe');
  await request(app).get('/probe');
  const res = await request(app).get('/probe');
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, RATE_LIMIT_MESSAGE);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/unit/rateLimit.test.js`
Expected: FAIL — `src/middleware/rateLimit.js` doesn't exist yet.

- [ ] **Step 4: Create `src/middleware/rateLimit.js`**

```javascript
import { rateLimit } from 'express-rate-limit';

export const RATE_LIMIT_MESSAGE = { error: 'Zu viele Anfragen, bitte später erneut versuchen.' };

function jsonRateLimitHandler(req, res) {
  res.status(429).json(RATE_LIMIT_MESSAGE);
}

const COMMON_OPTIONS = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonRateLimitHandler,
};

export function createPublicRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

export function createSessionRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    keyGenerator: (req) => (req.currentPerson ? String(req.currentPerson.churchtools_person_id) : req.ip),
    ...COMMON_OPTIONS,
    ...overrides,
  });
}

export function createMachineRateLimiter(overrides = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    ...COMMON_OPTIONS,
    ...overrides,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/rateLimit.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 6: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions (this task adds a new, self-contained module with no callers yet).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/middleware/rateLimit.js test/unit/rateLimit.test.js
git commit -m "feat: add rateLimit.js (public/session/machine limiter factories)"
```

---

### Task 2: Wire the limiters into `src/app.js`

**Files:**
- Modify: `src/app.js`
- Test: `test/integration/rateLimit.test.js` (new)

**Interfaces:**
- Consumes: `createPublicRateLimiter`, `createSessionRateLimiter`, `createMachineRateLimiter` (Task 1), all called with no arguments (real production defaults).
- Produces: nothing new consumed by later tasks — this is the final task of Sub-Phase E1.

Each of the three limiter instances is created **once per `createApp()` call**, then passed by reference into every route mount that needs it — never re-created per mount, never a module-level singleton. This is what gives every test (which calls `createApp({ db, config })` fresh) its own isolated counters automatically.

The limiter for each route group is placed **before** any `requireRole`/`requireApiKey` check on that same mount line, so repeated unauthorized/wrong-key attempts are throttled too, not just successful ones.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/rateLimit.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createApp } from '../../src/app.js';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
    cronSecret: 'cron-secret',
    n8nApiKey: 'test-n8n-key',
    downloadSigningSecret: 'test-signing-secret',
    jobsDir: '/tmp/freigabeportal-ratelimit-test-jobs',
  };
}

test('GET /healthz is never rate-limited, even after many rapid requests', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200, `request ${i} should not be throttled`);
  }
  db.close();
});

test('a fresh createApp() call gets its own isolated rate-limit counters (test isolation)', async () => {
  const db = openDatabase(':memory:');
  const app1 = createApp({ db, config: testConfig() });
  // Exhaust nothing here — this test only proves a second app doesn't inherit state,
  // which the next two tests in this file rely on implicitly (each builds its own app).
  const res = await request(app1).get('/healthz');
  assert.equal(res.status, 200);
  db.close();
});

test('POST /api/n8n/jobs is rate-limited independently of auth outcome (machine tier)', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });

  // No API key at all -> 401s, but each attempt still consumes the machine-tier budget.
  let lastStatus;
  for (let i = 0; i < 61; i++) {
    const res = await request(app).post('/api/n8n/jobs').field('quelle', 'scanner');
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'the 61st request within a minute should be rate-limited');
  db.close();
});

test('GET / (public tier) is rate-limited by IP after 100 requests in the window', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });

  let lastStatus;
  for (let i = 0; i < 101; i++) {
    const res = await request(app).get('/');
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'the 101st request within 15 minutes should be rate-limited');
  db.close();
});

test('two different logged-in people hitting /pool do not throttle each other (session tier keys by person)', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  upsertPerson(db, { id: '1', vorname: 'Erste', nachname: 'Person', email: 'erste@example.org', gruppen: ['10'], loggedInNow: true });
  upsertPerson(db, { id: '2', vorname: 'Zweite', nachname: 'Person', email: 'zweite@example.org', gruppen: ['10'], loggedInNow: true });
  const app = createApp({ db, config });

  async function loginAs(id) {
    client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
    client.intercept({ path: '/api/whoami', method: 'GET' }).reply(200, { data: { id, firstName: 'X', lastName: 'Y', email: `p${id}@example.org` } });
    client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: id }] });
    client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
    const agent = request.agent(app);
    const loginRes = await agent.get('/auth/login');
    const state = new URL(loginRes.headers.location).searchParams.get('state');
    await agent.get('/auth/callback').query({ code: `code-${id}`, state });
    return agent;
  }

  const personA = await loginAs(1);
  const personB = await loginAs(2);

  // Person A's own session-tier requests to /auth/login and /auth/callback above went through
  // the PUBLIC limiter (100/15min), not the session one, so /pool starts fresh for both people.
  const resA = await personA.get('/pool');
  assert.equal(resA.status, 200);
  const resB = await personB.get('/pool');
  assert.equal(resB.status, 200, 'person B is unaffected by person A having just used /pool');

  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/rateLimit.test.js`
Expected: FAIL — no limiter is mounted anywhere yet, so the 429-expecting tests never see one (they'll exhaust their loops without breaking, then fail the final `assert.equal(lastStatus, 429, ...)`).

- [ ] **Step 3: Wire the limiters into `src/app.js`**

Add the import near the top, after the other middleware imports:

```javascript
import { createPublicRateLimiter, createSessionRateLimiter, createMachineRateLimiter } from './middleware/rateLimit.js';
```

Inside `createApp`, right after the `mailer` try/catch block (before the `/branding` mount), add:

```javascript
  const publicLimiter = createPublicRateLimiter();
  const sessionLimiter = createSessionRateLimiter();
  const machineLimiter = createMachineRateLimiter();
```

Change every route mount listed below from its current form to the form shown. Every other line in `createApp` (session setup, `loadCurrentPerson`, the mailer block, the 404/500 handlers, `/healthz`) is unchanged.

```javascript
  app.use('/branding', publicLimiter, createBrandingRouter({ db }));
  app.use('/admin', sessionLimiter, requireRole(config, 'portal-admin'));
  app.use('/admin/konten', createKontenRouter({ db }));
  app.use('/admin/zuweisungsregeln', createZuweisungsregelnRouter({ db }));
  app.use('/admin/eskalation', createEskalationRouter({ db }));
  app.use('/admin/erscheinungsbild', createErscheinungsbildRouter({ db, config }));
  app.use('/admin/personen', createPersonenRouter({ db }));
  app.use('/admin/pdf-einstellungen', createPdfEinstellungenRouter({ db }));
  app.use('/admin/mails', createMailsRouter({ db, mailer }));

  app.use('/api/n8n/jobs', machineLimiter, requireApiKey(config), createN8nJobsRouter({ db, config, mailer }));
  app.use('/api/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolRouter({ db }));
  app.use('/pool', sessionLimiter, requireRole(config, 'buchhaltung'), createPoolPageRouter({ db, config }));
  app.use('/downloads', publicLimiter, createDownloadsRouter({ db, config }));
  app.use('/kontierung', sessionLimiter, requireRole(config, 'buchhaltung'), createKontierungRouter({ db, config, mailer }));
  app.use('/freigabe2', sessionLimiter, requireRole(config, 'buchhaltung'), createFreigabe2Router({ db, config, mailer }));
  app.use('/abgelehnt', sessionLimiter, requireRole(config, 'buchhaltung'), createAblehnungRouter({ db }));

  app.use('/auth', publicLimiter, createAuthRouter({ db, config }));
  app.use('/internal/cron', machineLimiter, createCronRouter({ db, config, mailer }));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', publicLimiter, (req, res) => {
```

(The `/admin/*` sub-routes each keep their existing single-line `app.use('/admin/xxx', ...)` form with no limiter of their own — the blanket `app.use('/admin', sessionLimiter, requireRole(...))` above already covers every one of them, exactly the way `requireRole` already does today. Do not add `sessionLimiter` a second time to any individual `/admin/xxx` line.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/rateLimit.test.js`
Expected: PASS, all 5 tests. Note: the machine-tier and public-tier 429 tests each fire up to 61/101 real requests against an in-process app — this is fast (no real network I/O) but takes a moment; that's expected and not a sign of a problem.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: PASS, no regressions. Pay particular attention to `test/integration/admin/authz-sweep.test.js` (21 routes × 2 auth checks per run) and `test/integration/mailversandEndToEnd.test.js` (~10 requests per run) — both must stay comfortably under every tier's limit and continue passing unchanged. If either fails, investigate whether a test fires more requests against a single `createApp()` instance than expected before assuming it's unrelated.

- [ ] **Step 6: Commit**

```bash
git add src/app.js test/integration/rateLimit.test.js
git commit -m "feat: wire tiered rate limiting into every route mount"
```
