# Mehrstufige Rechteverwaltung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das heutige binäre Rollenmodell (`buchhaltung`/`portal-admin`, rein aus ChurchTools-Gruppenmitgliedschaft abgeleitet) um eine dritte Stufe `manager` erweitern, `portal-admin` konzeptionell zu `superadmin` umbenennen, und additive Einzelrechte pro Person einführen — ohne das bestehende "Rolle = ChurchTools-Gruppenmitgliedschaft"-Prinzip zu verlassen.

**Architecture:** Drei Rollenstufen (`superadmin`, `manager`, implizit `benutzer`) bleiben rein ChurchTools-gruppenbasiert (`personHasRole`, wie heute). Eine neue Tabelle `person_berechtigungen` speichert additive, individuell vergebbare Einzelrechte für sechs granulare Admin-Bereiche. Eine neue Permission-Schicht (`personHasPermission`/`requirePermission`/`requireAdminAreaAccess`) kombiniert Rolle + Einzelrechte; drei Admin-Bereiche (Eskalationszeiten, Erscheinungsbild, Zeitstempel) sowie die Rechtevergabe selbst bleiben hart auf `requireRole(config, 'superadmin')` verdrahtet und sind über keinen Mechanismus delegierbar.

**Tech Stack:** Node.js, Express, `node:sqlite` (kein ORM, raw SQL via `db.prepare()`), EJS-Views, Bootstrap 5, `node:test` + `supertest` für Tests.

**Spec:** [docs/superpowers/specs/2026-08-23-mehrstufige-rechteverwaltung-design.md](../specs/2026-08-23-mehrstufige-rechteverwaltung-design.md)

## Global Constraints

- Vergebbare Rechte (exakt diese sechs Werte, keine anderen): `konten_verwalten`, `debitoren_verwalten`, `geplante_jobs_verwalten`, `abgelehnt_verwalten`, `mails_einsehen`, `sync_einsehen`.
- Hart gesperrt auf `superadmin`, nie vergebbar: `/admin/eskalation`, `/admin/erscheinungsbild`, `/admin/zeitstempel`, sowie das Bearbeiten von `person_berechtigungen` selbst.
- Einzelrechte sind rein additiv — sie können nur zusätzliche Rechte geben, nie ein Manager-Bundle-Recht entziehen.
- `CT_GROUP_ID_ADMIN` (Env-Var) wird **nicht** umbenannt. Nur der interne Rollen-String wechselt von `'portal-admin'` zu `'superadmin'`.
- `CT_GROUP_ID_MANAGER` ist **optional** (nicht über `required()` erzwungen) — ein Deployment ohne diese Variable muss unverändert weiterlaufen, niemand ist dann Manager.
- Manager/Superadmin-Zuweisung bleibt ausschliesslich ChurchTools-Gruppenmitgliedschaft — keine In-App-UI dafür. Nur die sechs Einzelrechte werden in-app verwaltet (auf `/admin/personen`, nur für Superadmin editierbar).

---

## Task 1: Datenbank & Repository für Einzelrechte

**Files:**
- Modify: `src/db/schema.sql`
- Create: `src/db/personBerechtigungenRepo.js`
- Test: `test/unit/personBerechtigungenRepo.test.js`

**Interfaces:**
- Produces: `listBerechtigungenForPerson(db, personId) -> string[]`, `setBerechtigungenForPerson(db, personId, berechtigungen: string[]) -> void` (ersetzt die komplette Menge), `personHasBerechtigung(db, personId, berechtigung: string) -> boolean`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/personBerechtigungenRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import {
  listBerechtigungenForPerson,
  setBerechtigungenForPerson,
  personHasBerechtigung,
} from '../../src/db/personBerechtigungenRepo.js';

function seedPerson(db, id) {
  upsertPerson(db, { id, vorname: 'Test', nachname: 'Person', email: `${id}@example.org`, gruppen: [], loggedInNow: false });
}

test('listBerechtigungenForPerson returns an empty array for a person with none', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('setBerechtigungenForPerson inserts the given set and listBerechtigungenForPerson reflects it', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten', 'mails_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1').sort(), ['konten_verwalten', 'mails_einsehen']);
  db.close();
});

test('setBerechtigungenForPerson replaces the previous set entirely (removes what is no longer included)', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten', 'mails_einsehen']);
  setBerechtigungenForPerson(db, '1', ['sync_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['sync_einsehen']);
  db.close();
});

test('setBerechtigungenForPerson with an empty array clears all rights', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  setBerechtigungenForPerson(db, '1', []);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('setBerechtigungenForPerson does not affect another person\'s rights', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  seedPerson(db, '2');
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  setBerechtigungenForPerson(db, '2', ['sync_einsehen']);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['konten_verwalten']);
  assert.deepEqual(listBerechtigungenForPerson(db, '2'), ['sync_einsehen']);
  db.close();
});

test('personHasBerechtigung returns true only for a granted right', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  setBerechtigungenForPerson(db, '1', ['debitoren_verwalten']);
  assert.equal(personHasBerechtigung(db, '1', 'debitoren_verwalten'), true);
  assert.equal(personHasBerechtigung(db, '1', 'konten_verwalten'), false);
  db.close();
});

test('personHasBerechtigung returns false for a person with no rows at all', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.equal(personHasBerechtigung(db, '1', 'konten_verwalten'), false);
  db.close();
});

