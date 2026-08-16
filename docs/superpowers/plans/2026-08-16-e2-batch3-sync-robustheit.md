# Sub-Phase E2, Batch 3 – ChurchTools-Sync-Robustheit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mass-deactivation guard to the ChurchTools person sync, surface sync health and stalled jobs to admins with a force-release remedy, and give a Stellvertreter who *also* has a conflict of interest a real second-tier escalation path to the Portal-Admin group instead of a dead end.

**Architecture:** A new admin router `src/routes/admin/sync.js` (mounted at `/admin/sync`) becomes the one home for SYNC-1's threshold config, SYNC-2's sync-run history, and SYNC-3's stalled-job list + force-release action. SYNC-8 is separate: two new nullable job columns (`freigabe1_eskaliert_an_admin`, `freigabe2_eskaliert_an_admin`) let `kontierung.js`/`freigabe2.js` route a doubly-conflicted job to any Portal-Admin instead of blocking, and a new `requireAnyRole` middleware lets a Portal-Admin who isn't also in Buchhaltung actually reach those routes.

**Tech Stack:** Same as every prior phase — Node.js/Express, `node:sqlite`, EJS views, `node:test` + `supertest`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-e2-batch3-sync-robustheit-design.md`

## Global Constraints

- Only `status = 'abgeholt'`-style irreversible actions stay out of this batch's reach — nothing here touches PDF deletion (that's Batch 2, already shipped). This batch only touches `personen`, `jobs` (two new columns), `admin_config`, `sync_log`, `mail_log`.
- SYNC-1's abort is all-or-nothing: on trip, zero upserts and zero deactivations are persisted for that run — the guard check happens strictly before the `BEGIN`/`COMMIT` transaction in `runPersonenSync`.
- The percent threshold (`sync_max_deaktivierung_prozent`, default `'50'`) only applies once the active population is at least as large as the absolute-count threshold (`sync_max_deaktivierung_anzahl`, default `'10'`) — below that population size, only the absolute threshold governs. This is a necessary refinement discovered while implementing the approved "percent OR absolute" design: a pure percentage guard would make a single person's completely normal departure trip a 50% threshold in any org with only 1-4 active people, which is exactly the small-congregation scale this app is built for, and would also break the existing `runPersonenSync` unit tests (which don't seed `admin_config` and run against a 1-person active population). Both existing tests and the new guard behave correctly together only with this population floor in place.
- SYNC-8's admin-escalation emails go to `resolveEmpfaenger(db, config, 'gruppe:admin')` directly — not through a new configurable `admin_config` key — matching how the existing Tier-1 escalation emails (to the specific Stellvertreter) are already un-configurable. `mail_log.typ` stays `'zuweisung'` for these (same category as the existing Tier-1 hand-off emails); only SYNC-2's sync-run-failure emails get the new `'sync-fehler'` typ.
- No schema migration system exists in this repo — `schema.sql` is edited directly, same convention as every prior batch (the app has never been deployed).
- All user-facing/log text in German, matching every other file's existing copy style.

---

### Task 1: Datenmodell — Schema-Spalten + admin_config-Defaults

**Files:**
- Modify: `src/db/schema.sql` (two new `jobs` columns, `mail_log.typ` CHECK gains `'sync-fehler'`)
- Modify: `src/db/adminConfigRepo.js` (three new `DEFAULTS` entries)
- Test: `test/unit/adminConfigRepo.test.js` (new test)

**Interfaces:**
- Consumes: nothing new.
- Produces (for later tasks): `jobs.freigabe1_eskaliert_an_admin` / `jobs.freigabe2_eskaliert_an_admin` columns (both `INTEGER NOT NULL DEFAULT 0`); `admin_config` keys `sync_max_deaktivierung_prozent` (`'50'`), `sync_max_deaktivierung_anzahl` (`'10'`), `sync_fehler_empfaenger` (`'gruppe:admin'`); `mail_log.typ` now accepts `'sync-fehler'`.

- [ ] **Step 1: Add the two job columns and the mail_log CHECK value**

In `src/db/schema.sql`, in the `jobs` table, add after `archiviert_am TEXT`:

```sql
  reminder_gesendet_at TEXT,
  eskalation_gesendet_at TEXT,
  archiviert_am TEXT,
  freigabe1_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0,
  freigabe2_eskaliert_an_admin INTEGER NOT NULL DEFAULT 0
);
```

In the `mail_log` table, change the `typ` CHECK constraint:

```sql
  typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler')),
```

- [ ] **Step 2: Write the failing test**

Add to `test/unit/adminConfigRepo.test.js`:

```javascript
test('seedDefaults sets the SYNC-1/SYNC-2 sync-robustness defaults', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '50');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_anzahl'), '10');
  assert.equal(getConfigValue(db, 'sync_fehler_empfaenger'), 'gruppe:admin');
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: FAIL (`null !== '50'`, etc.)

- [ ] **Step 4: Implement**

In `src/db/adminConfigRepo.js`, add to `DEFAULTS`:

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
  sync_max_deaktivierung_prozent: '50',
  sync_max_deaktivierung_anzahl: '10',
  sync_fehler_empfaenger: 'gruppe:admin',
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/unit/adminConfigRepo.test.js`
Expected: PASS

Also run the full unit suite once here to confirm the schema edit itself doesn't break anything: `node --test test/unit/`
Expected: PASS (the two new job columns are additive with defaults, `mail_log`'s CHECK constraint change is additive too — no existing row/insert becomes invalid).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/adminConfigRepo.js test/unit/adminConfigRepo.test.js
git commit -m "feat: add SYNC-8 job columns, sync-robustness admin_config defaults, sync-fehler mail typ"
```

---

### Task 2: `notify.js` — `'gruppe:admin'` Empfänger-Token

**Files:**
- Modify: `src/services/notify.js`
- Test: `test/unit/notify.test.js` (check whether this file exists first — if not, check `test/integration/` for existing `resolveEmpfaenger` coverage and match whichever location/pattern the codebase already uses for this function before creating a new file)

**Interfaces:**
- Consumes: `config.churchtools.groupIdAdmin` (already present in every `config.churchtools` object in this codebase, same shape as the existing `groupIdBuchhaltung`).
- Produces (for Tasks 4, 7, 8): `resolveEmpfaenger(db, config, konfigWert)` now resolves the literal string `'gruppe:admin'` the same way it already resolves `'gruppe:buchhaltung'`, via `listActivePersonsInGroup(db, config.churchtools.groupIdAdmin)`.

- [ ] **Step 1: Find the existing test file for `resolveEmpfaenger`**

Run: `grep -rl "resolveEmpfaenger" /config/workspace/freigabeportal/test/`

This function is currently only exercised indirectly through `cron.test.js`'s pool-erinnerungen tests (there is no dedicated `notify.test.js` in this codebase as of this batch). Create `test/unit/notify.test.js` as a new file for this task — it's a natural home for testing `resolveEmpfaenger` directly rather than only through the cron route.

- [ ] **Step 2: Write the failing test**

Create `test/unit/notify.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { resolveEmpfaenger } from '../../src/services/notify.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

test('resolveEmpfaenger resolves "gruppe:admin" to the email addresses of active Portal-Admin group members', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Eins', email: 'admin1@example.org', gruppen: ['20'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Nur', nachname: 'Buchhaltung', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const empfaenger = resolveEmpfaenger(db, CONFIG, 'gruppe:admin');
  assert.deepEqual(empfaenger, ['admin1@example.org']);
  db.close();
});

test('resolveEmpfaenger still resolves "gruppe:buchhaltung" and plain email lines as before', () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });

  const empfaenger = resolveEmpfaenger(db, CONFIG, 'gruppe:buchhaltung\nextra@example.org');
  assert.deepEqual(new Set(empfaenger), new Set(['buch@example.org', 'extra@example.org']));
  db.close();
});

test('resolveEmpfaenger returns an empty array for an empty config value', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(resolveEmpfaenger(db, CONFIG, ''), []);
  assert.deepEqual(resolveEmpfaenger(db, CONFIG, null), []);
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/unit/notify.test.js`
Expected: FAIL on the first test (`'gruppe:admin'` currently falls through to the `else` branch and is treated as a literal email address, so `empfaenger` would be `['gruppe:admin']`, not `['admin1@example.org']`).

- [ ] **Step 4: Implement**

In `src/services/notify.js`, replace the whole file's token-handling section:

