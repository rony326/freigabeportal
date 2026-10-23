# Externe Audit-Nachweise: Bedrohungsmodell und lokale Grundlage

Stand: 2026-10-23. Keine Audit-Freigabe. Ein unveraenderliches externes Speicherziel fuer die
Paketinhalte ist **nicht festgelegt**; dieses Dokument beschreibt, was lokal umgesetzt ist, was es
beweist und welche Betreiberentscheidungen fehlen. Seit 2026-10-23 gibt es zusaetzlich den
automatischen **Audit-Nachweis fuer die Revision** (TSA-Bestaetigung der Paket-Hashes plus
Pruefnummer-Mail, siehe unten).

## Vorhandene Exportmoeglichkeiten (Ist-Stand)

| Weg | Inhalt | Eignung als externer Audit-Nachweis |
| --- | --- | --- |
| Verschluesseltes Backup (`.fpbak`, n8n `GET /api/n8n/backup/latest`) | komplette SQLite-DB inkl. `audit_ereignisse` | Nein. Wer den Backup-Schluessel hat, kann manipulierte Stände verschluesseln; keine Kettenbindung zwischen Sicherungen, kein Empfangsnachweis. |
| Admin-Ansicht `/admin/audit-log` | Anzeige, keine Ausleitung | Nein. |
| Wartungsjournal `*.maintenance.jsonl` | Restore-/Rollback-Ereignisse, lokal | Nein, gleiche Vertrauensgrenze wie die DB. |
| `npm run audit:export` | fortlaufende, hashverkettete Audit-Pakete | Nur Grundlage. Beweiskraft entsteht erst durch ein externes, vom Portal unabhaengig kontrolliertes Ziel. |
| **Neu:** Job `audit-export` + Job `audit-pruefnummer` | taeglich automatisch Pakete, RFC3161-Zeitstempel ueber jeden Paket-Hash, regelmaessige Pruefnummer-Mail an die Revision | Ja, fuer die Frage "wurde das Audit-Log nachtraeglich veraendert?": TSA und Revisions-Postfach liegen ausserhalb der Kontrolle der Portal-Admins. Die Paketinhalte selbst bleiben im Portal und in den Backups. |

## Bedrohungsmodell

| Akteur | Faehigkeit | Heute abgedeckt durch | Offen |
| --- | --- | --- | --- |
| Web-Angreifer ohne Rechte | Requests, CSRF-Versuche, API-Key-Raten | Rechte-/CSRF-/Key-Pruefung, gedrosselte Protokollierung verweigerter Zugriffe | – |
| Berechtigte Person (Innentaeter) im Portal | fachliche Aktionen | transaktionale Audit-Trigger, Akteur, Request-ID | Bei Kollusion mit Betreiber keine externe Gegenkontrolle |
| Kompromittierter App-Prozess / Host-Benutzer | Schreibzugriff auf DB und Dateien | lokale UPDATE/DELETE-Trigger (umgehbar: Trigger koennen gedroppt werden) | Externe, vorab ausgelieferte Manifeste sind der einzige Schutz |
| DB-/Betriebsadministrator | beliebige DB-Aenderung, auch Neuberechnung von Hashes | RFC3161-Zeitstempel (DigiCert) ueber jeden Paket-Hash und Pruefnummer-Mail an eine Person der Revision, die nicht Portal-Admin ist: rueckwirkend neu berechnete Hashes passen nicht mehr zu Token und Mails | Inhalte liegen nur im Portal/Backup (kein WORM); die Pruefseite laeuft im Portal selbst (siehe "Ehrliche Grenze") |
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

Nicht umgesetzt und bewusst nicht simuliert: Transport der Paketinhalte, Empfangsquittung eines
Zielsystems, Aufbewahrungssperre. (Zeitplan und Alarm bei fehlendem Zeitstempel gibt es seit
2026-10-23, siehe naechster Abschnitt; der Rueckstand ist weiterhin ueber
`node src/cli/auditExport.js status` abfragbar.)

## Audit-Nachweis fuer die Revision (automatisch)

Zielgruppe: Vorstand/Revision, typischerweise bei der Jahrespruefung. Frage: *Hat jemand mit Admin-
oder Serverzugriff das Audit-Log im Nachhinein veraendert?* Spec:
`docs/superpowers/specs/2026-10-23-audit-nachweis-revision-design.md`.

**Ablauf**

1. Job `audit-export` (taeglich, Default 03:15 Europe/Zuerich) erzeugt Pakete, bis nichts mehr aussteht
   (`erstelleAuditExportPaket`). Auch ohne fachliche Ereignisse entsteht jede Nacht ein Paket, weil
   der Lauf selbst als Ereignis (`hintergrundlauf`, Lauf-Markierungen) protokolliert wird.
