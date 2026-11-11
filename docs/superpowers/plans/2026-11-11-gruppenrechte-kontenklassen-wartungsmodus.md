# Gruppenrechte, Konten-Klassifizierung und Wartungsmodus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rechte pro ChurchTools-Gruppe im Admin einstellbar machen (mit Herkunftsanzeige), Konten nach Buchungsart (Rechnung/Gutschrift/beides) klassifizieren und filtern, und einen Wartungsmodus für saubere Updates/Backups einführen.

**Architecture:** Neue Tabelle `gruppen_berechtigungen` + zentraler Rechtekatalog ersetzen das feste Rollen-Bundle in `middleware/permissions.js`; alle harten `requireRole`-Gatter der Admin-Seiten werden `requirePermission`. Der Wartungsmodus ist ein `admin_config`-Schalter, den eine Middleware (Web + Maschinenrouten), der Mail-Versand und der Scheduler lesen. Die Buchungsart ist eine Spalte `konten.buchungsart`, gefiltert im Browser und serverseitig.

**Tech Stack:** Node 22, Express 4, EJS, `node:sqlite` (Synchron-API wie `openDatabase`), `node:test` + supertest. Tests: `npm test` bzw. `node --test <datei>`.

**Spec:** `docs/superpowers/specs/2026-11-11-gruppenrechte-kontenklassen-wartungsmodus-design.md`

**Reihenfolge:** Teil A (Tasks 1–8) → Teil C (Tasks 9–12) → Teil B (Tasks 13–15). C braucht das Recht `wartungsmodus_schalten` aus A; B ist unabhängig. Arbeit auf neuem Branch `feature/gruppenrechte-kontenklassen-wartungsmodus` ab `master` (Worktree-Skill).

## Global Constraints

- Gruppen genau drei: `superadmin`, `manager`, `buchhaltung` (Config `CT_GROUP_ID_ADMIN` = `superadmin`). Keine weitere Gruppe.
- `gruppenrechte_verwalten` ist für Superadmin fest gesetzt, nicht abschaltbar, weder für andere Gruppen noch als Einzelrecht vergebbar.
- Effektives Recht = Vereinigung aus Rechten aller Gruppen der Person und ihrer Einzelrechte. Kein Verbotsrecht.
- Startwerte der Migration = heutiges Verhalten: Superadmin alle Rechte; Manager = alle bisherigen vergebbaren Rechte ausser `sync_verwalten`, `workflow_eingreifen`, `betrieb_einsehen`, plus `personen_einsehen` und `testmodus_nutzen`; Buchhaltung keine. Neue Rechte aus diesem Release (`wartungsmodus_schalten` und `gruppenrechte_verwalten`) nur Superadmin. Seeding einmalig, überschreibt später nie Änderungen.
- Konten-Buchungsart: Werte `rechnung`, `gutschrift`, `beides`, Default `beides`. Rechnung → `rechnung`+`beides`; Gutschrift → `gutschrift`+`beides`. Spesen und Kreditkarten-Belege zählen als Rechnung. Bestehende Vorgänge bleiben unberührt.
- Wartungsmodus: n8n-Routen (`/api/n8n/jobs`, `/kk-belege`, `/rapporte`) antworten 503 mit `Retry-After`; `/api/n8n/backup`, `/healthz`, `/auth/*` bleiben offen. Mails werden zurückgehalten, nie verworfen. Kein Zwischenspeichern von Rechnungen im Portal.
- Alle sichtbaren Texte in Du-Form, Schweizer Rechtschreibung (kein ß), im Stil der bestehenden Admin-Seiten. Jedes neue Formular trägt `_csrf` (`test/integration/csrfSweep.test.js` prüft das); jede neue Seite nutzt `_seite_anfang`/`_seite_ende` (`layoutSweep.test.js`).
- Audit-Einträge in `audit_ereignisse` (Spalten: `zeitpunkt, person_id, person_name, objekt, objekt_id, aktion, vorher, nachher, begruendung`), Akteur über `currentAuditActor()` aus `services/auditContext.js` (Muster: `schreibeAudit` in `services/verwaisteDateien.js`).

## Review Focus

Von der Spec angedeutete, von keiner Aufgabe sonst abgedeckte Fälle, wahrscheinlichster zuerst; jeder hat unten einen Test in der besitzenden Task:

1. Person in zwei Gruppen (IT-Admin: `superadmin`+`buchhaltung`): Rechte werden vereinigt; Entzug in einer Gruppe nimmt das Recht nicht weg, die Herkunft listet beide (Task 3, 7).
2. Superadmin versucht per manipuliertem POST, `gruppenrechte_verwalten` abzuschalten oder einer anderen Gruppe zu geben: wird ignoriert (Task 5).
3. Wartungsmodus aktiv, Anfrage ohne Session (ausgeloggt): Wartungsseite 503, `/auth/login` bleibt erreichbar, kein Redirect-Loop (Task 10).
4. Mail wird im Wartungsmodus eingereiht, nach dem Ausschalten zugestellt, nichts geht verloren; Digest und Sicherheitsalarm ebenfalls zurückgehalten (Task 11).
5. Konto-ID eines nicht passenden Kontos per Hand in den POST gesetzt (Rechnung↔Gutschrift) oder ein inaktives Konto: Server lehnt ab (Task 14).