```javascript
import { logMailAttempt } from '../db/mailLogRepo.js';
import { listActivePersonsInGroup } from '../db/personenRepo.js';

const GRUPPE_BUCHHALTUNG_TOKEN = 'gruppe:buchhaltung';
const GRUPPE_ADMIN_TOKEN = 'gruppe:admin';

export async function sendNotification(db, mailer, { to, subject, text, typ, jobId }) {
  try {
    await mailer.sendMail({ to, subject, text });
    logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'versendet' });
  } catch (err) {
    try {
      logMailAttempt(db, { typ, jobId, empfaenger: to, betreff: subject, text, status: 'fehlgeschlagen', fehlerDetails: err.message });
    } catch (logErr) {
      console.error('sendNotification: logMailAttempt failed while recording a failed send', logErr);
    }
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
    } else if (zeile === GRUPPE_ADMIN_TOKEN) {
      for (const person of listActivePersonsInGroup(db, config.churchtools.groupIdAdmin)) {
        empfaenger.add(person.email);
      }
    } else {
      empfaenger.add(zeile);
    }
  }
  return [...empfaenger];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/unit/notify.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/notify.js test/unit/notify.test.js
git commit -m "feat: add gruppe:admin recipient token to resolveEmpfaenger"
```

---

### Task 3: `sync.js` — SYNC-1 Massen-Deaktivierungs-Schutz

**Files:**
- Modify: `src/services/sync.js`
- Test: `test/integration/sync.test.js`

**Interfaces:**
- Consumes: `getConfigValue` from `../db/adminConfigRepo.js` (new import); `admin_config` keys `sync_max_deaktivierung_prozent`/`sync_max_deaktivierung_anzahl` from Task 1 (read with an inline `|| 'fallback'`, so this works correctly even against a database that never called `seedDefaults` — matching the existing `visum_seite_position` fallback pattern in `n8n/jobs.js`).
- Produces (for Task 4): `runPersonenSync(db, config, accessToken)` now returns `{ upserted, deactivated, unresolved, abgebrochen: false }` on a normal run, or `{ upserted: 0, deactivated: 0, unresolved, abgebrochen: true, meldung }` when the guard trips (nothing persisted in this case except the `sync_log` row itself). `sync_log.status` can now be `'abgebrochen'` in addition to the existing `'laufend'`/`'erfolg'`/`'fehler'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/sync.test.js`, after the existing three tests:

```javascript
test('runPersonenSync aborts with nothing persisted when deactivations exceed the percent threshold (population large enough for percent to apply)', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  // Only person 1 is still in ChurchTools; persons 2-20 (19 of the 20 pre-existing active
  // people) would be deactivated — 95%, well over the 50% default threshold, and the active
  // population (20) is well above the default absolute floor (10), so the percent check applies.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/1', method: 'GET' }).reply(200, { data: { id: 1, firstName: 'Bleibt', lastName: 'Da', email: 'bleibt@example.org' } });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  for (let i = 1; i <= 20; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  assert.equal(result.deactivated, 0);
  assert.equal(result.upserted, 0);
  assert.match(result.meldung, /Schwelle/);
  // Nothing was persisted: person 1's profile was never upserted (still shows the old, pre-sync name)...
  assert.equal(getPersonById(db, '1').vorname, 'Person1');
  // ...and nobody was deactivated.
  for (let i = 1; i <= 20; i++) {
    assert.equal(getPersonById(db, String(i)).aktiv, true, `person ${i} should still be active`);
  }
  const logRow = db.prepare("SELECT * FROM sync_log WHERE status = 'abgebrochen'").get();
  assert.ok(logRow);
  assert.match(logRow.fehler_details, /19 von 20/);
  db.close();
});

test('runPersonenSync aborts on the absolute-count threshold even when the percent is under the percent threshold', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  // 100 active people, only 85 still returned by ChurchTools -> 15 deactivated = 15%, well
  // under the 50% default percent threshold, but 15 > the default absolute threshold of 10.
  const stillActive = Array.from({ length: 85 }, (_, i) => ({ personId: i + 1 }));
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: stillActive });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  for (let i = 1; i <= 85; i++) {
    client.intercept({ path: `/api/persons/${i}`, method: 'GET' }).reply(200, { data: { id: i, firstName: `Person${i}`, lastName: 'Aktiv', email: `p${i}@example.org` } });
  }

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  for (let i = 1; i <= 100; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  assert.equal(result.deactivated, 0);
  for (let i = 86; i <= 100; i++) {
    assert.equal(getPersonById(db, String(i)).aktiv, true, `person ${i} should still be active — the run aborted before any deactivation`);
  }
  db.close();
});

test('runPersonenSync does NOT abort a small-population run even at 100% deactivation (percent threshold only applies once active count reaches the absolute floor)', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 7 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/persons/7', method: 'GET' }).reply(200, { data: { id: 7, firstName: 'Max', lastName: 'Muster', email: 'max@example.org' } });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  // Exactly one pre-existing active person, who will be deactivated this run (100% of the
  // population) — with only the default absolute floor of 10, this must NOT trip the guard.
  upsertPerson(db, { id: '99', vorname: 'Alt', nachname: 'Verlassen', email: 'alt@example.org', gruppen: ['10'], loggedInNow: false });

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, false);
  assert.equal(result.deactivated, 1);
  assert.equal(getPersonById(db, '99').aktiv, false);
  db.close();
});

test('runPersonenSync respects admin_config-configured thresholds', async () => {
  const client = setupMockChurchTools(CT_CONFIG.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  seedDefaults(db);
  // Lower the absolute threshold to 1 so a single deactivation now trips the guard.
  setConfigValue(db, 'sync_max_deaktivierung_anzahl', '1');
  upsertPerson(db, { id: '1', vorname: 'Wird', nachname: 'Deaktiviert', email: 'weg@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Wird', nachname: 'Auch', email: 'auch@example.org', gruppen: ['10'], loggedInNow: false });
  // Population is 2, below the default absolute floor used to gate the percent check, so this
  // exercises the (now-lowered) absolute threshold specifically.

  const result = await runPersonenSync(db, CT_CONFIG, 'service-token');

  assert.equal(result.abgebrochen, true);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/sync.test.js`
