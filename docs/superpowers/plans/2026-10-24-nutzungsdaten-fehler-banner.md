# Nutzungsdaten, Fehlermeldungen und Banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personenbezogene Nutzungsdaten (Seitenaufrufe, Anmeldungen, Geräte), automatische Fehlererfassung mit "Fehler melden", Mail bei neuem Gerät, Banner für Ankündigungen und Datenschutzhinweis — einsehbar über das Recht "Betrieb & Nutzung".

**Architecture:** Eine Middleware nach `loadCurrentPerson` erfasst Seitenaufrufe am Ende jeder Anfrage; der zentrale Fehler-Handler erfasst Fehler unter der bestehenden Anfrage-ID; der Login-Callback erfasst Anmeldungen und erkennt neue Geräte über ein eigenes Cookie. Banner werden im Shell-Layout gerendert. Admin-Seiten unter `/admin/betrieb`, ein täglicher Bereinigungsjob löscht nach Frist.

**Tech Stack:** Node.js, Express 4, EJS, node:sqlite, cookie-parser (vorhanden), `node:test` + supertest. Keine neue Abhängigkeit.

**Spec:** `docs/superpowers/specs/2026-10-24-nutzungsdaten-fehler-banner-design.md`

## Global Constraints

- Recht `betrieb_einsehen` ("Betrieb & Nutzung") additiv in `RIGHTS`, `GRANTABLE_BERECHTIGUNGEN`, `BERECHTIGUNG_LABELS`; Superadmin über Bundle, **Manager nicht** (in `personHasPermission` wie `sync_verwalten`/`workflow_eingreifen` ausnehmen).
- Aufbewahrung: Seitenaufrufe **90 Tage**; Anmeldungen, Fehler, Fehlermeldungen **365 Tage**; Geräte-Einträge 365 Tage nach `zuletzt_am`.
- Geräte-Cookie `fp_geraet`: 32 Hex-Zeichen zufällig, HttpOnly, SameSite=Lax, Secure wenn die Session-Cookies Secure sind, maxAge 2 Jahre; ungültiger Wert wird ersetzt.
- Erfasst werden nur angemeldete Personen, nur Anfragen, deren Antwort `text/html` ist; ausgenommen Präfixe `/api/n8n`, `/internal/cron`, `/branding`, `/downloads/` (Dateistreams), statische Assets.
- Gespeichert wird `pfad` = `req.path` (**ohne Query-String**) und `pfad_muster` mit Zahlensegmenten als `:id` (`/kontierung/123/aufsplitten` → `/kontierung/:id/aufsplitten`); nie Body, Query oder Header ausser User-Agent.
- Erfassen darf eine Anfrage nie scheitern lassen: jeder Fehler im Erfassen wird gefangen und höchstens einmal pro Stunde mit `console.error` gemeldet.
- Fehler-ID = bestehende Anfrage-ID aus `currentAuditRequestId()`; angezeigt werden die ersten 8 Zeichen, gesucht wird per Präfix (≥ 8 Zeichen).
- Mail-Typen neu: `neues-geraet`, `fehlermeldung` — beide immer sofort, bearbeitbare Vorlagen.
- Config neu: `betrieb_kontakt_email` Default `''` (Mail-Text sagt dann "die Portal-Administration"), `datenschutz_text` (Default-Text in Task 5).
- Banner-Arten `info` (wegklickbar), `wartung`, `warnung` (nicht wegklickbar); Reihenfolge `wartung`, `warnung`, `info`, dann `von` aufsteigend; nur Text (escaped), `\n` → Zeilenumbruch, optionaler Link `https://…` oder `/…`.
- UI Deutsch, "du", Schweizer Schreibweise; Desktop im Shell-Layout.
- Jeder Task endet mit `npm test` grün (aktuell 1895 Tests).

## Review Focus

