# Admin-Dashboard laufende Vorgänge + Umhängen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins sehen unter `/admin/vorgaenge` alle laufenden Vorgänge mit Status, aktuell zuständiger Person und voraussichtlicher Freigabe-2-Person, und können (mit `workflow_eingreifen`) einen Vorgang mit Pflicht-Bemerkung an eine andere Person übergeben.

**Architecture:** Pool/Kontierung/Abgelehnt werden über `jobs.zugewiesen_an` umgehängt, Freigabe 2 über die neue Spalte `jobs.freigabe2_umgeleitet_an`. Die Regel "wer ist effektive Freigabe-2-Person" lebt danach an genau zwei Stellen in `src/db/jobsRepo.js` (JS-Funktion + SQL-Fragment), die alle Leser verwenden. Drei kleine Services kapseln Zuständigkeit, Umhängen und die Übersicht; ein neuer Admin-Router rendert Liste und Detailseite.

**Tech Stack:** Node ≥ 22.13 (ESM), Express 4, EJS, `node:sqlite` (`DatabaseSync`), Bootstrap, Tests mit `node:test` + `supertest`.

**Spec:** `docs/superpowers/specs/2026-10-19-admin-vorgaenge-dashboard-design.md`

## Global Constraints

- Keine neuen npm-Abhängigkeiten.
- UI- und Mail-Texte auf Deutsch, mit Umlauten, Du-Form wie in den bestehenden Seiten ("dir", "du").
- Jede neue POST-Route bekommt `csrfProtection` und steht in `test/integration/csrfSweep.test.js`.
- Phasen mit Eingriff: `unzugewiesen`, `zugewiesen`, `freigabe2`, `abgelehnt`.
- Zielpersonen: aktive Personen mit mind. einer Konto-Rolle auf einem aktiven Konto (`listPersonenMitFreigeberRolle`), minus Ausschlüsse.
- Bisherige Person verliert den Zugriff (exklusiver Wechsel).
- Strikte Freigeber1-Prüfung (`kontierung_strikte_freigeber1_pruefung`) bleibt unverändert in Kraft — kein Bypass, nur ein Hinweis im Formular.
- Freigabe-2-Umleitung endet, sobald der Job `freigabe2` verlässt (Abschluss oder Ablehnung).
- Reihenfolge effektive Freigabe-2-Person: Admin-Eskalation → `freigabe2_umgeleitet_an` → Stellvertreter 2 (bei `freigabe2_eskaliert_von`) → Freigeber 2; danach Ferienvertretung.
- Ansehen: neues Recht `vorgaenge_einsehen` (superadmin + manager per Bundle). Eingreifen: `workflow_eingreifen` (nicht im manager-Bundle).
- Pflicht-Bemerkung: mind. 10 Zeichen nach `trim()`.
- Mail-Typ `admin-umzuweisung` geht immer sofort raus (nie gebündelt).
- Status-Codes: 404 (nicht gefunden / nicht laufend), 422 (Ziel/Bemerkung ungültig), 409 (Stand hat sich geändert).

**Bewusste Präzisierung gegenüber der Spec:** Es gibt keine allgemeine Admin-Detailseite für Jobs (die Workflow-Seiten `/kontierung/:id` etc. liefern Admins 403). Deshalb ist `GET /admin/vorgaenge/:id` die Detailseite (Stand, Verlauf, PDF-Link) und enthält das Umhängen-Formular, wenn die Person `workflow_eingreifen` hat. `POST /admin/vorgaenge/:id/umhaengen` führt aus. Die Mail-Variablen folgen der Namenskonvention der bestehenden Vorlagen (`%empfaengerName%`, `%adminName%`, `%grund%`, `%bemerkung%`, `%jobDateiname%`, `%link%`).

## Review Focus

1. **Umgeleitete Person erteilt Freigabe 2** → die Umleitung wird beim Abschluss gelöscht; der Vorgang muss trotzdem in ihrer Liste "Meine abgeschlossenen" erscheinen (Test in Task 4).
2. **Eine zweite Konflikt-Eskalation überschreibt `freigabe2_eskaliert_von`** (der ursprünglich konfliktbehaftete Freigeber 2 steht danach nicht mehr in der Spalte) → er darf trotzdem nie als Ziel wählbar sein; ausgeschlossen wird über die `freigaben`-Einträge (Test in Task 5).
3. **Abgelehnte Spesen-Position** hat keinen Überarbeiten-Weg (`/abgelehnt/:id` lehnt Spesen ab) → Umhängen muss sie ablehnen statt einen toten Vorgang zu erzeugen (Test in Task 5 und Task 7).
4. **Admin lädt das Formular, inzwischen erteilt jemand Freigabe 2** → 409, nichts geschrieben, keine Mail (Test in Task 5).
5. **Zielperson ist im Ferienmodus** → ihre Vertretung bekommt ebenfalls die Mail und sieht den Freigabe-2-Vorgang in ihrer Liste (Tests in Task 3 und Task 5).

---

### Task 1: Datenbank-Schema

**Files:**
- Modify: `src/db/index.js` (Liste `JOBS_TABLE_MIGRATIONS` ab Zeile 24, neue Funktion nach `migrateMailZustellung`, Aufruf in `openDatabase`)
- Modify: `src/db/schema.sql` (Tabellen `jobs`, `freigaben`, `mail_log`)
- Modify: `src/db/securitySchema.js:1-5` (`RIGHTS`)
- Modify: `src/db/freigabenRepo.js` (`createFreigabe`)
- Test: `test/unit/adminUmzuweisungSchema.test.js` (neu)

**Interfaces:**
- Produces: Spalte `jobs.freigabe2_umgeleitet_an TEXT` (nullable); `freigaben.rolle` erlaubt `'admin_umzuweisung'`; Spalten `freigaben.vorher_zustaendig TEXT`, `freigaben.ziel_person_id TEXT`; `mail_log.typ` erlaubt `'admin-umzuweisung'`; `person_berechtigungen.berechtigung` erlaubt `'vorgaenge_einsehen'`.
- Produces: `createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon, vertretungFuer = null, vorherZustaendig = null, zielPersonId = null }) → number`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/adminUmzuweisungSchema.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';

function spalten(db, tabelle) {
  return db.prepare(`PRAGMA table_info(${tabelle})`).all().map((c) => c.name);
}

function seed(db) {
  upsertPerson(db, { id: '1', vorname: 'P', nachname: 'Eins', email: 'p1@example.org', gruppen: [], loggedInNow: false });
  upsertPerson(db, { id: '2', vorname: 'P', nachname: 'Zwei', email: 'p2@example.org', gruppen: [], loggedInNow: false });
  return createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
}

test('frische DB: neue Spalten, Rolle, Mail-Typ und Recht sind vorhanden', () => {
  const db = openDatabase(':memory:');
  assert.ok(spalten(db, 'jobs').includes('freigabe2_umgeleitet_an'));
  assert.ok(spalten(db, 'freigaben').includes('vorher_zustaendig'));
  assert.ok(spalten(db, 'freigaben').includes('ziel_person_id'));
  const jobId = seed(db);
  createFreigabe(db, {
    jobId, personId: '1', rolle: 'admin_umzuweisung', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '127.0.0.1',
    interessenskonflikt: false, kommentar: 'Von Pool an P Zwei: Test', eskaliertVon: null, vorherZustaendig: null, zielPersonId: '2',
  });
  const [eintrag] = listFreigabenByJob(db, jobId);
  assert.equal(eintrag.rolle, 'admin_umzuweisung');
  assert.equal(eintrag.ziel_person_id, '2');
  assert.equal(eintrag.vorher_zustaendig, null);
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO mail_log (typ, job_id, empfaenger, betreff, text, status, versucht_am) VALUES ('admin-umzuweisung', NULL, 'x@example.org', 'B', 'T', 'eingereiht', '2026-10-01')").run()
  );
  assert.doesNotThrow(() => db.prepare("INSERT INTO person_berechtigungen (person_id, berechtigung) VALUES ('1', 'vorgaenge_einsehen')").run());
  db.close();
});

test('bestehende DB mit altem freigaben-/mail_log-CHECK wird migriert, ohne Daten zu verlieren', () => {
  const dir = mkdtempSync(join(tmpdir(), 'umzuweisung-schema-'));
  const pfad = join(dir, 'portal.db');
  let db = openDatabase(pfad);
  const jobId = seed(db);
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.close();

  // Stand vor diesem Feature nachbauen: alter CHECK, ohne die zwei neuen Spalten.
  const raw = new DatabaseSync(pfad);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    ALTER TABLE freigaben RENAME TO f_neu;
    CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id)
    );
    INSERT INTO freigaben SELECT id, job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer FROM f_neu;
    DROP TABLE f_neu;
  `);
  raw.close();

  db = openDatabase(pfad);
  const eintraege = listFreigabenByJob(db, jobId);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].rolle, 'freigeber1');
  assert.ok(spalten(db, 'freigaben').includes('ziel_person_id'));
  assert.doesNotThrow(() =>
    createFreigabe(db, { jobId, personId: '1', rolle: 'admin_umzuweisung', zeitpunkt: '2026-10-01T10:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: 'x', eskaliertVon: null, zielPersonId: '2' })
  );
  // Audit-Trigger wurden nach dem Neuaufbau wieder angelegt und kennen die neue Spalte.
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_freigaben_INSERT'").get();
  assert.ok(trigger && trigger.sql.includes('ziel_person_id'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mail_log_zustellung_idx'").get());
  db.close();
  openDatabase(pfad).close(); // idempotent
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/adminUmzuweisungSchema.test.js`
Expected: FAIL (Spalte `freigabe2_umgeleitet_an` fehlt bzw. CHECK constraint failed für `admin_umzuweisung`).

- [ ] **Step 3: Implement**

In `src/db/index.js`, `JOBS_TABLE_MIGRATIONS` um einen Eintrag nach `kk_text_betraege` ergänzen:

```js
  { column: 'kk_text_betraege', ddl: 'ALTER TABLE jobs ADD COLUMN kk_text_betraege TEXT' },
  // Admin-Umhängen bei Freigabe 2 (/admin/vorgaenge): hat Vorrang vor Stellvertreter2/Freigeber2.
  { column: 'freigabe2_umgeleitet_an', ddl: 'ALTER TABLE jobs ADD COLUMN freigabe2_umgeleitet_an TEXT REFERENCES personen(churchtools_person_id)' },
];
```

Neue Funktion direkt nach `migrateMailZustellung` einfügen:

```js
// Admin-Umhängen (/admin/vorgaenge): neue freigaben-Rolle 'admin_umzuweisung' plus zwei Spalten
// (vorher zuständige Person, Zielperson) und neuer Mail-Typ 'admin-umzuweisung'. Gleiches
// Rebuild-Muster wie oben. Muss VOR migrateSecuritySchema laufen, damit die dort neu erzeugten
// Audit-Trigger die neuen freigaben-Spalten in ihren Snapshot aufnehmen.
function migrateAdminUmzuweisung(db) {
  erweitereCheckPerRebuild(db, {
    tabelle: 'freigaben',
    marker: 'admin_umzuweisung',
    createSql: `CREATE TABLE freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id),
      rolle TEXT NOT NULL CHECK (rolle IN ('freigeber1', 'freigeber2', 'ablehnung', 'freigabe1_eskalation', 'freigabe2_eskalation', 'iban_abweichung', 'rechnungsnummer_duplikat', 'pool_zuweisung', 'pool_ruecksendung', 'freigabe1_weiterleitung', 'kk_abrechnung_markiert', 'kk_markierung_aufgehoben', 'kk_abgleich', 'admin_umzuweisung')),
      zeitpunkt TEXT NOT NULL,
      ip TEXT NOT NULL,
      interessenskonflikt INTEGER NOT NULL DEFAULT 0,
      kommentar TEXT,
      eskaliert_von TEXT REFERENCES personen(churchtools_person_id),
      vertretung_fuer TEXT REFERENCES personen(churchtools_person_id),
      vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),
      ziel_person_id TEXT REFERENCES personen(churchtools_person_id)
    )`,
    spalten: ['id', 'job_id', 'person_id', 'rolle', 'zeitpunkt', 'ip', 'interessenskonflikt', 'kommentar', 'eskaliert_von', 'vertretung_fuer'],
  });
  erweitereCheckPerRebuild(db, {
    tabelle: 'mail_log',
    marker: 'admin-umzuweisung',
    createSql: `CREATE TABLE mail_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      typ TEXT NOT NULL CHECK (typ IN ('zuweisung', 'reminder', 'eskalation', 'ablehnung', 'sync-fehler', 'iban-warnung', 'rechnungsnummer-warnung', 'freigabe2-reminder', 'freigabe2-eskalation', 'kk-abrechnung-zugewiesen', 'kk-beleg-erinnerung', 'kk-beleg-eingegangen', 'sicherheitsalarm', 'admin-umzuweisung')),
      job_id INTEGER REFERENCES jobs(id),
      empfaenger TEXT NOT NULL,
      betreff TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('eingereiht', 'versendet', 'fehlgeschlagen', 'geplant')),
      fehler_details TEXT,
      versucht_am TEXT NOT NULL,
      eingereiht_am TEXT,
      versuche INTEGER NOT NULL DEFAULT 0,
      naechster_versuch_am TEXT,
      sperre_token TEXT,
      sperre_bis TEXT,
      versendet_am TEXT
    )`,
    spalten: ['id', 'typ', 'job_id', 'empfaenger', 'betreff', 'text', 'status', 'fehler_details', 'versucht_am', 'eingereiht_am', 'versuche', 'naechster_versuch_am', 'sperre_token', 'sperre_bis', 'versendet_am'],
  });
  // Der Index verschwindet mit der alten Tabelle beim Rebuild.
  db.exec('CREATE INDEX IF NOT EXISTS mail_log_zustellung_idx ON mail_log(status, naechster_versuch_am)');
}
```

In `openDatabase` direkt nach `migrateMailZustellung(db);` aufrufen:

```js
  migrateMailZustellung(db);
  migrateAdminUmzuweisung(db);
```

In `src/db/schema.sql` (damit eine frische DB gar nicht erst umgebaut wird):
- Tabelle `jobs`: Zeile `kk_text_betraege TEXT` → `kk_text_betraege TEXT,` und darunter `freigabe2_umgeleitet_an TEXT REFERENCES personen(churchtools_person_id)` einfügen.
- Tabelle `freigaben`: `'kk_abgleich'` → `'kk_abgleich', 'admin_umzuweisung'` im CHECK; nach `vertretung_fuer ...` (Komma ergänzen) die Zeilen `vorher_zustaendig TEXT REFERENCES personen(churchtools_person_id),` und `ziel_person_id TEXT REFERENCES personen(churchtools_person_id)` anhängen.
- Tabelle `mail_log`: `'sicherheitsalarm'` → `'sicherheitsalarm', 'admin-umzuweisung'` im CHECK.