Expected: FAIL — `result.abgebrochen` is `undefined` in every new test (the guard doesn't exist yet), so the deactivations actually happen and the assertions expecting them NOT to happen fail.

- [ ] **Step 3: Implement the guard**

In `src/services/sync.js`, add the import and insert the guard between the existing `toDeactivate` computation and the write-phase variables:

```javascript
import { fetchGroupMemberIds, fetchPersonById } from './churchtools.js';
import { upsertPerson, getAllActivePersonIds, deactivatePerson, markUnresolved, personExists } from '../db/personenRepo.js';
import { startSyncLog, finishSyncLog } from '../db/syncLogRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';

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

    const resolvedProfiles = [];
    let unresolved = 0;
    for (const [personId, gruppen] of personIdToGroups) {
      try {
        const profile = await fetchPersonById(config, accessToken, personId);
        resolvedProfiles.push({ personId, gruppen, profile });
      } catch {
        if (personExists(db, personId)) {
          markUnresolved(db, personId);
        }
        unresolved += 1;
      }
    }

    const relevantIds = new Set(personIdToGroups.keys());
    const toDeactivate = getAllActivePersonIds(db).filter((id) => !relevantIds.has(id));

    // SYNC-1: refuse to commit a sync run that would deactivate an abnormally large share of
    // the active roster in one shot (a ChurchTools-side outage or misconfiguration returning
    // an empty/near-empty group membership list is exactly this shape). The percent threshold
    // only applies once the active population is at least as large as the absolute-count
    // threshold — below that, a single person's completely normal departure would otherwise be
    // 100% of a tiny population and trip a 50% guard on every ordinary sync in a small
    // congregation, which is the scale this app is built for.
    const aktiveVorher = getAllActivePersonIds(db).length;
    const maxProzent = Number(getConfigValue(db, 'sync_max_deaktivierung_prozent') || '50');
    const maxAnzahl = Number(getConfigValue(db, 'sync_max_deaktivierung_anzahl') || '10');
    const prozentDeaktiviert = aktiveVorher > 0 ? (toDeactivate.length / aktiveVorher) * 100 : 0;
    const prozentSchwelleAktiv = aktiveVorher >= maxAnzahl;
    const abbrechen =
      toDeactivate.length > 0 && ((prozentSchwelleAktiv && prozentDeaktiviert > maxProzent) || toDeactivate.length > maxAnzahl);

    if (abbrechen) {
      const meldung = `Sync abgebrochen: ${toDeactivate.length} von ${aktiveVorher} aktiven Personen (${Math.round(prozentDeaktiviert)}%) würden deaktiviert — Schwelle ${maxProzent}%/${maxAnzahl}`;
      finishSyncLog(db, syncLogId, { status: 'abgebrochen', fehlerDetails: meldung });
      return { upserted: 0, deactivated: 0, unresolved, abgebrochen: true, meldung };
    }

    let upserted = 0;
    let deactivated = 0;
    db.exec('BEGIN');
    try {
      for (const { personId, gruppen, profile } of resolvedProfiles) {
        upsertPerson(db, {
          id: String(personId),
          vorname: profile.firstName,
          nachname: profile.lastName,
          email: profile.email,
          gruppen,
          loggedInNow: false,
        });
        upserted += 1;
      }
      for (const activeId of toDeactivate) {
        deactivatePerson(db, activeId);
        deactivated += 1;
      }
      db.exec('COMMIT');
    } catch (writeErr) {
      db.exec('ROLLBACK');
      throw writeErr;
    }

    finishSyncLog(db, syncLogId, {
      status: 'erfolg',
      anzahlUpserted: upserted,
      anzahlDeaktiviert: deactivated,
      fehlerDetails: unresolved > 0 ? `${unresolved} Person(en) nicht auflösbar` : null,
    });
    return { upserted, deactivated, unresolved, abgebrochen: false };
  } catch (err) {
    finishSyncLog(db, syncLogId, { status: 'fehler', fehlerDetails: err.message });
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/sync.test.js`
Expected: PASS, all 8 tests (3 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/sync.js test/integration/sync.test.js
git commit -m "feat: add mass-deactivation guard to runPersonenSync (SYNC-1)"
```

---

### Task 4: `cron.js` — Sync-Fehler-E-Mail bei Abbruch/Exception (SYNC-2)

**Files:**
- Modify: `src/routes/cron.js`
- Test: `test/integration/cron.test.js`

**Interfaces:**
- Consumes: `runPersonenSync`'s new `{ abgebrochen, meldung }` fields (Task 3); `resolveEmpfaenger`'s `'gruppe:admin'` support (Task 2); `getConfigValue(db, 'sync_fehler_empfaenger')` (Task 1's default).
- Produces: nothing new for later tasks — `POST /internal/cron/sync-personen`'s response shape changes only in the new abort case (`{ status: 'abgebrochen', meldung }`, HTTP 200 — a deliberate, working-as-designed safety trip is not a server error), the existing `'erfolg'`/`'fehler'` shapes are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/cron.test.js`, after the existing `/sync-personen` tests:

```javascript
test('POST /internal/cron/sync-personen returns abgebrochen and emails gruppe:admin when the mass-deactivation guard trips, without persisting anything', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults, setConfigValue } = await import('../../src/db/adminConfigRepo.js');
  const { upsertPerson, getPersonById } = await import('../../src/db/personenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);
  setConfigValue(db, 'sync_max_deaktivierung_anzahl', '0');
  upsertPerson(db, { id: '1', vorname: 'Wird', nachname: 'Deaktiviert', email: 'weg@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'abgebrochen');
  assert.match(res.body.meldung, /Schwelle/);
  assert.equal(getPersonById(db, '1').aktiv, true, 'nothing should have been persisted');
  const syncFehlerMails = listMailLog(db).filter((m) => m.typ === 'sync-fehler');
  assert.equal(syncFehlerMails.length, 1);
  assert.equal(syncFehlerMails[0].empfaenger, 'admin@example.org');
  db.close();
});

test('POST /internal/cron/sync-personen emails gruppe:admin when the sync throws', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(500, {});
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 500);
  assert.equal(res.body.status, 'fehler');
  const syncFehlerMails = listMailLog(db).filter((m) => m.typ === 'sync-fehler');
  assert.equal(syncFehlerMails.length, 1);
  db.close();
});

test('POST /internal/cron/sync-personen sends no sync-fehler mail on a normal successful run', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [] });

  const db = openDatabase(':memory:');
  const { seedDefaults } = await import('../../src/db/adminConfigRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');
  seedDefaults(db);

  const app = createApp({ db, config });
  const res = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'erfolg');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'sync-fehler').length, 0);
  db.close();
});
```

Note: this test file's `testConfig()` needs a `publicBaseUrl` for the email text to interpolate cleanly and a `smtp` block for the app's mailer to initialize — check the top of `test/integration/cron.test.js` for its current `testConfig()` shape (it's used by the existing `pool-erinnerungen` tests, which already send mail) and reuse it as-is; only add fields if they're genuinely missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/cron.test.js`
Expected: FAIL — no `sync-fehler` mail is sent yet in either the abort or throw case, and `res.body.status` for the abort case is currently whatever the (unmodified) route returns for `result.abgebrochen` being ignored — the assertions on `syncFehlerMails.length` fail.

- [ ] **Step 3: Implement**

In `src/routes/cron.js`, replace the `/sync-personen` handler:

```javascript
  router.post('/sync-personen', async (req, res) => {
    if (hasRecentRunningSync(db)) {
      return res.status(409).json({ error: 'Ein Sync-Lauf ist bereits aktiv' });
    }
    try {
      const result = await runPersonenSync(db, config.churchtools, config.churchtools.syncServiceToken);
      if (result.abgebrochen) {
        await benachrichtigeSyncFehler(result.meldung);
        return res.json({ status: 'abgebrochen', meldung: result.meldung });
      }
      res.json({ status: 'erfolg', ...result });
    } catch (err) {
      await benachrichtigeSyncFehler(err.message);
      res.status(500).json({ status: 'fehler', error: err.message });
    }
  });

  async function benachrichtigeSyncFehler(meldung) {
    const empfaenger = resolveEmpfaenger(db, config, getConfigValue(db, 'sync_fehler_empfaenger'));
    for (const email of empfaenger) {
      await sendNotification(db, mailer, {
        to: email,
        subject: 'Freigabeportal: ChurchTools-Sync fehlgeschlagen',
        text: `Der ChurchTools-Personen-Sync konnte nicht erfolgreich abgeschlossen werden: ${meldung}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/admin/sync`,
        typ: 'sync-fehler',
        jobId: null,
      });
    }
  }
```

Place the `benachrichtigeSyncFehler` function definition inside `createCronRouter`, alongside the routes (it closes over `db`, `config`, `mailer`, all already in scope). No new imports are needed — `getConfigValue`, `sendNotification`, and `resolveEmpfaenger` are all already imported at the top of `cron.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/cron.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/routes/cron.js test/integration/cron.test.js
git commit -m "feat: email gruppe:admin when the ChurchTools sync aborts or throws (SYNC-2)"
```

---

### Task 5: `jobsRepo.js` — SYNC-8 Admin-Eskalations-Funktionen

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `jobs.freigabe1_eskaliert_an_admin`/`jobs.freigabe2_eskaliert_an_admin` columns (Task 1).
- Produces (for Tasks 7, 8, 9): `eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon, grund })` and `eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon, grund })` — each sets the stage's `*_eskaliert_an_admin` flag to `1` and updates `*_eskaliert_von`/`*_eskalationsgrund`, leaving `zugewiesen_an`/`konto_id` untouched (matches how `eskalierenFreigabe1`/`eskalierenFreigabe2` already behave — no `WHERE`-status guard needed, per this file's existing documented convention: every calling route is a fully synchronous handler with no `await` between its authorization check and the write).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`. Extend the import line to add the two new functions:

```javascript
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson, listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet, listAbgeholtJobs, archivierenJob, eskalierenFreigabe1AnAdmin, eskalierenFreigabe2AnAdmin } from '../../src/db/jobsRepo.js';
```

Append at the end of the file:

```javascript
test('eskalierenFreigabe1AnAdmin sets the admin-escalation flag and records who/why, leaving zugewiesen_an untouched', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon: '2', grund: 'Auch ein Interessenskonflikt' });

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.freigabe1_eskaliert_von, '2');
  assert.equal(job.freigabe1_eskalationsgrund, 'Auch ein Interessenskonflikt');
  assert.equal(job.zugewiesen_an, '2');
  db.close();
});

test('eskalierenFreigabe2AnAdmin sets the admin-escalation flag and records who/why', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2' WHERE id = ?").run(jobId);

  eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon: '4', grund: 'Auch ein Interessenskonflikt' });

  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.freigabe2_eskaliert_von, '4');
  assert.equal(job.freigabe2_eskalationsgrund, 'Auch ein Interessenskonflikt');
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `eskalierenFreigabe1AnAdmin is not a function` / `eskalierenFreigabe2AnAdmin is not a function`

- [ ] **Step 3: Implement**

In `src/db/jobsRepo.js`, add after `eskalierenFreigabe2`:

```javascript
// SYNC-8: a second-tier escalation, triggered when the person already escalated to (Tier 1)
// also has their own conflict of interest — routes the job to any active Portal-Admin instead
// of blocking. zugewiesen_an is deliberately left untouched: once this flag is set, job
// authorization stops checking zugewiesen_an for this stage entirely (see kontierung.js/
// freigabe2.js), so the field just stays as a historical record of the last named person in
// the chain rather than needing a sentinel value.
export function eskalierenFreigabe1AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe1_eskaliert_an_admin = 1, freigabe1_eskaliert_von = ?, freigabe1_eskalationsgrund = ? WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}

