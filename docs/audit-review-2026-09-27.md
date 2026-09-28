# Technischer Sicherheits- und Audit-Review

Stand: 2026-09-27. Gepruefter Commit: `955f4821ad61854b37e29289f2a728ee320e474c`.

## Bewertung und Umfang

Die Anwendung hat eine solide Basis bei Session-Schutz, CSRF, rollenbezogener
Autorisierung und dem Vier-Augen-Prinzip. Fuer einen belastbaren Audit-Nachweis
bestehen jedoch wesentliche Luecken bei Aenderungshistorie, Dokumentintegritaet,
Export und Wiederherstellung. Die produktive Installation, ChurchTools, der
externe n8n-Workflow und das Zielarchiv waren nicht Gegenstand dieser Pruefung.
Dieser Bericht bewertet technische Kontrollen, keine rechtliche Konformitaet
oder Zertifizierungsfaehigkeit nach einem bestimmten Standard.

Geprueft wurden die aktuelle Betriebs-/Fachdokumentation, zentrale Router,
Autorisierung, Datenmodell, PDF-/Zeitstempelverarbeitung, Backup, Export und
zugehoerige Tests. Historische Spezifikationen sind keine Zusicherung einer
Implementierung. Raumvermietung und Vertragsmanagement liegen als Spezifikationen
vor; entsprechende produktive Module wurden im aktuellen Quellbaum nicht gefunden.

Verifikation:

- `npm test`: 1.238 Tests bestanden, 0 fehlgeschlagen, 0 uebersprungen.
- `npm audit --json`: sechs betroffene Pakete, drei high, drei moderate,
  keine critical. Paketanzahl ist nicht gleich Anzahl unabhaengiger Schwachstellen.
- Isolierte In-Memory-Proben fuer Hash-Reset und Sync-Berechtigung sowie eine
  Zeitstempelprobe mit der vorhandenen Test-PDF. Keine produktiven Daten verwendet.
- Anwendungsquellcode und Abhaengigkeiten wurden nicht veraendert.

Prioritaeten: P1 = vor auditrelevantem Produktivbetrieb beheben;
P2 = wesentliche Kontrollluecke, zeitnah schliessen. Die Einstufung beruecksichtigt
die Voraussetzungen im Portal, nicht nur den generischen CVSS-Wert.

## Befunde

### F01 / P1: Bekannte Schwachstellen in produktiven Abhaengigkeiten

Belege: `package.json:16`, `package-lock.json`,
`src/routes/zeitstempelPruefen.js:88`, `src/services/backup.js:65`.

Der aktuelle Dependency-Graph enthaelt betroffene Versionen von `multer`,
`adm-zip`, `nodemailer`, `qs`, `express` und `body-parser`. Insbesondere
Multer 2.2.0 kann durch speziell konstruierte Multipart-Feldnamen den
Node-Prozess zum Absturz bringen. Im Portal ist dafuer eine Session oder fuer
den Rechnungseingang ein API-Key erforderlich; die allgemeine Beschreibung
als unauthentifizierter Angriff ist hier nicht unveraendert uebertragbar.
Die Zeitstempel-Uploadroute steht jeder aktiven angemeldeten Person offen.
Multer verarbeitet Multipart-Daten vor der nachgelagerten CSRF-Pruefung.

Adm-zip betrifft den auf Superadmins beschraenkten Restore. Andere Meldungen,
etwa zu bestimmten Nodemailer-Aufrufen oder einem asynchronen Multer-fileFilter,
sind nicht automatisch ueber die hier verwendeten Aufrufe ausnutzbar.

Massnahme: Lockfile gezielt aktualisieren, mindestens die betroffenen Multer-
und Adm-zip-Versionen verlassen, volle Suite und Upload-Negativtests ausfuehren.
Advisories nennen Multer 2.3.0 bzw. Adm-zip 0.6.1 als korrigierte Versionen.
Automatisierte Dependency-Pruefung und einen Patch-Verantwortlichen festlegen.