In `src/db/securitySchema.js`:

```js
const RIGHTS = [
  'konten_verwalten', 'kreditoren_verwalten', 'geplante_jobs_verwalten',
  'abgelehnt_verwalten', 'mails_einsehen', 'sync_einsehen', 'audit_log_einsehen',
  'pool_zuweisen', 'sync_verwalten', 'workflow_eingreifen', 'kreditkarten_verwalten',
  'vorgaenge_einsehen',
];
```

(Der bestehende Neuaufbau-Zweig erkennt den fehlenden Wert im CHECK und baut die Tabelle neu auf.)

In `src/db/freigabenRepo.js`:

```js
export function createFreigabe(db, { jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliertVon, vertretungFuer = null, vorherZustaendig = null, zielPersonId = null }) {
  const result = db
    .prepare(
      `INSERT INTO freigaben (job_id, person_id, rolle, zeitpunkt, ip, interessenskonflikt, kommentar, eskaliert_von, vertretung_fuer, vorher_zustaendig, ziel_person_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(jobId, personId, rolle, zeitpunkt, ip, interessenskonflikt ? 1 : 0, kommentar ?? null, eskaliertVon ?? null, vertretungFuer ?? null, vorherZustaendig ?? null, zielPersonId ?? null);
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/unit/adminUmzuweisungSchema.test.js` → PASS.
Run: `npm test` → alle grün. Falls ein bestehender Test die Rechte-Liste in `person_berechtigungen` exakt prüft (z. B. `test/unit/securitySchema.test.js`), den Erwartungswert um `'vorgaenge_einsehen'` ergänzen.

- [ ] **Step 5: Commit**

```bash
git add src/db/index.js src/db/schema.sql src/db/securitySchema.js src/db/freigabenRepo.js test/unit/adminUmzuweisungSchema.test.js
git commit -m "feat(db): Schema für Admin-Umhängen (F2-Umleitung, Rolle, Mail-Typ, Recht)"
```

---

### Task 2: Recht, Mail-Typ und Verlaufs-Bezeichnung

**Files:**
- Modify: `src/middleware/permissions.js` (`GRANTABLE_BERECHTIGUNGEN`, `BERECHTIGUNG_LABELS`)
- Modify: `src/services/mailTemplates.js` (`TYP_ZU_KEY_INFIX`)
- Modify: `src/db/adminConfigRepo.js` (`DEFAULTS`)
- Modify: `src/services/notify.js` (`IMMER_SOFORT_TYPEN`)
- Modify: `src/routes/admin/mailEinstellungen.js` (`VORLAGEN_FELDER`) und `views/admin/mail-einstellungen-form.ejs`
- Modify: `src/services/auditLog.js` (`EREIGNIS_LABEL`)
- Test: `test/unit/permissions.test.js`, `test/unit/mailTemplates.test.js`, `test/unit/notify.test.js`

**Interfaces:**
- Produces: Recht `'vorgaenge_einsehen'` (Label "Laufende Vorgänge einsehen"); Label von `workflow_eingreifen` = "In laufende Vorgänge eingreifen".
- Produces: Mail-Typ `'admin-umzuweisung'` mit Config-Keys `mail_vorlage_admin_umzuweisung_betreff` / `_text`, Variablen `%empfaengerName%`, `%grund%`, `%jobDateiname%`, `%adminName%`, `%bemerkung%`, `%link%`, `%portalName%`.
- Produces: `EREIGNIS_LABEL.admin_umzuweisung = 'Vorgang durch Administration übergeben'`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/permissions.test.js` den bestehenden Test "GRANTABLE_BERECHTIGUNGEN lists exactly the eleven …" anpassen (Titel "twelve", Liste sortiert):

```js
test('GRANTABLE_BERECHTIGUNGEN lists exactly the twelve catalog permissions, separating sync reading and writing', () => {
  assert.deepEqual(
    [...GRANTABLE_BERECHTIGUNGEN].sort(),
    ['abgelehnt_verwalten', 'audit_log_einsehen', 'geplante_jobs_verwalten', 'konten_verwalten', 'kreditkarten_verwalten', 'kreditoren_verwalten', 'mails_einsehen', 'pool_zuweisen', 'sync_einsehen', 'sync_verwalten', 'vorgaenge_einsehen', 'workflow_eingreifen']
  );
```

(Restliche Zeilen des Tests unverändert lassen.) Zusätzlich anhängen:

```js
test('vorgaenge_einsehen hat ein Label und workflow_eingreifen heisst jetzt "In laufende Vorgänge eingreifen"', () => {
  assert.equal(BERECHTIGUNG_LABELS.vorgaenge_einsehen, 'Laufende Vorgänge einsehen');
  assert.equal(BERECHTIGUNG_LABELS.workflow_eingreifen, 'In laufende Vorgänge eingreifen');
});
```

In `test/unit/mailTemplates.test.js` anhängen (Importe `openDatabase`, `seedDefaults`, `getVorlage` ggf. ergänzen):

```js
test('admin-umzuweisung hat eine Standardvorlage mit Bemerkung und Link', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const vorlage = getVorlage(db, 'admin-umzuweisung');
  assert.match(vorlage.betreff, /übergeben/);
  for (const variable of ['%empfaengerName%', '%grund%', '%jobDateiname%', '%adminName%', '%bemerkung%', '%link%']) {
    assert.ok(vorlage.text.includes(variable), variable);
  }
  db.close();
});
```

In `test/unit/notify.test.js` anhängen (Importe `openDatabase`, `seedDefaults`, `setConfigValue`, `reiheBenachrichtigungEin` ggf. ergänzen):

```js
test('admin-umzuweisung wird auch bei aktivem Batching sofort eingereiht', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'mail_batching_aktiv', '1');
  const eintrag = reiheBenachrichtigungEin(db, {
    to: 'x@example.org', typ: 'admin-umzuweisung', jobId: null,
    variablen: { empfaengerName: 'X', grund: 'G', jobDateiname: 'a.pdf', adminName: 'A', bemerkung: 'B', link: 'L' },
  });
  assert.equal(eintrag.status, 'eingereiht');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit/permissions.test.js test/unit/mailTemplates.test.js test/unit/notify.test.js`
Expected: FAIL (Recht fehlt, "Unbekannter Mail-Vorlagen-Typ: admin-umzuweisung").

- [ ] **Step 3: Implement**

`src/middleware/permissions.js`: `'vorgaenge_einsehen'` als letzten Eintrag in `GRANTABLE_BERECHTIGUNGEN`; in `BERECHTIGUNG_LABELS`:

```js
  workflow_eingreifen: 'In laufende Vorgänge eingreifen',
  vorgaenge_einsehen: 'Laufende Vorgänge einsehen',
```

(Das manager-Bundle in `personHasPermission` bleibt unverändert: es schliesst nur `sync_verwalten` und `workflow_eingreifen` aus, `vorgaenge_einsehen` ist also automatisch enthalten.)

`src/services/mailTemplates.js`, in `TYP_ZU_KEY_INFIX`:

```js
  'kk-beleg-eingegangen': 'kk_beleg_eingegangen',
  'admin-umzuweisung': 'admin_umzuweisung',
```

`src/db/adminConfigRepo.js`, in `DEFAULTS` nach `mail_vorlage_kk_beleg_eingegangen_text`:

```js
  mail_vorlage_admin_umzuweisung_betreff: 'Freigabeportal: Vorgang durch Administration übergeben',
  mail_vorlage_admin_umzuweisung_text: 'Hallo %empfaengerName%,\n\n%grund%\n\nVorgang: %jobDateiname%\nBemerkung von %adminName%: %bemerkung%\n\n%link%\n\nFreundliche Grüsse\n%portalName%',
```

`src/services/notify.js`:

```js
// admin-umzuweisung: ein Admin hat einen laufenden Vorgang umgehängt -- die neue Person soll sofort
// handeln können, die bisherige sofort wissen, dass sie nichts mehr tun muss.
const IMMER_SOFORT_TYPEN = new Set(['sync-fehler', 'iban-warnung', 'kk-beleg-eingegangen', 'admin-umzuweisung']);
```

`src/routes/admin/mailEinstellungen.js`, am Ende von `VORLAGEN_FELDER`:

```js
  ['adminUmzuweisungBetreff', 'mail_vorlage_admin_umzuweisung_betreff'],
  ['adminUmzuweisungText', 'mail_vorlage_admin_umzuweisung_text'],
```

`views/admin/mail-einstellungen-form.ejs`, direkt vor `<button type="submit" class="btn btn-primary">Speichern</button>`:

```ejs
      <div class="mb-3">
        <label class="form-label" for="adminUmzuweisungBetreff">Vorgang durch Administration übergeben — Betreff</label>
        <input type="text" class="form-control" id="adminUmzuweisungBetreff" name="adminUmzuweisungBetreff" value="<%= adminUmzuweisungBetreff %>" required>
        <label class="form-label mt-2" for="adminUmzuweisungText">Vorgang durch Administration übergeben — Text</label>
        <textarea class="form-control" id="adminUmzuweisungText" name="adminUmzuweisungText" rows="4" required><%= adminUmzuweisungText %></textarea>
        <div class="form-text">Variablen: %empfaengerName%, %grund%, %jobDateiname%, %adminName%, %bemerkung%, %link%, %portalName%</div>
      </div>
```

`src/services/auditLog.js`, in `EREIGNIS_LABEL` nach `freigabe1_weiterleitung`:

```js
  admin_umzuweisung: 'Vorgang durch Administration übergeben',
```

- [ ] **Step 4: Run tests**

`test/integration/admin/mailEinstellungen.test.js` schickt eine feste Feldliste (Zeile ~55, `kkBelegEingegangenBetreff: 'B13', kkBelegEingegangenText: 'T13',`). Direkt dahinter ergänzen, sonst scheitert dessen POST mit 400 ("darf nicht leer sein"):

```js
  adminUmzuweisungBetreff: 'B14', adminUmzuweisungText: 'T14',
```

Run: `npm test` → alle grün. Achtung: `test/unit/mailZustellung.test.js` (~Zeile 212) und `test/unit/db.test.js` (~Zeile 1161) bauen Alt-Datenbanken mit älteren CHECK-Listen nach und öffnen sie dann mit `openDatabase` — sie müssen ohne Änderung weiter grün sein. Falls nicht, liegt der Fehler in `migrateAdminUmzuweisung` (Spaltenliste), nicht im Test.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/permissions.js src/services/mailTemplates.js src/db/adminConfigRepo.js src/services/notify.js src/routes/admin/mailEinstellungen.js views/admin/mail-einstellungen-form.ejs src/services/auditLog.js test/unit/permissions.test.js test/unit/mailTemplates.test.js test/unit/notify.test.js test/integration/admin/mailEinstellungen.test.js
git commit -m "feat: Recht vorgaenge_einsehen, Mail-Typ admin-umzuweisung, Verlaufs-Label"
```

---

### Task 3: Effektive Freigabe-2-Person aus einer Quelle

**Files:**
- Modify: `src/db/jobsRepo.js` (`getEffectiveFreigeber2Id` Zeile ~655, `listFreigabe2JobsForPerson` Zeile ~570, `listAbgeschlossenJobsForPerson` Zeile ~607, neues Export `EFFEKTIVER_FREIGEBER2_SQL`)
- Test: `test/unit/effektiverFreigeber2.test.js` (neu)

**Interfaces:**
- Consumes: Spalte `jobs.freigabe2_umgeleitet_an` (Task 1).
- Produces: `getEffectiveFreigeber2Id(job, konto) → string|null` — berücksichtigt jetzt die Umleitung (Admin-Eskalation prüfen die Aufrufer weiterhin selbst).
- Produces: `export const EFFEKTIVER_FREIGEBER2_SQL` — SQL-Ausdruck, setzt `FROM jobs JOIN konten ON konten.id = jobs.konto_id` voraus.

- [ ] **Step 1: Write the failing test**

Create `test/unit/effektiverFreigeber2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus, deactivatePerson } from '../../src/db/personenRepo.js';
import { createKonto, getKontoById } from '../../src/db/kontenRepo.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import {
  createJob, getJobById, getEffectiveFreigeber2Id, EFFEKTIVER_FREIGEBER2_SQL,
  listFreigabe2JobsForPerson, listStalledJobs,
} from '../../src/db/jobsRepo.js';
import { runFreigabe2ErinnerungenJob } from '../../src/services/cronJobs.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

function seed(db) {
  for (const id of ['1', '2', '3', '4', '5', '6']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_seit = ? WHERE id = ?").run(kontoId, new Date().toISOString(), jobId);
  return { kontoId, jobId };
}

function sqlWert(db, jobId) {
  return db.prepare(`SELECT ${EFFEKTIVER_FREIGEBER2_SQL} AS id FROM jobs JOIN konten ON konten.id = jobs.konto_id WHERE jobs.id = ?`).get(jobId).id;
}

test('JS-Funktion und SQL-Fragment liefern für alle Fälle dieselbe Person', () => {
  const db = openDatabase(':memory:');
  const { kontoId, jobId } = seed(db);
  const faelle = [
    { setze: { freigabe2_eskaliert_von: null, freigabe2_umgeleitet_an: null }, erwartet: '3' },
    { setze: { freigabe2_eskaliert_von: '3', freigabe2_umgeleitet_an: null }, erwartet: '4' },
    { setze: { freigabe2_eskaliert_von: null, freigabe2_umgeleitet_an: '5' }, erwartet: '5' },
    { setze: { freigabe2_eskaliert_von: '3', freigabe2_umgeleitet_an: '5' }, erwartet: '5' },
  ];
  for (const { setze, erwartet } of faelle) {
    db.prepare('UPDATE jobs SET freigabe2_eskaliert_von = ?, freigabe2_umgeleitet_an = ? WHERE id = ?').run(setze.freigabe2_eskaliert_von, setze.freigabe2_umgeleitet_an, jobId);
    const job = getJobById(db, jobId);
    assert.equal(getEffectiveFreigeber2Id(job, getKontoById(db, kontoId)), erwartet, JSON.stringify(setze));
    assert.equal(sqlWert(db, jobId), erwartet, `SQL ${JSON.stringify(setze)}`);
  }
  db.close();
});

test('Aufgabenliste: umgeleitete Person und ihre Ferienvertretung sehen den Job, der ursprüngliche Freigeber 2 nicht', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seed(db);
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5' WHERE id = ?").run(jobId);
  const heute = new Date().toISOString().slice(0, 10);
  setFerienmodus(db, '5', { von: heute, bis: heute, stellvertreterId: '6' });
  assert.deepEqual(listFreigabe2JobsForPerson(db, '5').map((j) => j.id), [jobId]);
  assert.deepEqual(listFreigabe2JobsForPerson(db, '6').map((j) => j.id), [jobId]);
  assert.deepEqual(listFreigabe2JobsForPerson(db, '3'), []);
  db.close();
});

