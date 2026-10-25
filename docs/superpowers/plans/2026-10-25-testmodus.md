# Testmodus (Spielwiese) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins schalten für ihre Sitzung eine getrennte Spielwiese ein (eigene DB, eigenes Dateiverzeichnis, Test-Postfach, keine Aussenwirkung), handeln dort als Beispielpersonen und setzen sie bei Bedarf zurück.

**Architecture:** Eine zweite App-Instanz aus `createApp({ ..., testmodus: {...} })` mit Spiel-DB und Test-Konfiguration ohne ChurchTools-/TSA-/n8n-/Backup-Anbindung und ohne Scheduler. Eine Weiche in der echten App (nach Sitzung und `loadCurrentPerson`) leitet Anfragen von Sitzungen mit eingeschaltetem Testmodus an die Test-Instanz; Anmeldung, Abmelden, `/healthz`, `/admin/testmodus` und `/admin/betrieb/status` bleiben in der echten App.

**Tech Stack:** Node.js, Express 4, EJS, node:sqlite, pdf-lib (vorhanden) für Beispiel-PDFs, `node:test` + supertest, undici MockAgent.

**Spec:** `docs/superpowers/specs/2026-10-25-testmodus-design.md`

## Global Constraints

- Nur Superadmin und Manager schalten ein (`requireAnyRole(config, ['superadmin','manager'])` bzw. vorhandenes Muster).
- Spiel-DB-Datei `<dbPath>.testmodus.db`, Dateiverzeichnis `<jobsDir>-testmodus`, Branding-Kopie `<brandingDir>-testmodus`.
- In der Test-Instanz: kein Scheduler, `config.churchtools.syncServiceToken = null`, ChurchTools-URL `https://testmodus.invalid`, n8n-/Backup-/Cron-Schlüssel `null` (Maschinen-Routen antworten 401), `zeitstempel_tsa_url` leer, Mailer = Test-Mailer (schreibt nur `mail_log` mit Status `versendet`, kein SMTP).
- Kopie der Einstellungen: alle `admin_config`-Zeilen ausser Schlüsseln, deren Name `secret`, `token`, `pass`, `key` enthält, ausser `zeitstempel_tsa_url`, `zeitstempel_tsa_user`, `zeitstempel_tsa_passwort`, `monitoring_secret`, `einrichtung_*`.
- Beispielpersonen (IDs `test-1` … `test-5`): Anna Beispiel (Freigeberin 1), Ben Beispiel (Freigeber 2), Carla Beispiel (reicht Spesen ein), Dora Beispiel (Admin, Superadmin-Gruppe der Test-Konfiguration), Emil Beispiel (Stellvertretung). E-Mail `<vorname>@beispiel.invalid`.
- Band auf jeder Seite der Test-Instanz: "Testmodus — nichts hier ist echt", Auswahl der Beispielperson, Knopf "Testmodus beenden"; kontrastreich, auch bei 360 px sichtbar.
- Ein-/Ausschalten, Personenwechsel und Zurücksetzen werden im **echten** Audit-Log protokolliert (`objekt = 'testmodus'`).
- Abmelden beendet den Testmodus; Session-Flag `req.session.testmodus = { personId }`.
- Jeder Task endet mit `npm test` grün (aktuell 2077 Tests).

## Review Focus

1. Testmodus aktiv, Admin ruft eine Maschinen-Route (`/api/n8n/...`) oder `/healthz` auf → echte App bzw. 401, keine Vermischung (Task 3 Test).
2. Zwei Admins gleichzeitig: einer im Testmodus, einer nicht → der andere sieht nur echte Daten (Task 3 Test).
3. Spiel-DB-Datei fehlt oder ist beschädigt beim Einschalten → wird neu erstellt, verständliche Meldung, echte App unberührt (Task 1/3 Test).
4. Ein Formular aus dem Testmodus wird nach dem Ausschalten abgeschickt (alte Seite) → landet nicht in der echten DB (CSRF/Weiche: echte App lehnt ab oder führt nicht aus) (Task 3 Test).
5. Upload im Testmodus → Datei nur im Test-Verzeichnis, Zurücksetzen löscht sie (Task 1/4 Test).

