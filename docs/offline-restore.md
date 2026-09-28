# Offline-Wiederherstellung

Stand: 2026-09-27. Implementiert und an temporaeren Datenstaenden getestet.
Keine produktive Wiederherstellung oder Betriebsabnahme wurde ausgefuehrt.
HTTP-Live-Restore und der alte direkte `restoreBackupArchive`-Aufruf bleiben gesperrt.

## Sicherheitsmodell

Die Wiederherstellung ersetzt weder die laufende Datenbankdatei noch die bisherigen
Belegverzeichnisse. Sie erstellt einen neuen Datenstand unter
`<DB_PATH>.generations/<UUID>/` mit Datenbank, Belegen und Branding. Dateipfade
werden auf diesen Stand umgesetzt, Sessions entfernt, Integritaet/Fremdschluessel
geprueft und Restore-Auditdaten geschrieben. Erst nach Schliessen und Synchronisieren
aller Dateien wird `<DB_PATH>.active.json` atomar auf den neuen Stand umgestellt.

`npm start` liest diesen Zeiger vor dem Oeffnen der Datenbank. Ein fehlender Zeiger
bedeutet den bisherigen konfigurierten Stand; ein beschaedigter Zeiger fuehrt zum
Startabbruch, nicht zum stillen Rueckfall. `DB_PATH` in der Umgebung bleibt deshalb
auch nach einer Wiederherstellung **unveraendert**. JOBS_DIR/BRANDING_DIR werden
ueber den Zeiger intern auf den aktiven Datenstand gesetzt; BACKUP_DIR bleibt unveraendert.

Der vorherige Datenstand bleibt erhalten. Automatisches Loeschen alter Generationen
ist bewusst nicht implementiert; Speicherplatz und geschuetzte Aufbewahrung einplanen.

## Voraussetzungen

- Alle Portal-Prozesse, Worker, externen Cron-Aufrufer und direkten DB-Schreiber stoppen.
  Automatischen Neustart des Prozessmanagers fuer das Wartungsfenster deaktivieren.
- Der Server muss ueber den aktualisierten Einstiegspunkt `src/index.js` gestartet werden.
  Dieser und das CLI verwenden dieselbe exklusive Sperre `<DB_PATH>.process-lock`.
  Alte Serverversionen und direkte SQLite-Zugriffe kennen diese Sperre nicht.
- Ein Portal-Prozess pro konfiguriertem Datenspeicher. Mehrere Instanzen/Hosts,
  Netzlaufwerke und parallele direkte DB-Schreiber sind nicht durch dieses Verfahren abgedeckt.
- Lokales POSIX-Dateisystem mit atomarem Rename und funktionierendem fsync.
  Die Basispfade fuer DB, Jobs, Branding und Backups muessen so getrennt sein,
  dass das Generationsverzeichnis nicht innerhalb von Jobs/Branding/Backups liegt.
  DB_PATH selbst darf kein symbolischer Link sein.
- Genuegend Platz fuer bisherigen Stand, neuen Stand und temporaere Validierung.
  Es gelten weiterhin die Grenzen aus [backup-sicherheit.md](backup-sicherheit.md).
- Vertraute Herkunft des Backups und separat gepruefter SHA-256-Wert.
  Ein selbst berechneter Hash beweist Konsistenz, nicht die Herkunft eines unbekannten ZIPs.

Die CLI benoetigt nur DB_PATH, JOBS_DIR, BRANDING_DIR und BACKUP_DIR, keine OAuth-
oder SMTP-Zugangsdaten. Die npm-Kommandos lesen dieselbe `.env` wie der Server;
Arbeitsverzeichnis und Umgebung muessen zur betreffenden Installation gehoeren.

## Ablauf

1. Sicherung zunaechst ohne Umschalten validieren:

```sh
npm run backup:verify -- --archive /geschuetzt/backup.zip
```

Die Ausgabe enthaelt Formatversion, Dateianzahl und den berechneten SHA-256-Wert.
Wert mit einer vertrauenswuerdigen Referenz vergleichen. Nur Format 2 wird akzeptiert.

2. Dienst und andere Schreiber stoppen, dann Status pruefen:

```sh
npm run backup:status
```

Bei `locked: true` nicht fortfahren. Die Sperre enthaelt in `owner.json` Host,
PID, Zweck und Startzeit. Ein laufender Prozess muss zuerst geordnet beendet werden.

3. Nach Freigabe des Wartungsfensters wiederherstellen:

