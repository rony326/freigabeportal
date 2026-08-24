# Datenbank-Backup & Wiederherstellung — Design

## Kontext

Es gibt heute keinerlei Backup-/Restore-Mechanismus im Portal. Die
SQLite-Datenbank (`DB_PATH`, geöffnet über `node:sqlite` `DatabaseSync` in
`src/db/index.js`) sowie die beiden Datei-Verzeichnisse `JOBS_DIR`
(Rechnungs-PDFs, Thumbnails) und `BRANDING_DIR` (Logo) liegen ausschliesslich
auf dem Infomaniak-Dateisystem der Site. Ziel dieses Designs: eine
Backup-Funktion, mit der sich DB + beide Verzeichnisse sowohl manuell als
auch automatisch (geplant) sichern und bei Bedarf wiederherstellen lassen,
plus ein Weg, Backups extern (z. B. WebDAV/Cloud-Speicher) abzulegen.

Zwei technische Rahmenbedingungen bestimmen das Design:

- **`db` ist eine einmalige, in Closures eingebettete Verbindung.** Jeder
  Router bekommt `db` beim Start von `createApp()` übergeben (`src/app.js`)
  und hält die Referenz in seinem Closure. Es gibt keinen Mechanismus, diese
  Verbindung zur Laufzeit gegen eine neue Datei auszutauschen — ein Restore
  kann die Datei auf der Platte ersetzen, aber der laufende Prozess merkt
  davon nichts, bis er neu gestartet wird.
