# Phase F – UI-Modernisierung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Freigabeportal a consistent, professional, responsive appearance using self-hosted Bootstrap 5.3.3, add a reachable `/admin` dashboard, auto-redirect Buchhaltung/Portal-Admin members straight to `/pool` after login, add save-confirmation feedback to every admin settings form, and render the Aufgaben/Admin navigation as Bootstrap tabs — without changing any existing route, authorization gate, or workflow logic.

**Architecture:** Bootstrap 5.3.3's CSS and JS bundle are vendored into `public/vendor/bootstrap/` and served via a new `express.static('public')` mount — no CDN dependency, no build step, no new npm package. A new `loadNavFlags` middleware (mirroring the existing `loadBranding`/`loadCurrentPerson` pattern) computes `isBuchhaltung`/`isPortalAdmin`/`currentPath` once per request and exposes them as `res.locals`, so `_header.ejs`'s new global nav-tabs bar can render correctly on every page without every route handler passing them explicitly. All 16 existing views plus one new `views/admin/dashboard.ejs` get a `<meta name="viewport">` tag (verified absent from all of them before this plan), a Bootstrap stylesheet `<link>`, Bootstrap utility/component classes over their existing markup, and (where applicable) a `?gespeichert=1` redirect-marker-driven save-confirmation alert — all while preserving every ID/class an inline `<script>` block depends on (`#preview-dialog`, `.beanspruchen-btn`, `.thumbnail-preview`, etc.).

**Tech Stack:** Node.js, Express, EJS views, Bootstrap 5.3.3 (vendored static CSS/JS, no npm package), `node:test` + `supertest` for tests (`npm test` runs `node --test 'test/**/*.test.js'`).

**Spec:** docs/superpowers/specs/2026-08-16-phase-f-ui-modernisierung-design.md

## Global Constraints

- Node.js `>=22.13.0` (from `package.json` `engines`), no build step anywhere in this project — Bootstrap is vendored as static files fetched once and committed, never installed as an npm package and never loaded from a CDN at runtime.
- EJS views: `<%- %>` only for trusted includes (`<%- include(...) %>`), `<%= %>` for all real data — never mix these up when editing views in this plan.
- German-language strings throughout (labels, buttons, confirmation text) — match the existing tone exactly. The two save-confirmation strings are exactly `Gespeichert.` and (for the mail-resend action only) `Erneut gesendet.`.
- No `<meta name="viewport">` tag exists in any of this project's 16 pre-Phase-F views (verified by grep before writing this plan) — every task that touches a view's `<head>` must add one.
- This phase changes **no** existing authorization gate: `/admin` stays blanket-gated by `requireRole(config, 'portal-admin')` (`src/app.js:94`), `/kontierung`/`/freigabe2`/`/abgelehnt` stay gated by `requireLogin()`, `/pool`/`/api/pool` stay gated by `requireRole`/`requireAnyRole(config, ['buchhaltung', 'portal-admin'])`. Only nav/link **visibility** and one post-login **redirect target** change.
- Every view already receives `branding` (from `loadBranding`) and `currentPerson` (from `loadCurrentPerson`) automatically via `res.locals`, without any route handler passing them explicitly. This plan adds `isBuchhaltung`, `isPortalAdmin`, and `currentPath` to that same automatic-locals set via a new `loadNavFlags` middleware — `_header.ejs` reads them with `typeof x !== 'undefined'` guards so isolated per-router test harnesses that don't mount `loadNavFlags` degrade gracefully (nav-tabs simply don't render) instead of throwing.
- `res.render(view, locals)` in Express merges the passed `locals` object over `res.locals` — a view can reference a `res.locals`-only value without any route explicitly re-passing it, exactly how `branding`/`currentPerson` already work in every existing view.

---

### Task 1: Vendor Bootstrap 5.3.3 and serve it as a static asset

**Files:**
- Create: `public/vendor/bootstrap/bootstrap.min.css`
- Create: `public/vendor/bootstrap/bootstrap.bundle.min.js`
- Modify: `src/app.js`
- Test: `test/integration/app.test.js`

**Interfaces:**
- Produces: `GET /vendor/bootstrap/bootstrap.min.css` and `GET /vendor/bootstrap/bootstrap.bundle.min.js`, served as static files. Every later task's views reference these two exact URLs.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/app.test.js`, after the `'GET /healthz returns ok'` test:

```javascript
test('GET /vendor/bootstrap/bootstrap.min.css is served as a static asset', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/vendor/bootstrap/bootstrap.min.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /css/);
  db.close();
});

test('GET /vendor/bootstrap/bootstrap.bundle.min.js is served as a static asset', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/vendor/bootstrap/bootstrap.bundle.min.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="static asset"`
Expected: FAIL with `404` for both — neither the files nor the static mount exist yet.

- [ ] **Step 3: Vendor the files and add the static mount**

From the repo root:

```bash
mkdir -p public/vendor/bootstrap
curl -sSL https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css -o public/vendor/bootstrap/bootstrap.min.css
curl -sSL https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js -o public/vendor/bootstrap/bootstrap.bundle.min.js
wc -c public/vendor/bootstrap/bootstrap.min.css public/vendor/bootstrap/bootstrap.bundle.min.js
```

Expected: both files well over 100 KB (Bootstrap 5.3.3's minified CSS is roughly 230 KB, the JS bundle roughly 80 KB). If either command fails or produces a near-empty file, stop and report — do not commit a partial/corrupt vendor file.

In `src/app.js`, add the static mount right after `app.set('views', join(__dirname, '..', 'views'));` (currently line 37):

```javascript
  app.set('views', join(__dirname, '..', 'views'));
  app.use(express.static(join(__dirname, '..', 'public')));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add public/vendor/bootstrap/bootstrap.min.css public/vendor/bootstrap/bootstrap.bundle.min.js src/app.js test/integration/app.test.js
git commit -m "feat(ui): vendor Bootstrap 5.3.3 and serve it via express.static"
```

---

### Task 2: `loadNavFlags` middleware and a `personHasRole` refactor

**Files:**
- Modify: `src/middleware/roles.js`
- Modify: `src/middleware/branding.js`
- Create: `src/middleware/nav.js`
- Modify: `src/app.js`
- Test: `test/unit/roles.test.js`
- Test: `test/unit/branding.test.js`
- Test: `test/unit/nav.test.js`

**Interfaces:**
- Produces: `personHasRole(person, config, role)` from `src/middleware/roles.js` — returns `boolean`, `false` for a null/undefined `person`. `loadNavFlags(config)` from `src/middleware/nav.js` — Express middleware factory; sets `res.locals.isBuchhaltung`, `res.locals.isPortalAdmin` (both `boolean`), and `res.locals.currentPath` (`req.path`), then calls `next()` unconditionally. `branding.bsThemeAttr` — added to the object `loadBranding` already puts at `res.locals.branding`; `'dark'` when `themeAttr === 'dunkel'`, `'light'` when `themeAttr === 'hell'`, `null` otherwise.
- Consumes (later tasks): Task 3's `_header.ejs` reads `isBuchhaltung`/`isPortalAdmin`/`currentPath` and `branding.bsThemeAttr`. Every view touched in Tasks 6-8 reads `branding.bsThemeAttr` on its `<html>` tag.

- [ ] **Step 1: Write the failing tests**

In `test/unit/roles.test.js`, change the import line (line 5) from:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from '../../src/middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin, personHasRole } from '../../src/middleware/roles.js';
```

Add at the bottom of the file:

```javascript
test('personHasRole returns false for a null person', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  assert.equal(personHasRole(null, config, 'buchhaltung'), false);
});

test('personHasRole checks membership by the role\'s own configured group id', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  const person = { gruppen: ['20'] };
  assert.equal(personHasRole(person, config, 'buchhaltung'), false);
  assert.equal(personHasRole(person, config, 'portal-admin'), true);
});
```

In `test/unit/branding.test.js`, add at the bottom of the file:

```javascript
test('bsThemeAttr maps dunkel to dark and hell to light, and stays null when themeAttr is null', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(runMiddleware(db, 'theme=dunkel').bsThemeAttr, 'dark');
  assert.equal(runMiddleware(db, 'theme=hell').bsThemeAttr, 'light');
  assert.equal(runMiddleware(db, undefined).bsThemeAttr, null);
  db.close();
});
```

Create `test/unit/nav.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNavFlags } from '../../src/middleware/nav.js';

function runLoadNavFlags(config, currentPerson, path) {
  const req = { currentPerson, path };
  const res = { locals: {} };
  let calledNext = false;
  loadNavFlags(config)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

test('loadNavFlags sets isBuchhaltung/currentPath for a Buchhaltung member and calls next', () => {
  const { res, calledNext } = runLoadNavFlags(CONFIG, { gruppen: ['10'] }, '/pool');
  assert.equal(res.locals.isBuchhaltung, true);
  assert.equal(res.locals.isPortalAdmin, false);
  assert.equal(res.locals.currentPath, '/pool');
  assert.equal(calledNext, true);
});

test('loadNavFlags sets isPortalAdmin true for a Portal-Admin member', () => {
  const { res } = runLoadNavFlags(CONFIG, { gruppen: ['20'] }, '/admin');
  assert.equal(res.locals.isPortalAdmin, true);
  assert.equal(res.locals.isBuchhaltung, false);
});

test('loadNavFlags sets both flags false for an anonymous visitor (currentPerson null)', () => {
  const { res } = runLoadNavFlags(CONFIG, null, '/');
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.isPortalAdmin, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="personHasRole|bsThemeAttr|loadNavFlags"`
Expected: FAIL — `personHasRole` isn't exported yet, `bsThemeAttr` is `undefined`, and `src/middleware/nav.js` doesn't exist (import error).

- [ ] **Step 3: Implement**

Replace `src/middleware/roles.js` in full:

```javascript
import { getPersonById } from '../db/personenRepo.js';

export function loadCurrentPerson(db) {
  return (req, res, next) => {
    if (!req.session.personId) {
      req.currentPerson = null;
      res.locals.currentPerson = null;
      return next();
    }
    req.currentPerson = getPersonById(db, req.session.personId);
    // Exposed as a template local (mirroring middleware/branding.js's res.locals.branding
    // pattern) so views can render a logout link without every route handler needing to pass
    // it through explicitly.
    res.locals.currentPerson = req.currentPerson;
    next();
  };
}

const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  'portal-admin': 'groupIdAdmin',
};

// Shared by requireRole/requireAnyRole (the HTTP gates) and middleware/nav.js's loadNavFlags
// (Phase F's nav-tab visibility computation) — both need the identical "is this person in
// ChurchTools group X" check. Extracted here rather than duplicated a third time.
export function personHasRole(person, config, role) {
  if (!person) return false;
  const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
  return person.gruppen.includes(String(groupId));
}

export function requireRole(config, role) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!personHasRole(person, config, role)) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireAnyRole(config, roles) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!roles.some((role) => personHasRole(person, config, role))) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

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