```sh
npm run backup:restore -- --archive /geschuetzt/backup.zip --sha256 ERWARTETER_64STELLIGER_SHA256 --operator "Vorname Nachname" --reason "Genehmigte Wiederherstellung nach Vorfall ..."
```

Operator und Begruendung sind Pflicht. Der Operator ist die Angabe der berechtigten
Person an der Shell, keine ChurchTools-Authentisierung. Host und OS-UID werden mit erfasst.
Der Archivhash wird vor der Wiederherstellung verglichen. Die Ausgabe nennt `current`,
`previous` und den Zeigerpfad. Bei einem Fehler nach dem Umschaltpunkt kann bereits
der neue, vollstaendige Stand aktiv sein; die Fehlermeldung weist darauf hin.

4. Status und erwartete Pfade pruefen, dann den regulaeren Dienst starten:

```sh
npm run backup:status
npm start
```

Im betreuten Betrieb statt `npm start` den bisherigen Prozessmanager verwenden.
Anschliessend Anmeldung, Belegansicht, Freigabehistorie, Archivquittungen und
Backup-Erstellung pruefen. Wiederhergestellte Sessions sind ungueltig: neu anmelden.
Erst danach automatischen Neustart und externe Workflows wieder freigeben.

## Rueckwechsel

Ein Rueckwechsel ist kein Zusammenfuehren von Datenstaenden. Aenderungen nach der
Wiederherstellung bleiben nur im dann inaktiven neuen Stand erhalten. Deshalb
Schreiber stoppen und die Entscheidung fachlich freigeben lassen.

```sh
npm run backup:rollback -- --operator "Vorname Nachname" --reason "Freigegebener Rueckwechsel nach Abnahmefehler ..."
npm run backup:status
```

Der vorherige Stand wird vor dem Umschalten auf Datenbank-/Dateikonsistenz geprueft.
Alte Sessions werden auch beim Rueckwechsel entfernt. Der neue Stand bleibt erhalten;
der Zeiger speichert danach diesen als vorherigen Stand. Automatisch unterstuetzt wird
jeweils ein Rueckwechsel auf den unmittelbar vorherigen Stand, keine beliebige Historienauswahl.

## Abbruch und Sperren

- Fehler vor dem Umschalten: bisheriger Stand bleibt aktiv; normal aufgefangene
  Fehler entfernen das unbenutzte neue Verzeichnis.
- Fehler nach dem Umschalten: beide Staende bleiben erhalten. Status pruefen;
  nicht pauschal erneut importieren und keine Generation manuell loeschen.
- SIGTERM/SIGINT: der Server beendet HTTP-Verbindungen, schliesst die DB und gibt
  die Sperre frei. Nach maximal 30 Sekunden wird die Beendigung erzwungen.
- SIGKILL/Stromausfall: die Sperre bleibt absichtlich bestehen und laeuft nicht ab.
  Das verhindert einen Restore, waehrend ein alter Prozess moeglicherweise weiter schreibt.

Eine verwaiste Sperre darf nur nach Nachweis entfernt werden, dass auf dem angegebenen
Host keine zugehoerigen Prozesse oder offenen DB-Schreiber mehr existieren und kein
Supervisor sie neu startet. Danach `owner.json` und das leere Sperrverzeichnis gezielt
entfernen und den Status erneut pruefen. Es gibt keinen automatischen Force-Unlock.
PID allein ist wegen Wiederverwendung/Containern kein hinreichender Nachweis.

Restore-Vorbereitung wird in der neuen Datenbank protokolliert. Aktivierungsabsicht,
Aktivierung und Fehler stehen ausserdem in `<DB_PATH>.maintenance.jsonl` mit fsync.
Dieses lokale Journal ist kein extern unveraenderliches Audit-Archiv.

## Testnachweise und Grenzen

Automatisierte Tests pruefen Roundtrip/Pfadumsetzung, Session-Invalidierung,
exklusive Prozesssperre, falschen Hash, simulierte Fehler vor/nach Aktivierung,
echten SIGKILL vor/nach dem Umschalten, Rueckwechsel und einen echten Serverstart
auf dem neuen Stand samt SIGTERM. Die Fixtures sind temporaere Testdaten.
Stromausfall-/Dateisystemtests auf dem Zielhost, Staging-Migration und betriebliche
Abnahme stehen noch aus. Backup-Verschluesselung und ein unabhaengiger
Herkunftsnachweis sind ebenfalls noch offen.