1. Datenbank wirft beim Erfassen (z. B. gesperrt) → Seite antwortet trotzdem normal (Task 2 Test `Erfassen scheitert still`).
2. Aufruf mit Token im Query-String (`/downloads/…?token=abc`, `/pool?suche=…`) → kein Query-Teil gespeichert (Task 2 Test `kein Query-String`).
3. Banner-Text mit `<script>` oder `javascript:`-Link → Text escaped, Link abgelehnt (Task 5 Tests).
4. Person ohne dauerhaftes Cookie (privates Fenster) meldet sich mehrmals an → jedes Mal "neues Gerät"-Mail mit dem Hinweis auf gelöschte Browserdaten; allererste Anmeldung ohne Mail (Task 3 Tests).
5. Gefälschte oder fremde Fehler-ID im Melde-Formular → Meldung wird gespeichert, verknüpft nur, wenn der Fehler zur meldenden Person gehört oder ohne Person war (Task 4 Test).

---

### Task 1: Schema, Recht, Einstellungen, Mail-Typen

**Files:**
- Create: `src/db/betriebSchema.js` (`migrateBetriebSchema(db)`, in `openDatabase` vor `migrateSecuritySchema`)
- Modify: `src/db/index.js` (Aufruf; `migrateBetriebMailTypen(db)` nach der letzten mail_log-Erweiterung), `src/db/schema.sql` (mail_log-CHECK), `src/db/securitySchema.js` (`RIGHTS`; zentrale Audit-Liste: `banner: 'id'`, `betrieb_fehlermeldungen: 'id'`), `src/middleware/permissions.js`, `src/db/adminConfigRepo.js`, `src/services/mailTemplates.js`, `src/services/notify.js`, `src/routes/admin/mailEinstellungen.js` + Form
- Test: `test/unit/betriebSchema.test.js`, `test/integration/admin/mailEinstellungen.test.js`

**Interfaces:**
- Tabellen:
  - `nutzung_seitenaufrufe(id PK, zeitpunkt NOT NULL, person_id NOT NULL, methode, pfad NOT NULL, pfad_muster NOT NULL, status INTEGER, dauer_ms INTEGER, geraet_id, geraet_typ, browser, betriebssystem, request_id)` + Index `(zeitpunkt)`, `(person_id, zeitpunkt)`.
  - `nutzung_geraete(geraet_id, person_id, erstmals_am, zuletzt_am, user_agent, geraet_typ, browser, betriebssystem, PRIMARY KEY(geraet_id, person_id))`.
  - `nutzung_anmeldungen(id PK, zeitpunkt, person_id, erfolg INTEGER NOT NULL, grund TEXT, ip, geraet_id, user_agent, neues_geraet INTEGER NOT NULL DEFAULT 0)`.
  - `betrieb_fehler(id PK, request_id TEXT UNIQUE NOT NULL, zeitpunkt, person_id, methode, pfad, status INTEGER, meldung TEXT, stack TEXT, user_agent, geraet_id)`.
  - `betrieb_fehlermeldungen(id PK, zeitpunkt, person_id NOT NULL, request_id, beschreibung TEXT CHECK(length(beschreibung) <= 2000), seite TEXT, user_agent, status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','in_arbeit','erledigt')), notiz TEXT, bearbeitet_von, bearbeitet_am)`.
  - `banner(id PK, art TEXT NOT NULL CHECK(art IN ('info','wartung','warnung')), text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 1000), link TEXT, von TEXT NOT NULL, bis TEXT NOT NULL CHECK(bis >= von), erstellt_von, erstellt_am, aktiv INTEGER NOT NULL DEFAULT 1)` — `von`/`bis` ISO-Zeitpunkte.
  - `banner_ausgeblendet(banner_id, person_id, zeitpunkt, PRIMARY KEY(banner_id, person_id))`.
- Recht, Config-Defaults, Mail-Typen und Vorlagen: `neues-geraet` (`%empfaengerName% %zeitpunkt% %geraet% %ip% %kontakt% %portalName%`), `fehlermeldung` (`%meldendePerson% %seite% %fehlerId% %beschreibung% %link% %portalName%`).

