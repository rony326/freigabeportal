# Audit-Paket: Request-Korrelation und Backup-Loeschungen

Stand: 2026-09-29. Separater Branch `codex/audit-hardening`, Ausgangspunkt
`cfb8e6a` einschliesslich der bereits integrierten Kreditkarten-Aenderungen.
Export-/Zahlungsintegritaet und die zugehoerigen Fachtabellen werden nicht geaendert.

## Request-Korrelation

Die Anwendung vergibt vor Body-Parsing und Session-Verarbeitung eine zufaellige
UUID je HTTP-Request und liefert sie als `X-Request-ID` zurueck. Eine vom Client
mitgelieferte ID wird ignoriert. Keine Query-Parameter, Cookies, Authorization-
Header, Bodies oder IP-Adressen werden fuer diesen Nachweis gespeichert.

Eine eigene AsyncLocalStorage-Instanz haelt die Request-ID unabhaengig vom Akteur.
Ein Wechsel zu einem Maschinenakteur behaelt deshalb dieselbe Request-ID.
`mitAuditKontext` stellt bei Upload-Callbacks sowohl Akteur als auch Request-ID
wieder her, auch wenn ein fremder Stream-Kontext den Callback ausloest.

Die additive Migration `src/db/auditRequestSchema.js` erstellt die Tabelle
`audit_request_zuordnung` mit genau einer Zuordnung pro Audit-Ereignis.
Ein AFTER-INSERT-Trigger schreibt sie in derselben Transaktion wie das Ereignis.
Scheitert die Zuordnung, scheitert auch dessen INSERT. UPDATE und DELETE sind
gesperrt. Bestehende Ereignisse erhalten keine erfundenen Request-IDs.
Hintergrund-/Wartungsaktionen ohne HTTP-Kontext bleiben ohne Request-Zuordnung.

Die bestehende Audit-Ansicht zeigt die ID in den Aenderungsdetails an.
Die ID ist ein Korrelationsmerkmal, keine Berechtigung und kein Nachweis einer
erfolgreichen HTTP-Antwort. Abgewiesene Requests ohne Audit-Ereignis werden dadurch
nicht automatisch protokolliert; externe Logs werden noch nicht angebunden.

## Backup-Loeschungen

Manuelle Loeschung und automatische Retention verwenden `deleteBackupWithAudit`.
Der Ablauf schreibt unabhaengig von einer rueckrollbaren Fachtransaktion:

1. `backup_loeschung_beabsichtigt` vor dem Dateieingriff.
2. `backup_geloescht` nach erfolgreichem Unlink oder
   `backup_loeschung_fehlgeschlagen` bei einem aufgefangenen Dateifehler.

Beide Ereignisse enthalten dieselbe zufaellige `operationId`, den Backup-Dateinamen,
Akteur und den technischen Anlass (manuell/Retention). Fehler enthalten nur einen
begrenzten Fehlercode, keinen Stack oder geheimnishaltigen Dateipfad. Es werden keine
Schluessel und keine Backup-Inhalte protokolliert. Der Anlass ersetzt keine vom
Administrator eingegebene fachliche Begruendung; ein solches Pflichtfeld ist hier
noch nicht eingefuehrt.

Ohne erfolgreich gespeicherte Absicht wird nichts geloescht. Aufruf innerhalb einer
offenen DB-Transaktion wird abgelehnt: ein Rollback koennte die Datei nicht zurueckholen.
Scheitert das Abschlussprotokoll oder stirbt der Prozess nach dem Unlink, bleibt
die Absicht ohne Ergebnis. Das ist ein ungeklaerter Vorgang, nicht automatisch eine
erfolglose Loeschung. Die Admin-Backup-Seite listet solche Absichten inzwischen
mit maximal 50 Eintraegen je Seite und Cursor-Pagination auf. Ein passendes Ergebnis
muss zu Dateiname und operationId gehoeren und nach der Absicht liegen. Beschaedigte
oder fehlende Vorgangs-IDs werden nicht stillschweigend als geklaert behandelt.
Die Anzeige liest nur das Auditprotokoll: Dateien werden nicht automatisch entfernt,
fehlende Dateien beweisen keinen Loescherfolg. Externe Alarmierung steht noch aus.
Dateisystem und Datenbank bilden keine gemeinsame atomare Transaktion.

Administratoren koennen eine offene Absicht ueber
`POST /admin/backup/loeschungen/:id/pruefen` manuell klaeren. Die vorhandene
Superadmin-Zugriffssperre und CSRF-Pruefung gelten auch dort. Pflichtangaben sind
der festgestellte Dateibestand (vorhanden/nicht vorhanden) und eine Begruendung
mit 10 bis 2000 Zeichen; keine Zugangsdaten in Freitextfelder eintragen.

Die Pruefung schreibt ausschliesslich einen neuen Eintrag
`backup_loeschung_geprueft` mit Absichts-ID, Beobachtung und
`evidence: administrator_statement`. Akteur, Request-ID, Zeit und Begruendung
bleiben nachvollziehbar. Bestehende Ereignisse und Dateien werden nicht geaendert.
Auch historische Absichten ohne operationId koennen anhand ihrer eindeutigen
Audit-ID geprueft werden. Eine BEGIN-IMMEDIATE-Transaktion prueft den offenen Stand
erneut vor dem INSERT; doppelte/zwischenzeitlich abgeschlossene Vorgange ergeben
HTTP 409. Schreibfehler lassen die Absicht offen. Eine manuelle Pruefung entfernt
sie aus der offenen Liste, ist aber kein kryptographischer Nachweis der damaligen
Loeschung oder der Archivierung des Backup-Inhalts.

## Korrelation von Hintergrundlaeufen

