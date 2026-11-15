# Vertragsverwaltung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verträge und Abos zentral erfassen, Kündigungsfristen berechnen, Eigentümer bzw. Verwaltung rechtzeitig erinnern und eskalieren, Vertragsdokumente in Nextcloud ablegen und Software-Abos optional nach Snipe-IT übertragen.

**Architecture:** Neue Tabellen `vertrag_kategorien` und `vertraege` (eigene Schema-Datei), ein additives Recht `vertraege_verwalten`, reine Datumslogik in `services/vertraege.js`, ein täglicher Job `vertrag-erinnerungen` nach dem Muster `kk-beleg-erinnerungen`, Seiten unter `/vertraege` (Eigentümer-gefilterte Sicht) und `/admin/vertraege`. Audit läuft automatisch über die DB-Trigger-Map in `securitySchema.js`. Dokumente liegen in Nextcloud (WebDAV, serverseitig ausgeliefert, Prüfsumme je Datei); Snipe-IT wird direkt per REST-API angesprochen (kein n8n, wie ChurchTools). Beide Anbindungen sind optional: Ausfall oder fehlende Einrichtung blockiert weder Vertragsdaten noch Erinnerungen.

**Tech Stack:** Node 22 (eingebautes `fetch`), Express, EJS, multer (memoryStorage), node:sqlite, `node --test` + supertest + undici `MockAgent`.

**Spec:** `docs/superpowers/specs/2026-09-10-vertragsmanagement-design.md` (inkl. Ergänzung 2026-11-11: Abo-Felder).

**Reihenfolge und Abnahme-Etappen:** Tasks 1–7 = Kern (lauffähig und releasefähig ohne Nextcloud/Snipe-IT), Tasks 8–11 = Nextcloud-Dokumente, Tasks 12–13 = Snipe-IT, Task 14 = Sweeps, Doku, Release. Nach Task 7, 11 und 13 ist der Stand jeweils grün und mergebar.

**Vorabklärungen, die vor dem Produktivbetrieb (nicht vor der Umsetzung) erledigt sein müssen** (Tests laufen gegen Fakes):
- Nextcloud: technisches Konto mit Zugriff nur auf den Basisordner, App-Passwort, Ordner `Vertraege/` nicht pauschal freigeben.
- Snipe-IT: Version, eingeschränkt berechtigter API-Token, Lizenzkategorie-ID, Feldzuordnung aus Task 13 gegen die echte Installation prüfen (Task 13, Step 6).

## Global Constraints

- Neues Recht heisst exakt `vertraege_verwalten`; Label «Verträge verwalten».
- Personen-IDs sind `TEXT` (`personen.churchtools_person_id`), **nicht** INTEGER wie im Spec-SQL.
- Beträge `TEXT` (CHF), Datumswerte ISO `YYYY-MM-DD`; «heute» in Zeitzone `Europe/Zurich`.
- Job `vertrag-erinnerungen`: täglich, Standard 06:00 Europe/Zürich; Config-Schlüssel `vertrag_erinnerung_vorlauf_tage` = `'30'`, `vertrag_eskalation_vorlauf_tage` = `'7'`.
- Mailtypen `vertrag-erinnerung` (Variablen `%anbieter% %kategorie% %fristDatum% %link%`) und `vertrag-eskalation` (zusätzlich `%eigentuemerName%`), beide plus `%portalName%`.
- Status: `aktiv` → `gekuendigt` → `ausgelaufen`. Keine Erinnerungen für `gekuendigt`/`ausgelaufen`.
- Verlängerungsintervall: Dropdown 1/3/6/12/24 Monate plus «Andere» mit freier Zahl ≥ 1 (Spec-Review-Punkt entschieden). Löschen ist hart (Spec-Review-Punkt entschieden); der Audit-Trigger sichert den Snapshot in `audit_ereignisse`.
- Alle Texte Du-Form, Deutsch (Schweiz, kein ß). Kommentare im Code deutsch.
- Jede neue POST-Route ist CSRF-geschützt und in den Sweep-Tests eingetragen.
- Nextcloud: Umgebungsvariablen `NEXTCLOUD_URL` (https), `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`, `NEXTCLOUD_BASE_FOLDER` (Standard `Vertraege`); alle optional, ohne `NEXTCLOUD_URL` ist die Dokumentfunktion aus. Erlaubt PDF/JPG/PNG, höchstens 20 MB (Typ per Dateikennung, nicht per Dateiendung). Pfade entstehen nur serverseitig unter dem Basisordner; es gibt weder externe URLs noch Freigabelinks. Zugangsdaten tauchen nie in Browser, Logs, Audit oder Datei-URLs auf.
- Snipe-IT: `admin_config`-Schlüssel `snipeit_aktiv`, `snipeit_url` (https), `snipeit_token` (der Schlüsselname enthält `token`, daher schwärzt der Audit-Trigger den Wert automatisch), `snipeit_kategorie_id`. Übertragen werden nur Produktname, Lizenzanzahl, Lizenznehmer-E-Mail, Anbieter und ein ausdrücklich gepflegtes `lizenz_ablauf`. **Nie** Kündigungsfrist als Ablauf, **nie** Kosten, **nie** Zuweisungen. Kündigen/Löschen eines Vertrags ruft Snipe-IT nicht auf.

## Review Focus

