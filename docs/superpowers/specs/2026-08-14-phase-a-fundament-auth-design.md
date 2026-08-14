# Freigabeportal — Phase A: Fundament & Auth

Status: approved (Phase A only)
Datum: 2026-08-14

## Gesamtprojekt-Kontext

Dies ist Phase A eines mehrphasigen Projekts: ein Rechnungsfreigabe-Portal für eine
Schweizer Kirchgemeinde. Rechnungen kommen automatisiert über ein bestehendes,
internes n8n herein, werden im Portal kontiert, durch zwei unabhängige Personen
visiert, fälschungssicher gestempelt und danach von n8n abgeholt, archiviert
(Paperless-ngx) und an den Treuhänder (Bexio) weitergeleitet.

Das Portal ist die **einzige öffentlich erreichbare Komponente** der Kette. n8n,
Paperless-ngx sind intern und dürfen nicht exponiert werden — n8n muss daher aktiv
beim Portal pollen (nie Push).

### Phasenplan

- **Phase A – Fundament & Auth** (dieses Dokument): Express/SQLite-Skeleton,
  ChurchTools-OAuth2-Login, Rollen-Ableitung aus Gruppen, Session-Handling,
  Personen-Sync (Webcron + JIT-Refresh), Mailer-Grundgerüst.
- **Phase B – Admin-Bereich**: Konten-CRUD (4 Rollen inkl. Hart-Validierung
  freigeber1 ≠ freigeber2), Zuweisungsregeln, Eskalationszeiten-UI (nutzt
  `admin_config` aus Phase A).
- **Phase C – n8n-Schnittstelle & Job-Datenmodell**: API-Key-Auth, Job-Erstellung
  per POST, Pool mit atomarem Beanspruchen, signierte Download-Links,
  zweiphasiges Polling/Abholen, aktive Löschung nach Abholung.
- **Phase D – Freigabe-Workflow-UI**: Kontierung+Freigabe1 aus einer Hand,
  Freigabe2-Split-View (PDF-Vorschau links, Panel rechts), PDF-Stempelung/
  Flattening, Thumbnail-Rendering, Ablehnung/Rückweg, Reminder-/Eskalations-Mails.
- **Phase E – Härtung & Deployment**: Rate-Limiting, Infomaniak-Deployment,
  finaler Security-Review-Pass.

Jede Phase durchläuft einen eigenen Design → Spec → Plan → Umsetzung-Zyklus,
aufbauend auf dem, was in vorherigen Phasen entstanden ist.

## Infomaniak-Hosting: recherchierte Rahmenbedingungen

Öffentlich dokumentiert (Stand 2026-08-14, siehe Quellen unten):

- Node.js-Apps laufen als **persistenter Prozess** (Start/Stop/Restart über ein
  Dashboard), kein Serverless-per-Request-Modell.
- Zusätzlich existiert ein **Task-Scheduler-Webcron**: ruft eine URL in
  konfigurierbaren Intervallen auf, Minimum 15 Minuten bei Shared Hosting.
- Native Module (node-gyp-Kompilierung) sind **nicht dokumentiert** — unklares
  Risiko. Deshalb: `node:sqlite` (in Node.js eingebaut, kein natives Kompilieren)
  statt `better-sqlite3`.
- Der Listen-Port kommt dynamisch über `process.env.PORT`.

**Offener Punkt, früh im Deployment zu verifizieren:** ob `node:sqlite` in der auf
Infomaniak verfügbaren Node-Version stabil nutzbar ist, und ob der Prozess über
längere Zeit ohne Neustart durchläuft. Deshalb ist der primäre Zeitsteuerungs-Pfad
in diesem Design der Webcron (robust gegen Neustarts, idempotente Endpunkte),
nicht in-process-Timer.

Quellen: infomaniak.com/en/hosting/nodejs-hosting,
infomaniak.com/en/support/faq/2537 (Node.js-Site erstellen),
infomaniak.com/en/support/faq/2535 (Node.js-Konfiguration),
infomaniak.com/en/support/faq/2161 (Task Scheduler).

## Architektur & Tech-Stack (Phase A)