export function eskalierenFreigabe2AnAdmin(db, jobId, { eskaliertVon, grund }) {
  db.prepare(
    'UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ? WHERE id = ?'
  ).run(eskaliertVon, grund, jobId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add eskalierenFreigabe1AnAdmin/eskalierenFreigabe2AnAdmin (SYNC-8)"
```

---

### Task 6: `requireAnyRole` — Route-Gate-Fix für Admin-Zugriff

**Files:**
- Modify: `src/middleware/roles.js`
- Modify: `src/app.js:106-107` (the `/kontierung` and `/freigabe2` mounts)
- Test: `test/unit/roles.test.js` (check if this file exists — if not, check `test/integration/app.test.js`/wherever `requireRole` is currently tested and add alongside it)

**Interfaces:**
- Consumes: nothing new.
- Produces (for Tasks 7, 8): `requireAnyRole(config, roles)` → Express middleware, same shape as the existing `requireRole(config, role)` (401 if not logged in / inactive, 403 if logged in but in none of the given roles' groups, else `next()`) but accepts an array of role names and passes if the person is in *any* of them.

- [ ] **Step 1: Find the existing test file for `requireRole`**

Run: `grep -rl "requireRole" /config/workspace/freigabeportal/test/ | grep -v node_modules`

Add the new tests to whichever unit test file already covers `roles.js` (create `test/unit/roles.test.js` if none exists — this middleware has likely only been tested indirectly through integration tests of the routes it gates so far).

- [ ] **Step 2: Write the failing tests**

Create or extend the test file with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { loadCurrentPerson, requireAnyRole } from '../../src/middleware/roles.js';

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function runMiddleware(db, personId, roles) {
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
      requireAnyRole(CONFIG, roles)(req, res, () => resolve({ statusCode: 200, next: true }));
    });
  });
}

test('requireAnyRole allows a person in the first listed role', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Buch', nachname: 'Halter', email: 'buch@example.org', gruppen: ['10'], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'portal-admin']);
  assert.equal(result.next, true);
  db.close();
});

test('requireAnyRole allows a person in the second listed role', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'portal-admin']);
  assert.equal(result.next, true);
  db.close();
});

test('requireAnyRole rejects a person in neither role with 403', async () => {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'Niemand', nachname: 'Besonderes', email: 'x@example.org', gruppen: [], loggedInNow: false });
  const result = await runMiddleware(db, '1', ['buchhaltung', 'portal-admin']);
  assert.equal(result.statusCode, 403);
  db.close();
});

test('requireAnyRole rejects an unauthenticated request with 401', async () => {
  const db = openDatabase(':memory:');
  const result = await runMiddleware(db, undefined, ['buchhaltung', 'portal-admin']);
  assert.equal(result.statusCode, 401);
  db.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/unit/roles.test.js`
Expected: FAIL — `requireAnyRole is not a function`

- [ ] **Step 4: Implement**

In `src/middleware/roles.js`, add after `requireRole`:

```javascript
export function requireAnyRole(config, roles) {
  return (req, res, next) => {
    const person = req.currentPerson;
    if (!person || !person.aktiv) {
      return res.status(401).render('error', { message: 'Bitte melde dich an, um fortzufahren.' });
    }
    const erlaubt = roles.some((role) => {
      const groupId = config.churchtools[GROUP_ID_KEY_BY_ROLE[role]];
      return person.gruppen.includes(String(groupId));
    });
    if (!erlaubt) {
      return res.status(403).render('error', { message: 'Du hast keine Berechtigung für diesen Bereich.' });
    }
    next();
  };
}
```

In `src/app.js`, update the import and the two mounts:

```javascript
import { loadCurrentPerson, requireRole, requireAnyRole } from './middleware/roles.js';
```

```javascript
  app.use('/kontierung', sessionLimiter, requireAnyRole(config, ['buchhaltung', 'portal-admin']), createKontierungRouter({ db, config, mailer }));
  app.use('/freigabe2', sessionLimiter, requireAnyRole(config, ['buchhaltung', 'portal-admin']), createFreigabe2Router({ db, config, mailer }));
```

(`/abgelehnt` stays on `requireRole(config, 'buchhaltung')` — SYNC-8 only introduces admin-escalation for the Freigabe-1/Freigabe-2 stages, not job rework.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/roles.test.js`
Expected: PASS

Then run the full suite once to confirm the route-gate widening didn't change any existing test's expectations: `npm test`
Expected: PASS (a Buchhaltung-only person's access to `/kontierung`/`/freigabe2` is unaffected — `requireAnyRole` still passes them; only a Portal-Admin who was previously blocked can now get past this gate, and no existing test logs in as a Portal-Admin-only person against these two routes).

- [ ] **Step 6: Commit**

```bash
git add src/middleware/roles.js src/app.js test/unit/roles.test.js
git commit -m "feat: add requireAnyRole, let Portal-Admin reach /kontierung and /freigabe2"
```

---

### Task 7: `kontierung.js` — SYNC-8-Integration (Freigabe 1)

**Files:**
- Modify: `src/routes/kontierung.js`
- Test: `test/integration/kontierung.test.js` (check the exact filename via `ls test/integration/ | grep -i kontierung` — add to whichever file already covers this route)

**Interfaces:**
- Consumes: `eskalierenFreigabe1AnAdmin` (Task 5), `resolveEmpfaenger`/`sendNotification` with `'gruppe:admin'` (Task 2), `requireAnyRole` route gate (Task 6, already wired in `app.js`).
- Produces: nothing new for later tasks — this task's job authorization change (`job.freigabe1_eskaliert_an_admin` branch) is consumed only by real HTTP requests, not by other code.

- [ ] **Step 1: Write the failing tests**

Add to the kontierung test file (match its existing `testConfig`/login-helper conventions — read the top of the file first):

```javascript
test('a Stellvertreter1 who is escalated to and ALSO has a conflict escalates to Portal-Admin instead of being blocked', async () => {
  // Setup: freigeber1 (person 1) claims a job, picks a konto, declares a conflict -> escalates
  // to stellvertreter1 (person 2). Then person 2 logs in, sees the same job, ALSO declares a
  // conflict -> should now escalate to admin instead of hitting the old dead-end block.
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '2');

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const res = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin auch befangen.' });

  assert.equal(res.status, 302, 'the second escalation should succeed, not render the form with an error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  assert.equal(job.status, 'zugewiesen');

  const adminMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.empfaenger === 'admin@example.org');
  assert.equal(adminMails.length, 1);

  // The (now-excluded) Stellvertreter1 can no longer act on this job...
  const blockedAgent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const blockedRes = await blockedAgent.get(`/kontierung/${jobId}`);
  assert.equal(blockedRes.status, 403);

  // ...but an admin can.
  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const adminRes = await adminAgent.get(`/kontierung/${jobId}`);
  assert.equal(adminRes.status, 200);
  db.close();
});

test('a plain second escalation attempt with no conflict is still blocked with the original message', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  // No conflict this time, just an ordinary attempt to escalate again (e.g. a stray double
  // form submit) — still needs handling. This drives the branch that used to always error;
  // now it goes through the normal non-conflict completion path since hatKonflikt is false.
  const res = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(res.status, 302);
  db.close();
});

test('a person who picks a Konto where they are themselves the stellvertreter1 and declares a conflict escalates straight to admin', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  // Person 2 is stellvertreter1 for THIS konto, but claims the job directly (listKontenForPerson
  // includes konten where they're stellvertreter1 too).
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '2' WHERE id = ?").run(jobId);

  const app = createApp({ db, config });
  const agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const res = await agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Ich bin selbst die Stellvertretung.' });

  assert.equal(res.status, 302, 'this is a first-ever escalation for this job, but self-targeting -> should go straight to admin, not error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe1_eskaliert_an_admin, 1);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integration/kontierung.test.js` (or the correct filename found in Step 1's `ls`)
Expected: FAIL — the first two conditions still render the old 400 block message, so `res.status` is `400` instead of `302`.

- [ ] **Step 3: Implement**

In `src/routes/kontierung.js`, add the import and the `isPortalAdmin` helper, replace `loadAuthorizedJob`, and replace the escalation branching in the `POST /:id` handler:

```javascript
import { Router } from 'express';
import { getJobById, setKontierung, eskalierenFreigabe1, eskalierenFreigabe1AnAdmin, abschliessenFreigabe1, releaseJob, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { listKontenForPerson } from '../db/kontenRepo.js';
import { createFreigabe } from '../db/freigabenRepo.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { getPersonById } from '../db/personenRepo.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

export function createKontierungRouter({ db, config, mailer }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorizedJob(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'zugewiesen') {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    const authorized = job.freigabe1_eskaliert_an_admin
      ? isPortalAdmin(req.currentPerson)
      : job.zugewiesen_an === req.currentPerson.churchtools_person_id;
    if (!authorized) {
      res.status(403).render('error', { message: 'Dieser Job ist dir aktuell nicht zur Kontierung zugewiesen.' });
      return null;
    }
    return job;
  }
```

Update the `GET /:id` and `POST /:id` handlers — the `GET` handler is unchanged (it already calls `loadAuthorizedJob`, which now handles both cases automatically). In the `POST /:id` handler, replace the two `errors.push(...)` blocks and the escalation write/notification logic:

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

      if (errors.length > 0) {
        return res.status(400).render('kontierung', {
          job,
          konten,
          previewUrl: buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS),
          values: { kontoId, interessenskonflikt, begruendung },
          errors,
        });
      }

      // SYNC-8: a conflict-driven escalation has no distinct named person to hand off to in two
      // cases — this job was already escalated once (so the only person who could even reach
      // this line, per loadAuthorizedJob, is the previously-escalated Stellvertreter1, and they
      // ALSO have a conflict), or the chosen Konto's stellvertreter1 IS the current person
      // (escalating would target themselves). Both route to the Portal-Admin group instead of
      // blocking with the old "go back to pool / contact admin" dead end.
      const eskaliertAnAdmin = hatKonflikt && Boolean(job.freigabe1_eskaliert_von || konto.stellvertreter1_id === req.currentPerson.churchtools_person_id);

      db.exec('BEGIN');
      try {
        setKontierung(db, job.id, konto.id);
        if (eskaliertAnAdmin) {
          eskalierenFreigabe1AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
        } else if (hatKonflikt) {
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

      if (eskaliertAnAdmin) {
        const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
        for (const email of empfaenger) {
          await sendNotification(db, mailer, {
            to: email,
            subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 1 – an Portal-Admin eskaliert',
            text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
            typ: 'zuweisung',
            jobId: job.id,
          });
        }
      } else if (hatKonflikt) {
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
        const freigeber2 = getPersonById(db, getEffectiveFreigeber2Id(job, konto));
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

The `router.post('/:id/zurueck-in-pool', ...)` handler is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integration/kontierung.test.js` (or the correct filename)
Expected: PASS, all tests in the file including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/routes/kontierung.js test/integration/kontierung.test.js
git commit -m "feat: escalate a doubly-conflicted Freigabe-1 handoff to Portal-Admin (SYNC-8)"
```

---

### Task 8: `freigabe2.js` — SYNC-8-Integration (Freigabe 2)

**Files:**
- Modify: `src/routes/freigabe2.js`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Consumes: `eskalierenFreigabe2AnAdmin` (Task 5), `resolveEmpfaenger`/`sendNotification` with `'gruppe:admin'` (Task 2), `requireAnyRole` route gate (Task 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/freigabe2.test.js` (match its existing conventions — this file already has a four-eyes-principle regression test to pattern-match against):

```javascript
test('a Stellvertreter2 who is escalated to and ALSO has a conflict escalates to Portal-Admin instead of being blocked', async () => {
  const config = testConfig();
  const client = setupMockChurchTools(config.churchtools.baseUrl);
  const db = openDatabase(':memory:');
  const { upsertPerson } = await import('../../src/db/personenRepo.js');
  const { createKonto } = await import('../../src/db/kontenRepo.js');
  const { createJob, getJobById } = await import('../../src/db/jobsRepo.js');
  const { createFreigabe } = await import('../../src/db/freigabenRepo.js');
  const { listMailLog } = await import('../../src/db/mailLogRepo.js');

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: new Date().toISOString(), ip: '127.0.0.1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });

  const app = createApp({ db, config });
  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Ich bin befangen.' });
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_von, '3');

  const stellvertreter2Agent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  const res = await stellvertreter2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'ja', begruendung: 'Ich bin auch befangen.' });

  assert.equal(res.status, 302, 'the second escalation should succeed, not render the form with an error');
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.status, 'freigabe2');

  const adminMails = listMailLog(db).filter((m) => m.typ === 'zuweisung' && m.empfaenger === 'admin@example.org');
  assert.equal(adminMails.length, 1);

  const blockedAgent = await loginAs(app, client, { id: 4, vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'] });
  const blockedRes = await blockedAgent.get(`/freigabe2/${jobId}`);
  assert.equal(blockedRes.status, 403);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const adminRes = await adminAgent.get(`/freigabe2/${jobId}`);
  assert.equal(adminRes.status, 200);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/integration/freigabe2.test.js`
Expected: FAIL — the second escalation attempt still hits the old 400 block.

- [ ] **Step 3: Implement**

In `src/routes/freigabe2.js`, add the import and `isPortalAdmin` helper, update `loadAuthorized`, and replace the conflict-escalation branch in the `POST /:id` handler:

```javascript
import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getJobById, eskalierenFreigabe2, eskalierenFreigabe2AnAdmin, abschliessenFreigabe2, ablehnenJob, getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { stampAndFinalize } from '../services/pdfStamp.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../services/downloadUrl.js';
import { sendNotification, resolveEmpfaenger } from '../services/notify.js';

export function createFreigabe2Router({ db, config, mailer }) {
  const router = Router();

  function isPortalAdmin(person) {
    return Boolean(person && person.gruppen.includes(String(config.churchtools.groupIdAdmin)));
  }

  function loadAuthorized(req, res) {
    const job = getJobById(db, Number(req.params.id));
    if (!job || job.status !== 'freigabe2') {
      res.status(403).render('error', { message: 'Für diesen Job ist aktuell keine Freigabe 2 möglich.' });
      return null;
    }
    const konto = getKontoById(db, job.konto_id);
    const authorized =
      konto &&
      (job.freigabe2_eskaliert_an_admin
        ? isPortalAdmin(req.currentPerson)
        : getEffectiveFreigeber2Id(job, konto) === req.currentPerson.churchtools_person_id);
    if (!authorized) {
      res.status(403).render('error', { message: 'Du bist für die Freigabe 2 dieses Jobs nicht zuständig.' });
      return null;
    }
    // Vier-Augen-Prinzip: the Konto's role assignment is only checked at admin-edit time
    // (validateKontoRoles), which is a point-in-time check on the Konto row, not on this
    // specific job. If the Konto is edited while a job sits in freigabe2 — or the same person
    // holds both Buchhaltung and Portal-Admin — the person who already approved Freigabe 1
    // could otherwise end up as the resolved Freigabe-2 approver too. Re-check per job.
    const freigabe1 = listFreigabenByJob(db, job.id).findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1 && freigabe1.person_id === req.currentPerson.churchtools_person_id) {
      res.status(403).render('error', {
        message: 'Du hast diese Rechnung bereits in Freigabe 1 freigegeben und kannst sie nicht auch in Freigabe 2 freigeben (Vier-Augen-Prinzip).',
      });
      return null;
    }
    return { job, konto };
  }
```

In the `POST /:id` handler, replace the existing conflict block:

```javascript
      if (hatKonflikt && job.freigabe2_eskaliert_von) {
        return renderForm(req, res, 400, result, { interessenskonflikt, begruendung }, [
          'Diese Aufgabe wurde bereits eskaliert und kann nicht erneut eskaliert werden. Bitte wende dich an den Portal-Admin.',
        ]);
      }

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

with:

```javascript
      if (hatKonflikt) {
        // SYNC-8: job.freigabe2_eskaliert_von being already set here means this job was already
        // escalated once — and per loadAuthorized, the only person who could reach this line for
        // an already-escalated job is that Tier-1 escalated Stellvertreter2 themselves, now also
        // declaring their own conflict. Route to Portal-Admin instead of blocking.
        const eskaliertAnAdmin = Boolean(job.freigabe2_eskaliert_von);

        db.exec('BEGIN');
        try {
          if (eskaliertAnAdmin) {
            eskalierenFreigabe2AnAdmin(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          } else {
            eskalierenFreigabe2(db, job.id, { eskaliertVon: req.currentPerson.churchtools_person_id, grund: begruendung });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        if (eskaliertAnAdmin) {
          const empfaenger = resolveEmpfaenger(db, config, 'gruppe:admin');
          for (const email of empfaenger) {
            await sendNotification(db, mailer, {
              to: email,
              subject: 'Freigabeportal: Interessenskonflikt bei Freigabe 2 – an Portal-Admin eskaliert',
              text: `Eine Rechnung wurde an die Portal-Admin-Gruppe eskaliert, da auch die Stellvertretung einen Interessenskonflikt erklärt hat: ${job.dateiname}\n\nBitte im Freigabeportal anmelden: ${config.publicBaseUrl}/pool`,
              typ: 'zuweisung',
              jobId: job.id,
            });
          }
        } else {
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
        }
        return res.redirect('/pool');
      }
```

Everything else in the file (the `ablehnen` branch, the final stamping/completion branch) is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/integration/freigabe2.test.js`
Expected: PASS, all tests in the file including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/routes/freigabe2.js test/integration/freigabe2.test.js
git commit -m "feat: escalate a doubly-conflicted Freigabe-2 handoff to Portal-Admin (SYNC-8)"
```

---

### Task 9: `jobsRepo.js` — Stalled-Job-Erkennung + Force-Release (SYNC-3)

**Files:**
- Modify: `src/db/jobsRepo.js`
- Test: `test/unit/jobsRepo.test.js`

**Interfaces:**
- Consumes: `getKontoById` (already imported), `getEffectiveFreigeber2Id` (already in this file), `getPersonById` (new import from `./personenRepo.js`).
- Produces (for Task 11): `listStalledJobs(db)` → array of `{ job, akteurId, grund }` (`grund` is `'inaktiv'` or `'nicht_aufloesbar'`); `forceReleaseJob(db, jobId)` → resets a stalled `zugewiesen`/`abgelehnt` job to `unzugewiesen`, returns boolean; `forceEskalierenFreigabe2AnAdmin(db, jobId)` → sets a stalled `freigabe2` job's admin-escalation flag, returns boolean.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/jobsRepo.test.js`. Extend the import line to add the three new functions:

```javascript
import { findMatchingZuweisungsregel, createJob, getJobById, listPoolJobs, claimJob, listAbholbereitJobs, confirmAbholung, setThumbnailPfad, setKontierung, eskalierenFreigabe1, abschliessenFreigabe1, eskalierenFreigabe2, abschliessenFreigabe2, releaseJob, listZugewiesenJobsForPerson, listFreigabe2JobsForPerson, getEffectiveFreigeber2Id, ablehnenJob, wiederOeffnenJob, listAbgelehntJobsForPerson, listPoolJobsForReminder, markReminderGesendet, listPoolJobsForEskalation, markEskalationGesendet, listAbgeholtJobs, archivierenJob, eskalierenFreigabe1AnAdmin, eskalierenFreigabe2AnAdmin, listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin } from '../../src/db/jobsRepo.js';
```

Append at the end of the file:

```javascript
test('listStalledJobs finds a zugewiesen job whose actor was deactivated', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].job.id, jobId);
  assert.equal(stalled[0].akteurId, '1');
  assert.equal(stalled[0].grund, 'inaktiv');
  db.close();
});

test('listStalledJobs finds an abgelehnt job whose actor is not auflösbar', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET ct_person_unresolved = 1 WHERE churchtools_person_id = '1'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].grund, 'nicht_aufloesbar');
  db.close();
});

test('listStalledJobs finds a freigabe2 job whose effective freigeber2 is inactive', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();

  const stalled = listStalledJobs(db);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].akteurId, '3');
  db.close();
});

test('listStalledJobs excludes a freigabe2 job already escalated to admin', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, freigabe2_eskaliert_an_admin = 1 WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '4'").run();

  assert.equal(listStalledJobs(db).length, 0);
  db.close();
});

test('listStalledJobs excludes a healthy job with an active, resolvable actor', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  assert.equal(listStalledJobs(db).length, 0);
  db.close();
});

test('forceReleaseJob resets a stalled zugewiesen job to unzugewiesen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  const result = forceReleaseJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.zugewiesen_an, null);
  assert.equal(job.konto_id, null);
  db.close();
});

test('forceReleaseJob resets a stalled abgelehnt job to unzugewiesen', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', zugewiesen_an = '1', konto_id = ?, abgelehnt_von = '3', ablehnungsgrund = 'x' WHERE id = ?").run(kontoId, jobId);

  const result = forceReleaseJob(db, jobId);
  assert.equal(result, true);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'unzugewiesen');
  assert.equal(job.abgelehnt_von, null);
  db.close();
});

test('forceReleaseJob refuses a job that is not in a force-releasable status', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(forceReleaseJob(db, jobId), false);
  db.close();
});

test('forceEskalierenFreigabe2AnAdmin sets the admin flag on a stalled freigabe2 job', () => {
  const db = openDatabase(':memory:');
  const kontoId = seedKonto(db);
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);

  const result = forceEskalierenFreigabe2AnAdmin(db, jobId);
  assert.equal(result, true);
  assert.equal(getJobById(db, jobId).freigabe2_eskaliert_an_admin, 1);
  db.close();
});

test('forceEskalierenFreigabe2AnAdmin refuses a job not in freigabe2 or already escalated', () => {
  const db = openDatabase(':memory:');
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  assert.equal(forceEskalierenFreigabe2AnAdmin(db, jobId), false);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: FAIL — `listStalledJobs is not a function` / `forceReleaseJob is not a function` / `forceEskalierenFreigabe2AnAdmin is not a function`

- [ ] **Step 3: Implement**

In `src/db/jobsRepo.js`, add the new import at the top:

```javascript
import { getKontoById } from './kontenRepo.js';
import { getPersonById } from './personenRepo.js';
import { listZuweisungsregeln } from './zuweisungsregelnRepo.js';
```

Add after `eskalierenFreigabe2AnAdmin`:

```javascript
// SYNC-3: a job "stalls" when its current required actor can no longer act — deactivated or
// no longer resolvable in ChurchTools, both set by the person sync. Checked per status: for
// 'zugewiesen'/'abgelehnt', the actor is zugewiesen_an directly; for 'freigabe2', it's the
// effective freigeber2, unless the job already carries SYNC-8's admin-escalation flag — an
// admin-routed job is never "stalled" by this definition (a simultaneous outage of the entire
// Portal-Admin group is out of scope).
export function listStalledJobs(db) {
  const ergebnisse = [];

  for (const job of db.prepare("SELECT * FROM jobs WHERE status IN ('zugewiesen', 'abgelehnt')").all()) {
    const akteur = getPersonById(db, job.zugewiesen_an);
    if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) {
      ergebnisse.push({ job, akteurId: job.zugewiesen_an, grund: !akteur || !akteur.aktiv ? 'inaktiv' : 'nicht_aufloesbar' });
    }
  }

  for (const job of db.prepare("SELECT * FROM jobs WHERE status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0").all()) {
    const konto = getKontoById(db, job.konto_id);
    if (!konto) continue;
    const akteurId = getEffectiveFreigeber2Id(job, konto);
    const akteur = getPersonById(db, akteurId);
    if (!akteur || !akteur.aktiv || akteur.ct_person_unresolved) {
      ergebnisse.push({ job, akteurId, grund: !akteur || !akteur.aktiv ? 'inaktiv' : 'nicht_aufloesbar' });
    }
  }

  return ergebnisse;
}

// Resets a stalled 'zugewiesen'/'abgelehnt' job to 'unzugewiesen' so anyone can reclaim it —
// nothing irreversible has happened yet at these stages (no Freigabe-1/2 approval recorded),
// so a full reset is safe. Clears the same fields releaseJob/wiederOeffnenJob already clear.
export function forceReleaseJob(db, jobId) {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'unzugewiesen', zugewiesen_an = NULL, konto_id = NULL,
           freigabe1_eskaliert_von = NULL, freigabe1_eskalationsgrund = NULL, freigabe1_eskaliert_an_admin = 0,
           abgelehnt_von = NULL, ablehnungsgrund = NULL,
           reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status IN ('zugewiesen', 'abgelehnt')`
    )
    .run(jobId);
  return result.changes > 0;
}

// A stalled 'freigabe2' job does NOT get released to the pool — that would discard the
// already-completed, already-recorded Freigabe-1 approval and force kontierung + Freigabe 1 to
// be redone for no reason. Instead it gets the same admin-escalation flag SYNC-8 introduces,
// which is the correct next legitimate actor for a job already past Freigabe 1.
export function forceEskalierenFreigabe2AnAdmin(db, jobId) {
  const result = db
    .prepare("UPDATE jobs SET freigabe2_eskaliert_an_admin = 1 WHERE id = ? AND status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0")
    .run(jobId);
  return result.changes > 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/jobsRepo.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/jobsRepo.test.js
git commit -m "feat: add listStalledJobs, forceReleaseJob, forceEskalierenFreigabe2AnAdmin (SYNC-3)"
```

---

### Task 10: `admin/sync.js` — Sync-Übersicht (SYNC-1 Config + SYNC-2 Historie + SYNC-3 Stalled-Liste)

**Files:**
- Modify: `src/db/syncLogRepo.js` (add `listRecentSyncLogs`)
- Modify: `src/routes/admin/eskalation.js` (export `validateEmpfaengerListe`)
- Create: `src/routes/admin/sync.js`
- Create: `views/admin/sync.ejs`
- Modify: `views/admin/_nav.ejs` (add nav entry)
- Modify: `src/app.js` (mount the new router)
- Test: `test/unit/syncLogRepo.test.js` (new test)
- Test: `test/integration/admin/sync.test.js` (new file)

**Interfaces:**
- Consumes: `listRecentSyncLogs(db, limit)` (new, this task); `validateEmpfaengerListe` (exported, this task); `listStalledJobs`/`forceReleaseJob`/`forceEskalierenFreigabe2AnAdmin` (Task 9); `getConfigValue`/`setConfigValue` (existing); `getPersonById` (existing, for display names).
- Produces: nothing consumed by later tasks — this is the batch's admin-facing surface.

- [ ] **Step 1: Write the failing test for `listRecentSyncLogs`**

Add to `test/unit/syncLogRepo.test.js`. Extend the import line:

```javascript
import { startSyncLog, finishSyncLog, hasRecentRunningSync, listRecentSyncLogs } from '../../src/db/syncLogRepo.js';
```

Append:

```javascript
test('listRecentSyncLogs returns the most recent runs first, capped at the given limit', () => {
  const db = openDatabase(':memory:');
  const id1 = startSyncLog(db);
  finishSyncLog(db, id1, { status: 'erfolg', anzahlUpserted: 1, anzahlDeaktiviert: 0 });
  const id2 = startSyncLog(db);
  finishSyncLog(db, id2, { status: 'abgebrochen', fehlerDetails: 'zu viele Deaktivierungen' });

  const rows = listRecentSyncLogs(db, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id2);
  assert.equal(rows[0].status, 'abgebrochen');
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/syncLogRepo.test.js`
Expected: FAIL — `listRecentSyncLogs is not a function`

- [ ] **Step 3: Implement `listRecentSyncLogs`**

In `src/db/syncLogRepo.js`, add:

```javascript
export function listRecentSyncLogs(db, limit = 20) {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
}
```

Run: `node --test test/unit/syncLogRepo.test.js` — Expected: PASS

- [ ] **Step 4: Export `validateEmpfaengerListe` from `eskalation.js`**

In `src/routes/admin/eskalation.js`, change:

```javascript
function validateEmpfaengerListe(value, label, errors) {
```

to:

```javascript
export function validateEmpfaengerListe(value, label, errors) {
```

Run `node --test test/integration/admin/eskalation.test.js` to confirm this export change doesn't break the existing route (it shouldn't — the function is still called the same way internally). Expected: PASS.

- [ ] **Step 5: Write the failing integration tests for the new router**

Create `test/integration/admin/sync.test.js`, matching `test/integration/admin/eskalation.test.js`'s `buildTestApp`/session-header conventions (read that file first for the exact helper shape):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { seedDefaults, getConfigValue } from '../../../src/db/adminConfigRepo.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { loadCurrentPerson, requireRole } from '../../../src/middleware/roles.js';
import { createSyncRouter } from '../../../src/routes/admin/sync.js';

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
  app.use('/admin/sync', requireRole(config, 'portal-admin'), createSyncRouter({ db }));
  return app;
}

function seedAdmin(db) {
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
}

test('GET /admin/sync returns 401 without a session', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync');
  assert.equal(res.status, 401);
  db.close();
});

test('GET /admin/sync returns 403 for a non-admin', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '77');
  assert.equal(res.status, 403);
  db.close();
});

