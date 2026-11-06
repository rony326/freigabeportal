# Rapporte (nur zur Kenntnis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein dritter Belegweg «Rapport»: Das Accounting markiert einen Beleg als «Nur zur Kenntnis» und wählt Empfänger. Alle müssen bestätigen. Wer liegen lässt, wird erinnert und eskaliert. Abgeschlossene Rapporte holt n8n ausschliesslich über `/api/n8n/rapporte` ab und archiviert sie.

**Architecture:** Ein Rapport bleibt eine `jobs`-Zeile mit `typ = 'rapport'`. Der offene Zustand ist der neue Status `kenntnisnahme`. Abschluss, Abholung und Archivierung nutzen weiter `abgeschlossen` / `abgeholt` / `archiviert`. Jede Abfrage mit Rechnungsfachlichkeit schliesst `typ = 'rapport'` aus. Die Empfänger stehen in der neuen Tabelle `kenntnisnahmen`. Die Fachlogik liegt in `src/db/rapporteRepo.js` (SQL) und `src/services/rapporte.js` (Abläufe, Mails, Stempel). Der Paperless-Exportcode in `archiveReceipt.js` bekommt einen Parameter `art`, damit beide Endpunktfamilien denselben Code nutzen und sich gegenseitig ausschliessen.

**Tech Stack:** Node ≥ 22 (`node:sqlite` `DatabaseSync`), Express 4, EJS, pdf-lib, `node --test`.

**Spec:** [docs/superpowers/specs/2026-11-06-rapporte-kenntnisnahme-design.md](../specs/2026-11-06-rapporte-kenntnisnahme-design.md)

## Global Constraints

- n8n-Endpunkt-Präfix: `/api/n8n/rapporte`. Auth `requireApiKey(config)` (`N8N_API_KEY`), `machineLimiter`.
- `jobs.typ`-Wert: `'rapport'`. Neuer `jobs.status`-Wert: `'kenntnisnahme'`.
- Rapporte dürfen **nie** in `/api/n8n/jobs/*` erscheinen oder dort quittierbar sein (404).
- Config-Keys und Defaults: `modul_rapporte_aktiv` = `'0'`, `rapport_reminder_stunden` = `'72'`, `rapport_eskalation_stunden` = `'168'`, `rapport_eskalation_empfaenger` = `''` (leer = Admin-Gruppe, gleiche Auflösung wie `freigabe2_eskalation_empfaenger` via `resolveEmpfaenger`), `cron_rapport_erinnerungen_intervall_minuten` = `'60'`.
- Mail-Typen: `rapport-zuweisung`, `rapport-reminder`, `rapport-eskalation` (Vorlagen-Infix `rapport_zuweisung` usw.).
- `freigaben.rolle`-Werte: `rapport_markiert`, `rapport_bestaetigt`, `rapport_empfaenger_ersetzt`, `rapport_empfaenger_entfernt`, `rapport_markierung_aufgehoben`.
- `cron_log.job`-Wert: `rapport-erinnerungen`.
- Eingriffsrecht für Ersetzen, Entfernen und Aufheben durch Dritte: `workflow_eingreifen`.
- Ferienmodus wird ignoriert: Nur die genannte Person bestätigt. Mails gehen ohne Vertretung (`reiheBenachrichtigungEin`, **nicht** `…MitVertretungEin`).
- Mindestlänge Begründung für Ersetzen/Entfernen: `MIN_BEMERKUNG_LAENGE` aus `src/services/vorgangUmhaengen.js` (10).
- Alle POST-Formulare mit `csrfProtection`. `test/integration/csrfSweep.test.js` muss grün bleiben.
- UI-Texte auf Deutsch (CH, «ss» statt «ß»). Neue Seiten nutzen die Shell-Partials wie `views/pool.ejs`.

## Review Focus

1. **Zwei gleichzeitige letzte Bestätigungen** (zwei Empfänger klicken zeitgleich): genau ein Abschluss, ein finales PDF, keine verwaiste `final-*.pdf`. → Test in Task 4.
2. **Fehlmarkierung bei einem Spesen-, Kreditkarten- oder Splitkind-Job** per manipuliertem POST: 409, nichts geändert. → Test in Task 3.
3. **Empfänger wird nach der Markierung deaktiviert** (Personen-Sync): keine Erinnerung an ihn, Rapport wird ohne Wartezeit eskaliert. → Test in Task 5.
4. **Bestehender Rechnungs-Workflow sieht Rapporte nicht**: kein Eintrag in `/abholbereit`, `/admin/altfaelle` oder Pool/Kontierungsliste, `abholung-bestaetigen` liefert 404. → Test in Task 7.
5. **Doppeltes Absenden / Zurück-Knopf** beim Bestätigen und Ersetzen: idempotent, keine zweite `freigaben`-Zeile. → Test in Task 4 und Task 6.

---

### Task 1: Schema-Migrationen und Defaults

