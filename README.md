# Freigabeportal

Rechnungsfreigabe-Portal für eine Schweizer Kirchgemeinde: Zuweisung,
Kontierung (inkl. Gutschriften und Aufsplitten auf mehrere Konten) und
Vier-Augen-Freigabe von Rechnungen sowie eigene Spesen-Einreichungen durch
Mitarbeitende, mit ChurchTools-OAuth2-Login, Rollen-Ableitung aus Gruppen,
Personen-Sync und einer n8n-Schnittstelle für Eingang und Ablage.
Node.js/Express, SQLite, lauffähig auf Infomaniak Node.js-Webhosting.

## Dokumentation

Dieses README deckt Setup und Deployment ab. Die vollständige fachliche
und technische Dokumentation — Architektur, Datenmodell, der komplette
Rechnungs-Workflow, n8n-Schnittstelle, QR-Bill/Betrugserkennung,
RFC3161-Zeitstempel, Admin-Bereich, geplante Jobs und der
ChurchTools-Personen-Sync, jeweils mit Ablauf-/Sequenzdiagrammen — liegt
in [`docs/`](docs/README.md).

## Setup (lokal)

1. `npm install`
2. `cp .env.example .env` und Werte eintragen
3. `npm test` — gesamte Test-Suite; benoetigt das `openssl`-CLI fuer den lokalen Test-TSA
4. `npm run dev` — Entwicklungsserver mit Autoreload

## Deployment (Infomaniak Node.js-Hosting)

**Backup-Konfiguration:** Neue Sicherungen verlangen einen separat gesicherten
privaten Schluesselbund in `BACKUP_KEYRING_FILE`. Ohne ihn schlagen Sicherungen
fehl. n8n erhaelt jetzt `.fpbak` statt ZIP; Klartext-Altsicherungen sind nicht zum
Restore zugelassen. Vor Umstellung Wiederherstellungsprobe durchfuehren:
[Verschluesselte Backups](docs/backup-verschluesselung.md).

**TSA-Konfiguration:** Neue Zeitstempel verlangen ein geprueftes Root-CA-Buendel
und dessen SHA-256 in `TSA_TRUST_ANCHORS_FILE`/`TSA_TRUST_ANCHORS_SHA256`.
Zusaetzlich verlangt `TSA_CRL_FILE` aktuelle signierte Sperrlisten fuer alle
Aussteller der Kette. Ohne diese Nachweise bleiben TSA-pflichtige Exporte gesperrt. Installation und
verbleibende Pruefluecken: [TSA-Vertrauensanker](docs/tsa-vertrauensanker.md).

**Betrieb und Wiederherstellung:** Der aktualisierte Server verwendet eine exklusive
Datenspeichersperre; pro konfiguriertem DB_PATH ist ein Portal-Prozess erlaubt.
Offline-Restore und Rueckwechsel laufen ueber `npm run backup:restore` bzw.
`npm run backup:rollback`, niemals ueber die laufende Webanwendung.
Nach einem Restore bleibt DB_PATH unveraendert; der Server liest den aktiven
Datenstand aus `<DB_PATH>.active.json`. Ablauf, Abnahme und Umgang mit verwaisten
Sperren: [Offline-Wiederherstellung](docs/offline-restore.md).

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
- **Datenverzeichnisse** (`DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`,
  `BACKUP_DIR`, siehe unten): alle vier werden von der App beim ersten
  Zugriff automatisch
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
| `BACKUP_API_KEY` | Optionaler separater Schluessel fuer Backup-Downloads; ohne Wert ist die Backup-API gesperrt. Nicht den Job-Schluessel verwenden. |
| `DB_PATH`, `JOBS_DIR`, `BRANDING_DIR`, `BACKUP_DIR` | Pfade im persistenten Speicherbereich der Site wählen — liegt einer davon im bei jedem Deploy ersetzten Ausführungsverzeichnis, sind die Daten (bzw. sämtliche Backups) nach dem nächsten Deploy weg |
| `PUBLIC_BASE_URL` | die produktive Domain, `https://` |
| `CT_BASE_URL`, `CT_CLIENT_ID`, `CT_CLIENT_SECRET`, `CT_REDIRECT_URI`, `CT_GROUP_ID_BUCHHALTUNG`, `CT_GROUP_ID_ADMIN` | aus der bereits registrierten ChurchTools-OAuth2-Anwendung |
| `CT_GROUP_ID_MANAGER` (optional) | ChurchTools-Gruppe für die Manager-Rolle — Zugriff auf die meisten, aber nicht alle Admin-Bereiche; ohne diese Variable existiert die Rolle schlicht nicht |
| `CT_SYNC_SERVICE_TOKEN` | Login-Token des technischen Service-Accounts für den nächtlichen Sync |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | aus den bereits vorhandenen Produktions-SMTP-Zugangsdaten |

### Vor dem ersten Login — Superadmin-Bootstrap

