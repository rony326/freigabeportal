# Spesen-Bestätigungsmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die einreichende Person bekommt pro Spesenabrechnung eine Bestätigungsmail mit den gestempelten Belegen, sobald jede Position an Bexio versandt oder abgelehnt/gelöscht ist.

**Architecture:** Neuer Service `services/spesenBestaetigung.js` prüft «Abrechnung erledigt?» und reiht die Mail mit Anhängen in die bestehende Outbox (`mail_log`) ein. Aufgerufen nach jeder Bexio-Versandquittung einer Spesenposition, nach jeder Spesen-Ablehnung und nächtlich im Job `pdf-bereinigung`. Die Outbox lernt Anhänge (neue Tabelle `mail_anhaenge`); Belegkopien liegen unter `<jobsDir>/mail-anhaenge/`.

**Tech Stack:** Node ≥ 22 (ESM), `node:sqlite` (DatabaseSync), Express, nodemailer, `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-11-26-spesen-bestaetigungsmail-design.md`

## Global Constraints

- Code-Kommentare, Fehlermeldungen, Mailtexte und Doku auf Deutsch (Schweizer Schreibweise, «ss» statt «ß»), wie im übrigen `src/`.
- Neue Spalte → `*_TABLE_MIGRATIONS` **und** `src/db/schema.sql` (Regel aus `src/db/index.js:7`).
- Neuer Mailtyp → `TYP_ZU_KEY_INFIX`, DEFAULTS in `adminConfigRepo.js`, `mail_log`-CHECK-Migration (Regel aus `mailTemplates.js:6`). CHECK-Rebuilds laufen **vor** `migrateSecuritySchema`.
- Mailtyp heisst exakt `spesen-bestaetigung`, Vorlagen-Infix `spesen_bestaetigung`, Schalter `spesen_bestaetigung_aktiv` (Standard `'1'`).
- Vermerke in `spesenabrechnungen.bestaetigung_vermerk`: exakt `'versendet'`, `'keine'`, `'deaktiviert'`, `'altbestand'`.
- Anhangsgrenze 15 MB gesamt (`15 * 1024 * 1024` Bytes).
- Bestätigungs-Fehler dürfen Versandquittung und Ablehnung nie scheitern lassen (Aufruf nach dem Commit, try/catch + `console.error`).
- Dateilöschungen nur über `loescheDateiMitAudit` und nie in einer offenen Transaktion.
- Testlauf gesamt: `npm test -- --test-concurrency=2` (~6,5 min).

## Review Focus

1. **Doppelte n8n-Quittung / parallele Auslöser** (Bexio-Quittung und Ablehnung gleichzeitig) → genau eine Mail. Test in Task 3 (`zweimal aufgerufen → eine Mail`) und Task 4 (doppelte Quittung mit gleicher message_id).
2. **Abrechnung wird erst nach der 7-Tage-Bereinigung erledigt** → Anhang kommt aus der Kopie, nicht aus `pdf_pfad`. Test in Task 3 (Original löschen, dann prüfen).
3. **Bestehende Datenbank beim Update** → keine Mails für Altbestand, aber Mails für danach erledigte. Test in Task 2.
4. **Erneut versenden unter /admin/mails** → die neue Zeile hat dieselben Anhänge. Test in Task 1.
5. **Einreichende Person ohne Mailadresse oder deaktiviert** → keine Ausnahme, Vermerk `keine`, Warnung im Log. Test in Task 3.

---

### Task 1: Anhänge in der Mail-Outbox

**Files:**
- Modify: `src/services/mailer.js` (`sendMail` reicht `attachments` durch)
- Modify: `src/db/schema.sql` (neue Tabelle `mail_anhaenge`)
- Modify: `src/services/mailZustellung.js` (`reiheMailEin`, `stelleMailZu`)
- Modify: `src/db/mailLogRepo.js` (`pruneMailLogOlderThan` löscht zugehörige `mail_anhaenge`-Zeilen in derselben Transaktion)
- Modify: `src/routes/admin/mails.js` (Erneut-Versenden kopiert Anhänge)
- Modify: `src/services/notify.js` (`sendRenderedMail` nimmt optional `anhaenge`)
- Modify: `src/services/dateiAudit.js` (Dateiart `mail_anhang` in `DATEIARTEN`)
- Test: `test/unit/mailZustellung.test.js`, `test/unit/mailer.test.js`, `test/unit/mailLogRepo.test.js`