This is behavior-preserving for `requireRole`/`requireAnyRole`/`requireLogin` — only the group-membership check itself moved into a named, reusable function.

Create `src/middleware/nav.js`:

```javascript
import { personHasRole } from './roles.js';

export function loadNavFlags(config) {
  return (req, res, next) => {
    res.locals.isBuchhaltung = personHasRole(req.currentPerson, config, 'buchhaltung');
    res.locals.isPortalAdmin = personHasRole(req.currentPerson, config, 'portal-admin');
    res.locals.currentPath = req.path;
    next();
  };
}
```

In `src/middleware/branding.js`, change the `res.locals.branding` assignment (currently lines 32-37) from:

```javascript
    res.locals.branding = {
      primaryColor,
      secondaryColor,
      hasLogo: Boolean(logoPfad) && Boolean(logoMimetype),
      themeAttr,
    };
```

to:

```javascript
    res.locals.branding = {
      primaryColor,
      secondaryColor,
      hasLogo: Boolean(logoPfad) && Boolean(logoMimetype),
      themeAttr,
      // Bootstrap 5.3's native dark-mode attribute is a separate value from this app's own
      // data-theme="dunkel"/"hell" — computed here once so every view's <html> tag can set both
      // from the same toggle without duplicating the dunkel/dark mapping in 17 places.
      bsThemeAttr: themeAttr === 'dunkel' ? 'dark' : themeAttr === 'hell' ? 'light' : null,
    };
```

In `src/app.js`, add the import and mount `loadNavFlags` right after `loadCurrentPerson`. Change the import line (currently line 11) from:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
```

to:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';
import { loadNavFlags } from './middleware/nav.js';
```

Change (currently line 75):

```javascript
  app.use(loadCurrentPerson(db));
```

to:

```javascript
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(config));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/roles.js src/middleware/branding.js src/middleware/nav.js src/app.js test/unit/roles.test.js test/unit/branding.test.js test/unit/nav.test.js
git commit -m "feat(ui): add loadNavFlags middleware and bsThemeAttr, extract personHasRole"
```

---

### Task 3: `_header.ejs` — Bootstrap wiring, brand-color overrides, dark mode, nav-tabs

**Files:**
- Modify: `views/_header.ejs`
- Modify: `views/home.ejs`
- Modify: `src/app.js`
- Test: `test/integration/app.test.js`

**Interfaces:**
- Consumes: `isBuchhaltung`, `isPortalAdmin`, `currentPath` (Task 2's `loadNavFlags`), `branding.bsThemeAttr` (Task 2's `branding.js`), the two vendored asset URLs (Task 1).
- Produces: a global nav-tabs bar rendered on every page via `_header.ejs`'s existing `<%- include('_header') %>` call — no route handler changes needed elsewhere for the nav-tabs to appear.

**Note on Bootstrap's actual CSS:** Bootstrap 5.3.3's compiled `bootstrap.min.css` bakes literal hex values into each `.btn-*` variant's own `--bs-btn-*` custom properties (e.g. `.btn-primary { --bs-btn-bg: #0d6efd; ... }`) — it does **not** reference `--bs-primary` from those rules (verified by inspecting the shipped CSS). Setting `--bs-primary` alone at `:root` has no visible effect on buttons. This task overrides the actual `--bs-btn-*`/`--bs-nav-tabs-*` properties the components consume, not just `--bs-primary`.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/app.test.js`, after the `'every response carries the baseline security headers'` test:

```javascript
test('nav-tabs shows only the Aufgaben tab for a Buchhaltung-only member, active on /pool', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/pool');
  assert.match(res.text, /class="nav-link active" href="\/pool"/);
  assert.doesNotMatch(res.text, /href="\/admin"/);
  db.close();
});

test('nav-tabs shows both Aufgaben and Admin tabs for a Portal-Admin, Admin tab active on /admin', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.match(res.text, /href="\/pool">Aufgaben/);
  assert.match(res.text, /class="nav-link active" href="\/admin">Admin/);
  db.close();
});

test('nav-tabs renders no tabs at all for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.doesNotMatch(res.text, /nav-tabs/);
  db.close();
});
```

Replace the existing `'GET / shows no link to /pool for a logged-in person without the buchhaltung group'` test (lines 137-165) — its premise is now wrong: a Portal-Admin-only person can already reach `/pool` via `requireAnyRole`, and the whole point of this task's nav-tabs is to finally surface that link for them too. Replace it with two tests:

```javascript
test('GET / shows a link to /pool for a logged-in Portal-Admin who is not also in Buchhaltung (nav-tabs mirrors /pool\'s requireAnyRole gate)', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Angemeldet als Admin Only/);
  assert.match(res.text, /href="\/pool"/);
  db.close();
});

test('GET / shows no /pool or /admin link for a logged-in person in neither Buchhaltung nor Portal-Admin', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 30, firstName: 'Ohne', lastName: 'Gruppe', email: 'ohne@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /href="\/pool"/);
  assert.doesNotMatch(res.text, /href="\/admin"/);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="nav-tabs|Portal-Admin who is not also|neither Buchhaltung nor Portal-Admin"`
Expected: FAIL — no `nav-tabs` markup exists yet, and the old test this replaces no longer exists to conflict, but the new "shows a link" test fails because there is currently no nav-tabs-driven `/pool` link (only the old Buchhaltung-gated inline link on `home.ejs`, which this Portal-Admin-only person never saw).

- [ ] **Step 3: Implement**

Replace `views/_header.ejs` in full:

```html
<script src="/vendor/bootstrap/bootstrap.bundle.min.js"></script>
<link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
<style>
  :root {
    --brand-primary: <%= branding.primaryColor || '#2f4858' %>;
    --brand-secondary: <%= branding.secondaryColor || '#4d7ea8' %>;
    --bg: #ffffff;
    --fg: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="hell"]) {
      --bg: #1a1a1a;
      --fg: #f0f0f0;
    }
  }
  :root[data-theme="dunkel"] {
    --bg: #1a1a1a;
    --fg: #f0f0f0;
  }
  body { background: var(--bg); color: var(--fg); }
  a { color: var(--brand-primary); }
  button { border-color: var(--brand-secondary); }
  /* Bootstrap's compiled CSS bakes literal hex values into each .btn-*/.nav-tabs-* variant's
     own custom properties (not a reference to --bs-primary), so this app's per-instance
     branding colors must override those component-level variables directly to actually reach
     rendered buttons and the active tab indicator — setting --bs-primary alone has no effect. */
  .btn-primary {
    --bs-btn-bg: var(--brand-primary);
    --bs-btn-border-color: var(--brand-primary);
    --bs-btn-hover-bg: var(--brand-secondary);
    --bs-btn-hover-border-color: var(--brand-secondary);
    --bs-btn-active-bg: var(--brand-secondary);
    --bs-btn-active-border-color: var(--brand-secondary);
    --bs-btn-disabled-bg: var(--brand-primary);
    --bs-btn-disabled-border-color: var(--brand-primary);
  }
  .btn-outline-primary {
    --bs-btn-color: var(--brand-primary);
    --bs-btn-border-color: var(--brand-primary);
    --bs-btn-hover-bg: var(--brand-primary);
    --bs-btn-hover-border-color: var(--brand-primary);
    --bs-btn-active-bg: var(--brand-primary);
    --bs-btn-active-border-color: var(--brand-primary);
    --bs-btn-disabled-color: var(--brand-primary);
    --bs-btn-disabled-border-color: var(--brand-primary);
  }
  .nav-tabs .nav-link.active {
    color: var(--brand-primary);
    border-bottom: 2px solid var(--brand-primary);
  }
</style>
<header class="d-flex justify-content-between align-items-center p-3 border-bottom mb-3">
  <div class="d-flex align-items-center gap-3">
    <% if (branding.hasLogo) { %>
      <img src="/branding/logo" alt="Logo" height="48">
    <% } %>
  </div>
  <div class="d-flex align-items-center gap-2">
    <button type="button" id="theme-toggle" class="btn btn-outline-secondary btn-sm" aria-label="Farbmodus umschalten">🌓</button>
    <% if (typeof currentPerson !== 'undefined' && currentPerson) { %>
      <form method="post" action="/auth/logout" class="d-inline">
        <button type="submit" class="btn btn-outline-secondary btn-sm">Abmelden</button>
      </form>
    <% } %>
  </div>
</header>
<% const navIsBuchhaltung = typeof isBuchhaltung !== 'undefined' && isBuchhaltung; %>
<% const navIsPortalAdmin = typeof isPortalAdmin !== 'undefined' && isPortalAdmin; %>
<% const navAktuellerPfad = typeof currentPath !== 'undefined' ? currentPath : ''; %>
<% if (navIsBuchhaltung || navIsPortalAdmin) { %>
  <ul class="nav nav-tabs container mb-3">
    <li class="nav-item">
      <a class="nav-link<%= navAktuellerPfad === '/pool' ? ' active' : '' %>" href="/pool">Aufgaben</a>
    </li>
    <% if (navIsPortalAdmin) { %>
      <li class="nav-item">
        <a class="nav-link<%= navAktuellerPfad.startsWith('/admin') ? ' active' : '' %>" href="/admin">Admin</a>
      </li>
    <% } %>
  </ul>
<% } %>
<script>
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dunkel' ? 'hell' : 'dunkel';
    root.setAttribute('data-theme', next);
    root.setAttribute('data-bs-theme', next === 'dunkel' ? 'dark' : 'light');
    document.cookie = 'theme=' + next + ';path=/;max-age=31536000;samesite=lax';
  });
</script>
```

In `views/home.ejs`, remove the now-redundant inline pool link (the global nav-tabs bar covers it) and add the viewport tag/Bootstrap link/dark-mode attribute. Replace the file in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container py-4">
    <h1>Freigabeportal</h1>
    <% if (person) { %>
      <p>Angemeldet als <%= person.vorname %> <%= person.nachname %>.</p>
    <% } else { %>
      <p>Nicht angemeldet. <a href="/auth/login" class="btn btn-primary">Anmelden</a></p>
    <% } %>
  </main>
</body>
</html>
```

In `src/app.js`, simplify the `/` handler since `isBuchhaltung` is no longer used by `home.ejs` (it's still computed globally by `loadNavFlags` for the nav-tabs, just no longer needed as an explicit local here). Change (currently lines 117-122):

```javascript
  app.get('/', publicLimiter, (req, res) => {
    const isBuchhaltung = Boolean(
      req.currentPerson && req.currentPerson.gruppen.includes(String(config.churchtools.groupIdBuchhaltung))
    );
    res.render('home', { person: req.currentPerson ?? null, isBuchhaltung });
  });