Alle neun exportierten Job-Funktionen erhalten je Aufruf eine frische Lauf-UUID,
unabhaengig davon, ob Scheduler, Cron-API oder Administrator sie startet. Der Akteur
bleibt erhalten; die authentifizierte Cron-API setzt `service:cron`, der Scheduler
laeuft standardmaessig als System. HTTP-Request-ID und Lauf-ID koennen gleichzeitig
vorliegen. Verschachtelte/parallele Jobs bekommen eigene IDs; nach Rueckkehr gilt
wieder der aeussere Kontext. Upload-Callbacks bewahren auch diesen Laufkontext.

`audit_lauf_zuordnung` ordnet Audit-Ereignisse einem Lauf und Typ zu, atomar per
INSERT-Trigger und gegen UPDATE/DELETE gesperrt. Die bestehende Aenderungsansicht
zeigt Lauf-ID und Typ. Job-Start und Ende/Abbruch werden selbst als Audit-Ereignisse
geschrieben, ohne ungefilterte Ergebnisobjekte oder Fehlermeldungen zu speichern.
Ohne Startnachweis beginnt der Job nicht. Fehlender Abschluss ist kein Erfolg;
bereits erfolgte fachliche Aenderungen werden durch einen Audit-Abschlussfehler
nicht rueckgaengig gemacht. Das bisherige Job-Ergebnisformat bleibt unveraendert.

Offline-Restore und Rollback erhalten ebenfalls eigene Lauf-IDs. Diese stehen bei
ihren DB-Audit-Ereignissen und im lokalen Wartungsjournal als `laufId`.
Reine CLI-Status-/Verify-Aufrufe erhalten derzeit keinen dauerhaften Laufnachweis.
Bestehende Cron-/Sync-Logtabellen werden nicht umgebaut; der neue Laufnachweis
liegt separat im Auditprotokoll. Externe Logs sind noch nicht angebunden.

## Integration und Tests

Neue Migration ist ueber einen eigenen Aufruf am Ende von `openDatabase` angebunden.
Die bestehende Security-Migration und Export-/Snapshot-Schemata bleiben unangetastet.
Bei parallelen Merges besonders `src/db/index.js`, `src/app.js` und
`src/services/cronJobs.js` gemeinsam pruefen; dort sind nur schmale Integrationspunkte.
Auch `package.json`/`package-lock.json` enthalten gezielte Sicherheitsupdates und
muessen beim Merge gegen parallele Dependency-Aenderungen abgeglichen werden.
Die neue Tabelle wird mit der kompletten SQLite-Datenbank gesichert und beim
Oeffnen historischer Restore-Datenstaende additiv erstellt.

Gezielte Tests pruefen parallele Requests, ignorierte Client-IDs, Maschinenakteure,
fremde Upload-Kontexte, Unveraenderlichkeit, Rollback und Triggerfehler. Backup-Tests
pruefen Absicht/Ergebnis, Akteur/Korrelation, Dateifehler, verweigerte Audit-Schreibvorgaenge
und fehlende Abschlussprotokolle. Bestehende Retention-/Admin-Tests laufen ebenfalls.
Zusaetzliche Tests decken parallele/verschachtelte Hintergrundlaeufe, synchrone und
asynchrone Fehler, uebersprungene Jobs, Restore-Journal-Zuordnung und Seitengrenzen
der offenen Liste ab. Die manuelle Pruefung ist gegen fehlende Rechte, fehlenden
CSRF-Nachweis, ungueltige Angaben, doppelte Einreichung und Audit-Schreibfehler getestet.

## Dependency-Pruefung am 2026-09-29

Der erneute Registry-Scan meldete drei moderate betroffene Pakete, obwohl der
vorherige Scan noch null bekannte Schwachstellen auswies. Gezielt aktualisiert:

- `ip-address` (transitiv ueber express-rate-limit): 10.5.0 auf 10.7.2.
  [Link-local-Klassifikation](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rpw4-54j3-4h4q)
  und [NAT64-Klassifikation](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-2vr4-cq9g-pvrc).
- `nodemailer`: installierte Version 9.1.1 auf 10.0.12, direkte Anforderung auf
  `^10.0.12`. [DNS-/TLS-Identitaetscache](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-6vj9-mwq6-2f5v).
- `undici` (Testabhaengigkeit): 6.28.0 auf 6.29.0.
  [WebSocket-Dekompression](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v).

Kein pauschales `npm audit fix --force`, keine neuen Laufzeitabhaengigkeiten.
Nodemailer 10 benoetigt Node >=20; das Projekt verlangt bereits Node >=22.13.
Ein zusaetzlicher Test prueft den echten Nodemailer-Transport ueber die Portal-API
gegen einen lokalen SMTP-Testserver. Er ersetzt keine produktive SMTP-/TLS-Abnahme.
Nach Aktualisierung meldet `npm audit` null bekannte Schwachstellen.
Gesamtsuite am 2026-09-29: 1.543 Tests bestanden, null fehlgeschlagen;
`git diff --check` ohne Befund.

## Noch offen

- Vollstaendige Ereignisabdeckung, insbesondere verweigerte Zugriffe und weitere
  nicht durch DB-Trigger erfasste Dateieingriffe.
- Durchgaengige Korrelation mit externen Logs und weiteren Wartungswerkzeugen.
- Externer unveraenderlicher Audit-Export mit separat gesichertem Empfangsnachweis,
  Wiederanlauf, Aufbewahrung und Betriebsabnahme.
- Externe Alarmierung offener Loeschabsichten und reale Stromausfallprobe.

Die lokalen SQLite-Sperren schuetzen nicht gegen einen Betreiber mit direktem
Datei-/DB-Zugriff. Dieses Teilpaket ersetzt keinen externen unveraenderlichen Nachweis.
