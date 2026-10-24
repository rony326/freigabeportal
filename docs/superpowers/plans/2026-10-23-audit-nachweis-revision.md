# Audit-Nachweis für die Revision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit-Pakete entstehen jede Nacht automatisch, werden per RFC3161-TSA bestätigt, die Revision erhält monatlich eine Prüfnummer per Mail und kann sie auf einer öffentlichen Prüfseite abgleichen.

**Architecture:** Drei neue Services um das bestehende `auditExport.js`: `auditZeitstempel.js` (TSA über die Prüfnummer, Token-Prüfung), `auditNachweisJobs.js` (nächtlicher Export+Stempel+Alarm, monatliche Prüfnummer-Mail, Empfängerwechsel-Mail) und `auditPruefung.js` (Ergebnis der Prüfseite). Neue Tabelle `audit_export_zeitstempel`, neuer Mail-Typ `audit-pruefnummer`, öffentliche Route `/audit-pruefen`, Erweiterung von `/admin/zeitstempel`.

**Tech Stack:** Node.js (node:sqlite), Express, EJS, `pdf-rfc3161` (createTimestampRequest/sendTimestampRequest/parseTimestampResponse), pkijs/asn1js via `src/services/tsaResponse.js`, `node:test` + supertest, undici MockAgent (`test/helpers/mockTsa.js`), `test/helpers/chainedTsa.js`.

**Spec:** `docs/superpowers/specs/2026-10-23-audit-nachweis-revision-design.md` (inkl. Abschnitt "Präzisierungen beim Planen").

## Global Constraints

- Prüfnummer = `audit_export_pakete.paket_sha256` (64 Hex, klein). TSA-MessageImprint = SHA-256 über die UTF-8-Bytes dieser 64 Zeichen.
- Nach aussen (Mail, Prüfseite) nie personenbezogene Daten: nur Paketnummer, Hashes, Anzahlen, Zeitpunkte.
- Empfänger-Schlüssel `audit_revision_empfaenger` (komma-getrennt), nur Superadmin über `/admin/zeitstempel`.
- Einstellungen (alle auf `/admin/zeitstempel`, nur Superadmin, siehe Spec-Tabelle "Einstellbar über die Admin-Oberfläche"): `modul_audit_nachweis_aktiv` (`'1'`), `audit_pruefnummer_rhythmus` (`'monatlich'`|`'quartalsweise'`|`'jaehrlich'`, Default `'monatlich'`), `audit_pruefnummer_tag` (1–28, `'1'`), `cron_audit_export_stunde`/`_minute` (`'3'`/`'15'`), `cron_audit_pruefnummer_stunde`/`_minute` (`'7'`/`'0'`), `audit_zeitstempel_alarm_tage` (1–30, `'3'`). Kalenderlogik in Zeitzone `Europe/Zurich`. Quartalsweise = Monate 1/4/7/10, jährlich = Monat 1.
- Abgeschaltet (`modul_audit_nachweis_aktiv` ≠ `'1'`): beide Jobs liefern `{ status: 'uebersprungen' }` ohne Seiteneffekt; Prüfseite funktioniert weiter mit Hinweis.
- Alarm: ältestes Paket ohne Zeitstempel länger als `audit_zeitstempel_alarm_tage` → höchstens alle 24 h Mail an `sicherheitsalarm_empfaenger` (Default `gruppe:admin`), `typ: 'sicherheitsalarm'` via `sendRenderedMail`.
- Zeitstempel gilt als rechtzeitig, wenn `gen_time ≥ erstellt_am − 5 min` und `gen_time ≤ erstellt_am + 7 Tage`.
- `audit-pruefnummer` ist in `IMMER_SOFORT_TYPEN` (kein Digest).
- CHECK-Erweiterungen nur über `erweitereCheckPerRebuild` in `src/db/index.js`, aufgerufen nach `migrateDuplikatVerdacht`.
- UI-Texte Deutsch (Schweizer Schreibweise, "ss" statt "ß"), Code-Kommentare kurz und deutsch wie im Rest des Repos.
- Jeder Task endet mit `npm test` grün (aktuell 1820 Tests).

## Review Focus