- Eigentümer ist deaktivierte Person: Erinnerung geht trotzdem an die Verwaltung statt ins Leere.
- Job lief mehrere Zyklen nicht (Portal war aus): Termin rückt auf den ersten Termin ≥ heute, nicht nur um einen Zyklus.
- Monatsende: 31.01. + 1 Monat = 28.02. (29.02. im Schaltjahr), und der Folgetermin springt wieder auf den 31. zurück (Anker = Tag von `vertragsbeginn`).
- Kündigungsfrist länger als Intervall (Frist-Stichtag liegt vor dem letzten Termin): Erinnerung ist sofort fällig, keine Mehrfachmails im selben Zyklus.
- Parallel laufender Cron-Aufruf (Scheduler + manuell): keine doppelte Mail (Marker und Einreihen in einer Transaktion).
- Eigentümer ohne Verwaltungsrecht ruft fremden Vertrag per ID auf: 403, nicht 404-Leak über Existenz; nicht numerische ID: 404.
- Nextcloud-Ausfall mitten im Upload: kein Erfolg angezeigt, keine Zeile im Status «aktiv», Wiederholung überschreibt nie eine vorhandene Datei.
- Datei extern geändert, verschoben oder gelöscht: verständlicher Hinweis, nie stillschweigend als Original ausgeliefert.
- Snipe-IT-Anlage mit unklarem Ausgang (Timeout): Wiederholung gleicht zuerst ab und legt keine zweite Lizenz an.
- Eigentümer ändert per manipuliertem POST `eigentuemer_person_id` oder `kategorie_id` einer deaktivierten Kategorie: Eigentümerwechsel wird ignoriert, inaktive Kategorie abgelehnt.
- `kosten_betrag` mit Komma/Apostroph («1'200,50»): wird normalisiert oder mit Fehler abgelehnt, nie stillschweigend falsch gespeichert.

---

### Task 1: Recht `vertraege_verwalten`

**Files:**
- Modify: `src/services/berechtigungKatalog.js`, `src/db/gruppenBerechtigungenRepo.js`, `src/db/index.js` (Aufruf in `openDatabase`), `src/db/schema.sql` (CHECK-Liste nachziehen)
- Test: `test/unit/berechtigungKatalog.test.js`, `test/unit/permissions.test.js`, `test/unit/gruppenBerechtigungenRepo.test.js` (neu falls nicht vorhanden)

**Interfaces:**
- Produces: `'vertraege_verwalten'` in `GRANTABLE_BERECHTIGUNGEN`, `BERECHTIGUNG_LABELS`, Bereich «Stammdaten»; Startwert nur Superadmin (in `NICHT_FUER_MANAGER`). `ergaenzeSuperadminRecht(db: DatabaseSync, recht: string): void` in `gruppenBerechtigungenRepo.js` (idempotent `INSERT OR IGNORE` für Gruppe `superadmin`).

- [ ] **Step 1: Failing tests.** Katalog: Recht hat Label, liegt in genau einem Bereich, `startwerteFuerGruppe('superadmin')` enthält es, `'manager'` und `'buchhaltung'` nicht. `permissions.test.js`: die erwartete sortierte Rechteliste (Zeile 17) um das Recht erweitern. Repo: auf einer Datenbank, deren `gruppen_berechtigungen` bereits Zeilen hat, aber nicht dieses Recht, vergibt `openDatabase` es Superadmin nach dem Öffnen (Test baut DB, löscht die Zeile, ruft `ergaenzeSuperadminRecht` zweimal, erwartet genau eine Zeile).
- [ ] **Step 2: Run** `node --test test/unit/berechtigungKatalog.test.js test/unit/permissions.test.js` → FAIL.
- [ ] **Step 3: Implement.** Katalog-Einträge ergänzen; `ergaenzeSuperadminRecht` schreiben; in `openDatabase` nach `seedGruppenBerechtigungen` aufrufen. Begründung im Kommentar: `seedGruppenBerechtigungen` läuft nur einmal, ein neues Recht würde bestehenden Superadmins sonst fehlen. Die `person_berechtigungen`-CHECK-Liste baut `securitySchema.js` aus dem Katalog neu auf; `schema.sql` nur der Konsistenz halber anpassen.
- [ ] **Step 4: Run** dieselben Tests plus `node --test test/unit/securitySchema.test.js test/unit/db.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Recht vertraege_verwalten`.

---

### Task 2: Schema, Mailtypen, Cron-Job-Name, Config-Defaults

**Files:**
- Create: `src/db/vertraegeSchema.js`
- Modify: `src/db/index.js` (Aufruf vor `migrateSecuritySchema`, zwei `erweitereCheckPerRebuild`-Aufrufe), `src/db/securitySchema.js` (Tabellen in die Trigger-Map), `src/db/adminConfigRepo.js` (DEFAULTS), `src/services/mailTemplates.js` (`TYP_ZU_KEY_INFIX`)
- Test: `test/unit/vertraegeSchema.test.js`

**Interfaces:**
- Produces: `migrateVertraegeSchema(db): void` (idempotent). Tabelle `vertrag_kategorien(id, name UNIQUE, aktiv)`, vorbelegt mit «Internet», «Versicherung», «Software-Abo», «Miete», «Wartung», «Sonstiges» (nur wenn Tabelle neu/leer). Tabelle `vertraege` wie im Spec, plus Abo-Spalten: `vertragsart TEXT NOT NULL DEFAULT 'sonstiges' CHECK IN ('abo','versicherung','miete','wartung','sonstiges')`, `produkt`, `lizenzplaetze INTEGER`, `konto_email`, `verwaltungslink`, `passwortmanager_ref`, `zahlungsweg CHECK IN ('rechnung','lastschrift','firmenkarte')` (nullable), `kreditkarte_id INTEGER REFERENCES kreditkarten(id)`, `kostenstelle`, `automatische_verlaengerung INTEGER NOT NULL DEFAULT 1`, `nutzungsende TEXT`, `lizenz_ablauf TEXT` (nur für Task 13; getrennt von Kündigungsfrist und Nutzungsende). Personenspalten (`eigentuemer_person_id`, `gekuendigt_von_person_id`) sind `TEXT REFERENCES personen(churchtools_person_id)`. Index `vertraege_eigentuemer_idx(eigentuemer_person_id)`.
- Produces: `mail_log.typ` akzeptiert `'vertrag-erinnerung'`, `'vertrag-eskalation'`; `cron_log.job` akzeptiert `'vertrag-erinnerungen'`. `TYP_ZU_KEY_INFIX` kennt beide (`vertrag_erinnerung`, `vertrag_eskalation`). DEFAULTS: die zwei Vorlauf-Schlüssel, `cron_vertrag_erinnerungen_stunde='6'`, `_minute='0'`, `vertrag_erinnerungen_aktiv='1'`, je Mailtyp `mail_vorlage_<infix>_betreff|_text` mit den Spec-Variablen.

- [ ] **Step 1: Failing tests.** (a) Frische DB: beide Tabellen existieren, Kategorien vorbelegt, `INSERT` mit `status='bogus'` wirft. (b) `INSERT INTO mail_log (typ…)` mit beiden neuen Typen und `INSERT INTO cron_log (job…)` mit `'vertrag-erinnerungen'` gelingt, auch auf einer DB, die vorher mit altem CHECK geöffnet wurde (bestehende Zeilen bleiben erhalten). (c) `INSERT/UPDATE/DELETE` auf `vertraege` erzeugt je ein `audit_ereignisse`-Ereignis mit `objekt='vertraege'`. (d) `getVorlage(db,'vertrag-erinnerung')` liefert Betreff und Text, die `%anbieter%`, `%fristDatum%`, `%link%` enthalten.
- [ ] **Step 2: Run** `node --test test/unit/vertraegeSchema.test.js` → FAIL.
- [ ] **Step 3: Implement** `migrateVertraegeSchema`. Die beiden CHECK-Erweiterungen kopieren die **aktuelle** Spaltenliste und CHECK-Werte aus `migrateRapportChecks` (`src/db/index.js:1204-1270`) und hängen die neuen Werte an; sie laufen nach `migrateBetrugserkennungChecks` und vor `migrateSecuritySchema` (Kommentar dort: Rebuilds verwerfen Trigger). Tabellen-Map in `securitySchema.js`: `vertraege: 'id'`, `vertrag_kategorien: 'id'`.
- [ ] **Step 4: Run** Test aus Step 2 plus `node --test test/unit/securitySchema.test.js test/unit/db.test.js test/unit/mailTemplates.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Schema, Mailtypen und Standardwerte`.

---

### Task 3: Datumslogik

**Files:**
- Create: `src/services/vertraege.js`
- Test: `test/unit/vertraege.test.js`

**Interfaces:**
- Produces (alle rein, Datumswerte als `'YYYY-MM-DD'`-Strings):
  - `addMonate(iso: string, monate: number, ankerTag?: number): string` — Monatsende-Klemmung; `ankerTag` (Standard: Tag von `iso`) ist der gewünschte Tag, auf den ein späterer Monat zurückspringt.
  - `fristDatum(termin: string, kuendigungsfristTage: number): string` — `termin − tage`.
  - `ruecktTermin(termin: string, intervallMonate: number, heute: string, ankerTag: number): string` — erster Termin ≥ `heute`, den man durch wiederholtes `addMonate` ab `termin` erreicht; wirft bei `intervallMonate < 1`.
  - `zuerichHeute(jetzt?: Date): string`.
  - `normalisiereBetrag(eingabe: string): string | null` — akzeptiert `1200`, `1'200.50`, `1200,5`; liefert `'1200.50'`, `null` bei leerer Eingabe, wirft `Error('Ungültiger Betrag')` sonst.

- [ ] **Step 1: Failing tests.** `addMonate('2026-01-31',1)==='2026-02-28'`; `addMonate('2028-01-31',1)==='2028-02-29'`; `addMonate('2026-02-28',1,31)==='2026-03-31'`; `addMonate('2026-11-30',3)==='2027-02-28'`; `fristDatum('2027-01-01',30)==='2026-12-02'`; `ruecktTermin('2025-01-31',1,'2026-11-12',31)==='2026-11-30'`; `ruecktTermin('2026-12-01',12,'2026-11-12',1)==='2026-12-01'` (nicht in der Vergangenheit → unverändert); `ruecktTermin(…,0,…)` wirft; `zuerichHeute(new Date('2026-06-30T22:30:00Z'))==='2026-07-01'`; Beträge wie oben, `normalisiereBetrag('abc')` wirft.
- [ ] **Step 2: Run** `node --test test/unit/vertraege.test.js` → FAIL.
- [ ] **Step 3: Implement** mit UTC-Datumsarithmetik (`Date.UTC`), keine Fremdbibliothek.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Fristen- und Verlängerungslogik`.

---

### Task 4: Repository und Zugriffsregeln

**Files:**
- Create: `src/db/vertraegeRepo.js`, `src/services/vertraegeZugriff.js`
- Test: `test/unit/vertraegeRepo.test.js`, `test/unit/vertraegeZugriff.test.js`

**Interfaces:**
- Consumes: Task 2 (Tabellen), Task 3 (`normalisiereBetrag`).
- Produces in `vertraegeRepo.js`:
  - `listKategorien(db, { nurAktive?: boolean }): Kategorie[]`, `createKategorie(db, name): number` (wirft bei Duplikat `Error('Kategorie existiert bereits')`), `setKategorieAktiv(db, id, aktiv: boolean): void`.
  - `createVertrag(db, felder): number`, `updateVertrag(db, id, felder): void` (setzt `aktualisiert_am`), `getVertrag(db, id): Vertrag|undefined` (inkl. `kategorie_name`, `eigentuemer_name`), `deleteVertrag(db, id): void`.
  - `listVertraege(db, { eigentuemerId?: string, kategorieId?: number, status?: string, fristInTagen?: number, heute: string }): Vertrag[]` — sortiert nach Fristdatum aufsteigend; `fristInTagen` filtert aktive Verträge mit `fristDatum ≤ heute+N`.
  - `kuendige(db, id, personId, jetzt: string): void` — nur aus `aktiv`; setzt `status`, `gekuendigt_am`, `gekuendigt_von_person_id`; wirft `Error('Vertrag ist nicht aktiv')` sonst.
  - `listFaelligeFuerJob(db): Vertrag[]` — alle `aktiv` plus alle `gekuendigt` (für den Ablauf).
  - `hatEigeneVertraege(db, personId): boolean`.
- Produces in `vertraegeZugriff.js`:
  - `kannVerwalten(db, config, person): boolean` (= `personHasPermission(…,'vertraege_verwalten')`).
  - `kannSehen(db, config, person, vertrag): boolean` (Verwaltung oder Eigentümer).
  - `kannNeuAnlegen`, `kannEigentuemerWechseln`, `kannLoeschen` = `kannVerwalten`.
  - `personenMitVerwaltungsrecht(db, config): Person[]` — aktive Personen mit Recht (Gruppe oder Einzelrecht), für die Eskalation.

- [ ] **Step 1: Failing tests.** Repo: Anlegen/Lesen/Aktualisieren/Löschen; `listVertraege({eigentuemerId})` liefert nur eigene; `fristInTagen` Grenzfälle (genau N Tage = enthalten, N+1 = nicht); `kuendige` zweimal wirft; doppelte Kategorie wirft; deaktivierte Kategorie fehlt in `listKategorien({nurAktive:true})`. Zugriff: Superadmin und Person mit Einzelrecht sehen alles; Eigentümer sieht nur eigenen; Fremder nein; `personenMitVerwaltungsrecht` enthält keine deaktivierte Person.
- [ ] **Step 2: Run** beide Dateien → FAIL.
- [ ] **Step 3: Implement.** SQL mit Parametern; Fristdatum zur Laufzeit per `date(naechster_verlaengerungstermin, '-' || kuendigungsfrist_tage || ' days')` (Spec: nicht redundant speichern).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Repository und Zugriffsregeln`.

---

### Task 5: Täglicher Job `vertrag-erinnerungen`

**Files:**
- Modify: `src/services/cronJobs.js`, `src/services/scheduler.js`, `src/routes/cron.js`, `src/routes/admin/geplanteJobs.js`, `views/admin/geplante-jobs.ejs`, `docs/geplante-jobs-und-benachrichtigungen.md`
- Test: `test/unit/cronJobsVertraege.test.js`, `test/integration/cron.test.js` (erweitern), `test/integration/admin/geplanteJobs.test.js` (erweitern), `test/unit/scheduler.test.js` (erweitern)

**Interfaces:**
- Consumes: Tasks 2–4, `reiheBenachrichtigungEin`, `stelleEintraegeZu`, `planeInTransaktion`, `tageAusConfig`, `abschlussMitBilanz` (alle in `cronJobs.js`/`notify.js`).
- Produces: `runVertragErinnerungenJob(db, config, mailer, jetzt = new Date()): Promise<{status, erinnerungen, eskalationen, verlaengert, ausgelaufen, mails}>`, via `auditedJob('vertrag-erinnerungen', …)`. `jetzt` ist injizierbar (Spec: gefaketes «heute»). Route `POST /internal/cron/vertrag-erinnerungen`, Admin-Route `POST /admin/geplante-jobs/vertrag-erinnerungen/jetzt-ausfuehren`, Scheduler-Eintrag mit `cron_vertrag_erinnerungen_stunde/_minute`, Test-Fake-Default `async () => ({ status: 'uebersprungen' })` wie bei den anderen Jobs.

Ablauf je Vertrag in **einer** `planeInTransaktion` (Reihenfolge laut Spec in einem Lauf): `gekuendigt` und Termin < heute → `ausgelaufen`. `aktiv`: Erinnerung fällig (`heute ≥ frist − erinnerungVorlauf` und `erinnerung_gesendet_am IS NULL`) → Mail an Eigentümer, Marker; Eskalation fällig (`heute ≥ frist − eskalationVorlauf`, Marker leer) → Mail an `personenMitVerwaltungsrecht`, Marker; danach Termin < heute → `ruecktTermin(…, ankerTag = Tag von vertragsbeginn)`, beide Marker auf NULL. Ist der Eigentümer inaktiv oder fehlt die E-Mail, geht die Erinnerung an die Verwaltung (Marker wird trotzdem gesetzt). Jede Statusänderung/Verlängerung erzeugt automatisch ein Audit-Ereignis (Trigger); zusätzlich `logCronLauf` mit Bilanz. Modulschalter `vertrag_erinnerungen_aktiv !== '1'` → `{status:'uebersprungen'}`.

- [ ] **Step 1: Failing tests** (mit fester `jetzt`, in-memory-DB, Fake-Mailer): Vertrag 40 Tage vor Frist → keine Mail; 30 Tage → 1 Mail `vertrag-erinnerung` an Eigentümer, zweiter Lauf am selben Tag → keine weitere; 7 Tage → 1 Mail `vertrag-eskalation` an alle Verwaltungsberechtigten; Termin gestern → Termin rückt, Marker leer; Portal 3 Zyklen aus (monatliches Intervall) → Termin ≥ heute; `gekuendigt` bekommt nie Mails, wird nach Termin `ausgelaufen`; `ausgelaufen` bleibt unberührt; Eigentümer inaktiv → Mail geht an Verwaltung; Frist länger als Intervall → genau eine Erinnerung und eine Eskalation pro Zyklus; Modul aus → `uebersprungen`; zwei parallele Aufrufe (`Promise.all`) → insgesamt nur eine Mail pro Typ. Integration: `POST /internal/cron/vertrag-erinnerungen` ohne Secret → 401, mit Secret → 200.
- [ ] **Step 2: Run** `node --test test/unit/cronJobsVertraege.test.js` → FAIL.
- [ ] **Step 3: Implement** nach dem Muster `runKkBelegErinnerungenJobInternal` (`cronJobs.js:771`). Header-Kommentar von `cronJobs.js` und `scheduler.js` (Jobzahl 16 → 17) nachziehen. Admin-Seite: Zeitplan-Felder, Log-Liste und Knopf analog `kk-beleg-erinnerungen`.
- [ ] **Step 4: Run** Tests aus Step 1 plus `node --test test/unit/scheduler.test.js test/unit/cronJobs.test.js test/integration/cron.test.js test/integration/admin/geplanteJobs.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): täglicher Job für Erinnerung, Eskalation und Auto-Verlängerung`.

---

### Task 6: Seiten für Eigentümer und Verwaltung

**Files:**
- Create: `src/routes/vertraege.js`, `views/vertraege.ejs`, `views/vertrag.ejs`, `views/vertrag-formular.ejs`
- Modify: `src/app.js` (Mount `app.use('/vertraege', sessionLimiter, requireLogin(), createVertraegeRouter({ db, config, csrfProtection }))`), `src/services/navigation.js` (Punkt «Verträge», Gruppe «Arbeit», Symbol `file-earmark-text`, Flag `vertraegeSichtbar`; Symbol in `SYMBOLE` aufnehmen, danach `node scripts/baueSymbole.js`), `src/middleware/nav.js` (träge `vertraegeSichtbar` = `kannVerwalten || hatEigeneVertraege`; an `bauePortalGruppen` durchreichen)
- Test: `test/integration/vertraege.test.js`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `createVertraegeRouter({ db, config, csrfProtection }): Router` mit den Routen aus dem Spec (ohne Dokumente): `GET /` (Filter Kategorie/Status/«Frist in 90 Tagen»; Verwaltung alle, Eigentümer eigene, sonst 403), `GET /neu` und `POST /` (nur Verwaltung), `GET /:id`, `GET /:id/bearbeiten`, `POST /:id` (Eigentümer: Beschreibung, Kosten, Abo-Zusatzfelder, Zahlungsweg, Nutzungsende; Verwaltung zusätzlich Anbieter, Kategorie, Eigentümer, Laufzeit/Frist/Termin), `POST /:id/kuendigen` (Eigentümer oder Verwaltung), `POST /:id/loeschen` (nur Verwaltung; ab Task 10 zusätzlich: zuerst alle Dokumente über `loescheAlleDokumente` entfernen, bleibt eines offen, wird der Vertrag **nicht** gelöscht und die Seite meldet «Dokumente konnten nicht gelöscht werden, bitte erneut versuchen»). Ungültige ID → 404 (`/^\d+$/`), nicht berechtigt → 403 `error`-View. Validierung: Pflichtfelder, `kosten_betrag` über `normalisiereBetrag`, nur aktive Kategorien wählbar, Eigentümer muss aktive Person sein, `verlaengerungsintervall_monate ≥ 1`, `kuendigungsfrist_tage ≥ 0`. Fehler wie in `routes/kreditkarte.js` als Liste im Formular. Kündigen/Löschen mit Bestätigungsdialog wie `_bestaetigen_dialog.ejs`. Detailseite zeigt Status «gekündigt, läuft aus am …» und Fristdatum; Kündigung ist getrennt von «Nutzungsende» (Spec: Frist, Intervall und Nutzungsende bleiben getrennte Angaben).

- [ ] **Step 1: Failing tests** (Login wie in `test/integration/admin/wartungsmodus.test.js`): Verwaltung sieht alle; Eigentümer sieht nur eigene Zeile in der Liste; Person ohne beides → 403 auf `GET /vertraege`; Eigentümer `GET /vertraege/<fremde id>` → 403; `/vertraege/abc` → 404; Eigentümer `POST /vertraege/neu`-Pendant (`POST /vertraege`) → 403; Eigentümer `POST /:id` mit fremdem `eigentuemer_person_id` → Eigentümer unverändert; `POST` mit inaktiver Kategorie → 400/Formularfehler und nichts gespeichert; `kosten_betrag='1\'200,50'` → gespeichert als `1200.50`; `kuendigen` setzt Status, zweites Mal → Fehlermeldung, keine zweite Änderung; `loeschen` durch Eigentümer → 403, durch Verwaltung → Zeile weg und Audit-DELETE-Ereignis vorhanden; Menüpunkt «Verträge» erscheint für Eigentümer und Verwaltung, nicht für andere (`GET /pool` HTML enthält/enthält nicht `/vertraege`).
- [ ] **Step 2: Run** `node --test test/integration/vertraege.test.js` → FAIL.
- [ ] **Step 3: Implement.** Views verwenden die Shell-Partials (`_seite_anfang.ejs`/`_seite_ende.ejs`), das CSRF-Token in jedem Formular und die Tabellen/Kachel-Umschaltung nur, wenn sie sich ohne Mehraufwand wiederverwenden lässt (sonst nur Tabelle). Inline-`<script>`/`<style>` mit `nonce` (siehe `test/integration/cspSweep.test.js`).
- [ ] **Step 4: Run** Test aus Step 1 plus `node --test test/integration/cspSweep.test.js test/integration/layoutSweep.test.js test/unit/navigation.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Übersicht, Detail, Bearbeiten, Kündigen, Löschen`.

---

### Task 7: Admin → Verträge (Kategorien und Vorlaufzeiten)

**Files:**
- Create: `src/routes/admin/vertraege.js`, `views/admin/vertraege.ejs`
- Modify: `src/app.js` (Mount `/admin/vertraege` mit `requirePermission(db, config, 'vertraege_verwalten')`), `src/services/navigation.js` (Admin-Gruppe «Stammdaten», Punkt «Verträge», Flag `vertraege`), `src/middleware/nav.js` (`adminNav.vertraege`), `src/routes/admin/gruppenrechte.js` nur falls die Matrix das Recht nicht automatisch aus dem Katalog zeigt
- Test: `test/integration/admin/vertraege.test.js`

**Interfaces:**
- Consumes: Task 4 (`listKategorien`, `createKategorie`, `setKategorieAktiv`), `setConfigValue`.
- Produces: `GET /admin/vertraege`, `POST /admin/vertraege/kategorien` (anlegen), `POST /admin/vertraege/kategorien/:id/aktiv` (Body `aktiv=0|1`), `POST /admin/vertraege/einstellungen` (zwei Vorlauftage). Validierung: ganze Zahlen ≥ 1, `eskalation_vorlauf_tage ≤ erinnerung_vorlauf_tage`, sonst Fehler und nichts gespeichert. Das Spec nennt `GET/POST /admin/vertraege/kategorien`; hier bewusst **eine** Seite `/admin/vertraege` (Kategorien und Einstellungen zusammen, wie im Spec-Text «eigene Seite Admin → Verträge»).

- [ ] **Step 1: Failing tests:** Person ohne Recht → 403 auf GET und jede POST-Route; Kategorie anlegen/Duplikat → Fehlermeldung; deaktivieren → fehlt im Auswahl-Dropdown von `GET /vertraege/neu`, bestehender Vertrag behält sie; Einstellungen speichern (30/7) und ungültige (7/30, `0`, `abc`) abgelehnt.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** Test plus `node --test test/integration/admin/authz-sweep.test.js test/integration/admin/gruppenrechte.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Admin-Seite für Kategorien und Vorlaufzeiten`.

---

### Task 8: Nextcloud-WebDAV-Client und Konfiguration

**Files:**
- Create: `src/services/nextcloudClient.js`, `test/helpers/fakeNextcloud.js`
- Modify: `src/config/env.js` (Feld `config.nextcloud: {url, user, appPassword, baseFolder} | null`; `url` muss mit `https://` beginnen, sonst Startfehler; User und Passwort Pflicht, sobald `NEXTCLOUD_URL` gesetzt ist; Passwort wird **nicht** auf 32 Zeichen geprüft, App-Passwörter sind kürzer), `src/app.js` (`createApp({ db, config, …, nextcloudClient })`: Standard `config.nextcloud ? createNextcloudClient(config.nextcloud) : null`)
- Test: `test/unit/nextcloudClient.test.js`, `test/unit/env.test.js` (erweitern)

**Interfaces:**
- Produces in `nextcloudClient.js`:
  - `class NextcloudFehler extends Error { code: 'ausfall' | 'nicht_gefunden' | 'konflikt' | 'abgelehnt' }` — `ausfall` für Netzfehler, Timeout (10 s), 5xx; `abgelehnt` für 401/403.
  - `createNextcloudClient({ url, user, appPassword, baseFolder }, { fetchImpl = fetch } = {}): NextcloudClient` mit
    `ensureFolder(relPfad: string): Promise<void>` (MKCOL je Ebene, 405 = existiert = ok),
    `putFile(relPfad: string, buffer: Buffer, mime: string): Promise<{ etag: string, fileId: string | null }>` (Header `If-None-Match: *`; 412 → `konflikt`, **nie** überschreiben),
    `getFile(relPfad): Promise<{ buffer: Buffer, etag: string }>` (404 → `nicht_gefunden`),
    `statFile(relPfad): Promise<{ etag: string, fileId: string | null, groesse: number } | null>` (PROPFIND Depth 0, `getetag`, `oc:fileid`, `getcontentlength`; 404 → `null`),
    `deleteFile(relPfad): Promise<void>` (404 gilt als gelöscht),
    `ping(): Promise<void>` (PROPFIND auf den Basisordner).
  - `sichererRelPfad(relPfad: string): string` — wirft `Error('Ungültiger Pfad')` bei `..`, absolutem Pfad, Backslash, Steuerzeichen oder leerem Segment; percent-codiert jedes Segment. Alle Client-Methoden rufen es auf; der Basisordner wird dem Pfad immer vom Client vorangestellt.
- Produces in `test/helpers/fakeNextcloud.js`: `fakeNextcloud(): NextcloudClient & { dateien: Map<string, {buffer, etag}>, ausfall: boolean, ausfallNach: number | null }` — dieselbe Schnittstelle im Speicher; `ausfall = true` lässt jede Methode `NextcloudFehler('ausfall')` werfen; `ausfallNach = n` lässt die n+1-te `putFile`-Anfrage scheitern. Die Route-Tests (Tasks 10–11) nutzen ihn.

- [ ] **Step 1: Failing tests.** `sichererRelPfad('../x')`, `'a//b'`, `'/etc'`, `'a\\b'`, `'a/../b'` werfen; `'123-adobe/uuid.pdf'` ok. Mit undici-`MockAgent` gegen `https://cloud.example.org`: `putFile` sendet `PUT /remote.php/dav/files/<user>/<baseFolder>/<pfad>` mit Basic-Auth und `If-None-Match: *`; 201 liefert `etag` (ohne Anführungszeichen) und `fileId` aus `OC-FileId`; 412 → `code === 'konflikt'`; 503 und Timeout → `'ausfall'`; 401 → `'abgelehnt'`; `statFile` 404 → `null`; `getFile` 404 → `'nicht_gefunden'`; `deleteFile` 404 → ok. `NextcloudFehler.message` und `String(err)` enthalten weder Passwort noch Benutzer-Header. env: `NEXTCLOUD_URL=http://…` → Startfehler; URL ohne User → Startfehler; ohne alle vier Variablen `config.nextcloud === null`.
- [ ] **Step 2: Run** `node --test test/unit/nextcloudClient.test.js test/unit/env.test.js` → FAIL.
- [ ] **Step 3: Implement** mit eingebautem `fetch` und `AbortSignal.timeout(10_000)`. `fileId` nur aus der Antwort, nie aus Benutzereingaben.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Nextcloud-WebDAV-Client`.

---

### Task 9: Tabelle `vertrag_dokumente` und Dokumentenservice

**Files:**
- Modify: `src/db/vertraegeSchema.js`, `src/db/securitySchema.js` (Trigger-Map `vertrag_dokumente: 'id'`)
- Create: `src/db/vertragDokumenteRepo.js`, `src/services/vertragDokumente.js`
- Test: `test/unit/vertragDokumente.test.js`

**Interfaces:**
- Consumes: Task 8 (`NextcloudClient`, `NextcloudFehler`, `fakeNextcloud`), `detectBelegMimetype(buffer)` aus `src/services/belegAnhaengen.js`.
- Produces: Tabelle `vertrag_dokumente` wie im Spec, ergänzt um `status TEXT NOT NULL DEFAULT 'ausstehend' CHECK (status IN ('ausstehend','aktiv','loeschung_offen'))`, `erstellt_am TEXT NOT NULL`, `pruefung_hinweis TEXT`; `vertrag_id` mit `ON DELETE RESTRICT`. `sha256`, `etag`, `nextcloud_datei_id` sind bei `ausstehend` leer erlaubt (`sha256` wird erst im Wechsel zu `aktiv` gesetzt; Spalte daher nullable, CHECK `status <> 'aktiv' OR sha256 IS NOT NULL`).
- Produces in `vertragDokumenteRepo.js`: `reserviereDokument(db, {vertragId, originalName, mime, groesse, relPfad, personId}): number` (Status `ausstehend`; `nextcloud_pfad` UNIQUE), `markiereAktiv(db, id, {sha256, etag, fileId}): void`, `markiereLoeschungOffen(db, id): void`, `entferneZeile(db, id): void` (nur erlaubt bei `ausstehend` oder `loeschung_offen`, sonst wirft), `listDokumente(db, vertragId)`, `getDokument(db, id)`, `listOffeneBereinigungen(db, { aelterAlsMinuten }): Dokument[]` (ausstehend älter als N min oder `loeschung_offen`), `aktualisiereNachweis(db, id, {sha256, etag})`, `ordnePfadNeuZu(db, id, relPfad)`.
- Produces in `vertragDokumente.js` (alle erhalten `client` als Parameter; `client === null` → `Error('Nextcloud nicht eingerichtet')`):
  - `ladeDokumentHoch(db, client, { vertrag, datei: { buffer, originalname, mimetype }, personId }): Promise<Dokument>` — Ablauf: Dateikennung prüfen und gegen `mimetype` abgleichen, ≤ 20 MB; SHA-256 bilden; interner Name `<uuid>.<pdf|jpg|png>`, Ordner `<vertragId>-<slug(anbieter)>` (Slug `[a-z0-9-]`, max. 30 Zeichen; Ordner wird nur beim ersten Dokument bestimmt, danach aus vorhandenen Dokumenten übernommen); **erst** `reserviereDokument`, dann `ensureFolder` + `putFile`, dann `markiereAktiv`. Scheitert `putFile`, wird die reservierte Zeile wieder entfernt (bei `konflikt` oder `ausfall`); scheitert `markiereAktiv`, wird die Datei best-effort gelöscht und die Zeile bleibt `ausstehend` für die Bereinigung.
  - `liefereDokument(db, client, dokumentId): Promise<{ buffer, mime, dateiname }>` — wirft `DokumentFehler` mit `code` `'fehlt'` (Datei weg), `'geaendert'` (SHA-256 abweichend) oder `'ausfall'`. Ablauf: `statFile`; ETag gleich → `getFile` + SHA prüfen; ETag anders → `getFile` + SHA prüfen, bei gleicher SHA nur ETag nachführen, bei anderer SHA `geaendert` und `pruefung_hinweis` setzen. Es wird nie ein Inhalt mit abweichender Prüfsumme geliefert.
  - `loescheDokument(db, client, dokumentId): Promise<{ geloescht: boolean }>` — setzt `loeschung_offen`, `deleteFile`, erst bei Erfolg `entferneZeile`; bei Fehler bleibt die Zeile sichtbar (`geloescht: false`).
  - `loescheAlleDokumente(db, client, vertragId): Promise<{ offen: number }>`.
  - `uebernehmeGeaenderteFassung(db, client, dokumentId): Promise<void>` — liest die aktuelle Datei, prüft Typ und Grösse, setzt neue `sha256`/`etag`, leert `pruefung_hinweis` (Audit-Trigger protokolliert alt/neu).
  - `ordneDateiNeuZu(db, client, dokumentId, relPfad): Promise<void>` — `sichererRelPfad`, Pfad muss im Ordner des Vertrags liegen, `statFile` muss existieren; `getFile` + Typ-/Grössenprüfung; setzt Pfad, `sha256`, `etag`, `nextcloud_datei_id`.
  - `bereinigeDokumente(db, client): Promise<{ bereinigt: number, offen: number }>` — für `ausstehend` älter als 60 min: Datei löschen (404 ok), Zeile entfernen; für `loeschung_offen`: Löschung erneut versuchen.
  - `class DokumentFehler extends Error { code }`.

- [ ] **Step 1: Failing tests** (alle mit `fakeNextcloud`): Upload PDF ok → Zeile `aktiv`, SHA gleich Datei, Datei im Fake; `.exe` mit `.pdf`-Endung und Mime `application/pdf` → abgelehnt, nichts im Fake; 20 MB + 1 Byte → abgelehnt; Ausfall bei `putFile` → Fehler, **keine** Zeile mehr; `ausfallNach` so gesetzt, dass `putFile` klappt, aber die Zeile nicht aktiv werden kann (Test ruft `markiereAktiv` per Spy-Fehler) → Zeile `ausstehend`, danach `bereinigeDokumente` mit manipuliertem `erstellt_am` (vor 2 h) entfernt Datei und Zeile; zweiter Upload derselben Datei erzeugt neuen internen Namen und überschreibt nichts; `liefereDokument` ok; Inhalt im Fake geändert → `DokumentFehler('geaendert')` und Bytes nicht geliefert; Datei im Fake entfernt → `'fehlt'`; `ausfall = true` → `'ausfall'`; Löschen bei Ausfall → `{geloescht:false}`, Zeile `loeschung_offen` und weiter sichtbar in `listDokumente`; danach Ausfall aus → `bereinigeDokumente` löscht; `ordneDateiNeuZu(..., '../x')` wirft; `ordneDateiNeuZu` auf Pfad ausserhalb des Vertragsordners wirft; `uebernehmeGeaenderteFassung` setzt neue SHA und erzeugt Audit-UPDATE auf `vertrag_dokumente`; `INSERT … status='aktiv'` ohne `sha256` wirft.
- [ ] **Step 2: Run** `node --test test/unit/vertragDokumente.test.js` → FAIL.
- [ ] **Step 3: Implement.** Reihenfolge «Zeile reservieren → Datei schreiben → Zeile aktivieren» ersetzt die fehlende gemeinsame Transaktion: ein Abbruch hinterlässt immer eine sichtbare, bereinigbare `ausstehend`-Zeile, nie eine unbekannte Datei.
- [ ] **Step 4: Run** → PASS; dazu `node --test test/unit/vertraegeSchema.test.js`.
- [ ] **Step 5: Commit** `feat(vertraege): Dokumentenservice mit Prüfsumme und Bereinigung`.

---

### Task 10: Dokument-Routen und Anzeige

**Files:**
- Modify: `src/routes/vertraege.js`, `views/vertrag.ejs`, `src/app.js` (Client an den Router durchreichen)
- Create: `views/_vertrag_dokumente.ejs`
- Test: `test/integration/vertraegeDokumente.test.js`

**Interfaces:**
- Consumes: Tasks 4, 6, 9; `createVertraegeRouter({ db, config, csrfProtection, nextcloudClient })`.
- Produces: `POST /vertraege/:id/dokumente` (Feld `datei`, multer `memoryStorage`, `limits: { fileSize: 20 MB, files: 1 }`, CSRF und Audit-Kontext wie `POST /kreditkarte`), `GET /vertraege/:id/dokumente/:docId` (Header `Content-Type` aus der Datenbank, `Content-Disposition: inline; filename*=UTF-8''<name>`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`), `POST /vertraege/:id/dokumente/:docId/loeschen`, und nur für Verwaltung `POST /vertraege/:id/dokumente/:docId/uebernehmen` und `POST /vertraege/:id/dokumente/:docId/neu-zuordnen` (Feld `pfad`). Zugriff überall: Eigentümer oder Verwaltung, geprüft **vor** jedem Nextcloud-Aufruf; das Dokument muss zum Vertrag in der URL gehören (sonst 404). Fehlerabbildung: `DokumentFehler('fehlt'|'geaendert')` → Seite 409 mit Hinweis «Die Datei wurde in Nextcloud geändert/verschoben oder gelöscht. Bitte Verwaltung kontaktieren.», `NextcloudFehler('ausfall')` → 503 «Nextcloud ist gerade nicht erreichbar, bitte später erneut versuchen» (kein Erfolgshinweis, Formular bleibt), `client === null` → Detailseite zeigt «Dokumentablage nicht eingerichtet», Upload-Formular fehlt, Upload-POST → 409. Statusanzeige je Dokument (aktiv / Prüfhinweis / «Löschung offen»); Vertragsdetail lädt trotz Ausfall (Dokumentliste kommt aus der Datenbank, Prüfung erst beim Öffnen).