Der `/admin`-Bereich ist standardmässig über ChurchTools-Gruppenmitgliedschaft
zugänglich (`CT_GROUP_ID_ADMIN` für Superadmin, optional `CT_GROUP_ID_MANAGER`
für die eingeschränktere Manager-Rolle); ein Superadmin kann zusätzlich
einzelnen Personen über `/admin/personen` gezielte Einzelrechte geben,
unabhängig von ihrer ChurchTools-Gruppenmitgliedschaft. **Bevor die erste
Person sich einloggt**, muss diese Person in ChurchTools bereits Mitglied der
Superadmin-Gruppe sein — sonst kann sich zwar jeder einloggen (Login ist seit
Batch 4 nicht mehr gruppengebunden), aber niemand erreicht `/admin`, um z. B.
das erste Konto anzulegen oder später Einzelrechte zuzuweisen.

### Zeitgesteuerte Jobs — laufen im Node-Prozess selbst

Kein externer Task Scheduler nötig: Solange der Node-Prozess läuft (Infomaniaks
Node.js-Hosting hält ihn dauerhaft am Laufen), plant sich die App elf
Hintergrund-Jobs selbst ein (`src/services/scheduler.js`, gestartet in `src/index.js`):

| Job | Zeitplan | Zweck |
|---|---|---|
| `sync-personen` | täglich, Default 02:00 (Europe/Zürich) | ChurchTools-Personen-/Gruppen-Sync |
| `pool-erinnerungen` | Intervall, Default alle 60 Min. | Reminder-/Eskalations-Mails für unbeanspruchte Pool-Rechnungen (Schwellen in Stunden, admin-konfigurierbar, Default 24h/48h — separat unter Eskalationszeiten) |
| `freigabe2-erinnerungen` | Intervall, Default alle 60 Min. | Reminder an den effektiven Freigeber 2 und Übergabe an die Admin-Gruppe für seit langem unbeantwortete `freigabe2`-Jobs |
| `pdf-bereinigung` | täglich, Default 02:30 (Europe/Zürich) | Archivierung abgeholter Jobs, Aufräumen alter `.tmp`-Stempeldateien, Mail-Log-Retention, Quarantäne verwaister finaler Dateien |
| `zeitstempel-nachholen` | Intervall, Default alle 5 Min. | wiederholt fehlgeschlagene RFC3161-Zeitstempel-Versuche (nur solange die PDF noch lokal vorliegt) |
| `split-gruppen-nachholen` | Intervall, Default alle 15 Min. | holt die Zusammenführung einer vollständig freigegebenen Splitgruppe nach, wenn sie noch aussteht oder am Zeitstempel gescheitert ist |
| `kk-beleg-erinnerungen` | täglich, Default 08:00 (Europe/Zürich) | Erinnerungen zu offenen Kreditkartenbelegen und nicht abgeglichenen Abrechnungen |
| `mail-zustellung` | Intervall, Default alle 5 Min. | wiederholt eingereihte, noch nicht zugestellte Mails und gescheiterte Digests mit wachsendem Abstand (nach SMTP-Ausfall oder Neustart) |
| `datenbank-sicherung` | täglich, Default 03:00 (Europe/Zürich) | DB + `JOBS_DIR` + `BRANDING_DIR` als authentifiziert verschlüsselte `.fpbak` sichern (Schlüsselbund `BACKUP_KEYRING_FILE` Pflicht, sonst scheitert der Lauf); Retention nur für `.fpbak`, alte ZIPs bleiben erhalten |
| `mail-digest` | täglich, Default 07:00 (Europe/Zürich) | fasst wegen aktivem Batching eingereihte Mails pro Empfänger zu einer täglichen Zusammenfassung zusammen |
| `sicherheitsalarme` | Intervall, Default alle 30 Min. | Alarm-Mails zu ungeklärten Backup-Löschabsichten |

**Admin → Geplante Jobs** (`/admin/geplante-jobs`): Zeitplan von acht Jobs
einstellen (wirkt ab dem nächsten planmässigen Lauf, kein Neustart nötig),
jeden davon manuell sofort auslösen, und den Verlauf der letzten Läufe
(Erfolg/Fehler samt Details) einsehen — sowohl geplante als auch manuell
ausgelöste Läufe landen im selben Verlauf. `datenbank-sicherung` wird unter
**Admin → Datenbank-Backup**, `mail-digest` unter **Admin →
Mail-Einstellungen** eingestellt; `sicherheitsalarme` nur über `admin_config`.
Details zu allen elf Jobs:
[docs/geplante-jobs-und-benachrichtigungen.md](docs/geplante-jobs-und-benachrichtigungen.md).