**Interfaces:**
- Produces:
  - Tabelle `mail_anhaenge(id INTEGER PK AUTOINCREMENT, mail_log_id INTEGER NOT NULL REFERENCES mail_log(id), dateiname TEXT NOT NULL, pfad TEXT NOT NULL, sha256 TEXT NOT NULL)`, Index auf `mail_log_id`.
  - `reiheMailEin(db, { typ, jobId, empfaenger, betreff, text, geplant, jetzt, anhaenge = [] })` → `number`; `anhaenge: Array<{dateiname, pfad, sha256}>`, Insert in derselben Transaktion.
  - `listMailAnhaenge(db, mailLogId)` → `Array<{dateiname, pfad, sha256}>` in `mail_log_id`-Reihenfolge (in `mailLogRepo.js`).
  - `sendRenderedMail(db, mailer, { to, subject, text, typ, jobId, anhaenge })`.
  - `mailer.sendMail({ to, subject, text, attachments })` mit `attachments: Array<{filename, content: Buffer, contentType: 'application/pdf'}>`.

- [ ] **Step 1: Failing tests**
  - `mailZustellung.test.js` › `'Anhänge werden mit Inhalt zugestellt'`: Datei schreiben, `reiheMailEin(... anhaenge: [{dateiname: 'a.pdf', pfad, sha256}])`, `stelleMailZu` → Fake-Mailer erhielt `attachments[0].filename === 'a.pdf'` und `content.equals(bytes)`; Status `versendet`.
  - `'Fehlender Anhang → Wiederholung mit klarer Meldung'`: Datei vorher löschen → Status `eingereiht`, `fehler_details` matcht `/Anhang a\.pdf fehlt/`, Mailer nie aufgerufen.
  - `'Veränderter Anhang → Wiederholung'`: falscher sha256 → `fehler_details` matcht `/Anhang a\.pdf stimmt nicht/`.
  - `mailLogRepo.test.js` › `'Aufbewahrung löscht auch Anhangszeilen'`: alte `versendet`-Zeile mit Anhang → nach `pruneMailLogOlderThan` ist `mail_anhaenge` leer.
  - `mailer.test.js` › `'attachments werden an nodemailer weitergereicht'` (bestehendes Transport-Stub-Muster der Datei).
  - Integration in `test/integration/admin/` (bestehende Mail-Protokoll-Tests suchen): `'Erneut versenden übernimmt Anhänge'` → neue Zeile, `listMailAnhaenge(neueId)` gleich der alten Liste.
- [ ] **Step 2:** `node --test test/unit/mailZustellung.test.js test/unit/mailLogRepo.test.js test/unit/mailer.test.js` → FAIL.
- [ ] **Step 3: Implementieren.** `stelleMailZu` liest Anhänge vor `sendMail`; Fehlerfall als normaler Versuchsfehler (`vermerkeErgebnis`), Meldungen `Anhang <dateiname> fehlt` bzw. `Anhang <dateiname> stimmt nicht mit dem gespeicherten Hash überein`. Mails ohne Anhang rufen `sendMail` unverändert ohne `attachments`-Schlüssel auf (bestehende Tests bleiben grün). `mail_anhaenge` zusätzlich in die Liste der Tabellen, die `migrateSecuritySchema` auditiert, **nicht** aufnehmen (reine Hilfstabelle).
- [ ] **Step 4:** Tests aus Step 2 + `test/integration/mailversandEndToEnd.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Mail-Outbox kann PDF-Anhänge zustellen`

### Task 2: Schema, Mailtyp, Vorlage, Schalter, Altbestand

**Files:**
- Modify: `src/db/schema.sql` (`spesenabrechnungen.bestaetigung_am TEXT`, `bestaetigung_vermerk TEXT CHECK (bestaetigung_vermerk IN ('versendet','keine','deaktiviert','altbestand'))`; Tabelle `spesen_beleg_kopien(job_id INTEGER PRIMARY KEY REFERENCES jobs(id), pfad TEXT NOT NULL, sha256 TEXT NOT NULL, erstellt_am TEXT NOT NULL)`)
- Modify: `src/db/index.js` (neue `SPESENABRECHNUNGEN_TABLE_MIGRATIONS` + Funktion `migrateSpesenBestaetigung(db)` nach `migrateIbanAenderungMailTyp`: `mail_log`-CHECK um `'spesen-bestaetigung'` per `erweitereCheckPerRebuild` (Muster `migrateIbanAenderungMailTyp`, Marker `'spesen-bestaetigung'`), dann Altbestand markieren)
- Modify: `src/db/adminConfigRepo.js` (DEFAULTS: `spesen_bestaetigung_aktiv: '1'`, `mail_vorlage_spesen_bestaetigung_betreff`, `mail_vorlage_spesen_bestaetigung_text`)
- Modify: `src/services/mailTemplates.js` (`'spesen-bestaetigung': 'spesen_bestaetigung'`)
- Modify: `src/services/notify.js` (`IMMER_SOFORT_TYPEN` + `'spesen-bestaetigung'`, Kommentar ergänzen)
- Modify: `src/services/benachrichtigungsEreignisse.js` (Ereignis `id: 'spesen-bestaetigung'`, Bereich wie die übrigen Spesen-Ereignisse bzw. `'Spesen'`, `sofort: true`, Schalter-Key `spesen_bestaetigung_aktiv` nach dem Muster eines vorhandenen ein-/ausschaltbaren Ereignisses; falls keines existiert, Schalter als Checkbox auf der Ereignis-Seite in `routes/admin/benachrichtigungen.js` + View)
- Test: `test/unit/db.test.js` (oder neues `test/unit/spesenBestaetigungSchema.test.js`), `test/unit/mailTemplates.test.js`

