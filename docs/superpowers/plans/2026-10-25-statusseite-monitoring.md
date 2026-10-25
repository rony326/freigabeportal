# Statusseite und Monitoring-Endpunkt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ampel pro Hintergrunddienst auf einer Admin-Statusseite und dieselben Daten als JSON über das bestehende `/healthz` (mit Schlüssel) für Uptime Kuma.

**Architecture:** Ein Service `statusPruefungen.js` mit einer Prüffunktion pro Dienst und einem gemeinsamen Ergebnisformat; `/healthz` liefert ohne Schlüssel die Kurzantwort, mit gültigem `X-Monitoring-Key` das volle JSON. Die TSA-Erreichbarkeit wird höchstens alle 15 Minuten geprüft und zwischengespeichert. Admin-Seite unter `/admin/betrieb/status` mit Grenzwert-Formular und Schlüsselverwaltung.

**Tech Stack:** Node.js, Express 4, EJS, node:sqlite, express-rate-limit (vorhanden), `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-10-25-statusseite-monitoring-design.md`

## Global Constraints

- Status-Werte exakt `ok`, `warnung`, `fehler`; Gesamtstatus = schlechtester Dienst; nicht eingerichteter Dienst → `{ status: 'ok', aktiv: false, grund: 'nicht eingerichtet' }`.
- Dienst-Schlüssel exakt: `datenbank`, `sicherung`, `mailversand`, `churchtools`, `zeitstempel`, `audit_nachweis`, `archivuebergabe`, `speicher`, `jobs`, `sicherheitsalarme`.
- Standard-Grenzwerte (Config-Schlüssel, Defaults): `status_sicherung_warnung_stunden` 26, `status_sicherung_fehler_stunden` 50, `status_mail_wartezeit_fehler_minuten` 60, `status_churchtools_warnung_stunden` 26, `status_churchtools_fehler_stunden` 50, `status_zeitstempel_crl_warnung_tage` 7, `status_archiv_warnung_stunden` 48, `status_archiv_fehler_tage` 7, `status_speicher_warnung_prozent` 15, `status_speicher_fehler_prozent` 5. Mail-Fehlversuche-Fenster fest 24 h; Audit-Nachweis nutzt `audit_zeitstempel_alarm_tage`.
- JSON-Format: `{ status, geprueft_am, version, dienste: { <schluessel>: { status, grund, seit?, aktiv? } } }`; `grund` deutsch, kurz, ohne Personen-, Rechnungs- oder Konfigurationswerte (keine URLs, Pfade, Namen).
- `/healthz`: ohne oder mit falschem Schlüssel `200 {"status":"ok"}` bzw. `503 {"status":"fehler"}` bei Datenbankfehler; mit gültigem Schlüssel 200 + volles JSON (503 nur bei Datenbankfehler). Schlüsselvergleich mit `crypto.timingSafeEqual` auf gleich lange Hashes.
- Schlüssel: Config `monitoring_secret`, 64 Hex-Zeichen (32 Byte), leer = Details aus; Erneuern im Audit-Log (Wert durch bestehendes `*secret*`-Schwärzen geschützt).
- Eigener Limiter für `/healthz`: 120 Anfragen pro Minute pro IP.
- TSA-Erreichbarkeit: höchstens alle 15 min ein echter Versuch, Ergebnis im Speicher; Antwortzeit `/healthz` < 500 ms ohne TSA-Versuch.
- Statusseite: Recht `betrieb_einsehen`; responsive (360/768/1280 px ohne seitliches Scrollen).
- Jeder Task endet mit `npm test` grün (aktuell 1965 Tests).

## Review Focus