```

to:

```javascript
  app.get('/', publicLimiter, (req, res) => {
    res.render('home', { person: req.currentPerson ?? null });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular confirm the pre-existing `'GET / shows a link to /pool for a logged-in buchhaltung member'` test still passes — it now matches via the nav-tabs `Aufgaben` link instead of the removed inline paragraph link, which is the intended behavior.

- [ ] **Step 5: Commit**

```bash
git add views/_header.ejs views/home.ejs src/app.js test/integration/app.test.js
git commit -m "feat(ui): wire Bootstrap into _header.ejs, add global nav-tabs, dark-mode data-bs-theme"
```

---

### Task 4: `/admin` dashboard route and restyled admin sub-nav

**Files:**
- Create: `views/admin/dashboard.ejs`
- Modify: `views/admin/_nav.ejs`
- Modify: `src/app.js`
- Test: `test/integration/app.test.js`

**Interfaces:**
- Produces: `GET /admin` — 200 for a Portal-Admin, rendering `views/admin/dashboard.ejs` with a link to each of the 8 existing admin areas; 403/401 unchanged (still gated by the existing blanket `requireRole(config, 'portal-admin')` at `src/app.js:94`, which runs before this new route).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/app.test.js`, after the `'GET /pool returns 200 for a Portal-Admin who is not also a Buchhaltung member'` test:

```javascript
test('GET /admin renders a dashboard with links to all eight admin areas for a Portal-Admin', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 2, firstName: 'Admin', lastName: 'Only', email: 'admin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 2 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.equal(res.status, 200);
  for (const path of ['/admin/konten', '/admin/zuweisungsregeln', '/admin/eskalation', '/admin/erscheinungsbild', '/admin/personen', '/admin/pdf-einstellungen', '/admin/mails', '/admin/sync']) {
    assert.match(res.text, new RegExp(`href="${path}"`), `expected a link to ${path}`);
  }
  db.close();
});

test('GET /admin returns 403 for a logged-in Buchhaltung-only member', async () => {
  const config = testConfig();
  config.churchtools = {
    ...config.churchtools,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.org/auth/callback',
  };
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 1, firstName: 'Buch', lastName: 'Halter', email: 'buch@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code: 'the-code', state });

  const res = await agent.get('/admin');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin returns 401 for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/admin');
  assert.equal(res.status, 401);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="GET /admin"`
Expected: the first test FAILS with `404` (no route exists). The second and third continue to pass already (the existing blanket gate already 403s/401s bare `/admin`) — that's fine, they're here as regression coverage once the new route exists behind the same gate.

- [ ] **Step 3: Implement**

Create `views/admin/dashboard.ejs`:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Admin — Freigabeportal</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <h1>Admin</h1>
    <div class="row row-cols-1 row-cols-md-3 g-3">
      <div class="col">
        <a href="/admin/konten" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Konten</h2>
            <p class="card-text text-body-secondary">Konten und ihre Freigeber verwalten.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/zuweisungsregeln" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Zuweisungsregeln</h2>
            <p class="card-text text-body-secondary">Absender-Muster einem Konto zuordnen.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/eskalation" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Eskalationszeiten</h2>
            <p class="card-text text-body-secondary">Reminder- und Eskalationsfristen einstellen.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/erscheinungsbild" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Erscheinungsbild</h2>
            <p class="card-text text-body-secondary">Farben, Logo und Standard-Farbmodus.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/personen" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Personen</h2>
            <p class="card-text text-body-secondary">Synchronisierte Personen und ihr Status.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/pdf-einstellungen" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">PDF-Einstellungen</h2>
            <p class="card-text text-body-secondary">Position der Visum-Seite im PDF.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/mails" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Mail-Protokoll</h2>
            <p class="card-text text-body-secondary">Versendete und fehlgeschlagene E-Mails.</p>
          </div>
        </a>
      </div>
      <div class="col">
        <a href="/admin/sync" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Sync-Übersicht</h2>
            <p class="card-text text-body-secondary">ChurchTools-Sync-Historie und feststeckende Jobs.</p>
          </div>
        </a>
      </div>
    </div>
  </main>
</body>
</html>
```

Replace `views/admin/_nav.ejs` in full (Bootstrap pills, distinct from the global `nav-tabs` so the two navigation levels are visually distinguishable):

```html
<ul class="nav nav-pills mb-3">
  <li class="nav-item"><a class="nav-link" href="/admin/konten">Konten</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/zuweisungsregeln">Zuweisungsregeln</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/eskalation">Eskalationszeiten</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/erscheinungsbild">Erscheinungsbild</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/personen">Personen</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/pdf-einstellungen">PDF-Einstellungen</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/mails">Mail-Protokoll</a></li>
  <li class="nav-item"><a class="nav-link" href="/admin/sync">Sync-Übersicht</a></li>
</ul>
```

In `src/app.js`, add the dashboard route right after the blanket gate (currently line 94, before the `/admin/konten` sub-mount on line 95):

```javascript
  app.use('/admin', sessionLimiter, requireRole(config, 'portal-admin'));
  app.get('/admin', (req, res) => {
    res.render('admin/dashboard');
  });
  app.use('/admin/konten', createKontenRouter({ db }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add views/admin/dashboard.ejs views/admin/_nav.ejs src/app.js test/integration/app.test.js
git commit -m "feat(ui): add /admin dashboard route, restyle admin sub-nav with Bootstrap pills"
```

---

### Task 5: Post-login redirect straight to `/pool`

**Files:**
- Modify: `src/routes/auth.js`
- Modify: `test/integration/auth.test.js`

**Interfaces:**
- Produces: no new exports. `GET /auth/callback` now redirects to `/pool` when the logged-in person is a Buchhaltung or Portal-Admin member, and to `/` otherwise (unchanged for that case).

- [ ] **Step 1: Fix the now-wrong test and add a new one**

`test/integration/auth.test.js`'s `'GET /auth/callback with a valid state logs the person in'` test (lines 48-72) logs in a person who **is** a Buchhaltung member (`/api/groups/10/members` replies with `{ data: [{ personId: 7 }] }`) and currently asserts `res.headers.location === '/'`. That assertion is about to become wrong — this exact person is the case this task changes. Rename the test and fix its assertion. Replace:

```javascript
test('GET /auth/callback with a valid state logs the person in', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');

  const person = getPersonById(db, '7');
  assert.equal(person.vorname, 'Max');
  assert.deepEqual(person.gruppen, ['10']);
  db.close();
});
```

with:

```javascript
test('GET /auth/callback logs the person in and redirects straight to /pool for a Buchhaltung member', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');

  const person = getPersonById(db, '7');
  assert.equal(person.vorname, 'Max');
  assert.deepEqual(person.gruppen, ['10']);
  db.close();
});
```

Add a new test after it for the Portal-Admin (not Buchhaltung) case:

```javascript
test('GET /auth/callback redirects a Portal-Admin (not also Buchhaltung) straight to /pool', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 20, firstName: 'Portal', lastName: 'Admin', email: 'portaladmin@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 20 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');

  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pool');
  db.close();
});
```

The `'GET /auth/callback creates a session and a person even when the person belongs to no relevant group (AUTH-WIDEN-1)'` test already asserts `res.headers.location === '/'` for a person in neither group — that assertion stays correct under this task's change and needs no edit; it already covers the "neither group → /" case this task must not regress.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="redirects straight to /pool|Portal-Admin \(not also Buchhaltung\)"`
Expected: FAIL — the current code always redirects to `/`.

- [ ] **Step 3: Implement**

In `src/routes/auth.js`, change the end of the `/callback` handler from:

```javascript
      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      // Regenerate the session on login (not just reuse the pre-login one) to prevent session
      // fixation: a session ID issued before authentication must never become a valid,
      // authenticated session ID after it. Nothing from the pre-login session is needed past
      // this point — oauthState was already consumed above.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.personId = String(profile.id);
        res.redirect('/');
      });
      return;
```

to:

```javascript
      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      // Phase F: skip the extra click through the home page for the common case — a person who
      // can actually do something on /pool (Buchhaltung or Portal-Admin) is sent there directly.
      // Freigeber1/2 and their Stellvertreter (AUTH-WIDEN-1, no group membership required) still
      // land on / as before, since /pool would correctly 403 them.
      const kannPool =
        gruppen.includes(String(config.churchtools.groupIdBuchhaltung)) ||
        gruppen.includes(String(config.churchtools.groupIdAdmin));
      const zielUrl = kannPool ? '/pool' : '/';

      // Regenerate the session on login (not just reuse the pre-login one) to prevent session
      // fixation: a session ID issued before authentication must never become a valid,
      // authenticated session ID after it. Nothing from the pre-login session is needed past
      // this point — oauthState was already consumed above.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.personId = String(profile.id);
        res.redirect(zielUrl);
      });
      return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular re-run the `'GET /auth/callback regenerates the session on login...'` and `'...resolves group membership using the sync service token...'` tests in full — neither asserts a specific `location`, so both stay green unmodified even though the person they log in (a Buchhaltung member) now also redirects to `/pool`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.js test/integration/auth.test.js
git commit -m "feat(auth): redirect Buchhaltung/Portal-Admin members straight to /pool after login"
```

---

### Task 6: View-Behandlung Group A — home, pool, kontierung, freigabe2, abgelehnt, error

**Files:**
- Modify: `views/pool.ejs`
- Modify: `views/kontierung.ejs`
- Modify: `views/freigabe2.ejs`
- Modify: `views/abgelehnt.ejs`
- Modify: `views/error.ejs`
- Test: `test/integration/poolPage.test.js`
- Test: `test/integration/app.test.js`

**Interfaces:**
- Consumes: `branding.bsThemeAttr` (Task 2), Bootstrap assets (Task 1). `home.ejs` was already fully handled in Task 3.
- Produces: nothing new for later tasks — this task is purely presentational. No save-confirmation applies to any of these five views (none of their POST routes redirect to themselves with an admin-settings "save" semantic — `kontierung`/`freigabe2` redirect onward to `/pool` or the next job, `abgelehnt` redirects to `/kontierung/:id`).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/app.test.js`, after the `'GET /vendor/bootstrap/bootstrap.bundle.min.js is served as a static asset'` test:

```javascript
test('every top-level view carries a viewport meta tag', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const homeRes = await request(app).get('/');
  assert.match(homeRes.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  const errorRes = await request(app).get('/nonexistent-route-xyz');
  assert.match(errorRes.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  db.close();
});
```

Add to `test/integration/poolPage.test.js`, after its first test (check the file's existing `buildTestApp`/seed helpers and reuse them rather than redefining):

```javascript
test('GET /pool carries a viewport meta tag and wraps the Pool table in table-responsive', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/pool').set('x-test-person-id', '1');
  assert.match(res.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(res.text, /<div class="table-responsive">/);
  db.close();
});
```

(If `test/integration/poolPage.test.js`'s existing helper functions have different names than `buildTestApp`/a person id of `'1'`, read the file first and reuse whatever it already defines — don't introduce a second, differently-shaped test app builder in the same file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="viewport meta tag|table-responsive"`
Expected: FAIL — none of the current views have a `<meta name="viewport">` tag or a `table-responsive` wrapper.

- [ ] **Step 3: Implement**

Replace `views/pool.ejs` in full (every ID/class the inline `<script>` block depends on — `#preview-dialog`, `#preview-dialog-close`, `#preview-frame`, `.thumbnail-preview`, `.beanspruchen-btn`, the dynamic `pool-row-<id>` id — is preserved verbatim):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Aufgaben — Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container py-4">
    <h1>Aufgaben</h1>

    <h2 class="h4 mt-4">Pool</h2>
    <% if (poolJobs.length === 0) { %>
      <p>Keine offenen Rechnungen im Pool.</p>
    <% } else { %>
      <div class="table-responsive">
        <table class="table align-middle">
          <thead><tr><th>Vorschau</th><th>Dateiname</th><th>Eingang</th><th></th></tr></thead>
          <tbody>
            <% poolJobs.forEach((job) => { %>
              <tr id="pool-row-<%= job.id %>">
                <td>
                  <% if (job.thumbnail_pfad) { %>
                    <img class="thumbnail-preview" src="/api/pool/<%= job.id %>/thumbnail" data-preview-url="<%= job.previewUrl %>" alt="Vorschau" height="60" style="cursor:pointer">
                  <% } else { %>
                    <span class="thumbnail-placeholder text-muted">Keine Vorschau</span>
                  <% } %>
                </td>
                <td><%= job.dateiname %></td>
                <td><%= job.eingang_am %></td>
                <td><button type="button" class="beanspruchen-btn btn btn-primary btn-sm" data-job-id="<%= job.id %>">Beanspruchen</button></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    <% } %>

    <h2 class="h4 mt-4">Meine offenen Kontierungen</h2>
    <% if (meineKontierungen.length === 0) { %>
      <p>Keine offenen Kontierungen.</p>
    <% } else { %>
      <ul class="list-group mb-3">
        <% meineKontierungen.forEach((job) => { %>
          <li class="list-group-item"><a href="/kontierung/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
        <% }) %>
      </ul>
    <% } %>

    <h2 class="h4 mt-4">Meine Freigaben</h2>
    <% if (meineFreigaben.length === 0) { %>
      <p>Keine offenen Freigaben.</p>
    <% } else { %>
      <ul class="list-group mb-3">
        <% meineFreigaben.forEach((job) => { %>
          <li class="list-group-item"><a href="/freigabe2/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
        <% }) %>
      </ul>
    <% } %>

    <h2 class="h4 mt-4">Meine abgelehnten Jobs</h2>
    <% if (meineAbgelehnten.length === 0) { %>
      <p>Keine abgelehnten Rechnungen.</p>
    <% } else { %>
      <ul class="list-group mb-3">
        <% meineAbgelehnten.forEach((job) => { %>
          <li class="list-group-item"><a href="/abgelehnt/<%= job.id %>"><%= job.dateiname %></a> (Eingang <%= job.eingang_am %>)</li>
        <% }) %>
      </ul>
    <% } %>

    <dialog id="preview-dialog" class="p-0 border-0 rounded">
      <div class="d-flex justify-content-end p-2 bg-body border-bottom">
        <button type="button" id="preview-dialog-close" class="btn btn-outline-secondary btn-sm">Schließen</button>
      </div>
      <iframe id="preview-frame" src="" style="width:80vw;height:80vh;border:none"></iframe>
    </dialog>
  </main>

  <script>
    document.querySelectorAll('.beanspruchen-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.jobId;
        const res = await fetch(`/api/pool/${id}/beanspruchen`, { method: 'POST' });
        if (res.ok) {
          window.location.href = `/kontierung/${id}`;
          return;
        }
        const body = await res.json().catch(() => ({}));
        const row = document.getElementById(`pool-row-${id}`);
        if (row) {
          const msg = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 4;
          cell.textContent = body.error || 'Job ist nicht mehr verfügbar.';
          msg.appendChild(cell);
          row.replaceWith(msg);
        }
      });
    });

    document.querySelectorAll('.thumbnail-preview').forEach((img) => {
      img.addEventListener('click', () => {
        document.getElementById('preview-frame').src = img.dataset.previewUrl;
        document.getElementById('preview-dialog').showModal();
      });
    });
    document.getElementById('preview-dialog-close').addEventListener('click', () => {
      document.getElementById('preview-dialog').close();
      document.getElementById('preview-frame').src = '';
    });
  </script>
</body>
</html>
```

Replace `views/kontierung.ejs` in full (no inline `<script>` in this file — free to restructure form markup, add ids/labels):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Kontierung — Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container-fluid py-4">
    <h1>Kontierung: <%= job.dateiname %></h1>

    <iframe src="<%= previewUrl %>" class="w-100 border rounded mb-3" style="height:60vh"></iframe>

    <div class="card" style="max-width:40rem">
      <div class="card-body">
        <% if (errors.length > 0) { %>
          <div class="alert alert-danger">
            <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
          </div>
        <% } %>

        <form method="post" action="/kontierung/<%= job.id %>">
          <div class="mb-3">
            <label class="form-label" for="kontoId">Konto</label>
            <select class="form-select" id="kontoId" name="kontoId" required>
              <option value="">— wählen —</option>
              <% konten.forEach((k) => { %>
                <option value="<%= k.id %>" <%= String(k.id) === values.kontoId ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
              <% }) %>
            </select>
          </div>

          <div class="mb-3">
            <div class="form-check">
              <input class="form-check-input" type="radio" name="interessenskonflikt" id="konfliktNein" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>>
              <label class="form-check-label" for="konfliktNein">Kein Interessenskonflikt</label>
            </div>
            <div class="form-check">
              <input class="form-check-input" type="radio" name="interessenskonflikt" id="konfliktJa" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>>
              <label class="form-check-label" for="konfliktJa">Interessenskonflikt</label>
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label" for="begruendung">Begründung</label>
            <textarea class="form-control" id="begruendung" name="begruendung"><%= values.begruendung || '' %></textarea>
          </div>

          <button type="submit" class="btn btn-primary">Kontieren und Freigabe 1 erteilen</button>
        </form>

        <form method="post" action="/kontierung/<%= job.id %>/zurueck-in-pool" class="mt-3">
          <button type="submit" class="btn btn-outline-secondary">Zurück in den Pool legen</button>
        </form>
      </div>
    </div>
  </main>
</body>
</html>
```

Replace `views/freigabe2.ejs` in full (no inline `<script>` in this file):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Freigabe 2 — Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container-fluid py-4">
    <div class="row g-3">
      <div class="col-lg-6">
        <iframe src="<%= previewUrl %>" class="w-100 border rounded" style="height:85vh"></iframe>
      </div>
      <div class="col-lg-6 col-xl-4">
        <div class="card">
          <div class="card-body">
            <h1 class="h3">Freigabe 2</h1>
            <p><strong>Konto:</strong> <%= konto.kontonummer %> — <%= konto.bezeichnung %></p>
            <p><strong>Freigeber 1:</strong> <%= freigeber1Person.vorname %> <%= freigeber1Person.nachname %></p>
            <p><strong>Interessenskonflikt Freigeber 1:</strong> <%= freigabe1.interessenskonflikt ? 'Ja' : 'Nein' %></p>
            <% if (freigabe1.kommentar) { %><p><strong>Begründung:</strong> <%= freigabe1.kommentar %></p><% } %>

            <% if (errors.length > 0) { %>
              <div class="alert alert-danger">
                <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
              </div>
            <% } %>

            <form method="post" action="/freigabe2/<%= job.id %>">
              <div class="mb-3">
                <div class="form-check">
                  <input class="form-check-input" type="radio" name="interessenskonflikt" id="f2konfliktNein" value="nein" <%= values.interessenskonflikt !== 'ja' ? 'checked' : '' %>>
                  <label class="form-check-label" for="f2konfliktNein">Kein Interessenskonflikt</label>
                </div>
                <div class="form-check">
                  <input class="form-check-input" type="radio" name="interessenskonflikt" id="f2konfliktJa" value="ja" <%= values.interessenskonflikt === 'ja' ? 'checked' : '' %>>
                  <label class="form-check-label" for="f2konfliktJa">Interessenskonflikt</label>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label" for="f2begruendung">Begründung (bei Interessenskonflikt oder Ablehnung Pflicht)</label>
                <textarea class="form-control" id="f2begruendung" name="begruendung"><%= values.begruendung || '' %></textarea>
              </div>
              <button type="submit" name="aktion" value="freigeben" class="btn btn-primary me-2">Freigeben</button>
              <button type="submit" name="aktion" value="ablehnen" class="btn btn-outline-danger">Ablehnen</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>
```

Replace `views/abgelehnt.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Abgelehnt — Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container py-4">
    <h1>Abgelehnt: <%= job.dateiname %></h1>
    <p><strong>Abgelehnt von:</strong> <%= abgelehntVonPerson ? `${abgelehntVonPerson.vorname} ${abgelehntVonPerson.nachname}` : 'Unbekannt' %></p>
    <p><strong>Grund:</strong> <%= job.ablehnungsgrund %></p>
    <p><strong>Zeitpunkt:</strong> <%= ablehnung ? ablehnung.zeitpunkt : 'Unbekannt' %></p>
    <form method="post" action="/abgelehnt/<%= job.id %>/ueberarbeiten">
      <button type="submit" class="btn btn-primary">Überarbeiten</button>
    </form>
  </main>
</body>
</html>
```

Replace `views/error.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Fehler — Freigabeportal</title>
</head>
<body>
  <%- include('_header') %>
  <main class="container py-4">
    <h1>Es ist ein Fehler aufgetreten</h1>
    <p class="alert alert-danger"><%= message %></p>
    <p><a href="/" class="btn btn-outline-secondary">Zurück zur Startseite</a></p>
  </main>
</body>
</html>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular re-run `test/integration/poolPage.test.js`, `test/integration/kontierung.test.js`, `test/integration/freigabe2.test.js`, and `test/integration/ablehnung.test.js` in full — every existing text/href assertion in those files must still match (all data values, hrefs, and button labels were preserved verbatim, only wrapped in new Bootstrap markup).

- [ ] **Step 5: Commit**

```bash
git add views/pool.ejs views/kontierung.ejs views/freigabe2.ejs views/abgelehnt.ejs views/error.ejs test/integration/poolPage.test.js test/integration/app.test.js
git commit -m "feat(ui): apply Bootstrap classes and viewport meta to pool/kontierung/freigabe2/abgelehnt/error views"
```

---

### Task 7: View-Behandlung + Speichern-Rückmeldung Group B — Konten, Zuweisungsregeln, Personen

**Files:**
- Modify: `src/routes/admin/konten.js`
- Modify: `src/routes/admin/zuweisungsregeln.js`
- Modify: `views/admin/konten-liste.ejs`
- Modify: `views/admin/konten-form.ejs`
- Modify: `views/admin/zuweisungsregeln-liste.ejs`
- Modify: `views/admin/zuweisungsregeln-form.ejs`
- Modify: `views/admin/personen-liste.ejs`
- Test: `test/integration/admin/konten.test.js`
- Test: `test/integration/admin/zuweisungsregeln.test.js`

**Interfaces:**
- Produces: `POST /admin/konten` and `POST /admin/konten/:id` redirect to `/admin/konten?gespeichert=1` on success (unchanged on the `400` validation-failure path). `POST /admin/zuweisungsregeln` and `POST /admin/zuweisungsregeln/:id` redirect to `/admin/zuweisungsregeln?gespeichert=1` on success. `GET /admin/konten` and `GET /admin/zuweisungsregeln` both now pass `gespeichert: req.query.gespeichert === '1'` to their view. `POST /admin/konten/:id/deaktivieren` and `POST /admin/zuweisungsregeln/:id/loeschen` are unchanged — not in the spec's list of save-confirmation actions.

- [ ] **Step 1: Write the failing tests**

In `test/integration/admin/konten.test.js`, extend the existing `'POST /admin/konten with valid data creates a Konto and redirects'` test (add one assertion) and the existing update test, and add one new rendering test.

Change:

```javascript
test('POST /admin/konten with valid data creates a Konto and redirects', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(res.status, 302);
  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.match(listRes.text, /Unterhalt/);
  db.close();
});
```

to:

```javascript
test('POST /admin/konten with valid data creates a Konto and redirects with a gespeichert marker', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/konten?gespeichert=1');
  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.match(listRes.text, /Unterhalt/);
  db.close();
});
```

In the `'GET /admin/konten/:id/bearbeiten pre-fills the form, POST /admin/konten/:id updates it'` test, add one assertion right after `assert.equal(updateRes.status, 302);`:

```javascript
  const updateRes = await request(app)
    .post(`/admin/konten/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3001', bezeichnung: 'Unterhalt neu', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(updateRes.status, 302);
  assert.equal(updateRes.headers.location, '/admin/konten?gespeichert=1');
```

Add a new test at the end of the file:

```javascript
test('GET /admin/konten?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/konten?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});
```

In `test/integration/admin/zuweisungsregeln.test.js`, apply the same pattern. Change:

```javascript
test('POST /admin/zuweisungsregeln with valid data creates a rule and redirects', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zuweisungsregeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  assert.equal(res.status, 302);
  const listRes = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.match(listRes.text, /lieferant\.ch/);
  db.close();
});
```

to:

```javascript
test('POST /admin/zuweisungsregeln with valid data creates a rule and redirects with a gespeichert marker', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/zuweisungsregeln')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/zuweisungsregeln?gespeichert=1');
  const listRes = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.match(listRes.text, /lieferant\.ch/);
  db.close();
});
```

In `'edit and delete a Zuweisungsregel'`, add an assertion right after `assert.equal(updateRes.status, 302);`:

```javascript
  const updateRes = await request(app)
    .post(`/admin/zuweisungsregeln/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'rechnungen@lieferant.ch', kontoId: String(kontoId) });
  assert.equal(updateRes.status, 302);
  assert.equal(updateRes.headers.location, '/admin/zuweisungsregeln?gespeichert=1');
```

Add a new test at the end of the file:

```javascript
test('GET /admin/zuweisungsregeln?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedKonto(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/zuweisungsregeln?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="gespeichert marker|save confirmation"`
Expected: FAIL — the redirects don't carry `?gespeichert=1` yet, and neither view renders "Gespeichert." at all yet.

- [ ] **Step 3: Implement**

Replace `src/routes/admin/konten.js` in full:

```javascript
import { Router } from 'express';
import { createKonto, updateKonto, deactivateKonto, getKontoById, listKonten, validateKontoRoles } from '../../db/kontenRepo.js';
import { listActivePersons, getPersonById } from '../../db/personenRepo.js';

function personDisplayName(db, id) {
  const person = getPersonById(db, id);
  return person ? `${person.vorname} ${person.nachname}` : String(id);
}

function readRoleFields(body) {
  return {
    kontonummer: body.kontonummer,
    bezeichnung: body.bezeichnung,
    freigeber1Id: body.freigeber1Id,
    stellvertreter1Id: body.stellvertreter1Id,
    freigeber2Id: body.freigeber2Id,
    stellvertreter2Id: body.stellvertreter2Id,
  };
}

export function createKontenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const zeigtAlle = req.query.alle === '1';
    const konten = listKonten(db, { includeInactive: zeigtAlle }).map((konto) => ({
      ...konto,
      freigeber1Name: personDisplayName(db, konto.freigeber1_id),
      freigeber2Name: personDisplayName(db, konto.freigeber2_id),
    }));
    res.render('admin/konten-liste', { konten, zeigtAlle, gespeichert: req.query.gespeichert === '1' });
  });

  router.get('/neu', (req, res) => {
    res.render('admin/konten-form', { konto: null, values: {}, errors: [], personen: listActivePersons(db) });
  });

  router.post('/', (req, res) => {
    const values = readRoleFields(req.body);
    const errors = validateKontoRoles(db, values);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { konto: null, values, errors, personen: listActivePersons(db) });
    }

    createKonto(db, values);
    res.redirect('/admin/konten?gespeichert=1');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const konto = getKontoById(db, Number(req.params.id));
    if (!konto) {
      return res.status(404).render('error', { message: 'Konto nicht gefunden.' });
    }
    res.render('admin/konten-form', {
      konto,
      values: {
        kontonummer: konto.kontonummer,
        bezeichnung: konto.bezeichnung,
        freigeber1Id: konto.freigeber1_id,
        stellvertreter1Id: konto.stellvertreter1_id,
        freigeber2Id: konto.freigeber2_id,
        stellvertreter2Id: konto.stellvertreter2_id,
      },
      errors: [],
      personen: listActivePersons(db),
    });
  });

  router.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const konto = getKontoById(db, id);
    if (!konto) {
      return res.status(404).render('error', { message: 'Konto nicht gefunden.' });
    }

    const values = readRoleFields(req.body);
    const existingRoles = {
      freigeber1Id: konto.freigeber1_id,
      stellvertreter1Id: konto.stellvertreter1_id,
      freigeber2Id: konto.freigeber2_id,
      stellvertreter2Id: konto.stellvertreter2_id,
    };
    const errors = validateKontoRoles(db, values, existingRoles);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { konto, values, errors, personen: listActivePersons(db) });
    }

    updateKonto(db, id, values);
    res.redirect('/admin/konten?gespeichert=1');
  });

  router.post('/:id/deaktivieren', (req, res) => {
    deactivateKonto(db, Number(req.params.id));
    res.redirect('/admin/konten');
  });

  return router;
}
```

Replace `src/routes/admin/zuweisungsregeln.js` in full:

```javascript
import { Router } from 'express';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../db/zuweisungsregelnRepo.js';
import { listKonten } from '../../db/kontenRepo.js';

const EMAIL_MUSTER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_MUSTER_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidAbsenderMuster(muster) {
  return muster.includes('@') ? EMAIL_MUSTER_PATTERN.test(muster) : DOMAIN_MUSTER_PATTERN.test(muster);
}

export function createZuweisungsregelnRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/zuweisungsregeln-liste', { regeln: listZuweisungsregeln(db), gespeichert: req.query.gespeichert === '1' });
  });

  router.get('/neu', (req, res) => {
    res.render('admin/zuweisungsregeln-form', { regel: null, values: {}, errors: [], konten: listKonten(db) });
  });

  router.post('/', (req, res) => {
    const { absenderMuster, kontoId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kontoId) errors.push('Konto ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    if (absenderMuster && findZuweisungsregelByMuster(db, absenderMuster)) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel: null, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    createZuweisungsregel(db, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln?gespeichert=1');
  });

  router.get('/:id/bearbeiten', (req, res) => {
    const regel = getZuweisungsregelById(db, Number(req.params.id));
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }
    res.render('admin/zuweisungsregeln-form', {
      regel,
      values: { absenderMuster: regel.absender_muster, kontoId: regel.konto_id },
      errors: [],
      konten: listKonten(db),
    });
  });

  router.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    const regel = getZuweisungsregelById(db, id);
    if (!regel) {
      return res.status(404).render('error', { message: 'Zuweisungsregel nicht gefunden.' });
    }

    const { absenderMuster, kontoId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kontoId) errors.push('Konto ist ein Pflichtfeld.');
    if (absenderMuster && !isValidAbsenderMuster(absenderMuster)) {
      errors.push('Absender-Muster muss eine gültige E-Mail-Adresse oder Domain sein (z. B. "lieferant.ch" oder "rechnung@lieferant.ch").');
    }
    const existing = absenderMuster ? findZuweisungsregelByMuster(db, absenderMuster) : null;
    if (existing && existing.id !== id) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln?gespeichert=1');
  });

  router.post('/:id/loeschen', (req, res) => {
    deleteZuweisungsregel(db, Number(req.params.id));
    res.redirect('/admin/zuweisungsregeln');
  });

  return router;
}
```

Replace `views/admin/konten-liste.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Konten — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Konten</h1>
    <% if (gespeichert) { %>
      <div class="alert alert-success alert-dismissible fade show" role="alert">
        Gespeichert.
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Schließen"></button>
      </div>
    <% } %>
    <p><a href="/admin/konten/neu" class="btn btn-primary btn-sm">Neues Konto anlegen</a></p>
    <p>
      <% if (zeigtAlle) { %>
        <a href="/admin/konten">Nur aktive Konten anzeigen</a>
      <% } else { %>
        <a href="/admin/konten?alle=1">Auch inaktive Konten anzeigen</a>
      <% } %>
    </p>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead>
          <tr><th>Kontonummer</th><th>Bezeichnung</th><th>Freigeber 1</th><th>Freigeber 2</th><th>Aktiv</th><th></th></tr>
        </thead>
        <tbody>
          <% konten.forEach((konto) => { %>
            <tr>
              <td><%= konto.kontonummer %></td>
              <td><%= konto.bezeichnung %></td>
              <td><%= konto.freigeber1Name %></td>
              <td><%= konto.freigeber2Name %></td>
              <td><%= konto.aktiv ? 'Ja' : 'Nein' %></td>
              <td>
                <a href="/admin/konten/<%= konto.id %>/bearbeiten" class="btn btn-outline-secondary btn-sm">Bearbeiten</a>
                <form method="post" action="/admin/konten/<%= konto.id %>/deaktivieren" class="d-inline">
                  <button type="submit" class="btn btn-outline-danger btn-sm">Deaktivieren</button>
                </form>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
```

Replace `views/admin/konten-form.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Konto — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1><%= konto ? 'Konto bearbeiten' : 'Neues Konto' %></h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <form method="post" action="<%= konto ? `/admin/konten/${konto.id}` : '/admin/konten' %>" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="kontonummer">Kontonummer</label>
        <input type="text" class="form-control" id="kontonummer" name="kontonummer" value="<%= values.kontonummer || '' %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="bezeichnung">Bezeichnung</label>
        <input type="text" class="form-control" id="bezeichnung" name="bezeichnung" value="<%= values.bezeichnung || '' %>" required>
      </div>

      <div class="mb-3">
        <label class="form-label" for="freigeber1Id">Freigeber 1</label>
        <select class="form-select" id="freigeber1Id" name="freigeber1Id" required>
          <option value="">— wählen —</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.churchtools_person_id %>" <%= values.freigeber1Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
          <% }) %>
        </select>
      </div>

      <div class="mb-3">
        <label class="form-label" for="stellvertreter1Id">Stellvertreter 1</label>
        <select class="form-select" id="stellvertreter1Id" name="stellvertreter1Id" required>
          <option value="">— wählen —</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.churchtools_person_id %>" <%= values.stellvertreter1Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
          <% }) %>
        </select>
      </div>

      <div class="mb-3">
        <label class="form-label" for="freigeber2Id">Freigeber 2</label>
        <select class="form-select" id="freigeber2Id" name="freigeber2Id" required>
          <option value="">— wählen —</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.churchtools_person_id %>" <%= values.freigeber2Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
          <% }) %>
        </select>
      </div>

      <div class="mb-3">
        <label class="form-label" for="stellvertreter2Id">Stellvertreter 2</label>
        <select class="form-select" id="stellvertreter2Id" name="stellvertreter2Id" required>
          <option value="">— wählen —</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.churchtools_person_id %>" <%= values.stellvertreter2Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
          <% }) %>
        </select>
      </div>

      <button type="submit" class="btn btn-primary">Speichern</button>
    </form>
  </main>
</body>
</html>
```

Replace `views/admin/zuweisungsregeln-liste.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Zuweisungsregeln — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Zuweisungsregeln</h1>
    <% if (gespeichert) { %>
      <div class="alert alert-success alert-dismissible fade show" role="alert">
        Gespeichert.
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Schließen"></button>
      </div>
    <% } %>
    <p><a href="/admin/zuweisungsregeln/neu" class="btn btn-primary btn-sm">Neue Regel anlegen</a></p>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Absender-Muster</th><th>Konto</th><th></th></tr></thead>
        <tbody>
          <% regeln.forEach((regel) => { %>
            <tr>
              <td><%= regel.absender_muster %></td>
              <td><%= regel.konto_id %></td>
              <td>
                <a href="/admin/zuweisungsregeln/<%= regel.id %>/bearbeiten" class="btn btn-outline-secondary btn-sm">Bearbeiten</a>
                <form method="post" action="/admin/zuweisungsregeln/<%= regel.id %>/loeschen" class="d-inline">
                  <button type="submit" class="btn btn-outline-danger btn-sm">Löschen</button>
                </form>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
```

Replace `views/admin/zuweisungsregeln-form.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Zuweisungsregel — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1><%= regel ? 'Zuweisungsregel bearbeiten' : 'Neue Zuweisungsregel' %></h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <form method="post" action="<%= regel ? `/admin/zuweisungsregeln/${regel.id}` : '/admin/zuweisungsregeln' %>" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="absenderMuster">Absender-Muster (volle E-Mail-Adresse oder Domain)</label>
        <input type="text" class="form-control" id="absenderMuster" name="absenderMuster" value="<%= values.absenderMuster || '' %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="kontoId">Konto</label>
        <select class="form-select" id="kontoId" name="kontoId" required>
          <option value="">— wählen —</option>
          <% konten.forEach((k) => { %>
            <option value="<%= k.id %>" <%= String(values.kontoId) === String(k.id) ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
          <% }) %>
        </select>
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </form>
  </main>
</body>
</html>
```

Replace `views/admin/personen-liste.ejs` in full (no save-confirmation — this view has no POST route):

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Personen — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Personen</h1>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Hinweis</th></tr></thead>
        <tbody>
          <% personen.forEach((p) => { %>
            <tr>
              <td><%= p.vorname %> <%= p.nachname %></td>
              <td><%= p.email %></td>
              <td><span class="badge <%= p.aktiv ? 'text-bg-success' : 'text-bg-secondary' %>"><%= p.aktiv ? 'Aktiv' : 'Inaktiv' %></span></td>
              <td><% if (p.ct_person_unresolved) { %><span class="text-warning">⚠️ Person in ChurchTools nicht auflösbar (nicht auflösbar)</span><% } %></td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green. In particular re-run `test/integration/admin/konten.test.js`, `test/integration/admin/zuweisungsregeln.test.js`, and `test/integration/admin/personen.test.js` in full.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/konten.js src/routes/admin/zuweisungsregeln.js views/admin/konten-liste.ejs views/admin/konten-form.ejs views/admin/zuweisungsregeln-liste.ejs views/admin/zuweisungsregeln-form.ejs views/admin/personen-liste.ejs test/integration/admin/konten.test.js test/integration/admin/zuweisungsregeln.test.js
git commit -m "feat(ui): Bootstrap-ize Konten/Zuweisungsregeln/Personen views, add save confirmation"
```

---

### Task 8: View-Behandlung + Speichern-Rückmeldung Group C — Eskalation, Erscheinungsbild, PDF-Einstellungen, Sync, Mails

**Files:**
- Modify: `src/routes/admin/eskalation.js`
- Modify: `src/routes/admin/erscheinungsbild.js`
- Modify: `src/routes/admin/pdf-einstellungen.js`
- Modify: `src/routes/admin/sync.js`
- Modify: `src/routes/admin/mails.js`
- Modify: `views/admin/eskalation-form.ejs`
- Modify: `views/admin/erscheinungsbild-form.ejs`
- Modify: `views/admin/pdf-einstellungen-form.ejs`
- Modify: `views/admin/sync.ejs`
- Modify: `views/admin/mails.ejs`
- Test: `test/integration/admin/eskalation.test.js`
- Test: `test/integration/admin/erscheinungsbild.test.js`
- Test: `test/integration/admin/pdf-einstellungen.test.js`
- Test: `test/integration/admin/sync.test.js`
- Test: `test/integration/admin/mails.test.js`

**Interfaces:**
- Produces: `POST /admin/eskalation`, `POST /admin/erscheinungsbild`, `POST /admin/pdf-einstellungen`, `POST /admin/sync` all redirect to their own path with `?gespeichert=1` on success (unchanged on `400` validation failure). `POST /admin/mails/:id/erneut-versenden` redirects to `/admin/mails?gespeichert=1`. `POST /admin/sync/stalled/:jobId/freigeben` is unchanged — not in the spec's list.

- [ ] **Step 1: Write the failing tests**

In `test/integration/admin/eskalation.test.js`, add an assertion to the existing success test and one new rendering test:

```javascript
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
  assert.equal(res.headers.location, '/admin/eskalation?gespeichert=1');
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '36');
  assert.equal(getConfigValue(db, 'reminder_empfaenger'), 'gruppe:buchhaltung');
  assert.equal(getConfigValue(db, 'eskalation_empfaenger'), 'kirchenpflege@musterkirche.ch\ngruppe:buchhaltung');
  db.close();
});

test('GET /admin/eskalation?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/eskalation?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/eskalation').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});
```

In `test/integration/admin/erscheinungsbild.test.js`:

```javascript
test('POST /admin/erscheinungsbild with valid colors and theme persists them, no file', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#123456')
    .field('secondaryColor', '#abcdef')
    .field('themeDefault', 'dunkel');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/erscheinungsbild?gespeichert=1');
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#123456');
  assert.equal(getConfigValue(db, 'branding_theme_default'), 'dunkel');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('GET /admin/erscheinungsbild?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  const withMarker = await request(app).get('/admin/erscheinungsbild?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/erscheinungsbild').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
```

(Reuse whatever `mkdtempSync`/`join`/`tmpdir`/`rmSync` imports the file already has at its top — don't add duplicate imports.)

In `test/integration/admin/pdf-einstellungen.test.js`:

```javascript
test('POST /admin/pdf-einstellungen with "erste" persists it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/pdf-einstellungen')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ visumSeitePosition: 'erste' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/pdf-einstellungen?gespeichert=1');
  assert.equal(getConfigValue(db, 'visum_seite_position'), 'erste');
  db.close();
});