**Files:**
- Modify: `src/db/schema.sql` (jobs-Status-CHECK um `'kenntnisnahme'`; `freigaben.rolle`, `mail_log.typ`, `cron_log.job` um die neuen Werte; neue Tabelle `kenntnisnahmen`)
- Modify: `src/db/index.js` (neue Migrationen, Reihenfolge in `openDatabase`, `JOBS_TABLE_MIGRATIONS`)
- Modify: `src/db/securitySchema.js:116` (`kenntnisnahmen: 'id'` in `tables`)
- Modify: `src/db/adminConfigRepo.js` (Defaults inkl. drei Mail-Vorlagen)
- Modify: `src/services/mailTemplates.js` (`TYP_ZU_KEY_INFIX` + drei Einträge)
- Modify: `src/routes/admin/mailEinstellungen.js:32` + View (sechs Felder `rapportZuweisungBetreff/Text`, `rapportReminderBetreff/Text`, `rapportEskalationBetreff/Text`)
- Modify: `src/services/notify.js:25` (`rapport-reminder`, `rapport-eskalation` in `IMMER_SOFORT_TYPEN`, gleich wie `freigabe2-reminder`/`-eskalation`; `rapport-zuweisung` folgt der Bündelungs-Einstellung wie `zuweisung`)
- Test: `test/unit/db.test.js`, `test/unit/mailTemplates.test.js`, `test/integration/admin/mailEinstellungen.test.js` (die sechs Felder speichern)

**Interfaces:**
- Produces: Tabelle `kenntnisnahmen(id INTEGER PK, job_id INTEGER NOT NULL REFERENCES jobs(id), person_id TEXT NOT NULL REFERENCES personen(churchtools_person_id), zugeteilt_am TEXT NOT NULL, bestaetigt_am TEXT, entfernt_am TEXT, entfernt_von TEXT, begruendung TEXT, ersetzt_durch_id INTEGER REFERENCES kenntnisnahmen(id), erinnert_am TEXT)`. Index `(job_id)`. Partieller UNIQUE-Index `(job_id, person_id) WHERE bestaetigt_am IS NULL AND entfernt_am IS NULL`.
- Produces: jobs-Spalten `rapport_markiert_von TEXT`, `rapport_markiert_am TEXT`, `rapport_bemerkung TEXT`, `rapport_eskaliert_am TEXT` (über `JOBS_TABLE_MIGRATIONS`).
- Trigger `kenntnisnahmen_bestaetigt_unveraenderlich`: `BEFORE UPDATE ... WHEN OLD.bestaetigt_am IS NOT NULL` → ABORT. Trigger `kenntnisnahmen_no_delete` → ABORT.

- [ ] **Step 1: Failing tests in `test/unit/db.test.js`**

```js
test('jobs akzeptiert status kenntnisnahme nach Migration einer Alt-DB', ...)
  // Alt-DB mit dem heutigen jobs-CHECK + einer freigaben-Zeile + Trigger trg_zeitstempel_hash_unveraenderlich anlegen,
  // openDatabase() → INSERT status='kenntnisnahme' klappt;
  // PRAGMA foreign_key_check liefert [];
  // sqlite_master enthält weiterhin idx_jobs_datei_hash und trg_zeitstempel_hash_unveraenderlich;
  // freigaben.sql referenziert "jobs" (nicht "jobs_pre_…").
test('Migration ist idempotent (zweites openDatabase ändert nichts)', ...)
test('kenntnisnahmen: bestätigte Zeile ist unveränderlich, DELETE abgebrochen', ...)
  // UPDATE einer Zeile mit bestaetigt_am → throws /unveraenderlich/; DELETE → throws
test('kenntnisnahmen: dieselbe Person kann nicht zweimal offen auf demselben Job stehen', ...)
test('neue freigaben-rollen, mail_log-typen und cron_log-job sind erlaubt', ...)
test('kenntnisnahmen-Änderungen erscheinen im audit_log', ...)
```

`test/unit/mailTemplates.test.js`: `getVorlage(db, 'rapport-zuweisung')` liefert nicht-leeren Betreff/Text. Gleiches für `rapport-reminder` und `rapport-eskalation`.