- [ ] **Step 1: Failing tests:** `Tabellen vorhanden`; `Recht vergebbar, Manager hat es nicht, Superadmin schon`; `mail_log akzeptiert neue Typen`; `bestehende DB wird erweitert` (Muster `test/unit/duplikatVerdachtSchema.test.js`); `Audit-Trigger für banner und betrieb_fehlermeldungen`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Schema, Recht und Mail-Typen`.

### Task 2: Seitenaufrufe, Geräte und Fehler erfassen

**Files:**
- Create: `src/services/nutzung.js`, `src/middleware/nutzungErfassen.js`
- Modify: `src/app.js` (Middleware direkt nach `loadCurrentPerson(db)`; Fehler-Handler ruft `erfasseFehler`), `views/error.ejs` (Fehler-ID + Melde-Formular, Task 4 liefert die Route)
- Test: `test/unit/nutzung.test.js`, `test/integration/nutzungErfassen.test.js`, `test/integration/errors.test.js`

**Interfaces:**
- `geraetAusUserAgent(ua: string) → { geraetTyp: 'desktop'|'tablet'|'handy'|'unbekannt', browser: string, betriebssystem: string }` — einfache Regeln: Browser `Edge`, `Chrome`, `Firefox`, `Safari`, `Samsung Internet`, sonst `Andere` (+ Hauptversion, z. B. `Firefox 131`); Betriebssystem `Windows`, `macOS`, `iOS`, `iPadOS`, `Android`, `Linux`, sonst `Andere`; Tablet = iPad oder Android ohne `Mobile`.
- `normalisierePfad(pfad) → string` (Zahlensegmente und 32/36-stellige Hex/UUID-Segmente → `:id`).
- `geraeteIdAusCookie(req, res) → string` (liest/setzt `fp_geraet`).
- `erfasseSeitenaufruf(db, { req, res, dauerMs }) → void` (wirft nie) — inkl. Upsert `nutzung_geraete` (`zuletzt_am`).
- `erfasseFehler(db, { req, err, status }) → string` (Request-ID; wirft nie; `stack` max. 8000 Zeichen).
- `nutzungErfassen(db) → Express-Middleware` (Zeit messen, auf `res.on('finish')` erfassen).
- Fehlerseite: zeigt "Fehler-ID: <8 Zeichen>" nur bei Status 500 und einen Knopf "Fehler melden" (Formular `POST /fehler-melden` mit Feld `fehlerId` und `beschreibung`, nur wenn angemeldet). Nie Stacktrace.

- [ ] **Step 1: Failing tests:** `geraetAusUserAgent` (je ein echter UA für Chrome/Windows, Safari/iPhone, Safari/iPad, Firefox/Linux, Samsung Internet/Android-Handy, Android-Tablet); `normalisierePfad`; `Seitenaufruf angemeldet erfasst, abgemeldet nicht`; `kein Query-String`; `ausgenommene Präfixe nicht erfasst`; `Erfassen scheitert still` (Tabelle per `DROP TABLE` entfernt → Seite 200); `Geräte-Cookie gesetzt und wiederverwendet`; `500 erfasst Fehler mit Request-ID und Stack, Fehlerseite zeigt 8-stellige ID ohne Stack`; `404 erzeugt keinen Fehler-Eintrag`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Seitenaufrufe und Fehler erfassen`.

### Task 3: Anmeldungen und Mail bei neuem Gerät

**Files:**
- Modify: `src/routes/auth.js` (Callback), `src/services/nutzung.js`
- Test: `test/integration/auth.test.js` (bestehend, `setupMockChurchTools`), `test/unit/nutzung.test.js`

**Interfaces:**
- `erfasseAnmeldung(db, { req, res, personId: string|null, erfolg: boolean, grund?: string }) → { neuesGeraet: boolean, ersteAnmeldung: boolean }` (wirft nie).
- Erfolgreicher Login: Gerät für diese Person unbekannt **und** die Person hatte schon mindestens eine erfolgreiche Anmeldung → `neues_geraet = 1` und Mail `neues-geraet` an die Person (`personen.email`). Fehlgeschlagener Callback (State ungültig, Token-Tausch scheitert) → Eintrag mit `erfolg 0`, `grund`, ohne Person.
- Mail-Text enthält den Satz "Wenn du deine Browserdaten gelöscht oder ein privates Fenster benutzt hast, kann auch das der Grund sein." und den Kontakt aus `betrieb_kontakt_email` bzw. "die Portal-Administration".