test('listStalledJobs meldet eine deaktivierte umgeleitete Person', () => {
  const db = openDatabase(':memory:');
  const { jobId } = seed(db);
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5' WHERE id = ?").run(jobId);
  deactivatePerson(db, '5', 'churchtools_geloescht');
  const stalled = listStalledJobs(db).find((s) => s.job.id === jobId);
  assert.ok(stalled);
  assert.equal(stalled.akteurId, '5');
  db.close();
});

test('freigabe2-erinnerungen schickt den Reminder an die umgeleitete Person', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'freigabe2_reminder_stunden', '24');
  setConfigValue(db, 'freigabe2_eskalation_stunden', '1000');
  const { jobId } = seed(db);
  const vor30h = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  db.prepare("UPDATE jobs SET freigabe2_umgeleitet_an = '5', freigabe2_seit = ? WHERE id = ?").run(vor30h, jobId);
  const mailer = { async sendMail() {} };
  await runFreigabe2ErinnerungenJob(db, CONFIG, mailer);
  const reminder = listMailLog(db).filter((m) => m.typ === 'freigabe2-reminder');
  assert.deepEqual(reminder.map((m) => m.empfaenger), ['p5@example.org']);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/effektiverFreigeber2.test.js`
Expected: FAIL (`EFFEKTIVER_FREIGEBER2_SQL` ist kein Export; Umleitung wird ignoriert).

- [ ] **Step 3: Implement**

In `src/db/jobsRepo.js` direkt nach `VERTRETUNG_ZIEL_SUBQUERY`:

```js
// Effektive Freigabe-2-Person in SQL -- muss exakt getEffectiveFreigeber2Id (unten) entsprechen,
// test/unit/effektiverFreigeber2.test.js prüft beide gegeneinander. Admin-Eskalation
// (freigabe2_eskaliert_an_admin) prüft jeder Aufrufer weiterhin selbst. Setzt
// "FROM jobs JOIN konten ON konten.id = jobs.konto_id" voraus.
export const EFFEKTIVER_FREIGEBER2_SQL = `(CASE
    WHEN jobs.freigabe2_umgeleitet_an IS NOT NULL THEN jobs.freigabe2_umgeleitet_an
    WHEN jobs.freigabe2_eskaliert_von IS NOT NULL THEN konten.stellvertreter2_id
    ELSE konten.freigeber2_id
  END)`;
```

`listFreigabe2JobsForPerson` ersetzen (Kommentar darüber bleibt):

```js
export function listFreigabe2JobsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT jobs.* FROM jobs
       JOIN konten ON konten.id = jobs.konto_id
       WHERE jobs.status = 'freigabe2'
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (${EFFEKTIVER_FREIGEBER2_SQL} = ? OR ${EFFEKTIVER_FREIGEBER2_SQL} IN (${VERTRETUNG_ZIEL_SUBQUERY}))
         AND NOT (jobs.quelle = 'spesen' AND jobs.eingereicht_von = ?)
       ORDER BY jobs.eingang_am`
    )
    .all(personId, personId, personId);
}
```

In `listAbgeschlossenJobsForPerson` die `where`-Konstante ersetzen (Parameter bleiben `[personId, personId]` → siehe unten; Task 4 erweitert sie noch):

```js
  const where = `WHERE jobs.status IN ('abgeschlossen', 'abgeholt', 'archiviert')
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (
           jobs.zugewiesen_an = ?
           OR ${EFFEKTIVER_FREIGEBER2_SQL} = ?
         )`;
  const params = [personId, personId];
```

`getEffectiveFreigeber2Id` ersetzen:

```js
// Muss exakt EFFEKTIVER_FREIGEBER2_SQL (oben) entsprechen. Die Admin-Eskalation prüfen die
// Aufrufer selbst (sie hat Vorrang vor allem hier).
export function getEffectiveFreigeber2Id(job, konto) {
  if (job.freigabe2_umgeleitet_an) return job.freigabe2_umgeleitet_an;
  return job.freigabe2_eskaliert_von ? konto.stellvertreter2_id : konto.freigeber2_id;
}
```

(`listStalledJobs`, `cronJobs.js`, `jobAuthorization.js` und `routes/freigabe2.js` nutzen bereits `getEffectiveFreigeber2Id` und brauchen keine Änderung.)

- [ ] **Step 4: Run tests**

Run: `node --test test/unit/effektiverFreigeber2.test.js` → PASS. Run: `npm test` → alle grün.

- [ ] **Step 5: Commit**

```bash
git add src/db/jobsRepo.js test/unit/effektiverFreigeber2.test.js
git commit -m "refactor(jobs): effektive Freigabe-2-Person aus einer Quelle, inkl. Umleitung"
```

---

### Task 4: Lebensdauer der Umleitung und Konflikt der umgeleiteten Person

**Files:**
- Modify: `src/db/jobsRepo.js` (`abschliessenFreigabe2`, `ablehnenJob`, `releaseJob`, `sendJobBackToGroup`, `forceReleaseJob`, `eskalierenFreigabe2AnAdmin`, `forceEskalierenFreigabe2AnAdmin`, `listAbgeschlossenJobsForPerson`)
- Modify: `src/routes/freigabe2.js` (Konflikt-Zweig, Zeile ~148-152)
- Test: `test/unit/freigabe2Umleitung.test.js` (neu), `test/integration/freigabe2Umleitung.test.js` (neu)

**Interfaces:**
- Consumes: `EFFEKTIVER_FREIGEBER2_SQL`, `getEffectiveFreigeber2Id` (Task 3).
- Produces: Jede Funktion, die einen Job aus `freigabe2` herausführt oder an die Admin-Gruppe eskaliert, setzt `freigabe2_umgeleitet_an = NULL`.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/freigabe2Umleitung.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import {
  createJob, getJobById, abschliessenFreigabe2, ablehnenJob, eskalierenFreigabe2AnAdmin,
  forceEskalierenFreigabe2AnAdmin, listAbgeschlossenJobsForPerson,
} from '../../src/db/jobsRepo.js';

function seedUmgeleitet(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_umgeleitet_an = '5' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

test('Abschluss löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  assert.ok(abschliessenFreigabe2(db, jobId));
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Ablehnung löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  assert.ok(ablehnenJob(db, jobId, { abgelehntVon: '5', grund: 'falsch' }));
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Admin-Eskalation (Konflikt und Cron) löscht die Umleitung', () => {
  const db = openDatabase(':memory:');
  const a = seedUmgeleitet(db);
  eskalierenFreigabe2AnAdmin(db, a, { eskaliertVon: '5', grund: 'Konflikt' });
  assert.equal(getJobById(db, a).freigabe2_umgeleitet_an, null);
  const b = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'b.pdf', pdfPfad: '/tmp/b.pdf' });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = (SELECT konto_id FROM jobs WHERE id = ?), freigabe2_umgeleitet_an = '5' WHERE id = ?").run(a, b);
  assert.ok(forceEskalierenFreigabe2AnAdmin(db, b));
  assert.equal(getJobById(db, b).freigabe2_umgeleitet_an, null);
  db.close();
});

test('Meine abgeschlossenen: wer Freigabe 2 erteilt hat, sieht den Job auch nach gelöschter Umleitung', () => {
  const db = openDatabase(':memory:');
  const jobId = seedUmgeleitet(db);
  createFreigabe(db, { jobId, personId: '5', rolle: 'freigeber2', zeitpunkt: '2026-10-02T08:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  abschliessenFreigabe2(db, jobId);
  assert.deepEqual(listAbgeschlossenJobsForPerson(db, '5').jobs.map((j) => j.id), [jobId]);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/freigabe2Umleitung.test.js`
Expected: FAIL (Umleitung bleibt gesetzt; Person 5 sieht den abgeschlossenen Job nicht).

- [ ] **Step 3: Implement the repo changes**

In `src/db/jobsRepo.js`:

`abschliessenFreigabe2` — SQL ersetzen:

```js
      "UPDATE jobs SET status = 'abgeschlossen', abgeschlossen_am = ?, freigabe2_eskaliert_von = NULL, freigabe2_eskalationsgrund = NULL, freigabe2_eskaliert_an_admin = 0, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status = 'freigabe2'"
```

`ablehnenJob` — SQL ersetzen:

```js
      "UPDATE jobs SET status = 'abgelehnt', abgelehnt_von = ?, ablehnungsgrund = ?, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status IN ('freigabe2', 'zugewiesen')"
```

`eskalierenFreigabe2AnAdmin` — SQL ersetzen:

```js
    'UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_eskaliert_von = ?, freigabe2_eskalationsgrund = ?, freigabe2_umgeleitet_an = NULL WHERE id = ?'
```

`forceEskalierenFreigabe2AnAdmin` — SQL ersetzen:

```js
    .prepare("UPDATE jobs SET freigabe2_eskaliert_an_admin = 1, freigabe2_umgeleitet_an = NULL WHERE id = ? AND status = 'freigabe2' AND freigabe2_eskaliert_an_admin = 0")
```

`releaseJob`, `sendJobBackToGroup`, `forceReleaseJob` — jeweils in der `SET`-Liste direkt nach `freigabe2_eskaliert_an_admin = 0,` ergänzen:

```sql
           freigabe2_umgeleitet_an = NULL,
```

`listAbgeschlossenJobsForPerson` — `where`/`params` aus Task 3 erweitern:

```js
  // Die dritte Bedingung deckt die Person ab, die Freigabe 2 tatsächlich erteilt hat: nach einer
  // Admin-Umleitung ist freigabe2_umgeleitet_an beim Abschluss bereits wieder gelöscht.
  const where = `WHERE jobs.status IN ('abgeschlossen', 'abgeholt', 'archiviert')
         AND jobs.freigabe2_eskaliert_an_admin = 0
         AND (
           jobs.zugewiesen_an = ?
           OR ${EFFEKTIVER_FREIGEBER2_SQL} = ?
           OR EXISTS (SELECT 1 FROM freigaben f WHERE f.job_id = jobs.id AND f.rolle = 'freigeber2' AND f.person_id = ?)
         )`;
  const params = [personId, personId, personId];
```

- [ ] **Step 4: Run unit test**

Run: `node --test test/unit/freigabe2Umleitung.test.js` → PASS.

- [ ] **Step 5: Write the failing integration test**

Create `test/integration/freigabe2Umleitung.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { loadCurrentPerson, requireLogin } from '../../src/middleware/roles.js';
import { loadNavFlags } from '../../src/middleware/nav.js';
import { createFreigabe2Router } from '../../src/routes/freigabe2.js';

function buildApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', new URL('../../views', import.meta.url).pathname);
  app.use((req, res, next) => {
    res.locals.branding = { primaryColor: '#000', secondaryColor: '#fff', hasLogo: false, themeAttr: null };
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { personId: req.headers['x-test-person-id'] };
    next();
  });
  const config = {
    tsaTrustRequired: false,
    churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' },
    downloadSigningSecret: 'test-secret',
    publicBaseUrl: 'https://portal.example.org',
  };
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, config));
  app.use('/freigabe2', requireLogin(), createFreigabe2Router({ db, config, mailer: { async sendMail() {} } }));
  return app;
}

function seed(db) {
  for (const id of ['1', '2', '3', '4', '5']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: true });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T08:30:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  db.prepare("UPDATE jobs SET status = 'freigabe2', konto_id = ?, zugewiesen_an = '1', freigabe2_umgeleitet_an = '5' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

test('umgeleitete Person darf Freigabe 2 öffnen, der ursprüngliche Freigeber 2 nicht', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = seed(db);
  const app = buildApp(db);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '5')).status, 200);
  assert.equal((await request(app).get(`/freigabe2/${jobId}`).set('x-test-person-id', '3')).status, 403);
  db.close();
});

test('Interessenskonflikt der umgeleiteten Person geht direkt an die Admin-Gruppe und löscht die Umleitung', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const jobId = seed(db);
  const app = buildApp(db);
  const res = await request(app)
    .post(`/freigabe2/${jobId}`)
    .set('x-test-person-id', '5')
    .type('form')
    .send({ aktion: 'freigeben', interessenskonflikt: 'ja', begruendung: 'Eigene Firma' });
  assert.equal(res.status, 302);
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_eskaliert_an_admin, 1);
  assert.equal(job.freigabe2_umgeleitet_an, null);
  db.close();
});
```

- [ ] **Step 6: Run to verify the conflict test fails**

Run: `node --test test/integration/freigabe2Umleitung.test.js`
Expected: erster Test PASS (Task 3), zweiter FAIL (`freigabe2_eskaliert_an_admin` ist 0 — der Job ging an Stellvertreter 2).

- [ ] **Step 7: Implement the conflict rule**

In `src/routes/freigabe2.js` im Konflikt-Zweig die Zeile `const eskaliertAnAdmin = Boolean(job.freigabe2_eskaliert_von);` ersetzen:

```js
        // Eine vom Admin umgeleitete Person, die selbst einen Konflikt erklärt, geht direkt an die
        // Admin-Gruppe: der Admin hat die reguläre Kette (Freigeber2/Stellvertreter2) bewusst
        // übergangen, ein Rücksprung dorthin wäre unklar. eskalierenFreigabe2AnAdmin löscht die
        // Umleitung.
        const eskaliertAnAdmin = Boolean(job.freigabe2_eskaliert_von) || Boolean(job.freigabe2_umgeleitet_an);
