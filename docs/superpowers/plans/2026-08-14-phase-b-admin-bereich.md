# Freigabeportal Phase B: Admin-Bereich — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the protected `/admin/*` area: Konten-CRUD (four-role hard validation), Zuweisungsregeln-CRUD, Eskalationszeiten config, Erscheinungsbild (logo/colors/dark-light-mode), and a read-only Personen-Übersicht — all gated server-side by Phase A's `requireRole`.

**Architecture:** Server-rendered Express/EJS routes under `/admin/*`, each family (Konten, Zuweisungsregeln, Eskalation, Erscheinungsbild, Personen) its own router mounted individually behind `requireRole(config, 'portal-admin')`. Two new SQLite tables (`konten`, `zuweisungsregeln`); Eskalationszeiten and Branding reuse Phase A's generic `admin_config` key/value store. A new global `loadBranding` middleware + shared `_header.ejs` partial bring logo/colors/dark-light-mode to every page, not just `/admin/*`.

**Tech Stack:** Same as Phase A (Node ≥22.13.0, Express, EJS, `node:sqlite`, `node:test`, `supertest`). New dependency: `multer` (pure JS, no native compilation) for the logo file upload.

**Spec:** `docs/superpowers/specs/2026-08-14-phase-b-admin-bereich-design.md`

## Global Constraints

- `requireRole(config, 'portal-admin')` must gate **every** route under `/admin/*` server-side — mounted so it runs before any route handler, never relying on hidden UI. No route family may be reachable without it.
- Konten are **never hard-deleted**, only deactivated (`aktiv` flag) — later phases reference `konto_id` by foreign key.
- Zuweisungsregeln **may be hard-deleted** — no audit dependency on them.
- Konten validation (create AND edit): all four roles (`freigeber1_id`, `stellvertreter1_id`, `freigeber2_id`, `stellvertreter2_id`) are required, must be **four pairwise-distinct** active persons (not just `freigeber1 != freigeber2` — stricter, per spec).
- `zuweisungsregeln.absender_muster` must be unique (DB constraint + a friendly German duplicate error, not a raw 500).
- Eskalationszeiten and Branding config live in `admin_config` (Phase A's generic key/value store) — no new dedicated tables for them.
- Logo uploads: PNG/JPEG only (no SVG), max 2 MB, mimetype checked server-side (not just file extension).
- Dark/Light theme precedence: user's `theme` cookie (if set) always wins; else admin's `branding_theme_default` (`hell`/`dunkel`) if not `system`; else no forced `data-theme` attribute — `prefers-color-scheme` decides client-side.
- All user-facing text is German.
- Tests: real HTTP via `supertest` against a real in-memory `node:sqlite` DB, no mocking of this project's own business logic (matches Phase A's testing convention).
- `npm test` runs `node --test 'test/**/*.test.js'` (fixed in Phase A — do not change this script).

---

### Task 1: Schema additions + admin_config seed defaults

**Files:**
- Modify: `src/db/schema.sql` — add `konten` and `zuweisungsregeln` tables
- Modify: `src/db/adminConfigRepo.js` — extend `DEFAULTS` with branding keys
- Modify: `test/unit/db.test.js` — assert the two new tables exist
- Modify: `test/unit/adminConfigRepo.test.js` — assert the new defaults are seeded

**Interfaces:**
- Consumes: nothing new.
- Produces: `konten` table (`id, kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv`), `zuweisungsregeln` table (`id, absender_muster UNIQUE, konto_id`). `admin_config` seeded with `branding_farbe_primaer: '#2f4858'`, `branding_farbe_sekundaer: '#4d7ea8'`, `branding_theme_default: 'system'` (alongside Phase A's `reminder_stunden`/`eskalation_stunden`).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/db.test.js` (inside the existing `'openDatabase creates all expected tables'` test, extend the `for` loop's expected list):

```js
test('openDatabase creates all expected tables', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map((r) => r.name);
  for (const expected of ['personen', 'sessions', 'sync_log', 'admin_config', 'konten', 'zuweisungsregeln']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  db.close();
});
```

Add to `test/unit/adminConfigRepo.test.js`:

```js
test('seedDefaults sets branding defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  assert.equal(getConfigValue(db, 'branding_farbe_sekundaer'), '#4d7ea8');
  assert.equal(getConfigValue(db, 'branding_theme_default'), 'system');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/db.test.js test/unit/adminConfigRepo.test.js`
Expected: FAIL — `konten`/`zuweisungsregeln` tables and branding defaults don't exist yet.

- [ ] **Step 3: Update `src/db/schema.sql`** — append at the end of the file

```sql
CREATE TABLE IF NOT EXISTS konten (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kontonummer TEXT NOT NULL,
  bezeichnung TEXT NOT NULL,
  freigeber1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter1_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  freigeber2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  stellvertreter2_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  aktiv INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS zuweisungsregeln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  absender_muster TEXT NOT NULL UNIQUE,
  konto_id INTEGER NOT NULL REFERENCES konten(id)
);
```

- [ ] **Step 4: Update `src/db/adminConfigRepo.js`** — extend the `DEFAULTS` object

