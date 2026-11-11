# Code-Landkarte und Konventionen

Einstieg für alle, die den Code übernehmen oder erweitern: Wo liegt was, wie ist
der Code kommentiert, und welche Stellen muss man bei typischen Änderungen
anfassen. Fachlicher Hintergrund steht in den übrigen Dokumenten
([Index](README.md)); diese Seite ist die Brücke zwischen Doku und Code.

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `src/index.js` | Start: Konfiguration laden, Datenspeicher sperren, Datenbank öffnen, App bauen, Scheduler starten ([architektur.md](architektur.md#bootstrap-srcindexjs)) |
| `src/app.js` | Zusammenbau der Express-App: Sicherheits-Header, Session, CSRF, Rechte-Guards und **alle Router-Mounts**. Die Reihenfolge der `app.use`-Aufrufe ist Teil der Sicherheit |
| `src/config/env.js` | Einzige Stelle, die Umgebungsvariablen liest und prüft |
| `src/middleware/` | Wiederverwendbare Express-Middleware: Rollen (`roles.js`), Rechte (`permissions.js`), Navigation (`nav.js`), CSRF, Rate-Limits, Wartungsmodus, Testmodus-Weiche, Nutzungserfassung |
| `src/routes/` | Eine Datei je Seite oder Schnittstelle (`createXxxRouter`); `routes/admin/` für `/admin/*`, `routes/n8n/` für die Maschinenschnittstelle |
| `src/services/` | Fachlogik ohne HTTP: Workflow-Helfer, Mail, PDF, Zeitstempel, Backup, Audit, Hintergrund-Jobs. `services/testmodus/` baut die Spielwiese |
| `src/db/` | Datenbank: `schema.sql` (frische DB), Migrationen (`index.js`, `*Schema.js`) und je Tabelle ein `*Repo.js` mit den SQL-Zugriffen |
| `src/cli/` | Betreiberwerkzeuge (Backup-Wiederherstellung, Audit-Export, TSA-Sperrlisten) |
| `src/utils/` | Kleine Hilfen ohne Abhängigkeiten |
| `views/` | EJS-Seiten; Gerüst in `_seite_anfang.ejs`, `_seitenleiste.ejs`, `_seite_ende.ejs` |
| `public/` | Statische Dateien (CSS, JS, Bootstrap, Symbole) |
| `scripts/` | Hilfsskripte (`baueSymbole.js`, Prüfskript `pruefung/`) |
| `test/` | `unit/`, `integration/`, `sicherheit/` (laufen bei `npm test`), `verhalten/` und `responsive/` (Browser, nicht Teil von `npm test`) |
| `docs/` | Diese Dokumentation; `docs/superpowers/` enthält Entwürfe und Pläne der Ausbaustufen (historisch) |

Schichten: **Route → Service → Repo**. Routen prüfen Eingaben und Rechte,
rufen Services auf und rendern Views; Services enthalten die Regeln; Repos
enthalten SQL. Datenbankzugriff in Routen ist die Ausnahme (einfache Listen).

## Konventionen

- **Sprache:** Deutsch (Kommentare, Namen der Fachbegriffe, Meldungen für
  Benutzer:innen). Technische Begriffe bleiben englisch (`router`, `middleware`).
  Schweizer Schreibweise: „ss“ statt „ß“.
- **Module:** reines ESM (`import`/`export`), keine Build-Stufe. Router- und
  Service-Fabriken erhalten ihre Abhängigkeiten als Objekt
  (`{ db, config, mailer, csrfProtection }`), kein globaler Zustand.
- **Datenbank:** `node:sqlite` (synchron). Mehrere Schreibzugriffe gehören in
  `BEGIN … COMMIT`. Datei-, Netzwerk- und TSA-Arbeit läuft immer **vor** der
  Transaktion, nie darin (synchrone Transaktionen können kein `await` offen halten).
- **Rückgaben:** Zustandsübergänge im Repo liefern `true`/`false` bzw. `null`,
  wenn die `WHERE`-Bedingung auf den Status keine Zeile traf — so verliert ein
  gleichzeitiger Zugriff ehrlich, statt zu überschreiben.
- **Async-Handler** in Routen werden mit `asyncHandler` (`middleware/asyncHandler.js`)
  registriert; `test/sicherheit/asyncHandlerSweep.test.js` erzwingt das.
- **CSRF:** jede schreibende Route nutzt `csrfProtection` (bei Uploads nach
  `multer`); `test/integration/csrfSweep.test.js` erzwingt die Abdeckung.
- **Ausgabe in Views:** nur das escapende `<%= %>`; Inline-`<script>`/`<style>`
  brauchen das CSP-Nonce (`test/integration/cspSweep.test.js`).
- **Audit:** Änderungen wichtiger Tabellen protokollieren Datenbank-Trigger
  automatisch (`db/securitySchema.js`); den Akteur liefert `services/auditContext.js`.

## Kommentar-Konventionen

- **Dateikopf:** jede Datei beginnt mit einem Kommentar zu Zweck und
  Zusammenspiel (bei Routen: URL, nötige Rolle bzw. nötiges Recht, passende Doku).
- **Funktionen:** exportierte Funktionen haben einen kurzen Kommentar; bei
  nicht offensichtlichen Parametern oder Rückgaben als JSDoc (`@param`, `@returns`).
  Typen werden nur dokumentiert, nicht geprüft (kein TypeScript).
- **Routen:** über jedem `router.get/post` steht `METHODE /pfad – Wirkung`.
- **Warum, nicht was:** Kommentare erklären Gründe, Randfälle und Sicherheits­
  überlegungen (z. B. warum etwas vor der Transaktion läuft). Was der Code tut,
  steht im Code.
- **Verweise:** Kommentare nennen die zuständige Doku (`docs/…`), Tests oder die
  Gegenstelle (`siehe services/…`), damit man sich entlangarbeiten kann.
- **Kennungen wie `SYNC-8`, `A4-02`, `AUTH-WIDEN-1`** stammen aus früheren
  Prüfberichten und Design-Entscheidungen (siehe `docs/audit-*.md`,
  `docs/superpowers/specs/`); sie bleiben als Suchbegriff erhalten.

## Typische Änderungen: Was ist anzufassen?

**Neue Seite / neuer Router**
1. `src/routes/…` anlegen (`createXxxRouter({ db, config, … })`).
2. In `src/app.js` mit dem passenden Guard einhängen (`requireLogin`, `requireRole`, `requirePermission`) und mit Rate-Limiter.
3. Schreibende Routen mit `csrfProtection`, Async-Handler mit `asyncHandler`.
4. Menüeintrag in `src/services/navigation.js` (Admin-Seite: zusätzlich Flag in `src/middleware/nav.js`), Symbol in `SYMBOLE` und `node scripts/baueSymbole.js`.
5. View unter `views/`, Eintrag in `test/responsive/seiten.js`.
6. Doku: [admin-bereich.md](admin-bereich.md) bzw. [architektur.md](architektur.md).

**Neues Admin-Recht**
`src/services/berechtigungKatalog.js` (Liste, Label, Bereich, Startwert) → Guard in `app.js` → Menü-Flag in `middleware/nav.js` und `services/navigation.js`. Der CHECK von `person_berechtigungen` wird in `db/securitySchema.js` aus der Liste neu aufgebaut. Doku: [auth-und-rechte.md](auth-und-rechte.md).

**Neue Spalte oder Tabelle**
In `src/db/schema.sql` **und** als idempotente Migration (Spalte: Eintrag in der passenden `*_TABLE_MIGRATIONS`-Liste in `db/index.js`; neue Tabelle: eigene `migrate…`-Funktion bzw. `*Schema.js`, in `openDatabase()` einhängen — Reihenfolge beachten). Auditierte Tabelle: in `db/securitySchema.js` (`tables`) eintragen. Doku: [datenmodell.md](datenmodell.md).

**Neuer erlaubter Wert in einem CHECK** (Status, Rolle, Mailtyp, Cron-Jobname)
SQLite kann CHECKs nicht erweitern: neuer Tabellen-Neuaufbau über `erweitereCheckPerRebuild` in `db/index.js`, vor `migrateSecuritySchema`.

**Neuer Mailtyp**
`TYP_ZU_KEY_INFIX` in `services/mailTemplates.js`, Standardtexte in `db/adminConfigRepo.js`, CHECK von `mail_log.typ`, Ereignis in `services/benachrichtigungsEreignisse.js` (Admin-Seite), ggf. `IMMER_SOFORT_TYPEN` in `services/notify.js`.

**Neuer Hintergrund-Job**
Funktion (mit `auditedJob`) in `services/cronJobs.js` oder eigener Datei, Einhängen in `services/scheduler.js`, Zeitplan-Schlüssel in `db/adminConfigRepo.js`, CHECK von `cron_log.job`, ggf. manueller Aufruf in `routes/cron.js` / `routes/admin/geplanteJobs.js`. Doku: [geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md).

**Neue Einstellung (`admin_config`)**
Schlüssel mit Standardwert in `DEFAULTS` (`db/adminConfigRepo.js`), Oberfläche in der passenden Admin-Seite, Prüfung beim Speichern.

**Neue Umgebungsvariable**
Lesen und prüfen nur in `src/config/env.js`, Eintrag in `.env.example` und in der Tabelle des README.

## Wo steht welche Regel?

| Frage | Datei |
|---|---|
| Wer darf was (Rollen, Rechte)? | `middleware/roles.js`, `middleware/permissions.js`, `services/berechtigungKatalog.js` |
| Wer darf diesen Vorgang bearbeiten? | `services/kontierungZugriff.js`, `routes/freigabe2.js` (`loadAuthorized`), `services/jobAuthorization.js` |
| Status-Übergänge eines Vorgangs | `db/jobsRepo.js` (Kopfkommentar listet den Lebenslauf) |
| Was ist bei einer Rechnung auffällig? | `services/betrugspruefung.js`, `services/paymentApproval.js` |
| Was darf nach n8n/Paperless exportiert werden? | `services/exportSnapshot.js`, `services/archiveReceipt.js` |
| Zeitstempel (RFC 3161) | `services/zeitstempel.js`, `tsaTrust.js`, `tsaRevocation.js`, `tsaNachweis.js` |
| Mails: Vorlage, Einreihen, Zustellung | `services/notify.js`, `mailTemplates.js`, `mailZustellung.js`, `benachrichtigung.js` |
| Sicherung und Wiederherstellung | `services/backup.js`, `backupEnvelope.js`, `offlineRestore.js`, `storageState.js` |
| Audit | `db/securitySchema.js` (Trigger), `services/auditContext.js`, `zugriffsAudit.js`, `auditExport.js` |