```

- [ ] **Step 8: Run tests**

Run: `node --test test/integration/freigabe2Umleitung.test.js test/unit/freigabe2Umleitung.test.js` → PASS. Run: `npm test` → alle grün.

- [ ] **Step 9: Commit**

```bash
git add src/db/jobsRepo.js src/routes/freigabe2.js test/unit/freigabe2Umleitung.test.js test/integration/freigabe2Umleitung.test.js
git commit -m "feat(freigabe2): Umleitung endet mit Abschluss/Ablehnung, Konflikt geht an Admin-Gruppe"
```

---

### Task 5: Zuständigkeit und Umhängen-Service

**Files:**
- Create: `src/services/vorgangZustaendigkeit.js`
- Create: `src/services/vorgangUmhaengen.js`
- Modify: `src/db/jobsRepo.js` (neue Funktion `adminUmhaengen`)
- Test: `test/unit/vorgangUmhaengen.test.js` (neu)

**Interfaces:**
- Consumes: `createFreigabe` mit `vorherZustaendig`/`zielPersonId` (Task 1); Mail-Typ `admin-umzuweisung` (Task 2); `getEffectiveFreigeber2Id` (Task 3).
- Produces (`vorgangZustaendigkeit.js`):
  - `LAUFENDE_STATUS = ['unzugewiesen', 'zugewiesen', 'freigabe2', 'abgelehnt']`
  - `ermittleZustaendigkeit(db, job) → { art: 'pool'|'admin'|'person'|'keine', personId: string|null }`
  - `standToken(job, zustaendigkeit) → string` (z. B. `"freigabe2|person|3"`)
- Produces (`jobsRepo.js`): `adminUmhaengen(db, jobId, { status, zielId }) → boolean`
- Produces (`vorgangUmhaengen.js`):
  - `istUmhaengbar(job) → boolean`
  - `listUmhaengenZiele(db, job) → Person[]`
  - `async umhaengeVorgang(db, config, mailer, { jobId, zielId, bemerkung, standErwartet, admin, ip }) → { ok: true } | { fehler: 'phase'|'stand'|'ziel' }`
  - `MIN_BEMERKUNG_LAENGE = 10`

- [ ] **Step 1: Write the failing test**

Create `test/unit/vorgangUmhaengen.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, setFerienmodus } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createFreigabe, listFreigabenByJob } from '../../src/db/freigabenRepo.js';
import { listMailLog } from '../../src/db/mailLogRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { ermittleZustaendigkeit, standToken } from '../../src/services/vorgangZustaendigkeit.js';
import { listUmhaengenZiele, umhaengeVorgang } from '../../src/services/vorgangUmhaengen.js';

const CONFIG = { publicBaseUrl: 'https://portal.example.org', churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };
const MAILER = { async sendMail() {} };

function seed(db) {
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  upsertPerson(db, { id: '99', vorname: 'Ad', nachname: 'Min', email: 'admin@example.org', gruppen: ['20'], loggedInNow: false });
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'U', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  // Zweites Konto, damit 5, 6 und 7 eine Konto-Rolle haben und als Ziel wählbar sind.
  createKonto(db, { kontonummer: '4000', bezeichnung: 'V', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '1' });
  return kontoId;
}

function neuerJob(db, { status, kontoId = null, zugewiesenAn = null, quelle = 'scanner', extra = {} }) {
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'a.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare('UPDATE jobs SET status = ?, konto_id = ?, zugewiesen_an = ?, quelle = ? WHERE id = ?').run(status, kontoId, zugewiesenAn, quelle, jobId);
  for (const [spalte, wert] of Object.entries(extra)) db.prepare(`UPDATE jobs SET ${spalte} = ? WHERE id = ?`).run(wert, jobId);
  return jobId;
}

function admin(db) {
  return db.prepare("SELECT * FROM personen WHERE churchtools_person_id = '99'").get();
}

async function haenge(db, jobId, zielId, bemerkung = 'Urlaubsvertretung geklärt') {
  const job = getJobById(db, jobId);
  return umhaengeVorgang(db, CONFIG, MAILER, {
    jobId, zielId, bemerkung, standErwartet: standToken(job, ermittleZustaendigkeit(db, job)),
    admin: { ...admin(db), gruppen: ['20'] }, ip: '127.0.0.1',
  });
}

test('ermittleZustaendigkeit: Pool, Person, Admin-Gruppe, Freigabe 2 mit Umleitung', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'unzugewiesen' }))), { art: 'pool', personId: null });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'zugewiesen', zugewiesenAn: '1' }))), { art: 'person', personId: '1' });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'zugewiesen', zugewiesenAn: '1', extra: { freigabe1_eskaliert_an_admin: 1 } }))), { art: 'admin', personId: null });
  assert.deepEqual(ermittleZustaendigkeit(db, getJobById(db, neuerJob(db, { status: 'freigabe2', kontoId, extra: { freigabe2_umgeleitet_an: '5' } }))), { art: 'person', personId: '5' });
  db.close();
});

test('Pool → zugewiesen an Zielperson, Verlaufseintrag und Mail', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const jobId = neuerJob(db, { status: 'unzugewiesen', extra: { pool_rueckgesendet_bemerkung: 'falsch', pool_rueckgesendet_von: '1', pool_rueckgesendet_am: '2026-10-01' } });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  const job = getJobById(db, jobId);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '5');
  assert.equal(job.pool_rueckgesendet_bemerkung, null);
  const eintrag = listFreigabenByJob(db, jobId).at(-1);
  assert.equal(eintrag.rolle, 'admin_umzuweisung');
  assert.equal(eintrag.person_id, '99');
  assert.equal(eintrag.ziel_person_id, '5');
  assert.equal(eintrag.vorher_zustaendig, null);
  assert.match(eintrag.kommentar, /Von Pool an P5 M: Urlaubsvertretung geklärt/);
  const mails = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung');
  assert.deepEqual(mails.map((m) => m.empfaenger), ['p5@example.org']);
  assert.match(mails[0].text, /\/kontierung\//);
  db.close();
});

test('zugewiesen → neue Person, Admin-Eskalation aufgehoben, Info-Mail an bisherige Person', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '1' });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  assert.equal(getJobById(db, jobId).konto_id, kontoId);
  assert.equal(listFreigabenByJob(db, jobId).at(-1).vorher_zustaendig, '1');
  const empfaenger = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').map((m) => m.empfaenger).sort();
  assert.deepEqual(empfaenger, ['p1@example.org', 'p5@example.org']);
  db.close();
});

test('freigabe2 → Umleitung gesetzt, Admin-Eskalation zurückgesetzt, Uhr neu gestartet', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', extra: { freigabe2_eskaliert_an_admin: 1, freigabe2_seit: '2020-01-01T00:00:00.000Z', freigabe2_reminder_gesendet_at: '2020-01-02T00:00:00.000Z' } });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1.2.3.4', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  const job = getJobById(db, jobId);
  assert.equal(job.freigabe2_umgeleitet_an, '5');
  assert.equal(job.freigabe2_eskaliert_an_admin, 0);
  assert.equal(job.freigabe2_reminder_gesendet_at, null);
  assert.ok(job.freigabe2_seit > '2026-01-01');
  db.close();
});

test('abgelehnt → zugewiesen_an neu; abgelehnte Spesen sind nicht umhängbar', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'abgelehnt', kontoId, zugewiesenAn: '1' });
  assert.deepEqual(await haenge(db, jobId, '5'), { ok: true });
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  const spesenId = neuerJob(db, { status: 'abgelehnt', kontoId, zugewiesenAn: '1', quelle: 'spesen', extra: { eingereicht_von: '6' } });
  assert.deepEqual(await haenge(db, spesenId, '5'), { fehler: 'phase' });
  db.close();
});