test('GET /admin/pdf-einstellungen?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/pdf-einstellungen?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/pdf-einstellungen').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});
```

In `test/integration/admin/sync.test.js`:

```javascript
test('POST /admin/sync updates the three config values', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/sync')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ maxDeaktivierungProzent: '40', maxDeaktivierungAnzahl: '5', syncFehlerEmpfaenger: 'gruppe:admin' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/sync?gespeichert=1');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '40');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_anzahl'), '5');
  db.close();
});

test('GET /admin/sync?gespeichert=1 shows the save confirmation; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/sync?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Gespeichert\./);
  const withoutMarker = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Gespeichert\./);
  db.close();
});
```

In `test/integration/admin/mails.test.js`:

```javascript
test('POST /admin/mails/:id/erneut-versenden resends and appends a new versendet row', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const id = logMailAttempt(db, { typ: 'reminder', jobId: null, empfaenger: 'x@example.org', betreff: 'B', text: 'T', status: 'fehlgeschlagen', fehlerDetails: 'SMTP down' });
  const mailer = createStubMailer();
  const app = buildTestApp(db, mailer);

  const res = await request(app).post(`/admin/mails/${id}/erneut-versenden`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/mails?gespeichert=1');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'x@example.org');

  const rows = listMailLog(db);
  assert.equal(rows.length, 2, 'the original failed row stays, a new row is appended');
  assert.equal(rows[0].status, 'versendet', 'the newest row (retry) is versendet');
  db.close();
});

