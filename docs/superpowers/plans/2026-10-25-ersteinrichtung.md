# Geführte Ersteinrichtung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Assistent für Superadmins, der technische Grundlagen prüft, durch die Einrichtung im Portal führt, Tests (ChurchTools, Testmail, Jobs) auf Knopfdruck ausführt und den Fortschritt misst.

**Architecture:** Ein Service `ersteinrichtung.js` beschreibt die Schritte als Liste mit Messfunktion (`erledigt`), Pflicht-Flag und Ziel-Link; Tests in `einrichtungTests.js`; Seite `/admin/ersteinrichtung`; Dashboard-Hinweis; zusätzlicher Statusdienst `einrichtung`.

**Tech Stack:** Node.js, Express 4, EJS, node:sqlite, `node:test` + supertest, undici MockAgent (`test/helpers/mockChurchTools.js`).

**Spec:** `docs/superpowers/specs/2026-10-25-ersteinrichtung-design.md`

## Global Constraints

- Zugang nur Superadmin (`requireRole(config, 'superadmin')`); responsive (360/768/1280 px).
- Keine Geheimnisse anzeigen oder speichern; Umgebungsvariablen nur als `ok` / `fehlt` / `ungültig` / `Warnung` ohne Wert.
- Schritt-IDs exakt und Pflicht-Flag: `grundlagen` (Pflicht), `rollen` (Pflicht), `churchtools` (Pflicht), `mail` (Pflicht), `konten` (Pflicht), `zeitstempel` (Pflicht; erledigt auch bei bewusstem Verzicht), `sicherung` (Pflicht), `kontakt` (Pflicht), `branding` (optional), `kreditoren` (optional), `module` (optional), `mailvorlagen` (optional), `monitoring` (optional), `jobs` (optional).
- Messregeln: `grundlagen` = keine `fehlt`/`ungültig` in den technischen Prüfungen; `rollen` = mindestens ein aktiver Superadmin; `churchtools` = letzter `sync_log`-Eintrag `erfolg`; `mail` = mindestens eine `mail_log`-Zeile `typ = 'testmail'` mit Status `versendet`; `konten` = mindestens ein aktives Konto mit Freigeber 1 und Freigeber 2; `zeitstempel` = `zeitstempel_tsa_url` gesetzt **oder** `einrichtung_ohne_zeitstempel = '1'`; `sicherung` = letzter `cron_log` `datenbank-sicherung` mit `erfolg` jünger als 7 Tage; `kontakt` = `betrieb_kontakt_email` nicht leer; `branding` = `seiten_titel` gesetzt; `kreditoren` = mindestens ein Kreditor; `module`, `mailvorlagen` = von Hand markiert (`einrichtung_markiert_<id> = '1'`); `monitoring` = `monitoring_secret` gesetzt; `jobs` = jeder der Kernjobs (`sync-personen`, `pool-erinnerungen`, `mail-zustellung`) mindestens einmal gelaufen.
- Dashboard-Hinweis "Ersteinrichtung: X von Y Pflichtschritten erledigt" solange offen; "später" blendet ihn für 7 Tage aus (`einrichtung_spaeter_bis_<personId>` ISO).
- Statusdienst `einrichtung`: offene Pflichtschritte → `warnung` mit Anzahl; alle erledigt → `ok`.
- README-Go-Live-Checkliste bleibt unverändert; nur ein Hinweis auf den Assistenten (Nutzerentscheid).
- Neuer Mail-Typ `testmail` (immer sofort, feste Vorlage, nicht in Mail-Einstellungen editierbar).
- Jeder Task endet mit `npm test` grün (aktuell 2010 Tests).

## Review Focus