test('inserting a berechtigung outside the catalog violates the CHECK constraint', () => {
  const db = openDatabase(':memory:');
  seedPerson(db, '1');
  assert.throws(() => {
    db.prepare('INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES (?, ?)').run('1', 'basis_einstellungen');
  });
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/personBerechtigungenRepo.test.js`
Expected: FAIL — `Cannot find module '../../src/db/personBerechtigungenRepo.js'` (and the CHECK-constraint test fails too, since the table doesn't exist yet).

- [ ] **Step 3: Add the table to schema.sql**

In `src/db/schema.sql`, add after the `personen` table (before `sessions`):

```sql
-- Additive Einzelrechte pro Person, unabhängig von der ChurchTools-Rolle (superadmin/manager).
-- Nur die sechs vergebbaren Rechte sind hier zulässig -- die drei hart gesperrten Admin-Bereiche
-- (Eskalationszeiten, Erscheinungsbild, Zeitstempel) sowie das Bearbeiten dieser Tabelle selbst
-- sind strukturell nicht einfügbar, unabhängig von der Anwendungslogik.
CREATE TABLE IF NOT EXISTS person_berechtigungen (
  person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  berechtigung TEXT NOT NULL CHECK (berechtigung IN (
    'konten_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten',
    'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen'
  )),
  PRIMARY KEY (person_id, berechtigung)
);
```

- [ ] **Step 4: Implement the repo**

```javascript
// src/db/personBerechtigungenRepo.js
export function listBerechtigungenForPerson(db, personId) {
  return db
    .prepare('SELECT berechtigung FROM person_berechtigungen WHERE person_id = ?')
    .all(personId)
    .map((row) => row.berechtigung);
}

export function setBerechtigungenForPerson(db, personId, berechtigungen) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM person_berechtigungen WHERE person_id = ?').run(personId);
    const insert = db.prepare('INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES (?, ?)');
    for (const berechtigung of berechtigungen) {
      insert.run(personId, berechtigung);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function personHasBerechtigung(db, personId, berechtigung) {
  return db.prepare('SELECT 1 FROM person_berechtigungen WHERE person_id = ? AND berechtigung = ?').get(personId, berechtigung) != null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/unit/personBerechtigungenRepo.test.js`
Expected: PASS (all 8 tests)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/personBerechtigungenRepo.js test/unit/personBerechtigungenRepo.test.js
git commit -m "feat: add person_berechtigungen table and repo for individual admin rights"
```

---

## Task 2: Rollenmodell — Superadmin umbenennen, Manager-Rolle einführen

**Files:**
- Modify: `src/config/env.js`
- Modify: `src/middleware/roles.js`
- Modify: `src/app.js:92`
- Modify: `src/routes/poolPage.js:34-35`
- Modify: `src/middleware/nav.js:6`
- Modify: `src/services/jobAuthorization.js:10`
- Modify: `src/routes/kontierung.js:73-75`
- Modify: `src/routes/freigabe2.js:18-20`
- Modify: `src/routes/ablehnung.js:10-12`
- Modify: `src/routes/auth.js:25`
- Modify: `src/services/sync.js:10`
- Modify: `test/unit/roles.test.js`
- Modify: `test/integration/auth.test.js`
- Modify: `test/integration/sync.test.js`

**Interfaces:**
- Produces: role string `'superadmin'` (replaces `'portal-admin'` everywhere), role string `'manager'` (new), `config.churchtools.groupIdManager` (`string | null`), `personHasRole(person, config, role)` now returns `false` (not a crash) when the role's configured group id is falsy.
- Consumes: `person_berechtigungen` from Task 1 is NOT used yet in this task — this task only touches the role layer.

**Important gap found during planning, not in the spec:** `personHasRole` alone is not enough to make the Manager role reachable. `src/routes/auth.js:25` (login) and `src/services/sync.js:10` (nightly sync) each independently build their own `candidateGroupIds = [groupIdBuchhaltung, groupIdAdmin]` and only ever ask ChurchTools about membership in *those* two groups — `personen.gruppen` is populated exclusively from that list. Without adding `groupIdManager` to both lists, `person.gruppen` would never contain the Manager group ID no matter who ChurchTools says is a member, and `personHasRole(person, config, 'manager')` would be permanently `false` for everyone. This task fixes both call sites in the same commit as the role rename, since both are part of "wiring up the manager role" and neither works without the other.

This is one atomic task: `GROUP_ID_KEY_BY_ROLE`'s key rename and every call site that passes the string `'portal-admin'` must land in the same commit, otherwise the app breaks mid-task (a stale call site would look up an unknown role key and, after Step 4's null-guard, silently resolve to "nobody has this role" instead of crashing loudly).

- [ ] **Step 1: Update the failing/changing tests first**

In `test/unit/roles.test.js`, replace every `'portal-admin'` with `'superadmin'` (lines 20, 84, 92, 100, 107, 164) and extend the config objects to include `groupIdManager: '30'` where a config literal is declared (lines 10, 60, 156, 161). Add these new tests at the end of the file:

```javascript
test('personHasRole returns false when the role\'s configured group id is falsy (e.g. CT_GROUP_ID_MANAGER unset)', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: null } };
  const person = { gruppen: ['10', '20', 'null'] }; // even a literal "null" group id must not match
  assert.equal(personHasRole(person, config, 'manager'), false);
});

test('personHasRole recognizes manager group membership', () => {
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  const person = { gruppen: ['30'] };
  assert.equal(personHasRole(person, config, 'manager'), true);
  assert.equal(personHasRole(person, config, 'superadmin'), false);
});
```

Also update `buildTestApp` (line 20) to name the route consistently — rename `app.get('/admin-only', requireRole(config, 'portal-admin'), ...)` to use `'superadmin'`; the route path `/admin-only` itself stays.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/roles.test.js`
Expected: FAIL — `requireRole(config, 'superadmin')` currently resolves to `undefined` group id and throws or always 403s (role key doesn't exist yet in `GROUP_ID_KEY_BY_ROLE`), and the two new tests fail because `'manager'` isn't a known role yet.

- [ ] **Step 3: Add `groupIdManager` to config**

In `src/config/env.js`, in the `churchtools` block (after line 40, `groupIdAdmin: required(env, 'CT_GROUP_ID_ADMIN'),`):

```javascript
      groupIdAdmin: required(env, 'CT_GROUP_ID_ADMIN'),
      groupIdManager: env.CT_GROUP_ID_MANAGER || null,
```

- [ ] **Step 4: Rename the role and add manager in `src/middleware/roles.js`**

Replace lines 19-31:

```javascript
const GROUP_ID_KEY_BY_ROLE = {
  buchhaltung: 'groupIdBuchhaltung',
  superadmin: 'groupIdAdmin',
  manager: 'groupIdManager',
};

// Shared by requireRole/requireAnyRole (the HTTP gates) and middleware/nav.js's loadNavFlags
// (Phase F's nav-tab visibility computation) — both need the identical "is this person in
// ChurchTools group X" check. Extracted here rather than duplicated a third time.
export function personHasRole(person, config, role) {
  if (!person) return false;
  const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
  // groupIdManager is optional (CT_GROUP_ID_MANAGER is not required in env.js) — without this
  // guard an unconfigured role would compare against the string "null"/"undefined" instead of
  // simply having nobody in it.
  if (!groupId) return false;
  return person.gruppen.includes(String(groupId));
}
```

- [ ] **Step 5: Rename the six remaining call sites**

`src/app.js:92`:
```javascript
app.use('/admin', sessionLimiter, requireRole(config, 'superadmin'));
```

`src/routes/poolPage.js:34-35`:
```javascript
    const zeigtPool = personHasRole(req.currentPerson, config, 'buchhaltung') || personHasRole(req.currentPerson, config, 'superadmin');
    const istSuperadmin = personHasRole(req.currentPerson, config, 'superadmin');
```
(and rename the two later uses of `istPortalAdmin` on lines 41-42 to `istSuperadmin`)

`src/middleware/nav.js:6`:
```javascript
    res.locals.isPortalAdmin = personHasRole(req.currentPerson, config, 'superadmin');
```
(the `res.locals` key itself — `isPortalAdmin` — is renamed to `isSuperadmin` in Task 5, not here; this task only changes the role string passed to `personHasRole`, to keep this task's diff focused on the role rename)

`src/services/jobAuthorization.js:10`:
```javascript
  if (personHasRole(currentPerson, config, 'superadmin')) return true;
```

`src/routes/kontierung.js:73-75`, `src/routes/freigabe2.js:18-20`, `src/routes/ablehnung.js:10-12` — each has an identical local helper; rename the function and its body in all three:

```javascript
  function isSuperadmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }
```

and rename every call site of `isPortalAdmin(...)` within those same three files to `isSuperadmin(...)`.

- [ ] **Step 6: Make login and sync actually query the Manager group**

`src/routes/auth.js:25`:
```javascript
      const candidateGroupIds = [config.churchtools.groupIdBuchhaltung, config.churchtools.groupIdAdmin, config.churchtools.groupIdManager].filter(Boolean);
```

`src/services/sync.js:10`:
```javascript
    const candidateGroupIds = [config.groupIdBuchhaltung, config.groupIdAdmin, config.groupIdManager].filter(Boolean);
```

`.filter(Boolean)` matters here: `groupIdManager` is optional (Step 3), so on a deployment that hasn't set `CT_GROUP_ID_MANAGER` this must silently drop out of the list rather than triggering a request to `/api/groups/undefined/members`.

- [ ] **Step 7: Add tests proving the Manager group is queried when configured, and add nothing when it isn't**

In `test/integration/auth.test.js`, add (after the existing `'GET /auth/callback logs the person in...'` test, reusing that test's `testConfig`/import style):

```javascript
test('GET /auth/callback also resolves Manager group membership when CT_GROUP_ID_MANAGER is configured', async () => {
  const config = testConfig();
  config.churchtools.groupIdManager = '30';
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'tok' });
  client
    .intercept({ path: '/oauth/userinfo', method: 'GET' })
    .reply(200, { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' });
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/30/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });

  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const res = await agent.get('/auth/callback').query({ code: 'the-code', state });
  assert.equal(res.status, 302);
  assert.deepEqual(getPersonById(db, '7').gruppen, ['30']);
  db.close();
});
```

In `test/integration/sync.test.js`, add (after the first existing test, reusing its `CT_CONFIG`/import style):

```javascript
test('runPersonenSync also queries the Manager group when configured', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/30/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client
    .intercept({ path: '/api/persons/7', method: 'GET' })
    .reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const db = openDatabase(':memory:');
  const result = await runPersonenSync(db, { ...CT_CONFIG, groupIdManager: '30' }, 'service-token');

  assert.equal(result.upserted, 1);
  assert.deepEqual(getPersonById(db, '7').gruppen, ['30']);
  db.close();
});
```

No test is needed for "groupIdManager unset queries nothing" as its own case — every other pre-existing test in both files keeps `groupIdManager` unset and keeps passing unmodified; since `setupMockChurchTools` uses `MockAgent.disableNetConnect()`, an unexpected request to a manager-group endpoint would fail those tests loudly rather than silently passing, so they already cover this regression.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS — this is a mechanical rename plus the login/sync widening from Steps 6-7, so every existing test (not just `roles.test.js`) must still be green. Any remaining red test means a `'portal-admin'` call site was missed; re-check with `grep -rn "portal-admin" src/`.

- [ ] **Step 9: Commit**

```bash
git add src/config/env.js src/middleware/roles.js src/app.js src/routes/poolPage.js src/middleware/nav.js src/services/jobAuthorization.js src/routes/kontierung.js src/routes/freigabe2.js src/routes/ablehnung.js src/routes/auth.js src/services/sync.js test/unit/roles.test.js test/integration/auth.test.js test/integration/sync.test.js
git commit -m "refactor: rename portal-admin role to superadmin, add manager role and wire it into login/sync"
```

---

## Task 3: Berechtigungs-Middleware

**Files:**
- Create: `src/middleware/permissions.js`
- Test: `test/unit/permissions.test.js`

**Interfaces:**
- Consumes: `personHasRole(person, config, role)` from Task 2; `personHasBerechtigung(db, personId, berechtigung)`, `listBerechtigungenForPerson(db, personId)` from Task 1.
- Produces: `GRANTABLE_BERECHTIGUNGEN: string[]` (the six-item catalog), `BERECHTIGUNG_LABELS: Record<string,string>` (German display labels, used by Task 8's view), `personHasPermission(db, config, person, permission) -> boolean`, `requirePermission(db, config, permission) -> RequestHandler`, `requireAdminAreaAccess(db, config) -> RequestHandler`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/permissions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../src/middleware/roles.js';
import { GRANTABLE_BERECHTIGUNGEN, personHasPermission, requirePermission, requireAdminAreaAccess } from '../../src/middleware/permissions.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

test('GRANTABLE_BERECHTIGUNGEN lists exactly the six catalog permissions', () => {
  assert.deepEqual(
    [...GRANTABLE_BERECHTIGUNGEN].sort(),
    ['abgelehnt_verwalten', 'debitoren_verwalten', 'geplante_jobs_verwalten', 'konten_verwalten', 'mails_einsehen', 'sync_einsehen']
  );
});

test('personHasPermission: superadmin has every grantable permission without any individual grant', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['20'], loggedInNow: false });
  const person = { churchtools_person_id: '1', gruppen: ['20'] };
  for (const permission of GRANTABLE_BERECHTIGUNGEN) {
    assert.equal(personHasPermission(db, CONFIG, person, permission), true, permission);
  }
  db.close();
});

test('personHasPermission: manager has every grantable permission without any individual grant', () => {
  const db = openDatabase(':memory:');
  const person = { churchtools_person_id: '1', gruppen: ['30'] };
  for (const permission of GRANTABLE_BERECHTIGUNGEN) {
    assert.equal(personHasPermission(db, CONFIG, person, permission), true, permission);
  }
  db.close();
});

test('personHasPermission: a plain person only has an individually granted permission', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: false });
  setBerechtigungenForPerson(db, '1', ['debitoren_verwalten']);
  const person = { churchtools_person_id: '1', gruppen: [] };
  assert.equal(personHasPermission(db, CONFIG, person, 'debitoren_verwalten'), true);
  assert.equal(personHasPermission(db, CONFIG, person, 'konten_verwalten'), false);
  db.close();
});

test('personHasPermission returns false for a null person', () => {
  const db = openDatabase(':memory:');
  assert.equal(personHasPermission(db, CONFIG, null, 'konten_verwalten'), false);
  db.close();
});

function buildPermissionTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  app.use(loadCurrentPerson(db));
  app.get('/needs-konten', requirePermission(db, CONFIG, 'konten_verwalten'), (req, res) => res.json({ ok: true }));
  app.get('/admin-area', requireAdminAreaAccess(db, CONFIG), (req, res) => res.json({ ok: true }));
  return app;
}

test('requirePermission returns 401 when nobody is logged in', async () => {
  const db = openDatabase(':memory:');
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten');
  assert.equal(res.status, 401);
  db.close();
});

test('requirePermission returns 403 for a logged-in person without the permission', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requirePermission calls next for a person with the individual grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/needs-konten').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireAdminAreaAccess rejects a person with zero roles and zero individual grants', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 403);
  db.close();
});

test('requireAdminAreaAccess allows a person with exactly one individual grant', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});

test('requireAdminAreaAccess allows a manager with zero individual grants', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: ['30'], loggedInNow: true });
  const app = buildPermissionTestApp(db);
  const res = await request(app).get('/admin-area').set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/permissions.test.js`