```js
const DEFAULTS = {
  reminder_stunden: '24',
  eskalation_stunden: '48',
  branding_farbe_primaer: '#2f4858',
  branding_farbe_sekundaer: '#4d7ea8',
  branding_theme_default: 'system',
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/db.test.js test/unit/adminConfigRepo.test.js`
Expected: PASS

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/adminConfigRepo.js test/unit/db.test.js test/unit/adminConfigRepo.test.js
git commit -m "feat: konten/zuweisungsregeln schema and branding admin_config defaults"
```

---

### Task 2: kontenRepo.js — CRUD + four-role validation

**Files:**
- Create: `src/db/kontenRepo.js`
- Test: `test/unit/kontenRepo.test.js`

**Interfaces:**
- Consumes: `getPersonById(db, id)`, `upsertPerson` (Phase A, `src/db/personenRepo.js`); `openDatabase` (Phase A).
- Produces: `createKonto(db, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id })` → `number` (new id). `updateKonto(db, id, { same fields })` → `void`. `deactivateKonto(db, id)` → `void`. `getKontoById(db, id)` → row object or `null`. `listKonten(db, { includeInactive = false } = {})` → `array`. `validateKontoRoles(db, { freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id })` → `string[]` (German error messages; empty array = valid).

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/kontenRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import {
  createKonto,
  updateKonto,
  deactivateKonto,
  getKontoById,
  listKonten,
  validateKontoRoles,
} from '../../src/db/kontenRepo.js';

function seedPersonen(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
}

test('createKonto inserts and getKontoById reads it back', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, {
    kontonummer: '3000',
    bezeichnung: 'Unterhalt',
    freigeber1Id: '1',
    stellvertreter1Id: '2',
    freigeber2Id: '3',
    stellvertreter2Id: '4',
  });
  const konto = getKontoById(db, id);
  assert.equal(konto.kontonummer, '3000');
  assert.equal(konto.freigeber1_id, '1');
  assert.equal(konto.aktiv, 1);
  db.close();
});

test('updateKonto changes fields in place', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  updateKonto(db, id, { kontonummer: '3001', bezeichnung: 'Unterhalt neu', freigeber1Id: '5', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const konto = getKontoById(db, id);
  assert.equal(konto.kontonummer, '3001');
  assert.equal(konto.freigeber1_id, '5');
  db.close();
});

test('deactivateKonto sets aktiv to 0 without deleting the row', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const id = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, id);
  const konto = getKontoById(db, id);
  assert.equal(konto.aktiv, 0);
  db.close();
});

test('getKontoById returns null for an unknown id', () => {
  const db = openDatabase(':memory:');
  assert.equal(getKontoById(db, 999), null);
  db.close();
});

test('listKonten returns only active konten by default, all when includeInactive', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const activeId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Aktiv', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const inactiveId = createKonto(db, { kontonummer: '3001', bezeichnung: 'Inaktiv', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  deactivateKonto(db, inactiveId);

  const activeOnly = listKonten(db);
  assert.equal(activeOnly.length, 1);
  assert.equal(activeOnly[0].id, activeId);

  const all = listKonten(db, { includeInactive: true });
  assert.equal(all.length, 2);
  db.close();
});

test('validateKontoRoles rejects missing fields', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.ok(errors.length > 0);
  db.close();
});

test('validateKontoRoles rejects when two roles are the same person', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '1' });
  assert.ok(errors.some((e) => e.includes('unterschiedliche Personen')));
  db.close();
});

test('validateKontoRoles rejects an inactive person in any role', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  upsertPerson(db, { id: '1', vorname: 'Person1', nachname: 'Muster', email: 'p1@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('1');
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.ok(errors.some((e) => e.includes('nicht (mehr) aktiv')));
  db.close();
});

test('validateKontoRoles accepts four distinct active persons', () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const errors = validateKontoRoles(db, { freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.deepEqual(errors, []);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: FAIL — `src/db/kontenRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/kontenRepo.js`**

```js
import { getPersonById } from './personenRepo.js';

const ROLE_KEYS = ['freigeber1Id', 'stellvertreter1Id', 'freigeber2Id', 'stellvertreter2Id'];
const ROLE_LABELS = {
  freigeber1Id: 'Freigeber 1',
  stellvertreter1Id: 'Stellvertreter 1',
  freigeber2Id: 'Freigeber 2',
  stellvertreter2Id: 'Stellvertreter 2',
};

export function validateKontoRoles(db, roles) {
  const errors = [];

  for (const key of ROLE_KEYS) {
    if (!roles[key]) {
      errors.push(`${ROLE_LABELS[key]} ist ein Pflichtfeld.`);
    }
  }
  if (errors.length > 0) return errors;

  const values = ROLE_KEYS.map((key) => roles[key]);
  if (new Set(values).size !== values.length) {
    errors.push('Freigeber 1, Stellvertreter 1, Freigeber 2 und Stellvertreter 2 müssen vier unterschiedliche Personen sein.');
  }

  for (const key of ROLE_KEYS) {
    const person = getPersonById(db, roles[key]);
    if (!person || !person.aktiv) {
      errors.push(`${ROLE_LABELS[key]}: gewählte Person ist nicht (mehr) aktiv.`);
    }
  }

  return errors;
}

export function createKonto(db, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id }) {
  const result = db
    .prepare(
      `INSERT INTO konten (kontonummer, bezeichnung, freigeber1_id, stellvertreter1_id, freigeber2_id, stellvertreter2_id, aktiv)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id);
  return Number(result.lastInsertRowid);
}

export function updateKonto(db, id, { kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id }) {
  db.prepare(
    `UPDATE konten SET kontonummer = ?, bezeichnung = ?, freigeber1_id = ?, stellvertreter1_id = ?, freigeber2_id = ?, stellvertreter2_id = ?
     WHERE id = ?`
  ).run(kontonummer, bezeichnung, freigeber1Id, stellvertreter1Id, freigeber2Id, stellvertreter2Id, id);
}

export function deactivateKonto(db, id) {
  db.prepare('UPDATE konten SET aktiv = 0 WHERE id = ?').run(id);
}

export function getKontoById(db, id) {
  return db.prepare('SELECT * FROM konten WHERE id = ?').get(id) ?? null;
}

export function listKonten(db, { includeInactive = false } = {}) {
  if (includeInactive) {
    return db.prepare('SELECT * FROM konten ORDER BY kontonummer').all();
  }
  return db.prepare('SELECT * FROM konten WHERE aktiv = 1 ORDER BY kontonummer').all();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/kontenRepo.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/kontenRepo.js test/unit/kontenRepo.test.js
git commit -m "feat: konten repository with four-role hard validation"
```

---

### Task 3: zuweisungsregelnRepo.js

**Files:**
- Create: `src/db/zuweisungsregelnRepo.js`
- Test: `test/unit/zuweisungsregelnRepo.test.js`

**Interfaces:**
- Consumes: `createKonto`, `listKonten` (Task 2, for test setup only).
- Produces: `createZuweisungsregel(db, { absenderMuster, kontoId })` → `number`. `updateZuweisungsregel(db, id, { absenderMuster, kontoId })` → `void`. `deleteZuweisungsregel(db, id)` → `void`. `getZuweisungsregelById(db, id)` → row or `null`. `listZuweisungsregeln(db)` → `array`. `findZuweisungsregelByMuster(db, absenderMuster)` → row or `null`.

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/zuweisungsregelnRepo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import {
  createZuweisungsregel,
  updateZuweisungsregel,
  deleteZuweisungsregel,
  getZuweisungsregelById,
  listZuweisungsregeln,
  findZuweisungsregelByMuster,
} from '../../src/db/zuweisungsregelnRepo.js';

function seedKonto(db) {
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

test('createZuweisungsregel inserts and getZuweisungsregelById reads it back', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  const regel = getZuweisungsregelById(db, id);
  assert.equal(regel.absender_muster, 'lieferant.ch');
  assert.equal(regel.konto_id, kontoId);
  db.close();
});

test('updateZuweisungsregel changes fields in place', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  updateZuweisungsregel(db, id, { absenderMuster: 'rechnungen@lieferant.ch', kontoId });
  assert.equal(getZuweisungsregelById(db, id).absender_muster, 'rechnungen@lieferant.ch');
  db.close();
});

test('deleteZuweisungsregel removes the row', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const id = createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  deleteZuweisungsregel(db, id);
  assert.equal(getZuweisungsregelById(db, id), null);
  db.close();
});

test('listZuweisungsregeln returns all rules sorted by pattern', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'z-lieferant.ch', kontoId });
  createZuweisungsregel(db, { absenderMuster: 'a-lieferant.ch', kontoId });
  const rows = listZuweisungsregeln(db);
  assert.deepEqual(rows.map((r) => r.absender_muster), ['a-lieferant.ch', 'z-lieferant.ch']);
  db.close();
});

test('findZuweisungsregelByMuster finds an existing rule and returns null otherwise', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.ok(findZuweisungsregelByMuster(db, 'lieferant.ch'));
  assert.equal(findZuweisungsregelByMuster(db, 'unbekannt.ch'), null);
  db.close();
});