**Standardtexte (exakt):**
- Betreff: `Freigabeportal: Deine Spesen «%titel%» sind freigegeben`
- Text:
  ```
  Hallo %name%

  Deine Spesenabrechnung «%titel%» vom %eingereicht_am% ist freigegeben. Die folgenden Positionen werden nun zur Auszahlung vorbereitet:

  %positionen%

  Total: CHF %summe%
  %nicht_freigegeben%%anhang_hinweis%
  Freundliche Grüsse
  %portalName%
  ```
  `%nicht_freigegeben%` ist leer oder `\nNicht freigegeben:\n- …\n`; `%anhang_hinweis%` ist `\nDie gestempelten Belege findest du im Anhang.\n` oder bei Grössenüberschreitung `\nDie Belege sind zu gross für den Mailversand. Bitte fordere sie bei der Finanzverwaltung an.\n`.

**Interfaces:**
- Produces: Spalten/Tabelle oben; Config-Keys oben; Ereignis-Variablen `name, titel, eingereicht_am, positionen, summe, nicht_freigegeben, anhang_hinweis, portalName`.

**Altbestand-SQL (Algorithmus, in `migrateSpesenBestaetigung`, idempotent):**
```sql
UPDATE spesenabrechnungen SET bestaetigung_am = :jetzt, bestaetigung_vermerk = 'altbestand'
WHERE bestaetigung_am IS NULL
  AND EXISTS (SELECT 1 FROM jobs j WHERE j.spesenabrechnung_id = spesenabrechnungen.id)
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.spesenabrechnung_id = spesenabrechnungen.id
                  AND j.status NOT IN ('abgelehnt','geloescht')
                  AND NOT EXISTS (SELECT 1 FROM bexio_versand b WHERE b.job_id = j.id))
```
Nur beim **ersten** Anlegen der Spalte ausführen (sonst würden später erledigte Abrechnungen beim nächsten Start still als Altbestand markiert, wenn die Bestätigung gerade fehlschlug). Falls `bexio_versand` zu diesem Zeitpunkt noch nicht existiert, die Migration nach dessen Anlage einhängen.

- [ ] **Step 1: Failing tests**
  - `'Migration markiert erledigte Altbestand-Abrechnungen, offene nicht'`: Datenbankdatei mit altem Schema (ohne Spalten) erzeugen – Muster vorhandener Migrations-Tests in `test/unit/` (z. B. `ibanAenderungSchema.test.js`) – mit Abrechnung A (alle Positionen versandt/abgelehnt) und B (eine Position `freigabe2`); `openDatabase` → A `altbestand`, B `NULL`. Zweites `openDatabase` nach Erledigen von B → B bleibt `NULL`.
  - `'mail_log akzeptiert spesen-bestaetigung'`.
  - `mailTemplates.test.js`: `getVorlage(db, 'spesen-bestaetigung')` liefert die Standardtexte.
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Tests + `test/unit/securitySchema.test.js` + `test/unit/db.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: Schema und Vorlage für die Spesen-Bestätigung`

### Task 3: Service `spesenBestaetigung.js`

**Files:**
- Create: `src/services/spesenBestaetigung.js`
- Modify: `src/db/spesenabrechnungenRepo.js` (`listPositionen(db, abrechnungId)`, `setzeBestaetigung(db, abrechnungId, vermerk, jetzt)` → `boolean` (bedingt `WHERE bestaetigung_am IS NULL`))
- Test: `test/unit/spesenBestaetigung.test.js`