1. Prüfnummer aus der Mail mit Leerzeichen-Gruppen, Grossbuchstaben oder Zeilenumbruch eingefügt → wird akzeptiert (Task 5 Test `normalisiert Prüfnummer`).
2. Nicht existierende Paketnummer, Buchstaben statt Zahl, leere Parameter → verständliche Meldung, Status 200/400, nie 500 (Task 5 Test `ungültige Eingaben`).
3. TSA mehrere Nächte nicht erreichbar → Pakete entstehen weiter, Stempel werden später in Reihenfolge nachgeholt, keine doppelten Zeilen, kein Alarm-Spam (Task 3 Tests `nachholen` und `Alarm höchstens alle 24 h`).
4. Noch gar kein Paket vorhanden (frische Installation) → Monatsmail meldet `kein_paket` und sendet nichts; Prüfseite erklärt "noch kein Paket" (Task 4 und Task 5).
5. Empfängerfeld mit ungültiger Adresse oder mit der Adresse eines Superadmins → ungültig: 400 mit Fehlermeldung; Superadmin-Adresse: speichern + Warnung (Task 6).

---

### Task 1: Schema, Mail-Typ und Vorlage

**Files:**
- Modify: `src/db/auditExportSchema.js` (neue Tabelle im selben SAVEPOINT)
- Modify: `src/db/schema.sql` (mail_log-CHECK um `'audit-pruefnummer'`)
- Modify: `src/db/index.js` (neue `migrateAuditPruefnummerMailTyp(db)` nach `migrateDuplikatVerdacht(db)`)
- Modify: `src/db/adminConfigRepo.js` (DEFAULTS), `src/services/mailTemplates.js` (`'audit-pruefnummer': 'audit_pruefnummer'`), `src/services/notify.js` (IMMER_SOFORT_TYPEN), `src/routes/admin/mailEinstellungen.js` + `views/admin/mail-einstellungen-form.ejs` (Felder `auditPruefnummerBetreff`/`auditPruefnummerText`, Variablenliste)
- Test: `test/unit/auditNachweisSchema.test.js` (neu), `test/integration/admin/mailEinstellungen.test.js` (VALID_BODY ergänzen)

**Interfaces:**
- Produces: Tabelle `audit_export_zeitstempel(paket_nr INTEGER PRIMARY KEY REFERENCES audit_export_pakete(id), token BLOB NOT NULL, gen_time TEXT NOT NULL, nachweis TEXT NOT NULL, erstellt_am TEXT NOT NULL)`, Trigger `audit_export_zeitstempel_no_update` / `_no_delete`.
- Produces: Config-Defaults `audit_revision_empfaenger: ''`, alle Einstellungs-Schlüssel aus Global Constraints mit ihren Defaults, `mail_vorlage_audit_pruefnummer_betreff`, `mail_vorlage_audit_pruefnummer_text`.

- [ ] **Step 1: Failing tests** in `test/unit/auditNachweisSchema.test.js`:
  - `frische DB: audit_export_zeitstempel existiert und ist unveränderlich` — Paket via `erstelleAuditExportPaket` anlegen, Zeile einfügen, `UPDATE`/`DELETE` werfen `/unveraenderlich/`, zweites INSERT mit gleicher `paket_nr` wirft `/UNIQUE|PRIMARY/`.
  - `mail_log akzeptiert typ audit-pruefnummer` (frische DB).
  - `bestehende DB ohne audit-pruefnummer im CHECK wird erweitert, Daten bleiben` — Muster wie `test/unit/duplikatVerdachtSchema.test.js` (CHECK per `writable_schema` zurückbauen, neu öffnen, alte Zeile da, Index `mail_log_zustellung_idx` da).
  - `Standardvorlage enthält Paketnummer, Prüfnummer und Prüflink` — `getConfigValue(db,'mail_vorlage_audit_pruefnummer_text')` matcht `/%paketNr%/`, `/%pruefnummer%/`, `/%link%/`.