- [ ] **Step 1: Failing tests** (`fakeNextcloud`, drei Personen wie in Task 6): Eigentümer lädt PDF hoch → Redirect, Zeile `aktiv`; fremde Person → 403 und Fake unverändert; Upload mit `ausfall = true` → 503, keine Zeile, Seite enthält keine Erfolgsmeldung; Download durch Eigentümer liefert exakt die Bytes und die Header oben; Download durch Fremden → 403 ohne dass der Fake angefragt wurde (Spy-Zähler 0); Dokument von Vertrag A über URL von Vertrag B → 404; Inhalt im Fake manipuliert → 409, Antwort enthält die manipulierten Bytes nicht; `docId` nicht numerisch → 404; Antwort-HTML und Header enthalten weder Nextcloud-URL noch Zugangsdaten noch `remote.php`; Eigentümer ruft `/uebernehmen` → 403, Verwaltung → 302 und neue SHA; `neu-zuordnen` mit `pfad=../../x` → Fehlermeldung, nichts geändert; Vertrag löschen bei `ausfall = true` mit Dokument → Vertrag bleibt, Dokument `loeschung_offen`, Meldung sichtbar; nach `ausfall = false` und erneutem Löschen → Vertrag und Dokumente weg.
- [ ] **Step 2: Run** `node --test test/integration/vertraegeDokumente.test.js` → FAIL.
- [ ] **Step 3: Implement.** Multer-Fehler (`LIMIT_FILE_SIZE`) als Formularfehler «Die Datei darf höchstens 20 MB gross sein.»; keine Datei → «Bitte eine Datei auswählen.».
- [ ] **Step 4: Run** Test plus `node --test test/integration/vertraege.test.js test/integration/cspSweep.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Dokument-Upload, -Anzeige und -Löschung`.