test('GET /admin/sync renders the current thresholds', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /50/);
  assert.match(res.text, /10/);
  db.close();
});

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
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '40');
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_anzahl'), '5');
  db.close();
});

test('POST /admin/sync rejects an invalid percent value and does not persist it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  const app = buildTestApp(db);
  const res = await request(app)
    .post('/admin/sync')
    .set('x-test-person-id', '99')
    .type('form')
    .send({ maxDeaktivierungProzent: '0', maxDeaktivierungAnzahl: '5', syncFehlerEmpfaenger: 'gruppe:admin' });
  assert.equal(res.status, 400);
  assert.equal(getConfigValue(db, 'sync_max_deaktivierung_prozent'), '50');
  db.close();
});

test('GET /admin/sync lists stalled jobs with a force-release action', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const app = buildTestApp(db);
  const res = await request(app).get('/admin/sync').set('x-test-person-id', '99');
  assert.equal(res.status, 200);
  assert.match(res.text, /a\.pdf/);
  assert.match(res.text, new RegExp(`/admin/sync/stalled/${jobId}/freigeben`));
  db.close();
});

test('POST /admin/sync/stalled/:jobId/freigeben force-releases a stalled zugewiesen job', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '1'").run();

  const app = buildTestApp(db);
  const res = await request(app).post(`/admin/sync/stalled/${jobId}/freigeben`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  assert.equal(getJobById(db, jobId).status, 'unzugewiesen');
  db.close();
});

