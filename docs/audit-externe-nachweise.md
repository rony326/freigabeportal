# Externe Audit-Nachweise: Bedrohungsmodell und lokale Grundlage

Stand: 2026-09-29. Keine Audit-Freigabe. Ein unveraenderliches externes Speicherziel ist
**nicht festgelegt**; dieses Dokument beschreibt, was lokal umgesetzt ist, was es beweist und
welche Betreiberentscheidungen fehlen.

## Vorhandene Exportmoeglichkeiten (Ist-Stand)

| Weg | Inhalt | Eignung als externer Audit-Nachweis |
| --- | --- | --- |
| Verschluesseltes Backup (`.fpbak`, n8n `GET /api/n8n/backup`) | komplette SQLite-DB inkl. `audit_ereignisse` | Nein. Wer den Backup-Schluessel hat, kann manipulierte Stände verschluesseln; keine Kettenbindung zwischen Sicherungen, kein Empfangsnachweis. |
| Admin-Ansicht `/admin/audit-log` | Anzeige, keine Ausleitung | Nein. |
| Wartungsjournal `*.maintenance.jsonl` | Restore-/Rollback-Ereignisse, lokal | Nein, gleiche Vertrauensgrenze wie die DB. |
| **Neu:** `npm run audit:export` | fortlaufende, hashverkettete Audit-Pakete | Nur Grundlage. Beweiskraft entsteht erst durch ein externes, vom Portal unabhaengig kontrolliertes Ziel. |

## Bedrohungsmodell

| Akteur | Faehigkeit | Heute abgedeckt durch | Offen |
| --- | --- | --- | --- |
| Web-Angreifer ohne Rechte | Requests, CSRF-Versuche, API-Key-Raten | Rechte-/CSRF-/Key-Pruefung, gedrosselte Protokollierung verweigerter Zugriffe | – |
| Berechtigte Person (Innentaeter) im Portal | fachliche Aktionen | transaktionale Audit-Trigger, Akteur, Request-ID | Bei Kollusion mit Betreiber keine externe Gegenkontrolle |
| Kompromittierter App-Prozess / Host-Benutzer | Schreibzugriff auf DB und Dateien | lokale UPDATE/DELETE-Trigger (umgehbar: Trigger koennen gedroppt werden) | Externe, vorab ausgelieferte Manifeste sind der einzige Schutz |
| DB-/Betriebsadministrator | beliebige DB-Aenderung, auch Neuberechnung von Hashes | – | Nur ein externes Ziel mit Zugriffstrennung (WORM/Aufbewahrungssperre) |
| Inhaber des Backup-Schluessels | manipuliertes Backup erzeugen/einspielen | Restore-Auditjournal, Quellhash | Unabhaengiger Herkunftsnachweis |
| n8n-/Paperless-Betreiber | Quittungen melden | Hash-/ID-Bindung der Quittung | Direkte Archivpruefung |

Kernaussage: Lokale Dateien, lokale Hashketten und ein HTTP-200 eines Zielsystems sind **kein
Beweis externer Unveraenderlichkeit**. Wer DB und Exportregister kontrolliert, kann beide
konsistent neu berechnen. Beweiskraft entsteht erst, wenn Manifest-Hashes zeitnah an ein Ziel
gelangen, das der Portal-Betreiber nachtraeglich nicht aendern kann, und der Empfang dort
unabhaengig nachvollziehbar ist.

## Lokal umgesetzt (klar abgegrenzt)

- `src/services/auditExport.js`, Tabelle `audit_export_pakete` (UPDATE/DELETE gesperrt).
- Ein Paket umfasst alle Ereignisse ab der letzten exportierten ID (max. 5000) in kanonischer
  JSONL-Form inkl. Request-/Laufzuordnung, plus Manifest: Format, Paketnummer, ID-Bereich,
  erkannte ID-Luecken, SHA-256 des Inhalts, SHA-256 des Vorgaengerpakets, Paket-Hash.
- Erzeugung unter `BEGIN IMMEDIATE`: keine verzweigte Kette, kein uebersprungenes Ereignis.
- `npm run audit:export -- --out <verzeichnis>` schreibt `audit-export-NNNNNNNN.jsonl` und
  `.manifest.json` (Modus 0600, nie ueberschreibend). `--paket N` gibt ein registriertes Paket
  erneut aus, falls das Schreiben nach der Registrierung scheiterte; abweichender Inhalt bricht ab.
- `npm run audit:verify` gleicht Register, Kette und neu berechnete Inhalte mit der DB ab.
  `pruefeAuditExportPaket` prueft ein ausgeliefertes Paket ohne DB (fuer den Empfaenger).
- Tests: `test/unit/auditExport.test.js` (Kette, Determinismus, Luecken, lokale Manipulation,
  Empfaengerpruefung, CLI mit exklusiven 0600-Dateien).

Nicht umgesetzt und bewusst nicht simuliert: Transport, Empfangsquittung, Aufbewahrungssperre,
Alarm bei Exportrueckstand (Rueckstand ist ueber `node src/cli/auditExport.js status` abfragbar),
automatischer Zeitplan.

## Benoetigte Betreiberentscheidungen

1. **Zielsystem** mit technischer Aufbewahrungssperre, die der Portal-Betreiber nicht aufheben
   kann (z.B. Objektspeicher mit Compliance-Lock bei einem getrennt verwalteten Konto, externer
   Log-Dienst mit Aufbewahrungsgarantie, oder Hinterlegung der Manifest-Hashes bei Dritten).
2. **Zugriffstrennung:** wer darf schreiben (nur Append), wer lesen, wer verwaltet das Ziel;
   keine Portal-Administratoren mit Loesch-/Aenderungsrecht.
3. **Umfang:** komplette Pakete (personenbezogen, Datenschutz/Zugriff klaeren) oder nur Manifeste
   (Hash-Hinterlegung, Inhalt bleibt lokal/Backup).
4. **Frequenz und maximaler Rueckstand** (RPO fuer Audit), Alarmempfaenger bei Rueckstand/Fehler.
5. **Aufbewahrungsfrist** (z.B. GeBueV/OR 958f, zehn Jahre) und Loeschkonzept nach Fristablauf.
6. **Empfangsnachweis:** was gilt als Quittung (signierte Empfangsbestaetigung, Versions-ID mit
   Sperrdatum), wer prueft sie regelmaessig, wie werden Abweichungen eskaliert.
7. **Schluessel/Zugangsdaten** fuer das Ziel: Ablage ausserhalb von DB und Repository, Rotation.

Erst nach diesen Entscheidungen: Transportadapter, persistente Versandwarteschlange mit Retry,
Quittungsspeicherung und Abnahmetest G08 (Aendern/Loeschen mit App-Zugang versuchen).