---

### Task 11: Bereinigung im Tagesjob, Verbindungstest, Anzeige offener Bereinigungen

**Files:**
- Modify: `src/services/cronJobs.js` (Job aus Task 5), `src/routes/admin/vertraege.js`, `views/admin/vertraege.ejs`
- Test: `test/unit/cronJobsVertraege.test.js` (erweitern), `test/integration/admin/vertraege.test.js` (erweitern)

**Interfaces:**
- Consumes: Task 9 (`bereinigeDokumente`, `listOffeneBereinigungen`), Task 5 (Job). `runVertragErinnerungenJob(db, config, mailer, jetzt?, { nextcloudClient } = {})` — Client optional, Standard aus `config.nextcloud`.
- Produces: Der Job ruft **nach** dem Erinnerungsteil `bereinigeDokumente` in eigenem `try/catch` auf; ein Nextcloud-Fehler ändert den Jobstatus nicht auf `fehler`, steht aber in den `details` (`Dokumente: bereinigt N, offen M, Nextcloud-Fehler: ausfall`). `POST /admin/vertraege/bereinigung` (Verwaltung) stösst `bereinigeDokumente` manuell an. `POST /admin/vertraege/nextcloud-test` ruft `client.ping()` und zeigt «Verbindung ok» oder die Fehlerart (nie Zugangsdaten). Die Admin-Seite listet `listOffeneBereinigungen(db, { aelterAlsMinuten: 0 })` mit Vertrag, Dateiname, Status.