- [ ] **Step 2:** `node --test test/unit/auditNachweisSchema.test.js` → FAIL.
- [ ] **Step 3: Implement.** Betreff-Default: `'Freigabeportal: Audit-Prüfnummer für die Revision'`. Text-Default (exakt):
  ```
  Guten Tag

  dies ist die regelmässige Prüfnummer des Audit-Protokolls des %portalName%. Bitte diese Mail aufbewahren.

  Paketnummer: %paketNr%
  Prüfnummer: %pruefnummer%
  Zeitraum: %vonZeit% bis %bisZeit%
  Protokollierte Ereignisse insgesamt: %anzahlEreignisse%
  Zeitstempel: %zeitstempelZeit%
  Pakete noch ohne Zeitstempel: %ohneZeitstempel%

  Bei der Prüfung: Link öffnen oder Paketnummer und Prüfnummer auf %pruefseite% eingeben. Stimmt alles, wurde das Protokoll seit dieser Mail nicht verändert.

  %link%

  Freundliche Grüsse
  %portalName%
  ```
- [ ] **Step 4:** Test + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(audit): Schema und Mailvorlage für Audit-Prüfnummer`.

### Task 2: TSA-Bestätigung einer Prüfnummer

**Files:**
- Create: `src/services/auditZeitstempel.js`
- Modify: `src/services/tsaResponse.js` (Parsing aus `validateTimestampBinding` als `leseTimestampToken` exportieren; `validateTimestampBinding` nutzt es, Verhalten unverändert)
- Test: `test/unit/auditZeitstempel.test.js`

**Interfaces:**
- Produces: `async stempleAuditPaket(paketSha256: string, tsaConfig: {url, user?, passwort?, trustAnchorsFile?, trustAnchorsSha256?, crlFile?, requireTrustedChain?}) → { token: Buffer, genTime: Date, nachweis: object }` — wirft `Error` mit deutscher Meldung bei jedem Fehler.
- Produces: `pruefeAuditZeitstempelToken(token: Buffer, paketSha256: string) → { gueltig: boolean, genTime: Date|null, fehler: string|null }` — wirft nie.
- Produces: `tsaConfigAusDb(db, config) → object|null` (null, wenn `zeitstempel_tsa_url` leer; sonst wie in `tsaCrlUpdate.js:runTsaCrlAktualisierungJobInternal` gebaut).
- Produces (tsaResponse.js): `leseTimestampToken(token) → { signed, info }`.

- [ ] **Step 1: Failing tests** (mit `createChainedTsa(t)` + `setupMockTsa(url).intercept({path:'/tsr',method:'POST'}).reply(200, tsa.reply)` wie in `test/unit/tsaCrlUpdate.test.js`):
  - `stempelt eine Prüfnummer und liefert Token, Zeit und Nachweis` — `genTime` ist Date ≈ jetzt, `nachweis` ist Objekt, `pruefeAuditZeitstempelToken(token, hash).gueltig === true`.
  - `MessageImprint ist SHA-256 über die Hex-Zeichen der Prüfnummer` — aus `leseTimestampToken(token).info.messageImprint.hashedMessage` = `sha256(Buffer.from(hash,'utf8'))`.
  - `Token gehört nicht zu einer anderen Prüfnummer` — mit anderem Hash geprüft → `gueltig:false`, `fehler` matcht `/passt nicht/`.
  - `manipuliertes Token ist ungültig` — ein Byte im Signaturteil kippen → `gueltig:false`, wirft nicht.
  - `TSA-Fehler (HTTP 500) wirft verständliche Meldung` → rejects `/Zeitstempel/`.
  - `tsaConfigAusDb liefert null ohne TSA-URL`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `stempleAuditPaket`: `freshTimestampRequest(await createTimestampRequest(Buffer.from(hash,'utf8'), { hashAlgorithm: 'SHA-256' }))`, senden mit `buildTsaHeaders` und eigenem Timing `{ timeout: 15000, retry: 2, retryDelay: 1000 }`, `validateTimestampBinding`, Kette via `loadTsaTrustAnchors`/`loadTsaCrls`/`verifyTsaChain` wenn Anker konfiguriert (gleiche Bedingung wie `setZeitstempelMitNachweis`), `baueTsaNachweis`. `pruefeAuditZeitstempelToken`: `leseTimestampToken`, Imprint vergleichen, CMS-Signatur mit pkijs `signed.verify({ signer: 0, checkChain: false, data: eContent })` prüfen, alles in try/catch.
- [ ] **Step 4:** Test + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(audit): RFC3161-Bestätigung für Audit-Prüfnummern`.

### Task 3: Nächtlicher Export mit Zeitstempel und Alarm