test('POST /admin/sync/stalled/:jobId/freigeben escalates a stalled freigabe2 job to admin instead of releasing it', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  seedAdmin(db);
  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ? WHERE id = ?").run(kontoId, jobId);
  db.prepare("UPDATE personen SET aktiv = 0 WHERE churchtools_person_id = '3'").run();

  const app = buildTestApp(db);
  const res = await request(app).post(`/admin/sync/stalled/${jobId}/freigeben`).set('x-test-person-id', '99');
  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'freigabe2');
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  db.close();
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test test/integration/admin/sync.test.js`
Expected: FAIL — `Cannot find module '.../src/routes/admin/sync.js'`

- [ ] **Step 7: Implement the router**

Create `src/routes/admin/sync.js`:

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
      });
    }

    setConfigValue(db, 'sync_max_deaktivierung_prozent', String(prozentNum));
    setConfigValue(db, 'sync_max_deaktivierung_anzahl', String(anzahlNum));
    setConfigValue(db, 'sync_fehler_empfaenger', syncFehlerEmpfaenger.trim());
    res.redirect('/admin/sync');
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

- [ ] **Step 8: Create the view**

Create `views/admin/sync.ejs`:

```html
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>"<% } %>>
<head><meta charset="utf-8"><title>Sync-Übersicht — Freigabeportal Admin</title></head>
<body>
  <%- include('../_header') %>
  <%- include('./_nav') %>
  <h1>Sync-Übersicht</h1>
  <% if (errors.length > 0) { %>
    <ul><% errors.forEach((error) => { %><li><%= error %></li><% }) %></ul>
  <% } %>

  <h2>Massen-Deaktivierungs-Schutz</h2>
  <form method="post" action="/admin/sync">
    <label>Max. Deaktivierung (Prozent der aktiven Personen) <input type="number" name="maxDeaktivierungProzent" value="<%= maxDeaktivierungProzent %>" required></label><br>
    <label>Max. Deaktivierung (absolute Anzahl) <input type="number" name="maxDeaktivierungAnzahl" value="<%= maxDeaktivierungAnzahl %>" required></label><br>
    <label>Sync-Fehler-Empfänger (ein Ziel pro Zeile: E-Mail-Adresse oder "gruppe:admin")<br>
      <textarea name="syncFehlerEmpfaenger" rows="4" cols="50"><%= syncFehlerEmpfaenger || '' %></textarea>
    </label><br>
    <button type="submit">Speichern</button>
  </form>

  <h2>Sync-Historie</h2>
  <table>
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

  <h2>Feststeckende Jobs</h2>
  <table>
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
              <button type="submit">Freigeben</button>
            </form>
          </td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 9: Wire the nav entry and the app.js mount**