test('Ausschlüsse bei Freigabe 2: Freigabe-1-Person, alle F2-Konfliktmelder, Spesen-Einreicher, aktuell Zuständige', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  // Freigeber 2 (3) meldete Konflikt, danach Stellvertreter 2 (4) ebenfalls -> freigabe2_eskaliert_von zeigt nur noch auf 4.
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1', quelle: 'spesen', extra: { eingereicht_von: '6', freigabe2_eskaliert_von: '4', freigabe2_eskaliert_an_admin: 1 } });
  createFreigabe(db, { jobId, personId: '2', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  createFreigabe(db, { jobId, personId: '3', rolle: 'freigabe2_eskalation', zeitpunkt: '2026-10-01T10:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'x', eskaliertVon: null });
  createFreigabe(db, { jobId, personId: '4', rolle: 'freigabe2_eskalation', zeitpunkt: '2026-10-01T11:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'y', eskaliertVon: '3' });
  const ziele = listUmhaengenZiele(db, getJobById(db, jobId)).map((p) => p.churchtools_person_id).sort();
  assert.deepEqual(ziele, ['1', '5', '7']);
  db.close();
});

test('Ausschluss bei Kontierung: wer bei Freigabe 1 einen Konflikt erklärt hat', () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'zugewiesen', kontoId, zugewiesenAn: '2', extra: { freigabe1_eskaliert_von: '1' } });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigabe1_eskalation', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: true, kommentar: 'x', eskaliertVon: null });
  const ziele = listUmhaengenZiele(db, getJobById(db, jobId)).map((p) => p.churchtools_person_id);
  assert.ok(!ziele.includes('1'));
  assert.ok(!ziele.includes('2'));
  assert.ok(ziele.includes('3'));
  db.close();
});

test('nicht erlaubtes Ziel wird abgewiesen, nichts geschrieben', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  createFreigabe(db, { jobId, personId: '1', rolle: 'freigeber1', zeitpunkt: '2026-10-01T09:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  assert.deepEqual(await haenge(db, jobId, '1'), { fehler: 'ziel' });
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  assert.equal(listFreigabenByJob(db, jobId).length, 1);
  db.close();
});

test('veralteter Stand (inzwischen Freigabe 2 erteilt) → fehler stand, nichts geschrieben, keine Mail', async () => {
  const db = openDatabase(':memory:');
  const kontoId = seed(db);
  const jobId = neuerJob(db, { status: 'freigabe2', kontoId, zugewiesenAn: '1' });
  const job = getJobById(db, jobId);
  const standErwartet = standToken(job, ermittleZustaendigkeit(db, job));
  db.prepare("UPDATE jobs SET status = 'abgeschlossen' WHERE id = ?").run(jobId);
  const ergebnis = await umhaengeVorgang(db, CONFIG, MAILER, { jobId, zielId: '5', bemerkung: 'Urlaubsvertretung geklärt', standErwartet, admin: admin(db), ip: '1' });
  assert.deepEqual(ergebnis, { fehler: 'phase' });
  // Gleicher Status, aber andere zuständige Person:
  db.prepare("UPDATE jobs SET status = 'freigabe2', freigabe2_eskaliert_von = '3' WHERE id = ?").run(jobId);
  const ergebnis2 = await umhaengeVorgang(db, CONFIG, MAILER, { jobId, zielId: '5', bemerkung: 'Urlaubsvertretung geklärt', standErwartet, admin: admin(db), ip: '1' });
  assert.deepEqual(ergebnis2, { fehler: 'stand' });
  assert.equal(getJobById(db, jobId).freigabe2_umgeleitet_an, null);
  assert.equal(listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').length, 0);
  db.close();
});

test('Zielperson im Ferienmodus: Mail auch an die Vertretung', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const heute = new Date().toISOString().slice(0, 10);
  setFerienmodus(db, '5', { von: heute, bis: heute, stellvertreterId: '6' });
  const jobId = neuerJob(db, { status: 'unzugewiesen' });
  await haenge(db, jobId, '5');
  const empfaenger = listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').map((m) => m.empfaenger).sort();
  assert.deepEqual(empfaenger, ['p5@example.org', 'p6@example.org']);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vorgangUmhaengen.test.js`
Expected: FAIL ("Cannot find module …/vorgangZustaendigkeit.js").

- [ ] **Step 3: Implement `adminUmhaengen` in `src/db/jobsRepo.js`**

Nach `forceEskalierenFreigabe2AnAdmin` einfügen:

```js
// Admin-Eingriff (/admin/vorgaenge): übergibt einen laufenden Vorgang an zielId. Pro Phase genau
// die Felder, die die Spec nennt; die WHERE-Klausel auf den Status schützt gegen einen Wechsel
// zwischen Prüfung und Update. Prüfung von Ziel und Stand macht services/vorgangUmhaengen.js.
export function adminUmhaengen(db, jobId, { status, zielId }) {
  const jetzt = new Date().toISOString();
  const statements = {
    unzugewiesen: [
      `UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = ?,
         pool_rueckgesendet_bemerkung = NULL, pool_rueckgesendet_von = NULL, pool_rueckgesendet_am = NULL,
         reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'unzugewiesen'`,
      [zielId, jobId],
    ],
    zugewiesen: [
      `UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_an_admin = 0,
         reminder_gesendet_at = NULL, eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'zugewiesen'`,
      [zielId, jobId],
    ],
    freigabe2: [
      `UPDATE jobs SET freigabe2_umgeleitet_an = ?, freigabe2_eskaliert_an_admin = 0, freigabe2_seit = ?,
         freigabe2_reminder_gesendet_at = NULL, freigabe2_eskalation_gesendet_at = NULL
       WHERE id = ? AND status = 'freigabe2'`,
      [zielId, jetzt, jobId],
    ],
    abgelehnt: [
      `UPDATE jobs SET zugewiesen_an = ?, freigabe1_eskaliert_an_admin = 0
       WHERE id = ? AND status = 'abgelehnt' AND quelle != 'spesen'`,
      [zielId, jobId],
    ],
  };
  const eintrag = statements[status];
  if (!eintrag) return false;
  const [sql, params] = eintrag;
  return db.prepare(sql).run(...params).changes > 0;
}
```

- [ ] **Step 4: Create `src/services/vorgangZustaendigkeit.js`**

```js
import { getEffectiveFreigeber2Id } from '../db/jobsRepo.js';
import { getKontoById } from '../db/kontenRepo.js';

export const LAUFENDE_STATUS = ['unzugewiesen', 'zugewiesen', 'freigabe2', 'abgelehnt'];

// Wer muss bei diesem Job jetzt handeln? Spiegelt die Autorisierung der Workflow-Seiten
// (kontierungZugriff.js, ablehnung.js, freigabe2.js), ohne Ferienvertretung -- die kommt additiv
// dazu und ändert die Zuständigkeit nicht.
export function ermittleZustaendigkeit(db, job) {
  if (job.status === 'unzugewiesen') return { art: 'pool', personId: null };
  if (job.status === 'zugewiesen' || job.status === 'abgelehnt') {
    if (job.freigabe1_eskaliert_an_admin) return { art: 'admin', personId: null };
    return { art: 'person', personId: job.zugewiesen_an ?? null };
  }
  if (job.status === 'freigabe2') {
    if (job.freigabe2_eskaliert_an_admin) return { art: 'admin', personId: null };
    const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
    return { art: 'person', personId: konto ? getEffectiveFreigeber2Id(job, konto) : null };
  }
  return { art: 'keine', personId: null };
}

// Kompakter Fingerabdruck des Stands, den der Admin im Formular gesehen hat. Ändert sich Status
// oder zuständige Person bis zum Absenden, passt der Token nicht mehr.
export function standToken(job, zustaendigkeit) {
  return `${job.status}|${zustaendigkeit.art}|${zustaendigkeit.personId ?? ''}`;
}
```

- [ ] **Step 5: Create `src/services/vorgangUmhaengen.js`**

```js
import { getJobById, adminUmhaengen } from '../db/jobsRepo.js';
import { listPersonenMitFreigeberRolle } from '../db/kontenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { createFreigabe, listFreigabenByJob } from '../db/freigabenRepo.js';
import { reiheBenachrichtigungEin, reiheBenachrichtigungMitVertretungEin } from './notify.js';
import { stelleEintraegeZu } from './mailZustellung.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit, standToken } from './vorgangZustaendigkeit.js';

export const MIN_BEMERKUNG_LAENGE = 10;
const MAIL_TYP = 'admin-umzuweisung';

function name(person) {
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// Abgelehnte Spesen-Positionen haben keinen Überarbeiten-Weg (/abgelehnt/:id weist Spesen ab) --
// ein Umhängen würde nur einen toten Vorgang erzeugen.
export function istUmhaengbar(job) {
  if (!job || !LAUFENDE_STATUS.includes(job.status)) return false;
  if (job.status === 'abgelehnt' && job.quelle === 'spesen') return false;
  return true;
}

// Erlaubte Zielpersonen: aktive Personen mit Konto-Rolle, ohne die aktuell zuständige Person und
// ohne jeden, den das Vier-Augen-Prinzip oder ein erklärter Interessenskonflikt ausschliesst.
// Konflikte werden aus freigaben gelesen, nicht aus *_eskaliert_von: eine zweite Eskalation
// überschreibt diese Spalte, der erste Konfliktmelder bliebe sonst wählbar.
export function listUmhaengenZiele(db, job) {
  const ausgeschlossen = new Set();
  const { personId } = ermittleZustaendigkeit(db, job);
  if (personId) ausgeschlossen.add(personId);
  if (job.quelle === 'spesen' && job.eingereicht_von) ausgeschlossen.add(job.eingereicht_von);
  const freigaben = listFreigabenByJob(db, job.id);
  if (job.status === 'freigabe2') {
    const freigabe1 = freigaben.findLast((f) => f.rolle === 'freigeber1');
    if (freigabe1) ausgeschlossen.add(freigabe1.person_id);
    for (const f of freigaben) if (f.rolle === 'freigabe2_eskalation') ausgeschlossen.add(f.person_id);
  } else {
    for (const f of freigaben) if (f.rolle === 'freigabe1_eskalation') ausgeschlossen.add(f.person_id);
    if (job.freigabe1_eskaliert_von) ausgeschlossen.add(job.freigabe1_eskaliert_von);
  }
  return listPersonenMitFreigeberRolle(db).filter((p) => !ausgeschlossen.has(p.churchtools_person_id));
}

function linkNachUmhaengen(config, job) {
  const basis = config.publicBaseUrl;
  if (job.status === 'freigabe2') return `${basis}/freigabe2/${job.id}`;
  if (job.status === 'abgelehnt') return `${basis}/abgelehnt/${job.id}`;
  return job.quelle === 'spesen' ? `${basis}/spesen-freigabe1/${job.id}` : `${basis}/kontierung/${job.id}`;
}

export async function umhaengeVorgang(db, config, mailer, { jobId, zielId, bemerkung, standErwartet, admin, ip }) {
  let eintraege = [];
  db.exec('BEGIN');
  try {
    const job = getJobById(db, jobId);
    if (!istUmhaengbar(job)) {
      db.exec('ROLLBACK');
      return { fehler: 'phase' };
    }
    const vorher = ermittleZustaendigkeit(db, job);
    if (standToken(job, vorher) !== standErwartet) {
      db.exec('ROLLBACK');
      return { fehler: 'stand' };
    }
    const ziel = listUmhaengenZiele(db, job).find((p) => p.churchtools_person_id === zielId);
    if (!ziel) {
      db.exec('ROLLBACK');
      return { fehler: 'ziel' };
    }
    if (!adminUmhaengen(db, job.id, { status: job.status, zielId })) {
      db.exec('ROLLBACK');
      return { fehler: 'stand' };
    }

    const vorherPerson = vorher.personId ? getPersonById(db, vorher.personId) : null;
    const vorherText = vorher.art === 'pool' ? 'Pool' : vorher.art === 'admin' ? 'Admin-Gruppe' : name(vorherPerson);
    createFreigabe(db, {
      jobId: job.id,
      personId: admin.churchtools_person_id,
      rolle: 'admin_umzuweisung',
      zeitpunkt: new Date().toISOString(),
      ip,
      interessenskonflikt: false,
      kommentar: `Von ${vorherText} an ${name(ziel)}: ${bemerkung}`,
      eskaliertVon: null,
      vorherZustaendig: vorher.personId,
      zielPersonId: ziel.churchtools_person_id,
    });

    const jobDanach = getJobById(db, job.id);
    const gemeinsam = { jobDateiname: job.dateiname, adminName: name(admin), bemerkung };
    eintraege = reiheBenachrichtigungMitVertretungEin(db, {
      person: ziel,
      typ: MAIL_TYP,
      jobId: job.id,
      variablen: {
        ...gemeinsam,
        grund: `${name(admin)} hat dir einen Vorgang übergeben (bisher zuständig: ${vorherText}).`,
        link: linkNachUmhaengen(config, jobDanach),
      },
    });
    if (vorherPerson && vorherPerson.aktiv) {
      eintraege.push(reiheBenachrichtigungEin(db, {
        to: vorherPerson.email,
        typ: MAIL_TYP,
        jobId: job.id,
        variablen: {
          ...gemeinsam,
          empfaengerName: name(vorherPerson),
          grund: `${name(admin)} hat einen Vorgang, für den du zuständig warst, an ${name(ziel)} übergeben. Du musst dafür nichts mehr tun.`,
          link: `${config.publicBaseUrl}/pool`,
        },
      }));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Nach dem Commit zustellen: scheitert SMTP, bleibt das Umhängen gültig und mail-zustellung
  // wiederholt die eingereihten Mails.
  await stelleEintraegeZu(db, mailer, eintraege);
  return { ok: true };
}
```

- [ ] **Step 6: Run tests**

Run: `node --test test/unit/vorgangUmhaengen.test.js` → PASS. Run: `npm test` → alle grün.

- [ ] **Step 7: Commit**

```bash
git add src/db/jobsRepo.js src/services/vorgangZustaendigkeit.js src/services/vorgangUmhaengen.js test/unit/vorgangUmhaengen.test.js
git commit -m "feat: Service für Admin-Umhängen laufender Vorgänge"
```

---

### Task 6: Übersicht laufender Vorgänge

**Files:**
- Create: `src/services/vorgaengeUebersicht.js`
- Test: `test/unit/vorgaengeUebersicht.test.js` (neu)

**Interfaces:**
- Consumes: `LAUFENDE_STATUS`, `ermittleZustaendigkeit` (Task 5).
- Produces:
  - `STATUS_LABEL` (Objekt Status → Anzeige-Text)
  - `beschreibeVorgang(db, job, { jetzt = Date.now(), namen } = {}) → Vorgang`
  - `listLaufendeVorgaenge(db, filter = {}) → Vorgang[]`, `filter = { status?, art?, personId?, nurProbleme? }`
  - `Vorgang = { id, dateiname, eingangAm, seit, art, artLabel, status, statusLabel, betrag, gegenueber, kontoLabel, zustaendig: { art, personId, name, vertretungName }, prognoseF2: null | { personId, name, prognose, offen }, kennzeichen: string[], haengt, ueberfaellig }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/vorgaengeUebersicht.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson, deactivatePerson } from '../../src/db/personenRepo.js';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createKreditor } from '../../src/db/kreditorenRepo.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createFreigabe } from '../../src/db/freigabenRepo.js';
import { createJob } from '../../src/db/jobsRepo.js';
import { listLaufendeVorgaenge } from '../../src/services/vorgaengeUebersicht.js';

function seed(db) {
  seedDefaults(db);
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: [], loggedInNow: false });
  }
  const kontoA = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  const kontoB = createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '8' });
  return { kontoA, kontoB };
}

function job(db, felder) {
  const id = createJob(db, { eingangAm: felder.eingang_am ?? '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: `${felder.name}.pdf`, pdfPfad: '/tmp/x.pdf' });
  for (const [spalte, wert] of Object.entries(felder)) {
    if (spalte === 'name' || spalte === 'eingang_am') continue;
    db.prepare(`UPDATE jobs SET ${spalte} = ? WHERE id = ?`).run(wert, id);
  }
  return id;
}

test('listet nur laufende Status, älteste zuerst', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  job(db, { name: 'neu', status: 'unzugewiesen', eingang_am: '2026-10-05T08:00:00.000Z' });
  job(db, { name: 'alt', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA, eingang_am: '2026-09-01T08:00:00.000Z' });
  job(db, { name: 'fertig', status: 'abgeschlossen', konto_id: kontoA });
  job(db, { name: 'eltern', status: 'aufgesplittet' });
  job(db, { name: 'weg', status: 'geloescht' });
  assert.deepEqual(listLaufendeVorgaenge(db).map((v) => v.dateiname), ['alt.pdf', 'neu.pdf']);
  db.close();
});

test('Zuständigkeit und Prognose Freigabe 2: Konto, Kreditor-Default, Hinweis-Konto, offen, Stellvertreter 2 nach Konflikt', () => {
  const db = openDatabase(':memory:');
  const { kontoA, kontoB } = seed(db);
  const kreditorId = createKreditor(db, { name: 'Muster AG', kontoId: kontoB });
  job(db, { name: 'konto', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA });
  job(db, { name: 'kreditor', status: 'zugewiesen', zugewiesen_an: '1', kreditor_id: kreditorId });
  job(db, { name: 'hinweis', status: 'unzugewiesen', hinweis_konto_id: kontoA });
  job(db, { name: 'offen', status: 'unzugewiesen' });
  job(db, { name: 'konflikt', status: 'abgelehnt', zugewiesen_an: '1', konto_id: kontoA, freigabe2_eskaliert_von: '3' });
  job(db, { name: 'f2', status: 'freigabe2', zugewiesen_an: '1', konto_id: kontoA, freigabe2_umgeleitet_an: '7' });
  const v = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));

  assert.equal(v['konto.pdf'].zustaendig.name, 'P1 M');
  assert.deepEqual([v['konto.pdf'].prognoseF2.name, v['konto.pdf'].prognoseF2.prognose], ['P3 M', false]);
  assert.deepEqual([v['kreditor.pdf'].prognoseF2.name, v['kreditor.pdf'].prognoseF2.prognose], ['P7 M', true]);
  assert.equal(v['hinweis.pdf'].zustaendig.art, 'pool');
  assert.deepEqual([v['hinweis.pdf'].prognoseF2.name, v['hinweis.pdf'].prognoseF2.prognose], ['P3 M', true]);
  assert.equal(v['offen.pdf'].prognoseF2.offen, true);
  assert.equal(v['konflikt.pdf'].prognoseF2.name, 'P4 M');
  assert.equal(v['f2.pdf'].prognoseF2, null);
  assert.equal(v['f2.pdf'].zustaendig.name, 'P7 M');
  assert.ok(v['f2.pdf'].kennzeichen.includes('umgeleitet'));
  db.close();
});

test('Kennzeichen hängt und überfällig; Filter nurProbleme, status, art, personId', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  deactivatePerson(db, '2', 'churchtools_geloescht');
  job(db, { name: 'haengt', status: 'zugewiesen', zugewiesen_an: '2', konto_id: kontoA });
  job(db, { name: 'ueberfaellig', status: 'freigabe2', konto_id: kontoA, freigabe2_seit: '2020-01-01T00:00:00.000Z' });
  job(db, { name: 'ok', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA, typ: 'gutschrift' });
  const alle = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));
  assert.equal(alle['haengt.pdf'].haengt, true);
  assert.equal(alle['ueberfaellig.pdf'].ueberfaellig, true);
  assert.equal(alle['ok.pdf'].artLabel, 'Gutschrift');

  assert.deepEqual(listLaufendeVorgaenge(db, { nurProbleme: true }).map((x) => x.dateiname).sort(), ['haengt.pdf', 'ueberfaellig.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { status: 'freigabe2' }).map((x) => x.dateiname), ['ueberfaellig.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { art: 'gutschrift' }).map((x) => x.dateiname), ['ok.pdf']);
  assert.deepEqual(listLaufendeVorgaenge(db, { personId: '1' }).map((x) => x.dateiname), ['ok.pdf']);
  db.close();
});