test('the absender_muster UNIQUE constraint rejects a duplicate insert', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId });
  assert.throws(() => createZuweisungsregel(db, { absenderMuster: 'lieferant.ch', kontoId }));
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/zuweisungsregelnRepo.test.js`
Expected: FAIL — `src/db/zuweisungsregelnRepo.js` does not exist yet.

- [ ] **Step 3: Implement `src/db/zuweisungsregelnRepo.js`**

```js
export function createZuweisungsregel(db, { absenderMuster, kontoId }) {
  const result = db.prepare('INSERT INTO zuweisungsregeln (absender_muster, konto_id) VALUES (?, ?)').run(absenderMuster, kontoId);
  return Number(result.lastInsertRowid);
}

export function updateZuweisungsregel(db, id, { absenderMuster, kontoId }) {
  db.prepare('UPDATE zuweisungsregeln SET absender_muster = ?, konto_id = ? WHERE id = ?').run(absenderMuster, kontoId, id);
}

export function deleteZuweisungsregel(db, id) {
  db.prepare('DELETE FROM zuweisungsregeln WHERE id = ?').run(id);
}

export function getZuweisungsregelById(db, id) {
  return db.prepare('SELECT * FROM zuweisungsregeln WHERE id = ?').get(id) ?? null;
}

export function listZuweisungsregeln(db) {
  return db.prepare('SELECT * FROM zuweisungsregeln ORDER BY absender_muster').all();
}

export function findZuweisungsregelByMuster(db, absenderMuster) {
  return db.prepare('SELECT * FROM zuweisungsregeln WHERE absender_muster = ?').get(absenderMuster) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit/zuweisungsregelnRepo.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/zuweisungsregelnRepo.js test/unit/zuweisungsregelnRepo.test.js
git commit -m "feat: zuweisungsregeln repository"
```

---

### Task 4: Branding middleware + shared header partial + public logo route

**Files:**
- Create: `src/middleware/branding.js`
- Create: `src/routes/branding.js`
- Create: `views/_header.ejs`
- Modify: `views/home.ejs`
- Modify: `views/error.ejs`
- Modify: `src/app.js` — mount `loadBranding(db)` globally (before routers) and `createBrandingRouter({ db })` at `/branding`
- Test: `test/unit/branding.test.js`
- Test: `test/integration/branding.test.js`

**Interfaces:**
- Consumes: `getConfigValue` (Phase A, `src/db/adminConfigRepo.js`).
- Produces: `loadBranding(db)` → middleware setting `res.locals.branding = { primaryColor, secondaryColor, hasLogo, themeAttr }` (`themeAttr` is `'hell'`, `'dunkel'`, or `null`). `createBrandingRouter({ db })` → Router with `GET /logo`.

- [ ] **Step 1: Write the failing middleware test**

```js
// test/unit/branding.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { loadBranding } from '../../src/middleware/branding.js';

function runMiddleware(db, cookieHeader) {
  const req = { headers: { cookie: cookieHeader } };
  const res = { locals: {} };
  let nextCalled = false;
  loadBranding(db)(req, res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
  return res.locals.branding;
}

test('with no cookie and theme default "system", themeAttr is null', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.themeAttr, null);
  db.close();
});

test('with no cookie and an admin default of "dunkel", themeAttr follows the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.themeAttr, 'dunkel');
  db.close();
});

test('a user theme cookie overrides the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, 'theme=hell');
  assert.equal(branding.themeAttr, 'hell');
  db.close();
});

test('an invalid theme cookie value is ignored, falling back to the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, 'theme=lila; other=1');
  assert.equal(branding.themeAttr, 'dunkel');
  db.close();
});

test('branding exposes primaryColor, secondaryColor and hasLogo', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.primaryColor, '#2f4858');
  assert.equal(branding.secondaryColor, '#4d7ea8');
  assert.equal(branding.hasLogo, false);
  db.close();
});

test('hasLogo is true once a logo path is configured', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_logo_pfad', '/data/branding/logo.png');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.hasLogo, true);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/branding.test.js`
Expected: FAIL — `src/middleware/branding.js` does not exist yet.

- [ ] **Step 3: Implement `src/middleware/branding.js`**

```js
import { getConfigValue } from '../db/adminConfigRepo.js';

function parseThemeCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('theme='));
  if (!entry) return null;
  const value = decodeURIComponent(entry.slice('theme='.length));
  return value === 'hell' || value === 'dunkel' ? value : null;
}

export function loadBranding(db) {
  return (req, res, next) => {
    const primaryColor = getConfigValue(db, 'branding_farbe_primaer');
    const secondaryColor = getConfigValue(db, 'branding_farbe_sekundaer');
    const themeDefault = getConfigValue(db, 'branding_theme_default') || 'system';
    const logoPfad = getConfigValue(db, 'branding_logo_pfad');

    const userTheme = parseThemeCookie(req.headers.cookie);
    let themeAttr;
    if (userTheme) {
      themeAttr = userTheme;
    } else if (themeDefault === 'hell' || themeDefault === 'dunkel') {
      themeAttr = themeDefault;
    } else {
      themeAttr = null;
    }

    res.locals.branding = {
      primaryColor,
      secondaryColor,
      hasLogo: Boolean(logoPfad),
      themeAttr,
    };
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/branding.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing integration test**

```js
// test/integration/branding.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  };
}

test('GET / renders with no data-theme attribute when default is system and no cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /data-theme=/);
  db.close();
});

test('GET / renders data-theme="dunkel" when a theme cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/').set('Cookie', 'theme=dunkel');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-theme="dunkel"/);
  db.close();
});

test('GET /branding/logo returns 404 when no logo is configured', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/branding/logo');
  assert.equal(res.status, 404);
  db.close();
});

test('the error page also renders the shared header partial', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_theme_default', 'hell');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /data-theme="hell"/);
  db.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/integration/branding.test.js`
Expected: FAIL — `views/_header.ejs` doesn't exist, `loadBranding`/branding route aren't mounted yet.

- [ ] **Step 7: Create `views/_header.ejs`**

```html
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
</style>
<header>
  <% if (branding.hasLogo) { %>
    <img src="/branding/logo" alt="Logo" height="48">
  <% } %>
  <button type="button" id="theme-toggle" aria-label="Farbmodus umschalten">🌓</button>
</header>
<script>
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dunkel' ? 'hell' : 'dunkel';
    root.setAttribute('data-theme', next);
    document.cookie = 'theme=' + next + ';path=/;max-age=31536000;samesite=lax';
  });
</script>
```

- [ ] **Step 8: Modify `views/home.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <h1>Freigabeportal</h1>
  <% if (person) { %>
    <p>Angemeldet als <%= person.vorname %> <%= person.nachname %>.</p>
  <% } else { %>
    <p>Nicht angemeldet. <a href="/auth/login">Anmelden</a></p>
  <% } %>