2. Fuer jedes Paket ohne Nachweis holt er einen RFC3161-Zeitstempel (`stempleAuditPaket` in
   `src/services/auditZeitstempel.js`). Der MessageImprint ist SHA-256 ueber die UTF-8-Bytes der
   64-stelligen hexadezimalen **Pruefnummer** (= `paket_sha256`); extern mit Standardwerkzeugen
   nachrechenbar. Die Vertrauenskette wird **beim Stempeln** geprueft und im Nachweis gespeichert
   (Tabelle `audit_export_zeitstempel`, unveraenderlich). Die Pruefseite prueft spaeter nur die
   Integritaet des Tokens (`pruefeAuditZeitstempelToken`), nicht die Kette erneut.
3. Faellt die TSA aus, entsteht das Paket trotzdem; der Stempel wird beim naechsten Lauf nachgeholt
   (aelteste zuerst, keine verzweigte Kette). Ist das aelteste Paket ohne Zeitstempel laenger als
   `audit_zeitstempel_alarm_tage` (Default 3) offen, geht hoechstens alle 24 h eine Mail
   (`mail_log.typ = 'sicherheitsalarm'`) an `sicherheitsalarm_empfaenger`.
4. Job `audit-pruefnummer` (taeglich, Default 07:00) verschickt nur am konfigurierten Versandtag
   (Rhythmus monatlich/quartalsweise/jaehrlich, Tag 1-28) die Mail `audit-pruefnummer` an
   `audit_revision_empfaenger`: Paketnummer, Pruefnummer, Zeitraum, Anzahl Ereignisse, Zeitstempel,
   Anzahl Pakete ohne Zeitstempel, Link zur Pruefseite. Nach aussen gehen nie Personendaten. Auf
   Knopfdruck: Superadmin, `POST /admin/zeitstempel/audit-pruefnummer-senden`.
5. Pruefung: oeffentliche Seite `GET /audit-pruefen?paket=N&pruefnummer=...` (kein Login,
   `publicLimiter`, nur lesend). Eingabe wird normalisiert (Leerzeichen, Gross/Klein). Punkte, je
   gruen/rot: (1) Paket existiert und Pruefnummer stimmt, (2) Verkettung und Inhalt (ganzes Register
   gegen die DB, `pruefeAuditExportRegister`), (3) Zeitstempel gueltig und rechtzeitig
   (`gen_time` hoechstens 5 Min. vor und 7 Tage nach Erstellung); dazu Anzahl neuerer Pakete.
   "Keine Veraenderung festgestellt" nur, wenn alle Punkte gruen sind.

**Empfaenger-Schutz:** `audit_revision_empfaenger` (komma-getrennt) und alle Einstellungen aendert nur
der Superadmin auf `/admin/zeitstempel`. Wechsel der Empfaenger geht als Mail an alte **und** neue
Adresse, Abschalten sowie Aenderung von Rhythmus/Tag als Mail an die Empfaenger; Aenderungen stehen
im Audit-Log (Trigger auf `admin_config`). Gehoert eine Adresse zu einer Person mit Admin-Rechten, warnt die Seite.

**Verhalten im Detail**

- Punkt 2 prueft das **ganze** Register: ein spaeter beschaedigtes Paket macht auch eine aeltere,
  frueher korrekte Pruefnummer rot. Das ist gewollt.
- Abgeschaltet (`modul_audit_nachweis_aktiv` != `1`): beide Jobs liefern `uebersprungen`, es entstehen
  keine Pakete, Stempel, Mails oder Alarme. Die Pruefseite funktioniert weiter (mit Hinweis). Nach dem
  Wiedereinschalten holt der naechste Lauf alles Ausstehende nach.
- Ohne TSA-Konfiguration entstehen Pakete, aber keine Stempel; die Pruefseite zeigt rot.
- Ohne Empfaenger entfaellt die Mail; Pakete und Stempel laufen weiter.

**Ehrliche Grenze**

- Die Pruefseite laeuft im Portal. Wer den Server voll kontrolliert, koennte auch sie verfaelschen. Fuer
  eine vertiefte Pruefung: Backup-Kopie offline mit `npm run audit:verify` pruefen und die
  TSA-Token gegen die gemailten Pruefnummern vergleichen. Die Huerde steigt von "eine SQL-Zeile" auf
  "Code des Portals faelschen".
- Bekannte Luecke: Wird am Versandtag die Versandzeit verpasst (Portal laeuft dann nicht), wird diese
  Periode uebersprungen; es gibt keinen Nachlauf. Der naechste Termin sendet wieder, oder
  der Superadmin loest den Versand von Hand aus.
- Die Paketinhalte (personenbezogen) bleiben im Portal und in den Backups; ein WORM-Ziel gibt es weiterhin nicht.

## Benoetigte Betreiberentscheidungen

0. Die Betreiberentscheidungen unten betreffen den Transport der Paketinhalte; die Revisions-Pruefnummer ist davon unabhaengig umgesetzt.
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
