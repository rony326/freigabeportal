# Freigabeportal

Rechnungsfreigabe-Portal für eine Schweizer Kirchgemeinde: Zuweisung,
Kontierung und Vier-Augen-Freigabe von Rechnungen, mit ChurchTools-OAuth2-Login,
Rollen-Ableitung aus Gruppen, Personen-Sync und einer n8n-Schnittstelle für
Eingang und Ablage. Node.js/Express, SQLite, lauffähig auf Infomaniak
Node.js-Webhosting.

## Setup (lokal)

1. `npm install`
2. `cp .env.example .env` und Werte eintragen
3. `npm test` — gesamte Test-Suite
4. `npm run dev` — Entwicklungsserver mit Autoreload

## Deployment (Infomaniak Node.js-Hosting)

### Infomaniak Manager — Site-Konfiguration

- **Deployment-Methode**: Git (dieses Repository), nicht ZIP/SFTP.
- **Ausführungsordner**: Repository-Root (dort liegt `package.json`).
- **Build-Kommando**: `npm install` (kein separater Build-Schritt nötig).
- **Start-Kommando**: `npm start`.
- **Node.js-Version**: ≥22.13.0 — `node:sqlite` benötigt diese Version (kein
  `--experimental-sqlite`-Flag mehr nötig ab dieser Version). Beim ersten
  Deploy in der Ausführungskonsole verifizieren, dass die App tatsächlich
  mit dieser Version startet, nicht mit einer älteren Default-LTS.
- **Port**: wird von Infomaniak automatisch über die Umgebungsvariable
  `PORT` vorgegeben — die App liest das bereits korrekt
  (`config/env.js`), keine manuelle Portwahl nötig.
- **Datenverzeichnisse** (`DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`, siehe
  unten): alle drei werden von der App beim ersten Zugriff automatisch
  angelegt (`mkdirSync({ recursive: true })`) — kein manueller Schritt
  nötig, nur sicherstellen, dass der gewählte Pfad im persistenten
  (redeploy-sicheren) Speicherbereich der Site liegt, nicht im
  Ausführungsordner selbst, falls dieser bei jedem Deploy neu ausgerollt
  wird.

### Umgebungsvariablen

**Bevorzugter Weg**: über die Umgebungsvariablen-Konfiguration im
Infomaniak Manager (Site-Konfigurationsseite, dieselbe Stelle wie
Start-/Build-Kommando und Node-Version). Dort gesetzte Werte haben Vorrang
vor allem anderen.

**Fallback, falls diese UI auf dem gebuchten Plan nicht verfügbar ist**:
`npm start`/`npm run dev` laden automatisch eine `.env`-Datei im
Ausführungsordner, sofern vorhanden (`node --env-file-if-exists=.env`,
Node ≥22.9.0, kein zusätzliches Paket wie `dotenv` nötig). Bereits über die
Plattform gesetzte Variablen haben weiterhin Vorrang vor Werten aus der
Datei. `.env` ist in `.gitignore` — niemals committen. Die Datei muss im
selben Dateisystem liegen, das der laufende Prozess tatsächlich sieht — bei
manchen Infomaniak-Node.js-Plänen ist das **nicht** dasselbe Verzeichnis,
das über die allgemeine Hosting-SSH sichtbar ist (dort kann `~/sites/<domain>`
leer erscheinen, während die App aus einem eigenen, isolierten
Ausführungsbereich läuft) — im Zweifel die tatsächlich aktive `.env` über
die Ausführungskonsole/App-eigene SSH-Zugriffsmöglichkeit des Node.js-Sites
verifizieren, nicht über die generische Hosting-SSH.

Vollständige Liste inkl. Format-Anforderungen in `.env.example`. Alle
`*_SECRET`/`*_TOKEN`/`*_KEY`-Werte müssen mindestens 32 Zeichen lang sein
und dürfen nicht `changeme` enthalten — die App verweigert sonst den Start
(`config/env.js`). Neue Werte generieren mit `openssl rand -hex 32`.