1. Frische Installation ohne Konto, ohne Sync, ohne Mail → Seite lädt, alle Pflichtschritte offen, keine Fehlerseite (Task 3 Test).
2. ChurchTools-Test bei falschem Token/Netzfehler → verständliche Meldung, kein Stacktrace, Token nie angezeigt (Task 2 Test).
3. Testmail ohne E-Mail-Adresse der Person → Meldung "Für dich ist keine E-Mail-Adresse hinterlegt" (Task 2 Test).
4. Speicherpfad im Anwendungsverzeichnis (z. B. `DB_PATH=./data/portal.db` im Repo) → Warnung beim Schritt `grundlagen` (Task 2 Test).
5. Ein Manager (nicht Superadmin) ruft die Seite oder einen Test-POST auf → 403 (Task 3 Test).

---

### Task 1: Schritte und Messung

**Files:**
- Create: `src/services/ersteinrichtung.js`
- Modify: `src/db/adminConfigRepo.js` (Defaults `einrichtung_ohne_zeitstempel: '0'`)
- Test: `test/unit/ersteinrichtung.test.js`

**Interfaces:**
- Produces: `SCHRITTE` (Array `{ id, titel, beschreibung, pflicht, link, manuell: boolean }` — Reihenfolge wie in Global Constraints), `einrichtungsStand(db, config, { jetzt, technik }) → { schritte: Array<{ id, titel, beschreibung, pflicht, link, erledigt: boolean, hinweis?: string }>, pflichtOffen: number, pflichtGesamt: number }` (`technik` = Ergebnis von `pruefeTechnik` aus Task 2, optional; ohne → `grundlagen` wird nicht bewertet und gilt als offen mit Hinweis "noch nicht geprüft").
- Produces: `markiereSchritt(db, id, wert: boolean)` (nur für `manuell: true`), `setzeOhneZeitstempel(db, wert)`.

- [ ] **Step 1: Failing tests:** je Schritt `erledigt` false → true mit minimalen Daten gemäss Messregeln; `sicherung` älter als 7 Tage → offen; `zeitstempel` per Verzicht erledigt; `markiereSchritt` lehnt nicht-manuelle IDs ab; Zählung `pflichtOffen/pflichtGesamt`; `frische Installation` alle Pflicht offen.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(einrichtung): Schritte und Messung`.

### Task 2: Technische Prüfungen und Tests

**Files:**
- Create: `src/services/einrichtungTests.js`
- Modify: `src/db/index.js` + `src/db/schema.sql` (mail_log-CHECK um `'testmail'`, Rebuild-Muster wie `migrateBetriebMailTypen`), `src/services/notify.js` (IMMER_SOFORT), `src/services/churchtools.js` (falls nötig `fetchGroup(config, token, groupId) → { id, name }`)
- Test: `test/unit/einrichtungTests.test.js`

**Interfaces:**
- Produces: `pruefeTechnik(config, { anwendungsVerzeichnis = process.cwd(), fs }) → Array<{ name, status: 'ok'|'warnung'|'fehlt'|'ungültig', hinweis }>` — prüft: `PUBLIC_BASE_URL` beginnt mit `https://` (sonst Warnung), Speicherpfade (`dbPath`, `jobsDir`, `brandingDir`, `backupDir`) beschreibbar (sonst `ungültig`) und nicht innerhalb `anwendungsVerzeichnis` (sonst Warnung "wird beim nächsten Deploy überschrieben"), optionale Variablen `BACKUP_API_KEY`, `CT_GROUP_ID_MANAGER`, TSA-Vertrauensanker (fehlend = `ok` mit Hinweis "optional"). Pflichtvariablen sind durch den Start bereits erzwungen → `ok`.
- Produces: `async testeChurchtools(config) → { ok: boolean, gruppen?: Array<{ rolle, id, name, mitglieder }>, meldung?: string }` (Gruppen Buchhaltung/Admin/Manager über den Sync-Token; nie Token in `meldung`).
- Produces: `async sendeTestmail(db, mailer, { person }) → { status, meldung }` (Typ `testmail`, Betreff "Testmail vom Freigabeportal", kurzer fester Text).
- Produces: `async loeseKernjobsAus(db, config, mailer, jobs) → Array<{ job, status }>` — ruft dieselben Job-Funktionen wie die "jetzt ausführen"-Routen in `src/routes/admin/geplanteJobs.js` auf (`sync-personen`, `pool-erinnerungen`, `mail-zustellung`), Ergebnis pro Job.