---

### Task 1: Spielwiese erzeugen und zurücksetzen

**Files:**
- Create: `src/services/testmodus/spielwiese.js`, `src/services/testmodus/beispieldaten.js`
- Test: `test/unit/testmodusSpielwiese.test.js`

**Interfaces:**
- Produces: `testmodusPfade(config) → { dbPath, jobsDir, brandingDir }`.
- Produces: `erstelleSpielwiese(echteDb, config, { neu = false } = {}) → { db, config: testConfig }` — öffnet bzw. erstellt die Spiel-DB mit `openDatabase`, bei `neu` oder fehlender/beschädigter Datei: Datei und Verzeichnisse löschen und neu anlegen, `seedDefaults`, Einstellungen kopieren (Regeln aus Global Constraints), Branding-Dateien kopieren, Beispieldaten einspielen. `testConfig` = Kopie von `config` mit den Abweichungen aus Global Constraints und `churchtools.groupIdAdmin = 'test-admin'`, `groupIdBuchhaltung = 'test-buchhaltung'`.
- Produces: `spieleBeispieldatenEin(db, testConfig)` — Personen (Global Constraints), 2 Konten (z. B. "3000 Jugend" F1 Anna/F2 Ben/SV Emil, "6000 Verwaltung" F1 Anna/F2 Dora), 2 Kreditoren, Rechnungen je Stufe (Pool, zugewiesen an Anna, Freigabe 2 bei Ben, abgelehnt, abgeschlossen) mit zur Laufzeit erzeugten einseitigen Beispiel-PDFs (pdf-lib, Text "Beispielrechnung – kein echtes Dokument"), eine Spesenposition von Carla.
- Produces: `entferneSpielwiese(config)`.

- [ ] **Step 1: Failing tests:** `erstellt DB, Verzeichnisse, Beispieldaten`; `kopiert Einstellungen ohne Geheimnisse und ohne TSA/Monitoring/Einrichtung`; `neu=true setzt zurück (eigene Zusatzdaten weg)`; `beschädigte Datei wird neu erstellt`; `echte DB unverändert` (Zeilenzahlen vorher/nachher gleich); `testConfig` ohne Token/URLs.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(testmodus): Spielwiese erzeugen und zurücksetzen`.

### Task 2: Test-Instanz der App

**Files:**
- Modify: `src/app.js` (Option `testmodus: { mailer }` in `createApp`: ohne Session-Middleware und ohne Login-/Auth-Router; `req.currentPerson` = Beispielperson aus `req.session.testmodus.personId`, nur IDs `test-*`; `res.locals.testmodus = { person, beispielpersonen }`), `views/_seite_anfang.ejs` (Band wenn `testmodus`)
- Create: `src/services/testmodus/testMailer.js`
- Test: `test/integration/testmodusInstanz.test.js`

**Interfaces:**
- Produces: `createTestMailer() → { sendMail(mail) }` (sammelt nur; zusammen mit dem bestehenden Outbox-Ablauf ergibt das `mail_log` Status `versendet` in der Spiel-DB).
- Produces: `createApp({ db, config, mailer, testmodus: true })` — CSRF bleibt aktiv (nutzt die von der echten App übernommene `req.session`).

- [ ] **Step 1: Failing tests:** Test-Instanz mit Spiel-DB, Sitzungsobjekt von aussen gesetzt (`req.session = { testmodus: { personId: 'test-1' } }`): `/pool` zeigt Beispielrechnungen und das Band; Kontieren/Freigeben als Anna dann Ben funktioniert (Vier-Augen); Mail landet nur im Test-Mailer; keine ausgehenden fetch-Aufrufe (`MockAgent.disableNetConnect`, ganze Rundreise); Maschinen-Routen 401; Person-ID ausserhalb `test-*` → 403.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(testmodus): Test-Instanz ohne Aussenwirkung`.