- [ ] **Step 2: Run** `node --test test/unit/db.test.js test/unit/mailTemplates.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement `migrateJobsStatusKenntnisnahme(db)` in `src/db/index.js`**

Marker `'kenntnisnahme'` im jobs-SQL. **Nicht** das Rename-alt-Muster von `migrateJobsTableQuelleCheck` verwenden: Modernes SQLite schreibt FK-Verweise anderer Tabellen beim Umbenennen auf den alten Namen um. Stattdessen das SQLite-«12-Schritte»-Verfahren:
1. Vorher alle `sqlite_master`-`sql` mit `tbl_name='jobs' AND type IN ('index','trigger') AND sql IS NOT NULL` merken.
2. `PRAGMA foreign_keys=OFF`, `BEGIN`.
3. `CREATE TABLE jobs_neu`: aktuelles `jobs`-SQL aus `sqlite_master`, Tabellenname ersetzt und Status-Liste per String-Replace um `,'kenntnisnahme'` ergänzt. Wirft, falls die Ersetzung nicht genau einmal greift.
4. Alle Spalten per `PRAGMA table_info(jobs)` kopieren, `DROP TABLE jobs`, `ALTER TABLE jobs_neu RENAME TO jobs`.
5. Gemerkte Indizes und Trigger neu ausführen, dann `PRAGMA foreign_key_check` (nicht leer → throw), `COMMIT`, `foreign_keys=ON`.

Aufruf direkt nach `migrateJobsTableQuelleCheck(db)`. Die übrigen CHECK-Erweiterungen (freigaben, mail_log, cron_log) folgen über `erweitereCheckPerRebuild` mit den vollständigen aktuellen `CREATE`-Statements: `migrateRapportChecks(db)` nach `migrateKommentareSchema`, vor `migrateSecuritySchema`. `migrateRapporteSchema(db)` legt `kenntnisnahmen` + Trigger + Indizes an (`IF NOT EXISTS`).

- [ ] **Step 4: Defaults** in `adminConfigRepo.js` (Keys aus Global Constraints). Mail-Vorlagen mit Variablen:
  - `zuweisung`: `%empfaengerName%`, `%jobDateiname%`, `%markiertVon%`, `%bemerkung%`, `%link%`.
  - `reminder`: `%empfaengerName%`, `%jobDateiname%`, `%stunden%`, `%link%`.
  - `eskalation`: `%jobDateiname%`, `%stunden%`, `%offenePersonen%`, `%link%`.

- [ ] **Step 5: Run** die Tests aus Step 2 plus `node --test test/unit/securitySchema.test.js test/unit/exportIntegritaetSchema.test.js`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(rapporte): Schema, Migrationen und Defaults`

---

### Task 2: Repository `rapporteRepo.js` und Ausschluss im Rechnungsweg

**Files:**
- Create: `src/db/rapporteRepo.js`
- Modify: `src/db/jobsRepo.js` (`listAbholbereitJobs`, `confirmAbholung`, `listZeitstempelAusstehendJobs` unverändert lassen → deckt Rapporte mit ab)
- Modify: `src/services/altfaelle.js:21` (`OFFEN_EINZEL` + `AND COALESCE(j.typ,'') <> 'rapport'`)
- Test: `test/unit/rapporteRepo.test.js`, `test/unit/jobsRepo.test.js`

**Interfaces (Produces, alle synchron, `db` erstes Argument):**
- `markiereAlsRapport(db, jobId, { markiertVon, empfaengerIds: string[], bemerkung: string|null, zeitpunkt }) -> boolean`: nur aus `status='zugewiesen'`. Setzt `typ='rapport'`, `status='kenntnisnahme'`, die vier `rapport_*`-Spalten und leert Konto/Kreditor/Betrag/Zahlungsziel/Rechnungsnummer/Eskalationsfelder. Legt je Empfänger (dedupliziert) eine `kenntnisnahmen`-Zeile an. `false` bei falschem Status.
- `listKenntnisnahmen(db, jobId) -> Row[]` (inkl. entfernte/ersetzte, nach `id`).
- `listOffeneKenntnisnahmen(db, jobId) -> Row[]` (`bestaetigt_am IS NULL AND entfernt_am IS NULL`).
- `bestaetigeKenntnisnahme(db, jobId, personId, zeitpunkt) -> 'bestaetigt'|'bereits'|'nicht_berechtigt'`.
- `schliesseRapportAbWennVollstaendig(db, jobId, zeitpunkt) -> boolean`: `status='kenntnisnahme'` → `'abgeschlossen'`, setzt `abgeschlossen_am`. Nur wenn 0 offen **und** ≥ 1 bestätigt.
- `hebeRapportMarkierungAuf(db, jobId) -> boolean`: nur wenn keine Zeile `bestaetigt_am` hat. Status → `zugewiesen`, `zugewiesen_an = rapport_markiert_von`, `typ = NULL`, `rapport_*` → NULL. Offene Zeilen bekommen `entfernt_am` + `begruendung='Markierung aufgehoben'`, weil DELETE verboten ist.
- `ersetzeEmpfaenger(db, kenntnisnahmeId, { neuePersonId, von, begruendung, zeitpunkt }) -> number|null`: neue Zeilen-ID. Alte bekommt `entfernt_*` + `ersetzt_durch_id`. Setzt `jobs.rapport_eskaliert_am = NULL`.
- `entferneEmpfaenger(db, kenntnisnahmeId, { von, begruendung, zeitpunkt }) -> 'entfernt'|'letzter_offen_ohne_bestaetigung'|'nicht_offen'`.
- `listOffeneRapporteForPerson(db, personId) -> Job[]`.
- `listRapporteFuerErinnerung(db, stunden) -> {kenntnisnahme, job}[]`: offen, `erinnert_am IS NULL`, `zugeteilt_am` älter als `stunden`.
- `markErinnert(db, kenntnisnahmeId) -> boolean`: nur wenn noch NULL.
- `listRapporteFuerEskalation(db, stunden) -> Job[]`: `status='kenntnisnahme'`, `rapport_eskaliert_am IS NULL` und mindestens eine offene Zeile, die älter als `stunden` ist **oder** deren Person `aktiv=0`/`ct_person_unresolved=1` ist.
- `markRapportEskaliert(db, jobId, zeitpunkt) -> boolean`: nur wenn noch NULL.