1. Frische Installation ohne einen einzigen Job-Lauf, ohne TSA, ohne Sync → kein Dienst `fehler` ausser wenn wirklich kaputt; "noch nie gelaufen" nach Ablauf der Grenze = Warnung/Fehler mit Grund "noch nie erfolgreich", vorher `ok` mit "noch kein Lauf" (Task 1 Test `frische Installation`).
2. Speicherprüfung auf einem System, wo `fs.statfs` fehlt oder wirft → `ok`, `aktiv: false`, Grund "unbekannt" (Task 1 Test).
3. Schlüssel mit anderer Länge, Gross/Kleinschreibung, fehlender Header → nie Details, nie 401, kein Fehler im Log (Task 2 Test).
4. TSA hängt (Timeout) → `/healthz` wartet nicht; nächster Versuch frühestens nach 15 min (Task 2 Test mit gestubbtem Versuch).
5. JSON enthält nirgends Personen-E-Mails, Namen, Dateipfade oder URLs (Task 2 Test, der alle `grund`-Texte gegen Muster prüft).

---

### Task 1: Prüffunktionen pro Dienst

**Files:**
- Create: `src/services/statusPruefungen.js`
- Modify: `src/db/adminConfigRepo.js` (Defaults)
- Test: `test/unit/statusPruefungen.test.js`

**Interfaces:**
- Produces: `pruefeAlleDienste(db, config, { jetzt = new Date(), tsaErgebnis = null, statfs = fs.statfsSync } = {}) → { status, geprueft_am, dienste }` (ohne `version`).
- Produces: je Dienst `pruefe<Name>(db, config, ctx) → { status, grund, seit?, aktiv? }`: `pruefeDatenbank` (einfaches `SELECT 1`), `pruefeSicherung` (letzter Eintrag `cron_log` job `datenbank-sicherung`: Status und Zeit des letzten `erfolg`), `pruefeMailversand` (`mail_log` Status `fehlgeschlagen` in 24 h → Warnung; `eingereiht` mit `eingereiht_am` älter als Grenze → Fehler), `pruefeChurchtools` (`sync_log` letzter `status` = Erfolgswert und `beendet_am`), `pruefeZeitstempel` (TSA-URL leer → nicht eingerichtet; Sperrlisten aus `config.tsaCrlFile` via `loadTsaCrls` → frühestes `nextUpdate`; `countZeitstempelUeberfaellig` > 0 → Warnung; `ctx.tsaErgebnis?.erreichbar === false` → Fehler), `pruefeAuditNachweis` (Modul aus → nicht eingerichtet; Paket ohne Zeitstempel → Warnung; älter als `audit_zeitstempel_alarm_tage` → Fehler), `pruefeArchivuebergabe` (`jobs` Status `abgeschlossen`, nicht abgeholt, `abgeschlossen_am` älter als Grenzen), `pruefeSpeicher` (`statfs` auf dem Verzeichnis von `config.dbPath`), `pruefeJobs` (je Job der letzte `cron_log`-Eintrag; einer `fehler` → Warnung mit Jobnamen), `pruefeSicherheitsalarme` (`sicherheitsalarme` mit Status ≠ `erledigt` → Fehler).
- `seit` = Zeitpunkt, seit dem der aktuelle Zustand besteht, soweit aus den Daten ableitbar (z. B. letzter Erfolg).

- [ ] **Step 1: Failing tests:** je Dienst `ok`/`warnung`/`fehler` genau an den Grenzwerten (Werte aus Global Constraints, `jetzt` injiziert); `Grenzwerte aus admin_config überschreiben Defaults`; `frische Installation` (keine Läufe: vor Ablauf der Fehlergrenze seit Installationsdatum `ok` "noch kein Lauf"; Installationsdatum = ältester `admin_config`/`audit_ereignisse`-Zeitpunkt oder `jetzt`); `statfs wirft → ok, aktiv false`; `Gesamtstatus = schlechtester`; `grund enthält keine Pfade/URLs`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(status): Prüffunktionen pro Dienst`.

### Task 2: /healthz mit Schlüssel und TSA-Zwischenspeicher

**Files:**
- Create: `src/services/statusTsa.js`, `src/routes/healthz.js`
- Modify: `src/app.js` (bestehende Zeile `app.get('/healthz', …)` durch Router mit eigenem Limiter ersetzen)
- Test: `test/integration/healthz.test.js`

**Interfaces:**
- Consumes: `pruefeAlleDienste` (Task 1); `tsaConfigAusDb`, `stempleAuditPaket`-ähnlicher Testversuch aus `src/services/auditZeitstempel.js` (Zeitstempel über 32 Zufallsbytes, Ergebnis verworfen).
- Produces: `tsaErreichbarkeit(db, config, { jetzt, versuch } ) → { erreichbar: boolean|null, geprueft_am }` — startet höchstens alle 15 min einen Versuch **im Hintergrund** (nicht awaited im Request), liefert sonst den letzten Wert; `null` = noch nie geprüft.
- Produces: `createHealthzRouter({ db, config, versionFn })`.

- [ ] **Step 1: Failing tests:** ohne Header → exakt `{"status":"ok"}`; falscher/zu kurzer/anderer-Länge Schlüssel → gleiche Kurzantwort, 200; gültiger Schlüssel → alle 10 Dienst-Schlüssel, `version`, `geprueft_am`; leeres `monitoring_secret` → nie Details; DB geschlossen → 503 mit und ohne Schlüssel; TSA-Versuch gestubbt hängend → Antwort ohne Warten, zweiter Aufruf innerhalb 15 min startet keinen zweiten Versuch; Limiter: 121. Anfrage in einer Minute → 429; `keine Personendaten` (Person mit E-Mail anlegen, Fehler-Zustände provozieren, JSON enthält weder E-Mail noch Name noch `/` gefolgt von Pfaden).
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(status): Monitoring-JSON über /healthz`.