Quellen: [Multer Advisory](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm),
[Adm-zip Advisory](https://github.com/advisories/GHSA-7q85-xj36-vmfc).

### F02 / P1: Sync-Leserecht erlaubt Eingriffe in beliebige offene Vorgaenge

Belege: `src/app.js:151`, `src/routes/admin/sync.js:34`,
`src/routes/admin/sync.js:66`, `src/db/jobsRepo.js:678`.

`sync_einsehen` schuetzt auch die schreibenden Routen. Deren Force-Aktion prueft
nicht, ob der Job tatsaechlich wegen einer inaktiven/nicht aufloesbaren Person
blockiert ist. Eine bekannte Job-ID reicht: zugewiesene oder abgelehnte Jobs
werden in den Pool zurueckgesetzt, Jobs in Freigabe 2 an Admins eskaliert.
Zuweisung und Konfliktinformationen koennen dabei geloescht werden.
Ein Ereignis mit handelnder Person und Begruendung wird nicht geschrieben.

Reproduziert mit dem echten Router und `requirePermission`, einer Person mit
nur `sync_einsehen` sowie einem einer aktiven Person zugewiesenen Job:
HTTP 302, danach `status=unzugewiesen`, `zugewiesen_an=null`, null Audit-Zeilen.
Session und gueltiger CSRF-Kontext wurden bei dieser isolierten Routerprobe
als gegeben behandelt; es handelt sich nicht um einen CSRF-Bypass.

Massnahme: eigenes Eingriffsrecht, serverseitige Blockadepruefung im selben
Schreibvorgang und verpflichtendes Audit-Ereignis. Negativtest: leseberechtigte
Person sowie nicht blockierter Job duerfen keine Aenderung ausloesen.

### F03 / P1: Pruefbescheinigung belegt keine vertrauenswuerdige Zeitquelle

Belege: `src/services/zeitstempel.js:62`, `views/zeitstempel-zertifikat.ejs:54`,
`docs/zeitstempel-und-pruefbescheinigung.md:58`.

`verifyTimestamp` erhaelt keinen Truststore. Die installierte Bibliothek
verwendet intern `checkChain: false`; eine Vertrauenskette wird nur mit explizit
uebergebenem Truststore geprueft. Gueltigkeit der Signatur mit dem beigefuegten
Zertifikat belegt daher keine vertrauenswuerdige TSA oder verlaessliche Uhrzeit.
Das Portal unterscheidet diese Aussagen im Ergebnis nicht. Auch eine Pruefung
des Sperrstatus bzw. eine Langzeitvalidierungsstrategie ist hier nicht umgesetzt.

Zusaetzlich wird nur `extrahiert[0]` geprueft, ohne die Abdeckung der kompletten
aktuellen Dateiversion sicherzustellen. Reproduziert: Anhaengen eines PDF-
Kommentars an die Testdatei veraendert ihren SHA-256, trotzdem bleibt
`gueltig=true`. Das beweist die fehlende Gesamtdatei-Abdeckung, noch keinen
erprobten Austausch sichtbarer Rechnungsinhalte. Ein vorhandener korrekter
DB-Hash erkennt diese Byte-Aenderung; die freie Uploadpruefung ohne Hash nicht.

Massnahme: zugelassene Vertrauensanker und TSA-Policy festlegen; Signatur,
Vertrauenskette, Sperrstatus, Abdeckung und Job-Hash getrennt ausweisen.
Unbekannte TSA und nachtraegliche PDF-Revisionen als Negativtests aufnehmen.
Die Dokumentation darf aus der heutigen Pruefung nicht pauschal ableiten,
dass die gesamte Datei seit einer vertrauenswuerdigen Uhrzeit unveraendert ist.
Fachliche Grundlage: [RFC 3161](https://www.rfc-editor.org/info/rfc3161/).

### F04 / P1: Abschluss kann ohne korrekt abgelegte Freigabe-PDF bestehen bleiben

Belege: `src/routes/freigabe2.js:397`, `src/routes/freigabe2.js:404`,
`src/services/cronJobs.js:318`; bestehender Test
`test/integration/freigabe2.test.js:429`.

Der Datenbankabschluss wird vor dem finalen Datei-Rename committed. Bei einem
Rename-Fehler bleibt der Job abgeschlossen; nur Zeitstempelwerte werden ggf.
zurueckgesetzt. Ohne aktive TSA kann der Export damit die alte ungestempelte
Datei ausliefern. Mit TSA setzt der Nachholjob lediglich einen Zeitstempel
auf die am Pfad vorhandene Datei: Er rekonstruiert nicht die fehlende
Freigabe-/Verlaufsseite. Ein Prozessabbruch zwischen Commit und Rename ist
ein weiterer offener Fehlerpfad. Der vorhandene Test akzeptiert den
abgeschlossenen Zustand nach Rename-Fehler ausdruecklich.

Massnahme: fertiggestellte, unveraenderliche Datei unter neuem Pfad ablegen,
Integritaet bestaetigen und erst dann den DB-Verweis/Exportstatus freigeben.
Expliziten Finalisierungsstatus und Wiederanlauf fuer unterbrochene Vorgaenge
vorsehen. Bei simulierten Datei-/Prozessfehlern darf niemals eine PDF ohne die
zugesagten Freigaben exportierbar sein.

### F05 / P1: Freigegebene Zahlungs-/Kontierungsdaten sind beim Export veraenderlich

Belege: `src/routes/freigabe2.js:269`, `src/routes/n8n/jobs.js:141`,
`src/routes/n8n/jobs.js:164`, `src/routes/n8n/jobs.js:198`.

Die IBAN und der Kontoinhaber von Spesen werden fuer die finale PDF aus
ChurchTools gelesen, beim Export aber erneut live abgefragt. Eine Aenderung
zwischen diesen Zeitpunkten liefert andere Zahlungsdaten als im gestempelten
Dokument. Wer die Custom-Fields aendern darf, haengt von der externen
ChurchTools-Konfiguration ab. Die Abweichung ist bereits ohne boeswilliges
Verhalten moeglich. Ebenso stammen Kontonummer und Kontobezeichnung beim Export
aus dem aktuellen Kontostamm; auch Splitgruppen sind betroffen.

Massnahme: versionierten Freigabe-Snapshot der Zahlungs- und Buchungsdaten
speichern und identisch fuer PDF und Export verwenden. Aenderungen danach
muessen eine explizite Korrektur bzw. erneute Freigabe ausloesen. Abnahmetest:
Stammdaten nach Freigabe aendern; Export bleibt identisch oder wird blockiert.

### F06 / P1: Restore ersetzt Live-Dateien bei weiterlaufender alter DB-Verbindung

Belege: `src/services/backup.js:174`, `src/services/backup.js:180`,
`src/services/backup.js:187`, `src/routes/admin/backup.js:175`.

Der Restore ersetzt den DB-Dateinamen, waehrend Router, Sessionstore und
Scheduler ihre alte Verbindung behalten. Die Dokumentverzeichnisse werden
sofort ersetzt. Bis zum manuellen Neustart arbeitet die App somit mit alter
Datenbank und neuer Dateiablage; spaetere Schreibvorgaenge auf der alten DB
koennen beim Neustart verloren gehen. Ein Fehler beim Kopieren nach dem
DB-Austausch hinterlaesst ausserdem einen nur teilweise wiederhergestellten
Stand. Ein Sicherheitsbackup ist vorhanden, aber kein automatischer Rollback.

Massnahme: Wartungsmodus, laufende Requests/Jobs beenden, Verbindungen schliessen,
gesamten Restore vorbereitet validieren und kontrolliert umschalten/neustarten.
Bis zur erfolgreichen Integritaetspruefung keine Freigaben oder Exporte zulassen.
Restore unter Last und mit simuliertem Kopierfehler pruefen.

### F07 / P2: Globales Audit-Log ist keine vollstaendige Aenderungshistorie

Belege: `src/services/globalAuditLog.js:4`, `src/routes/admin/personen.js:39`,
`src/routes/admin/konten.js:94`, `src/routes/admin/zeitstempel.js:44`,
`src/db/schema.sql:225`.

Die Gesamtsicht vereinigt nur `freigaben` und `job_loeschungen`. Rechtevergaben,
Konten-/Freigeberaenderungen, IBAN-Stammdaten, TSA-Abschaltung, weitere
Konfiguration und Force-Eingriffe besitzen keinen entsprechenden zentralen
Vorher-/Nachher-Nachweis mit Akteur. Restore-Ereignisse liegen separat.
Historische Anzeigen lesen Namen, Kontobezeichnung und Status aus aktuellen
Stammdaten. Freigabezeilen enthalten keinen vollstaendigen Snapshot der damals
freigegebenen Rechnungsdaten. Die Tabellen sind zudem regulaer veraenderbar;
eine unabhaengige manipulationserkennbare Sicherung ist nicht implementiert.

Massnahme: Ereigniskatalog definieren, kritische Aenderungen zusammen mit ihrer
Historie transaktional schreiben; Akteur, Objektversion, alte/neue Werte,
Grund und UTC-Zeitpunkt festhalten. Geheimnisse dabei redigieren. Ereignisse
regelmaessig in ein separat kontrolliertes unveraenderliches Ziel uebertragen.
Eine Hashkette allein in derselben administrierbaren DB reicht dafuer nicht.

### F08 / P2: Behaupteter Hash-Manipulationsschutz ist ueber NULL umgehbar

Belege: `src/db/schema.sql:175`, `src/db/jobsRepo.js:536`,
`test/unit/jobsRepo.test.js:1647`.

Die Trigger erlauben bewusst `Wert -> NULL -> anderer Wert`, sowohl fuer
Einzeljobs als auch Gruppen. Reproduziert in einer frischen In-Memory-DB:
direktes Ersetzen wird verhindert, zweistufiges Ersetzen gelingt. Damit
schuetzen sie nicht gegen den im Kommentar genannten direkten DB-Zugriff.
Dafuer ist DB-Schreibzugriff bzw. ein entsprechender interner Fehlerpfad
erforderlich; ein beliebiger Webnutzer kann diesen SQL-Pfad nicht direkt nutzen.

Massnahme: finalen Nachweis von temporaerem Finalisierungsstatus trennen,
finale Hashes nicht zur Fehlerkorrektur loeschen; Korrekturen append-only
modellieren und Referenzhash extern verankern. DB-Administratoren koennen
auch strengere SQLite-Trigger entfernen, weshalb diese keine unabhaengige
Vertrauensgrenze darstellen.

### F09 / P2: Splitgruppen-Pruefung verwendet das falsche Dokument und Hashfeld

Belege: `src/routes/zeitstempelPruefen.js:46`,
`src/routes/zeitstempelPruefen.js:62`, `src/routes/zeitstempelPruefen.js:116`,
`src/routes/downloads.js:88`, `views/zeitstempel-zertifikat.ejs:72`.

Der Export/Download verwendet beim Elternjob `gruppe_pdf_pfad`. Die
Verifikationsroute liest dagegen stets `pdf_pfad` und
`zeitstempel_datei_hash`. Auch nach Upload der archivierten Gruppen-PDF
wird nicht gegen `gruppe_zeitstempel_datei_hash` verglichen. Eine korrekt
zeitgestempelte Gruppe hat deshalb keinen passenden Nachweis in diesem Ablauf.

Massnahme: Dokumenttyp zentral aufloesen; fuer Gruppen konsistent den
Gruppenpfad und Gruppenhash verwenden. Test vor und nach Abholung einschliesslich
Upload der archivierten Gruppen-PDF hinzufuegen.

### F10 / P2: Restore-Validierung prueft keine referentielle Vollstaendigkeit

Belege: `src/services/backup.js:95`, `src/services/backup.js:128`,
`src/services/backup.js:146`, `test/unit/backup.test.js:33`.

Die Validierung prueft im Wesentlichen JSON und das Vorhandensein dreier
Tabellennamen. Abweichende Dateianzahlen erzeugen nur Warnungen. Es fehlen
DB-Integritaets-/FK-Pruefung, erwartete Spalten, referenzierte Dateien und
Dateihashes. Fehlende jobs-/branding-Verzeichnisse koennen beim Restore die
vorhandenen Verzeichnisse leeren. Gespeicherte PDF-/Thumbnail-/Gruppenpfade
werden bei einem Restore in andere Verzeichnisse nicht umgeschrieben.
Der Roundtrip-Test prueft Zeilen und Dateien getrennt, nicht deren Aufloesung
ueber den wiederhergestellten DB-Pfad.

Massnahme: Archiv vollstaendig in Staging pruefen, fehlende benoetigte Dateien
hart ablehnen, relative Objektpfade verwenden bzw. kontrolliert migrieren;
Grenzen fuer entpackte Gesamtgroesse und Eintragsanzahl setzen. Restore-Test
auf einem neuen Host muss reale Downloads und Hashpruefungen einschliessen.

### F11 / P2: Ein gemeinsamer n8n-Key erschliesst auch vollstaendige Backups

Belege: `src/app.js:159`, `src/app.js:160`, `src/services/backup.js:33`,
`src/routes/n8n/backup.js:10`, `src/db/sessionStore.js:13`.

Der Rechnungseingangs-/Export-Key erlaubt zugleich den Abruf der gesamten
DB samt personenbezogenen Daten, Berechtigungen, Sessions und TSA-Passwort.
Das ist dokumentiert, vergroessert aber den Schaden bei Verlust des Keys.
Backups enthalten unverschluesselte DB-Inhalte. Sessiondaten werden beim
Restore ebenfalls zurueckgespielt; eine zwischenzeitlich abgemeldete Session
kann bei gleichem SESSION_SECRET und noch nicht erreichtem Ablauf wieder
gueltig werden. Die Kenntnis einer SID allein ersetzt nicht die Cookie-Signatur.

Massnahme: getrennte minimal berechtigte Maschinenzugriffe, authentisierte
Backup-Verschluesselung, dokumentierte Rotation und Restore-seitiges Verwerfen
aller Sessions. Zugriff auf Backup-Ziel und Schluessel getrennt verwalten.

### F12 / P2: Abholbestaetigung loescht ohne belegbaren Archivierungsnachweis

Belege: `src/routes/n8n/jobs.js:234`, `src/routes/n8n/jobs.js:273`,
`docs/n8n-schnittstelle.md:64`.

Die API akzeptiert eine Bestaetigung ohne Archiv-ID, Zielhash oder Nachweis
einer erfolgreichen dauerhaften Ablage und loescht die lokale PDF. Ein
fehlerhafter Workflow kann damit den einzigen aktuellen Beleg entfernen.
Der externe n8n-Workflow ist nicht im Repository enthalten und wurde nicht
geprueft; er kann zusaetzliche Kontrollen besitzen. Das Portal speichert
deren Ergebnis jedenfalls nicht als nachvollziehbaren Uebergabebeleg.

Massnahme: Exportmanifest mit finalem Hash/Version, Bestaetigung mit externer
Dokument-ID und Hashabgleich, anschliessend begrenzte Wiederherstellungsfrist.
Idempotenz sowie Fehler zwischen Download, Archivierung und Bestaetigung mit
dem echten Zielsystem pruefen. Archivgarantien und Verantwortlichkeiten in
der Verfahrensdokumentation verbindlich festhalten.

## Dokumentationsabgleich

| Aussage/Bereich | Effektive Umsetzung / Korrekturbedarf |
| --- | --- |
| `docs/auth-und-rechte.md:87`: Manager nur Personenuebersicht | Widerspruch zum selben Dokument ab Zeile 109: Manager erhalten alle additiven Rechte, wie auch `permissions.js` implementiert. Rollenmatrix konsolidieren. |
| Recht `sync_einsehen` | Erlaubt Schreiben und Force-Eingriffe; Name und Zugriffsumfang passen nicht zusammen (F02). |
| `docs/architektur.md`: sechs Hintergrundjobs | Der aktuelle Scheduler hat acht; auch Admin-Doku nennt acht. Diagramme und Routerbeschreibung aktualisieren. |
| Zeitstempel beweist unveraenderte Datei | Nur mit expliziter Unterscheidung von Signatur, vertrauenswuerdiger TSA, PDF-Revision und unabhaengigem Hashnachweis haltbar (F03/F08). |
| Splitgruppen nutzen denselben Pruefmechanismus | Export ist implementiert, Pruefroute/Pruefbescheinigung verwenden aber Einzeljob-Felder (F09). |
| Backup vor Live-Aenderung vollstaendig validiert | Kommentar und Sicherheitswirkung gehen ueber die tatsaechliche Struktur-/Dateipruefung hinaus (F10). |
| Rechnungsdatum im Export | `n8n/jobs.js:173` setzt bei Rechnungen die Zahlungsfrist als Rechnungsdatum ein. Dokumentiert, aber fachlich unterschiedliche Daten; eigenes Rechnungsdatum erfassen und Exportvertrag korrigieren. |
| Globales Audit-Log | Als zusammengefuehrte Workflow-Historie zutreffend, als umfassender Audit-Trail unzureichend (F07). |

Die laufende Dokumentation ist detailliert, aber manche Aussagen beschreiben
eine beabsichtigte Garantie statt ihrer technischen Grenzen. Sicherheits-
Kommentare ersetzen keinen Negativtest. Explizit zwischen implementiert,
extern vorausgesetzt, optional und nur geplant unterscheiden.

## Weitere Betriebsnachweise und offene Pruefpunkte

Diese Punkte sind anhand des Repositories nicht abschliessend bewertbar:

- Gewuenschter Auditstandard und verbindliche Aufbewahrungs-/Loeschfristen,
  Originalbelegbehandlung, Verfahrensverantwortung und Aenderungsfreigaben.
- Tatsaechliche ChurchTools-Rechte fuer IBAN-Aenderungen, MFA fuer privilegierte
  Konten, Austrittsprozess und maximal tolerierte Verzoegerung beim Rechteentzug.
  Gruppen werden lokal zwischengespeichert; deren Entzug greift nicht sofort live.
- Externes Archiv: Unveraenderbarkeit, Berechtigungen, Restore-Nachweis,
  Vollstaendigkeitsabgleich und dokumentierte Wiederanlaufziele RPO/RTO.
- Proxy-Vertrauensgrenze: `trust proxy = 1` ist fest kodiert. Nur bei passender
  Topologie und gesaeubertem Forwarded-Header sind IP-basierte Limits und
  gespeicherte Freigabe-IP verlaesslich. Direkten Zugriff auf den App-Port pruefen.
- Produktions-TLS wird ueber die Konfiguration vorausgesetzt; `env.js` lehnt
  HTTP-URLs nicht ab. SMTP auf Port 587 erzwingt in `mailer.js` kein `requireTLS`.
  Tatsaechliche Transportabsicherung beim Betreiber pruefen und erzwingen.
- Upload-/PDF-Verarbeitung und ZIP-Operationen laufen weitgehend im Webprozess.
  Dateigroessenlimits ersetzen keine Laufzeit-/Gesamtspeichergrenzen. Isolation
  teurer Verarbeitung und Lasttests mit komplexen Dateien fehlen als Nachweis.
- Im Repository keine CI-Pipeline gefunden. Vendorte Assets wie PDF.js und
  Bootstrap werden durch `npm audit` nicht vollstaendig erfasst; Herkunft,
  Versionen und Aktualisierungsprozess separat inventarisieren.
- Alarmierung: `/healthz` bestaetigt nur den HTTP-Prozess; Integritaetsprobleme,
  fehlende PDFs, Mail-/Backup-/TSA-Ausfaelle brauchen externe Ueberwachung.

## Empfohlene Reihenfolge und Abnahme

1. Abhaengigkeiten aktualisieren und F02 schliessen; negative Berechtigungstests.
2. Finalisierung, Export-Snapshot und Restore korrigieren (F04-F06).
3. Zeitstempelvertrauen, Gruppenpruefung und unveraenderliche Nachweise (F03/F07-F09).
4. Backup-Verifikation, getrennte Maschinenrechte und Archivquittung (F10-F12).
5. Betriebsnachweise, Rechte-Matrix und Dokumentation mit der tatsaechlichen
   Installation abgleichen; verbleibende Risiken ausdruecklich verantworten.

Die bestehende Suite ist umfangreich und prueft bereits CSRF, Rollen, mehrere
Vier-Augen-Konflikte und konkurrierende Freigaben. Fuer die genannten Befunde
sind jedoch gezielte neue Negativ- und Wiederanlauftests erforderlich; ein
vollstaendig gruener bestehender Testlauf belegt diese Garantien noch nicht.