test('GET /admin/mails?gespeichert=1 shows "Erneut gesendet."; without it, it does not', async () => {
  const db = openDatabase(':memory:');
  seedAdmin(db);
  const app = buildTestApp(db);
  const withMarker = await request(app).get('/admin/mails?gespeichert=1').set('x-test-person-id', '99');
  assert.match(withMarker.text, /Erneut gesendet\./);
  const withoutMarker = await request(app).get('/admin/mails').set('x-test-person-id', '99');
  assert.doesNotMatch(withoutMarker.text, /Erneut gesendet\./);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="gespeichert marker|save confirmation|Erneut gesendet"`
Expected: FAIL — none of the five redirects carry `?gespeichert=1` yet, and none of the five views render a confirmation.

- [ ] **Step 3: Implement**

Replace `src/routes/admin/eskalation.js` in full:

```javascript
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Both group tokens are accepted here (not just "gruppe:buchhaltung") because this validator is
// shared with the /admin/sync route, whose "Sync-Fehler-Empfänger" field defaults to
// "gruppe:admin" — see adminConfigRepo's seeded default and notify.js's resolveEmpfaenger, which
// already resolves both tokens.
const GRUPPE_TOKENS = ['gruppe:buchhaltung', 'gruppe:admin'];

export function validateEmpfaengerListe(value, label, errors) {
  const zeilen = (value || '')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
  if (zeilen.length === 0) {
    errors.push(`${label} braucht mindestens ein Ziel.`);
    return;
  }
  for (const zeile of zeilen) {
    if (!GRUPPE_TOKENS.includes(zeile) && !EMAIL_PATTERN.test(zeile)) {
      errors.push(`${label}: "${zeile}" ist weder eine gültige E-Mail-Adresse noch "${GRUPPE_TOKENS.join('"/"')}".`);
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
      gespeichert: req.query.gespeichert === '1',
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
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, reminderEmpfaenger, eskalationEmpfaenger, errors, gespeichert: false });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'reminder_empfaenger', reminderEmpfaenger.trim());
    setConfigValue(db, 'eskalation_empfaenger', eskalationEmpfaenger.trim());
    res.redirect('/admin/eskalation?gespeichert=1');
  });

  return router;
}
```

Replace `src/routes/admin/erscheinungsbild.js` in full:

```javascript
import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const VALID_THEME_DEFAULTS = new Set(['hell', 'dunkel', 'system']);
const ALLOWED_MIMETYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Sniffs the actual file-signature bytes so a mislabeled upload (e.g. an SVG
// renamed to logo.png with a spoofed `Content-Type: image/png`) is caught
// even though multer's `file.mimetype` is just the client-declared header.
function detectImageMimetype(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export function createErscheinungsbildRouter({ db, config }) {
  const router = Router();

  function currentState() {
    return {
      primaryColor: getConfigValue(db, 'branding_farbe_primaer'),
      secondaryColor: getConfigValue(db, 'branding_farbe_sekundaer'),
      themeDefault: getConfigValue(db, 'branding_theme_default'),
      hasLogo: Boolean(getConfigValue(db, 'branding_logo_pfad')),
    };
  }

  router.get('/', (req, res) => {
    res.render('admin/erscheinungsbild-form', { ...currentState(), errors: [], gespeichert: req.query.gespeichert === '1' });
  });

  router.post('/', (req, res) => {
    upload.single('logo')(req, res, (uploadErr) => {
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Die Logo-Datei darf höchstens 2 MB gross sein.' : 'Fehler beim Datei-Upload.';
        return res.status(400).render('admin/erscheinungsbild-form', {
          primaryColor: req.body.primaryColor,
          secondaryColor: req.body.secondaryColor,
          themeDefault: req.body.themeDefault,
          hasLogo: currentState().hasLogo,
          errors: [message],
          gespeichert: false,
        });
      }

      const { primaryColor, secondaryColor, themeDefault } = req.body;
      const errors = [];
      if (!HEX_COLOR_PATTERN.test(primaryColor || '')) errors.push('Primärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #2f4858).');
      if (!HEX_COLOR_PATTERN.test(secondaryColor || '')) errors.push('Sekundärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #4d7ea8).');
      if (!VALID_THEME_DEFAULTS.has(themeDefault)) errors.push('Ungültiger Standard-Farbmodus.');
      if (req.file) {
        const detectedMimetype = detectImageMimetype(req.file.buffer);
        if (!ALLOWED_MIMETYPES[req.file.mimetype] || !detectedMimetype || detectedMimetype !== req.file.mimetype) {
          errors.push('Logo muss eine PNG- oder JPEG-Datei sein.');
        }
      }

      if (errors.length > 0) {
        return res.status(400).render('admin/erscheinungsbild-form', {
          primaryColor,
          secondaryColor,
          themeDefault,
          hasLogo: currentState().hasLogo,
          errors,
          gespeichert: false,
        });
      }

      setConfigValue(db, 'branding_farbe_primaer', primaryColor);
      setConfigValue(db, 'branding_farbe_sekundaer', secondaryColor);
      setConfigValue(db, 'branding_theme_default', themeDefault);

      if (req.file) {
        const ext = ALLOWED_MIMETYPES[req.file.mimetype];
        const oldPfad = getConfigValue(db, 'branding_logo_pfad');
        if (oldPfad && existsSync(oldPfad)) {
          unlinkSync(oldPfad);
        }
        mkdirSync(config.brandingDir, { recursive: true });
        const neuerPfad = join(config.brandingDir, `logo.${ext}`);
        writeFileSync(neuerPfad, req.file.buffer);
        setConfigValue(db, 'branding_logo_pfad', neuerPfad);
        setConfigValue(db, 'branding_logo_mimetype', req.file.mimetype);
      }

      res.redirect('/admin/erscheinungsbild?gespeichert=1');
    });
  });

  return router;
}
```

Replace `src/routes/admin/pdf-einstellungen.js` in full:

```javascript
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const VALID_POSITIONEN = new Set(['erste', 'letzte']);

export function createPdfEinstellungenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/pdf-einstellungen-form', {
      visumSeitePosition: getConfigValue(db, 'visum_seite_position'),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
    const { visumSeitePosition } = req.body;

    if (!VALID_POSITIONEN.has(visumSeitePosition)) {
      return res.status(400).render('admin/pdf-einstellungen-form', {
        visumSeitePosition,
        errors: ['Position der Visum-Seite muss "erste" oder "letzte" sein.'],
        gespeichert: false,
      });
    }

    setConfigValue(db, 'visum_seite_position', visumSeitePosition);
    res.redirect('/admin/pdf-einstellungen?gespeichert=1');
  });

  return router;
}
```

Replace `src/routes/admin/sync.js` in full:

```javascript
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';
import { listRecentSyncLogs } from '../../db/syncLogRepo.js';
import { listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin } from '../../db/jobsRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { validateEmpfaengerListe } from './eskalation.js';