- [ ] **Step 1: Failing tests:** `erste Anmeldung ohne Mail`; `zweite Anmeldung vom selben Gerät ohne Mail`; `Anmeldung ohne Cookie → neues Gerät, Mail mit Hinweis`; `fehlgeschlagener Callback wird erfasst`; `Mail-Fehler bricht Login nicht ab`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Anmeldungen und Warnung bei neuem Gerät`.

### Task 4: Fehler melden

**Files:**
- Create: `src/routes/fehlerMelden.js`, `views/fehler-melden.ejs`
- Modify: `src/app.js` (Mount `/fehler-melden` hinter `requireLogin()`), `views/_seitenleiste.ejs` bzw. `src/services/navigation.js` (Link "Problem melden" für alle Angemeldeten)
- Test: `test/integration/fehlerMelden.test.js`, `csrfSweep`

**Interfaces:**
- `GET /fehler-melden?fehler=<id>` Formular (Beschreibung optional, max. 2000), `POST /fehler-melden` (CSRF) → speichert `betrieb_fehlermeldungen` mit `seite` (Referer-Pfad ohne Query), `user_agent`, `request_id` (nur wenn ein `betrieb_fehler` mit diesem Präfix existiert **und** `person_id` gleich der meldenden Person oder leer ist), Mail `fehlermeldung` an alle aktiven Personen mit `personHasPermission(…, 'betrieb_einsehen')`, Link `${config.publicBaseUrl}/admin/betrieb/meldungen/<id>`; danach Dankesseite.

- [ ] **Step 1: Failing tests:** `Meldung mit eigener Fehler-ID verknüpft`; `fremde oder unbekannte Fehler-ID → gespeichert, nicht verknüpft`; `Beschreibung > 2000 → 400`; `Mail an Berechtigte`; `ohne Login → Weiterleitung zum Login`; Sweeps.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Fehler melden`.

### Task 5: Banner und Datenschutz

**Files:**
- Create: `src/services/banner.js`, `src/routes/banner.js` (Ausblenden), `src/routes/datenschutz.js`, `views/datenschutz.ejs`, `views/_banner.ejs`
- Modify: `views/_seite_anfang.ejs` (Banner nur wenn `currentPerson`), `src/middleware/nav.js` (aktive Banner in `res.locals`), `src/db/betriebSchema.js` (Seed Datenschutz-Banner beim ersten Start: Art `info`, `von` = jetzt, `bis` = jetzt + 60 Tage, Text "Neu: Das Portal speichert Nutzungsdaten zur Wartung, Weiterentwicklung und Sicherheit. Details unter Datenschutz.", Link `/datenschutz`), Seitenleiste (Link "Datenschutz")
- Test: `test/unit/banner.test.js`, `test/integration/banner.test.js`, `layoutSweep`

**Interfaces:**
- `aktiveBanner(db, personId, jetzt = new Date()) → Array<{ id, art, text, link, wegklickbar }>`.
- `pruefeBannerEingabe({ art, text, link, von, bis }) → string[]` (Fehler; Link nur `https://` oder `/` ohne `//`).
- `POST /banner/:id/ausblenden` (CSRF, nur `info`) → Redirect auf Referer-Pfad.
- `GET /datenschutz` (angemeldet): Text aus `datenschutz_text`; Default-Text nennt: welche Daten (Seitenaufrufe, Anmeldungen mit IP und Gerät, Fehler), Zweck (Wartung, Weiterentwicklung, Sicherheit), Aufbewahrung (90 Tage / 1 Jahr), Zugriff (Personen mit dem Recht "Betrieb & Nutzung"), Kontakt.