test('seit: Freigabe 2 nimmt freigabe2_seit, Kontierung den letzten Verlaufseintrag', () => {
  const db = openDatabase(':memory:');
  const { kontoA } = seed(db);
  const id = job(db, { name: 'k', status: 'zugewiesen', zugewiesen_an: '1', konto_id: kontoA });
  createFreigabe(db, { jobId: id, personId: '1', rolle: 'pool_zuweisung', zeitpunkt: '2026-10-03T08:00:00.000Z', ip: '1', interessenskonflikt: false, kommentar: null, eskaliertVon: null });
  job(db, { name: 'f', status: 'freigabe2', konto_id: kontoA, freigabe2_seit: '2026-10-04T08:00:00.000Z' });
  const v = Object.fromEntries(listLaufendeVorgaenge(db).map((x) => [x.dateiname, x]));
  assert.equal(v['k.pdf'].seit, '2026-10-03T08:00:00.000Z');
  assert.equal(v['f.pdf'].seit, '2026-10-04T08:00:00.000Z');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/vorgaengeUebersicht.test.js`
Expected: FAIL ("Cannot find module …/vorgaengeUebersicht.js").

- [ ] **Step 3: Create `src/services/vorgaengeUebersicht.js`**

```js
import { getKontoById } from '../db/kontenRepo.js';
import { getKreditorById } from '../db/kreditorenRepo.js';
import { getPersonById } from '../db/personenRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { listFreigabenByJob } from '../db/freigabenRepo.js';
import { getAktivenVertreter } from './vertretung.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit } from './vorgangZustaendigkeit.js';

export const STATUS_LABEL = {
  unzugewiesen: 'Pool',
  zugewiesen: 'Kontierung / Freigabe 1',
  freigabe2: 'Freigabe 2',
  abgelehnt: 'Abgelehnt',
};

const ART_LABEL = { rechnung: 'Rechnung', gutschrift: 'Gutschrift', spesen: 'Spesen' };
const STUNDE_MS = 60 * 60 * 1000;

function artVon(job) {
  if (job.quelle === 'spesen') return 'spesen';
  return job.typ === 'gutschrift' ? 'gutschrift' : 'rechnung';
}

// Ein Namens-Cache pro Request: die Liste löst dieselben Personen oft dutzendfach auf.
function namensAufloeser(db) {
  const cache = new Map();
  return (personId) => {
    if (!personId) return null;
    if (!cache.has(personId)) cache.set(personId, getPersonById(db, personId));
    return cache.get(personId);
  };
}

function anzeigeName(person) {
  return person ? `${person.vorname} ${person.nachname}` : 'Unbekannt';
}

// Freigeber 2 des ersten vorhandenen Kontos: konto_id, sonst Default-Konto des Kreditors, sonst
// Hinweis-Konto. Nur das eigene Konto ist sicher, alles andere ist eine Prognose.
function prognoseFreigabe2(db, job, person) {
  if (job.status === 'freigabe2') return null;
  const kandidaten = [
    { kontoId: job.konto_id, prognose: false },
    { kontoId: job.kreditor_id ? getKreditorById(db, job.kreditor_id)?.konto_id : null, prognose: true },
    { kontoId: job.hinweis_konto_id, prognose: true },
  ];
  for (const { kontoId, prognose } of kandidaten) {
    const konto = kontoId ? getKontoById(db, kontoId) : null;
    if (!konto) continue;
    const spesenSelbst = job.quelle === 'spesen' && konto.freigeber2_id === job.eingereicht_von;
    const personId = job.freigabe2_eskaliert_von || spesenSelbst ? konto.stellvertreter2_id : konto.freigeber2_id;
    return { personId, name: anzeigeName(person(personId)), prognose, offen: false };
  }
  return { personId: null, name: null, prognose: true, offen: true };
}

function seitWann(db, job) {
  if (job.status === 'freigabe2' && job.freigabe2_seit) return job.freigabe2_seit;
  if (job.status === 'unzugewiesen') return job.pool_rueckgesendet_am || job.eingang_am;
  const letzter = listFreigabenByJob(db, job.id).at(-1);
  return letzter ? letzter.zeitpunkt : job.eingang_am;
}

function istUeberfaellig(db, job, jetzt) {
  if (job.status === 'unzugewiesen') {
    const stunden = Number(getConfigValue(db, 'reminder_stunden'));
    return Boolean(stunden) && Date.parse(job.eingang_am) < jetzt - stunden * STUNDE_MS;
  }
  if (job.status === 'freigabe2' && job.freigabe2_seit) {
    const stunden = Number(getConfigValue(db, 'freigabe2_reminder_stunden'));
    return Boolean(stunden) && Date.parse(job.freigabe2_seit) < jetzt - stunden * STUNDE_MS;
  }
  return false;
}

function kennzeichenVon(job) {
  const liste = [];
  if (job.status === 'unzugewiesen' && job.pool_rueckgesendet_bemerkung) liste.push('Rückläufer');
  if ((job.status === 'freigabe2' && job.freigabe2_eskaliert_an_admin) || (job.status !== 'freigabe2' && job.freigabe1_eskaliert_an_admin)) liste.push('Admin-Eskalation');
  if ((job.status === 'freigabe2' && job.freigabe2_eskaliert_von) || (job.status === 'zugewiesen' && job.freigabe1_eskaliert_von)) liste.push('Interessenskonflikt');
  if (job.status === 'freigabe2' && job.freigabe2_umgeleitet_an) liste.push('umgeleitet');
  return liste;
}

export function beschreibeVorgang(db, job, { jetzt = Date.now(), namen = namensAufloeser(db) } = {}) {
  const zust = ermittleZustaendigkeit(db, job);
  const zustaendigPerson = namen(zust.personId);
  const vertreterId = zust.personId ? getAktivenVertreter(db, zust.personId) : null;
  const konto = job.konto_id ? getKontoById(db, job.konto_id) : null;
  const art = artVon(job);
  const zustaendigName =
    zust.art === 'pool' ? (job.pool_rueckgesendet_bemerkung ? 'Pool – Rückläufer' : 'Pool')
      : zust.art === 'admin' ? 'Admin-Gruppe'
        : anzeigeName(zustaendigPerson);
  return {
    id: job.id,
    dateiname: job.dateiname,
    eingangAm: job.eingang_am,
    seit: seitWann(db, job),
    art,
    artLabel: ART_LABEL[art],
    status: job.status,
    statusLabel: STATUS_LABEL[job.status] || job.status,
    betrag: job.betrag,
    gegenueber: art === 'spesen' ? anzeigeName(namen(job.eingereicht_von)) : job.lieferant || job.absender || '—',
    kontoLabel: konto ? `${konto.kontonummer} ${konto.bezeichnung}` : '—',
    zustaendig: { art: zust.art, personId: zust.personId, name: zustaendigName, vertretungName: vertreterId ? anzeigeName(namen(vertreterId)) : null },
    prognoseF2: prognoseFreigabe2(db, job, namen),
    kennzeichen: kennzeichenVon(job),
    haengt: zust.art === 'person' && (!zustaendigPerson || !zustaendigPerson.aktiv || Boolean(zustaendigPerson.ct_person_unresolved)),
    ueberfaellig: istUeberfaellig(db, job, jetzt),
  };
}

export function listLaufendeVorgaenge(db, filter = {}) {
  const platzhalter = LAUFENDE_STATUS.map(() => '?').join(', ');
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN (${platzhalter}) ORDER BY eingang_am, id`).all(...LAUFENDE_STATUS);
  const kontext = { jetzt: Date.now(), namen: namensAufloeser(db) };
  return jobs
    .map((job) => beschreibeVorgang(db, job, kontext))
    .filter((v) => !filter.status || v.status === filter.status)
    .filter((v) => !filter.art || v.art === filter.art)
    .filter((v) => !filter.personId || v.zustaendig.personId === filter.personId)
    .filter((v) => !filter.nurProbleme || v.haengt || v.ueberfaellig);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/unit/vorgaengeUebersicht.test.js` → PASS. Run: `npm test` → alle grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/vorgaengeUebersicht.js test/unit/vorgaengeUebersicht.test.js
git commit -m "feat: Übersicht laufender Vorgänge mit Zuständigkeit und F2-Prognose"
```

---

### Task 7: Admin-Seiten, Einbindung und Sweeps

**Files:**
- Create: `src/routes/admin/vorgaenge.js`
- Create: `views/admin/vorgaenge-liste.ejs`, `views/admin/vorgang-detail.ejs`
- Modify: `src/app.js` (Import + Mount nach `/admin/abgelehnt`)
- Modify: `src/middleware/nav.js` (`adminNav.vorgaenge`)
- Modify: `views/admin/_nav.ejs`, `views/admin/dashboard.ejs`
- Modify: `test/integration/admin/authz-sweep.test.js`, `test/integration/csrfSweep.test.js`, `test/unit/nav.test.js`
- Test: `test/integration/admin/vorgaenge.test.js` (neu)

**Interfaces:**
- Consumes: `listLaufendeVorgaenge`, `beschreibeVorgang`, `STATUS_LABEL` (Task 6); `ermittleZustaendigkeit`, `standToken`, `LAUFENDE_STATUS` (Task 5); `listUmhaengenZiele`, `umhaengeVorgang`, `istUmhaengbar`, `MIN_BEMERKUNG_LAENGE` (Task 5).
- Produces: `createVorgaengeRouter({ db, config, mailer, csrfProtection })`; Routen `GET /admin/vorgaenge`, `GET /admin/vorgaenge/:id`, `POST /admin/vorgaenge/:id/umhaengen`.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/admin/vorgaenge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { createKonto } from '../../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../../src/db/jobsRepo.js';
import { listFreigabenByJob } from '../../../src/db/freigabenRepo.js';
import { listMailLog } from '../../../src/db/mailLogRepo.js';
import { seedDefaults } from '../../../src/db/adminConfigRepo.js';
import { setBerechtigungenForPerson } from '../../../src/db/personBerechtigungenRepo.js';
import { loadCurrentPerson } from '../../../src/middleware/roles.js';
import { loadNavFlags } from '../../../src/middleware/nav.js';
import { requirePermission } from '../../../src/middleware/permissions.js';
import { createVorgaengeRouter } from '../../../src/routes/admin/vorgaenge.js';

const CONFIG = {
  churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20', groupIdManager: '30' },
  publicBaseUrl: 'https://portal.example.org',
  downloadSigningSecret: 'test-secret',
};

function buildApp(db) {
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
  app.use(loadCurrentPerson(db));
  app.use(loadNavFlags(db, CONFIG));
  app.use('/admin/vorgaenge', requirePermission(db, CONFIG, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config: CONFIG, mailer: { async sendMail() {} } }));
  return app;
}

function seed(db) {
  seedDefaults(db);
  upsertPerson(db, { id: '99', vorname: 'Admina', nachname: 'Portal', email: 'admin@example.org', gruppen: ['20'], loggedInNow: true });
  upsertPerson(db, { id: '55', vorname: 'Mana', nachname: 'Ger', email: 'manager@example.org', gruppen: ['30'], loggedInNow: true });
  upsertPerson(db, { id: '77', vorname: 'Nur', nachname: 'Buchhaltung', email: 'b@example.org', gruppen: ['10'], loggedInNow: true });
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    upsertPerson(db, { id, vorname: `P${id}`, nachname: 'M', email: `p${id}@example.org`, gruppen: ['10'], loggedInNow: false });
  }
  const kontoId = createKonto(db, { kontonummer: '3000', bezeichnung: 'Unterhalt', freigeber1Id: '1', stellvertreter1Id: '2', freigeber2Id: '3', stellvertreter2Id: '4' });
  createKonto(db, { kontonummer: '4000', bezeichnung: 'Jugend', freigeber1Id: '5', stellvertreter1Id: '6', freigeber2Id: '7', stellvertreter2Id: '8' });
  const jobId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'rechnung.pdf', pdfPfad: '/tmp/a.pdf' });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = '1', konto_id = ?, lieferant = 'Muster AG' WHERE id = ?").run(kontoId, jobId);
  return jobId;
}

function stand(text) {
  return text.match(/name="stand" value="([^"]+)"/)[1];
}

test('Liste: 401 ohne Session, 403 ohne Recht, 200 für Manager und Admin mit zuständiger Person und Prognose', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const app = buildApp(db);
  assert.equal((await request(app).get('/admin/vorgaenge')).status, 401);
  assert.equal((await request(app).get('/admin/vorgaenge').set('x-test-person-id', '77')).status, 403);
  const res = await request(app).get('/admin/vorgaenge').set('x-test-person-id', '55');
  assert.equal(res.status, 200);
  assert.match(res.text, /rechnung\.pdf/);
  assert.match(res.text, /P1 M/);
  assert.match(res.text, /P3 M/);
  assert.doesNotMatch(res.text, />Umhängen</);
  const resAdmin = await request(app).get('/admin/vorgaenge').set('x-test-person-id', '99');
  assert.match(resAdmin.text, />Umhängen</);
  db.close();
});

test('Einzelrecht vorgaenge_einsehen reicht zum Ansehen', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  setBerechtigungenForPerson(db, '77', ['vorgaenge_einsehen']);
  const app = buildApp(db);
  assert.equal((await request(app).get('/admin/vorgaenge').set('x-test-person-id', '77')).status, 200);
  db.close();
});

test('Detail: Manager sieht Verlauf ohne Formular; Admin sieht Formular mit erlaubten Zielen', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  const app = buildApp(db);
  const manager = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '55');
  assert.equal(manager.status, 200);
  assert.doesNotMatch(manager.text, /name="zielId"/);
  const adminRes = await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99');
  assert.match(adminRes.text, /name="zielId"/);
  assert.match(adminRes.text, /value="5"/);
  assert.doesNotMatch(adminRes.text, /<option value="1"/);
  assert.equal((await request(app).get('/admin/vorgaenge/99999').set('x-test-person-id', '99')).status, 404);
  db.close();
});

test('POST umhaengen: Manager 403, fehlende Bemerkung 422, Erfolg schreibt Verlauf und Mails', async () => {
  const db = openDatabase(':memory:');
  const jobId = seed(db);
  const app = buildApp(db);
  const token = stand((await request(app).get(`/admin/vorgaenge/${jobId}`).set('x-test-person-id', '99')).text);

  const manager = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '55').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(manager.status, 403);

  const ohneBemerkung = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'kurz', bestaetigung: 'ja', stand: token });
  assert.equal(ohneBemerkung.status, 422);
  assert.equal(getJobById(db, jobId).zugewiesen_an, '1');

  const falschesZiel = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '1', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(falschesZiel.status, 422);

  const ok = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, `/admin/vorgaenge/${jobId}?umgehaengt=1`);
  assert.equal(getJobById(db, jobId).zugewiesen_an, '5');
  assert.equal(listFreigabenByJob(db, jobId).at(-1).rolle, 'admin_umzuweisung');
  assert.equal(listMailLog(db).filter((m) => m.typ === 'admin-umzuweisung').length, 2);

  const nochmal = await request(app).post(`/admin/vorgaenge/${jobId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '6', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: token });
  assert.equal(nochmal.status, 409);
  db.close();
});