function ladeStalledJobsMitNamen(db) {
  return listStalledJobs(db).map(({ job, akteurId, grund }) => {
    const akteur = getPersonById(db, akteurId);
    return {
      job,
      akteurName: akteur ? `${akteur.vorname} ${akteur.nachname}` : akteurId,
      grund,
    };
  });
}

export function createSyncRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/sync', {
      maxDeaktivierungProzent: getConfigValue(db, 'sync_max_deaktivierung_prozent'),
      maxDeaktivierungAnzahl: getConfigValue(db, 'sync_max_deaktivierung_anzahl'),
      syncFehlerEmpfaenger: getConfigValue(db, 'sync_fehler_empfaenger'),
      syncLog: listRecentSyncLogs(db, 20),
      stalledJobs: ladeStalledJobsMitNamen(db),
      errors: [],
      gespeichert: req.query.gespeichert === '1',
    });
  });

  router.post('/', (req, res) => {
    const { maxDeaktivierungProzent, maxDeaktivierungAnzahl, syncFehlerEmpfaenger } = req.body;
    const errors = [];

    const prozentNum = Number(maxDeaktivierungProzent);
    const anzahlNum = Number(maxDeaktivierungAnzahl);
    if (!Number.isInteger(prozentNum) || prozentNum <= 0 || prozentNum > 100) {
      errors.push('Max. Deaktivierungs-Prozentsatz muss eine Ganzzahl zwischen 1 und 100 sein.');
    }
    if (!Number.isInteger(anzahlNum) || anzahlNum <= 0) {
      errors.push('Max. Deaktivierungs-Anzahl muss eine positive Ganzzahl sein.');
    }
    validateEmpfaengerListe(syncFehlerEmpfaenger, 'Sync-Fehler-Empfänger', errors);

    if (errors.length > 0) {
      return res.status(400).render('admin/sync', {
        maxDeaktivierungProzent,
        maxDeaktivierungAnzahl,
        syncFehlerEmpfaenger,
        syncLog: listRecentSyncLogs(db, 20),
        stalledJobs: ladeStalledJobsMitNamen(db),
        errors,
        gespeichert: false,
      });
    }

    setConfigValue(db, 'sync_max_deaktivierung_prozent', String(prozentNum));
    setConfigValue(db, 'sync_max_deaktivierung_anzahl', String(anzahlNum));
    setConfigValue(db, 'sync_fehler_empfaenger', syncFehlerEmpfaenger.trim());
    res.redirect('/admin/sync?gespeichert=1');
  });

  router.post('/stalled/:jobId/freigeben', (req, res) => {
    const jobId = Number(req.params.jobId);
    // Try the pool-release path first (covers zugewiesen/abgelehnt); if that's not the job's
    // status, fall back to the admin-escalation path (covers freigabe2). Exactly one of the two
    // can ever apply to a given status, so trying both in order is safe and needs no extra
    // status lookup here.
    if (!forceReleaseJob(db, jobId)) {
      forceEskalierenFreigabe2AnAdmin(db, jobId);
    }
    res.redirect('/admin/sync');
  });

  return router;
}
```

Replace `src/routes/admin/mails.js` in full:

```javascript
import { Router } from 'express';
import { listMailLog, getMailLogById } from '../../db/mailLogRepo.js';
import { sendNotification } from '../../services/notify.js';

