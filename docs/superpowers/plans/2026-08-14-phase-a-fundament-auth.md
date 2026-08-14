# Freigabeportal Phase A: Fundament & Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Express/SQLite skeleton for the Freigabeportal with ChurchTools OAuth2 login, group-derived roles, a nightly/JIT personen sync, and the plumbing (mailer, API-key auth, cron-secret auth) later phases build on.

**Architecture:** Server-rendered Express app (EJS views), `node:sqlite` for storage (no native compilation), a custom SQLite-backed `express-session` store, three fully separate auth mechanisms (ChurchTools OAuth2 for humans, API-key for n8n, technical-account token for sync), and Infomaniak Task-Scheduler webcron hitting protected internal endpoints instead of relying on in-process timers.

**Tech Stack:** Node.js ≥22.13.0 (ESM, `"type": "module"`), Express 4, EJS, `express-session`, `node:sqlite`, Nodemailer, native `node:test` + `node:assert/strict` for tests, `supertest` and `undici` (MockAgent) as dev-only test dependencies.

## Global Constraints

- Node.js ≥22.13.0 required (`node:sqlite` needs no `--experimental-sqlite` flag from this version on) — verified 2026-08-14, see spec.
- No native/compiled npm dependencies (Infomaniak native-module support is undocumented) — use `node:sqlite`, not `better-sqlite3`.
- Three auth mechanisms must stay on fully separate code paths: ChurchTools OAuth2 (humans), API-key (n8n, stub in this phase), technical-account token (sync). Never share an "isAuthenticated" check between them.
- Roles are derived from ChurchTools group **IDs** (env-configured), never group names, on every request — not cached in the session.
- Personen are **never deleted**, only deactivated (`aktiv = 0`); audit trail must survive.
- Unresolvable ChurchTools person references must produce an admin-visible warning (`ct_person_unresolved`), never silent data loss.
- All timestamps stored as ISO-8601 UTC strings; local-timezone display is a later-phase (D) UI concern, not part of this plan.
- All user-facing text (error pages) is German.
- Zeitsteuerung (sync, later escalation checks) is triggered via protected webcron endpoints (`X-Cron-Secret` header), designed to be idempotent and safe under repeated/parallel calls.
- `admin_config` is a generic key/value store (not fixed columns) so Phase B's escalation-time UI and later possible person-based escalation can land without a schema change.
- Out of scope for this plan (see spec "Nicht Teil von Phase A"): Konten/Zuweisungsregeln, Job-Datenmodell, n8n job endpoints, PDF processing, the actual Freigabe UI, rate-limiting, TLS/deployment details, and any real escalation *business logic* (it depends on Jobs, which don't exist yet — only the `admin_config` plumbing for it is built here).

---

### Task 1: Project scaffolding & config loader

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/config/env.js`
- Test: `test/unit/env.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env)` → returns `{ port, sessionSecret, dbPath, churchtools: { baseUrl, clientId, clientSecret, redirectUri, groupIdBuchhaltung, groupIdAdmin, syncServiceToken }, cronSecret, n8nApiKey, smtp: { host, port, user, pass, from } }`. Throws `Error('Fehlende Umgebungsvariable: <NAME>')` if a required variable is missing.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "freigabeportal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "ejs": "^3.1.10",
    "express": "^4.21.0",
    "express-session": "^1.18.0",
    "nodemailer": "^6.9.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "undici": "^6.19.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
data/
.env
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`

- [ ] **Step 4: Write the failing test**

```js
// test/unit/env.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env.js';

const FULL_ENV = {
  SESSION_SECRET: 'secret',
  CT_BASE_URL: 'https://ct.example.org',
  CT_CLIENT_ID: 'client-id',
  CT_CLIENT_SECRET: 'client-secret',
  CT_REDIRECT_URI: 'https://portal.example.org/auth/callback',
  CT_GROUP_ID_BUCHHALTUNG: '10',
  CT_GROUP_ID_ADMIN: '20',
  CT_SYNC_SERVICE_TOKEN: 'sync-token',
  CRON_SECRET: 'cron-secret',
  N8N_API_KEY: 'n8n-key',
  SMTP_HOST: 'smtp.example.org',
  SMTP_USER: 'smtp-user',
  SMTP_PASS: 'smtp-pass',
  SMTP_FROM: 'portal@example.org',
};

test('loadConfig returns full config when all variables are set', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.churchtools.baseUrl, 'https://ct.example.org');
  assert.equal(config.smtp.port, 587);
  assert.equal(config.port, 3000);
});

test('loadConfig throws a German error when a required variable is missing', () => {
  const { SESSION_SECRET, ...incomplete } = FULL_ENV;
  assert.throws(() => loadConfig(incomplete), /Fehlende Umgebungsvariable: SESSION_SECRET/);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test test/unit/env.test.js`
Expected: FAIL — `src/config/env.js` does not exist yet.

- [ ] **Step 6: Implement `src/config/env.js`**

```js
function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    sessionSecret: required(env, 'SESSION_SECRET'),
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    churchtools: {
      baseUrl: required(env, 'CT_BASE_URL'),
      clientId: required(env, 'CT_CLIENT_ID'),
      clientSecret: required(env, 'CT_CLIENT_SECRET'),
      redirectUri: required(env, 'CT_REDIRECT_URI'),
      groupIdBuchhaltung: required(env, 'CT_GROUP_ID_BUCHHALTUNG'),
      groupIdAdmin: required(env, 'CT_GROUP_ID_ADMIN'),
      syncServiceToken: required(env, 'CT_SYNC_SERVICE_TOKEN'),
    },
    cronSecret: required(env, 'CRON_SECRET'),
    n8nApiKey: required(env, 'N8N_API_KEY'),
    smtp: {
      host: required(env, 'SMTP_HOST'),
      port: Number(env.SMTP_PORT) || 587,
      user: required(env, 'SMTP_USER'),
      pass: required(env, 'SMTP_PASS'),
      from: required(env, 'SMTP_FROM'),
    },
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/unit/env.test.js`
Expected: PASS (2 tests)

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore src/config/env.js test/unit/env.test.js package-lock.json
git commit -m "chore: project scaffolding and env config loader"
```

---

### Task 2: Database layer (schema + connection)

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/index.js`
- Test: `test/unit/db.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `openDatabase(dbPath)` → returns a `node:sqlite` `DatabaseSync` instance with schema applied. `dbPath === ':memory:'` supported for tests.

- [ ] **Step 1: Create `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS personen (
  churchtools_person_id TEXT PRIMARY KEY,
  vorname TEXT NOT NULL,
  nachname TEXT NOT NULL,
  email TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1,
  gruppen TEXT NOT NULL DEFAULT '[]',
  ct_person_unresolved INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gestartet_am TEXT NOT NULL,
  beendet_am TEXT,
  status TEXT NOT NULL,
  fehler_details TEXT,
  anzahl_upserted INTEGER,
  anzahl_deaktiviert INTEGER
);