test('abgelehnte Spesen-Position: Detail zeigt kein Formular, POST liefert 404', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  const spesenId = createJob(db, { eingangAm: '2026-10-01T08:00:00.000Z', quelle: 'scanner', absender: null, dateiname: 'spesen.pdf', pdfPfad: '/tmp/s.pdf' });
  db.prepare("UPDATE jobs SET status = 'abgelehnt', quelle = 'spesen', zugewiesen_an = '1', eingereicht_von = '6' WHERE id = ?").run(spesenId);
  const app = buildApp(db);
  const detail = await request(app).get(`/admin/vorgaenge/${spesenId}`).set('x-test-person-id', '99');
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.text, /name="zielId"/);
  const post = await request(app).post(`/admin/vorgaenge/${spesenId}/umhaengen`).set('x-test-person-id', '99').type('form')
    .send({ zielId: '5', bemerkung: 'Zuständigkeit geklärt', bestaetigung: 'ja', stand: 'egal' });
  assert.equal(post.status, 404);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration/admin/vorgaenge.test.js`
Expected: FAIL ("Cannot find module …/routes/admin/vorgaenge.js").

- [ ] **Step 3: Create `src/routes/admin/vorgaenge.js`**

```js
import { Router } from 'express';
import { getJobById } from '../../db/jobsRepo.js';
import { getKontoById } from '../../db/kontenRepo.js';
import { getPersonById } from '../../db/personenRepo.js';
import { getConfigValue } from '../../db/adminConfigRepo.js';
import { personHasPermission, requirePermission } from '../../middleware/permissions.js';
import { buildAuditLog } from '../../services/auditLog.js';
import { canViewJobPdf } from '../../services/jobAuthorization.js';
import { buildSignedDownloadUrl, PDF_PREVIEW_TTL_SECONDS } from '../../services/downloadUrl.js';
import { listLaufendeVorgaenge, beschreibeVorgang, STATUS_LABEL } from '../../services/vorgaengeUebersicht.js';
import { LAUFENDE_STATUS, ermittleZustaendigkeit, standToken } from '../../services/vorgangZustaendigkeit.js';
import { listUmhaengenZiele, umhaengeVorgang, istUmhaengbar, MIN_BEMERKUNG_LAENGE } from '../../services/vorgangUmhaengen.js';

const NICHT_LAUFEND = 'Dieser Vorgang existiert nicht oder ist nicht (mehr) in Bearbeitung.';