export function createMailsRouter({ db, mailer }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/mails', { mails: listMailLog(db), gespeichert: req.query.gespeichert === '1' });
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
      res.redirect('/admin/mails?gespeichert=1');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

Replace `views/admin/eskalation-form.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Eskalationszeiten — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Eskalationszeiten</h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <form method="post" action="/admin/eskalation" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="reminderStunden">Reminder nach (Stunden)</label>
        <input type="number" class="form-control" id="reminderStunden" name="reminderStunden" value="<%= reminderStunden %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="eskalationStunden">Eskalation nach (Stunden)</label>
        <input type="number" class="form-control" id="eskalationStunden" name="eskalationStunden" value="<%= eskalationStunden %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="reminderEmpfaenger">Reminder-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:buchhaltung")</label>
        <textarea class="form-control" id="reminderEmpfaenger" name="reminderEmpfaenger" rows="4"><%= reminderEmpfaenger || '' %></textarea>
      </div>
      <div class="mb-3">
        <label class="form-label" for="eskalationEmpfaenger">Eskalations-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:buchhaltung")</label>
        <textarea class="form-control" id="eskalationEmpfaenger" name="eskalationEmpfaenger" rows="4"><%= eskalationEmpfaenger || '' %></textarea>
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 px-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close btn-close-sm ms-2" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>
  </main>
</body>
</html>
```

Replace `views/admin/erscheinungsbild-form.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Erscheinungsbild — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Erscheinungsbild</h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <% if (hasLogo) { %>
      <p>Aktuelles Logo: <img src="/branding/logo" alt="Aktuelles Logo" height="48"></p>
    <% } %>
    <form method="post" action="/admin/erscheinungsbild" enctype="multipart/form-data" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="primaryColor">Primärfarbe</label>
        <input type="color" class="form-control form-control-color" id="primaryColor" name="primaryColor" value="<%= primaryColor %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="secondaryColor">Sekundärfarbe</label>
        <input type="color" class="form-control form-control-color" id="secondaryColor" name="secondaryColor" value="<%= secondaryColor %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="themeDefault">Standard-Farbmodus</label>
        <select class="form-select" id="themeDefault" name="themeDefault">
          <option value="system" <%= themeDefault === 'system' ? 'selected' : '' %>>Folgt Geräteeinstellung</option>
          <option value="hell" <%= themeDefault === 'hell' ? 'selected' : '' %>>Hell</option>
          <option value="dunkel" <%= themeDefault === 'dunkel' ? 'selected' : '' %>>Dunkel</option>
        </select>
      </div>
      <div class="mb-3">
        <label class="form-label" for="logo">Logo (PNG oder JPEG, max. 2 MB)</label>
        <input type="file" class="form-control" id="logo" name="logo" accept="image/png,image/jpeg">
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 px-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close btn-close-sm ms-2" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>
  </main>
</body>
</html>
```

Replace `views/admin/pdf-einstellungen-form.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>PDF-Einstellungen — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>PDF-Einstellungen</h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>
    <form method="post" action="/admin/pdf-einstellungen" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="visumSeitePosition">Position der Visum-Seite im PDF</label>
        <select class="form-select" id="visumSeitePosition" name="visumSeitePosition">
          <option value="letzte" <%= visumSeitePosition === 'letzte' ? 'selected' : '' %>>Letzte Seite</option>
          <option value="erste" <%= visumSeitePosition === 'erste' ? 'selected' : '' %>>Erste Seite</option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 px-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close btn-close-sm ms-2" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>
  </main>
</body>
</html>
```

Replace `views/admin/sync.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Sync-Übersicht — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Sync-Übersicht</h1>
    <% if (errors.length > 0) { %>
      <div class="alert alert-danger">
        <ul class="mb-0"><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
      </div>
    <% } %>

    <h2 class="h4 mt-4">Massen-Deaktivierungs-Schutz</h2>
    <form method="post" action="/admin/sync" class="col-12 col-md-8 col-lg-6">
      <div class="mb-3">
        <label class="form-label" for="maxDeaktivierungProzent">Max. Deaktivierung (Prozent der aktiven Personen)</label>
        <input type="number" class="form-control" id="maxDeaktivierungProzent" name="maxDeaktivierungProzent" value="<%= maxDeaktivierungProzent %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="maxDeaktivierungAnzahl">Max. Deaktivierung (absolute Anzahl)</label>
        <input type="number" class="form-control" id="maxDeaktivierungAnzahl" name="maxDeaktivierungAnzahl" value="<%= maxDeaktivierungAnzahl %>" required>
      </div>
      <div class="mb-3">
        <label class="form-label" for="syncFehlerEmpfaenger">Sync-Fehler-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:admin")</label>
        <textarea class="form-control" id="syncFehlerEmpfaenger" name="syncFehlerEmpfaenger" rows="4"><%= syncFehlerEmpfaenger || '' %></textarea>
      </div>
      <button type="submit" class="btn btn-primary">Speichern</button>
      <% if (gespeichert) { %>
        <div class="alert alert-success alert-dismissible fade show d-inline-flex align-items-center py-1 px-2 ms-2 mb-0" role="alert">
          Gespeichert.
          <button type="button" class="btn-close btn-close-sm ms-2" data-bs-dismiss="alert" aria-label="Schließen"></button>
        </div>
      <% } %>
    </form>

    <h2 class="h4 mt-4">Sync-Historie</h2>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Gestartet</th><th>Beendet</th><th>Status</th><th>Upserted</th><th>Deaktiviert</th><th>Details</th></tr></thead>
        <tbody>
          <% syncLog.forEach((eintrag) => { %>
            <tr>
              <td><%= eintrag.gestartet_am %></td>
              <td><%= eintrag.beendet_am || '' %></td>
              <td><%= eintrag.status %></td>
              <td><%= eintrag.anzahl_upserted ?? '' %></td>
              <td><%= eintrag.anzahl_deaktiviert ?? '' %></td>
              <td><%= eintrag.fehler_details || '' %></td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>

    <h2 class="h4 mt-4">Feststeckende Jobs</h2>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Datei</th><th>Status</th><th>Verantwortliche Person</th><th>Grund</th><th></th></tr></thead>
        <tbody>
          <% stalledJobs.forEach((eintrag) => { %>
            <tr>
              <td><%= eintrag.job.dateiname %></td>
              <td><%= eintrag.job.status %></td>
              <td><%= eintrag.akteurName %></td>
              <td><%= eintrag.grund === 'inaktiv' ? 'Person deaktiviert' : 'Person in ChurchTools nicht auflösbar' %></td>
              <td>
                <form method="post" action="/admin/sync/stalled/<%= eintrag.job.id %>/freigeben">
                  <button type="submit" class="btn btn-outline-secondary btn-sm">Freigeben</button>
                </form>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
```

Replace `views/admin/mails.ejs` in full:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Mail-Protokoll — Freigabeportal Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Mail-Protokoll</h1>
    <% if (gespeichert) { %>
      <div class="alert alert-success alert-dismissible fade show" role="alert">
        Erneut gesendet.
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Schließen"></button>
      </div>
    <% } %>
    <div class="table-responsive">
      <table class="table align-middle">
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
                    <button type="submit" class="btn btn-outline-secondary btn-sm">Erneut versenden</button>
                  </form>
                <% } %>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, full suite green — this is the plan's final task, so a full green run here is the whole-branch acceptance signal.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/eskalation.js src/routes/admin/erscheinungsbild.js src/routes/admin/pdf-einstellungen.js src/routes/admin/sync.js src/routes/admin/mails.js views/admin/eskalation-form.ejs views/admin/erscheinungsbild-form.ejs views/admin/pdf-einstellungen-form.ejs views/admin/sync.ejs views/admin/mails.ejs test/integration/admin/eskalation.test.js test/integration/admin/erscheinungsbild.test.js test/integration/admin/pdf-einstellungen.test.js test/integration/admin/sync.test.js test/integration/admin/mails.test.js