**Interfaces:**
- Consumes: Task 1 `reiheMailEin(... anhaenge)`; Task 2 Spalten, Vorlage, Schalter.
- Produces:
  - `sichereBelegKopie(db, config, jobId)` → `{pfad, sha256} | null`. Nur `quelle = 'spesen'`; kopiert `jobDocument(job).pdf_pfad` nach `join(config.jobsDir, 'mail-anhaenge', \`spesen-${jobId}.pdf\`)` (Verzeichnis anlegen), Hash des **Exportnachweises** muss passen, sonst `null` + `console.error`; idempotent (`INSERT OR IGNORE` in `spesen_beleg_kopien`, vorhandene Kopie nicht überschreiben).
  - `pruefeSpesenBestaetigung(db, config, abrechnungId, { jetzt = Date.now() } = {})` → `{ ergebnis: 'offen'|'bereits'|'keine'|'deaktiviert'|'eingereiht', mailId?: number }`. Synchron, eigene `BEGIN IMMEDIATE`-Transaktion (wirft, wenn schon eine läuft).
  - `holeSpesenBestaetigungenNach(db, config)` → `{ geprueft: number, eingereiht: number }` über alle Abrechnungen mit `bestaetigung_am IS NULL`.
  - `abrechnungIdFuerJob(db, jobId)` → `number | null` (nur Spesen).

**Regeln (aus dem Spec):** freigegeben = Zeile in `bexio_versand`; nicht durchgekommen = `abgelehnt`/`geloescht`; sonst `offen`. Keine freigegebene → `keine`. Schalter aus → `deaktiviert` (Marker gesetzt, keine Mail). Einreicher ohne `email` → Vermerk `keine` + `console.error`. Positionen-Zeile: `- <beschreibung oder belegName(job)>: CHF <betrag>`; Abgelehnte: `- <…>: CHF <betrag> (Grund: <ablehnungsgrund>)`, gelöschte ohne Grund-Text `(gelöscht)`. Summe der freigegebenen Beträge mit zwei Nachkommastellen. Anhang-Dateiname: `Spesen-<abrechnungId>-<jobId>.pdf`. Fehlt eine Kopie, `sichereBelegKopie` zuerst nachholen; bleibt sie aus, Position ohne Anhang und `console.error`. Summe Kopiegrössen > 15 MB → keine Anhänge, Hinweistext. `%eingereicht_am%` als `TT.MM.JJJJ` Zürcher Zeit (vorhandenen Datumshelfer verwenden, z. B. den von `belegName.js` genutzten `zeitpunktAnzeige`-Modulnachbarn). Mail wird mit `reiheBenachrichtigungEin`-Logik gerendert, aber über `reiheMailEin(... anhaenge)` eingereiht (Status immer `eingereiht`), `jobId` = erste freigegebene Position.

- [ ] **Step 1: Failing tests** (`test/unit/spesenBestaetigung.test.js`, In-Memory-DB, tmp-`jobsDir`, Positionen per `createJob` + direkte `UPDATE`/`INSERT INTO bexio_versand/export_nachweise` wie in `test/integration/n8n/bexioVersand.test.js`):
  - `'drei versandt → eine Mail mit drei Anhängen'`: `ergebnis === 'eingereiht'`, `listMailAnhaenge(mailId).length === 3`, Text enthält `Total: CHF` + Summe, Vermerk `versendet`.
  - `'zwei versandt + eine abgelehnt → Mail erwähnt Ablehnung mit Grund'`: Text matcht `/Nicht freigegeben/` und den Grund; 2 Anhänge.
  - `'alle abgelehnt → keine Mail'`: `ergebnis === 'keine'`, `mail_log` leer.
  - `'eine Position offen → offen'`: `ergebnis === 'offen'`, `bestaetigung_am IS NULL`.
  - `'zweimal aufgerufen → eine Mail'`: zweiter Aufruf `ergebnis === 'bereits'`.
  - `'Original nach Bereinigung gelöscht → Anhang aus Kopie'`: `sichereBelegKopie` aufrufen, Original-PDF löschen, prüfen → Anhang-Hash = Original-Hash.
  - `'Schalter aus → deaktiviert, keine Mail'`.
  - `'Einreicher ohne Mailadresse → keine, kein Wurf'`.
  - `'Anhänge über 15 MB → Mail ohne Anhänge mit Hinweis'` (Kopie-Datei mit 15 MB + 1 Byte erzeugen; Hash-Prüfung per Stub der Kopie-Zeile).
  - `'Nachholen findet erledigte Abrechnung'`: `holeSpesenBestaetigungenNach` → `eingereiht === 1`.