</body>
</html>
```

- [ ] **Step 9: Modify `views/error.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Fehler — Freigabeportal</title></head>
<body>
  <%- include('_header') %>
  <h1>Es ist ein Fehler aufgetreten</h1>
  <p><%= message %></p>
  <p><a href="/">Zurück zur Startseite</a></p>
</body>
</html>
```

- [ ] **Step 10: Create `src/routes/branding.js`**

```js
import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { getConfigValue } from '../db/adminConfigRepo.js';

export function createBrandingRouter({ db }) {
  const router = Router();

  router.get('/logo', (req, res) => {
    const pfad = getConfigValue(db, 'branding_logo_pfad');
    const mimetype = getConfigValue(db, 'branding_logo_mimetype');
    if (!pfad || !mimetype || !existsSync(pfad)) {
      return res.status(404).end();
    }
    res.type(mimetype);
    createReadStream(pfad).pipe(res);
  });

  return router;
}
```

- [ ] **Step 11: Modify `src/app.js`** — add imports and mount, right after `app.use(loadCurrentPerson(db));`

```js
import { loadBranding } from './middleware/branding.js';
import { createBrandingRouter } from './routes/branding.js';
// ...
app.use(loadBranding(db));
app.use('/branding', createBrandingRouter({ db }));
```

- [ ] **Step 12: Run test to verify it passes**

Run: `node --test test/integration/branding.test.js`
Expected: PASS (4 tests)

- [ ] **Step 13: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 14: Commit**

```bash
git add src/middleware/branding.js src/routes/branding.js views/_header.ejs views/home.ejs views/error.ejs src/app.js test/unit/branding.test.js test/integration/branding.test.js
git commit -m "feat: branding middleware, shared header partial, dark/light mode, public logo route"
```

---

### Task 5: Admin router scaffold + Konten CRUD

**Files:**
- Create: `views/admin/_nav.ejs`
- Create: `views/admin/konten-liste.ejs`
- Create: `views/admin/konten-form.ejs`
- Create: `src/routes/admin/konten.js`
- Modify: `src/db/personenRepo.js` — add `listActivePersons(db)`
- Modify: `src/app.js` — add `express.urlencoded`, mount `/admin/konten` behind `requireRole(config, 'portal-admin')`
- Test: `test/integration/admin/konten.test.js`

**Interfaces:**
- Consumes: `createKonto`, `updateKonto`, `deactivateKonto`, `getKontoById`, `listKonten`, `validateKontoRoles` (Task 2); `requireRole(config, role)` (Phase A, `src/middleware/roles.js`).
- Produces: `listActivePersons(db)` → `Array<{ churchtools_person_id, vorname, nachname, email }>`. `createKontenRouter({ db })` → Router with `GET /`, `GET /neu`, `POST /`, `GET /:id/bearbeiten`, `POST /:id`, `POST /:id/deaktivieren`.

- [ ] **Step 1: Write the failing test**

Session cookies are signed by `express-session` and cannot be forged directly against the
`sessions` table from a test. Instead, build a tiny **test-only** Express app that mounts just
the Konten router behind a stub `req.session`, matching the pattern Phase A's
`test/unit/roles.test.js` already established for testing role-gated behavior without a full
OAuth flow:

```js
// test/integration/admin/konten.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createKontenRouter } from '../../../src/routes/admin/konten.js';

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
  app.use('/admin/konten', requireRole(config, 'portal-admin'), createKontenRouter({ db }));
  return app;
}

function seedPersonen(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
}

const KONTEN_ROUTES = [
  { method: 'get', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/neu' },
  { method: 'post', path: '/admin/konten' },
  { method: 'get', path: '/admin/konten/1/bearbeiten' },
  { method: 'post', path: '/admin/konten/1' },
  { method: 'post', path: '/admin/konten/1/deaktivieren' },
];

test('every Konten route returns 401 without any session, and no Konto is created', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  for (const { method, path } of KONTEN_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM konten').get().n;
  assert.equal(count, 0, 'no Konto should have been created by the unauthenticated POST attempts');
  db.close();
});

test('every Konten route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of KONTEN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

test('GET /admin/konten as portal-admin lists konten', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  db.close();
});

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

test('POST /admin/konten with two identical roles is rejected with a German error, no row created', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'X', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '1' });
  assert.equal(res.status, 400);
  assert.match(res.text, /unterschiedliche Personen/);
  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.doesNotMatch(listRes.text, />X</);
  db.close();
});