- **Node.js/Express**, serverseitig gerendert mit **EJS**, minimales Vanilla-JS
  für Interaktivität. Kein Frontend-Build-Schritt — passt zu Infomaniaks
  Build/Start-Kommando-Modell und zur überschaubaren Nutzerzahl.
- **`node:sqlite`** als DB-Zugriff (kein natives Kompilieren nötig). Fallback
  dokumentiert, aber nicht implementiert: `better-sqlite3`, falls `node:sqlite`
  sich als zu instabil erweist.
- **Sessions**: `express-session` mit eigenem SQLite-Store (Tabelle `sessions`),
  damit Logins einen Prozess-Neustart überleben.
- **Zeitsteuerung**: primär Infomaniak Task-Scheduler-Webcron gegen geschützte
  interne Endpunkte (`/internal/cron/sync-personen`,
  `/internal/cron/check-eskalationen`), alle Endpunkte idempotent. In-process
  Fallback (`node-cron`) bleibt als dokumentierte Option, nicht Standard.
- **Mailversand**: eigener Nodemailer-SMTP-Client, komplett getrennt vom
  n8n/Bexio-Mailpfad. SMTP-Zugang ist zum Zeitpunkt dieses Designs noch nicht
  final — Konfiguration ausschliesslich über Env-Vars (`SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`), Mailer-Service ist so gebaut, dass ein
  späterer Anbieterwechsel keine Code-Änderung erfordert.
- **Drei getrennte Auth-Mechanismen**, ohne gemeinsamen Code-Pfad:
  1. ChurchTools OAuth2 (Menschen-Login)
  2. API-Key/Shared-Secret (n8n, kommt in Phase C, Middleware-Grundgerüst
     bereits in Phase A angelegt)
  3. ChurchTools-Login-Token eines technischen Service-Accounts (Personen-Sync)

### Ordnerstruktur

```
src/
  routes/
  services/        churchtools.js, sync.js, mailer.js
  db/               schema.sql, migrations/
  middleware/       auth.js, apiKey.js, roles.js
  config/           env-basierte Konfiguration
views/              EJS-Templates
```

## Datenmodell (Phase A)

Nur die für diese Phase nötigen Tabellen. Schema ist so angelegt, dass spätere
Fremdschlüssel aus Phase B/C (`konten.freigeber1_id` etc.) ohne Umbau auf
`personen.churchtools_person_id` verweisen können.