- [ ] **Step 1: Failing tests.** Job mit `ausfall = true`: Erinnerungsmails gehen trotzdem raus, Status bleibt `erfolg`, `details` nennt den Ausfall; Job mit alter `ausstehend`-Zeile → Datei und Zeile weg, in `details` gezählt; Admin-Seite ohne Recht → 403 (alle neuen POSTs); `nextcloud-test` mit Fake ok → «Verbindung ok», mit `ausfall` → Hinweis ohne Passwort im HTML; offene Bereinigungen erscheinen in der Liste.
- [ ] **Step 2: Run** beide Testdateien → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Dokumentbereinigung im Tagesjob, Verbindungstest`.

---

### Task 12: Snipe-IT-Client, Tabelle und Übertragungslogik

**Files:**
- Modify: `src/db/vertraegeSchema.js`, `src/db/securitySchema.js` (Trigger-Map `vertrag_snipeit: 'vertrag_id'`), `src/db/adminConfigRepo.js` (DEFAULTS `snipeit_aktiv='0'`, `snipeit_url=''`, `snipeit_token=''`, `snipeit_kategorie_id=''`)
- Create: `src/services/snipeitClient.js`, `src/db/vertragSnipeitRepo.js`, `src/services/snipeitSync.js`, `test/helpers/fakeSnipeit.js`
- Test: `test/unit/snipeitClient.test.js`, `test/unit/snipeitSync.test.js`

**Interfaces:**
- Produces: Tabelle `vertrag_snipeit(vertrag_id INTEGER PRIMARY KEY REFERENCES vertraege(id) ON DELETE CASCADE, lizenz_id INTEGER UNIQUE, status TEXT NOT NULL CHECK (status IN ('anlage_laeuft','anlage_unklar','verknuepft','veraltet','fehler')), letzter_erfolg_am TEXT, letzter_fehler TEXT, verknuepft_am TEXT, verknuepft_von TEXT REFERENCES personen(churchtools_person_id))`. `lizenz_id UNIQUE` verhindert, dass dieselbe Snipe-IT-Lizenz an zwei Verträgen hängt.
- Produces in `snipeitClient.js`: `class SnipeitFehler extends Error { code: 'ausfall'|'abgelehnt'|'nicht_gefunden'|'ungueltig' }`; `createSnipeitClient({ url, token }, { fetchImpl = fetch } = {})` mit `ping()`, `getLizenz(id)`, `sucheLizenzen(suchtext)`, `legeLizenzAn(nutzlast)`, `aktualisiereLizenz(id, nutzlast)`, `sucheHersteller(name)`; Timeout 10 s; Header `Authorization: Bearer <token>`; Fehlermeldungen enthalten nie den Token; Snipe-IT antwortet teils mit HTTP 200 und `{"status":"error"}` im Body, das zählt als `ungueltig`. URL muss `https://` sein (sonst wirft die Fabrik).
- Produces in `snipeitSync.js`:
  - `baueNutzlast(vertrag, { herstellerId, kategorieId, portalLink }): object` (rein) — `{ name: vertrag.produkt || vertrag.anbieter, seats: vertrag.lizenzplaetze, license_email: vertrag.konto_email, notes: 'Portal-Vertrag #<id> · <portalLink>' (+ Zeile «Anbieter: <anbieter>», wenn kein `herstellerId`), manufacturer_id?, category_id, expiration_date?: vertrag.lizenz_ablauf }` — Felder ohne Wert fehlen im Objekt; enthält nie `purchase_cost`, Zuweisungen, Kündigungsfrist oder Nutzungsende.
  - `snipeitClientAusConfig(db): SnipeitClient | null` (nur wenn `snipeit_aktiv === '1'` und URL/Token gesetzt).
  - `verknuepfeBestehende(db, client, vertragId, lizenzId, personId): Promise<void>` — prüft per `getLizenz`, dass sie existiert; `lizenz_id` bereits an anderem Vertrag → `Error('Lizenz ist bereits mit einem anderen Vertrag verknüpft')`; schreibt nur die Verknüpfung, **überträgt nichts** (Bestandsdaten bleiben unberührt, bis ausdrücklich übertragen wird).
  - `legeNeuAn(db, client, vertragId, personId, ctx): Promise<void>` — setzt `anlage_laeuft`; gleicht **zuerst** ab (`sucheLizenzen('Portal-Vertrag #<id>')`, Treffer nur wenn `notes` den Marker enthält) und verknüpft einen Treffer statt neu anzulegen; sonst `legeLizenzAn`; bei `ausfall`/Timeout → `anlage_unklar` (nicht `fehler`), die Wiederholung beginnt wieder mit dem Abgleich.
  - `uebertrage(db, client, vertragId, ctx): Promise<void>` — nur bei vorhandener `lizenz_id`; `aktualisiereLizenz`; Erfolg → `verknuepft` + `letzter_erfolg_am`, Fehler → `fehler` + `letzter_fehler` (Text ohne Token).
  - `markiereVeraltet(db, vertragId): void` (nur wenn verknüpft).