test('GET /admin/konten/:id/bearbeiten pre-fills the form, POST /admin/konten/:id updates it', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/konten\/(\d+)\/bearbeiten/);
  assert.ok(idMatch, 'expected an edit link in the list');
  const id = idMatch[1];

  const editRes = await request(app).get(`/admin/konten/${id}/bearbeiten`).set('x-test-person-id', '99');
  assert.equal(editRes.status, 200);
  assert.match(editRes.text, /value="3000"/);

  const updateRes = await request(app)
    .post(`/admin/konten/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3001', bezeichnung: 'Unterhalt neu', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  assert.equal(updateRes.status, 302);

  const listAfter = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.match(listAfter.text, /3001/);
  db.close();
});

test('POST /admin/konten/:id/deaktivieren removes it from the default list but keeps the row', async () => {
  const db = openDatabase(':memory:');
  seedPersonen(db);
  const app = buildTestApp(db);
  await request(app)
    .post('/admin/konten')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });

  const listRes = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/konten\/(\d+)\/deaktivieren/);
  const id = idMatch[1];

  const deactivateRes = await request(app).post(`/admin/konten/${id}/deaktivieren`).set('x-test-person-id', '99');
  assert.equal(deactivateRes.status, 302);

  const listAfter = await request(app).get('/admin/konten').set('x-test-person-id', '99');
  assert.doesNotMatch(listAfter.text, /Unterhalt/);
  const row = db.prepare('SELECT * FROM konten WHERE id = ?').get(Number(id));
  assert.equal(row.aktiv, 0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/konten.test.js`
Expected: FAIL — `src/routes/admin/konten.js` and views don't exist yet.

- [ ] **Step 3: Modify `src/db/personenRepo.js`** — append this export

```js
export function listActivePersons(db) {
  return db
    .prepare('SELECT churchtools_person_id, vorname, nachname, email FROM personen WHERE aktiv = 1 ORDER BY nachname, vorname')
    .all();
}
```

- [ ] **Step 4: Create `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
</nav>
```

- [ ] **Step 5: Create `views/admin/konten-liste.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Konten — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Konten</h1>
  <p><a href="/admin/konten/neu">Neues Konto anlegen</a></p>
  <table>
    <thead>
      <tr><th>Kontonummer</th><th>Bezeichnung</th><th>Freigeber 1</th><th>Freigeber 2</th><th></th></tr>
    </thead>
    <tbody>
      <% konten.forEach((konto) => { %>
        <tr>
          <td><%= konto.kontonummer %></td>
          <td><%= konto.bezeichnung %></td>
          <td><%= konto.freigeber1_id %></td>
          <td><%= konto.freigeber2_id %></td>
          <td>
            <a href="/admin/konten/<%= konto.id %>/bearbeiten">Bearbeiten</a>
            <form method="post" action="/admin/konten/<%= konto.id %>/deaktivieren" style="display:inline">
              <button type="submit">Deaktivieren</button>
            </form>
          </td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 6: Create `views/admin/konten-form.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Konto — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1><%= konto ? 'Konto bearbeiten' : 'Neues Konto' %></h1>
  <% if (errors.length > 0) { %>
    <ul>
      <% errors.forEach((error) => { %><li><%= error %></li><% }) %>
    </ul>
  <% } %>
  <form method="post" action="<%= konto ? `/admin/konten/${konto.id}` : '/admin/konten' %>">
    <label>Kontonummer <input type="text" name="kontonummer" value="<%= values.kontonummer || '' %>" required></label><br>
    <label>Bezeichnung <input type="text" name="bezeichnung" value="<%= values.bezeichnung || '' %>" required></label><br>

    <label>Freigeber 1
      <select name="freigeber1Id" required>
        <option value="">— wählen —</option>
        <% personen.forEach((p) => { %>
          <option value="<%= p.churchtools_person_id %>" <%= values.freigeber1Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
        <% }) %>
      </select>
    </label><br>

    <label>Stellvertreter 1
      <select name="stellvertreter1Id" required>
        <option value="">— wählen —</option>
        <% personen.forEach((p) => { %>
          <option value="<%= p.churchtools_person_id %>" <%= values.stellvertreter1Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
        <% }) %>
      </select>
    </label><br>

    <label>Freigeber 2
      <select name="freigeber2Id" required>
        <option value="">— wählen —</option>
        <% personen.forEach((p) => { %>
          <option value="<%= p.churchtools_person_id %>" <%= values.freigeber2Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
        <% }) %>
      </select>
    </label><br>

    <label>Stellvertreter 2
      <select name="stellvertreter2Id" required>
        <option value="">— wählen —</option>
        <% personen.forEach((p) => { %>
          <option value="<%= p.churchtools_person_id %>" <%= values.stellvertreter2Id === p.churchtools_person_id ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
        <% }) %>
      </select>
    </label><br>

    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

- [ ] **Step 7: Create `src/routes/admin/konten.js`**

```js
import { Router } from 'express';
import { createKonto, updateKonto, deactivateKonto, getKontoById, listKonten, validateKontoRoles } from '../../db/kontenRepo.js';
import { listActivePersons } from '../../db/personenRepo.js';

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
    const konten = listKonten(db, { includeInactive: req.query.alle === '1' });
    res.render('admin/konten-liste', { konten });
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
    res.redirect('/admin/konten');
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
    const errors = validateKontoRoles(db, values);
    if (!values.kontonummer) errors.push('Kontonummer ist ein Pflichtfeld.');
    if (!values.bezeichnung) errors.push('Bezeichnung ist ein Pflichtfeld.');

    if (errors.length > 0) {
      return res.status(400).render('admin/konten-form', { konto, values, errors, personen: listActivePersons(db) });
    }

    updateKonto(db, id, values);
    res.redirect('/admin/konten');
  });

  router.post('/:id/deaktivieren', (req, res) => {
    deactivateKonto(db, Number(req.params.id));
    res.redirect('/admin/konten');
  });

  return router;
}
```

- [ ] **Step 8: Modify `src/app.js`** — add `express.urlencoded`, import `requireRole` and `createKontenRouter`, mount

```js
import { loadCurrentPerson, requireRole } from './middleware/roles.js';
import { createKontenRouter } from './routes/admin/konten.js';
// ...
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// ... (after loadBranding/branding router mount)
app.use('/admin/konten', requireRole(config, 'portal-admin'), createKontenRouter({ db }));
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/admin/konten.test.js`
Expected: PASS (7 tests)

- [ ] **Step 10: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add views/admin/_nav.ejs views/admin/konten-liste.ejs views/admin/konten-form.ejs src/routes/admin/konten.js src/db/personenRepo.js src/app.js test/integration/admin/konten.test.js
git commit -m "feat: admin Konten CRUD with four-role hard validation"
```

---

### Task 6: Zuweisungsregeln CRUD

**Files:**
- Modify: `views/admin/_nav.ejs` — add Zuweisungsregeln link
- Create: `views/admin/zuweisungsregeln-liste.ejs`
- Create: `views/admin/zuweisungsregeln-form.ejs`
- Create: `src/routes/admin/zuweisungsregeln.js`
- Modify: `src/app.js` — mount `/admin/zuweisungsregeln`
- Test: `test/integration/admin/zuweisungsregeln.test.js`

**Interfaces:**
- Consumes: `createZuweisungsregel`, `updateZuweisungsregel`, `deleteZuweisungsregel`, `getZuweisungsregelById`, `listZuweisungsregeln`, `findZuweisungsregelByMuster` (Task 3); `listKonten` (Task 2); `requireRole` (Phase A).
- Produces: `createZuweisungsregelnRouter({ db })` → Router with `GET /`, `GET /neu`, `POST /`, `GET /:id/bearbeiten`, `POST /:id`, `POST /:id/loeschen`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/admin/zuweisungsregeln.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createZuweisungsregelnRouter } from '../../../src/routes/admin/zuweisungsregeln.js';

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
  app.use('/admin/zuweisungsregeln', requireRole(config, 'portal-admin'), createZuweisungsregelnRouter({ db }));
  return app;
}

function seedKonto(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4']) {
    upsertPerson(db, { id, vorname: `Person${id}`, nachname: 'Muster', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  return createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
}

const ZUWEISUNGSREGELN_ROUTES = [
  { method: 'get', path: '/admin/zuweisungsregeln' },
  { method: 'get', path: '/admin/zuweisungsregeln/neu' },
  { method: 'post', path: '/admin/zuweisungsregeln' },
  { method: 'get', path: '/admin/zuweisungsregeln/1/bearbeiten' },
  { method: 'post', path: '/admin/zuweisungsregeln/1' },
  { method: 'post', path: '/admin/zuweisungsregeln/1/loeschen' },
];

test('every Zuweisungsregeln route returns 401 without any session, and no rule is created', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  for (const { method, path } of ZUWEISUNGSREGELN_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM zuweisungsregeln').get().n;
  assert.equal(count, 0, 'no Zuweisungsregel should have been created by the unauthenticated attempts');
  db.close();
});

test('every Zuweisungsregeln route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  for (const { method, path } of ZUWEISUNGSREGELN_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
});

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

test('POST /admin/zuweisungsregeln with a duplicate pattern is rejected with a German error', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  const res = await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });
  assert.equal(res.status, 400);
  assert.match(res.text, /bereits/);
  db.close();
});

test('edit and delete a Zuweisungsregel', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const app = buildTestApp(db);
  await request(app).post('/admin/zuweisungsregeln').set('x-test-person-id', '99').type('form').send({ absenderMuster: 'lieferant.ch', kontoId: String(kontoId) });

  const listRes = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  const idMatch = listRes.text.match(/\/admin\/zuweisungsregeln\/(\d+)\/bearbeiten/);
  const id = idMatch[1];

  const updateRes = await request(app)
    .post(`/admin/zuweisungsregeln/${id}`)
    .set('x-test-person-id', '99')
    .type('form')
    .send({ absenderMuster: 'rechnungen@lieferant.ch', kontoId: String(kontoId) });
  assert.equal(updateRes.status, 302);

  const afterEdit = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.match(afterEdit.text, /rechnungen@lieferant\.ch/);

  const deleteRes = await request(app).post(`/admin/zuweisungsregeln/${id}/loeschen`).set('x-test-person-id', '99');
  assert.equal(deleteRes.status, 302);
  const afterDelete = await request(app).get('/admin/zuweisungsregeln').set('x-test-person-id', '99');
  assert.doesNotMatch(afterDelete.text, /rechnungen@lieferant\.ch/);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/zuweisungsregeln.test.js`
Expected: FAIL — `src/routes/admin/zuweisungsregeln.js` and views don't exist yet.

- [ ] **Step 3: Modify `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
</nav>
```

- [ ] **Step 4: Create `views/admin/zuweisungsregeln-liste.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Zuweisungsregeln — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Zuweisungsregeln</h1>
  <p><a href="/admin/zuweisungsregeln/neu">Neue Regel anlegen</a></p>
  <table>
    <thead><tr><th>Absender-Muster</th><th>Konto</th><th></th></tr></thead>
    <tbody>
      <% regeln.forEach((regel) => { %>
        <tr>
          <td><%= regel.absender_muster %></td>
          <td><%= regel.konto_id %></td>
          <td>
            <a href="/admin/zuweisungsregeln/<%= regel.id %>/bearbeiten">Bearbeiten</a>
            <form method="post" action="/admin/zuweisungsregeln/<%= regel.id %>/loeschen" style="display:inline">
              <button type="submit">Löschen</button>
            </form>
          </td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 5: Create `views/admin/zuweisungsregeln-form.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Zuweisungsregel — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1><%= regel ? 'Zuweisungsregel bearbeiten' : 'Neue Zuweisungsregel' %></h1>
  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>
  <form method="post" action="<%= regel ? `/admin/zuweisungsregeln/${regel.id}` : '/admin/zuweisungsregeln' %>">
    <label>
      Absender-Muster (volle E-Mail-Adresse oder Domain)
      <input type="text" name="absenderMuster" value="<%= values.absenderMuster || '' %>" required>
    </label><br>
    <label>
      Konto
      <select name="kontoId" required>
        <option value="">— wählen —</option>
        <% konten.forEach((k) => { %>
          <option value="<%= k.id %>" <%= String(values.kontoId) === String(k.id) ? 'selected' : '' %>><%= k.kontonummer %> — <%= k.bezeichnung %></option>
        <% }) %>
      </select>
    </label><br>
    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

- [ ] **Step 6: Create `src/routes/admin/zuweisungsregeln.js`**

```js
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

export function createZuweisungsregelnRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/zuweisungsregeln-liste', { regeln: listZuweisungsregeln(db) });
  });

  router.get('/neu', (req, res) => {
    res.render('admin/zuweisungsregeln-form', { regel: null, values: {}, errors: [], konten: listKonten(db) });
  });

  router.post('/', (req, res) => {
    const { absenderMuster, kontoId } = req.body;
    const errors = [];
    if (!absenderMuster) errors.push('Absender-Muster ist ein Pflichtfeld.');
    if (!kontoId) errors.push('Konto ist ein Pflichtfeld.');
    if (absenderMuster && findZuweisungsregelByMuster(db, absenderMuster)) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel: null, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    createZuweisungsregel(db, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln');
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
    const existing = absenderMuster ? findZuweisungsregelByMuster(db, absenderMuster) : null;
    if (existing && existing.id !== id) {
      errors.push('Dieses Absender-Muster ist bereits einem Konto zugewiesen.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/zuweisungsregeln-form', { regel, values: { absenderMuster, kontoId }, errors, konten: listKonten(db) });
    }

    updateZuweisungsregel(db, id, { absenderMuster, kontoId: Number(kontoId) });
    res.redirect('/admin/zuweisungsregeln');
  });

  router.post('/:id/loeschen', (req, res) => {
    deleteZuweisungsregel(db, Number(req.params.id));
    res.redirect('/admin/zuweisungsregeln');
  });

  return router;
}
```

- [ ] **Step 7: Modify `src/app.js`**

```js
import { createZuweisungsregelnRouter } from './routes/admin/zuweisungsregeln.js';
// ...
app.use('/admin/zuweisungsregeln', requireRole(config, 'portal-admin'), createZuweisungsregelnRouter({ db }));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/integration/admin/zuweisungsregeln.test.js`
Expected: PASS (5 tests)

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add views/admin/_nav.ejs views/admin/zuweisungsregeln-liste.ejs views/admin/zuweisungsregeln-form.ejs src/routes/admin/zuweisungsregeln.js src/app.js test/integration/admin/zuweisungsregeln.test.js
git commit -m "feat: admin Zuweisungsregeln CRUD"
```

---

### Task 7: Eskalationszeiten

**Files:**
- Modify: `views/admin/_nav.ejs` — add Eskalation link
- Create: `views/admin/eskalation-form.ejs`
- Create: `src/routes/admin/eskalation.js`
- Modify: `src/app.js` — mount `/admin/eskalation`
- Test: `test/integration/admin/eskalation.test.js`

**Interfaces:**
- Consumes: `getConfigValue`, `setConfigValue` (Phase A, `src/db/adminConfigRepo.js`); `requireRole` (Phase A).
- Produces: `createEskalationRouter({ db })` → Router with `GET /`, `POST /`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/admin/eskalation.test.js
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

test('every Eskalation route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  for (const { method, path } of ESKALATION_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ reminderStunden: '1', eskalationStunden: '2', eskalationFallbackEmail: 'x@example.org' });
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
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ reminderStunden: '1', eskalationStunden: '2', eskalationFallbackEmail: 'x@example.org' });
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
    .send({ reminderStunden: '12', eskalationStunden: '36', eskalationFallbackEmail: 'kirchenpflege@musterkirche.ch' });
  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '12');
  assert.equal(getConfigValue(db, 'eskalation_stunden'), '36');
  assert.equal(getConfigValue(db, 'eskalation_fallback_email'), 'kirchenpflege@musterkirche.ch');
  db.close();
});

test('POST /admin/eskalation with invalid values is rejected, existing config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/eskalation')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ reminderStunden: '-5', eskalationStunden: '36', eskalationFallbackEmail: 'nicht-valide' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'reminder_stunden'), '24');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: FAIL — `src/routes/admin/eskalation.js` and view don't exist yet.

- [ ] **Step 3: Modify `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
</nav>
```

- [ ] **Step 4: Create `views/admin/eskalation-form.ejs`**

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
    <label>Eskalations-Fallback-E-Mail <input type="email" name="eskalationFallbackEmail" value="<%= eskalationFallbackEmail || '' %>" required></label><br>
    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

- [ ] **Step 5: Create `src/routes/admin/eskalation.js`**

```js
import { Router } from 'express';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createEskalationRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/eskalation-form', {
      reminderStunden: getConfigValue(db, 'reminder_stunden'),
      eskalationStunden: getConfigValue(db, 'eskalation_stunden'),
      eskalationFallbackEmail: getConfigValue(db, 'eskalation_fallback_email'),
      errors: [],
    });
  });

  router.post('/', (req, res) => {
    const { reminderStunden, eskalationStunden, eskalationFallbackEmail } = req.body;
    const errors = [];

    const reminderNum = Number(reminderStunden);
    const eskalationNum = Number(eskalationStunden);
    if (!Number.isInteger(reminderNum) || reminderNum <= 0) {
      errors.push('Reminder-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!Number.isInteger(eskalationNum) || eskalationNum <= 0) {
      errors.push('Eskalations-Stunden muss eine positive Ganzzahl sein.');
    }
    if (!EMAIL_PATTERN.test(eskalationFallbackEmail || '')) {
      errors.push('Eskalations-Fallback-E-Mail muss eine gültige E-Mail-Adresse sein.');
    }

    if (errors.length > 0) {
      return res.status(400).render('admin/eskalation-form', { reminderStunden, eskalationStunden, eskalationFallbackEmail, errors });
    }

    setConfigValue(db, 'reminder_stunden', String(reminderNum));
    setConfigValue(db, 'eskalation_stunden', String(eskalationNum));
    setConfigValue(db, 'eskalation_fallback_email', eskalationFallbackEmail);
    res.redirect('/admin/eskalation');
  });

  return router;
}
```

- [ ] **Step 6: Modify `src/app.js`**

```js
import { createEskalationRouter } from './routes/admin/eskalation.js';
// ...
app.use('/admin/eskalation', requireRole(config, 'portal-admin'), createEskalationRouter({ db }));
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/integration/admin/eskalation.test.js`
Expected: PASS (5 tests)

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add views/admin/_nav.ejs views/admin/eskalation-form.ejs src/routes/admin/eskalation.js src/app.js test/integration/admin/eskalation.test.js
git commit -m "feat: admin Eskalationszeiten configuration"
```