- [ ] **Step 1: Failing tests:** `Zeitraum und aktiv steuern Sichtbarkeit`; `Info wegklickbar, Wartung nicht (POST → 400)`; `Reihenfolge`; `Text escaped, javascript:-Link abgelehnt`; `nicht auf Login-Seite`; `Datenschutz-Banner einmalig geseedet`; `Datenschutzseite zeigt Text`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Banner und Datenschutzhinweis`.

### Task 6: Admin "Betrieb & Nutzung"

**Files:**
- Create: `src/routes/admin/betrieb.js`, `src/services/nutzungAuswertung.js`, `views/admin/betrieb-uebersicht.ejs`, `views/admin/betrieb-person.ejs`, `views/admin/betrieb-fehler.ejs`, `views/admin/betrieb-meldungen.ejs`, `views/admin/betrieb-banner.ejs`, `views/admin/betrieb-datenschutz.ejs`
- Modify: `src/app.js` (Mount `/admin/betrieb` hinter `requirePermission(db, config, 'betrieb_einsehen')`), `src/services/navigation.js` (Admin → Betrieb "Betrieb & Nutzung", Flag `betrieb`)
- Test: `test/unit/nutzungAuswertung.test.js`, `test/integration/admin/betrieb.test.js`, `csrfSweep`

**Interfaces:**
- `nutzungAuswertung.js`: `uebersicht(db, { von, bis, personId? }) → { aktivePersonen, seitenaufrufe, geraeteTypen: Array<{ wert, anzahl }>, browser, betriebssysteme, topSeiten: Array<{ pfadMuster, anzahl, medianMs }>, langsameSeiten (Top 10 nach p90 dauer_ms, min. 20 Aufrufe), fehlerProTag }`, `personDetail(db, personId) → { anmeldungen (letzte 50), geraete, letzteAufrufe (letzte 100), fehler, meldungen }`.
- Routen: `GET /admin/betrieb` (Übersicht, Zeitraum `7`/`30`/`90` Tage, Default 30, Personenfilter), `GET /admin/betrieb/personen/:id`, `GET /admin/betrieb/fehler` (+ `/:requestId` mit Stack), `GET /admin/betrieb/meldungen` (+ `/:id`, `POST` Status/Notiz), `GET/POST /admin/betrieb/banner` (Liste, Anlegen, Bearbeiten, Deaktivieren), `GET/POST /admin/betrieb/datenschutz` (Text, `betrieb_kontakt_email`).

- [ ] **Step 1: Failing tests:** Zugang (`betrieb_einsehen` 200, Manager ohne Einzelrecht 403, Superadmin 200); `Übersicht aggregiert korrekt`; `Personendetail`; `Fehlerdetail zeigt Stack nur hier`; `Meldungsstatus ändern, Audit-Eintrag`; `Banner anlegen/validieren/deaktivieren`; `Datenschutztext speichern`; Sweeps.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Verwaltung Betrieb & Nutzung`.

### Task 7: Bereinigung nach Frist

**Files:**
- Create: `src/services/nutzungBereinigung.js`
- Modify: `src/services/scheduler.js` (`runNutzungsdatenBereinigungJob`, `scheduleDaily` mit `cron_nutzungsdaten_bereinigung_stunde`/`_minute`, Default 03:45)
- Test: `test/unit/nutzungBereinigung.test.js`, `test/unit/scheduler.test.js`

**Interfaces:**
- `runNutzungsdatenBereinigungJob(db, config, mailer, { jetzt?: Date }) → { status, geloescht: { seitenaufrufe, anmeldungen, fehler, meldungen, geraete, bannerAusgeblendet } }` via `auditedJob('nutzungsdaten-bereinigung', …)`; Fristen aus Global Constraints; `banner_ausgeblendet` für Banner, deren `bis` > 365 Tage vorbei ist.

- [ ] **Step 1: Failing tests:** `löscht genau nach Frist (89/91 Tage, 364/366 Tage)`; `Job registriert 03:45`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(betrieb): Nutzungsdaten nach Frist löschen`.

### Task 8: Dokumentation

**Files:**
- Create: `docs/betrieb-und-nutzung.md` (Was erfasst wird und was nicht, Fristen, Recht, Neues-Gerät-Mail, Fehler melden, Banner, Datenschutz-Hinweis, Bezug revDSG)
- Modify: `docs/README.md`, `README.md` (Jobliste und Anzahl), `docs/auth-und-rechte.md`, `docs/admin-bereich.md`, `docs/datenmodell.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/architektur.md`

- [ ] **Step 1:** Doku schreiben; Routen, Schlüssel, Jobnamen per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Betrieb & Nutzung dokumentieren`.