- **Kein automatischer Prozess-Neustart bei Exit/Crash bekannt.** Anders als
  bei vielen PaaS-Umgebungen ist für das Infomaniak Node.js-Hosting kein
  Supervisor bekannt, der den Prozess nach `process.exit()` automatisch neu
  hochfährt (README, Abschnitt „Deployment"). Ein `process.exit()` nach dem
  Restore wäre daher ein Risiko, die Site bis zum nächsten manuellen Eingriff
  offline zu nehmen. Restore ersetzt deshalb nur die Dateien und verlangt
  einen expliziten manuellen Neustart über den Infomaniak-Manager.

## Architektur & Komponenten

### Backup-Archiv-Service (`src/services/backup.js`)

Baut ein ZIP-Archiv mit drei Bestandteilen:

- **DB-Snapshot**: `db.prepare('VACUUM INTO ?').run(tmpPfad)` — SQLite-
  eigener, atomarer Online-Backup-Mechanismus (funktioniert bei laufendem
  Betrieb, kein Lock auf den Live-Verbindungen nötig), Ergebnis landet unter
  `db.sqlite` im Archiv.
- **`jobs/`**: rekursiver Inhalt von `config.jobsDir`.
- **`branding/`**: rekursiver Inhalt von `config.brandingDir`.
- **`manifest.json`**: `{ erstelltAm, formatVersion, dateiAnzahlJobs,
  dateiAnzahlBranding }` — dient beim Restore als erste Plausibilitätsprüfung
  (kein Ersatz für eine echte Schema-Prüfung, siehe Restore-Ablauf).

Neue Abhängigkeit: **`adm-zip`** (Node hat keine eingebaute ZIP-Unterstützung;
`adm-zip` deckt sowohl Erstellen als auch Auslesen desselben Formats
synchron ab, ausreichend für die Datenmengen dieser App). Wird in
`package.json` als reguläre `dependency` ergänzt.

### Lokale Ablage (`BACKUP_DIR`)

Neue Env-Var nach demselben Muster wie `JOBS_DIR`/`BRANDING_DIR` (Default
`./data/backups`, `mkdirSync({ recursive: true })` beim ersten Zugriff, siehe
`src/config/env.js` und `src/db/index.js`-Pendant). Jede Sicherung (manuell
oder automatisch) landet dort als `backup-<ISO-Zeitstempel>.zip`. Nach jedem
erfolgreichen Lauf werden alte Dateien über die konfigurierte Aufbewahrung
hinaus gelöscht (Default: die letzten 14 behalten) — analog zur bestehenden
PDF-Bereinigung (`runPdfBereinigungJob`).

### Geplanter Job „datenbank-sicherung"

Läuft wie die drei bestehenden Cron-Jobs über `services/scheduler.js`
(In-Prozess-Timer, siehe `src/index.js`) und wird in `services/cronJobs.js`
als `runDatenbankSicherungJob(db, config)` implementiert — dieselbe Funktion
wird sowohl vom Scheduler als auch vom manuellen „Jetzt sichern"-Button auf
`/admin/backup` aufgerufen, exakt das Muster von `pool-erinnerungen` und
`pdf-bereinigung` in `src/routes/admin/geplanteJobs.js`.

Protokollierung in `cron_log` unter dem neuen Job-Namen
`'datenbank-sicherung'`. `cron_log.job` hat eine `CHECK`-Constraint mit
fester Werteliste (`pool-erinnerungen`, `pdf-bereinigung`,
`zeitstempel-nachholen`) — SQLite kann `CHECK`-Constraints nicht per `ALTER
TABLE` erweitern, daher braucht es eine weitere Migration nach dem
etablierten Rebuild-Muster in `src/db/index.js`
(`migrateFreigabenTable`/`migrateMailLogTable`/`migrateCronLogTable`: Tabelle
umbenennen, mit erweitertem `CHECK` neu anlegen, Zeilen kopieren, alte
Tabelle droppen, alles in einer Transaktion). Da ein Backup-Lauf (Zippen
potenziell vieler PDFs) länger dauern kann als die bestehenden Jobs, nutzt
er das Zwei-Phasen-Logging (`startCronLauf`/`finishCronLauf` +
`hasRecentRunningCronLauf` als Overlap-Guard), nicht das Einzelschuss-
`logCronLauf` der einfacheren Jobs.

Neue `admin_config`-Schlüssel (Muster wie bestehende Cron-Konfiguration,
`seedDefaults` in `src/db/adminConfigRepo.js`):

- `backup_cron_stunde` (Default `'3'`)
- `backup_cron_minute` (Default `'0'`)
- `backup_aufbewahrung_anzahl` (Default `'14'`)

### Admin-Seite `/admin/backup` — **nur `superadmin`**

Eigenständige Seite (nicht in `/admin/geplante-jobs` integriert), damit
Personen mit nur dem Einzelrecht `geplante_jobs_verwalten` (nicht
zwingend Superadmin) keinen Zugriff auf Backup-Steuerung oder -Downloads
bekommen. Strukturell abgesichert wie `/admin/eskalation`,
`/admin/erscheinungsbild`, `/admin/zeitstempel`: `requireRole(config,
'superadmin')` direkt in `src/app.js`, kein vergebbares Einzelrecht in
`GRANTABLE_BERECHTIGUNGEN`. Grund für die verschärfte Einstufung: das
Archiv enthält `admin_config.zeitstempel_tsa_passwort` im Klartext — die
Seite ist damit sensitiver als jede der drei bereits gesperrten.

Inhalt:

- **Zeitplan/Aufbewahrung-Formular**: Stunde/Minute + Anzahl, gleiche
  Validierung wie in `geplanteJobs.js` (`ganzzahlImBereich`).
- **„Jetzt sichern"-Button**: `POST /admin/backup/jetzt-ausfuehren`, ruft
  `runDatenbankSicherungJob` direkt auf, redirect mit Erfolgsmeldung.
- **Liste lokaler Backups**: Dateiname, Grösse, Zeitpunkt (aus
  Dateisystem-Metadaten, `readdirSync(config.backupDir)` +
  `statSync`), pro Zeile ein Download-Link (`GET
  /admin/backup/dateien/:name`) und ein Löschen-Button (`POST
  /admin/backup/dateien/:name/loeschen`) — Dateiname wird gegen ein festes
  Muster (`backup-<ISO>.zip`) validiert, um Path-Traversal über den
  Routenparameter auszuschliessen.
- **Restore-Formular**: Datei-Upload (`multer`, bereits Abhängigkeit,
  gleiches Limit-Muster wie bestehende Upload-Routen) + Pflichtfeld, in das
  exakt das Wort `WIEDERHERSTELLEN` eingetippt werden muss, sonst 400 ohne
  jede Dateiverarbeitung.

### Restore-Ablauf (`POST /admin/backup/wiederherstellen`)

1. Bestätigungstext prüfen (exakt `WIEDERHERSTELLEN`) — bricht sofort ab,
   bevor irgendeine Datei angefasst wird.
2. Upload in ein temporäres Verzeichnis entpacken, validieren:
   - ZIP lässt sich öffnen und enthält `manifest.json`, `db.sqlite`.
   - `db.sqlite` lässt sich als eigenständige `DatabaseSync`-Instanz öffnen
     und enthält mindestens die Tabellen `jobs`, `personen`, `konten`
     (einfache Schema-Plausibilitätsprüfung, keine vollständige
     Migrationsprüfung).
   - Bricht einer dieser Schritte ab: 400 mit Fehlermeldung, **nichts
     Live wird angefasst**.
3. **Sicherheits-Snapshot**: aktuellen Stand (Live-DB via `VACUUM INTO` +
   `JOBS_DIR` + `BRANDING_DIR`) als eigenes Archiv nach `BACKUP_DIR`
   schreiben — macht einen Fehlgriff selbst wieder über dasselbe
   Restore-Formular rückgängig.
4. Live-Dateien ersetzen:
   - `DB_PATH`: die wiederhergestellte Datei nicht in-place über die Live-Datei
     schreiben (Risiko eines unvollständigen Schreibvorgangs, während der
     Prozess dieselbe Datei noch offen hält), sondern komplett in eine
     Temp-Datei im selben Verzeichnis schreiben und erst dann atomar per
     `renameSync` an `DB_PATH` verschieben.
   - `JOBS_DIR`/`BRANDING_DIR`: vollständiger Ersatz, nicht nur Überschreiben
     gleichnamiger Dateien — vorhandener Inhalt wird vorher gelöscht, damit
     keine verwaisten Dateien aus dem alten Stand liegen bleiben, die im
     wiederhergestellten Stand nicht mehr referenziert werden.
5. Eintrag in neuer Tabelle `backup_wiederherstellungen` (siehe
   Datenmodell) mit der auslösenden Person.
6. Ergebnisseite mit unübersehbarem Hinweis: *„Wiederherstellung auf
   Dateiebene abgeschlossen. Die Oberfläche zeigt bis zum manuellen
   Neustart (Infomaniak-Manager) weiterhin die alten Daten."*

Kein `process.exit()`, kein Versuch, die laufende `db`-Verbindung
auszutauschen — bewusste Konsequenz aus den beiden Rahmenbedingungen oben.

### n8n-Anbindung (`GET /api/n8n/backup/latest`)

Neue Route in einem neuen `src/routes/n8n/backup.js`, gemountet unter
`/api/n8n/backup` mit derselben `requireApiKey(config)`-Middleware wie
`/api/n8n/jobs` (`src/app.js:126`). Liefert die jeweils neueste Datei aus
`BACKUP_DIR` als Datei-Download aus (404 falls noch keine existiert). Kein
eigener Trigger-Mechanismus — n8n holt sich ab, was der interne Scheduler
ohnehin produziert (symmetrisch zum bestehenden Abholbereit-Muster in
`docs/n8n-schnittstelle.md`). Ein n8n-Workflow ausserhalb dieses Repos ist
dafür verantwortlich, die Datei extern abzulegen (WebDAV, Cloud-Speicher
etc.) — das ist bewusst **nicht** Teil dieses Designs (siehe „Nicht Teil von
diesem Design").

## Datenmodell

Neue Tabelle, analog zu `job_loeschungen` (eigene schlanke Audit-Tabelle
statt Zweckentfremdung von `cron_log`, weil hier — anders als bei den
geplanten Jobs — festgehalten werden muss, *welche Person* eine
Wiederherstellung ausgelöst hat):

```sql
CREATE TABLE IF NOT EXISTS backup_wiederherstellungen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dateiname TEXT NOT NULL,
  wiederhergestellt_von TEXT NOT NULL REFERENCES personen(churchtools_person_id),
  zeitpunkt TEXT NOT NULL
);
```

`cron_log.job`-`CHECK` wird um `'datenbank-sicherung'` erweitert (siehe
Migrationsmuster oben).

## Sicherheit

- `/admin/backup` (Ansicht, Download, Löschen, Restore) ausschliesslich
  `superadmin` — keine Einzelrecht-Option (siehe Berechtigungs-Diskussion
  oben).
- Warntext auf der Seite, dass jedes Archiv Geheimnisse im Klartext enthält
  (`zeitstempel_tsa_passwort`) und entsprechend sicher zu handhaben ist —
  gilt für lokale Downloads genauso wie für das über `/api/n8n/backup/latest`
  abgeholte Archiv.
- `/api/n8n/backup/latest` nutzt dieselbe API-Key-Absicherung wie die
  bestehende n8n-Schnittstelle, kein neues Auth-Konzept.
- Restore verlangt exakten Bestätigungstext, validiert das Archiv vollständig
  **vor** jeder Live-Änderung, und erzeugt automatisch einen
  Sicherheits-Snapshot des vorherigen Zustands.
- Downloadnamen/Löschen-Routen validieren den Dateinamen-Parameter gegen ein
  festes Muster (Path-Traversal-Schutz), analog zu bestehenden
  Datei-Routen im Projekt.

## Nicht Teil von diesem Design

- **Native WebDAV-Anbindung im Portal.** Bewusst nicht gebaut — würde ein
  weiteres Klartext-Secret in `admin_config` bedeuten (neben dem
  TSA-Passwort) sowie einen neuen, ungetesteten HTTP-Client. Stattdessen
  liefert `/api/n8n/backup/latest` das Archiv aus, ein n8n-Workflow
  übernimmt die externe Ablage über n8n-eigene Nodes/Credentials — konsistent
  mit der bestehenden Architektur, in der n8n bereits die Integrationsebene
  für alles Externe ist (siehe `docs/n8n-schnittstelle.md`).
- **Automatischer Prozess-Neustart nach Restore.** Siehe Rahmenbedingungen
  oben — die Zielumgebung bietet dafür keine bekannte, verlässliche
  Grundlage. Kann nachgezogen werden, falls sich das ändert.
- **Verschlüsselung des Archivs.** Zugriffsschutz läuft über
  Superadmin-Gate + API-Key, nicht über eine zusätzliche
  Archiv-Verschlüsselung mit eigener Schlüsselverwaltung.

## Testing

- **Roundtrip-Test** (höchster Wert angesichts des Risikoprofils): Backup
  aus einer Test-DB mit ein paar `jobs`-Zeilen + einer Fake-PDF in einem
  Test-`JOBS_DIR` + einem Fake-Logo in einem Test-`BRANDING_DIR` erstellen,
  in ein separates Zielverzeichnis „wiederherstellen", Inhalt auf Identität
  prüfen.
- Route-Tests (`supertest`, bestehendes Muster) für: Rechte-Gate (403 für
  Nicht-Superadmin, inkl. jemand mit `geplante_jobs_verwalten`ohne
  Superadmin), Download/Löschen mit Path-Traversal-Versuchen im
  Dateinamen-Parameter, Restore-Ablehnung bei fehlendem/falschem
  Bestätigungstext und bei kaputtem/fremdem ZIP (jeweils ohne dass Live-Dateien
  angefasst werden), `/api/n8n/backup/latest` mit/ohne gültigen API-Key und
  mit leerem `BACKUP_DIR` (404).
- Migrationstest für die `cron_log`-`CHECK`-Erweiterung, analog zu den
  bestehenden Tests für `migrateFreigabenTable`/`migrateMailLogTable`.