In `views/admin/_nav.ejs`, add a new entry:

```html
<nav>
  <a href="/admin/konten">Konten</a>
  <a href="/admin/zuweisungsregeln">Zuweisungsregeln</a>
  <a href="/admin/eskalation">Eskalationszeiten</a>
  <a href="/admin/erscheinungsbild">Erscheinungsbild</a>
  <a href="/admin/personen">Personen</a>
  <a href="/admin/pdf-einstellungen">PDF-Einstellungen</a>
  <a href="/admin/mails">Mail-Protokoll</a>
  <a href="/admin/sync">Sync-Übersicht</a>
</nav>
```

In `src/app.js`, add the import and the mount, alongside the other `/admin/*` sub-routers:

```javascript
import { createSyncRouter } from './routes/admin/sync.js';
```

```javascript
  app.use('/admin/mails', createMailsRouter({ db, mailer }));
  app.use('/admin/sync', createSyncRouter({ db }));
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node --test test/integration/admin/sync.test.js test/unit/syncLogRepo.test.js`
Expected: PASS, all tests.

Then run the full suite: `npm test`
Expected: PASS, no regressions (the `_nav.ejs` change is additive; every other admin view test that checks the page renders successfully is unaffected by one more `<a>` tag).

- [ ] **Step 11: Commit**