---

### Task 8: Erscheinungsbild (Branding admin form + logo upload)

**Files:**
- Modify: `package.json` — add `multer` dependency
- Modify: `src/config/env.js` — add `brandingDir` config field
- Modify: `views/admin/_nav.ejs` — add Erscheinungsbild link
- Create: `views/admin/erscheinungsbild-form.ejs`
- Create: `src/routes/admin/erscheinungsbild.js`
- Modify: `src/app.js` — mount `/admin/erscheinungsbild`
- Test: `test/integration/admin/erscheinungsbild.test.js`

**Interfaces:**
- Consumes: `getConfigValue`, `setConfigValue` (Phase A); `requireRole` (Phase A).
- Produces: `createErscheinungsbildRouter({ db, config })` → Router with `GET /`, `POST /`. `config.brandingDir` (string, default `'./data/branding'`).

- [ ] **Step 1: Install the new dependency**

```bash
npm install multer
```

- [ ] **Step 2: Modify `src/config/env.js`** — add `brandingDir` to the returned config object

```js
export function loadConfig(env = process.env) {
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    sessionSecret: required(env, 'SESSION_SECRET'),
    dbPath: env.DB_PATH || './data/freigabeportal.sqlite',
    brandingDir: env.BRANDING_DIR || './data/branding',
    churchtools: {
      // ... unchanged
    },
    // ... unchanged
  };
}
```