CREATE TABLE IF NOT EXISTS admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/db.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';

test('openDatabase creates all expected tables', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('openDatabase is idempotent (safe to call schema twice)', () => {
  const db = openDatabase(':memory:');
  assert.doesNotThrow(() => db.exec('SELECT 1'));
  db.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/unit/db.test.js`
Expected: FAIL — `src/db/index.js` does not exist yet.

- [ ] **Step 4: Implement `src/db/index.js`**

```js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/db.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.js test/unit/db.test.js
git commit -m "feat: sqlite schema and connection via node:sqlite"
```

---

### Task 3: Session store + Express app skeleton

**Files:**
- Create: `src/db/sessionStore.js`
- Create: `src/app.js`
- Create: `src/index.js`
- Create: `views/home.ejs`
- Test: `test/unit/sessionStore.test.js`
- Test: `test/integration/app.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2), `loadConfig` (Task 1).
- Produces: `class SqliteSessionStore extends Store` (`get(sid, cb)`, `set(sid, session, cb)`, `destroy(sid, cb)`). `createApp({ db, config })` → returns an Express app with `app.locals.config` set, session middleware mounted, `GET /healthz`, `GET /` wired.

- [ ] **Step 1: Write the failing session store test**

```js
// test/unit/sessionStore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { SqliteSessionStore } from '../../src/db/sessionStore.js';

test('set/get round-trips a session', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const session = { personId: '42', cookie: { expires: new Date(Date.now() + 60000) } };

  store.set('sid-1', session, (err) => {
    assert.equal(err, null);
    store.get('sid-1', (err2, loaded) => {
      assert.equal(err2, null);
      assert.equal(loaded.personId, '42');
      db.close();
    });
  });
});

test('get returns null for an expired session and deletes it', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const expired = { personId: '1', cookie: { expires: new Date(Date.now() - 1000) } };

  store.set('sid-2', expired, () => {
    store.get('sid-2', (err, loaded) => {
      assert.equal(err, null);
      assert.equal(loaded, null);
      const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-2');
      assert.equal(row, undefined);
      db.close();
    });
  });
});

test('destroy removes the session', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteSessionStore(db);
  const session = { personId: '1', cookie: { expires: new Date(Date.now() + 60000) } };

  store.set('sid-3', session, () => {
    store.destroy('sid-3', (err) => {
      assert.equal(err, null);
      const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-3');
      assert.equal(row, undefined);
      db.close();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/sessionStore.test.js`
Expected: FAIL — `src/db/sessionStore.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/sessionStore.js`**

```js
import { Store } from 'express-session';

export class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (new Date(row.expires).getTime() < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, session, callback) {
    try {
      const expires = session.cookie?.expires
        ? new Date(session.cookie.expires).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      this.db
        .prepare(
          'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
            'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
        )
        .run(sid, JSON.stringify(session), expires);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/sessionStore.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Create `views/home.ejs`**

```html
<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Freigabeportal</title></head>
<body>
  <h1>Freigabeportal</h1>
  <% if (person) { %>
    <p>Angemeldet als <%= person.vorname %> <%= person.nachname %>.</p>
  <% } else { %>
    <p>Nicht angemeldet. <a href="/auth/login">Anmelden</a></p>
  <% } %>
</body>
</html>
```

- [ ] **Step 6: Write the failing app test**

```js
// test/integration/app.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
    },
  };
}

test('GET /healthz returns ok', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
  db.close();
});

test('GET / renders the German home page for an anonymous visitor', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Nicht angemeldet/);
  db.close();
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `node --test test/integration/app.test.js`
Expected: FAIL — `src/app.js` does not exist yet.

- [ ] **Step 8: Implement `src/app.js`**

```js
import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteSessionStore } from './db/sessionStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, config }) {
  const app = express();
  app.locals.config = config;
  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(
    session({
      store: new SqliteSessionStore(db),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: config.env === 'production', maxAge: 24 * 60 * 60 * 1000 },
    })
  );

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/', (req, res) => {
    res.render('home', { person: req.currentPerson ?? null });
  });

  return app;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/app.test.js`
Expected: PASS (2 tests)

- [ ] **Step 10: Create `src/index.js` (composition root, not unit-tested)**

```js
import { loadConfig } from './config/env.js';
import { openDatabase } from './db/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({ db, config });

app.listen(config.port, () => {
  console.log(`Freigabeportal läuft auf Port ${config.port}`);
});
```

- [ ] **Step 11: Commit**

```bash
git add src/db/sessionStore.js src/app.js src/index.js views/home.ejs test/unit/sessionStore.test.js test/integration/app.test.js
git commit -m "feat: express app skeleton with sqlite-backed sessions"
```

---

### Task 4: ChurchTools OAuth2 service