- [ ] **Step 2:** `node --test test/unit/spesenBestaetigung.test.js` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: Spesen-Bestätigung prüft Abrechnung und reiht Mail mit Belegen ein`

### Task 4: Auslöser und Aufräumen verdrahten

**Files:**
- Modify: `src/routes/n8n/jobs.js` (Route `/:id/bexio-versand-bestaetigen`: bei `neu` und Spesen-Job nach `bestaetigeBexioVersand` → `sichereBelegKopie`, `pruefeSpesenBestaetigung`; bei `eingereiht` und vorhandenem `mailer` `stelleMailZu` im Hintergrund wie `sendeNotificationsImHintergrund`)
- Modify: `src/routes/spesenFreigabe1.js` und `src/routes/freigabe2.js` (nach `COMMIT` der Ablehnung, nur `job.quelle === 'spesen'`: `pruefeSpesenBestaetigung` + Hintergrundzustellung)
- Modify: `src/services/cronJobs.js` (`runPdfBereinigungJobInternal`: zuerst `holeSpesenBestaetigungenNach` (Mails bleiben `eingereiht`, Job `mail-zustellung` stellt zu); nach `pruneMailLogOlderThan`: Kopien löschen, deren Abrechnung `bestaetigung_am IS NOT NULL` hat und deren `pfad` in keiner `mail_anhaenge`-Zeile mehr vorkommt → `loescheDateiMitAudit(..., { objekt: 'jobs', objektId: jobId, dateiart: 'mail_anhang', anlass: 'Spesen-Bestätigung erledigt' })`, danach Zeile aus `spesen_beleg_kopien` entfernen; Zähler in `details`)
- Test: `test/integration/n8n/bexioVersand.test.js`, `test/integration/spesenFreigabe1.test.js`, `test/integration/freigabe2.test.js`, `test/integration/pdfBereinigungEndToEnd.test.js`

**Interfaces:**
- Consumes: Task 3 `sichereBelegKopie`, `pruefeSpesenBestaetigung`, `holeSpesenBestaetigungenNach`, `abrechnungIdFuerJob`; Task 1 `stelleMailZu`.

- [ ] **Step 1: Failing tests**
  - `bexioVersand.test.js` › `'letzte Spesenposition quittiert → Bestätigung eingereiht, Kopie angelegt'` und `'doppelte Quittung (gleiche message_id) → weiterhin eine Mail'`.
  - `bexioVersand.test.js` › `'Bestätigungsfehler lässt Quittung trotzdem 201 durch'` (z. B. Vorlage auf leeren Betreff setzen bzw. `jobsDir` unbeschreibbar) → Status 201, Quittung gespeichert.
  - `spesenFreigabe1.test.js` und `freigabe2.test.js` › `'Ablehnung der letzten offenen Spesenposition löst Bestätigung aus'` (andere Positionen vorher mit `bexio_versand`-Zeile).
  - `pdfBereinigungEndToEnd.test.js` › `'Kopie bleibt bis zur Mail-Aufbewahrung, danach gelöscht mit Audit'` und `'Nachholen im Nachtlauf reiht übersehene Bestätigung ein'`.
- [ ] **Step 2:** betroffene Testdateien → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test -- --test-concurrency=2` → alles grün (inkl. `csrfSweep`, `cspSweep`).
- [ ] **Step 5: Commit** `feat: Spesen-Bestätigung nach Bexio-Versand und Ablehnung auslösen`

### Task 5: Doku, Anleitung, Version

**Files:**
- Modify: `docs/n8n-schnittstelle.md` (Abschnitt «Versand an Bexio bestätigen»: löst bei Spesen die Bestätigung aus; n8n muss nichts Neues tun)
- Modify: Doku der Mailtypen/Benachrichtigungen in `docs/` (Datei per `grep -rl "iban-aenderung" docs/` finden) und `docs/admin-bereich.md` (Schalter)
- Modify: Anwender-Anleitung-Quellen in `docs/anleitung/` (Abschnitt Spesen: «Du bekommst eine Bestätigung mit Belegen, sobald alles an die Buchhaltung übergeben ist»)
- Modify: `docs/testdrehbuch/` (neues Szenario: drei Positionen, eine abgelehnt → Bestätigung mit zwei Anhängen) – nur die Szenario-Quelle; die vom Nutzer lokal geänderten Dateien `gen.mjs`, `build.py`, `golive.py`, `template.html` **nicht** anfassen bzw. nicht mitcommitten
- Modify: `package.json` Version → `1.5.0`; Versionsanzeige-Test `test/unit/version.test.js` falls nötig
- [ ] **Step 1:** Doku schreiben.
- [ ] **Step 2:** `npm test -- --test-concurrency=2` → grün.
- [ ] **Step 3: Commit** `docs: Spesen-Bestätigung dokumentiert (Version 1.5.0)` — nur die eigenen Dateien stagen.