---

## Teil A – Rechte pro Gruppe

### Task 1: Rechtekatalog als eigenes Modul

**Files:**
- Create: `src/services/berechtigungKatalog.js`
- Modify: `src/middleware/permissions.js` (Katalog-Konstanten von dort verschieben und re-exportieren), `src/db/securitySchema.js:1-6` (`RIGHTS` aus dem Katalog statt eigener Liste)
- Test: `test/unit/berechtigungKatalog.test.js`, anpassen `test/unit/permissions.test.js` (erste Test-Fälle zählen jetzt die erweiterte Liste)

**Interfaces:**
- Produces (alle aus `berechtigungKatalog.js`):
  - `GRUPPEN = ['superadmin', 'manager', 'buchhaltung']`
  - `GRANTABLE_BERECHTIGUNGEN: string[]` — die 15 bisherigen plus neu: `personen_einsehen`, `testmodus_nutzen`, `benachrichtigungen_verwalten`, `erscheinungsbild_verwalten`, `ersteinrichtung_verwalten`, `zeitstempel_verwalten`, `backup_verwalten`, `module_verwalten`, `dateiquarantaene_verwalten`, `wartungsmodus_schalten`
  - `FESTE_RECHTE = ['gruppenrechte_verwalten']` (nur Superadmin, nicht in `GRANTABLE_BERECHTIGUNGEN`)
  - `BERECHTIGUNG_LABELS: Record<string,string>` für alle Rechte inkl. `gruppenrechte_verwalten` («Gruppenrechte verwalten»)
  - `BERECHTIGUNG_BEREICHE: {titel: string, rechte: string[]}[]` (Gruppierung für die Matrix, spiegelt `ADMIN` in `services/navigation.js`: Vorgänge, Stammdaten, Benachrichtigungen/Erscheinungsbild, System, …)
  - `startwerteFuerGruppe(gruppe: string): string[]` — liefert die Startwerte aus den Global Constraints
- `permissions.js` re-exportiert `GRANTABLE_BERECHTIGUNGEN` und `BERECHTIGUNG_LABELS` unverändert (bestehende Importe bleiben gültig).

- [ ] **Step 1: Failing tests** in `berechtigungKatalog.test.js`: `startwerteFuerGruppe('superadmin')` enthält jedes Recht aus `GRANTABLE_BERECHTIGUNGEN` und `gruppenrechte_verwalten`; `startwerteFuerGruppe('manager')` enthält `konten_verwalten`, `personen_einsehen`, `testmodus_nutzen`, aber keines von `sync_verwalten`, `workflow_eingreifen`, `betrieb_einsehen`, `wartungsmodus_schalten`, `backup_verwalten`; `startwerteFuerGruppe('buchhaltung')` ist `[]`; jedes Recht hat ein Label und liegt in genau einem Bereich; `gruppenrechte_verwalten` ist nicht in `GRANTABLE_BERECHTIGUNGEN`.
- [ ] **Step 2:** `node --test test/unit/berechtigungKatalog.test.js` → FAIL (Modul fehlt).
- [ ] **Step 3:** Modul anlegen, `permissions.js` und `securitySchema.js` auf den Katalog umstellen (`RIGHTS` = `GRANTABLE_BERECHTIGUNGEN`; so baut die bestehende Migration `person_berechtigungen` mit erweitertem CHECK neu auf). In `permissions.test.js` die erste Prüfung auf die neue Liste anpassen.
- [ ] **Step 4:** `node --test test/unit/berechtigungKatalog.test.js test/unit/permissions.test.js test/unit/db.test.js` → PASS (nur die bewusst angepassten Erwartungen ändern sich).
- [ ] **Step 5: Commit** `feat: Rechtekatalog als eigenes Modul, neue Rechte für bisher rollengebundene Seiten`

### Task 2: Tabelle `gruppen_berechtigungen`, Repo, einmaliges Seeding

**Files:**
- Modify: `src/db/schema.sql` (neue Tabelle), `src/db/index.js` (`openDatabase` ruft Seeding)
- Create: `src/db/gruppenBerechtigungenRepo.js`
- Test: `test/unit/gruppenBerechtigungenRepo.test.js`