**Files:**
- Create: `src/services/churchtools.js`
- Create: `test/helpers/mockChurchTools.js`
- Test: `test/integration/churchtools.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses global `fetch`).
- Produces: `buildAuthorizeUrl(ctConfig, state)`, `exchangeCodeForToken(ctConfig, code)`, `fetchPerson(ctConfig, accessToken)` (whoami), `fetchPersonById(ctConfig, accessToken, personId)`, `fetchGroupMemberIds(ctConfig, accessToken, groupId)` → `string[]`, `resolveMemberGroupIds(ctConfig, accessToken, personId, candidateGroupIds)` → `string[]` (subset of candidates the person belongs to). All async functions throw on non-OK HTTP responses.

> Note: endpoint paths below (`/api/oauth/authorize`, `/api/oauth/token`, `/api/whoami`, `/api/persons/{id}`, `/api/groups/{id}/members`) follow ChurchTools' documented REST API conventions. Verify exact paths/response shapes against the target ChurchTools instance's API docs (Manager → API) during Phase A hardening, before wiring real credentials — the tests below pin the *contract* this service relies on, so a path fix is a one-line change per function.

- [ ] **Step 1: Create the mock helper**

```js
// test/helpers/mockChurchTools.js
import { MockAgent, setGlobalDispatcher } from 'undici';

export function setupMockChurchTools(baseUrl) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent.get(baseUrl);
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/integration/churchtools.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchPerson,
  fetchPersonById,
  fetchGroupMemberIds,
  resolveMemberGroupIds,
} from '../../src/services/churchtools.js';

const CONFIG = {
  baseUrl: 'https://ct.example.org',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://portal.example.org/auth/callback',
};

test('buildAuthorizeUrl includes client id, redirect uri and state', () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, 'the-state'));
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('state'), 'the-state');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('exchangeCodeForToken returns the parsed token response', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/oauth/token', method: 'POST' })
    .reply(200, { access_token: 'abc123', token_type: 'Bearer' });

  const result = await exchangeCodeForToken(CONFIG, 'the-code');
  assert.equal(result.access_token, 'abc123');
});

test('exchangeCodeForToken throws on a non-ok response', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(401, {});
  await assert.rejects(() => exchangeCodeForToken(CONFIG, 'bad-code'));
});

test('fetchPerson returns the whoami payload', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const person = await fetchPerson(CONFIG, 'token');
  assert.equal(person.firstName, 'Max');
});

test('fetchPersonById returns a specific person by id', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/persons/9', method: 'GET' })
    .reply(200, { data: { id: 9, firstName: 'Ana', lastName: 'Muster', email: 'ana@example.org' } });

  const person = await fetchPersonById(CONFIG, 'token', 9);
  assert.equal(person.lastName, 'Muster');
});

test('fetchGroupMemberIds returns member ids as strings', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client
    .intercept({ path: '/api/groups/42/members', method: 'GET' })
    .reply(200, { data: [{ personId: 7 }, { personId: 9 }] });

  const ids = await fetchGroupMemberIds(CONFIG, 'token', 42);
  assert.deepEqual(ids, ['7', '9']);
});

test('resolveMemberGroupIds returns only groups the person belongs to', async () => {
  const client = setupMockChurchTools(CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 5 }] });

  const groups = await resolveMemberGroupIds(CONFIG, 'token', 7, ['10', '20']);
  assert.deepEqual(groups, ['10']);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/integration/churchtools.test.js`
Expected: FAIL — `src/services/churchtools.js` does not exist yet.

- [ ] **Step 4: Implement `src/services/churchtools.js`**

```js
export function buildAuthorizeUrl(config, state) {
  const url = new URL('/api/oauth/authorize', config.baseUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

async function parseOrThrow(response, label) {
  if (!response.ok) {
    throw new Error(`ChurchTools ${label} fehlgeschlagen: ${response.status}`);
  }
  return response.json();
}

export async function exchangeCodeForToken(config, code) {
  const url = new URL('/api/oauth/token', config.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
  });
  return parseOrThrow(response, 'Token-Austausch');
}

export async function fetchPerson(config, accessToken) {
  const url = new URL('/api/whoami', config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Profilabruf');
  return data.data;
}

export async function fetchPersonById(config, accessToken, personId) {
  const url = new URL(`/api/persons/${personId}`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Personenabruf');
  return data.data;
}

export async function fetchGroupMemberIds(config, accessToken, groupId) {
  const url = new URL(`/api/groups/${groupId}/members`, config.baseUrl);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await parseOrThrow(response, 'Gruppenabfrage');
  return data.data.map((member) => String(member.personId));
}

export async function resolveMemberGroupIds(config, accessToken, personId, candidateGroupIds) {
  const memberships = await Promise.all(
    candidateGroupIds.map(async (groupId) => {
      const memberIds = await fetchGroupMemberIds(config, accessToken, groupId);
      return memberIds.includes(String(personId)) ? String(groupId) : null;
    })
  );
  return memberships.filter(Boolean);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/integration/churchtools.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/churchtools.js test/helpers/mockChurchTools.js test/integration/churchtools.test.js
git commit -m "feat: ChurchTools OAuth2 and group-membership service"
```

---

### Task 5: Personen repo + auth routes (login/callback/logout)

**Files:**
- Create: `src/db/personenRepo.js`
- Create: `src/routes/auth.js`
- Modify: `src/app.js` — mount the auth router at `/auth`
- Test: `test/unit/personenRepo.test.js`
- Test: `test/integration/auth.test.js`

**Interfaces:**
- Consumes: `fetchPerson`, `exchangeCodeForToken`, `resolveMemberGroupIds`, `buildAuthorizeUrl` (Task 4); `openDatabase` (Task 2); `createApp` (Task 3).
- Produces: `upsertPerson(db, { id, vorname, nachname, email, gruppen, loggedInNow })`, `getPersonById(db, id)` → `{ churchtools_person_id, vorname, nachname, email, aktiv: boolean, gruppen: string[], ... } | null`. `createAuthRouter({ db, config })` → Express `Router` with `GET /login`, `GET /callback`, `POST /logout`.

- [ ] **Step 1: Write the failing personenRepo test**

```js
// test/unit/personenRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';

test('upsertPerson inserts a new person', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  const person = getPersonById(db, '1');
  assert.equal(person.vorname, 'Ana');
  assert.deepEqual(person.gruppen, ['10']);
  assert.equal(person.aktiv, true);
  assert.ok(person.last_login_at);
  db.close();
});

test('upsertPerson keeps last_login_at when a background sync runs (loggedInNow: false)', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Ana', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10'], loggedInNow: true });
  const afterLogin = getPersonById(db, '1');

  upsertPerson(db, { id: '1', vorname: 'Ana Maria', nachname: 'Muster', email: 'ana@example.org', gruppen: ['10', '20'], loggedInNow: false });
  const afterSync = getPersonById(db, '1');

  assert.equal(afterSync.last_login_at, afterLogin.last_login_at);
  assert.equal(afterSync.vorname, 'Ana Maria');
  assert.deepEqual(afterSync.gruppen, ['10', '20']);
  db.close();
});