**Files:**
- Create: `src/services/auditNachweisJobs.js`
- Modify: `src/services/scheduler.js` (neuer Job-Parameter `runAuditExportJob` mit Platzhalter-Default wie `runTsaCrlAktualisierungJob`, `scheduleDaily` mit `cron_audit_export_*`)
- Test: `test/unit/auditNachweisJobs.test.js`, `test/unit/scheduler.test.js` (Job wird registriert)

**Interfaces:**
- Consumes: `erstelleAuditExportPaket` (auditExport.js), `stempleAuditPaket`, `tsaConfigAusDb` (Task 2), Tabelle aus Task 1, `sendRenderedMail`, `resolveEmpfaenger` (notify.js).
- Produces: `runAuditExportJob(db, config, mailer, { jetzt?: Date, stemple?: fn }) → Promise<{ status: 'erfolg'|'fehler', neuePakete: number, gestempelt: number, ohneZeitstempel: number, alarmiert: boolean, error?: string }>` — via `auditedJob('audit-export', …)`; `stemple` ist Test-Injektion (Default `stempleAuditPaket`).
- Produces: `listPaketeOhneZeitstempel(db) → Array<audit_export_pakete-Zeile>` (aufsteigend nach id), `ladeAuditZeitstempel(db, paketNr) → Zeile|undefined`.
- Produces: Config-Schlüssel `audit_zeitstempel_alarm_gesendet_am` (ISO).

- [ ] **Step 1: Failing tests:**
  - `erzeugt Pakete bis keine Ereignisse mehr ausstehen und stempelt sie` — 2 Pakete erzwingen (z. B. `maxEreignisse`-Weg nicht nötig: zwei Läufe mit Ereignissen dazwischen), Stub-`stemple` liefert `{token:Buffer.from('x'),genTime:jetzt,nachweis:{}}`; danach `listPaketeOhneZeitstempel` leer, `gestempelt` korrekt.
  - `ohne TSA-Konfiguration: Pakete ja, Stempel nein, status erfolg`.
  - `TSA-Fehler: Paket bleibt registriert, nächster Lauf holt in Reihenfolge nach` — erster Lauf `stemple` wirft → `status:'fehler'`, `ohneZeitstempel:1`; zweiter Lauf ok → Zeile vorhanden, keine Duplikate, Aufrufreihenfolge der `stemple`-Hashes = aufsteigende Paketnummer.
  - `nach erstem TSA-Fehler im Lauf keine weiteren Versuche in diesem Lauf` (Stub zählt Aufrufe = 1 bei 3 offenen Paketen).
  - `abgeschaltet → uebersprungen, kein Paket, kein Stempel, kein Alarm`; wieder eingeschaltet → nächster Lauf erzeugt Paket mit allen zwischenzeitlichen Ereignissen.
  - `Alarmschwelle aus Konfiguration` — `audit_zeitstempel_alarm_tage='5'`: bei 4 Tagen kein Alarm, bei 5 Tagen + 1 min Alarm.
  - `Alarm, wenn ältestes Paket > 3 Tage ohne Zeitstempel` (Default) — `jetzt` = erstellt_am + 3 d + 1 min → `alarmiert:true`, ein `mail_log` mit `typ='sicherheitsalarm'`, Text nennt Paketnummer.
  - `Alarm höchstens alle 24 h` — zweiter Lauf 1 h später → `alarmiert:false`; 25 h später → wieder `true`.
  - `kein Alarm bei 2 Tagen Rückstand`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Schleife `while (erstelleAuditExportPaket(db, { jetzt }))`; danach für jede Zeile aus `listPaketeOhneZeitstempel` stempeln und `INSERT INTO audit_export_zeitstempel … ON CONFLICT(paket_nr) DO NOTHING` (`gen_time` ISO, `nachweis` via `kanonischesJson`); beim ersten Fehler abbrechen. Alarm-Mail-Text nennt Anzahl offener Pakete, älteste Paketnummer und Erstellzeit, Hinweis "TSA-Konfiguration unter Admin → Zeitstempel prüfen", Link `${publicBaseUrl}/admin/zeitstempel`.