**Interfaces:**
- Consumes: `GRUPPEN`, `startwerteFuerGruppe` (Task 1)
- Produces:
  - Tabelle `gruppen_berechtigungen (gruppe TEXT NOT NULL, berechtigung TEXT NOT NULL, PRIMARY KEY (gruppe, berechtigung))` — bewusst **ohne** CHECK auf `berechtigung` (Gültigkeit prüft der Code gegen den Katalog; spart künftige Tabellen-Neuaufbauten).
  - `listGruppenBerechtigungen(db, gruppe: string): string[]`
  - `listAlleGruppenBerechtigungen(db): Record<string, string[]>` (alle drei Gruppen, leere Arrays inklusive)
  - `setGruppenBerechtigungen(db, gruppe: string, berechtigungen: string[]): void` — ersetzt in einer Transaktion; filtert auf `GRANTABLE_BERECHTIGUNGEN` (+ `gruppenrechte_verwalten` nur bei `superadmin`, dort immer erzwungen)
  - `seedGruppenBerechtigungen(db): void` — idempotent über `admin_config`-Schlüssel `gruppenrechte_initialisiert='1'`; läuft nur, wenn der Schlüssel fehlt

- [ ] **Step 1: Failing tests:** Seeding auf leerer DB füllt gemäss `startwerteFuerGruppe`; zweiter Aufruf nach `setGruppenBerechtigungen(db,'manager',['konten_verwalten'])` überschreibt nichts; `setGruppenBerechtigungen(db,'superadmin',[])` lässt `gruppenrechte_verwalten` stehen; `setGruppenBerechtigungen(db,'manager',['gruppenrechte_verwalten','unbekannt','konten_verwalten'])` speichert nur `konten_verwalten`.
- [ ] **Step 2:** Test laufen lassen → FAIL.
- [ ] **Step 3:** Implementieren; `CREATE TABLE IF NOT EXISTS` in `schema.sql`; Seeding am Ende von `openDatabase` (nach `seedDefaults`-Muster; `admin_config` wird mit `getConfigValue`/`setConfigValue` aus `adminConfigRepo.js` gelesen/geschrieben).
- [ ] **Step 4:** Tests → PASS; `node --test test/unit/db.test.js` weiterhin PASS.
- [ ] **Step 5: Commit** `feat: Gruppenrechte-Tabelle mit einmaligem Seeding auf den Ist-Zustand`

### Task 3: Effektive Rechte und Herkunft

**Files:**
- Modify: `src/middleware/roles.js` (neue Funktion `gruppenVon`), `src/middleware/permissions.js` (Logik umbauen)
- Test: `test/unit/permissions.test.js` (erweitern; die Manager-Bundle-Tests ersetzen), `test/unit/roles.test.js`

**Interfaces:**
- Consumes: `listAlleGruppenBerechtigungen`, `listGruppenBerechtigungen` (Task 2), `listBerechtigungenForPerson`, `personHasBerechtigung`
- Produces:
  - `gruppenVon(person, config): ('superadmin'|'manager'|'buchhaltung')[]` in `roles.js` (nutzt `personHasRole`)
  - `personHasPermission(db, config, person, permission): boolean` — `true` wenn eine Gruppe der Person das Recht hat (für `gruppenrechte_verwalten`: nur Mitgliedschaft in `superadmin`) oder ein Einzelrecht vorliegt. Die Sonderregeln «Superadmin hat alles» und `NICHT_IM_MANAGER_BUNDLE` entfallen.
  - `erstellePermissionPruefer(db, config, person): (permission: string) => boolean` — lädt Gruppen- und Einzelrechte einmal lazy.
  - `ermittleRechteMitHerkunft(db, config, person): Map<string, { gruppen: string[], direkt: boolean }>` — nur Rechte, die die Person effektiv hat; `gruppenrechte_verwalten` mit `gruppen:['superadmin']`.
  - `hatIrgendeinAdminRecht(db, config, person): boolean`; `requireAdminAreaAccess` nutzt es.

- [ ] **Step 1: Failing tests** (Name → Assertion): «Person nur in manager hat Startwert-Rechte, aber nicht `sync_verwalten`»; «Person in superadmin+buchhaltung: nach `setGruppenBerechtigungen(db,'superadmin',[])` bleibt ein Recht, das Buchhaltung hat, erhalten (Review Focus 1) und `ermittleRechteMitHerkunft` führt beide Gruppen auf»; «Einzelrecht ergänzt Gruppenrechte, `direkt` true»; «Superadmin ohne `workflow_eingreifen` in der Tabelle: `personHasPermission(...,'workflow_eingreifen') === false`, aber `gruppenrechte_verwalten` true»; «Buchhaltungsperson ohne Gruppenrechte und ohne Einzelrechte: `hatIrgendeinAdminRecht` false».
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementieren, `requireAdminAreaAccess` anpassen. Tests mit `seedGruppenBerechtigungen`-Startwerten aufbauen (`openDatabase(':memory:')` seedet bereits).
- [ ] **Step 4:** `node --test test/unit/permissions.test.js test/unit/roles.test.js test/unit/nav.test.js` → PASS (nav-Tests ggf. in Task 6 mitziehen).
- [ ] **Step 5: Commit** `feat: effektive Rechte aus Gruppen und Einzelrechten mit Herkunft`