test('getPersonById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getPersonById(db, 'missing'), null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/personenRepo.test.js`
Expected: FAIL — `src/db/personenRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/personenRepo.js`**

```js
export function upsertPerson(db, person) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO personen (churchtools_person_id, vorname, nachname, email, aktiv, gruppen, last_synced_at, last_login_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(churchtools_person_id) DO UPDATE SET
       vorname = excluded.vorname,
       nachname = excluded.nachname,
       email = excluded.email,
       aktiv = 1,
       gruppen = excluded.gruppen,
       last_synced_at = excluded.last_synced_at,
       last_login_at = COALESCE(excluded.last_login_at, personen.last_login_at)`
  ).run(
    person.id,
    person.vorname,
    person.nachname,
    person.email,
    JSON.stringify(person.gruppen),
    now,
    person.loggedInNow ? now : null
  );
}

export function getPersonById(db, id) {
  const row = db.prepare('SELECT * FROM personen WHERE churchtools_person_id = ?').get(id);
  if (!row) return null;
  return { ...row, gruppen: JSON.parse(row.gruppen), aktiv: Boolean(row.aktiv) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/personenRepo.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing auth routes test**

```js
// test/integration/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { getPersonById } from '../../src/db/personenRepo.js';

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
    },
  };
}

test('GET /auth/login redirects to ChurchTools with a state parameter', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.ok(location.searchParams.get('state'));
  db.close();
});

test('GET /auth/callback rejects a mismatched state with a German error', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const agent = request.agent(app);
  await agent.get('/auth/login');

  const res = await agent.get('/auth/callback').query({ code: 'x', state: 'wrong-state' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Ungültiger Login-Vorgang/);
  db.close();
});

test('GET /auth/callback with a valid state logs the person in', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/api/whoami', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });
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

test('POST /auth/logout destroys the session', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const agent = request.agent(app);
  const res = await agent.post('/auth/logout');
  assert.equal(res.status, 302);
  db.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/integration/auth.test.js`
Expected: FAIL — `src/routes/auth.js` does not exist yet, and `/auth` is not mounted.

- [ ] **Step 7: Implement `src/routes/auth.js`**

```js
import { Router } from 'express';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchPerson, resolveMemberGroupIds } from '../services/churchtools.js';
import { upsertPerson } from '../db/personenRepo.js';

export function createAuthRouter({ db, config }) {
  const router = Router();

  router.get('/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(buildAuthorizeUrl(config.churchtools, state));
  });

  router.get('/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (!state || state !== req.session.oauthState) {
        return res.status(400).render('error', { message: 'Ungültiger Login-Vorgang. Bitte erneut versuchen.' });
      }
      delete req.session.oauthState;

      const token = await exchangeCodeForToken(config.churchtools, code);
      const profile = await fetchPerson(config.churchtools, token.access_token);
      const candidateGroupIds = [config.churchtools.groupIdBuchhaltung, config.churchtools.groupIdAdmin];
      const gruppen = await resolveMemberGroupIds(config.churchtools, token.access_token, profile.id, candidateGroupIds);

      upsertPerson(db, {
        id: String(profile.id),
        vorname: profile.firstName,
        nachname: profile.lastName,
        email: profile.email,
        gruppen,
        loggedInNow: true,
      });

      req.session.personId = String(profile.id);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.redirect('/');
    });
  });

  return router;
}
```

- [ ] **Step 8: Modify `src/app.js`** — add the import and mount the router (insert after the session middleware, before `/healthz`)

```js
import { createAuthRouter } from './routes/auth.js';
// ...
app.use('/auth', createAuthRouter({ db, config }));
```

Also add a minimal `views/error.ejs` so the 400 response in the state-mismatch test can render (full error-page polish is Task 12; this unblocks the test now):

```html
<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Fehler</title></head>
<body><h1>Fehler</h1><p><%= message %></p></body>
</html>
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/auth.test.js`
Expected: PASS (4 tests)

- [ ] **Step 10: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add src/db/personenRepo.js src/routes/auth.js src/app.js views/error.ejs test/unit/personenRepo.test.js test/integration/auth.test.js
git commit -m "feat: ChurchTools OAuth2 login/callback/logout with JIT person upsert"
```

---

### Task 6: Roles middleware

**Files:**
- Create: `src/middleware/roles.js`
- Modify: `src/app.js` — mount `loadCurrentPerson(db)` globally, before routes
- Test: `test/unit/roles.test.js`

**Interfaces:**
- Consumes: `getPersonById` (Task 5).
- Produces: `loadCurrentPerson(db)` → middleware setting `req.currentPerson` from `req.session.personId` (or `null`). `requireRole(role)` where `role` is `'buchhaltung' | 'portal-admin'` → middleware that 401s if nobody is logged in / inactive, 403s if logged in but missing the group, else calls `next()`. Reads group IDs from `req.app.locals.config.churchtools`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/roles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { loadCurrentPerson, requireRole } from '../../src/middleware/roles.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';

function buildTestApp(db) {
  const app = express();
  app.locals.config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use(loadCurrentPerson(db));
  app.get('/buchhaltung-only', requireRole('buchhaltung'), (req, res) => res.json({ ok: true }));
  app.get('/admin-only', requireRole('portal-admin'), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireRole returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only');
  assert.equal(res.status, 401);
  db.close();
});

test('requireRole returns 403 when logged in but missing the group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['20'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requireRole calls next when the person has the required group', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireRole returns 401 for a deactivated person', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['10'], loggedInNow: true });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const app = buildTestApp(db);
  const res = await request(app).get('/buchhaltung-only').set('x-test-person-id', '1');
  assert.equal(res.status, 401);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/roles.test.js`
Expected: FAIL — `src/middleware/roles.js` does not exist yet.

- [ ] **Step 3: Implement `src/middleware/roles.js`**

```js
import { getPersonById } from '../db/personenRepo.js';

export function loadCurrentPerson(db) {
  return (req, res, next) => {
    if (!req.session.personId) {
      req.currentPerson = null;
      return next();
    }
    req.currentPerson = getPersonById(db, req.session.personId);
    next();
  };
}

const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  'portal-admin': 'groupIdAdmin',
};

export function requireRole(role) {
  return (req, res, next) => {
    const config = req.app.locals.config;
    const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
    const person = req.currentPerson;

    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!person.gruppen.includes(String(groupId))) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/roles.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Modify `src/app.js`** — wire `loadCurrentPerson(db)` globally so later phases can use `requireRole` on any route

```js
import { loadCurrentPerson } from './middleware/roles.js';
// ... after session middleware, before mounting /auth:
app.use(loadCurrentPerson(db));
```

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/middleware/roles.js src/app.js test/unit/roles.test.js
git commit -m "feat: group-derived role middleware (requireRole, loadCurrentPerson)"
```

---

### Task 7: API-key middleware (n8n auth stub)

**Files:**
- Create: `src/middleware/apiKey.js`
- Test: `test/unit/apiKey.test.js`

**Interfaces:**
- Consumes: nothing (reads `config.n8nApiKey`).
- Produces: `requireApiKey(config)` → middleware checking the `X-API-Key` header, 401 JSON on missing/wrong key. Used by Phase C's n8n endpoints.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/apiKey.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requireApiKey } from '../../src/middleware/apiKey.js';

function buildTestApp() {
  const app = express();
  app.get('/protected', requireApiKey({ n8nApiKey: 'correct-key' }), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireApiKey returns 401 when the header is missing', async () => {
  const res = await request(buildTestApp()).get('/protected');
  assert.equal(res.status, 401);
});

test('requireApiKey returns 401 when the key is wrong', async () => {
  const res = await request(buildTestApp()).get('/protected').set('X-API-Key', 'wrong-key');
  assert.equal(res.status, 401);
});

test('requireApiKey calls next when the key matches', async () => {
  const res = await request(buildTestApp()).get('/protected').set('X-API-Key', 'correct-key');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/apiKey.test.js`
Expected: FAIL — `src/middleware/apiKey.js` does not exist yet.

- [ ] **Step 3: Implement `src/middleware/apiKey.js`**

```js
export function requireApiKey(config) {
  return (req, res, next) => {
    const key = req.get('X-API-Key');
    if (!key || key !== config.n8nApiKey) {
      return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key' });
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/apiKey.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/middleware/apiKey.js test/unit/apiKey.test.js
git commit -m "feat: API-key middleware stub for future n8n endpoints"
```

---

### Task 8: Mailer service

**Files:**
- Create: `src/services/mailer.js`
- Test: `test/unit/mailer.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createMailer(smtpConfig)` → `{ sendMail({ to, subject, text }) }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/mailer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createMailer } from '../../src/services/mailer.js';

test('sendMail delivers via the configured transporter', async (t) => {
  let captured;
  const fakeTransporter = {
    sendMail: async (mail) => {
      captured = mail;
      return { messageId: 'test' };
    },
  };
  t.mock.method(nodemailer, 'createTransport', () => fakeTransporter);

  const mailer = createMailer({ host: 'smtp.example.org', port: 587, user: 'u', pass: 'p', from: 'portal@example.org' });
  await mailer.sendMail({ to: 'person@example.org', subject: 'Test', text: 'Hallo' });

  assert.equal(captured.to, 'person@example.org');
  assert.equal(captured.from, 'portal@example.org');
  assert.equal(captured.subject, 'Test');
  assert.equal(captured.text, 'Hallo');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/mailer.test.js`
Expected: FAIL — `src/services/mailer.js` does not exist yet.

- [ ] **Step 3: Implement `src/services/mailer.js`**

```js
import nodemailer from 'nodemailer';

export function createMailer(smtpConfig) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });

  return {
    async sendMail({ to, subject, text }) {
      await transporter.sendMail({ from: smtpConfig.from, to, subject, text });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/mailer.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/services/mailer.js test/unit/mailer.test.js
git commit -m "feat: mailer service (portal-owned SMTP, separate from n8n/Bexio mail)"
```

---

### Task 9: Admin-config repo (generic key/value store, seeded defaults)

**Files:**
- Create: `src/db/adminConfigRepo.js`
- Modify: `src/index.js` — call `seedDefaults(db)` after `openDatabase`
- Test: `test/unit/adminConfigRepo.test.js`

**Interfaces:**
- Consumes: `openDatabase` (Task 2).
- Produces: `seedDefaults(db)` (idempotent — inserts `reminder_stunden: '24'`, `eskalation_stunden: '48'` only if absent), `getConfigValue(db, key)` → `string | null`, `setConfigValue(db, key, value)`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/adminConfigRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, getConfigValue, setConfigValue } from '../../src/db/adminConfigRepo.js';

test('seedDefaults sets reminder and escalation defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '48');
  db.close();
});

test('seedDefaults does not overwrite an already-changed value', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'reminder_stunden', '12');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  db.close();
});

test('getConfigValue returns null for an unknown key', () => {
  const db = openDatabase(':memory:');
  assert.equal(getConfigValue(db, 'unknown'), null);
  db.close();
});

test('setConfigValue upserts a value', () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'custom_key', 'first');
  setConfigValue(db, 'custom_key', 'second');
  assert.equal(getConfigValue(db, 'custom_key'), 'second');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: FAIL — `src/db/adminConfigRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/adminConfigRepo.js`**

```js
const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
};

export function seedDefaults(db) {
  const insert = db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    insert.run(key, value);
  }
}

export function getConfigValue(db, key) {
  const row = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfigValue(db, key, value) {
  db.prepare(
    'INSERT INTO admin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Modify `src/index.js`**

```js
import { seedDefaults } from './db/adminConfigRepo.js';
// ... after `const db = openDatabase(config.dbPath);`
seedDefaults(db);
```

- [ ] **Step 6: Commit**

```bash
git add src/db/adminConfigRepo.js src/index.js test/unit/adminConfigRepo.test.js
git commit -m "feat: generic admin_config key/value store with seeded reminder/escalation defaults"
```

---

### Task 10: Personen-Sync service

**Files:**
- Create: `src/db/syncLogRepo.js`
- Modify: `src/db/personenRepo.js` — add `getAllActivePersonIds`, `deactivatePerson`, `markUnresolved`, `personExists`
- Create: `src/services/sync.js`
- Test: `test/unit/syncLogRepo.test.js`
- Test: `test/integration/sync.test.js`

**Interfaces:**
- Consumes: `fetchGroupMemberIds`, `fetchPersonById` (Task 4); `upsertPerson` + new repo functions (this task); `openDatabase` (Task 2).
- Produces: `startSyncLog(db)` → `number` (log id), `finishSyncLog(db, id, { status, anzahlUpserted, anzahlDeaktiviert, fehlerDetails })`, `hasRecentRunningSync(db, staleAfterMs = 600000)` → `boolean`. `runPersonenSync(db, ctConfig, accessToken)` → `Promise<{ upserted, deactivated, unresolved }>`, writes one `sync_log` row per call.

- [ ] **Step 1: Write the failing syncLogRepo test**

```js
// test/unit/syncLogRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { startSyncLog, finishSyncLog, hasRecentRunningSync } from '../../src/db/syncLogRepo.js';

test('startSyncLog then finishSyncLog records a completed run', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  finishSyncLog(db, id, { status: 'erfolg', anzahlUpserted: 3, anzahlDeaktiviert: 1, fehlerDetails: null });
  const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(id);
  assert.equal(row.status, 'erfolg');
  assert.equal(row.anzahl_upserted, 3);
  assert.ok(row.beendet_am);
  db.close();
});

test('hasRecentRunningSync is true right after startSyncLog and false after finishSyncLog', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  assert.equal(hasRecentRunningSync(db), true);
  finishSyncLog(db, id, { status: 'erfolg' });
  assert.equal(hasRecentRunningSync(db), false);
  db.close();
});

test('hasRecentRunningSync ignores a stale (older than threshold) running entry', () => {
  const db = openDatabase(':memory:');
  const id = startSyncLog(db);
  const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare('UPDATE sync_log SET gestartet_am = ? WHERE id = ?').run(staleTimestamp, id);
  assert.equal(hasRecentRunningSync(db, 10 * 60 * 1000), false);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/syncLogRepo.test.js`
Expected: FAIL — `src/db/syncLogRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/syncLogRepo.js`**

```js
export function startSyncLog(db) {
  const result = db.prepare("INSERT INTO sync_log (gestartet_am, status) VALUES (?, 'laufend')").run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishSyncLog(db, id, { status, anzahlUpserted = null, anzahlDeaktiviert = null, fehlerDetails = null }) {
  db.prepare(
    'UPDATE sync_log SET beendet_am = ?, status = ?, anzahl_upserted = ?, anzahl_deaktiviert = ?, fehler_details = ? WHERE id = ?'
  ).run(new Date().toISOString(), status, anzahlUpserted, anzahlDeaktiviert, fehlerDetails, id);
}

export function hasRecentRunningSync(db, staleAfterMs = 10 * 60 * 1000) {
  const row = db.prepare("SELECT gestartet_am FROM sync_log WHERE status = 'laufend' ORDER BY id DESC LIMIT 1").get();
  if (!row) return false;
  return Date.now() - new Date(row.gestartet_am).getTime() < staleAfterMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/syncLogRepo.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Modify `src/db/personenRepo.js`** — append these exports

```js
export function getAllActivePersonIds(db) {
  return db.prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1').all().map((r) => r.churchtools_person_id);
}

export function deactivatePerson(db, id) {
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run(id);
}

export function markUnresolved(db, id) {
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run(id);
}

export function personExists(db, id) {
  return db.prepare('SELECT 1 FROM personen WHERE churchtools_person_id = ?').get(id) != null;
}
```

- [ ] **Step 6: Write the failing sync service test**

```js
// test/integration/sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { runPersonenSync } from '../../src/services/sync.js';

const CT_CONFIG = {
  baseUrl: 'https://ct.example.org',
  groupIdBuchhaltung: '10',
  groupIdAdmin: '20',
};

test('runPersonenSync upserts current members and deactivates people no longer in any group', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client
    .intercept({ path: '/api/persons/7', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Alt', nachname: 'Verlassen', email: 'alt@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.upserted, 1);
  assert.equal(result.deactivated, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(getPersonById(db, '7').vorname, 'Max');
  assert.equal(getPersonById(db, '99').aktiv, false);

  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'erfolg'").get();
  assert.ok(logRow);
  assert.equal(logRow.anzahl_upserted, 1);
  assert.equal(logRow.anzahl_deaktiviert, 1);
  db.close();
});

test('runPersonenSync marks an existing local person unresolved when their detail fetch fails', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/7', method: 'GET' }).reply(404, {});

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '7', vorname: 'Max', nachname: 'Muster', email: 'max@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.unresolved, 1);
  assert.equal(getPersonById(db, '7').ct_person_unresolved, true);
  db.close();
});

test('runPersonenSync records a failed run and leaves existing data untouched', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(500, {});

  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Bleibt', nachname: 'Gleich', email: 'b@example.org', gruppen: ['10'], loggedInNow: false });

  await assert.rejects(() => runPersonenSync(db, CT_CONFIG, 'service-token'));

  assert.equal(getPersonById(db, '1').vorname, 'Bleibt');
  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'fehler'").get();
  assert.ok(logRow);
  db.close();
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `node --test test/integration/sync.test.js`
Expected: FAIL — `src/services/sync.js` does not exist yet.

- [ ] **Step 8: Implement `src/services/sync.js`**

```js
import { fetchGroupMemberIds, fetchPersonById } from './churchtools.js';
import { upsertPerson, getAllActivePersonIds, deactivatePerson, markUnresolved, personExists } from '../db/personenRepo.js';
import { startSyncLog, finishSyncLog } from '../db/syncLogRepo.js';

export async function runPersonenSync(db, config, accessToken) {
  const syncLogId = startSyncLog(db);
  try {
    const candidateGroupIds = [config.groupIdBuchhaltung, config.groupIdAdmin];
    const personIdToGroups = new Map();

    for (const groupId of candidateGroupIds) {
      const memberIds = await fetchGroupMemberIds(config, accessToken, groupId);
      for (const personId of memberIds) {
        const groups = personIdToGroups.get(personId) ?? [];
        groups.push(String(groupId));
        personIdToGroups.set(personId, groups);
      }
    }

    let upserted = 0;
    let unresolved = 0;
    for (const [personId, gruppen] of personIdToGroups) {
      try {
        const profile = await fetchPersonById(config, accessToken, personId);
        upsertPerson(db, {
          id: String(personId),
          vorname: profile.firstName,
          nachname: profile.lastName,
          email: profile.email,
          gruppen,
          loggedInNow: false,
        });
        upserted += 1;
      } catch {
        if (personExists(db, personId)) {
          markUnresolved(db, personId);
        }
        unresolved += 1;
      }
    }

    const relevantIds = new Set(personIdToGroups.keys());
    let deactivated = 0;
    for (const activeId of getAllActivePersonIds(db)) {
      if (!relevantIds.has(activeId)) {
        deactivatePerson(db, activeId);
        deactivated += 1;
      }
    }

    finishSyncLog(db, syncLogId, {
      status: 'erfolg',
      anzahlUpserted: upserted,
      anzahlDeaktiviert: deactivated,
      fehlerDetails: unresolved > 0 ? `${unresolved} Person(en) nicht auflösbar` : null,
    });
    return { upserted, deactivated, unresolved };
  } catch (err) {
    finishSyncLog(db, syncLogId, { status: 'fehler', fehlerDetails: err.message });
    throw err;
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/sync.test.js`
Expected: PASS (3 tests)

- [ ] **Step 10: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add src/db/syncLogRepo.js src/db/personenRepo.js src/services/sync.js test/unit/syncLogRepo.test.js test/integration/sync.test.js
git commit -m "feat: personen sync (upsert/deactivate/unresolved) with sync_log audit trail"
```

---

### Task 11: Cron-secret middleware + `/internal/cron/sync-personen` webcron endpoint

**Files:**
- Create: `src/middleware/cronAuth.js`
- Create: `src/routes/cron.js`
- Modify: `src/app.js` — mount the cron router at `/internal/cron`
- Test: `test/unit/cronAuth.test.js`
- Test: `test/integration/cron.test.js`

**Interfaces:**
- Consumes: `runPersonenSync`, `hasRecentRunningSync` (Task 10).
- Produces: `requireCronSecret(config)` middleware (checks `X-Cron-Secret` header). `createCronRouter({ db, config })` → Router with `POST /sync-personen`.

- [ ] **Step 1: Write the failing cronAuth test**

```js
// test/unit/cronAuth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requireCronSecret } from '../../src/middleware/cronAuth.js';

function buildTestApp() {
  const app = express();
  app.post('/protected', requireCronSecret({ cronSecret: 'correct-secret' }), (req, res) => res.json({ ok: true }));
  return app;
}

test('requireCronSecret returns 401 without the header', async () => {
  const res = await request(buildTestApp()).post('/protected');
  assert.equal(res.status, 401);
});

test('requireCronSecret returns 401 with the wrong secret', async () => {
  const res = await request(buildTestApp()).post('/protected').set('X-Cron-Secret', 'wrong');
  assert.equal(res.status, 401);
});

test('requireCronSecret calls next with the correct secret', async () => {
  const res = await request(buildTestApp()).post('/protected').set('X-Cron-Secret', 'correct-secret');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/cronAuth.test.js`
Expected: FAIL — `src/middleware/cronAuth.js` does not exist yet.

- [ ] **Step 3: Implement `src/middleware/cronAuth.js`**

```js
export function requireCronSecret(config) {
  return (req, res, next) => {
    const secret = req.get('X-Cron-Secret');
    if (!secret || secret !== config.cronSecret) {
      return res.status(401).json({ error: 'Ungültiges oder fehlendes Cron-Secret' });
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/cronAuth.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing cron route test**

```js
// test/integration/cron.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupMockChurchTools } from '../helpers/mockChurchTools.js';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { startSyncLog } from '../../src/db/syncLogRepo.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    cronSecret: 'cron-secret',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'service-token',
    },
  };
}

test('POST /internal/cron/sync-personen without the secret is rejected', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).post('/internal/cron/sync-personen');
  assert.equal(res.status, 401);
  db.close();
});

test('POST /internal/cron/sync-personen runs the sync with the correct secret', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  db.close();
});

test('POST /internal/cron/sync-personen returns 409 while a run is already active', async () => {
  const config = testConfig();
  const db = openDatabase(':memory:');
  startSyncLog(db);
  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(res.status, 409);
  db.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/integration/cron.test.js`
Expected: FAIL — `src/routes/cron.js` does not exist yet.

- [ ] **Step 7: Implement `src/routes/cron.js`**

```js
import { Router } from 'express';
import { runPersonenSync } from '../services/sync.js';
import { hasRecentRunningSync } from '../db/syncLogRepo.js';
import { requireCronSecret } from '../middleware/cronAuth.js';

export function createCronRouter({ db, config }) {
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

  return router;
}
```

- [ ] **Step 8: Modify `src/app.js`** — add the import and mount the router

```js
import { createCronRouter } from './routes/cron.js';
// ... after mounting /auth:
app.use('/internal/cron', createCronRouter({ db, config }));
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/cron.test.js`
Expected: PASS (3 tests)

- [ ] **Step 10: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add src/middleware/cronAuth.js src/routes/cron.js src/app.js test/unit/cronAuth.test.js test/integration/cron.test.js
git commit -m "feat: webcron-triggered, idempotent personen-sync endpoint"
```

---

### Task 12: German error pages and centralized error/404 handling

**Files:**
- Modify: `views/error.ejs` — finalize German copy (created minimally in Task 5)
- Modify: `src/app.js` — add 404 handler and centralized error-handling middleware (must be the last `app.use` calls)
- Test: `test/integration/errors.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: any unmatched route → 404 German page; any thrown/`next(err)` error → 500 German page. No new exported functions — this task hardens `src/app.js` directly.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/errors.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    cronSecret: 'cron-secret',
    n8nApiKey: 'n8n-key',
    churchtools: {
      baseUrl: 'https://ct.example.org',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://portal.example.org/auth/callback',
      groupIdBuchhaltung: '10',
      groupIdAdmin: '20',
      syncServiceToken: 'token',
    },
  };
}

test('an unmatched route returns a German 404 page', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /nicht gefunden/);
  db.close();
});

test('a thrown error in a route is caught and rendered as a German 500 page', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  app.get('/__boom', () => {
    throw new Error('kaboom');
  });
  const res = await request(app).get('/__boom');
  assert.equal(res.status, 500);
  assert.match(res.text, /unerwarteter Fehler/);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/errors.test.js`
Expected: FAIL — no 404/500 handling wired yet, so both requests hit Express' default HTML error pages (not the German ones).

- [ ] **Step 3: Update `views/error.ejs`**

```html
<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Fehler — Freigabeportal</title></head>
<body>
  <h1>Es ist ein Fehler aufgetreten</h1>
  <p><%= message %></p>
  <p><a href="/">Zurück zur Startseite</a></p>
</body>
</html>
```

- [ ] **Step 4: Modify `src/app.js`** — append as the very last two `app.use` calls, after all routers

```js
app.use((req, res) => {
  res.status(404).render('error', { message: 'Seite nicht gefunden.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.' });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/integration/errors.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add views/error.ejs src/app.js test/integration/errors.test.js
git commit -m "feat: German 404 and centralized error handling"
```

---

### Task 13: Env example, README, final full-suite verification

**Files:**
- Create: `.env.example`
- Create: `README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Create `.env.example`**

```
# Server
PORT=3000
SESSION_SECRET=changeme-long-random-string
DB_PATH=./data/freigabeportal.sqlite

# ChurchTools OAuth2 (Manager -> Einstellungen -> Integrationen -> Login bei Drittsystemen)
CT_BASE_URL=https://musterkirche.church.tools
CT_CLIENT_ID=
CT_CLIENT_SECRET=
CT_REDIRECT_URI=https://portal.musterkirche.ch/auth/callback
CT_GROUP_ID_BUCHHALTUNG=
CT_GROUP_ID_ADMIN=
# Login-Token eines separaten technischen Service-Accounts, nur fuer den naechtlichen Sync
CT_SYNC_SERVICE_TOKEN=

# Webcron (Infomaniak Task Scheduler ruft /internal/cron/* mit diesem Header auf)
CRON_SECRET=changeme-long-random-string

# n8n Maschine-zu-Maschine-Auth (Phase C nutzt dies, Middleware existiert bereits)
N8N_API_KEY=changeme-long-random-string

# Portal-eigener SMTP-Versand (getrennt von n8n/Bexio-Mailpfad)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=portal@musterkirche.ch
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Freigabeportal — Phase A

Rechnungsfreigabe-Portal für eine Schweizer Kirchgemeinde. Diese Phase liefert
das Fundament: Express/SQLite-Skeleton, ChurchTools-OAuth2-Login,
Rollen-Ableitung aus Gruppen, Personen-Sync.

## Setup

1. `npm install`
2. `cp .env.example .env` und Werte eintragen
3. `npm test` — gesamte Test-Suite
4. `npm run dev` — Entwicklungsserver mit Autoreload

## Deployment (Infomaniak Node.js-Hosting)

- Start-Kommando: `npm start`
- Der Port wird von Infomaniak über die Umgebungsvariable `PORT` vorgegeben.
- Task Scheduler (Manager → Website → Advanced Tools → Task Scheduler)
  einrichten: `POST` auf `/internal/cron/sync-personen` mit Header
  `X-Cron-Secret: <CRON_SECRET>`, empfohlen einmal täglich (nachts).
- `node:sqlite` benötigt Node.js ≥22.13.0 (kein `--experimental-sqlite`-Flag
  mehr nötig ab dieser Version) — bei der Node-Versionswahl im Infomaniak
  Manager entsprechend eine aktuelle LTS-Version wählen und früh im
  Deployment verifizieren, dass `node:sqlite` verfügbar ist.

## Nächste Phasen

Siehe `docs/superpowers/specs/2026-08-14-phase-a-fundament-auth-design.md`
für den Gesamt-Phasenplan (B: Admin-Bereich, C: n8n-Schnittstelle, D:
Freigabe-Workflow-UI, E: Härtung & Deployment).
```

- [ ] **Step 3: Run the full test suite one final time**

Run: `npm test`
Expected: all tests PASS (sum of all tasks' tests)

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: env example and Phase A README"
```