Expected: FAIL — `Cannot find module '../../src/middleware/permissions.js'`

- [ ] **Step 3: Implement `src/middleware/permissions.js`**

```javascript
import { personHasRole } from './roles.js';
import { listBerechtigungenForPerson, personHasBerechtigung } from '../db/personBerechtigungenRepo.js';

export const GRANTABLE_BERECHTIGUNGEN = [
  'konten_verwalten',
  'debitoren_verwalten',
  'geplante_jobs_verwalten',
  'abgelehnt_verwalten',
  'mails_einsehen',
  'sync_einsehen',
];

export const BERECHTIGUNG_LABELS = {
  konten_verwalten: 'Konten verwalten',
  debitoren_verwalten: 'Debitoren verwalten',
  geplante_jobs_verwalten: 'Geplante Jobs verwalten',
  abgelehnt_verwalten: 'Abgelehnte Rechnungen verwalten',
  mails_einsehen: 'Mail-Protokoll einsehen',
  sync_einsehen: 'Sync-Übersicht einsehen',
};

// Superadmin und Manager bekommen jedes vergebbare Recht über ihr Rollen-Bundle, unabhängig von
// person_berechtigungen -- Einzelrechte sind nur für alle anderen relevant (additiv, siehe Design).
export function personHasPermission(db, config, person, permission) {
  if (!person) return false;
  if (personHasRole(person, config, 'superadmin')) return true;
  if (personHasRole(person, config, 'manager')) return true;
  return personHasBerechtigung(db, person.churchtools_person_id, permission);
}

export function requirePermission(db, config, permission) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    if (!personHasPermission(db, config, person, permission)) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}

export function requireAdminAreaAccess(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    const hatZugriff =
      personHasRole(person, config, 'superadmin') ||
      personHasRole(person, config, 'manager') ||
      listBerechtigungenForPerson(db, person.churchtools_person_id).length > 0;
    if (!hatZugriff) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/permissions.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/middleware/permissions.js test/unit/permissions.test.js
git commit -m "feat: add permission layer combining superadmin/manager roles with individual grants"
```