**Verpasste Termine werden nicht nachgeholt:** Nach einem Neustart plant der
Scheduler tägliche Jobs nur für den nächsten zukünftigen Termin. Nach jedem
Ausfall prüfen, ob Sicherung, Sync oder Bereinigung fehlen, und sie manuell
auslösen; das Alter der neuesten Sicherung zusätzlich extern überwachen.
Eingereihte Mails gehen dagegen nicht verloren (`mail-zustellung`). Nach
SIGKILL/Stromausfall bleibt die Prozesssperre `<DB_PATH>.process-lock`
bestehen und der Server startet erst nach geprüfter manueller Entfernung —
siehe [Offline-Wiederherstellung](docs/offline-restore.md#abbruch-und-sperren).

**Mailzustellung:** Mails werden vor dem Versand in `mail_log` eingereiht
(`eingereiht` → `versendet`, nach ausgeschöpften Wiederholungen
`fehlgeschlagen`). SMTP-Fehler machen Erinnerungsläufe im Verlauf als
`fehler` sichtbar. Restrisiko: Absturz zwischen SMTP-Annahme und Speichern
kann zu einer doppelt zugestellten Mail führen.

Die zugehörigen `POST /internal/cron/*`-Routen (Header `X-Cron-Secret:
<CRON_SECRET>`) existieren weiterhin — nützlich für die Go-Live-Checkliste
unten oder falls doch noch ein externer Scheduler eingerichtet wird.
`CRON_SECRET` bleibt daher Pflicht, auch ohne Infomaniak Task Scheduler.

### Domain & TLS

Domain im Site-Dashboard verbinden, SSL-Zertifikat dort aktivieren — TLS ist
laut Lastenheft zwingend für das Portal.

### Go-Live-Checkliste (nach dem ersten Deploy)

1. `GET /healthz` → `{ "status": "ok" }`.
2. Login-Roundtrip als der vorab in ChurchTools zur Superadmin-Gruppe
   hinzugefügten Person; `/admin` muss erreichbar sein.
3. Ein erstes Konto unter `/admin/konten` anlegen (Freigeber 1/2 samt
   Stellvertretern).
4. Die Cron-Routen (`sync-personen`, `pool-erinnerungen`,
   `freigabe2-erinnerungen`, `pdf-bereinigung`, `zeitstempel-nachholen`,
   `split-gruppen-nachholen`, `kk-beleg-erinnerungen`, `mail-zustellung`)
   einmal manuell auslösen (z. B. via
   `curl -X POST -H "X-Cron-Secret: <CRON_SECRET>" https://<domain>/internal/cron/sync-personen`)
   und den `200`/`erfolg`-Response prüfen, bevor man sich auf den
   automatischen Zeitplan verlässt. Unter **Admin → Datenbank-Backup** eine
   Sicherung auslösen und mit `npm run backup:verify` offline prüfen.
5. Eine Test-Mail-Zustellung prüfen: unter `/admin/mails` muss die Zeile
   `versendet` zeigen, nicht `eingereiht`/`fehlgeschlagen`.

## Weitere Dokumentation

Die vollständige fachliche/technische Dokumentation mit Diagrammen liegt
in [`docs/`](docs/README.md):

- [Architektur](docs/architektur.md) — Systemüberblick, Middleware-Pipeline, Router-Übersicht
- [Authentifizierung und Rechte](docs/auth-und-rechte.md) — OAuth2-Login, Rollen, Einzelrechte, Job-Autorisierung
- [Datenmodell](docs/datenmodell.md) — ER-Diagramm und Tabellenbeschreibung
- [Rechnungs-Workflow](docs/rechnungs-workflow.md) — Status-Modell, Kontierung, Gutschriften, Freigabe 1/2, Ablehnung, Aufsplitten, Splitgruppen-Export, Löschung
- [Spesen-Einreichung](docs/spesen-einreichung.md) — Auslagen-Erstattung durch die Person selbst, eigene Freigabe-1-Seite
- [Kreditkarten-Belege](docs/kreditkarten-belege.md) — Vorab-Erfassung von Kreditkartenbelegen, Abgleich gegen die Monatsabrechnung
- [n8n-Schnittstelle](docs/n8n-schnittstelle.md) — API-Vertrag Eingang/Abholung
- [QR-Bill und Betrugserkennung](docs/qr-bill-und-betrugserkennung.md)
- [Zeitstempel und Prüfbescheinigung](docs/zeitstempel-und-pruefbescheinigung.md)
- [Admin-Bereich](docs/admin-bereich.md) — alle Admin-Seiten mit Rechte-Matrix
- [Geplante Jobs und Benachrichtigungen](docs/geplante-jobs-und-benachrichtigungen.md)
- [ChurchTools-Personen-Sync](docs/personen-sync.md)

Phasenpläne und historische Design-Dokumente der einzelnen Ausbaustufen
liegen in `docs/superpowers/specs/`. Der Gesamt-Phasenplan (A:
Fundament/Auth, B: Admin-Bereich, C: n8n-Schnittstelle, D:
Freigabe-Workflow-UI, E: Härtung & Deployment) ist in
`docs/superpowers/specs/2026-08-14-phase-a-fundament-auth-design.md`
dokumentiert.