- [ ] **Step 4:** Test + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(audit): nächtlicher Export mit Zeitstempel und Alarm`.

### Task 4: Prüfnummer-Mail (monatlich und manuell)

**Files:**
- Modify: `src/services/auditNachweisJobs.js`
- Modify: `src/services/scheduler.js` (`runAuditPruefnummerJob`, `scheduleDaily` mit `cron_audit_pruefnummer_*`)
- Test: `test/unit/auditNachweisJobs.test.js`

**Interfaces:**
- Consumes: Task 1 (Vorlage, Mail-Typ), Task 3 (`ladeAuditZeitstempel`, `listPaketeOhneZeitstempel`).
- Produces: `parseEmpfaengerListe(wert: string) → { adressen: string[], ungueltig: string[] }` (trim, leer ignorieren, Duplikate entfernen, einfache Prüfung `/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/`).
- Produces: `formatierePruefnummer(hex) → string` (8 Gruppen à 8 Zeichen, mit Leerzeichen getrennt).
- Produces: `async sendeAuditPruefnummer(db, config, mailer) → { status: 'versendet'|'kein_empfaenger'|'kein_paket', paketNr?: number, empfaenger?: number }`.
- Produces: `istVersandtag(jetzt: Date, { rhythmus: string, tag: number }) → boolean` (Zürcher Datum; Monat passt zum Rhythmus und Tag = `tag`).
- Produces: `runAuditPruefnummerJob(db, config, mailer, { jetzt?: Date }) → Promise<{ status: 'erfolg'|'uebersprungen'|'fehler', … }>` via `auditedJob('audit-pruefnummer', …)`; sendet nur wenn Funktion aktiv, `istVersandtag(...)` mit den Config-Werten und `audit_pruefnummer_zuletzt_monat` ≠ aktueller Monat `YYYY-MM`; setzt den Schlüssel nach Versand.
- Produces: `async meldeAuditNachweisAenderung(db, config, mailer, { aenderungen: string[], person: {vorname, nachname} }) → void` — `sendRenderedMail` mit `typ:'audit-pruefnummer'` an die aktuellen Revisions-Empfänger, Betreff `'Freigabeportal: Einstellungen des Audit-Nachweises geändert'`, eine Zeile pro Änderung (z. B. `Automatischer Nachweis: aktiv → abgeschaltet`), Person und Zeitpunkt.
- Produces: `async meldeAuditEmpfaengerWechsel(db, config, mailer, { alt: string, neu: string, person: {vorname, nachname} }) → void` — `sendRenderedMail` mit `typ:'audit-pruefnummer'` an Vereinigung von alt+neu, Betreff `'Freigabeportal: Empfänger der Audit-Prüfnummer geändert'`, Text nennt alte und neue Adressen, Person und Zeitpunkt.

- [ ] **Step 1: Failing tests:**
  - `sendet Prüfnummer an alle Empfänger mit Link zur Prüfseite` — Mail-Text enthält Paketnummer, `formatierePruefnummer(hash)`, Link `https://…/audit-pruefen?paket=N&pruefnummer=<hex>`, keinen Personennamen aus `audit_ereignisse` (Ereignis mit Person "Erika Muster" erzeugen, `doesNotMatch /Erika/`).
  - `kein_empfaenger` bei leerem Schlüssel, `kein_paket` ohne Pakete — jeweils keine Mail.
  - `ohneZeitstempel` und `zeitstempelZeit` ("noch keiner" ohne Stempel) korrekt im Text.
  - `Monatsjob sendet am 1. genau einmal` — `jetzt` 2026-11-01T06:00Z → versendet; gleicher Tag zweiter Lauf → `uebersprungen`; 2026-11-02 → `uebersprungen`; 2026-12-01 → versendet.
  - `istVersandtag` — quartalsweise Tag 15: 2027-04-15 true, 2027-05-15 false; jährlich Tag 1: 2027-01-01 true, 2027-02-01 false; Zürcher Mitternacht: 2026-10-31T23:30Z ist bereits der 1.11. in Zürich.
  - `abgeschaltet → kein Versand` am Versandtag.
  - `meldeAuditNachweisAenderung` schickt eine Mail pro Empfänger mit allen Änderungszeilen.
  - `Empfängerwechsel geht an alte und neue Adresse` — 2 Mails, Text nennt beide Adressen.
  - `parseEmpfaengerListe` und `formatierePruefnummer` Grundfälle.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Variablen für `sendNotification`: `paketNr, pruefnummer (formatiert), vonZeit/bisZeit` (Zeitpunkt des ersten/letzten Ereignisses von Paket 1 bzw. N, `Europe/Zurich`, `dd.MM.yyyy HH:mm`), `anzahlEreignisse` (Summe `anzahl`), `zeitstempelZeit`, `ohneZeitstempel`, `pruefseite` (`${publicBaseUrl}/audit-pruefen`), `link`. `jobId: null`.