### Task 4: Audit-Helfer für Rechteänderungen

**Files:**
- Create: `src/services/rechteAudit.js`
- Test: `test/unit/rechteAudit.test.js`

**Interfaces:**
- Produces:
  - `auditiereGruppenrechte(db, gruppe: string, vorher: string[], nachher: string[]): number` — schreibt je geändertem Recht einen `audit_ereignisse`-Eintrag (`objekt='gruppenrechte'`, `objekt_id=gruppe`, `aktion='recht_erteilt'|'recht_entzogen'`, `nachher=JSON {recht}`), gibt die Anzahl zurück.
  - `auditiereEinzelrechte(db, personId: string, vorher: string[], nachher: string[]): number` — wie oben mit `objekt='person_berechtigungen'`, `objekt_id=personId`.

- [ ] **Step 1: Failing tests:** Diff `['a','b']→['b','c']` schreibt genau zwei Einträge (`a` entzogen, `c` erteilt); gleicher Bestand schreibt nichts; Akteur stammt aus `withAuditOperation`-Kontext (Muster `test/unit/auditLog.test.js`).
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren (Akteur `currentAuditActor()`). **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: Audit-Einträge für Gruppen- und Einzelrechteänderungen`

### Task 5: Admin-Seite «Gruppenrechte»

**Files:**
- Create: `src/routes/admin/gruppenrechte.js`, `views/admin/gruppenrechte.ejs`
- Modify: `src/app.js` (Route mounten), `src/services/navigation.js` (Punkt «Gruppenrechte» in `ADMIN`, Gruppe «System», `flag: 'gruppenrechte'`, passendes Symbol aus `SYMBOLE`, z. B. `shield-lock` oder ein bereits vorhandenes), `src/routes/admin/auditLog.js` (`objektLabel`: `gruppenrechte` → «Gruppenrechte», `person_berechtigungen` → «Einzelrechte»)
- Test: `test/integration/admin/gruppenrechte.test.js`

**Interfaces:**
- Consumes: Task 1–4
- Produces: `createGruppenrechteRouter({ db, config, csrfProtection }): Router` — `GET /` rendert die Matrix (Zeilen = Rechte gruppiert nach `BERECHTIGUNG_BEREICHE`, Spalten = drei Gruppen, Checkbox `name="recht_<gruppe>" value="<recht>"`, `gruppenrechte_verwalten` als gesetzte, deaktivierte Checkbox in der Spalte Superadmin und nicht in den anderen Spalten); `POST /` speichert alle drei Gruppen, ruft pro Gruppe `setGruppenBerechtigungen` + `auditiereGruppenrechte`, Redirect `/admin/gruppenrechte?gespeichert=1`.
  Mount in `app.js`: `app.use('/admin/gruppenrechte', requirePermission(db, config, 'gruppenrechte_verwalten'), createGruppenrechteRouter(...))`.

- [ ] **Step 1: Failing tests:** GET ohne Recht → 403; GET als Superadmin zeigt eine Zeile pro Recht; POST ändert Manager-Rechte, schreibt Audit-Einträge, Wirkung sofort sichtbar (`personHasPermission`); POST mit `recht_superadmin` ohne `gruppenrechte_verwalten` lässt es trotzdem gesetzt (Review Focus 2); POST mit `recht_manager=gruppenrechte_verwalten` wird ignoriert; POST ohne CSRF-Token → 403 (bestehender `csrf`-Helfer in `test/helpers/csrf.js`).
- [ ] **Step 2:** → FAIL. **Step 3:** Route, View (Stil von `views/admin/module-form.ejs`), Navigation, Mount. **Step 4:** `node --test test/integration/admin/gruppenrechte.test.js test/integration/csrfSweep.test.js test/integration/layoutSweep.test.js test/unit/navigation.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Admin-Seite Gruppenrechte`

### Task 6: Harte Rollengatter durch Rechte ersetzen

**Files:**
- Modify: `src/app.js:307-338` (alle `requireRole(config,'superadmin')`/`requireAnyRole` der Admin-Routen), `src/middleware/nav.js:11-40` (`adminNav`), `src/middleware/testmodusWeiche.js:20-22` (`darfTestmodus`), `src/routes/kontierung.js:110-111`, `src/routes/admin/personen.js:3,18,33`
- Test: `test/integration/admin/authz-sweep.test.js`, `test/unit/nav.test.js`, `test/integration/testmodusWeiche.test.js`, `test/integration/kontierung.test.js`

**Interfaces:**
- Zuordnung Route → Recht: `/admin/benachrichtigungen`→`benachrichtigungen_verwalten`; `/admin/erscheinungsbild`→`erscheinungsbild_verwalten`; `/admin/ersteinrichtung`→`ersteinrichtung_verwalten`; `/admin/zeitstempel`→`zeitstempel_verwalten`; `/admin/personen`→`personen_einsehen`; `/admin/backup`→`backup_verwalten`; `/admin/module`→`module_verwalten`; `/admin/dateiquarantaene`→`dateiquarantaene_verwalten`; `/admin/testmodus` und Testmodus-Zugang (`darfTestmodus`, Signatur bekommt `db`: `darfTestmodus(db, person, config)`)→`testmodus_nutzen`. `POST /admin/personen/:id/berechtigungen` verlangt `gruppenrechte_verwalten` (Entscheid des Plans: Rechtevergabe an Personen ist dieselbe Sensibilität wie Gruppenrechte). `adminNav`-Flags nutzen `hasPermission(...)` mit den neuen Rechten; `isSuperadmin`/`isManager`/`isBuchhaltung` bleiben für Nicht-Rechte-Zwecke erhalten. In `kontierung.js` entfällt `personHasRole(...,'superadmin') ||`; es zählt nur `kreditoren_verwalten`.
- Unverändert (Rolle, kein Recht): Pool (`poolPage.js`), `jobAuthorization.js`, `kkRechte.js`, Eskalations-Empfänger.

- [ ] **Step 1: Failing tests:** pro umgestellter Route, dass eine Person mit Gruppe `buchhaltung` + diesem einen Gruppenrecht Zugriff hat und dieselbe Person ohne das Recht 403 bekommt; `adminNav` zeigt den Punkt genau dann; Manager nach Startwerten sieht weiterhin Personen und Testmodus, nicht Backup; Superadmin ohne `backup_verwalten` bekommt auf `/admin/backup` 403.
- [ ] **Step 2:** → FAIL. **Step 3:** Umstellen. Danach `grep -rn "requireRole\|requireAnyRole" src/app.js` — es dürfen nur `buchhaltung`-Pool und die `/api/pool`-Route übrig sein. **Step 4:** `npm test` komplett → PASS (bestehende Tests, die Superadmin ohne Gruppenrechte-Seeding annehmen, laufen über das Seeding von `openDatabase`).
- [ ] **Step 5: Commit** `refactor: Admin-Seiten prüfen Rechte statt fester Rollen`

### Task 7: Herkunft in der Personenliste, Einzelrechte-Audit

**Files:**
- Modify: `src/routes/admin/personen.js`, `views/admin/personen-liste.ejs`
- Test: `test/integration/admin/personen.test.js`

**Interfaces:**
- Consumes: `ermittleRechteMitHerkunft` (Task 3), `auditiereEinzelrechte` (Task 4)
- Produces: die Listenzeile zeigt statt «bereits über Rolle … enthalten» eine Liste der effektiven Rechte mit Herkunftsmarken («direkt», «über Gruppe Manager», mehrere nebeneinander). Das Einzelrechte-Formular bleibt bedienbar (Checkboxen **nicht** deaktivieren, sonst entzieht Speichern still); Rechte, die schon eine Gruppe liefert, tragen den Hinweis «auch über Gruppe X». Gruppenrechte-Spalte `rolle` bleibt als Anzeige der höchsten Gruppe.
  `POST /:id/berechtigungen` ruft nach dem Speichern `auditiereEinzelrechte(db, id, vorher, nachher)`.

- [ ] **Step 1: Failing tests:** Person in `manager` + Einzelrecht `workflow_eingreifen` → Seite zeigt «direkt» bei diesem Recht und «über Gruppe Manager» bei `konten_verwalten`; Person in `superadmin`+`buchhaltung` mit Recht, das nur Buchhaltung gibt: beide Gruppen genannt (Review Focus 1); Speichern von Einzelrechten schreibt Audit-Einträge `person_berechtigungen`.
- [ ] **Step 2:** → FAIL. **Step 3:** Umsetzen. **Step 4:** `node --test test/integration/admin/personen.test.js test/integration/csrfSweep.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Herkunft der Rechte in der Personenliste, Audit der Einzelrechte`

### Task 8: Dokumentation Teil A

**Files:** Modify `docs/auth-und-rechte.md` (Rollenmodell + additive Rechte + Tabelle `gruppen_berechtigungen`), `docs/admin-bereich.md` (Seite Gruppenrechte, Rechte pro Seite), `docs/datenmodell.md`, Test-Runbook `docs/testdrehbuch/` (Prüfschritt: Manager-Recht entziehen und prüfen).

- [ ] **Step 1:** Dokus nachziehen (Rechtekatalog-Tabelle mit Startwerten, fester Superadmin-Schutz, Herkunftsanzeige, Audit-Aktionen `recht_erteilt`/`recht_entzogen`).
- [ ] **Step 2:** `npm test` → PASS. **Step 3: Commit** `docs: Gruppenrechte`

---

## Teil C – Wartungsmodus

### Task 9: Zustand und Service

**Files:**
- Modify: `src/db/adminConfigRepo.js` (`DEFAULTS`: `wartungsmodus_aktiv: '0'`, `wartungsmodus_hinweis: ''`)
- Create: `src/services/wartungsmodus.js`
- Test: `test/unit/wartungsmodus.test.js`

**Interfaces:**
- Produces: `istWartungsmodusAktiv(db): boolean`, `wartungsHinweis(db): string`, `setzeWartungsmodus(db, aktiv: boolean, hinweis?: string): void` — schreibt den Zustand und genau einen Audit-Eintrag (`objekt='wartungsmodus'`, `aktion='wartungsmodus_ein'|'wartungsmodus_aus'`, `nachher=JSON {hinweis}`) nur bei tatsächlicher Änderung.

- [ ] **Step 1: Failing tests:** Default aus; ein→aus→ein; zweimal «ein» schreibt nur einen Audit-Eintrag; Hinweis wird auf 200 Zeichen gekürzt und getrimmt; Zustand überlebt `db`-Neuöffnung (Datei-DB im `os.tmpdir`).
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** → PASS. **Step 5: Commit** `feat: Wartungsmodus-Zustand`

### Task 10: Sperre für Web- und Maschinenzugriffe

**Files:**
- Create: `src/middleware/wartungsmodus.js`, `views/wartung.ejs`
- Modify: `src/app.js` (direkt nach `loadNavFlags`, vor `/admin`), Banner-Partial `views/_banner.ejs` oder `_seite_anfang.ejs` (Banner «Wartungsmodus aktiv» mit Link zu `/admin/wartungsmodus`, nur wenn `res.locals.wartungsmodusAktiv`)
- Test: `test/integration/wartungsmodus.test.js`

**Interfaces:**
- Produces: `wartungsmodusSperre(db, config): RequestHandler`. Ist der Modus aus → `next()`. Immer durchgelassen: `/healthz`, `/auth/*`, `/api/n8n/backup`. Pfade `/api/n8n/*` (ausser backup) und `/internal/cron/*` → `503`, Header `Retry-After: 300`, JSON `{ error: 'wartungsmodus' }`. Alle anderen Anfragen: Person mit Recht `wartungsmodus_schalten` → `next()` mit `res.locals.wartungsmodusAktiv = true`; sonst `503` + Seite `wartung.ejs` (Du-Form: «Wartungsarbeiten – bitte versuch es später wieder», Hinweistext, Link zur Abmeldung). Die Wartungsseite zeigt der ausgeloggten Anfrage dasselbe (kein Redirect auf `/auth/login`).
- Offene Frage für den Implementierer, zu prüfen und im Test festzuhalten: der Cron-Pfad für die Datenbank-Sicherung (`grep datenbank-sicherung src/routes/cron.js`). Falls er existiert, bleibt er offen (Sicherung ist lesend).

- [ ] **Step 1: Failing tests:** Modus aus → alles wie vorher; Modus an: normale Person `GET /pool` → 503 + Wartungstext; ausgeloggt `GET /pool` → 503 (nicht 302) und `GET /auth/login` → nicht 503 (Review Focus 3); Person mit Recht → 200 mit Banner; `POST /api/n8n/jobs` mit gültigem API-Key → 503 + `Retry-After`; `GET /api/n8n/backup/latest` → unverändert; `/healthz` → 200.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren, in `app.js` einhängen (Maschinenrouten laufen dort bereits hinter der Personenladung, die Sperre kommt vor deren Mounts). **Step 4:** `node --test test/integration/wartungsmodus.test.js test/integration/layoutSweep.test.js test/integration/app.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Wartungsmodus sperrt Web und n8n-Eingang`

### Task 11: Mails zurückhalten, Jobs pausieren

**Files:**
- Modify: `src/services/mailZustellung.js` (`stelleMailZu` ab Z. 115, `stelleDigestZu` ab Z. 219: Guard am Anfang), `src/services/sicherheitsalarme.js` (um Z. 137: vor `mailer.sendMail` Guard), `src/services/scheduler.js` (`scheduleDaily`/`scheduleInterval`-Aufgaben überspringen, ausser Datenbank-Sicherung; Entscheid des Plans, damit der geplante Sicherungslauf nicht ausfällt), `src/routes/admin/mails.js` (manueller Wiederholen-Knopf zeigt Hinweis statt zu senden)
- Test: `test/unit/mailZustellung.test.js`, `test/unit/scheduler.test.js` (bestehende Dateien erweitern), `test/integration/wartungsmodus.test.js`

**Interfaces:**
- Consumes: `istWartungsmodusAktiv` (Task 9)
- Produces: `stelleMailZu` liefert bei aktivem Modus `{ id, status: 'eingereiht', beansprucht: false, zurueckgehalten: true }`, ohne die Zeile zu beanspruchen und ohne `versuche` zu erhöhen. `stelleDigestZu` gibt dann `null` zurück (wie «nichts beansprucht»). Der Scheduler protokolliert übersprungene Läufe nicht als Fehler.

- [ ] **Step 1: Failing tests:** `sendRenderedMail` bei aktivem Modus: kein `sendMail`-Aufruf am Fake-Mailer, Zeile `eingereiht`, `versuche === 0`; nach `setzeWartungsmodus(false)` liefert `stelleFaelligeMailsZu` sie aus (Review Focus 4); Digest zurückgehalten; Sicherheitsalarm zurückgehalten; Scheduler-Aufgabe läuft im Modus nicht, die Sicherungsaufgabe schon.
- [ ] **Step 2:** → FAIL. **Step 3:** Guards setzen. **Step 4:** `node --test test/unit/mailZustellung.test.js test/unit/scheduler.test.js test/unit/cronJobs.test.js test/integration/mailversandEndToEnd.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Wartungsmodus hält Mails zurück und pausiert geplante Jobs`

### Task 12: Admin-Seite, Navigation, Statusseite, Doku

**Files:**
- Create: `src/routes/admin/wartungsmodus.js`, `views/admin/wartungsmodus.ejs`
- Modify: `src/app.js` (Mount mit `requirePermission(db, config, 'wartungsmodus_schalten')`), `src/services/navigation.js` (Punkt «Wartungsmodus», Gruppe «System», `flag: 'wartungsmodus'`), `src/middleware/nav.js` (Flag), `src/routes/healthz.js` (Wartungsmodus als Info-Feld, kein Fehlerstatus), `docs/betrieb-und-nutzung.md` (Ablauf «Modus an → Backup → Update → Modus aus»), `docs/n8n-schnittstelle.md` (503 + `Retry-After`, n8n-Workflow muss erneut versuchen), `docs/admin-bereich.md`, `docs/datenmodell.md`
- Test: `test/integration/admin/wartungsmodus.test.js`, `test/integration/healthz.test.js`

**Interfaces:**
- Produces: `createWartungsmodusRouter({ db, csrfProtection }): Router` — `GET /` zeigt Zustand, Textfeld Hinweis (max. 200), Knopf «Wartungsmodus einschalten/ausschalten» als POST-Formular; `POST /` ruft `setzeWartungsmodus`, Redirect mit `?gespeichert=1`.

- [ ] **Step 1: Failing tests:** ohne Recht 403; Einschalten setzt Zustand und schreibt Audit; Ausschalten ebenso; Hinweis erscheint auf `wartung.ejs`; `/healthz` meldet den Modus ohne Fehlercode; Person mit Recht kann im Modus ausschalten (kommt durch die Sperre).
- [ ] **Step 2:** → FAIL. **Step 3:** Umsetzen. **Step 4:** `npm test` → PASS. **Step 5: Commit** `feat: Admin-Seite Wartungsmodus mit Doku`

---

## Teil B – Konten-Klassifizierung

### Task 13: Spalte, Repo, Admin-Formular

**Files:**
- Modify: `src/db/index.js` (neue Spaltenmigration nach dem Muster `migrateKreditorenTable`: `ALTER TABLE konten ADD COLUMN buchungsart TEXT NOT NULL DEFAULT 'beides' CHECK (buchungsart IN ('rechnung','gutschrift','beides'))`), `src/db/schema.sql` (Spalte im `CREATE TABLE konten`), `src/db/kontenRepo.js` (`createKonto`/`updateKonto` nehmen `buchungsart`), `src/routes/admin/konten.js` (`readRoleFields`, Validierung, Audit bei Änderung), `views/admin/konten-form.ejs`, `views/admin/konten-liste.ejs`
- Test: `test/unit/kontenRepo.test.js`, `test/integration/admin/konten.test.js`

**Interfaces:**
- Produces: `BUCHUNGSARTEN = ['rechnung','gutschrift','beides']` und `BUCHUNGSART_LABEL = { rechnung: 'Rechnung', gutschrift: 'Gutschrift', beides: 'Rechnung / Gutschrift' }` exportiert aus `kontenRepo.js`; `createKonto(db, {..., buchungsart = 'beides'})`, `updateKonto(db, id, {..., buchungsart})`; Konten-Zeilen enthalten `buchungsart`. Änderung der Buchungsart schreibt `audit_ereignisse` (`objekt='konten'`, `objekt_id=id`, `aktion='buchungsart_geaendert'`, `vorher`/`nachher` JSON).

- [ ] **Step 1: Failing tests:** bestehendes Konto in einer alten DB hat nach der Migration `beides`; Anlegen mit `gutschrift` speichert es; ungültiger Wert → 400 mit Fehlertext; Liste zeigt die Art; Änderung schreibt Audit, unveränderte Speicherung nicht.
- [ ] **Step 2:** → FAIL. **Step 3:** Umsetzen. **Step 4:** `node --test test/unit/kontenRepo.test.js test/integration/admin/konten.test.js test/unit/db.test.js` → PASS. **Step 5: Commit** `feat: Buchungsart pro Konto im Admin`

### Task 14: Filter in Kontierung und Aufsplitten (Browser + Server)

**Files:**
- Modify: `src/db/kontenRepo.js` (Helfer), `src/routes/kontierung.js` (Konto-Prüfung um Z. 352 und Aufsplitten um Z. 982), `views/kontierung.ejs` (Konto-`<option>` mit `data-buchungsart`), `views/kontierung-aufsplitten.ejs` (pro Zeile), `public/js/kontierung-konto-filter.js` (neu, CSP-konform: Skript mit Nonce wie die anderen Seiten-Skripte; gleiches Einbindungsmuster wie `public/js/kontierung-iban.js`)
- Test: `test/unit/kontenRepo.test.js`, `test/integration/kontierung.test.js`, `test/integration/splitgruppen-e2e.test.js` (Aufsplitten-Fall)

**Interfaces:**
- Produces in `kontenRepo.js`: `kontoErlaubtFuerTyp(konto: {buchungsart: string}, typ: 'rechnung'|'gutschrift'): boolean` und `filterKontenFuerTyp(konten: object[], typ): object[]`. Das Skript hört auf das Typ-Radio (`name="typ"`), blendet nicht passende `<option>` aus/entfernt sie, leert eine nicht mehr passende Auswahl und zeigt «Das gewählte Konto passt nicht zum Typ – bitte neu wählen» in einem `aria-live`-Hinweis.
- Serverseitig: `POST /kontierung/:id` und der Aufsplitten-POST lehnen ein nicht passendes Konto mit Feldfehler `kontoId` bzw. Zeilenfehler ab («Dieses Konto kann nicht für <Typ> verwendet werden.»); Typ `rapport` bleibt vom Filter ausgenommen.

- [ ] **Step 1: Failing tests:** `kontoErlaubtFuerTyp` Wahrheitstabelle (3×2); Kontierung als Rechnung mit Gutschrift-Konto per Hand im POST → 400 und Job unverändert (Review Focus 5); Gutschrift mit Rechnungs-Konto → 400; inaktives Konto → 400; `beides` in beiden Typen akzeptiert; Aufsplitten mit nicht passender Zeile → Fehler an dieser Zeile, nichts gespeichert; GET-Formular enthält `data-buchungsart` an jeder Option.
- [ ] **Step 2:** → FAIL. **Step 3:** Umsetzen. **Step 4:** `node --test test/unit/kontenRepo.test.js test/integration/kontierung.test.js test/integration/splitgruppen-e2e.test.js test/integration/cspSweep.test.js` → PASS. **Step 5: Commit** `feat: Konto-Auswahl folgt dem Typ Rechnung/Gutschrift`

### Task 15: Spesen und Kreditkarten-Belege, Doku

**Files:**
- Modify: `src/routes/spesen.js` (`alleKonten` Z. 45/59 → `filterKontenFuerTyp(..., 'rechnung')` und serverseitige Prüfung), `src/routes/kkAbgleich.js` (Z. 91), `src/routes/kreditkarte.js` (Z. 73, 140) mit demselben Muster; Doku `docs/admin-bereich.md`, `docs/rechnungs-workflow.md`, `docs/spesen-einreichung.md`, `docs/kreditkarten-belege.md`, `docs/datenmodell.md`, Test-Runbook
- Test: `test/integration/spesen.test.js`, `test/integration/kkAbgleich.test.js`, `test/integration/kreditkarte.test.js`

- [ ] **Step 1: Failing tests:** Spesen-Formular bietet kein reines Gutschrift-Konto an, POST mit solchem Konto → Fehler; gleiches für KK-Abgleich und Beleg-Bearbeitung; `beides` und `rechnung` bleiben wählbar.
- [ ] **Step 2:** → FAIL. **Step 3:** Umsetzen, Doku nachziehen. **Step 4:** `npm test` → PASS. **Step 5: Commit** `feat: Spesen und Kreditkarten-Belege nutzen nur Rechnungs-Konten`

---

## Abschluss

- [ ] `npm test` vollständig grün; `git grep -n "requireRole(config, 'superadmin')" src/app.js` leer.
- [ ] Browser-Prüfung (manuell, Desktop): Gruppenrechte-Matrix, Personenliste mit Herkunft, Wartungsseite und Banner, Konto-Filter beim Typwechsel. n8n-Workflow auf 503/Retry prüfen (Doku-Hinweis in Task 12).