- Produces in `fakeSnipeit.js`: In-Memory-Fake derselben Schnittstelle mit `lizenzen: Map`, Schalter `ausfall` und `ausfallNachAnlage` (Lizenz wird angelegt, die Antwort aber als Timeout geworfen — der Fall «unklarer Ausgang»), Zähler `aufrufe`.

- [ ] **Step 1: Failing tests.** Client (undici-Mock): Bearer-Header gesetzt, 401 → `abgelehnt`, 200 mit `status:'error'` → `ungueltig`, `SnipeitFehler.message` enthält den Token nicht, `http://`-URL wirft. Nutzlast: Vertrag mit Kündigungsfrist 30, `nutzungsende` und `kosten_betrag` gesetzt → Nutzlast enthält keinen davon; `lizenz_ablauf` leer → kein `expiration_date`-Schlüssel (auch wenn Termin gesetzt ist); `lizenz_ablauf` gesetzt → übernommen; Anbieter ohne Hersteller-Treffer → steht in `notes`. Sync: Neuanlage legt genau eine Lizenz an; `ausfallNachAnlage` → Status `anlage_unklar`, Lizenz existiert im Fake; **zweiter** `legeNeuAn`-Aufruf legt keine zweite an (Fake zählt 1) und verknüpft die vorhandene; `verknuepfeBestehende` auf bereits belegte Lizenz wirft, Fake unverändert; `verknuepfeBestehende` ändert die Lizenz im Fake nicht; zweimaliges `uebertrage` → ein Update-Aufruf pro Lauf, keine Neuanlage; Update schreibt keine Zuweisungsfelder (Fake-Lizenz behält seine `zugewiesen`-Liste); Snipe-IT-Ausfall bei `uebertrage` → Status `fehler`, `letzter_fehler` gesetzt, `uebertrage` wirft nicht, sondern speichert den Fehlerstatus (die Route in Task 13 braucht kein eigenes Abfangen dafür); Audit-Ereignis für `admin_config` mit Schlüssel `snipeit_token` enthält `[redacted]` und nie den Token.
- [ ] **Step 2: Run** `node --test test/unit/snipeitClient.test.js test/unit/snipeitSync.test.js` → FAIL.
- [ ] **Step 3: Implement.** Eingabe-Marker `Portal-Vertrag #<id>` als Konstante `PORTAL_MARKER(id)` in `snipeitSync.js`; kein Fremdcode zum Zusammenbauen von URLs ausser `new URL(pfad, basis)` und `encodeURIComponent` für Suchtexte.
- [ ] **Step 4: Run** → PASS; dazu `node --test test/unit/securitySchema.test.js`.
- [ ] **Step 5: Commit** `feat(vertraege): Snipe-IT-Client und Übertragungslogik`.