- [ ] **Step 4:** Test + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(audit): monatliche Prüfnummer-Mail an die Revision`.

### Task 5: Öffentliche Prüfseite `/audit-pruefen`

**Files:**
- Create: `src/services/auditPruefung.js`, `src/routes/auditPruefen.js`, `views/audit-pruefen.ejs`
- Modify: `src/app.js` (`app.use('/audit-pruefen', publicLimiter, createAuditPruefenRouter({ db }))` bei den anderen öffentlichen Routen)
- Test: `test/unit/auditPruefung.test.js`, `test/integration/auditPruefen.test.js`

**Interfaces:**
- Consumes: `pruefeAuditExportRegister` (auditExport.js), `pruefeAuditZeitstempelToken` (Task 2), `ladeAuditZeitstempel` (Task 3).
- Produces: `normalisierePruefnummer(eingabe) → string|null` (Whitespace und `-` entfernen, klein, nur `/^[0-9a-f]{64}$/`).
- Produces: `pruefeAuditNachweis(db, { paketNr: number, pruefnummer: string }) → { status: 'ok'|'abweichung'|'unbekannt'|'kein_paket', punkte: Array<{ titel: string, ok: boolean, text: string }>, neuere: { anzahl: number, alleGestempelt: boolean } }` — `ok` nur wenn Punkte 1–3 der Spec grün.
- Produces: `createAuditPruefenRouter({ db }) → Router` mit nur `GET /`.

- [ ] **Step 1: Failing tests** (Service mit echter DB, Zeitstempel-Zeilen direkt mit Token aus `createChainedTsa` oder Stub über `stemple`-Injektion aus Task 3):
  - `richtige Prüfnummer, Kette intakt, alle gestempelt → ok` (3 grüne Punkte).
  - `normalisiert Prüfnummer` — Eingabe `formatierePruefnummer(hash).toUpperCase() + '\n'` → ok.
  - `falsche Prüfnummer → abweichung`, Punkt 1 rot.
  - `Audit-Ereignis nachträglich verändert → abweichung` — Trigger droppen, `UPDATE audit_ereignisse`, Punkt 2 rot (Befund `inhalt_abweichend`).
  - `Paket ohne Zeitstempel → abweichung`, Punkt 3 rot, Text nennt Paketnummer.
  - `Zeitstempel verspätet (> 7 Tage nach Erstellung) → Punkt 3 rot mit "verspätet"`.
  - `unbekannte Paketnummer → unbekannt`; `noch kein Paket → kein_paket`.
  - Route: `GET /audit-pruefen` ohne Login → 200 mit Formular; `?paket=1&pruefnummer=<hex>` → 200 "Keine Veränderung festgestellt"; `ungültige Eingaben` (`paket=abc`, `pruefnummer=xyz`, leer) → 400 mit Meldung, nie 500; Antwort enthält keinen Personennamen aus dem Audit-Log.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Bei abgeschalteter Funktion oben Hinweis "Der automatische Audit-Nachweis ist derzeit abgeschaltet." (Test: `abgeschaltet → Hinweis, Prüfung vorhandener Pakete funktioniert`). View im bestehenden Layout (`_seite_anfang` mit `rahmen: 'ohne'`, ohne Login lauffähig), Formular `method="get"`, Ergebnisliste grün/rot, Druckknopf (`window.print()`), Absatz zur ehrlichen Grenze aus der Spec ("Die Seite läuft im Portal selbst …").
- [ ] **Step 4:** Test + `npm test` (inkl. `csrfSweep`, `layoutSweep`) → PASS.
- [ ] **Step 5:** Commit `feat(audit): öffentliche Prüfseite für die Revision`.

### Task 6: Einstellungen unter Admin → Zeitstempel

**Files:**
- Modify: `src/routes/admin/zeitstempel.js` (Signatur `createZeitstempelAdminRouter({ db, config, mailer, csrfProtection })`), `src/app.js:173` (config + mailer übergeben), `views/admin/zeitstempel-form.ejs`, `src/app.js` Dashboard-Flag + `views/admin/dashboard.ejs`
- Test: `test/integration/admin/zeitstempel.test.js` (bestehend, sonst neu), `test/integration/csrfSweep.test.js` (neue POST-Route aufnehmen, falls die Liste explizit ist)

**Interfaces:**
- Consumes: `parseEmpfaengerListe`, `meldeAuditEmpfaengerWechsel`, `meldeAuditNachweisAenderung`, `sendeAuditPruefnummer` (Task 4), `listPaketeOhneZeitstempel` (Task 3).
- Produces: Formularfelder im bestehenden `POST /admin/zeitstempel`: `auditRevisionEmpfaenger`, `auditNachweisAktiv` (Checkbox), `auditPruefnummerRhythmus` (Select), `auditPruefnummerTag`, `auditExportStunde`, `auditExportMinute`, `auditPruefnummerStunde`, `auditPruefnummerMinute`, `auditZeitstempelAlarmTage` — validiert mit den Bereichen aus Global Constraints (Fehler → 400, nichts gespeichert, Muster `ganzzahlImBereich` aus `src/routes/admin/geplanteJobs.js`); neue Route `POST /admin/zeitstempel/audit-pruefnummer-senden` (csrfProtection) → Redirect `/admin/zeitstempel` mit Flash/Query-Hinweis über das Ergebnis.
- Produces: Dashboard-Variable `auditRevisionEmpfaengerFehlt: boolean`.

- [ ] **Step 1: Failing tests:**
  - `Superadmin speichert Empfänger; alte und neue Adresse bekommen Mail; admin_config-Änderung steht im Audit-Log` (`audit_ereignisse` objekt `admin_config`, objekt_id `audit_revision_empfaenger`).
  - `unveränderter Empfänger → keine Wechsel-Mail`.
  - `Abschalten oder Rhythmus/Tag ändern → Änderungs-Mail an Revisions-Empfänger`; nur Uhrzeit oder Alarmschwelle ändern → keine Mail.
  - `ungültige Werte` (Tag 29, Stunde 24, Alarmtage 0, Rhythmus "woechentlich") → 400, nichts gespeichert.
  - Seite zeigt alle Einstellungen vorbelegt mit den gespeicherten Werten.
  - `ungültige Adresse → 400, nichts gespeichert`.
  - `Adresse eines Superadmins → gespeichert, Seite zeigt Warnung "gehört einer Person mit Admin-Rechten"`.
  - `Nicht-Superadmin → 403` für GET, POST und `audit-pruefnummer-senden`.
  - `"Prüfnummer jetzt senden" verschickt Mail bzw. zeigt "kein Empfänger festgelegt"`.
  - `Seite zeigt letztes Paket, Anzahl ohne Zeitstempel und Hinweis bei fehlendem Empfänger`; Dashboard zeigt Hinweis bei leerem Empfänger.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Wechsel-Mail nach erfolgreichem `setConfigValue`, nur wenn normalisierte Liste sich ändert.
- [ ] **Step 4:** Test + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(admin): Revision-Empfänger und manueller Versand der Audit-Prüfnummer`.

### Task 7: Dokumentation

**Files:**
- Modify: `docs/audit-externe-nachweise.md` (Ist-Stand-Tabelle, "Lokal umgesetzt", Bedrohungsmodell-Zeile DB-Admin: jetzt TSA + Revision-Mail; ehrliche Grenze), `docs/geplante-jobs-und-benachrichtigungen.md` (Jobs `audit-export`, `audit-pruefnummer`, Mail-Typ, Config-Schlüssel), `docs/admin-bereich.md` (Admin → Zeitstempel), `docs/datenmodell.md` (`audit_export_zeitstempel`), `docs/feature-abgleich-2026-09-30.md` (Grenze "automatischer Transport" aktualisieren), `README.md` falls Jobliste dort steht.

- [ ] **Step 1:** Doku anpassen; jede genannte Route/Config-Schlüssel per `grep` im Code gegenprüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Audit-Nachweis für die Revision dokumentieren`.