### Task 3: Weiche und Admin-Seite

**Files:**
- Create: `src/routes/admin/testmodus.js`, `views/admin/testmodus.ejs`, `src/middleware/testmodusWeiche.js`
- Modify: `src/app.js` (Weiche nach `loadCurrentPerson`; Mount `/admin/testmodus`), `src/routes/auth.js` (Abmelden löscht `req.session.testmodus`), Navigation (Admin → Betrieb "Testmodus", Superadmin/Manager)
- Test: `test/integration/testmodusWeiche.test.js`, `csrfSweep`

**Interfaces:**
- Produces: `testmodusWeiche({ echteDb, config, holeTestApp })` — wenn `req.session.testmodus` gesetzt **und** `req.currentPerson` (echte Person) Superadmin/Manager ist **und** der Pfad nicht mit `/auth`, `/healthz`, `/admin/testmodus`, `/admin/betrieb/status`, `/api/`, `/internal/`, `/static`, `/branding` (echte App) beginnt → Anfrage an `holeTestApp()` (lazy erzeugt aus Task 1 + Task 2, im Speicher gehalten); sonst `next()`. Verliert die Person die Admin-Rolle → Flag löschen.
- Routen (echte App, CSRF): `GET /admin/testmodus` (Status, Erklärung), `POST /ein` (Person standardmässig Dora), `POST /aus`, `POST /person` (`personId` aus Beispielpersonen; auch aus dem Band), `POST /zuruecksetzen` (`erstelleSpielwiese(..., { neu: true })`, nur wenn Testmodus aus oder mit Bestätigung).

- [ ] **Step 1: Failing tests:** Einschalten nur Superadmin/Manager (sonst 403); danach `/pool` zeigt Spielwiese, `/admin/testmodus` und `/healthz` echte App; zweite Sitzung ohne Testmodus sieht echte Daten; Ausschalten → echte Daten; Abmelden beendet; Formular aus Testmodus nach Ausschalten (POST `/kontierung/<testId>`) verändert die echte DB nicht; Zurücksetzen; Audit-Einträge im echten Log; Sweeps.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(testmodus): Weiche und Admin-Seite`.

### Task 4: Test-Postfach und Jobs per Knopf

**Files:**
- Create: `src/routes/testmodusInstanz.js` (nur in der Test-Instanz gemountet unter `/testmodus`), `views/testmodus-postfach.ejs`
- Modify: Band (Links "Test-Postfach", "Jobs auslösen")
- Test: `test/integration/testmodusPostfach.test.js`

**Interfaces:**
- `GET /testmodus/postfach` (alle `mail_log`-Einträge der Spiel-DB, neueste zuerst: Zeit, Empfänger, Betreff, Text), `POST /testmodus/jobs` (führt in der Spiel-DB `pool-erinnerungen`, `freigabe2-erinnerungen`, `mail-digest`, `mail-zustellung` aus; Sync, Backup, Zeitstempel, n8n nicht), Ergebnis als Meldung.

- [ ] **Step 1: Failing tests:** Postfach zeigt die beim Freigeben entstandene Mail; Jobs erzeugen Erinnerungsmails im Postfach, nicht in der echten DB; Route existiert in der echten App nicht (404).
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(testmodus): Test-Postfach und Jobs`.

### Task 5: Dokumentation

**Files:**
- Create: `docs/testmodus.md`
- Modify: `docs/README.md`, `docs/admin-bereich.md`, `docs/architektur.md` (Weiche, Test-Instanz), `docs/backup-sicherheit.md` oder passende Stelle (Spiel-DB ist nicht Teil der Sicherung)

- [ ] **Step 1:** Doku schreiben; Pfade, Routen, IDs per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Testmodus dokumentieren`.