git commit -m "feat(ui): Bootstrap-ize Eskalation/Erscheinungsbild/PDF/Sync/Mails views, add save confirmation"
```

---

## Self-Review Notes

**Spec coverage:**
- Bootstrap-Integration (self-hosted, no CDN, no build step) — Task 1.
- CSS-variable mapping of brand colors onto Bootstrap components — Task 3 (corrected from the spec's simplified description once the actual shipped CSS was inspected: literal per-component `--bs-btn-*`/`--bs-nav-tabs-*` properties are overridden directly, not just `--bs-primary`).
- Native `data-bs-theme` dark mode wired to the existing toggle — Task 3 (JS) + Task 2 (`branding.bsThemeAttr`) + every view touched in Tasks 3/6/7/8 (`<html>` tag).
- `GET /admin` dashboard — Task 4.
- Global nav-tabs (Aufgaben/Admin) — Task 3.
- Post-login auto-redirect to `/pool` — Task 5.
- Speichern-Rückmeldung across all 7 listed routes (`konten.js` ×2, `zuweisungsregeln.js` ×2, `eskalation.js`, `erscheinungsbild.js`, `pdf-einstellungen.js`, `sync.js`, `mails.js`'s resend action) — Tasks 7 and 8.
- View-Behandlung across all 16 pre-existing views + the new dashboard — Tasks 3, 6, 7, 8.
- Responsive design (viewport meta on all 17 views, `table-responsive` wrappers, responsive form/split-view grid, no separate mobile stylesheet) — addressed throughout Tasks 3, 6, 7, 8; the `kontierung.ejs`/`freigabe2.ejs` split-view treatment was scoped conservatively in Task 6 (see note below).
- Tests: route/visibility/redirect/save-marker tests — present in every task; the spec's explicit per-view viewport-tag test — Task 6 (`'every top-level view carries a viewport meta tag'` plus a dedicated `poolPage.test.js` case; the remaining views are covered indirectly by their own task's existing 200-status assertions rendering the same shared `<head>` pattern, which Steps 3/4 of each task establish and verify).

**Deviation from the spec, and why:** the spec's Responsive Design section describes `kontierung.ejs` as already having "PDF-Vorschau neben Formular" (preview next to the form) — the actual current file has them stacked (iframe above, form below), not side-by-side. Task 6 keeps `kontierung.ejs`'s existing stacked structure (iframe full-width, form in a `.card` below) rather than introducing a new two-column split that never existed before, consistent with the spec's own "keine Struktur-Umbauten über das nötige Minimum hinaus" principle. `freigabe2.ejs`, which genuinely is a side-by-side split today, gets the full responsive `.col-lg-6`/`.col-12` treatment as specified.

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling" language anywhere in this plan — every step has literal, complete code.

**Type/interface consistency:** `gespeichert` (boolean, from `req.query.gespeichert === '1'`) is the one query-marker name used across all 7 save-confirmation routes and their views — no second name was introduced for the mails.js resend case; only its rendered copy text differs ("Erneut gesendet." vs "Gespeichert."). `isBuchhaltung`/`isPortalAdmin`/`currentPath` (Task 2's `loadNavFlags`) are the exact names Task 3's `_header.ejs` reads. `personHasRole(person, config, role)` (Task 2) is reused unchanged by `requireRole`/`requireAnyRole`/`loadNavFlags` — no divergent copies.