- [ ] **Step 1: Failing tests** `test/unit/rapporteRepo.test.js`, je eine Funktion:

```js
test('markiereAlsRapport: nur aus zugewiesen, dedupliziert Empfänger, leert Rechnungsfelder')
test('bestaetigeKenntnisnahme: zweiter Aufruf → "bereits", fremde Person → "nicht_berechtigt"')
test('schliesseRapportAbWennVollstaendig: erst nach letzter Bestätigung true, danach status abgeschlossen')
test('hebeRapportMarkierungAuf: false sobald eine Bestätigung existiert')
test('entferneEmpfaenger: letzter Offener ohne jede Bestätigung → "letzter_offen_ohne_bestaetigung"')
test('ersetzeEmpfaenger: setzt rapport_eskaliert_am zurück, neue Zeile zugeteilt_am = zeitpunkt')
test('listRapporteFuerEskalation: inaktiver Empfänger eskaliert sofort, ohne Frist')
```

In `test/unit/jobsRepo.test.js`:

```js
test('listAbholbereitJobs und confirmAbholung ignorieren typ rapport')
  // abgeschlossener Rapport → nicht in Liste; confirmAbholung → null
```

- [ ] **Step 2: Run** `node --test test/unit/rapporteRepo.test.js test/unit/jobsRepo.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** die Funktionen. In `listAbholbereitJobs` / `confirmAbholung`: `AND COALESCE(typ,'') <> 'rapport'`. Altfälle-Filter.
- [ ] **Step 4: Run** dieselben Tests plus `node --test test/unit/*.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): Repository und Ausschluss aus dem Rechnungsweg`

---

### Task 3: Markieren in der Kontierung, Modul-Schalter, Aufheben

**Files:**
- Create: `src/services/rapporte.js`
- Modify: `src/routes/kontierung.js` (GET: `rapportModulAktiv`, `rapportEmpfaengerKandidaten`; POST `/:id` neuer Zweig `aktion === 'rapport'` **vor** jeder Kontierungsvalidierung; neue Route `POST /:id/rapport-aufheben`)
- Modify: `views/kontierung.ejs` (dritter Typ-Radio «Nur zur Kenntnis (Rapport)» nur bei aktivem Modul; blendet per JS Kontierungsfelder aus und Empfänger-Mehrfachauswahl + Bemerkung ein; Submit-Knopf «Zur Kenntnis weitergeben» mit `aktion=rapport`)
- Modify: `src/routes/admin/module.js`, `views/admin/module-form.ejs` (Checkbox `rapporteAktiv` ↔ `modul_rapporte_aktiv`)
- Test: `test/integration/rapporteMarkieren.test.js`, `test/integration/admin/module.test.js`

**Interfaces:**
- Consumes: Task 2 (`markiereAlsRapport`, `hebeRapportMarkierungAuf`).
- Produces in `src/services/rapporte.js`:
  - `listRapportEmpfaengerKandidaten(db) -> Person[]` (aktiv, nicht unresolved, sortiert Nachname/Vorname).
  - `async markiereRapport(db, config, mailer, { job, person, empfaengerIds, bemerkung, ip }) -> { ok: true } | { ok: false, status: 400|409, fehler: string }`. Validiert Modul an, ≥ 1 gültiger Kandidat, Bemerkung ≤ 2000 Zeichen und Job-Zulässigkeit: `quelle IN ('scanner','lieferant')`, kein `aufgesplittet_von`, kein `kreditkarte_id`, kein Splitelternjob. Schreibt in einer Transaktion `freigaben` `rapport_markiert` (Kommentar = Empfängernamen) und reiht pro Empfänger `rapport-zuweisung` ein, Link `${config.publicBaseUrl}/rapporte/${job.id}`.
  - `async hebeRapportAuf(db, config, { jobId, person, ip }) -> { ok } | { ok:false, status, fehler }`. Erlaubt der markierenden Person oder mit `workflow_eingreifen`. Schreibt `rapport_markierung_aufgehoben`.
- Autorisierung des Markierens = bestehende Kontierungs-Autorisierung von `POST /kontierung/:id`. Keine neue Prüfung.

- [ ] **Step 1: Failing tests** `test/integration/rapporteMarkieren.test.js`:

```js
test('Modul aus: Radio fehlt im Formular und POST aktion=rapport → 409, Job unverändert')
test('Modul an: POST mit 2 Empfängern → status kenntnisnahme, 2 kenntnisnahmen, 2 rapport-zuweisung-Mails, freigaben rapport_markiert')
test('ohne Empfänger → 400 mit Fehlermeldung, Job bleibt zugewiesen')
test('Konto/Betrag im selben POST werden ignoriert (konto_id bleibt NULL)')
test('Spesen-, Kreditkarten- und Splitkind-Job → 409')         // Review Focus 2
test('fremde Person (nicht zugewiesen) → 403 wie bei Kontierung')
test('aufheben vor erster Bestätigung → zugewiesen an Markierer; nach Bestätigung → 409')
test('aufheben durch Dritten ohne workflow_eingreifen → 403')
```

`test/integration/admin/module.test.js`: Checkbox speichert `modul_rapporte_aktiv` `'1'`/`'0'`.

- [ ] **Step 2: Run** `node --test test/integration/rapporteMarkieren.test.js test/integration/admin/module.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** Service, Routen, Views.
- [ ] **Step 4: Run** dieselben plus `node --test test/integration/kontierung.test.js test/integration/csrfSweep.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): als Rapport markieren in der Kontierung`

---

### Task 4: Rapport-Seite, Bestätigen, Abschluss mit Vermerk

**Files:**
- Create: `src/routes/rapporte.js` (`GET /:id`, `POST /:id/bestaetigen`), `views/rapport.ejs`
- Modify: `src/app.js` (`app.use('/rapporte', sessionLimiter, requireLogin(), createRapporteRouter({ db, config, mailer, csrfProtection }))`)
- Modify: `src/services/pdfStamp.js` (neu `export async function stampKenntnisnahme(pdfBuffer, data) -> Buffer`)
- Modify: `src/services/rapporte.js` (`async bestaetigeRapport(...)`)
- Modify: `src/services/aufgabenZaehler.js` (+ `listOffeneRapporteForPerson(db, personId).length`)
- Modify: `src/routes/poolPage.js` + `views/pool.ejs` (Abschnitt «Zur Kenntnis» mit den offenen Rapporten der Person, Tabelle/Kachel wie andere Abschnitte)
- Modify: `src/db/jobsRepo.js` `listAbgeschlossenJobsForPerson` (`JOIN konten` → `LEFT JOIN`, zusätzliche Bedingung `OR EXISTS (SELECT 1 FROM kenntnisnahmen k WHERE k.job_id = jobs.id AND k.person_id = ?)` oder `jobs.rapport_markiert_von = ?`; View zeigt bei Rapport «Rapport» statt Konto)
- Modify: `src/services/kommentare.js` (Rapport-Seite als Kommentarort zulassen; `kenntnisnahme` ist kein geschlossener Status)
- Test: `test/integration/rapporteBestaetigen.test.js`, `test/unit/pdfStamp.test.js`, `test/unit/aufgabenZaehler.test.js`, `test/integration/meineAbgeschlossenen.test.js`

**Interfaces:**
- Consumes: Task 2 (`bestaetigeKenntnisnahme`, `schliesseRapportAbWennVollstaendig`, `listKenntnisnahmen`).
- `stampKenntnisnahme(pdfBuffer, { jobId, markiertVon: {name, zeitpunkt}, bemerkung, kenntnisnahmen: [{ name, bestaetigtAm|null, entferntAm|null, entferntVon|null, begruendung|null, ersetztDurch|null }], kommentare, testmodus })`: hängt eine A4-Hochformat-Seite an. Titel `Zur Kenntnis genommen`, darunter `Job-ID`, Weitergegeben von/am, Bemerkung, je Empfänger eine Zeile, danach Kommentare (`drawKommentare` wiederverwenden). Gleiche Fehlermeldung bei ungültigem PDF wie `stampAndFinalize`.
- `async bestaetigeRapport(db, config, { jobId, person, ip }) -> { ok: true, abgeschlossen: boolean } | { ok: false, status, fehler }`. Algorithmus wie Freigabe 2 (`src/routes/freigabe2.js:426-520`):
  1. Bestätigung + `freigaben` `rapport_bestaetigt` in eigener Transaktion committen.
  2. Wenn danach 0 offen: Stempel erstellen, TSA ausserhalb der Transaktion (`setZeitstempelMitNachweis`), `writeFinalDocument`.
  3. Dann `BEGIN`: `schliesseRapportAbWennVollstaendig`. `false` → ROLLBACK + `unlinkSync(tmp)`, gilt als Erfolg ohne Abschluss. Sonst `pdf_pfad`, `final_datei_hash`, `zeitstempel_erforderlich`, ggf. `markZeitstempelGesetzt` + `speichereTsaNachweis`.
  - Scheitert der Stempel, bleibt die Bestätigung gültig und der Rapport bleibt `kenntnisnahme` mit 0 offen. Dann wird `console.error` geloggt, und **Task 5** holt den Abschluss nach (`schliesseRapporteNach`).
- Detailseite: nur für Personen mit (auch früherer) Kenntnisnahme-Zeile, Markierer, Superadmin oder `vorgaenge_einsehen`. Sonst 403. Knopf nur, wenn die Person eine offene Zeile hat.

- [ ] **Step 1: Failing tests** `test/integration/rapporteBestaetigen.test.js`:

```js
test('Empfänger sieht Rapport im Pool-Abschnitt "Zur Kenntnis" und Badge zählt +1')
test('Stellvertretung im Ferienmodus sieht keinen Knopf und POST → 403')
test('erste von zwei Bestätigungen: status bleibt kenntnisnahme, Seite zeigt "1 von 2"')
test('letzte Bestätigung: status abgeschlossen, pdf_pfad zeigt auf final-*.pdf, letzte Seite enthält "Zur Kenntnis genommen" und beide Namen')
test('mit TSA (mockTsa): zeitstempel_gesetzt_am gesetzt; TSA down: zeitstempel_erforderlich = 1, gesetzt_am NULL')
test('doppeltes POST derselben Person → zweite Antwort Redirect, nur eine rapport_bestaetigt-Zeile')     // Review Focus 5
test('zwei letzte Bestätigungen parallel (Promise.all) → genau ein Abschluss, keine verwaiste final-*.pdf')  // Review Focus 1
test('abgeschlossener Rapport erscheint in /meine-abgeschlossenen für Markierer und Empfänger')
test('Kommentar auf offenem Rapport möglich, nach Abschluss nur lesbar')
```

`test/unit/pdfStamp.test.js`: `stampKenntnisnahme` erzeugt +1 Seite. Text enthält Titel und Empfängernamen. Ein Nicht-WinAnsi-Zeichen im Namen wird über `winAnsiSicher` dargestellt und wirft nicht.

- [ ] **Step 2: Run** die Testdateien. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dieselben plus `node --test test/integration/poolPage.test.js test/integration/kachelansicht.test.js test/integration/layoutSweep.test.js test/integration/csrfSweep.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): Kenntnisnahme bestätigen und abschliessen`

---

### Task 5: Erinnerung, Eskalation, Einstellungen

**Files:**
- Modify: `src/services/cronJobs.js` (neu `export const runRapportErinnerungenJob = auditedJob('rapport-erinnerungen', …)`, Muster `runFreigabe2ErinnerungenJobInternal`)
- Modify: `src/services/scheduler.js` (`scheduleInterval` mit `cron_rapport_erinnerungen_intervall_minuten`)
- Modify: `src/routes/cron.js` (`POST /rapport-erinnerungen`), `src/routes/testmodusInstanz.js` (Job-Liste), `src/routes/admin/geplanteJobs.js` + View (Log-Abschnitt)
- Modify: `src/routes/admin/eskalation.js` + View (drei Felder `rapportReminderStunden`, `rapportEskalationStunden`, `rapportEskalationEmpfaenger`, gleiche Validierung wie die Freigabe-2-Felder)
- Modify: `src/services/benachrichtigung.js:70` (`kuerzesteFristStunden` berücksichtigt die zwei neuen Stunden-Keys)
- Test: `test/unit/cronJobs.test.js`, `test/integration/admin/eskalation.test.js`, `test/integration/cron.test.js`

**Interfaces:**
- Consumes: Task 2 (`listRapporteFuerErinnerung`, `markErinnert`, `listRapporteFuerEskalation`, `markRapportEskaliert`), Task 4 (`schliesseRapporteNach`).
- Produces in `src/services/rapporte.js`: `async schliesseRapporteNach(db, config) -> number`. Schliesst Rapporte ab, die in `kenntnisnahme` stehen und 0 offene Kenntnisnahmen haben. Gleicher Stempel- und TSA-Weg wie `bestaetigeRapport`. Wird zu Beginn jedes `rapport-erinnerungen`-Laufs aufgerufen.
- Laufergebnis: `{ status, reminder: number, eskalation: number, nachgeholt: number, mails }`.
- Erinnerung: Mail `rapport-reminder` an die Person (nur aktiv und auflösbar), Link `/rapporte/:id`.
- Eskalation: Mail `rapport-eskalation` an `resolveEmpfaenger(db, config, getConfigValue(db, 'rapport_eskalation_empfaenger'))`. `%offenePersonen%` = Namen, kommagetrennt. Link `/admin/vorgaenge?typ=rapport`.

- [ ] **Step 1: Failing tests** in `test/unit/cronJobs.test.js`:

```js
test('rapport-erinnerungen: Reminder nach 72h genau einmal pro offener Kenntnisnahme')
test('rapport-erinnerungen: bestätigte Personen bekommen keinen Reminder')
test('rapport-erinnerungen: Eskalation nach 168h einmal pro Rapport mit offenen Namen im Text')
test('rapport-erinnerungen: deaktivierter Empfänger → keine Erinnerung, sofortige Eskalation')   // Review Focus 3
test('rapport-erinnerungen: nach Ersetzen wird erneut eskalierbar (rapport_eskaliert_am NULL)')
test('rapport-erinnerungen: Rapport mit 0 offen in kenntnisnahme wird nachgeholt abgeschlossen')
```

`test/integration/admin/eskalation.test.js`: Speichern und Validierung der drei Felder (nicht-numerisch → 400). `test/integration/cron.test.js`: `POST /internal/cron/rapport-erinnerungen` mit Key → 200.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dieselben plus `node --test test/unit/scheduler.test.js test/unit/benachrichtigung.test.js test/integration/admin/geplanteJobs.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): Erinnerung und Eskalation`

---

### Task 6: Vorgänge-Dashboard: anzeigen, ersetzen, entfernen

**Files:**
- Modify: `src/services/vorgaengeUebersicht.js` (`STATUS_LABEL.kenntnisnahme = 'Wartet auf Kenntnisnahme'`, `artVon` → `'rapport'`, Fortschritt `n von m`, Filter `typ=rapport`, `istUeberfaellig` über `rapport_eskalation_stunden`)
- Modify: `src/routes/admin/vorgaenge.js` (`POST /:id/rapport/:kid/ersetzen`, `POST /:id/rapport/:kid/entfernen`, `POST /:id/rapport/aufheben`, alle `requirePermission(db, config, 'workflow_eingreifen')` + `csrfProtection`)
- Modify: `views/admin/vorgaenge*.ejs` (Detail: Empfängerliste mit Status, je offener Zeile Ersetzen-Formular mit Personenauswahl und Pflicht-Begründung sowie Entfernen-Formular mit Pflicht-Begründung)
- Modify: `src/services/vorgangUmhaengen.js` (`istUmhaengbar` → `false` für `kenntnisnahme`, damit das allgemeine Umhängen nicht greift)
- Modify: `src/services/rapporte.js`
- Test: `test/integration/admin/vorgaenge.test.js`

**Interfaces:**
- Consumes: Task 2 (`ersetzeEmpfaenger`, `entferneEmpfaenger`), Task 3 (`hebeRapportAuf`), Task 4 (Abschlussweg aus `bestaetigeRapport`, ausgelagert als `async finalisiereRapport(db, config, jobId) -> boolean`).
- Produces in `src/services/rapporte.js`:
  - `async ersetzeRapportEmpfaenger(db, config, { jobId, kenntnisnahmeId, neuePersonId, begruendung, admin, ip }) -> { ok } | { ok:false, status, fehler }`. Begründung ≥ `MIN_BEMERKUNG_LAENGE`. Neue Person muss Kandidat sein und darf nicht schon offen sein. Schreibt `freigaben` `rapport_empfaenger_ersetzt` und reiht `rapport-zuweisung` an die neue Person ein.
  - `async entferneRapportEmpfaenger(db, config, { jobId, kenntnisnahmeId, begruendung, admin, ip }) -> { ok, abgeschlossen } | { ok:false, status, fehler }`. Schreibt `rapport_empfaenger_entfernt`. Bleibt danach niemand offen, folgt `finalisiereRapport`.
- `bestaetigeRapport` (Task 4) ruft künftig `finalisiereRapport` auf. Das ist reines Refactoring ohne Verhaltensänderung.

- [ ] **Step 1: Failing tests** in `test/integration/admin/vorgaenge.test.js`:

```js
test('Rapport erscheint mit Art "Rapport" und "1 von 2" im Dashboard, Filter typ=rapport')
test('ersetzen: alte Zeile entfernt mit ersetzt_durch_id, neue Person bekommt Mail, Audit-Eintrag')
test('ersetzen mit Begründung < 10 Zeichen → 400; ohne workflow_eingreifen → 403')
test('ersetzen doppelt abgeschickt (gleiche kid) → zweites Mal 409, nur eine neue Zeile')  // Review Focus 5
test('entfernen des letzten Offenen nach einer Bestätigung → abgeschlossen mit Vermerk "entfernt"')
test('entfernen des letzten Offenen ohne Bestätigung → 409 mit Hinweis ersetzen/aufheben')
test('allgemeines Umhängen bietet Rapporte nicht an')
```

- [ ] **Step 2: Run** `node --test test/integration/admin/vorgaenge.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dieselben plus `node --test test/integration/admin/authz-sweep.test.js test/integration/csrfSweep.test.js test/integration/rapporteBestaetigen.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): Admin-Eingriff im Vorgänge-Dashboard`

---

### Task 7: n8n-Endpunkt `/api/n8n/rapporte` und Abschottung von `/api/n8n/jobs`

**Files:**
- Create: `src/routes/n8n/rapporte.js`
- Modify: `src/app.js` (`app.use('/api/n8n/rapporte', machineLimiter, requireApiKey(config), createN8nRapporteRouter({ db, config }))`)
- Modify: `src/services/archiveReceipt.js` (Parameter `art`)
- Modify: `src/routes/n8n/jobs.js` (alle `/:id/*`-Routen: Rapport → 404 `{ error: 'Job nicht gefunden.' }`; `archivierung-ausstehend` ohne Rapporte)
- Modify: `src/services/cronJobs.js` `pdf-bereinigung` nur prüfen. Er nutzt `hasMatureArchiveReceipt` / `archivedBytesMatch` ohne Typ und deckt Rapporte damit ab. Ein Test belegt es.
- Test: `test/integration/n8n/rapporte.test.js`, `test/integration/n8n/jobs.test.js`, `test/integration/n8n/archiveReceipt.test.js`, `test/integration/pdfBereinigungEndToEnd.test.js`

**Interfaces:**
- `archiveReceipt.js`: `createExportEvidence(db, id, { art = 'beleg' } = {})`, `readExportDocument(db, id, exportId, { art = 'beleg' } = {})`, `confirmArchiveReceipt(db, id, body, { art = 'beleg' } = {})`.
  - `loadExportable` wirft `ArchiveError(404, 'Job nicht gefunden.')`, wenn `(job.typ === 'rapport') !== (art === 'rapport')`.
  - Bei `art === 'rapport'` liefert `manifestInhalt` statt `exportNachweis` den Block `{ nachweis_status: 'kenntnisnahme', metadaten: rapportMetadaten(db, job), zahlung: null, positionen: [] }`.
  - `download_pfad` = `/api/n8n/rapporte/${id}/exportdatei/${export_id}`.
  - `confirmArchiveReceipt` setzt bei Rapporten den Status `abgeschlossen` → `abgeholt` direkt per `UPDATE … WHERE typ='rapport' AND status='abgeschlossen'`, weil `confirmAbholung` Rapporte jetzt ausschliesst.
- `rapportMetadaten(db, job) -> { job_id, art: 'rapport', eingang_am, quelle, absender, dateiname, markiert_von, markiert_am, bemerkung, kenntnisnahmen: [{ person_id, name, zugeteilt_am, bestaetigt_am, entfernt_am, begruendung }], abgeschlossen_am }` in `src/services/rapporte.js`.
- Routen in `rapporte.js`:
  - `GET /abholbereit`: Liste `{ id, art, eingang_am, dateiname, abgeschlossen_am, export_nachweis_url }`. Gleiche Zeitstempel-Bedingung wie `listAbholbereitJobs`.
  - `GET /archivierung-ausstehend`.
  - `GET /:id/exportnachweis`.
  - `GET /:id/exportdatei/:exportId` (application/pdf).
  - `POST /:id/archivierung-bestaetigen` (`json({ limit: '8kb' })`).
  - Fehler über `ArchiveError.status` wie in `jobs.js`.

- [ ] **Step 1: Failing tests** `test/integration/n8n/rapporte.test.js`:

```js
test('ohne X-API-Key → 401')
test('abholbereit listet abgeschlossenen Rapport, nicht offenen und keine Rechnung')
test('abholbereit mit TSA aktiv: Rapport ohne Zeitstempel fehlt')
test('exportnachweis: version 2, sha256 = Hash der final-PDF, metadaten.art = "rapport", zahlung null, download_pfad unter /api/n8n/rapporte')
test('exportdatei liefert exakt die Bytes; archivierung-bestaetigen → archiv_bestaetigt, status abgeholt')
test('Rechnungs-ID auf /api/n8n/rapporte/:id/exportnachweis → 404')
```

In `test/integration/n8n/jobs.test.js` (Anti-Ziel, Review Focus 4):

```js
test('Rapport erscheint nie in /api/n8n/jobs/abholbereit und archivierung-ausstehend')
test('Rapport-ID auf /api/n8n/jobs/:id/exportnachweis, /exportdatei, /abholung-bestaetigen, /archivierung-bestaetigen → 404')
test('Rapport erscheint nicht in /admin/altfaelle')
```

`test/integration/pdfBereinigungEndToEnd.test.js`: quittierter Rapport ist nach 7 Tagen `archiviert` und die Datei ist entfernt.

- [ ] **Step 2: Run** die vier Testdateien. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dieselben plus `node --test test/integration/exportZahlungsintegritaet.test.js test/integration/splitgruppen-e2e.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rapporte): n8n-Endpunkt /api/n8n/rapporte`

---

### Task 8: Testmodus, Doku, Gesamtlauf

**Files:**
- Modify: `src/services/testmodus/beispieldaten.js` (je ein offener Rapport mit 2 Empfängern, davon 1 bestätigt, und ein abgeschlossener Rapport)
- Modify: `docs/rechnungs-workflow.md` (Status `kenntnisnahme` in Tabelle und Diagramm, neuer Abschnitt «Rapporte»), `docs/n8n-schnittstelle.md` + `docs/n8n-paperless-archivierung.md` (Endpunkt-Tabelle und Hinweis: eigener n8n-Zweig nötig, bestehender Workflow bleibt unverändert), `docs/datenmodell.md` (Tabelle `kenntnisnahmen`, neue Spalten), `docs/geplante-jobs-und-benachrichtigungen.md` (`rapport-erinnerungen`, drei Mail-Typen), `docs/admin-bereich.md` (Modul-Schalter, Eskalationsfelder, Dashboard-Aktionen), `docs/auth-und-rechte.md` (`workflow_eingreifen` gilt auch für Rapporte)
- Test: `test/unit/testmodusSpielwiese.test.js`

- [ ] **Step 1: Failing test**: Testmodus-Instanz enthält genau einen Job mit `status='kenntnisnahme'` und einen mit `typ='rapport' AND status='abgeschlossen'`.
- [ ] **Step 2: Run** `node --test test/unit/testmodusSpielwiese.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** Beispieldaten und Doku.
- [ ] **Step 4: Gesamtlauf** `npm test`. Expected: alle Tests PASS, 0 fail. Dazu `npm run test:responsive`, falls die Umgebung es zulässt. Sonst im Abschluss vermerken.
- [ ] **Step 5: Commit** `docs(rapporte): Doku und Testmodus-Beispieldaten`