---

### Task 13: Snipe-IT-Oberfläche, Admin-Einstellungen und Abnahme gegen die Zielinstallation

**Files:**
- Modify: `src/routes/vertraege.js`, `views/vertrag.ejs`, `views/vertrag-formular.ejs` (Felder aus Task 2 inkl. `lizenz_ablauf`, nur bei Vertragsart `abo` sichtbar), `src/routes/admin/vertraege.js`, `views/admin/vertraege.ejs`
- Create: `views/_vertrag_snipeit.ejs`
- Test: `test/integration/vertraegeSnipeit.test.js`, `test/integration/admin/vertraege.test.js` (erweitern)

**Interfaces:**
- Consumes: Tasks 6, 7, 12; `createVertraegeRouter({ …, snipeitClientFactory = () => snipeitClientAusConfig(db) })` (Fabrik, damit Tests den Fake einspeisen).
- Produces (alle nur `vertraege_verwalten`, sonst 403, geprüft vor jedem Client-Aufruf): `POST /vertraege/:id/snipeit/verknuepfen` (Feld `lizenz_id`, positive ganze Zahl), `POST /vertraege/:id/snipeit/neu`, `POST /vertraege/:id/snipeit/uebertragen`. Admin: `POST /admin/vertraege/snipeit` (Felder `aktiv`, `url`, `kategorie_id`, `token`; leeres `token` = bestehenden Wert behalten; URL muss `https://` sein), `POST /admin/vertraege/snipeit-test` (`ping()`, Ausgabe «Verbindung ok» oder Fehlerart). Der Token wird nie im HTML ausgegeben (nur «gesetzt / nicht gesetzt»).
  Automatik: `POST /vertraege/:id` ruft nach erfolgreichem Speichern, **wenn** der Vertrag verknüpft ist, Snipe-IT aktiv ist und die speichernde Person `vertraege_verwalten` hat, `uebertrage` in `try/catch` auf (Fehler blockieren das Speichern nie, stehen aber in der Statuszeile). Speichert ein Eigentümer ohne Verwaltungsrecht, wird nur `markiereVeraltet` gesetzt. Kündigen und Löschen rufen den Client **nicht** auf.
  Die Detailseite zeigt für Verwalter: Status, letzter Erfolg, letzter Fehler, die Liste «Diese Felder führt das Portal und überschreibt sie in Snipe-IT: Name, Lizenzanzahl, Lizenznehmer-E-Mail, Anbieter, Lizenzablauf (falls gepflegt). Zuweisungen werden nicht verändert.» direkt am Verknüpfen-Knopf, und die Schaltflächen «Vorhandene Lizenz verknüpfen», «Neue Lizenz anlegen», «Erneut übertragen».