```sql
CREATE TABLE personen (
  churchtools_person_id TEXT PRIMARY KEY,
  vorname TEXT NOT NULL,
  nachname TEXT NOT NULL,
  email TEXT NOT NULL,
  aktiv INTEGER NOT NULL DEFAULT 1,       -- boolean
  gruppen TEXT NOT NULL DEFAULT '[]',     -- JSON-Array von ChurchTools-Gruppen-IDs
  ct_person_unresolved INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_login_at TEXT
);

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires TEXT NOT NULL
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gestartet_am TEXT NOT NULL,
  beendet_am TEXT,
  status TEXT NOT NULL,                   -- laufend | erfolg | fehler
  fehler_details TEXT,
  anzahl_upserted INTEGER,
  anzahl_deaktiviert INTEGER
);

CREATE TABLE admin_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`admin_config` ist bewusst ein generischer Key/Value-Store (statt fester Spalten),
damit Phase B (Eskalationszeiten-UI) und die in Abschnitt 10 der Anforderungen
offen gelassene, möglicherweise spätere personenbasierte
Vorgesetzten-Eskalation ohne Schema-Umbau andocken können.

Alle Zeitstempel werden als ISO-8601-UTC-Strings gespeichert, in der UI später
(Phase D) nach Europe/Zurich konvertiert dargestellt.

## Auth-Flow

**ChurchTools OAuth2 (Login, Authorization Code Flow):**

1. `GET /auth/login` → Redirect zum ChurchTools-Authorization-Endpoint (PKCE,
   sofern von ChurchTools unterstützt).
2. `GET /auth/callback` tauscht Code gegen Token, holt Profil + aktuelle
   Gruppenmitgliedschaften der eingeloggten Person.
3. **JIT-Refresh**: Upsert der Person in `personen` bei jedem Login (Name,
   E-Mail, `gruppen`, `last_synced_at`, `last_login_at`) — Sicherheitsnetz
   zwischen den nächtlichen Syncs.
4. Die Session speichert nur `churchtools_person_id`, keine Rollen. Rollen
   werden bei **jedem Request** aus `personen.gruppen` abgeleitet
   (`middleware/roles.js`: `requireRole('buchhaltung' | 'portal-admin')`) —
   Gruppenänderungen wirken sofort, nicht erst nach erneutem Login.
5. Gruppen-Matching ausschliesslich über die stabile ChurchTools-Gruppen-ID
   (`CT_GROUP_ID_BUCHHALTUNG`, `CT_GROUP_ID_ADMIN` als Env-Vars), nie über den
   Gruppennamen — Umbenennungen dürfen die Zuordnung nicht brechen.

**API-Key-Auth (Grundgerüst für n8n, volle Endpunkte folgen in Phase C):**
Middleware prüft `X-API-Key`-Header gegen Env-Secret (`N8N_API_KEY`).
Komplett getrennter Code-Pfad von der OAuth-Middleware — kein gemeinsamer
"isAuthenticated"-Zustand zwischen Mensch- und Maschinen-Auth.

## Personen-Sync

Getriggert vom Webcron-Endpoint `/internal/cron/sync-personen` (geschützt durch
eigenes Shared-Secret, `CRON_SECRET`), Datenzugriff über den technischen
ChurchTools-Service-Account-Token:

1. Schreibt `sync_log`-Eintrag mit Status `laufend` (dient als Lock — ein
   zweiter, parallel eintreffender Trigger wird abgewiesen, solange ein Lauf
   `laufend` ist und jünger als 10 Minuten ist; danach gilt der Lock als
   verwaist und ein neuer Lauf darf starten).
2. Fragt die konfigurierten ChurchTools-Gruppen ab.
3. Upsert neuer/geänderter Personen, transaktional pro Lauf (kein
   Teil-Upsert bei Abbruch).
4. Lokal aktive Personen, die in keiner relevanten Gruppe mehr auftauchen →
   `aktiv = 0` (niemals gelöscht — Audit-Trail alter Freigaben bleibt in
   späteren Phasen referenzierbar).
5. Falls eine referenzierte `churchtools_person_id` beim Abgleich nicht mehr
   auflösbar ist (ChurchTools-Personen-Zusammenführung) → `ct_person_unresolved
   = 1` gesetzt und in `sync_log.fehler_details` vermerkt; sichtbar später im
   Admin-Bereich (Phase B) als Warnung statt stillem Datenverlust.
6. Lauf schliesst mit Status `erfolg` oder `fehler` + Zahlen
   (`anzahl_upserted`, `anzahl_deaktiviert`) in `sync_log`.

## Fehlerbehandlung

- ChurchTools beim Login nicht erreichbar → deutschsprachige Fehlerseite, kein
  Absturz; eine bereits bestehende gültige Session bleibt nutzbar.
- Sync-Lauf schlägt fehl (Netzwerk/Auth) → `sync_log` vermerkt den Fehler,
  bestehende Personendaten bleiben unverändert.
- Webcron-Endpoints sind idempotent und vertragen Mehrfach-/Parallel-Trigger
  ohne doppelte Effekte (Lock über `sync_log`-Status, siehe oben).

## Tests (Phase A)

- **Unit**: Rollen-Ableitung aus `gruppen`, Sync-Merge-Logik
  (upsert/deaktivieren/unresolved), Mailer-Service gegen Test-SMTP/Mock.
- **Integration**: OAuth-Callback-Flow gegen gemockten ChurchTools-Server,
  API-Key-Middleware (gültig/ungültig/fehlend), Session-Persistenz über
  Prozess-Neustart (SQLite-Store).
- Kein E2E/Browser-Test in Phase A (noch keine nennenswerte UI) — folgt in
  Phase D für den Freigabe-Workflow.

## Nicht Teil von Phase A

Konten-Verwaltung, Zuweisungsregeln, Job-Datenmodell, n8n-Job-Endpunkte,
PDF-Verarbeitung, Freigabe-UI, Rate-Limiting, TLS-Deployment-Details — diese
folgen in den Phasen B–E gemäss obigem Phasenplan.