### Task 3: Statusseite im Admin-Bereich

**Files:**
- Create: `views/admin/betrieb-status.ejs`
- Modify: `src/routes/admin/betrieb.js` (Routen `GET /status`, `POST /status/grenzwerte`, `POST /status/schluessel`), Navigation des Betrieb-Bereichs (Reiter/Link "Status"), Admin-Dashboard-Karte zeigt Gesamtstatus
- Test: `test/integration/admin/betriebStatus.test.js`, `csrfSweep`

**Interfaces:**
- Consumes: `pruefeAlleDienste`, `tsaErreichbarkeit`.
- Seite: Tabelle/Kacheln pro Dienst (Ampel, Name deutsch, Grund, seit, Link zur passenden Admin-Seite: Backup, Mails, Sync, Zeitstempel, Audit-Nachweis, Geplante Jobs, Sicherheitsalarme bzw. Backup-Seite), Grenzwert-Formular (Ganzzahlen > 0, Fehlergrenze ≥ Warnungsgrenze wo beides existiert; ungültig → 400, nichts gespeichert), Schlüssel-Abschnitt: Status "eingerichtet/nicht eingerichtet", Knopf "Neuen Schlüssel erzeugen" (zeigt ihn genau einmal auf der Antwortseite mit Kopier-Hinweis und Uptime-Kuma-Beispiel), Knopf "Schlüssel entfernen".

- [ ] **Step 1: Failing tests:** Zugang (`betrieb_einsehen` 200, ohne 403, Manager ohne Einzelrecht 403); `zeigt alle Dienste mit Ampel`; `Grenzwerte speichern/validieren`; `Schlüssel erzeugen zeigt ihn einmal, danach nie mehr`; `Schlüssel entfernen → /healthz ohne Details`; `Audit-Eintrag ohne Klartextschlüssel`; Sweeps.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(status): Statusseite im Admin-Bereich`.

### Task 4: Dokumentation inkl. Uptime-Kuma-Anleitung

**Files:**
- Create: `docs/statusseite-und-monitoring.md` (Dienste mit Grenzwerten, JSON-Beispiel, Uptime-Kuma: Monitor-Typ "HTTP(s) - Json Query", URL `https://<domain>/healthz`, Header `X-Monitoring-Key: <schluessel>` (Feld "Headers" als JSON), JSON-Query je Dienst z. B. `dienste.sicherung.status`, erwarteter Wert `ok`, empfohlenes Intervall 60 s; zusätzlich ein Gesamt-Monitor `status`)
- Modify: `docs/README.md`, `docs/admin-bereich.md`, `README.md` (Go-Live-Checkliste Punkt 1 um Hinweis auf Details-Schlüssel ergänzen, Liste sonst unverändert)

- [ ] **Step 1:** Doku schreiben; Schlüsselnamen und Routen per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Statusseite und Monitoring dokumentieren`.