| Variable | Quelle |
|---|---|
| `SESSION_SECRET`, `DOWNLOAD_SIGNING_SECRET`, `CRON_SECRET`, `N8N_API_KEY` | neu generieren (`openssl rand -hex 32`), nie wiederverwenden |
| `DB_PATH`, `JOBS_DIR`, `BRANDING_DIR` | Pfade im persistenten Speicherbereich der Site wählen |
| `PUBLIC_BASE_URL` | die produktive Domain, `https://` |
| `CT_BASE_URL`, `CT_CLIENT_ID`, `CT_CLIENT_SECRET`, `CT_REDIRECT_URI`, `CT_GROUP_ID_BUCHHALTUNG`, `CT_GROUP_ID_ADMIN` | aus der bereits registrierten ChurchTools-OAuth2-Anwendung |
| `CT_SYNC_SERVICE_TOKEN` | Login-Token des technischen Service-Accounts für den nächtlichen Sync |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | aus den bereits vorhandenen Produktions-SMTP-Zugangsdaten |

### Vor dem ersten Login — Portal-Admin-Bootstrap

Der `/admin`-Bereich ist ausschliesslich über ChurchTools-Gruppenmitgliedschaft
zugänglich (`CT_GROUP_ID_ADMIN`), es gibt keinen anderen Weg, Admin-Rechte zu
vergeben. **Bevor die erste Person sich einloggt**, muss diese Person in
ChurchTools bereits Mitglied der Portal-Admin-Gruppe sein — sonst kann sich
zwar jeder einloggen (Login ist seit Batch 4 nicht mehr gruppengebunden),
aber niemand erreicht `/admin`, um z. B. das erste Konto anzulegen.

### Task Scheduler (Manager → Website → Advanced Tools → Task Scheduler)

Drei Einträge, je ein `POST` mit Header `X-Cron-Secret: <CRON_SECRET>`:

| Route | Empfohlene Frequenz | Zweck |
|---|---|---|
| `/internal/cron/sync-personen` | täglich (nachts) | ChurchTools-Personen-/Gruppen-Sync |
| `/internal/cron/pool-erinnerungen` | stündlich | Reminder-/Eskalations-Mails für unbeanspruchte Pool-Rechnungen (Schwellen in Stunden, admin-konfigurierbar, Default 24h/48h — stündlich hält die Verzögerung gegenüber der Schwelle klein, ohne unnötig oft zu laufen) |
| `/internal/cron/pdf-bereinigung` | täglich | Archivierung abgeholter Jobs, Aufräumen alter `.tmp`-Stempeldateien, Mail-Log-Retention |

### Domain & TLS

Domain im Site-Dashboard verbinden, SSL-Zertifikat dort aktivieren — TLS ist
laut Lastenheft zwingend für das Portal.

### Go-Live-Checkliste (nach dem ersten Deploy)

1. `GET /healthz` → `{ "status": "ok" }`.
2. Login-Roundtrip als der vorab in ChurchTools zur Portal-Admin-Gruppe
   hinzugefügten Person; `/admin` muss erreichbar sein.
3. Ein erstes Konto unter `/admin/konten` anlegen (Freigeber 1/2 samt
   Stellvertretern).
4. Jede der drei Task-Scheduler-Routen einmal manuell auslösen (z. B. via
   `curl -X POST -H "X-Cron-Secret: <CRON_SECRET>" https://<domain>/internal/cron/sync-personen`)
   und den `200`/`erfolg`-Response prüfen, bevor man sich auf den
   automatischen Zeitplan verlässt.
5. Eine Test-Mail-Zustellung prüfen (z. B. über einen Pool-Reminder oder
   `/admin/mails` nach einem der obigen Cron-Läufe).

## Weitere Dokumentation

Phasenpläne und Design-Dokumente in `docs/superpowers/specs/`. Der
Gesamt-Phasenplan (A: Fundament/Auth, B: Admin-Bereich, C:
n8n-Schnittstelle, D: Freigabe-Workflow-UI, E: Härtung & Deployment) ist in
`docs/superpowers/specs/2026-08-14-phase-a-fundament-auth-design.md`
dokumentiert.