- [ ] **Step 1: Failing tests** (`fakeSnipeit` per Fabrik): Eigentümer ohne Verwaltungsrecht → 403 auf alle drei Routen, `fake.aufrufe === 0`; Verwaltung verknüpft → Status `verknuepft`, Lizenz im Fake unverändert; zweiter Vertrag mit derselben `lizenz_id` → Fehlermeldung; «Neu anlegen» zweimal nacheinander (zweiter Klick nach `ausfallNachAnlage`) → genau eine Lizenz; Speichern durch Verwaltung bei `ausfall` → Vertrag gespeichert, Statuszeile `fehler`; Speichern durch Eigentümer → Status `veraltet`, Fake nicht aufgerufen; Kündigen und Löschen → `fake.aufrufe` unverändert und Lizenz bleibt; Vertragsbearbeitung und `jobs`-Erinnerungsmails laufen bei `ausfall` normal weiter; Admin: Token-Speichern → `GET /admin/vertraege` enthält den Token nicht; `http://`-URL abgelehnt; leeres Token-Feld behält den alten Wert; Audit-Ereignis zeigt `[redacted]`.
- [ ] **Step 2: Run** `node --test test/integration/vertraegeSnipeit.test.js test/integration/admin/vertraege.test.js` → FAIL.
- [ ] **Step 3: Implement.** Eingabe `lizenz_id` strikt `/^\d+$/`; Fehlermeldungen aus `SnipeitFehler` auf Deutsch abbilden (`ausfall` → «Snipe-IT ist nicht erreichbar», `abgelehnt` → «Zugriff von Snipe-IT abgelehnt (Token prüfen)», `ungueltig` → «Snipe-IT hat die Daten abgelehnt»).
- [ ] **Step 4: Run** Tests aus Step 1 plus `node --test test/integration/vertraege.test.js test/integration/cspSweep.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(vertraege): Snipe-IT verknüpfen, übertragen, Admin-Einstellungen`.
- [ ] **Step 6 (manuell, vor Produktivbetrieb, nicht automatisierbar):** gegen die echte Snipe-IT-Installation mit einem eingeschränkten Token prüfen und in `docs/vertraege.md` festhalten: (a) Version und dass `POST/PUT /api/v1/licenses` die Felder `name, seats, license_email, expiration_date, category_id, manufacturer_id, notes` akzeptieren; (b) dass `GET /api/v1/licenses?search=<Marker>` Verträge anhand `notes` findet, sonst `sucheLizenzen` in `snipeitClient.js` auf Abruf aller Lizenzen mit Filterung im Portal umstellen; (c) dass ein `PUT` mit weniger Plätzen als zugewiesen abgelehnt wird (Fehler sichtbar, Zuweisung unverändert); (d) Testlauf an einer Wegwerf-Lizenz: verknüpfen, übertragen, Vertrag kündigen und löschen → Lizenz bleibt unangetastet.

---

### Task 14: Sweeps, Dokumentation, Release-Notiz

**Files:**
- Modify: `test/integration/csrfSweep.test.js` (`SESSION_POST_ROUTES` um alle neuen POST-Routen, auch Upload, Dokument-, Snipe-IT- und Admin-Routen), `test/sicherheit/zugriffSweep.test.js` und `test/integration/admin/authz-sweep.test.js` (neue Routen eintragen), `docs/auth-und-rechte.md` (Recht, Zugriffsmodell), `docs/admin-bereich.md`, `docs/datenmodell.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/n8n-schnittstelle.md` nur falls Cron-Liste dort steht, `docs/code-landkarte.md`, `docs/README.md`, neu `docs/vertraege.md` (Bedienung, Rechte, Nextcloud-Einrichtung, Snipe-IT-Feldzuordnung, **gemeinsamer Restore Portal + Nextcloud mit Prüfsummenkontrolle als Betriebsabnahme-Checkliste**; Portal-Backup enthält die PDFs nicht), `.env.example` und README-Abschnitt Konfiguration (Nextcloud-Variablen), `docs/testdrehbuch/` (Testfälle Vertrag anlegen/kündigen/Erinnerung), `CHANGELOG.md`, `package.json` (Version 1.3.0)
- Test: die genannten Sweep-Dateien

- [ ] **Step 1: Failing sweeps.** Neue Routen in die Sweep-Listen eintragen, bevor etwas anderes angefasst wird; die Sweeps schlagen fehl, wo ein Gatter fehlt.
- [ ] **Step 2: Run** `node --test test/integration/csrfSweep.test.js test/sicherheit/zugriffSweep.test.js test/integration/admin/authz-sweep.test.js test/sicherheit/asyncHandlerSweep.test.js` → alle neuen Routen grün (jede Route nutzt `asyncHandler`, wo sie `await` nutzt).
- [ ] **Step 3: Docs** wie oben; Mermaid-Ablauf aus dem Spec in `geplante-jobs-und-benachrichtigungen.md` übernehmen. Spec-Status auf «Genehmigt» setzen und die beiden Review-Punkte als entschieden vermerken.
- [ ] **Step 4: Gesamtsuite** `npm test -- --test-concurrency=2` (ca. 6,5 min) → alles grün.
- [ ] **Step 5: Commit** `docs(vertraege): Dokumentation, Sweeps, Version 1.3.0`.