---

## Task 4: Hart gesperrte Admin-Bereiche — Tests auf Superadmin/Manager erweitern

**Files:**
- Modify: `test/integration/admin/eskalation.test.js`
- Modify: `test/integration/admin/erscheinungsbild.test.js`
- Modify: `test/integration/admin/zeitstempel.test.js`

**Interfaces:**
- Consumes: `requireRole` (unchanged signature, from Task 2's rename), no new production code in this task.

These three router files stay on `requireRole(config, 'superadmin')` (never `requirePermission`) — this task only proves that a Manager, who now exists as a concept, is correctly still rejected. Each of the three test files follows an identical pattern; apply the same edit to all three.

- [ ] **Step 1: Write the failing test (repeat per file)**

In `test/integration/admin/eskalation.test.js`, update `buildTestApp`'s `config` literal (line 24) to include `groupIdManager: '30'`, and rename `requireRole(config, 'portal-admin')` (line 26) to `requireRole(config, 'superadmin')`. Add:

```javascript
test('GET /admin/eskalation returns 403 for a Manager (hard-locked to superadmin only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/eskalation').set('x-test-person-id', '55');
  assert.equal(res.status, 403);
  db.close();
});
```

Repeat identically in `test/integration/admin/erscheinungsbild.test.js` (path `/admin/erscheinungsbild`) and `test/integration/admin/zeitstempel.test.js` (path `/admin/zeitstempel`), each renaming their own `buildTestApp`'s config/`requireRole` call the same way.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/eskalation.test.js test/integration/admin/erscheinungsbild.test.js test/integration/admin/zeitstempel.test.js`
Expected: FAIL — the `requireRole(config, 'portal-admin')` calls still reference the old role key, which no longer resolves (Task 2 already renamed the underlying `GROUP_ID_KEY_BY_ROLE`), so these files are currently broken until the rename below lands. (If Task 2 already turned these three files red, this step confirms the new Manager-403 tests specifically also fail before the rename.)

- [ ] **Step 3: No production code changes — this task is test-only**

(The rename to `requireRole(config, 'superadmin')` inside each `buildTestApp` **is** the fix — apply it as part of Step 1 if not already done.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/admin/eskalation.test.js test/integration/admin/erscheinungsbild.test.js test/integration/admin/zeitstempel.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/integration/admin/eskalation.test.js test/integration/admin/erscheinungsbild.test.js test/integration/admin/zeitstempel.test.js
git commit -m "test: confirm Manager stays locked out of eskalation/erscheinungsbild/zeitstempel"
```

---

## Task 5: Nav-Flags — isSuperadmin/isManager/adminNav

**Files:**
- Modify: `src/middleware/nav.js`
- Modify: `src/app.js:83`
- Modify: `views/_header.ejs:46,60`
- Modify: `views/pool.ejs:14,19-24`
- Modify: `test/unit/nav.test.js`

**Interfaces:**
- Consumes: `personHasRole` (Task 2), `personHasPermission`, `GRANTABLE_BERECHTIGUNGEN` (Task 3).
- Produces: `loadNavFlags(db, config)` (signature change — was `loadNavFlags(config)`), setting `res.locals.isBuchhaltung`, `res.locals.isSuperadmin` (renamed from `isPortalAdmin`), `res.locals.isManager` (new), `res.locals.adminNav` (new — `{ konten, debitoren, eskalation, erscheinungsbild, zeitstempel, personen, mails, sync, geplanteJobs, abgelehnt }`, all booleans).

- [ ] **Step 1: Write the failing test**

Replace `test/unit/nav.test.js` entirely:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { loadNavFlags } from '../../src/middleware/nav.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };

function runLoadNavFlags(db, config, currentPerson, path) {
  const req = { currentPerson, path };
  const res = { locals: {} };
  let calledNext = false;
  loadNavFlags(db, config)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

test('loadNavFlags sets isBuchhaltung/currentPath for a Buchhaltung member and calls next', () => {
  const db = openDatabase(':memory:');
  const { res, calledNext } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['10'] }, '/pool');
  assert.equal(res.locals.isBuchhaltung, true);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.isManager, false);
  assert.equal(res.locals.currentPath, '/pool');
  assert.equal(calledNext, true);
  db.close();
});

test('loadNavFlags sets isSuperadmin true for a Superadmin (ChurchTools Admin group) member', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['20'] }, '/admin');
  assert.equal(res.locals.isSuperadmin, true);
  assert.equal(res.locals.isBuchhaltung, false);
  db.close();
});

test('loadNavFlags sets isManager true for a Manager group member, and adminNav includes the bundled sections but not the hard-locked ones', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: ['30'] }, '/admin');
  assert.equal(res.locals.isManager, true);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.adminNav.konten, true);
  assert.equal(res.locals.adminNav.debitoren, true);
  assert.equal(res.locals.adminNav.mails, true);
  assert.equal(res.locals.adminNav.sync, true);
  assert.equal(res.locals.adminNav.geplanteJobs, true);
  assert.equal(res.locals.adminNav.abgelehnt, true);
  assert.equal(res.locals.adminNav.personen, true);
  assert.equal(res.locals.adminNav.eskalation, false);
  assert.equal(res.locals.adminNav.erscheinungsbild, false);
  assert.equal(res.locals.adminNav.zeitstempel, false);
  db.close();
});

test('loadNavFlags: a plain person with one individual grant sees only that section in adminNav', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@b.ch', gruppen: [], loggedInNow: false });
  setBerechtigungenForPerson(db, '1', ['mails_einsehen']);
  const { res } = runLoadNavFlags(db, CONFIG, { churchtools_person_id: '1', gruppen: [] }, '/admin');
  assert.equal(res.locals.adminNav.mails, true);
  assert.equal(res.locals.adminNav.konten, false);
  assert.equal(res.locals.adminNav.personen, false, 'personen list stays role-only, not grantable via individual rights');
  db.close();
});

test('loadNavFlags sets all flags false and adminNav all-false for an anonymous visitor (currentPerson null)', () => {
  const db = openDatabase(':memory:');
  const { res } = runLoadNavFlags(db, CONFIG, null, '/');
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.isSuperadmin, false);
  assert.equal(res.locals.isManager, false);
  assert.equal(Object.values(res.locals.adminNav).every((v) => v === false), true);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/nav.test.js`
Expected: FAIL — `loadNavFlags` still takes only `config`, doesn't set `isSuperadmin`/`isManager`/`adminNav`.

- [ ] **Step 3: Implement the new `loadNavFlags`**

Replace `src/middleware/nav.js` entirely:

```javascript
import { personHasRole } from './roles.js';
import { personHasPermission } from './permissions.js';

export function loadNavFlags(db, config) {
  return (req, res, next) => {
    const person = req.currentPerson;
    res.locals.isBuchhaltung = personHasRole(person, config, 'buchhaltung');
    res.locals.isSuperadmin = personHasRole(person, config, 'superadmin');
    res.locals.isManager = personHasRole(person, config, 'manager');
    const hasPermission = (permission) => personHasPermission(db, config, person, permission);
    res.locals.adminNav = {
      konten: hasPermission('konten_verwalten'),
      debitoren: hasPermission('debitoren_verwalten'),
      eskalation: res.locals.isSuperadmin,
      erscheinungsbild: res.locals.isSuperadmin,
      zeitstempel: res.locals.isSuperadmin,
      personen: res.locals.isSuperadmin || res.locals.isManager,
      mails: hasPermission('mails_einsehen'),
      sync: hasPermission('sync_einsehen'),
      geplanteJobs: hasPermission('geplante_jobs_verwalten'),
      abgelehnt: hasPermission('abgelehnt_verwalten'),
    };
    res.locals.currentPath = req.path;
    next();
  };
}
```

- [ ] **Step 4: Update the `src/app.js` call site**

Line 83:
```javascript
  app.use(loadNavFlags(db, config));
```

- [ ] **Step 5: Rename `isPortalAdmin` to `isSuperadmin` in the two consuming views**

`views/_header.ejs:46`:
```ejs
<% const navIsSuperadmin = typeof isSuperadmin !== 'undefined' && isSuperadmin; %>
```
and line 60, `navIsPortalAdmin` → `navIsSuperadmin`.

`views/pool.ejs:14`:
```ejs
    <% if (typeof isBuchhaltung !== 'undefined' && (isBuchhaltung || isSuperadmin)) { %>
```
line 19:
```ejs
    <% if (typeof isSuperadmin !== 'undefined' && isSuperadmin) { %>
      <h2 class="h4 mt-4">An Superadmin eskalierte Kontierungen</h2>
      <%- include('_job_table', { jobs: adminEskalierteKontierungen, idPrefix: 'admin-eskalation-kontierung', linkPrefix: '/kontierung', aktionLabel: 'Kontieren', leerText: 'Keine an Superadmin eskalierten Kontierungen.' }) %>

      <h2 class="h4 mt-4">An Superadmin eskalierte Freigaben</h2>
      <%- include('_job_table', { jobs: adminEskalierteFreigaben, idPrefix: 'admin-eskalation-freigabe', linkPrefix: '/freigabe2', aktionLabel: 'Freigeben', leerText: 'Keine an Superadmin eskalierten Freigaben.' }) %>
    <% } %>
```

- [ ] **Step 6: Run test to verify it passes, then run the full suite**

Run: `node --test test/unit/nav.test.js`
Expected: PASS

Run: `npm test`
Expected: PASS — check especially `test/integration/poolPage.test.js` and any snapshot-style assertion on the header/pool markup; fix any remaining literal `isPortalAdmin`/`navIsPortalAdmin` string match left over from the old naming.

- [ ] **Step 7: Commit**

```bash
git add src/middleware/nav.js src/app.js views/_header.ejs views/pool.ejs test/unit/nav.test.js
git commit -m "feat: compute isSuperadmin/isManager/adminNav nav flags from the new permission layer"
```

---

## Task 6: App-Routing umstellen

**Files:**
- Modify: `src/app.js:92-110`
- Modify: `views/admin/_nav.ejs`

**Interfaces:**
- Consumes: `requireAdminAreaAccess`, `requirePermission` (Task 3), `res.locals.adminNav` (Task 5).

- [ ] **Step 1: Rewire the admin mount and per-router gates**

In `src/app.js`, add the import (near the other middleware imports, after line 11):

```javascript
import { requireAdminAreaAccess, requirePermission } from './middleware/permissions.js';
```

Replace lines 92-110:

```javascript
  app.use('/admin', sessionLimiter, requireAdminAreaAccess(db, config));
  app.get('/admin', (req, res) => {
    const zeitstempelWarnungSchwelle = Number(getConfigValue(db, 'zeitstempel_warnung_ab_stunden'));
    const tsaAktiv = Boolean(getConfigValue(db, 'zeitstempel_tsa_url'));
    res.render('admin/dashboard', {
      zeitstempelUeberfaellig: tsaAktiv ? countZeitstempelUeberfaellig(db, zeitstempelWarnungSchwelle) : 0,
      zeitstempelWarnungSchwelle,
    });
  });
  app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db }));
  app.use('/admin/debitoren', requirePermission(db, config, 'debitoren_verwalten'), createDebitorenRouter({ db }));
  app.use('/admin/eskalation', requireRole(config, 'superadmin'), createEskalationRouter({ db }));
  app.use('/admin/erscheinungsbild', requireRole(config, 'superadmin'), createErscheinungsbildRouter({ db, config }));
  app.use('/admin/zeitstempel', requireRole(config, 'superadmin'), createZeitstempelAdminRouter({ db }));
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config }));
  app.use('/admin/mails', requirePermission(db, config, 'mails_einsehen'), createMailsRouter({ db, mailer }));
  app.use('/admin/sync', requirePermission(db, config, 'sync_einsehen'), createSyncRouter({ db }));
  app.use('/admin/abgelehnt', requirePermission(db, config, 'abgelehnt_verwalten'), createAdminAbgelehntRouter({ db }));
  app.use('/admin/geplante-jobs', requirePermission(db, config, 'geplante_jobs_verwalten'), createGeplanteJobsRouter({ db, config, mailer }));
```

`requireAnyRole` must be imported too — add it to the existing `roles.js` import on line 11: `import { loadCurrentPerson, requireRole, requireAnyRole, requireLogin } from './middleware/roles.js';`.

Note: `createPersonenRouter({ db, config })` now takes `config` — Task 8 updates the router itself to accept and use it; until Task 8 lands, the extra property is simply ignored (the current `createPersonenRouter({ db })` destructures only `db`), so this task's own tests below stay green.

- [ ] **Step 2: Update `views/admin/_nav.ejs` to filter by `adminNav`**

```ejs
<ul class="nav nav-pills mb-3">
  <% if (adminNav.konten) { %><li class="nav-item"><a class="nav-link" href="/admin/konten">Konten</a></li><% } %>
  <% if (adminNav.debitoren) { %><li class="nav-item"><a class="nav-link" href="/admin/debitoren">Debitoren</a></li><% } %>
  <% if (adminNav.eskalation) { %><li class="nav-item"><a class="nav-link" href="/admin/eskalation">Eskalationszeiten</a></li><% } %>
  <% if (adminNav.erscheinungsbild) { %><li class="nav-item"><a class="nav-link" href="/admin/erscheinungsbild">Erscheinungsbild</a></li><% } %>
  <% if (adminNav.zeitstempel) { %><li class="nav-item"><a class="nav-link" href="/admin/zeitstempel">Zeitstempel</a></li><% } %>
  <% if (adminNav.personen) { %><li class="nav-item"><a class="nav-link" href="/admin/personen">Personen</a></li><% } %>
  <% if (adminNav.mails) { %><li class="nav-item"><a class="nav-link" href="/admin/mails">Mail-Protokoll</a></li><% } %>
  <% if (adminNav.sync) { %><li class="nav-item"><a class="nav-link" href="/admin/sync">Sync-Übersicht</a></li><% } %>
  <% if (adminNav.geplanteJobs) { %><li class="nav-item"><a class="nav-link" href="/admin/geplante-jobs">Geplante Jobs</a></li><% } %>
  <% if (adminNav.abgelehnt) { %><li class="nav-item"><a class="nav-link" href="/admin/abgelehnt">Abgelehnte Rechnungen</a></li><% } %>
</ul>
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: Several `test/integration/admin/*.test.js` files will now fail — their own local `buildTestApp` still mounts `requireRole(config, 'portal-admin')` directly rather than going through `createApp`, so they're unaffected by this task's `app.js` change and should stay green; but `test/integration/admin/authz-sweep.test.js` exercises the **real** `createApp` and will now fail at `/admin/personen` (needs `requireAnyRole` import wired — verify) — this is expected and fixed in Task 9. Confirm no *other* test regresses; if one does, it's a missed rename from Task 2/5.

- [ ] **Step 4: Commit**

```bash
git add src/app.js views/admin/_nav.ejs
git commit -m "feat: gate each /admin/* section by its own permission instead of one blanket role"
```

---

## Task 7: Vergebbare Admin-Bereiche — Tests auf Manager/Einzelrecht erweitern

**Files:**
- Modify: `test/integration/admin/konten.test.js`
- Modify: `test/integration/admin/debitoren.test.js`
- Modify: `test/integration/admin/mails.test.js`
- Modify: `test/integration/admin/sync.test.js`
- Modify: `test/integration/admin/abgelehnt.test.js`
- Modify: `test/integration/admin/geplanteJobs.test.js`

**Interfaces:**
- Consumes: `requirePermission` (Task 3), `setBerechtigungenForPerson` (Task 1).

Each of these six files independently builds its own Express test app and currently mounts `requireRole(config, 'portal-admin')` directly in front of the router under test. Apply the same three edits to all six (paths/permission names differ per file — see table):

| Test file | Route prefix | Permission |
|---|---|---|
| `konten.test.js` | `/admin/konten` | `konten_verwalten` |
| `debitoren.test.js` | `/admin/debitoren` | `debitoren_verwalten` |
| `mails.test.js` | `/admin/mails` | `mails_einsehen` |
| `sync.test.js` | `/admin/sync` | `sync_einsehen` |
| `abgelehnt.test.js` | `/admin/abgelehnt` | `abgelehnt_verwalten` |
| `geplanteJobs.test.js` | `/admin/geplante-jobs` | `geplante_jobs_verwalten` |

- [ ] **Step 1: Write the failing test (repeat per file, using `konten.test.js` as the concrete example)**

In `test/integration/admin/konten.test.js`:
- Add imports: `import { requirePermission } from '../../../src/middleware/permissions.js';` and `import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';`
- Remove the now-unused `requireRole` import if nothing else in the file uses it (check first — `personen.test.js`-style files only import it for this one mount line).
- In `buildTestApp`, change the `config` literal (line 23) to include `groupIdManager: '30'`, and change line 25 from `app.use('/admin/konten', requireRole(config, 'portal-admin'), createKontenRouter({ db }));` to:

```javascript
  app.use('/admin/konten', requirePermission(db, config, 'konten_verwalten'), createKontenRouter({ db }));
```

Add two new tests (adjust the route path per file):

```javascript
test('GET /admin/konten returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/konten').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/konten returns 200 for a plain person with exactly this individual grant, and 403 for a different one', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Nur', nachname: 'Debitoren', email: 'nur@example.org', gruppen: [], loggedInNow: true });
  setBerechtigungenForPerson(db, '1', ['debitoren_verwalten']);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/konten').set('x-test-person-id', '1');
  assert.equal(res.status, 403);

  setBerechtigungenForPerson(db, '1', ['konten_verwalten']);
  const res2 = await request(app).get('/admin/konten').set('x-test-person-id', '1');
  assert.equal(res2.status, 200);
  db.close();
});
```

Repeat this pattern in the other five files, substituting the route path/permission per the table above (e.g. in `mails.test.js`, the "different permission" grant in the second test should be something other than `mails_einsehen`, e.g. `sync_einsehen`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration/admin/konten.test.js test/integration/admin/debitoren.test.js test/integration/admin/mails.test.js test/integration/admin/sync.test.js test/integration/admin/abgelehnt.test.js test/integration/admin/geplanteJobs.test.js`
Expected: FAIL until each file's `buildTestApp` mount line is updated (see Step 1's inline fix).

- [ ] **Step 3: No further production code changes — the mount-line edit from Step 1 is the fix**

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration/admin/konten.test.js test/integration/admin/debitoren.test.js test/integration/admin/mails.test.js test/integration/admin/sync.test.js test/integration/admin/abgelehnt.test.js test/integration/admin/geplanteJobs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/integration/admin/konten.test.js test/integration/admin/debitoren.test.js test/integration/admin/mails.test.js test/integration/admin/sync.test.js test/integration/admin/abgelehnt.test.js test/integration/admin/geplanteJobs.test.js
git commit -m "test: confirm Manager and individual grants reach the six bundled admin sections"
```

---

## Task 8: Personen-Seite — Rollen-Badges & Einzelrechte-UI

**Files:**
- Modify: `src/routes/admin/personen.js`
- Modify: `views/admin/personen-liste.ejs`
- Modify: `test/integration/admin/personen.test.js`

**Interfaces:**
- Consumes: `personHasRole`, `requireRole` (Task 2); `GRANTABLE_BERECHTIGUNGEN`, `BERECHTIGUNG_LABELS` (Task 3); `listBerechtigungenForPerson`, `setBerechtigungenForPerson` (Task 1).
- Produces: `createPersonenRouter({ db, config })` (signature change — was `{ db }`), new route `POST /admin/personen/:id/berechtigungen` (hard-locked to `superadmin`, independent of the mount-level `requireAnyRole(['superadmin','manager'])` gate).

- [ ] **Step 1: Write the failing test**

Update `test/integration/admin/personen.test.js`'s `buildTestApp` (add `config` param passthrough, add `groupIdManager: '30'` to the config literal, and change the mount to `requireAnyRole`):

```javascript
import { loadCurrentPerson, requireAnyRole, requireRole } from '../../../src/middleware/roles.js';
// ...
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/personen', requireAnyRole(config, ['superadmin', 'manager']), createPersonenRouter({ db, config }));
  return app;
}
```

Rename the existing `'portal-admin'`-referencing test descriptions/seed data (`gruppen: ['20']` stays — it's still the Superadmin group) as needed for clarity, then add:

```javascript
test('GET /admin/personen returns 200 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  db.close();
});

test('GET /admin/personen shows a role badge per person and rights checkboxes, disabled for a Manager viewer', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: false });
  const app = buildTestApp(db);

  const asSuperadmin = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.match(asSuperadmin.text, /Superadmin/);
  assert.match(asSuperadmin.text, /Manager/);
  assert.doesNotMatch(asSuperadmin.text, /disabled/, 'superadmin must be able to edit the checkboxes');

  const asManager = await request(app).get('/admin/personen').set('x-test-person-id', '55');
  assert.equal(asManager.status, 200);
  assert.match(asManager.text, /disabled/, 'manager must see read-only checkboxes');
  db.close();
});

test('POST /admin/personen/:id/berechtigungen returns 403 for a Manager', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .set('x-test-person-id', '55')
    .send({ berechtigungen: ['konten_verwalten'] });
  assert.equal(res.status, 403);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen sets the given rights for a Superadmin, and clears them when none are submitted', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);

  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'mails_einsehen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1').sort(), ['konten_verwalten', 'mails_einsehen']);

  await request(app).post('/admin/personen/1/berechtigungen').set('x-test-person-id', '99').send({});
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), []);
  db.close();
});

test('POST /admin/personen/:id/berechtigungen ignores a value outside the catalog instead of crashing', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Ziel', nachname: 'Person', email: 'z@example.org', gruppen: [], loggedInNow: false });
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/personen/1/berechtigungen')
    .set('x-test-person-id', '99')
    .send({ berechtigungen: ['konten_verwalten', 'basis_einstellungen'] });
  assert.equal(res.status, 302);
  assert.deepEqual(listBerechtigungenForPerson(db, '1'), ['konten_verwalten']);
  db.close();
});
```

Add the two new imports at the top: `import { requireAnyRole } from '../../../src/middleware/roles.js';` (adjust the existing `roles.js` import line) and `import { listBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/personen.test.js`
Expected: FAIL — `createPersonenRouter` doesn't accept `config`, no `POST /:id/berechtigungen` route exists, view has no badges/checkboxes.

- [ ] **Step 3: Implement the router**

Replace `src/routes/admin/personen.js`:

```javascript
import { Router } from 'express';
import { listAllPersons } from '../../db/personenRepo.js';
import { personHasRole, requireRole } from '../../middleware/roles.js';
import { listBerechtigungenForPerson, setBerechtigungenForPerson } from '../../db/personBerechtigungenRepo.js';
import { GRANTABLE_BERECHTIGUNGEN, BERECHTIGUNG_LABELS } from '../../middleware/permissions.js';

function rolleVon(person, config) {
  if (personHasRole(person, config, 'superadmin')) return 'Superadmin';
  if (personHasRole(person, config, 'manager')) return 'Manager';
  return 'Benutzer';
}

export function createPersonenRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    const bearbeitbar = personHasRole(req.currentPerson, config, 'superadmin');
    const personen = listAllPersons(db).map((p) => ({
      ...p,
      rolle: rolleVon(p, config),
      berechtigungen: listBerechtigungenForPerson(db, p.churchtools_person_id),
    }));
    res.render('admin/personen-liste', {
      personen,
      bearbeitbar,
      grantableBerechtigungen: GRANTABLE_BERECHTIGUNGEN,
      berechtigungLabels: BERECHTIGUNG_LABELS,
    });
  });

  router.post('/:id/berechtigungen', requireRole(config, 'superadmin'), (req, res) => {
    const angefordert = [].concat(req.body.berechtigungen || []);
    const gueltig = angefordert.filter((b) => GRANTABLE_BERECHTIGUNGEN.includes(b));
    setBerechtigungenForPerson(db, req.params.id, gueltig);
    res.redirect('/admin/personen');
  });

  return router;
}
```

- [ ] **Step 4: Implement the view**

Replace `views/admin/personen-liste.ejs`:

```ejs
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Personen — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <h1>Personen</h1>
    <div class="table-responsive">
      <table class="table align-middle">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Rolle</th><th>Einzelrechte</th><th>Hinweis</th></tr></thead>
        <tbody>
          <% personen.forEach((p) => { %>
            <tr>
              <td><%= p.vorname %> <%= p.nachname %></td>
              <td><%= p.email %></td>
              <td><span class="badge <%= p.aktiv ? 'text-bg-success' : 'text-bg-secondary' %>"><%= p.aktiv ? 'Aktiv' : 'Inaktiv' %></span></td>
              <td><span class="badge text-bg-info"><%= p.rolle %></span></td>
              <td>
                <% if (p.rolle !== 'Benutzer') { %>
                  <span class="text-muted small">bereits über Rolle <%= p.rolle %> enthalten</span>
                <% } %>
                <form method="post" action="/admin/personen/<%= p.churchtools_person_id %>/berechtigungen" class="d-flex flex-wrap gap-2 mt-1">
                  <% grantableBerechtigungen.forEach((berechtigung) => { %>
                    <div class="form-check form-check-inline">
                      <input
                        class="form-check-input"
                        type="checkbox"
                        name="berechtigungen"
                        value="<%= berechtigung %>"
                        id="berechtigung-<%= p.churchtools_person_id %>-<%= berechtigung %>"
                        <%= p.berechtigungen.includes(berechtigung) ? 'checked' : '' %>
                        <%= bearbeitbar ? '' : 'disabled' %>
                      >
                      <label class="form-check-label small" for="berechtigung-<%= p.churchtools_person_id %>-<%= berechtigung %>"><%= berechtigungLabels[berechtigung] %></label>
                    </div>
                  <% }) %>
                  <% if (bearbeitbar) { %>
                    <button type="submit" class="btn btn-sm btn-outline-primary">Speichern</button>
                  <% } %>
                </form>
              </td>
              <td>
                <% if (p.ct_person_unresolved) { %><span class="text-warning d-block">⚠️ Person in ChurchTools nicht auflösbar (nicht auflösbar)</span><% } %>
                <% if (p.aktiv && p.gruppen.length === 0) { %><span class="text-warning d-block">⚠️ Nicht mehr in einer ChurchTools-Gruppe, aber weiterhin als Freigeber/Stellvertreter auf einem Konto hinterlegt</span><% } %>
              </td>
            </tr>
          <% }) %>
        </tbody>
      </table>
    </div>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

- [ ] **Step 5: Run test to verify it passes, then the full suite**

Run: `node --test test/integration/admin/personen.test.js`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/personen.js views/admin/personen-liste.ejs test/integration/admin/personen.test.js
git commit -m "feat: add role badges and superadmin-only individual-rights editing to /admin/personen"
```

---

## Task 9: authz-sweep.test.js aktualisieren

**Files:**
- Modify: `test/integration/admin/authz-sweep.test.js`

**Interfaces:**
- Consumes: the real `createApp({ db, config })` (Task 6's wiring) end-to-end.

- [ ] **Step 1: Write the failing test**

In `test/integration/admin/authz-sweep.test.js`:

1. Add two imports: `import { setupMockChurchTools } from '../../helpers/mockChurchTools.js';` and `import { upsertPerson } from '../../../src/db/personenRepo.js';`.
2. Add `groupIdManager: '30'` to `testConfig()`'s `churchtools` object (alongside the existing `groupIdBuchhaltung`/`groupIdAdmin`).
3. Add the new route to `ADMIN_ROUTES`: `{ method: 'post', path: '/admin/personen/1/berechtigungen' }` (after the existing `{ method: 'get', path: '/admin/personen' }` line), and bump the sanity-check count from `30` to `31` in the test body and its assertion message.
4. Add a `loginAs` helper, matching the exact pattern already used against the real `createApp` in `test/integration/authzModellEndToEnd.test.js:33-49` — that file drives `/auth/login` + `/auth/callback` through a mocked ChurchTools rather than injecting a session header, because (unlike the hand-built `buildTestApp`s in the other `test/integration/admin/*.test.js` files) this test exercises the real app, where a session is only ever established through that real login route:

```javascript
async function loginAs(app, client, { id, vorname, nachname, email, gruppen }) {
  client.intercept({ path: '/oauth/access_token', method: 'POST' }).reply(200, { access_token: `tok-${id}` });
  client.intercept({ path: '/oauth/userinfo', method: 'GET' }).reply(200, { id, firstName: vorname, lastName: nachname, email });
  client
    .intercept({ path: '/api/groups/10/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('10') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/20/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('20') ? [{ personId: id }] : [] });
  client
    .intercept({ path: '/api/groups/30/members', method: 'GET' })
    .reply(200, { data: gruppen.includes('30') ? [{ personId: id }] : [] });

  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callbackRes = await agent.get('/auth/callback').query({ code: `code-${id}`, state });
  assert.equal(callbackRes.status, 302, `login for person ${id} should succeed`);
  return agent;
}
```

Unlike `authzModellEndToEnd.test.js` (which only ever logs in Buchhaltung/Superadmin members and so only needs to intercept groups 10/20), this helper always intercepts group 30 too, since this task specifically needs to log in a Manager.

5. Add a second test in the same file, using `loginAs` to get an authenticated `supertest` agent (not a raw cookie string) and issuing every request straight from that agent:

```javascript
test('the real createApp wiring enforces the superadmin-only hard lock and the manager bundle correctly', async () => {
  const db = openDatabase(':memory:');
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const config = testConfig(brandingDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  const managerAgent = await loginAs(app, client, { id: 55, vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'] });

  const HART_GESPERRT = [
    { method: 'get', path: '/admin/eskalation' },
    { method: 'get', path: '/admin/erscheinungsbild' },
    { method: 'get', path: '/admin/zeitstempel' },
  ];
  for (const { method, path } of HART_GESPERRT) {
    const res = await managerAgent[method](path);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} must stay superadmin-only even for a Manager`);
  }

  const VERGEBBAR = [
    { method: 'get', path: '/admin/konten' },
    { method: 'get', path: '/admin/debitoren' },
    { method: 'get', path: '/admin/mails' },
    { method: 'get', path: '/admin/sync' },
    { method: 'get', path: '/admin/abgelehnt' },
    { method: 'get', path: '/admin/geplante-jobs' },
  ];
  for (const { method, path } of VERGEBBAR) {
    const res = await managerAgent[method](path);
    assert.notEqual(res.status, 403, `${method.toUpperCase()} ${path} must be reachable by a Manager`);
  }

  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
```

Note this test does not call `upsertPerson` directly — `loginAs` creates the Manager's `personen` row itself via the real `/auth/callback` flow (same as `authzModellEndToEnd.test.js`), which is what makes this a true end-to-end proof of Task 6's wiring rather than a shortcut around it. The `upsertPerson` import from Step 1 is kept for a follow-up assertion only if one of `VERGEBBAR`'s 200s needs seeded data to render without erroring (e.g. `/admin/sync` renders `sync_log` rows, which is fine empty) — if any route 500s on empty data during Step 2's run, seed the minimal row that route needs via `upsertPerson`/the relevant repo function before asserting, rather than changing the route's own behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/authz-sweep.test.js`
Expected: FAIL — new route/count mismatch, and the new manager-tier test fails until the session-login helper is wired correctly.

- [ ] **Step 3: No further production code changes — Task 6 already wired the real app**

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `node --test test/integration/admin/authz-sweep.test.js`
Expected: PASS

Run: `npm test`
Expected: PASS — full green suite confirms Tasks 1-9 compose correctly end-to-end.

- [ ] **Step 5: Commit**

```bash
git add test/integration/admin/authz-sweep.test.js
git commit -m "test: extend the real-app authz sweep to cover the manager tier and the new berechtigungen route"
```

---

## Task 10: Dokumentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** None — documentation only, no code.

- [ ] **Step 1: Update `.env.example`**

After the existing `CT_GROUP_ID_ADMIN=` line (line 27), add:

```
# Optional: ChurchTools-Gruppen-ID für die Manager-Rolle (Zugriff auf die meisten, aber nicht alle
# Admin-Bereiche -- siehe docs/superpowers/specs/2026-08-23-mehrstufige-rechteverwaltung-design.md).
# Ohne diese Variable existiert die Manager-Stufe schlicht nicht.
# CT_GROUP_ID_MANAGER=
```

- [ ] **Step 2: Update `README.md`**

In the variable table (line 70), change:
```
| `CT_BASE_URL`, `CT_CLIENT_ID`, `CT_CLIENT_SECRET`, `CT_REDIRECT_URI`, `CT_GROUP_ID_BUCHHALTUNG`, `CT_GROUP_ID_ADMIN` | aus der bereits registrierten ChurchTools-OAuth2-Anwendung |
```
to:
```
| `CT_BASE_URL`, `CT_CLIENT_ID`, `CT_CLIENT_SECRET`, `CT_REDIRECT_URI`, `CT_GROUP_ID_BUCHHALTUNG`, `CT_GROUP_ID_ADMIN` | aus der bereits registrierten ChurchTools-OAuth2-Anwendung |
| `CT_GROUP_ID_MANAGER` (optional) | ChurchTools-Gruppe für die Manager-Rolle — Zugriff auf die meisten, aber nicht alle Admin-Bereiche; ohne diese Variable existiert die Rolle schlicht nicht |
```

In the "Vor dem ersten Login" section (lines 74-81), rename the heading and body:
```markdown
### Vor dem ersten Login — Superadmin-Bootstrap

Der `/admin`-Bereich ist ausschliesslich über ChurchTools-Gruppenmitgliedschaft
zugänglich (`CT_GROUP_ID_ADMIN` für Superadmin, optional `CT_GROUP_ID_MANAGER`
für die eingeschränktere Manager-Rolle), es gibt keinen anderen Weg, Admin-Rechte
zu vergeben. **Bevor die erste Person sich einloggt**, muss diese Person in
ChurchTools bereits Mitglied der Superadmin-Gruppe sein — sonst kann sich
zwar jeder einloggen (Login ist seit Batch 4 nicht mehr gruppengebunden),
aber niemand erreicht `/admin`, um z. B. das erste Konto anzulegen oder die
Manager-Gruppe später Einzelrechte zuzuweisen.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document the optional CT_GROUP_ID_MANAGER variable and rename Portal-Admin to Superadmin"
```

---

## Self-Review Notes

- **Spec coverage:** Rollenmodell (Task 2), Berechtigungs-Katalog (Task 3), Datenmodell (Task 1), Middleware (Task 3), Routing (Task 6), UI-Änderungen (Tasks 5, 6, 8), Konfiguration & Rollout (Task 10) — all spec sections have a task. The spec's explicit exclusions (no Manager-bundle revocation, no in-app Manager/Superadmin assignment, no consolidated Basis-Einstellungen page, no `CT_GROUP_ID_ADMIN` rename) are respected — no task implements any of them.
- **Manager/Superadmin assignment stays ChurchTools-only**, per spec — confirmed no task adds an in-app UI for that; Task 8 only edits `person_berechtigungen`.
- **Type/name consistency checked:** `personHasPermission(db, config, person, permission)` (Task 3) is called with the same argument order in Task 5 (`nav.js`) and consumed identically in Task 6 (`requirePermission(db, config, permission)`); `GRANTABLE_BERECHTIGUNGEN`/`BERECHTIGUNG_LABELS` (Task 3) are the exact names imported in Tasks 5 and 8; `createPersonenRouter({ db, config })` signature (Task 8) matches the call site introduced in Task 6.