- [ ] **Step 1: Failing tests:** `pruefeTechnik` (http-URL → Warnung, Pfad im App-Verzeichnis → Warnung, nicht beschreibbar → ungültig, kein Wert im Ergebnis); `testeChurchtools` (Mock: ok mit Namen/Mitgliederzahl; 401 → `ok: false`, Meldung ohne Token; Netzfehler); `sendeTestmail` (protokolliert `testmail`, ohne E-Mail-Adresse → Meldung); `loeseKernjobsAus` (ruft die Jobs, liefert Status); Migration `testmail` (bestehende DB, Muster `test/unit/betriebSchema.test.js`).
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(einrichtung): technische Prüfungen und Tests`.

### Task 3: Seite, Dashboard-Hinweis, Statusdienst

**Files:**
- Create: `src/routes/admin/ersteinrichtung.js`, `views/admin/ersteinrichtung.ejs`
- Modify: `src/app.js` (Mount `/admin/ersteinrichtung` hinter `requireRole(config, 'superadmin')`; Dashboard-Daten), `views/admin/dashboard.ejs` (Hinweis + "später"), `src/services/navigation.js` (Admin → Einstellungen "Ersteinrichtung", nur Superadmin), `src/services/statusPruefungen.js` (Dienst `einrichtung`), Doku-Liste der Dienste und Tests mit `DIENSTE`
- Test: `test/integration/admin/ersteinrichtung.test.js`, `test/unit/statusPruefungen.test.js`, `csrfSweep`

**Interfaces:**
- Consumes: Task 1 + Task 2.
- Routen (POST mit CSRF): `GET /` (Schrittliste mit Status, Pflicht/optional, Erklärung, Link, Ergebnis der technischen Prüfung), `POST /technik` (Prüfung erneut), `POST /churchtools-test`, `POST /testmail`, `POST /jobs`, `POST /markieren` (`id`, `wert`), `POST /ohne-zeitstempel` (`wert`), `POST /spaeter` (setzt `einrichtung_spaeter_bis_<personId>` = jetzt + 7 Tage). Jede Aktion schreibt einen Audit-Eintrag (bestehender `admin_config`-Trigger bzw. expliziter Eintrag für Tests ohne Config-Änderung, Muster `schreibeAudit` in `src/services/sicherheitsalarme.js`).
- Statusdienst `einrichtung` in `pruefeAlleDienste` (11. Dienst); `/healthz`-JSON und Statusseite zeigen ihn.

- [ ] **Step 1: Failing tests:** Zugang (Superadmin 200, Manager 403, Person mit `betrieb_einsehen` 403); `frische Installation lädt`; jede Aktion (inkl. Fehlerfall CT-Test und Testmail ohne Adresse); `markieren` nur manuelle Schritte; Dashboard-Hinweis sichtbar/"später" blendet 7 Tage aus/nach Abschluss weg; Statusdienst `einrichtung` warnung → ok; keine Geheimnisse in der HTML-Antwort (Sync-Token, Client-Secret, SMTP-Passwort aus Test-Config dürfen nicht vorkommen); Sweeps.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(einrichtung): Assistent im Admin-Bereich`.

### Task 4: Dokumentation

**Files:**
- Create: `docs/ersteinrichtung.md`
- Modify: `README.md` (vor der Go-Live-Checkliste ein Satz "Hilfe: Admin → Ersteinrichtung prüft vieles davon automatisch" — Liste selbst unverändert), `docs/admin-bereich.md`, `docs/statusseite-und-monitoring.md` (11. Dienst `einrichtung`), `docs/README.md`

- [ ] **Step 1:** Doku schreiben; Routen, Schritt-IDs, Config-Schlüssel per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Ersteinrichtung dokumentieren`.