- [ ] **Step 3: Write the failing test**

```js
// test/integration/admin/erscheinungsbild.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createErscheinungsbildRouter } from '../../../src/routes/admin/erscheinungsbild.js';

function buildTestApp(db, brandingDir) {
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
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' }, brandingDir };
  app.use(loadCurrentPerson(db));
  app.use('/admin/erscheinungsbild', requireRole(config, 'portal-admin'), createErscheinungsbildRouter({ db, config }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

const ERSCHEINUNGSBILD_ROUTES = [
  { method: 'get', path: '/admin/erscheinungsbild' },
  { method: 'post', path: '/admin/erscheinungsbild' },
];

test('every Erscheinungsbild route returns 401 without any session, and config is untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  for (const { method, path } of ERSCHEINUNGSBILD_ROUTES) {
    const res = await request(app)[method](path).type('form').send({ primaryColor: '#111111', secondaryColor: '#222222', themeDefault: 'hell' });
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should be 401 without a session`);
  }
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('every Erscheinungsbild route returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  for (const { method, path } of ERSCHEINUNGSBILD_ROUTES) {
    const res = await request(app)[method](path).set('x-test-person-id', '77').type('form').send({ primaryColor: '#111111', secondaryColor: '#222222', themeDefault: 'hell' });
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} should be 403 for a non-admin`);
  }
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

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
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#123456');
  assert.equal(getConfigValue(db, 'branding_theme_default'), 'dunkel');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild with an invalid hex color is rejected, config untouched', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', 'not-a-color')
    .field('secondaryColor', '#abcdef')
    .field('themeDefault', 'system');
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'branding_farbe_primaer'), '#2f4858');
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild with a valid PNG logo saves it and it is servable', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);

  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#2f4858')
    .field('secondaryColor', '#4d7ea8')
    .field('themeDefault', 'system')
    .attach('logo', pngBytes, { filename: 'logo.png', contentType: 'image/png' });

  assert.equal(res.status, 302);
  assert.equal(getConfigValue(db, 'branding_logo_mimetype'), 'image/png');
  const pfad = getConfigValue(db, 'branding_logo_pfad');
  assert.ok(pfad.startsWith(brandingDir));
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});

test('POST /admin/erscheinungsbild rejects a non-image file', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const brandingDir = mkdtempSync(join(tmpdir(), 'branding-test-'));
  const app = buildTestApp(db, brandingDir);

  const res = await request(app)
    .post('/admin/erscheinungsbild')
    .set('x-test-person-id', '99')
    .field('primaryColor', '#2f4858')
    .field('secondaryColor', '#4d7ea8')
    .field('themeDefault', 'system')
    .attach('logo', Buffer.from('not an image'), { filename: 'evil.txt', contentType: 'text/plain' });

  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'branding_logo_pfad'), null);
  db.close();
  rmSync(brandingDir, { recursive: true, force: true });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/integration/admin/erscheinungsbild.test.js`
Expected: FAIL — `src/routes/admin/erscheinungsbild.js` and view don't exist yet.

- [ ] **Step 5: Modify `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
  <a href="/admin/erscheinungsbild">Erscheinungsbild</a>
</nav>
```