```bash
git add src/db/syncLogRepo.js src/routes/admin/eskalation.js src/routes/admin/sync.js views/admin/sync.ejs views/admin/_nav.ejs src/app.js test/unit/syncLogRepo.test.js test/integration/admin/sync.test.js
git commit -m "feat: add /admin/sync — sync thresholds, history, stalled-job force-release (SYNC-2, SYNC-3)"
```

---

### Task 11: Ende-zu-Ende-Test

**Files:**
- Create: `test/integration/syncRobustheitEndToEnd.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–10, exercised through real HTTP routes.
- Produces: nothing further — this is the batch's final verification task.

- [ ] **Step 1: Write the test**

Create `test/integration/syncRobustheitEndToEnd.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, getPersonById } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
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
    smtp: { host: 'smtp.example.org', port: 587, user: 'user', pass: 'pass', from: 'portal@example.org' },
    publicBaseUrl: 'http://portal.example.org',
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

test('a doubly-conflicted Freigabe-1 handoff reaches an admin, who takes it all the way to completion', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobsDir = mkdtempSync(join(tmpdir(), 'sync-robustheit-e2e-test-'));
  const config = testConfig(jobsDir);
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '1', vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '3', vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '4', vorname: 'Stellvertreter', nachname: 'Zwei', email: 's2@example.org', gruppen: ['10'], loggedInNow: false });
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const pdfPfad = join(jobsDir, 'e2e-sync-robustheit.pdf');
  writeFileSync(pdfPfad, await buildPdfFixture(['Rechnung', 'Visum']));
  const jobId = createJob(db, { eingangAm: '2026-08-01T00:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1' WHERE id = ?").run(jobId);

  const freigeber1Agent = await loginAs(app, client, { id: 1, vorname: 'Freigeber', nachname: 'Eins', email: 'f1@example.org', gruppen: ['10'] });
  await freigeber1Agent.post(`/kontierung/${jobId}`).type('form').send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Befangen.' });

  const stellvertreter1Agent = await loginAs(app, client, { id: 2, vorname: 'Stellvertreter', nachname: 'Eins', email: 's1@example.org', gruppen: ['10'] });
  const eskalationRes = await stellvertreter1Agent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'ja', begruendung: 'Auch befangen.' });
  assert.equal(eskalationRes.status, 302);
  assert.equal(getJobById(db, jobId).freigabe1_eskaliert_an_admin, 1);
  assert.equal(listMailLog(db).filter((m) => m.empfaenger === 'admin@example.org').length, 1);

  const adminAgent = await loginAs(app, client, { id: 99, vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'] });
  const kontierungRes = await adminAgent
    .post(`/kontierung/${jobId}`)
    .type('form')
    .send({ kontoId: String(kontoId), interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(kontierungRes.status, 302);
  assert.equal(getJobById(db, jobId).status, 'freigabe2');

  const freigeber2Agent = await loginAs(app, client, { id: 3, vorname: 'Freigeber', nachname: 'Zwei', email: 'f2@example.org', gruppen: ['10'] });
  const freigabe2Res = await freigeber2Agent.post(`/freigabe2/${jobId}`).type('form').send({ interessenskonflikt: 'nein', begruendung: '' });
  assert.equal(freigabe2Res.status, 302);
  assert.equal(getJobById(db, jobId).status, 'abgeschlossen');

  db.close();
  rmSync(jobsDir, { recursive: true, force: true });
});

test('a mass-deactivation sync run aborts cleanly, and a subsequent normal run still works', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = testConfig(mkdtempSync(join(tmpdir(), 'sync-robustheit-e2e-abort-test-')));
  const app = createApp({ db, config });
  const client = setupMockChurchTools(config.churchtools.baseUrl);

  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  for (let i = 1; i <= 20; i++) {
    upsertPerson(db, { id: String(i), vorname: `Person${i}`, nachname: 'Aktiv', email: `p${i}@example.org`, gruppen: ['10'], loggedInNow: false });
  }

  // First run: ChurchTools returns almost nobody — the guard should trip.
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, { data: [{ personId: 1 }] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  client.intercept({ path: '/api/persons/1', method: 'GET' }).reply(200, { data: { id: 1, firstName: 'Person1', lastName: 'Aktiv', email: 'p1@example.org' } });
  client.intercept({ path: '/api/persons/99', method: 'GET' }).reply(200, { data: { id: 99, firstName: 'Admina', lastName: 'Portal', email: 'admin@example.org' } });

  const abortRes = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(abortRes.body.status, 'abgebrochen');
  assert.equal(getPersonById(db, '20').aktiv, true, 'nothing should have been deactivated');
  assert.ok(listMailLog(db).some((m) => m.typ === 'sync-fehler'));

  // Second run: ChurchTools returns everyone as before — a completely normal run should still
  // succeed (the guard doesn't get "stuck" tripped).
  client.intercept({ path: '/api/groups/10/members', method: 'GET' }).reply(200, Array.from({ length: 20 }, (_, i) => ({ personId: i + 1 })).length ? { data: Array.from({ length: 20 }, (_, i) => ({ personId: i + 1 })) } : { data: [] });
  client.intercept({ path: '/api/groups/20/members', method: 'GET' }).reply(200, { data: [{ personId: 99 }] });
  for (let i = 1; i <= 20; i++) {
    client.intercept({ path: `/api/persons/${i}`, method: 'GET' }).reply(200, { data: { id: i, firstName: `Person${i}`, lastName: 'Aktiv', email: `p${i}@example.org` } });
  }
  client.intercept({ path: '/api/persons/99', method: 'GET' }).reply(200, { data: { id: 99, firstName: 'Admina', lastName: 'Portal', email: 'admin@example.org' } });

  const okRes = await request(app).post('/internal/cron/sync-personen').set('X-Cron-Secret', 'cron-secret');
  assert.equal(okRes.body.status, 'erfolg');
  db.close();
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/integration/syncRobustheitEndToEnd.test.js`
Expected: PASS. As with prior batches' end-to-end tasks, this should pass on the first run given Tasks 1–10 already implemented and unit/integration-tested every piece — if it doesn't, that's a real integration gap between tasks to fix before proceeding.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, full suite green, no regressions in any previously-passing file.

- [ ] **Step 4: Commit**

```bash
git add test/integration/syncRobustheitEndToEnd.test.js
git commit -m "test: cover the doubly-conflicted-escalation and mass-deactivation-abort paths end to end"
```

---

## After All Tasks: Whole-Batch Review

Following Batch 1 and Batch 2's precedent, dispatch one whole-branch code review before moving to `finishing-a-development-branch`. Pay particular attention to:

- Does `requireAnyRole` (Task 6) ever let someone with *neither* role through? Re-verify by constructing a person in neither group and confirming 403.
- Does the percent-threshold population floor (`aktiveVorher >= maxAnzahl`, Task 3) ever let a genuinely dangerous mass-deactivation through for a mid-sized org where the floor and the trip point interact unexpectedly? Walk through a few concrete population/threshold combinations by hand.
- Does `listStalledJobs` (Task 9) risk an N+1 query blowup for a large job table? At this app's scale (a small congregation) this is very unlikely to matter, but confirm the reviewer agrees it's an acceptable tradeoff rather than a real problem, given every other list-style function in this codebase (`listAbholbereitJobs`, `listPoolJobsForReminder`, etc.) already does its own per-row work.
- Confirm the `freigabe1_eskaliert_an_admin`/`freigabe2_eskaliert_an_admin` flags are checked in *every* place job authorization happens for these two routes — re-grep `zugewiesen_an` and `getEffectiveFreigeber2Id` usages in `kontierung.js`/`freigabe2.js` to confirm no authorization check was missed.
- Confirm `forceReleaseJob`'s guard (`WHERE status IN ('zugewiesen', 'abgelehnt')`) can never accidentally reset a `freigabe2` job to the pool, discarding a completed Freigabe-1 approval — re-run the "force-release escalates a stalled freigabe2 job to admin instead of releasing it" test with the guard removed to prove it's load-bearing.