export function createVorgaengeRouter({ db, config, mailer, csrfProtection = (req, res, next) => next() }) {
  const router = Router();

  function kannEingreifen(req) {
    return personHasPermission(db, config, req.currentPerson, 'workflow_eingreifen');
  }

  function ladeLaufendenJob(id) {
    const job = getJobById(db, Number(id));
    return job && LAUFENDE_STATUS.includes(job.status) ? job : null;
  }

  // Hinweis bei aktiver strikter Freigeber1-Prüfung: der Admin-Eingriff hebelt sie nicht aus.
  function strikteHinweisPerson(job) {
    if (job.status !== 'zugewiesen' || !job.konto_id) return null;
    if (getConfigValue(db, 'kontierung_strikte_freigeber1_pruefung') !== '1') return null;
    const konto = getKontoById(db, job.konto_id);
    const id = konto ? (job.freigabe1_eskaliert_von ? konto.stellvertreter1_id : konto.freigeber1_id) : null;
    const person = id ? getPersonById(db, id) : null;
    return person ? `${person.vorname} ${person.nachname}` : null;
  }

  function renderDetail(req, res, status, job, { errors = [], werte = {}, umgehaengt = false } = {}) {
    const darfEingreifen = kannEingreifen(req) && istUmhaengbar(job);
    res.status(status).render('admin/vorgang-detail', {
      vorgang: beschreibeVorgang(db, job),
      auditLog: buildAuditLog(db, job.id),
      pdfUrl: canViewJobPdf(db, config, req.currentPerson, job) ? buildSignedDownloadUrl(config, job.id, PDF_PREVIEW_TTL_SECONDS) : null,
      darfEingreifen,
      ziele: darfEingreifen ? listUmhaengenZiele(db, job) : [],
      stand: standToken(job, ermittleZustaendigkeit(db, job)),
      strikterFreigeber1: darfEingreifen ? strikteHinweisPerson(job) : null,
      minBemerkung: MIN_BEMERKUNG_LAENGE,
      errors,
      werte: { zielId: '', bemerkung: '', ...werte },
      umgehaengt,
    });
  }

  router.get('/', (req, res) => {
    const filter = {
      status: LAUFENDE_STATUS.includes(req.query.status) ? req.query.status : '',
      art: ['rechnung', 'gutschrift', 'spesen'].includes(req.query.art) ? req.query.art : '',
      personId: typeof req.query.person === 'string' ? req.query.person : '',
      nurProbleme: req.query.probleme === '1',
    };
    const alle = listLaufendeVorgaenge(db);
    const personen = [...new Map(alle.filter((v) => v.zustaendig.personId).map((v) => [v.zustaendig.personId, v.zustaendig.name])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    res.render('admin/vorgaenge-liste', {
      vorgaenge: listLaufendeVorgaenge(db, filter),
      filter,
      personen,
      statusLabel: STATUS_LABEL,
      darfEingreifen: kannEingreifen(req),
    });
  });

  router.get('/:id', (req, res) => {
    const job = ladeLaufendenJob(req.params.id);
    if (!job) return res.status(404).render('error', { message: NICHT_LAUFEND });
    renderDetail(req, res, 200, job, { umgehaengt: req.query.umgehaengt === '1' });
  });

  router.post('/:id/umhaengen', requirePermission(db, config, 'workflow_eingreifen'), csrfProtection, async (req, res, next) => {
    try {
      const job = ladeLaufendenJob(req.params.id);
      if (!job || !istUmhaengbar(job)) return res.status(404).render('error', { message: NICHT_LAUFEND });
      const zielId = typeof req.body.zielId === 'string' ? req.body.zielId : '';
      const bemerkung = typeof req.body.bemerkung === 'string' ? req.body.bemerkung.trim() : '';
      const werte = { zielId, bemerkung };
      const errors = [];
      if (bemerkung.length < MIN_BEMERKUNG_LAENGE) errors.push(`Bitte eine Bemerkung mit mindestens ${MIN_BEMERKUNG_LAENGE} Zeichen angeben.`);
      if (req.body.bestaetigung !== 'ja') errors.push('Bitte das Umhängen bestätigen.');
      if (!zielId) errors.push('Bitte eine Zielperson auswählen.');
      if (errors.length) return renderDetail(req, res, 422, job, { errors, werte });

      const ergebnis = await umhaengeVorgang(db, config, mailer, {
        jobId: job.id,
        zielId,
        bemerkung,
        standErwartet: typeof req.body.stand === 'string' ? req.body.stand : '',
        admin: req.currentPerson,
        ip: req.ip,
      });
      if (ergebnis.ok) return res.redirect(`/admin/vorgaenge/${job.id}?umgehaengt=1`);

      const aktuell = ladeLaufendenJob(job.id);
      if (ergebnis.fehler === 'phase' || !aktuell) return res.status(404).render('error', { message: NICHT_LAUFEND });
      if (ergebnis.fehler === 'ziel') return renderDetail(req, res, 422, aktuell, { errors: ['Diese Person kann den Vorgang nicht übernehmen. Bitte eine Person aus der Liste wählen.'], werte });
      return renderDetail(req, res, 409, aktuell, { errors: ['Der Vorgang hat sich inzwischen geändert. Bitte den aktuellen Stand prüfen und erneut umhängen.'], werte: { bemerkung } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Create `views/admin/vorgaenge-liste.ejs`**

```ejs
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Laufende Vorgänge — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container-fluid py-4">
    <%- include('./_nav') %>
    <h1>Laufende Vorgänge</h1>
    <form method="get" action="/admin/vorgaenge" class="row g-2 align-items-end mb-3">
      <div class="col-auto">
        <label class="form-label" for="status">Status</label>
        <select class="form-select" id="status" name="status">
          <option value="">Alle</option>
          <% Object.entries(statusLabel).forEach(([wert, label]) => { %>
            <option value="<%= wert %>"<%= filter.status === wert ? ' selected' : '' %>><%= label %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto">
        <label class="form-label" for="art">Art</label>
        <select class="form-select" id="art" name="art">
          <option value="">Alle</option>
          <option value="rechnung"<%= filter.art === 'rechnung' ? ' selected' : '' %>>Rechnung</option>
          <option value="gutschrift"<%= filter.art === 'gutschrift' ? ' selected' : '' %>>Gutschrift</option>
          <option value="spesen"<%= filter.art === 'spesen' ? ' selected' : '' %>>Spesen</option>
        </select>
      </div>
      <div class="col-auto">
        <label class="form-label" for="person">Zuständig</label>
        <select class="form-select" id="person" name="person">
          <option value="">Alle</option>
          <% personen.forEach((p) => { %>
            <option value="<%= p.id %>"<%= filter.personId === p.id ? ' selected' : '' %>><%= p.name %></option>
          <% }) %>
        </select>
      </div>
      <div class="col-auto form-check ms-2">
        <input class="form-check-input" type="checkbox" id="probleme" name="probleme" value="1"<%= filter.nurProbleme ? ' checked' : '' %>>
        <label class="form-check-label" for="probleme">nur hängende / überfällige</label>
      </div>
      <div class="col-auto"><button type="submit" class="btn btn-outline-primary">Filtern</button></div>
    </form>

    <% if (vorgaenge.length === 0) { %>
      <p>Keine laufenden Vorgänge für diese Auswahl.</p>
    <% } else { %>
      <p class="text-body-secondary"><%= vorgaenge.length %> Vorgang<%= vorgaenge.length === 1 ? '' : 'e' %>, älteste zuerst.</p>
      <div class="table-responsive">
        <table class="table table-sm align-middle">
          <thead>
            <tr><th>Eingang / seit</th><th>Art</th><th>Lieferant / Einreicher</th><th>Betrag</th><th>Konto</th><th>Status</th><th>Aktuell zuständig</th><th>Voraussichtlich Freigabe 2</th><th></th></tr>
          </thead>
          <tbody>
            <% vorgaenge.forEach((v) => { %>
              <tr class="<%= v.haengt ? 'table-danger' : (v.ueberfaellig ? 'table-warning' : '') %>">
                <td><%= v.eingangAm.slice(0, 10) %><br><small class="text-body-secondary">seit <%= (v.seit || '').slice(0, 10) %></small></td>
                <td><%= v.artLabel %></td>
                <td><a href="/admin/vorgaenge/<%= v.id %>"><%= v.gegenueber %></a><br><small class="text-body-secondary"><%= v.dateiname %></small></td>
                <td><%= v.betrag || '—' %></td>
                <td><%= v.kontoLabel %></td>
                <td>
                  <%= v.statusLabel %>
                  <% v.kennzeichen.forEach((k) => { %><span class="badge text-bg-secondary ms-1"><%= k %></span><% }) %>
                  <% if (v.haengt) { %><span class="badge text-bg-danger ms-1">hängt</span><% } %>
                  <% if (v.ueberfaellig) { %><span class="badge text-bg-warning ms-1">überfällig</span><% } %>
                </td>
                <td><%= v.zustaendig.name %><% if (v.zustaendig.vertretungName) { %><br><small class="text-body-secondary">vertreten durch <%= v.zustaendig.vertretungName %></small><% } %></td>
                <td>
                  <% if (!v.prognoseF2) { %>—
                  <% } else if (v.prognoseF2.offen) { %><span class="text-body-secondary">noch offen</span>
                  <% } else { %><%= v.prognoseF2.name %><% if (v.prognoseF2.prognose) { %> <span class="badge text-bg-light">Prognose</span><% } %><% } %>
                </td>
                <td><% if (darfEingreifen) { %><a href="/admin/vorgaenge/<%= v.id %>#umhaengen" class="btn btn-outline-primary btn-sm">Umhängen</a><% } %></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    <% } %>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

(Hinweis: Für abgelehnte Spesen zeigt die Liste den Button, die Detailseite dann aber kein Formular — die Detailseite erklärt das. Das hält die Liste frei von Sonderlogik.)

- [ ] **Step 5: Create `views/admin/vorgang-detail.ejs`**

```ejs
<!DOCTYPE html>
<html lang="de"<% if (branding.themeAttr) { %> data-theme="<%= branding.themeAttr %>" data-bs-theme="<%= branding.bsThemeAttr %>"<% } %>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
  <title>Vorgang <%= vorgang.dateiname %> — <%= branding.seitenTitel %> Admin</title>
</head>
<body>
  <%- include('../_header') %>
  <main class="container py-4">
    <%- include('./_nav') %>
    <p><a href="/admin/vorgaenge">← Laufende Vorgänge</a></p>
    <h1 class="h3"><%= vorgang.gegenueber %> <small class="text-body-secondary"><%= vorgang.dateiname %></small></h1>

    <% if (umgehaengt) { %>
      <div class="alert alert-success">Vorgang umgehängt. Die beteiligten Personen wurden per Mail informiert.</div>
    <% } %>
    <% if (errors.length) { %>
      <div class="alert alert-danger"><ul class="mb-0"><% errors.forEach((e) => { %><li><%= e %></li><% }) %></ul></div>
    <% } %>

    <dl class="row">
      <dt class="col-sm-3">Status</dt><dd class="col-sm-9"><%= vorgang.statusLabel %><% vorgang.kennzeichen.forEach((k) => { %> <span class="badge text-bg-secondary"><%= k %></span><% }) %></dd>
      <dt class="col-sm-3">Art</dt><dd class="col-sm-9"><%= vorgang.artLabel %></dd>
      <dt class="col-sm-3">Betrag</dt><dd class="col-sm-9"><%= vorgang.betrag || '—' %></dd>
      <dt class="col-sm-3">Konto</dt><dd class="col-sm-9"><%= vorgang.kontoLabel %></dd>
      <dt class="col-sm-3">Eingang / seit</dt><dd class="col-sm-9"><%= vorgang.eingangAm %> / <%= vorgang.seit %></dd>
      <dt class="col-sm-3">Aktuell zuständig</dt>
      <dd class="col-sm-9"><%= vorgang.zustaendig.name %><% if (vorgang.zustaendig.vertretungName) { %> (vertreten durch <%= vorgang.zustaendig.vertretungName %>)<% } %><% if (vorgang.haengt) { %> <span class="badge text-bg-danger">hängt</span><% } %></dd>
      <% if (vorgang.prognoseF2) { %>
        <dt class="col-sm-3">Voraussichtlich Freigabe 2</dt>
        <dd class="col-sm-9"><%= vorgang.prognoseF2.offen ? 'noch offen' : vorgang.prognoseF2.name %><% if (vorgang.prognoseF2.prognose && !vorgang.prognoseF2.offen) { %> <span class="badge text-bg-light">Prognose</span><% } %></dd>
      <% } %>
      <% if (pdfUrl) { %>
        <dt class="col-sm-3">Beleg</dt><dd class="col-sm-9"><a href="<%= pdfUrl %>" target="_blank" rel="noopener">PDF öffnen</a></dd>
      <% } %>
    </dl>

    <h2 class="h5">Verlauf</h2>
    <% if (auditLog.length === 0) { %>
      <p class="text-body-secondary">Noch keine Einträge.</p>
    <% } else { %>
      <table class="table table-sm">
        <thead><tr><th>Zeitpunkt</th><th>Ereignis</th><th>Person</th><th>Kommentar</th></tr></thead>
        <tbody>
          <% auditLog.forEach((e) => { %>
            <tr><td><%= e.zeitpunkt %></td><td><%= e.ereignis %></td><td><%= e.person %><% if (e.vertretungFuerPerson) { %> (für <%= e.vertretungFuerPerson %>)<% } %></td><td><%= e.kommentar || '' %></td></tr>
          <% }) %>
        </tbody>
      </table>
    <% } %>

    <% if (darfEingreifen) { %>
      <h2 class="h5 mt-4" id="umhaengen">Umhängen</h2>
      <% if (ziele.length === 0) { %>
        <p class="text-body-secondary">Keine Person kann diesen Vorgang übernehmen (alle Personen mit Konto-Rolle sind ausgeschlossen).</p>
      <% } else { %>
        <form method="post" action="/admin/vorgaenge/<%= vorgang.id %>/umhaengen" class="col-lg-8">
          <input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">
          <input type="hidden" name="stand" value="<%= stand %>">
          <div class="mb-3">
            <label class="form-label" for="zielId">Neue zuständige Person</label>
            <select class="form-select" id="zielId" name="zielId" required>
              <option value="">Bitte wählen …</option>
              <% ziele.forEach((p) => { %>
                <option value="<%= p.churchtools_person_id %>"<%= werte.zielId === p.churchtools_person_id ? ' selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
              <% }) %>
            </select>
            <div class="form-text">Ausgeschlossen sind die aktuell zuständige Person sowie alle, die das Vier-Augen-Prinzip oder ein erklärter Interessenskonflikt sperrt.</div>
          </div>
          <% if (strikterFreigeber1) { %>
            <div class="alert alert-warning">Strikte Freigeber-1-Prüfung ist aktiv: Ist die gewählte Person nicht <%= strikterFreigeber1 %>, wird der Vorgang bei der Kontierung an <%= strikterFreigeber1 %> weitergeleitet.</div>
          <% } %>
          <div class="mb-3">
            <label class="form-label" for="bemerkung">Bemerkung (Pflicht, mindestens <%= minBemerkung %> Zeichen)</label>
            <textarea class="form-control" id="bemerkung" name="bemerkung" rows="3" minlength="<%= minBemerkung %>" required><%= werte.bemerkung %></textarea>
            <div class="form-text">Erscheint im Verlauf und in den Mails an die beteiligten Personen.</div>
          </div>
          <div class="form-check mb-3">
            <input class="form-check-input" type="checkbox" id="bestaetigung" name="bestaetigung" value="ja" required>
            <label class="form-check-label" for="bestaetigung">Ich übergebe diesen Vorgang. Die bisher zuständige Person verliert den Zugriff.</label>
          </div>
          <button type="submit" class="btn btn-primary">Umhängen</button>
        </form>
      <% } %>
    <% } else if (vorgang.status === 'abgelehnt' && vorgang.art === 'spesen') { %>
      <p class="text-body-secondary mt-4">Abgelehnte Spesen-Positionen können nicht umgehängt werden, weil es für sie keinen Überarbeiten-Weg gibt.</p>
    <% } %>
  </main>
  <%- include('../_footer') %>
</body>
</html>
```

- [ ] **Step 6: Wire up app, nav, dashboard**

`src/app.js`: Import ergänzen

```js
import { createVorgaengeRouter } from './routes/admin/vorgaenge.js';
```

und direkt nach der Zeile mit `'/admin/abgelehnt'` mounten:

```js
  app.use('/admin/vorgaenge', requirePermission(db, config, 'vorgaenge_einsehen'), createVorgaengeRouter({ db, config, mailer, csrfProtection }));
```

`src/middleware/nav.js`, in `adminNav`:

```js
      vorgaenge: hasPermission('vorgaenge_einsehen'),
```

`views/admin/_nav.ejs`, als erster Eintrag der Liste:

```ejs
  <% if (adminNav.vorgaenge) { %><li class="nav-item"><a class="nav-link" href="/admin/vorgaenge">Laufende Vorgänge</a></li><% } %>
```

`views/admin/dashboard.ejs`, als erste Kachel innerhalb von `<div class="row row-cols-1 row-cols-md-3 g-3">`:

```ejs
      <% if (adminNav.vorgaenge) { %>
      <div class="col">
        <a href="/admin/vorgaenge" class="card text-decoration-none h-100">
          <div class="card-body">
            <h2 class="h5 card-title">Laufende Vorgänge</h2>
            <p class="card-text text-body-secondary">Alle offenen Vorgänge, wer zuständig ist und wer Freigabe 2 macht.</p>
          </div>
        </a>
      </div>
      <% } %>
```

- [ ] **Step 7: Update the sweeps and nav test**

`test/integration/admin/authz-sweep.test.js`: in `ADMIN_ROUTES` nach dem Block `// altfaelle (3)` ergänzen

```js
  // vorgaenge (3)
  { method: 'get', path: '/admin/vorgaenge' },
  { method: 'get', path: '/admin/vorgaenge/1' },
  { method: 'post', path: '/admin/vorgaenge/1/umhaengen' },
```

und im ersten Test die Zahl 42 an beiden Stellen (Titel und `assert.equal(ADMIN_ROUTES.length, 42, …)`) auf 45 ändern. In `VERGEBBAR` ergänzen: `{ method: 'get', path: '/admin/vorgaenge' },`.

`test/integration/csrfSweep.test.js`: in `SESSION_POST_ROUTES` nach `'/admin/altfaelle/1',` ergänzen: `'/admin/vorgaenge/1/umhaengen',`.

`test/unit/nav.test.js`: im Manager-Test ("adminNav includes the bundled sections …") ergänzen: `assert.equal(res.locals.adminNav.vorgaenge, true);`.

- [ ] **Step 8: Run tests**

Run: `node --test test/integration/admin/vorgaenge.test.js test/integration/admin/authz-sweep.test.js test/integration/csrfSweep.test.js test/unit/nav.test.js` → PASS.
Run: `npm test` → alle grün.

- [ ] **Step 9: Manual smoke check**

Run: `npm run dev` (mit vorhandener `.env`), als superadmin `/admin` öffnen: Kachel "Laufende Vorgänge" → Liste mit Filtern → Detailseite → einen Testvorgang umhängen → Bestätigung + neuer Verlaufseintrag. Ergebnis im Abschlussbericht nennen; wenn keine `.env` vorhanden ist, das ausdrücklich als nicht durchgeführt melden.

- [ ] **Step 10: Commit**

```bash
git add src/routes/admin/vorgaenge.js views/admin/vorgaenge-liste.ejs views/admin/vorgang-detail.ejs src/app.js src/middleware/nav.js views/admin/_nav.ejs views/admin/dashboard.ejs test/integration/admin/vorgaenge.test.js test/integration/admin/authz-sweep.test.js test/integration/csrfSweep.test.js test/unit/nav.test.js
git commit -m "feat(admin): Seite Laufende Vorgänge mit Detail und Umhängen"
```

---

### Task 8: Dokumentation

**Files:**
- Modify: `docs/rechnungs-workflow.md`, `docs/admin-bereich.md`, `docs/auth-und-rechte.md`, `docs/datenmodell.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/personen-sync.md`
- Modify: `docs/superpowers/specs/2026-10-19-admin-vorgaenge-dashboard-design.md` (Status-Zeile)

- [ ] **Step 1: `docs/rechnungs-workflow.md`**

Im Mermaid-Status-Diagramm nach der Zeile `abgelehnt --> geloescht: …` ergänzen:

```
    unzugewiesen --> zugewiesen: Admin hängt um\n(/admin/vorgaenge)
    zugewiesen --> zugewiesen: Admin hängt um
    freigabe2 --> freigabe2: Admin leitet Freigabe 2 um
    abgelehnt --> abgelehnt: Admin hängt um
```

Neuen Abschnitt vor "## \"Stalled Jobs\" — blockierte Rechnungen" einfügen:

```markdown
## 8. Admin-Eingriff: laufende Vorgänge umhängen

Unter **Admin → Laufende Vorgänge** (`/admin/vorgaenge`, Recht
`vorgaenge_einsehen`) stehen alle Vorgänge in `unzugewiesen`, `zugewiesen`,
`freigabe2` und `abgelehnt` mit aktuell zuständiger Person und
voraussichtlicher Freigabe-2-Person. Mit `workflow_eingreifen` lässt sich ein
Vorgang auf der Detailseite mit Pflicht-Bemerkung (mind. 10 Zeichen) an eine
andere Person mit Konto-Rolle übergeben:

| Phase | Wirkung |
|---|---|
| `unzugewiesen` | wird `zugewiesen` an die Zielperson (wie Pool-Weiterleitung) |
| `zugewiesen` / `abgelehnt` | `zugewiesen_an` = Zielperson, Admin-Eskalation bei Freigabe 1 aufgehoben |
| `freigabe2` | `freigabe2_umgeleitet_an` = Zielperson, Admin-Eskalation aufgehoben, Erinnerungsuhr startet neu |

Die bisher zuständige Person verliert den Zugriff. Ausgeschlossen sind die
aktuell zuständige Person, bei Freigabe 2 die Person mit Freigabe 1 und alle
Konfliktmelder dieser Stufe, bei Kontierung alle Konfliktmelder bei Freigabe 1,
bei Spesen die einreichende Person. Abgelehnte Spesen sind nicht umhängbar.
Die strikte Freigeber1-Prüfung bleibt in Kraft. Jeder Eingriff erzeugt einen
`freigaben`-Eintrag `admin_umzuweisung` und Mails (`admin-umzuweisung`, immer
sofort) an neue und bisherige Person.

**Effektive Freigabe-2-Person**: Admin-Eskalation → `freigabe2_umgeleitet_an`
→ Stellvertreter 2 (nach Konflikt) → Freigeber 2, danach Ferienvertretung.
Umgesetzt einmal als `getEffectiveFreigeber2Id` und einmal als
`EFFEKTIVER_FREIGEBER2_SQL` (`src/db/jobsRepo.js`). Die Umleitung endet bei
Abschluss, Ablehnung, Admin-Eskalation und jedem Pool-Reset. Erklärt die
umgeleitete Person einen Interessenskonflikt, geht der Vorgang direkt an die
Admin-Gruppe.
```

In Abschnitt "## 3. Freigabe 2" den Satz "Autorisiert ist der **effektive Freigeber 2** des Kontos — `stellvertreter2_id`, wenn …" ergänzen um: "— bzw. die per Admin-Eingriff umgeleitete Person (`freigabe2_umgeleitet_an`, siehe Abschnitt 8)".

- [ ] **Step 2: `docs/admin-bereich.md`**

In der Rechte-Matrix eine Zeile ergänzen (Spaltenform der bestehenden Tabelle übernehmen): `Laufende Vorgänge` | `/admin/vorgaenge` | `vorgaenge_einsehen` (Umhängen: `workflow_eingreifen`) | superadmin ✓, manager ✓ (nur ansehen). Darunter ein kurzer Absatz mit Verweis auf `rechnungs-workflow.md#8-admin-eingriff-laufende-vorgänge-umhängen`.

- [ ] **Step 3: `docs/auth-und-rechte.md`**

In der Liste der additiven Einzelrechte ergänzen:

```markdown
- `vorgaenge_einsehen`: Übersicht laufender Vorgänge — erlaubt `GET /admin/vorgaenge` und `GET /admin/vorgaenge/:id`
```

`workflow_eingreifen` umformulieren zu: "`workflow_eingreifen`: in laufende Vorgänge eingreifen — Force-Aktionen bei hängenden Jobs, Altfälle und Umhängen (`POST /admin/vorgaenge/:id/umhaengen`)". Den Satz "Ein `CHECK`-Constraint erlaubt elf Rechte" bzw. "elf oben genannten Rechte" auf "zwölf" ändern.

- [ ] **Step 4: `docs/datenmodell.md`**

Im ER-Diagramm bei `jobs` die Zeile `text freigabe2_umgeleitet_an FK "Admin-Umleitung Freigabe 2"` ergänzen, bei `freigaben` `text vorher_zustaendig FK` und `text ziel_person_id FK`; `rolle "13 mögliche Werte"` → `"14 mögliche Werte"`; bei `mail_log` `typ` die Anzahl um eins erhöhen. In "### `person_berechtigungen`" "elf Rechte" → "zwölf Rechte". In "### `freigaben`" ergänzen: "`vorher_zustaendig`/`ziel_person_id` sind nur bei `rolle = 'admin_umzuweisung'` gesetzt (vorher zuständige Person — `NULL` bei Pool/Admin-Gruppe — und Zielperson)."

- [ ] **Step 5: `docs/geplante-jobs-und-benachrichtigungen.md`**

Im Abschnitt `freigabe2-erinnerungen` ergänzen: "Empfänger des Reminders ist die effektive Freigabe-2-Person, also auch eine per Admin-Eingriff umgeleitete Person." In der Liste der Mail-Typen ergänzen: "`admin-umzuweisung` — Admin hat einen laufenden Vorgang umgehängt; an die neue Person (plus deren Ferienvertretung) und die bisherige; ignoriert das Batching wie `sync-fehler`/`iban-warnung`/`kk-beleg-eingegangen`."

- [ ] **Step 6: `docs/personen-sync.md`**

In der Tabelle "Stalled Jobs" bei `freigabe2`: "effektiver Freigeber 2 des Kontos (bzw. die per Admin-Eingriff umgeleitete Person)".

- [ ] **Step 7: Spec-Status**

In `docs/superpowers/specs/2026-10-19-admin-vorgaenge-dashboard-design.md` die Zeile `Status: Freigegeben (2026-10-19)` → `Status: Umgesetzt (<Datum der Umsetzung>)` und unter "## 2. Umhängen" einen Satz ergänzen: "Umsetzung: Detailseite `GET /admin/vorgaenge/:id` enthält das Formular (keine eigene `…/umhaengen`-GET-Route)."

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "docs: Admin-Dashboard laufende Vorgänge und Umhängen dokumentieren"
```

---

## Abschluss

Nach Task 8: `npm test` vollständig grün, dann `superpowers:finishing-a-development-branch`.