- [ ] **Step 6: Create `views/admin/erscheinungsbild-form.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Erscheinungsbild — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Erscheinungsbild</h1>
  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>
  <% if (hasLogo) { %>
    <p>Aktuelles Logo: <img src="/branding/logo" alt="Aktuelles Logo" height="48"></p>
  <% } %>
  <form method="post" action="/admin/erscheinungsbild" enctype="multipart/form-data">
    <label>Primärfarbe <input type="color" name="primaryColor" value="<%= primaryColor %>" required></label><br>
    <label>Sekundärfarbe <input type="color" name="secondaryColor" value="<%= secondaryColor %>" required></label><br>
    <label>Standard-Farbmodus
      <select name="themeDefault">
        <option value="system" <%= themeDefault === 'system' ? 'selected' : '' %>>Folgt Geräteeinstellung</option>
        <option value="hell" <%= themeDefault === 'hell' ? 'selected' : '' %>>Hell</option>
        <option value="dunkel" <%= themeDefault === 'dunkel' ? 'selected' : '' %>>Dunkel</option>
      </select>
    </label><br>
    <label>Logo (PNG oder JPEG, max. 2 MB) <input type="file" name="logo" accept="image/png,image/jpeg"></label><br>
    <button type="submit">Speichern</button>
  </form>
</body>
</html>
```

`type="color"` guarantees the browser only ever submits a valid 6-digit hex value, but the
server-side `HEX_COLOR_PATTERN` check in the route (Step 7) is still the authoritative guard —
non-browser clients (curl, the tests below) can send anything.

- [ ] **Step 7: Create `src/routes/admin/erscheinungsbild.js`**

```js
import { Router } from 'express';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../db/adminConfigRepo.js';

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const VALID_THEME_DEFAULTS = new Set(['hell', 'dunkel', 'system']);
const ALLOWED_MIMETYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
    res.render('admin/erscheinungsbild-form', { ...currentState(), errors: [] });
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
        });
      }

      const { primaryColor, secondaryColor, themeDefault } = req.body;
      const errors = [];
      if (!HEX_COLOR_PATTERN.test(primaryColor || '')) errors.push('Primärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #2f4858).');
      if (!HEX_COLOR_PATTERN.test(secondaryColor || '')) errors.push('Sekundärfarbe muss ein gültiger Hex-Farbwert sein (z.B. #4d7ea8).');
      if (!VALID_THEME_DEFAULTS.has(themeDefault)) errors.push('Ungültiger Standard-Farbmodus.');
      if (req.file && !ALLOWED_MIMETYPES[req.file.mimetype]) errors.push('Logo muss eine PNG- oder JPEG-Datei sein.');

      if (errors.length > 0) {
        return res.status(400).render('admin/erscheinungsbild-form', {
          primaryColor,
          secondaryColor,
          themeDefault,
          hasLogo: currentState().hasLogo,
          errors,
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

      res.redirect('/admin/erscheinungsbild');
    });
  });

  return router;
}
```

- [ ] **Step 8: Modify `src/app.js`**

```js
import { createErscheinungsbildRouter } from './routes/admin/erscheinungsbild.js';
// ...
app.use('/admin/erscheinungsbild', requireRole(config, 'portal-admin'), createErscheinungsbildRouter({ db, config }));
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/integration/admin/erscheinungsbild.test.js`
Expected: PASS (6 tests)

- [ ] **Step 10: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/config/env.js views/admin/_nav.ejs views/admin/erscheinungsbild-form.ejs src/routes/admin/erscheinungsbild.js src/app.js test/integration/admin/erscheinungsbild.test.js
git commit -m "feat: admin Erscheinungsbild (logo upload, colors, theme default)"
```

---

### Task 9: Personen-Übersicht (read-only)

**Files:**
- Modify: `views/admin/_nav.ejs` — add Personen link
- Modify: `src/db/personenRepo.js` — add `listAllPersons(db)`
- Create: `views/admin/personen-liste.ejs`
- Create: `src/routes/admin/personen.js`
- Modify: `src/app.js` — mount `/admin/personen`
- Test: `test/integration/admin/personen.test.js`

**Interfaces:**
- Consumes: `requireRole` (Phase A).
- Produces: `listAllPersons(db)` → `array` (raw `personen` rows, all statuses, sorted active-first then by name). `createPersonenRouter({ db })` → Router with `GET /`.

- [ ] **Step 1: Write the failing test**

```js
// test/integration/admin/personen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createPersonenRouter } from '../../../src/routes/admin/personen.js';

function buildTestApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
  app.use(loadCurrentPerson(db));
  app.use('/admin/personen', requireRole(config, 'portal-admin'), createPersonenRouter({ db }));
  return app;
}

test('GET /admin/personen without a portal-admin session returns 401', async () => {
  const db = openDatabase(':memory:');
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/personen returns 403 for a logged-in non-admin (buchhaltung only)', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/personen lists all persons including inactive ones, and flags unresolved persons', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '1', vorname: 'Aktiv', nachname: 'Person', email: 'a@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Inaktiv', nachname: 'Person', email: 'i@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = ?').run('2');
  upsertPerson(db, { id: '3', vorname: 'Unresolved', nachname: 'Person', email: 'u@example.org', gruppen: ['10'], loggedInNow: false });
  db.prepare('UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = ?').run('3');

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/personen').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /Aktiv Person/);
  assert.match(res.text, /Inaktiv Person/);
  assert.match(res.text, /Unresolved Person/);
  assert.match(res.text, /nicht auflösbar/);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/personen.test.js`
Expected: FAIL — `src/routes/admin/personen.js` and view don't exist yet.

- [ ] **Step 3: Modify `views/admin/_nav.ejs`**

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
  <a href="/admin/erscheinungsbild">Erscheinungsbild</a>
  <a href="/admin/personen">Personen</a>
</nav>
```

- [ ] **Step 4: Modify `src/db/personenRepo.js`** — append this export

```js
export function listAllPersons(db) {
  return db.prepare('SELECT * FROM personen ORDER BY aktiv DESC, nachname, vorname').all();
}
```

- [ ] **Step 5: Create `views/admin/personen-liste.ejs`**

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Personen — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Personen</h1>
  <table>
    <thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Hinweis</th></tr></thead>
    <tbody>
      <% personen.forEach((p) => { %>
        <tr>
          <td><%= p.vorname %> <%= p.nachname %></td>
          <td><%= p.email %></td>
          <td><%= p.aktiv ? 'Aktiv' : 'Inaktiv' %></td>
          <td><% if (p.ct_person_unresolved) { %>⚠️ Person in ChurchTools nicht auflösbar (nicht auflösbar)<% } %></td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 6: Create `src/routes/admin/personen.js`**

```js
import { Router } from 'express';
import { listAllPersons } from '../../db/personenRepo.js';

export function createPersonenRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.render('admin/personen-liste', { personen: listAllPersons(db) });
  });

  return router;
}
```

- [ ] **Step 7: Modify `src/app.js`**

```js
import { createPersonenRouter } from './routes/admin/personen.js';
// ...
app.use('/admin/personen', requireRole(config, 'portal-admin'), createPersonenRouter({ db }));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test test/integration/admin/personen.test.js`
Expected: PASS (3 tests)

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add views/admin/_nav.ejs src/db/personenRepo.js views/admin/personen-liste.ejs src/routes/admin/personen.js src/app.js test/integration/admin/personen.test.js
git commit -m "feat: read-only admin Personen-Übersicht with ct_person_unresolved warning"
```
