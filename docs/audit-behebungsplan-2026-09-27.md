# Behebungs- und Testplan zum Audit-Review

Stand: 2026-09-27. Grundlage: [Audit-Review](audit-review-2026-09-27.md),
Befunde F01-F12. Status: teilweise implementiert, noch keine Betriebsabnahme.
Aktueller Nachweis und offene Punkte: [Umsetzungsstand](audit-umsetzungsstand-2026-09-27.md).
Die Portal-Seite der Archivquittung und die Backup-Format-2-Pruefung sind inzwischen
implementiert. Ein Offline-Restore mit Generationswechsel und Prozesssperre ist
ebenfalls umgesetzt. Externe n8n-Abnahme, DigiCert-Vertrauenspruefung und die reale
Wiederherstellungsprobe bleiben offen; Details und Grenzen stehen im Umsetzungsstand.
Ergaenzung 2026-09-28: Neue Spesenfreigaben verlangen gueltige Schweizer
Zahlungsdaten und eine ausdrueckliche Bestaetigung des angezeigten Stands.
CT-Ausfall oder geaenderte Daten verhindern den Abschluss; Altfaelle bleiben offen.
Gruppen verwenden nun ebenfalls dauerhaft geschriebene neue Dateien, einen
transaktionalen Dateizeiger/Hash und eine gespeicherte Zeitstempelpflicht.
Gruppenstand und Quelldateien werden nach TSA-I/O erneut geprueft.
SIGKILL vor/nach Commit und der anschliessende Wiederanlauf sind getestet;
verwaiste Dateien und reale Stromausfallproben bleiben betriebliche Restpunkte.
Eingehende TSA-Antworten werden inzwischen auf Anfragebindung, Nonce,
Dokumenthash, Signatur und vollstaendige PDF-Abdeckung geprueft. Hinzu kommen
ESS-Bindung an das Signierzertifikat, Zeitstempel-EKU und Gueltigkeitszeitraeume.
Kettenvalidierung zu einem lokal freigegebenen Root-CA-Buendel ist implementiert;
fehlende Vertrauensanker sperren neue TSA-Zeitstempel. Konkrete DigiCert-Zuordnung,
CRL-Betriebsabnahme und historische Validierung bleiben offen. Neue Zeitstempel
verlangen nun aktuelle, lokal bereitgestellte und direkt signierte vollstaendige
Sperrlisten fuer alle Nicht-Root-Zertifikate; fehlende Evidenz blockiert.
Neue Backups sind inzwischen AES-256-GCM-verschluesselt; Restore prueft die
authentifizierte Huelle vor dem ZIP. Separater Schluesselbund, n8n-Formatwechsel
und Abnahme sind erforderlich. Unabhaengiger Herkunftsnachweis gegen kompromittierte
Schluesselinhaber, externe unveraenderliche Ablage und Altsicherungs-Migration bleiben offen.

## Ziel und Vorgehen

Jedes Arbeitspaket liefert Implementierung, Migration soweit erforderlich,
Regressionstests und aktualisierte Betriebs-/Fachdokumentation gemeinsam.
Die unten genannten Test-IDs sind spezifizierte Abnahmefaelle, keine bereits
implementierten oder bestandenen Tests. Ausgangsbasis ist der im Review
ausgefuehrte Testlauf mit 1.238 bestandenen Tests.

Kleine, separat pruefbare Aenderungspakete in dieser Reihenfolge umsetzen:

| Paket | Inhalt | Befunde | Abhaengigkeit |
| --- | --- | --- | --- |
| A | Abhaengigkeiten und sofortige Zugriffsbeschraenkungen | F01, F02, F06 | keine |
| B | Audit-Ereignisse und kontrollierte Sync-Eingriffe | F02, F07 | A |
| C | Freigabe-Snapshot, sichere Finalisierung, finale Hashes | F04, F05, F08 | B |
| D | Vertrauenswuerdige Zeitstempel- und Gruppenpruefung | F03, F09 | C fuer Dokumentversionen |
| E | Validierter Restore und getrennte Backup-Zugriffe | F06, F10, F11 | B; C fuer Dateimanifest |
| F | Versionierter Export und nachvollziehbare Archivquittung | F12 | C, D, B |
| G | Betrieb, Migration, Dokumentation und Gesamtabnahme | alle | A-F |

E kann nach dem gemeinsamen Schema aus C unabhaengig von D/F umgesetzt werden.
Keine Anwendung bestehender Datenmigrationen auf die Produktion im Rahmen
der Entwicklung. Migrationen zuerst an synthetischen Altstaenden und einer
geschuetzten Staging-Kopie pruefen.

## A. Sofortige Risikoreduktion

### Aenderungen

- Betroffene produktive Abhaengigkeiten samt transitiven Paketen auf zum
  Umsetzungszeitpunkt gepruefte, korrigierte Versionen aktualisieren. Lockfile
  mitfuehren; Installation und CI ueber `npm ci` reproduzierbar machen.
- Schreibende Sync-Routen vorlaeufig auf Superadmins beschraenken. GET bleibt
  mit `sync_einsehen` erreichbar. Endgueltige Rechte folgen in B.
- Live-Restore vorlaeufig deaktivieren, solange er die aktive DB-Verbindung
  nicht kontrolliert schliessen kann. Backup-Erstellung/Download bleiben
  nutzbar. Wartungswiederherstellung als Betriebsschritt dokumentieren.
- Vorlaeufig keine pauschale Aussage einer vertrauenswuerdigen Zeitquelle in
  Pruefbescheinigungen; fehlende Vertrauenspruefung sichtbar benennen.

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| A01 | Installation aus Lockfile, volle Suite, Dependency-Scan | Reproduzierbare Installation; relevante bekannte Luecken behoben. Verbleibende Meldungen einzeln bewertet, nicht pauschal ignoriert. |
| A02 | Manipulierte Multipart-Feldnamen, abgebrochener Upload, uebergrosse Datei | Kontrollierte Ablehnung; keine DB-/Dateiaenderung; Prozess beantwortet danach einen normalen Request. |
| A03 | ZIP mit ueberhoehter deklarierter Entpackgroesse | Kontrollierte Ablehnung innerhalb begrenzter Ressourcen. |
| A04 | Sync-POST als anonyme, inaktive, nur leseberechtigte Person und Manager | 401/403; keine Zustandsaenderung. Superadmin wird anschliessend fachlich validiert. |
| A05 | Live-Restore waehrend normalem App-Betrieb | Kein DB-/Dateiaustausch moeglich; verstaendliche Wartungsmeldung. |

Orte: bestehende `test/integration/admin/sync.test.js`,
`test/integration/admin/backup.test.js`, `test/integration/csrfSweep.test.js`;
neu bei Bedarf `test/integration/uploadRobustheit.test.js`.
Prozessabsturz-/Speicherproben in separaten Kindprozessen mit Zeit- und
Speichergrenzen ausfuehren, niemals gegen eine laufende Produktivinstanz.

## B. Audit-Ereignisse und Sync-Rechte

### Aenderungen

- Explizite Rechte `sync_verwalten` fuer Konfiguration und
  `workflow_eingreifen` fuer Force-Aktionen einfuehren. `sync_einsehen` bleibt
  rein lesend. Neue Rechte nicht automatisch an alle Manager vergeben:
  Rollen-Bundles explizit auflisten. Bestehende sonstige Managerrechte erhalten.
- Rechtekatalog, DB-CHECK, Migration, Personenverwaltung und Navigation
  gemeinsam aktualisieren. Vorhandene Leser erhalten keine neuen Schreibrechte.
- Force-Aktion verlangt Begruendung; prueft Blockadegrund, aktiven Status und
  Jobversion unmittelbar in der Transaktion erneut. Bereits bearbeiteter oder
  nicht blockierter Job liefert 409; unbekannte ID liefert 404.
- Gemeinsame Tabelle `audit_ereignisse` und Repo einfuehren: Ereignis-ID,
  UTC-Zeit, Akteurtyp/-ID, Aktion, Objekt/-Version, Grund, Request-Korrelation
  sowie redigierte Vorher-/Nachher-Werte. Namen/Bezeichnungen bei Bedarf als
  historische Werte speichern. Keine Tokens, Passwoerter oder Sessioncookies.
- Kritische Aenderung und Ereignis in derselben Transaktion speichern.
  Bestehende Repo-Transaktionen entsprechend koordinieren, keine verschachtelten
  `BEGIN` erzeugen. Fehler beim Audit-Insert verhindern den Eingriff.
- Ereigniskatalog mindestens: Rechte, Kontenrollen, Lieferanten-IBANs,
  Zuweisungsregeln, Vertretungen, Force-Aktionen, TSA-/Sicherheitskonfiguration,
  Backup-Loeschung/Restore, Finalisierung, Export und Archivierung.
- Bestehende Freigaben-/Loeschhistorie weiterhin anzeigen; historische
  unbekannte Werte nicht nachtraeglich aus aktuellen Stammdaten erfinden.
- Externen, separat berechtigten Audit-Export ueber eine persistente Queue
  vorbereiten. Lokale DB-Trigger sind kein Schutz vor DB-Administratoren.

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| B01 | Matrix aus Leser, Verwalter, Eingriffsrecht, Manager, Superadmin | Nur explizit erlaubte Operationen; GET-Recht allein erlaubt keine POST-Aktion. |
| B02 | Aktiver zustaendiger Freigeber, manipulierte Job-ID im Force-POST | 409; Job und Historie unveraendert. |
| B03 | Wirklich blockierter Job in zugewiesen/abgelehnt/freigabe2 | Nur erlaubter Uebergang; genau ein Ereignis mit Akteur, Grund, alten/neuen Werten. Spesen gesondert pruefen. |
| B04 | Leere Begruendung, fehlendes CSRF, Rechteentzug, parallele Force-Requests | Ablehnung bzw. nur ein erfolgreicher Zustandswechsel. |
| B05 | Audit-Insert gezielt fehlschlagen lassen | Fachliche Aenderung vollstaendig zurueckgerollt. |
| B06 | Rollen-/IBAN-/TSA-Aenderung und spaetere Umbenennung | Ereignis vollstaendig, geheimnisfrei und historisch unveraendert. |
| B07 | Audit-Ziel nicht erreichbar; anschliessender Wiederanlauf | Ereignisse bleiben in Queue, Alarm bei Rueckstand, deduplizierter Export ohne Luecke. |
| B08 | Migration alter Rechte und Ereignisse, zweimaliger App-Start | Keine Rechteausweitung, keine doppelten Ereignisse, lesbare Althistorie. |

Orte: bestehende Tests fuer Permissions, Personenverwaltung, Sync und globales
Audit-Log; neu `test/unit/auditEreignisseRepo.test.js` und
`test/integration/auditAenderungen.test.js`.

## C. Freigabe-Snapshot und sichere Dokumentfinalisierung

### Aenderungen

- Pro Freigabeversion einen unveraenderlichen Snapshot speichern: Rechnung,
  Betrag/Waehrung, echtes Rechnungsdatum, Zahlungsziel, Kontonummer/-bezeichnung,
  Zahlungsdaten, Beteiligte und Freigabeereignisse; bei Gruppen je Position.
- PDF und Export ausschliesslich aus dieser Version erzeugen. Fuer Spesen
  Zahlungsdaten vor der endgueltigen Bestaetigung sichtbar bereitstellen und
  diese Version bestaetigen lassen. Aenderung oder fehlende Pflichtdaten
  erfordert erneute Vorlage; CT-Ausfall darf keinen scheinbar vollstaendigen
  Zahlungsexport erzeugen. Kein spaeterer Live-Fallback beim Export.
- Rechnungsdatum als eigenes Feld erfassen; Zahlungsziel ist kein Ersatz.
- Fachliche Entscheidung und Dokumentbereitstellung unterscheiden: dauerhaften
  Finalisierungsauftrag mit Snapshot und eindeutiger Version in derselben
  Transaktion wie die zweite Freigabe speichern. Export bleibt gesperrt.
- Freigabeberechtigung, Vier-Augen-Regel und Jobversion nach asynchronen
  Arbeitsschritten erneut pruefen. Doppelte Requests duerfen nur einen Auftrag
  erzeugen. Keine DB-Transaktion ueber Netzwerk-/PDF-Arbeit offen halten.
- Finales Dokument unter neuem versionsbezogenem Pfad schreiben; Datei und
  Verzeichnis nach dokumentierten Plattformgarantien persistieren. Existenz,
  Lesbarkeit, erwartete Seiten und SHA-256 kontrollieren; erst danach DB-Verweis
  und Bereitschaft transaktional veroeffentlichen. Original nicht ueberschreiben.
- Nachholen arbeitet mit dem gespeicherten Auftrag und erzeugt auch fehlende
  Freigabeseiten. Ein TSA-Ausfall hinterlaesst einen sichtbaren offenen Zustand.
  Pro Version speichern, ob ein vertrauenswuerdiger Zeitstempel erforderlich ist;
  spaeteres Abschalten der TSA darf diese Anforderung nicht umgehen.
- Finalen Dateihash immer speichern, auch ohne TSA. Endgueltige Hashwerte duerfen
  weder durch andere Werte noch durch NULL ersetzt werden. Erneuerung des
  Zeitstempels oder Korrektur erzeugt eine neue verknuepfte Dokumentversion.
- Abbruch hinterlaesst hoechstens nicht referenzierte Dateien, keine exportierbare
  falsche Version. Bereinigung solcher Dateien erst nach Ablauf aktiver Auftraege.

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| C01 | Kontonummer, Name und CT-IBAN nach Freigabe aendern | PDF und Export behalten exakt denselben freigegebenen Snapshot. |
| C02 | CT-Ausfall/fehlende IBAN bzw. Aenderung seit Formularanzeige | Keine unbeabsichtigte Freigabe neuer Zahlungsdaten; nachvollziehbarer offener Zustand. |
| C03 | Datei schreiben, final ablegen, DB-Commit jeweils gezielt fehlschlagen lassen | Export nie bereit, solange referenziertes Artefakt nicht korrekt vorliegt. |
| C04 | Prozess nach Auftrag, nach Dateischreiben und vor/nach DB-Verweis hart beenden | Neustart setzt korrekt fort; genau eine wirksame Freigabeversion, Hash stimmt mit Dateibytes ueberein. |
| C05 | Zwei Freigaben gleichzeitig; parallel Ablehnung, Rollenwechsel oder Rueckgabe | Nur gueltiger Versionswechsel gewinnt; veraltete Aktion 409/403; kein Ueberschreiben. |
| C06 | TSA faellt aus, spaeter Nachholung | Freigabeseite vorhanden, kein doppelter Stempel, richtige Version wird nachgeholt. |
| C07 | TSA nach Freigabe mit TSA-Pflicht abschalten | Offene Version wird nicht ploetzlich exportierbar. |
| C08 | Finalen Einzel-/Gruppenhash direkt oder ueber NULL aendern | Beides abgewiesen; neue Dokumentversion ist der erlaubte Korrekturpfad. |
| C09 | Anhang in Freigabe 1 und anschliessende Freigabe 2/Gruppe | Snapshot, Seitenbestand und Export enthalten den bestaetigten Anhang auch unter Konkurrenz. |
| C10 | Rechnungsdatum ungleich Zahlungsziel | Beide Werte bleiben in Einzel-/Gruppenexport unterscheidbar erhalten. |

Orte: `test/integration/freigabe2.test.js`, `freigabeWorkflowEndToEnd.test.js`,
`spesenWorkflowEndToEnd.test.js`, `splitgruppen-e2e.test.js`,
`test/integration/n8n/jobs.test.js`, `test/unit/jobsRepo.test.js`;
neu `test/integration/finalisierungRecovery.test.js`.

Bestehende Erwartungen ausdruecklich ersetzen: abgeschlossener/exportierbarer
Job nach Rename-Fehler, erlaubtes Zuruecksetzen finaler Hashes, Live-IBAN beim
Export und Zahlungsziel als Rechnungsdatum. Die jeweiligen Testfaelle behalten,
aber die neue fachliche Garantie pruefen.

## D. Zeitstempelvertrauen und richtige Dokumentauswahl

### Aenderungen

- Ergebnis aufteilen in Signatur, vertrauenswuerdige Kette/Policy, Zertifikats-
  und Sperrstatus zur relevanten Zeit, Abdeckung der aktuellen PDF-Version und
  Job-Hashabgleich. Unbekannt oder nicht pruefbar ist kein positives Ergebnis.
- Explizite Truststore-Konfiguration mit versionierten, ausserhalb des normalen
  Benutzerzugriffs gepflegten Vertrauensankern. Produktions-TSA und Policy sind
  vom Betreiber zu benennen; Test-TSA ist nur fuer Fixtures vertrauenswuerdig.
- Bibliotheksfaehigkeiten vor Umsetzung gegen die benoetigten Garantien pruefen;
  etablierte Validierung verwenden, keine eigene ASN.1-/PKI-Implementierung.
- ByteRange und PDF-Revisionen strukturell pruefen. Gueltige spaetere
  Archivzeitstempel differenziert behandeln; ein alter erster Zeitstempel reicht
  nicht fuer die Gesamtdatei. Unsignierte Aenderungen duerfen nicht gruen sein.
- Bereits beim Setzen TSA-Antwort, Dokumentbindung und notwendiges Vertrauen
  pruefen, bevor ein Dokument als zeitgestempelt bereit markiert wird.
- Gemeinsame Dokumentaufloesung fuer Download, Pruefung und Bescheinigung:
  Einzeljob oder Gruppenartefakt inklusive passendem Versionshash. Nach Abholung
  bleibt Upload gegen den gespeicherten finalen Gruppenhash moeglich.
- Externe Pruefanfragen fuer Sperrinformationen zeitlich begrenzen; Ziele aus
  hochgeladenen Zertifikaten nicht unkontrolliert abrufen (interne Netze sperren).

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| D01 | Gueltiger Test-TSA-Stempel mit passendem Truststore/Hash | Alle erwarteten Teilpruefungen positiv. |
| D02 | Gueltige Signatur unbekannter/selbstsignierter TSA oder falsche Policy | Signatur ggf. positiv, Vertrauen negativ; keine vollstaendig positive Bescheinigung. |
| D03 | Gesperrtes Zertifikat, fehlende/abgelaufene Sperrauskunft, gueltige historische Evidenz | Jeweils korrektes Ergebnis fuer den Pruefzeitpunkt; fehlende Evidenz als unbekannt. |
| D04 | Geaenderter PDF-Inhalt, angehaengte Bytes, inkrementell geaenderte sichtbare Rechnung | Keine Aussage vollstaendiger unveraenderter aktueller Datei. |
| D05 | Mehrere legitime Zeitstempel und spaetere unsignierte Revision | Richtige Abdeckung festgestellt; nicht blind erster/letzter Eintrag akzeptiert. |
| D06 | TSA liefert Token fuer anderes Dokument oder fehlerhafte Signatur | Artefakt nicht als erfolgreich zeitgestempelt veroeffentlicht. |
| D07 | Gruppe vor Abholung sowie Upload danach | Gruppen-PDF und Gruppenhash stimmen ueberein; Original-/Kind-PDF wird nicht verwechselt. |
| D08 | Fremde Job-/Gruppen-ID, fehlender Hash oder fehlende lokale Datei | Zugriffsschutz bleibt erhalten; unbekannter Vergleich wird nicht als Erfolg dargestellt. |
| D09 | Sperrdienst nicht erreichbar oder URL zeigt auf internes Netz | Begrenzte Laufzeit, kein interner Abruf, sichtbares unbekanntes Pruefergebnis. |

Orte: bestehende Unit-/Integrationstests fuer Zeitstempel, Downloads und
Splitgruppen. Kryptografische Fixtures reproduzierbar mit Test-CA und festem
Pruefzeitpunkt erstellen; gespeicherte TSA-Antworten fuer fremde Message-Imprints
nicht als positives Ende-zu-Ende-Ergebnis verwenden. Keine externen Dienste in CI.

## E. Backup und kontrollierter Restore

### Aenderungen

- Backup-Key vom Rechnungseingangs-/Export-Key trennen; keine implizite
  Rueckfallauthentifizierung mit dem alten gemeinsamen Key.
- Backupformat versionieren: Dateimanifest mit relativen Pfaden, Groessen,
  SHA-256 und Versionsreferenzen; konsistenter Snapshot von DB und referenzierten
  Dokumenten. Bereinigung darf diese Dokumente waehrend des Backups nicht entfernen.
- Authentisierte Verschluesselung ueber etabliertes Verfahren; Schluessel ausserhalb
  der DB/des Archivs, Schluessel-ID fuer Rotation. Klartextaltbackups nur ueber
  expliziten Migrationsweg behandeln. Temporaere Klartexte restriktiv berechtigen.
- Restore in Staging pruefen: Format, Tabellen/Spalten, `integrity_check`,
  `foreign_key_check`, Migrationen, Dateipfade, Hashes, entpackte Groesse,
  Dateianzahl. Traversal, absolute Pfade, Symlinks und doppelte Eintraege ablehnen.
- Bereits ordnungsgemaess archivierte/entfernte Dokumente anhand ihres Status
  unterscheiden; deren legitimes Fehlen darf einen Restore nicht unmoeglich machen.
- Restore als Wartungsvorgang: persistente Wartungssperre, neue Requests/Jobs
  sperren, laufende Arbeit abwarten, Scheduler stoppen, DB schliessen. Kein
  Austausch mehr innerhalb eines weiterlaufenden normalen Request-Handlers.
- Neue DB/Dateigeneration vollstaendig vorbereiten, kontrolliert aktivieren,
  neu starten und pruefen. Abbruchmarker und Rueckkehr zum alten Stand vorsehen;
  auch nach Prozessabbruch darf keine gemischte Generation bedient werden.
- Sessions beim Restore verwerfen. Restore-Ereignis mit Quellhash, Akteur,
  Zeitpunkt und vorherigem Stand auch ausserhalb der zurueckgesetzten DB sichern.
- Erst nach automatischer Start-/Integritaetskontrolle Wartungssperre entfernen.

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| E01 | Job-Key auf Backup-Endpunkt, Backup-Key auf Job-/Cron-Endpunkt | Jeweils 401; nur richtige Kombination erlaubt. |
| E02 | Falscher Schluessel, geaendertes Ciphertext/Manifest, alte Schluessel-ID | Manipulation abgewiesen; vorgesehene Schluesselrotation funktioniert. |
| E03 | Defekte DB, fehlende Spalten/FKs, fehlende erforderliche PDF, falscher Hash | Restore vor Live-Aenderung abgelehnt; alter Stand unveraendert. |
| E04 | Zip-Traversal, Symlink, doppelte Namen, ZIP-Bombe | Abgewiesen ohne Schreiben ausserhalb Staging oder unkontrollierten Ressourcenverbrauch. |
| E05 | Restore in andere Verzeichnisse | Reale Downloads und Hashpruefungen funktionieren ueber neue DB-Verweise. |
| E06 | Aktive Freigabe, TSA-Anfrage, Cron und Download beim Restore | Wartung verhindert neue Arbeit; laufende Arbeit kontrolliert beendet; kein Mischbetrieb. |
| E07 | Kopier-/Plattenfehler und harter Prozessabbruch in jeder Umschaltphase | Alter konsistenter Stand oder neuer gepruefter Stand; sonst Wartung, niemals Mischbetrieb. |
| E08 | Abgemeldetes bzw. noch aktives Cookie aus Backup nach Restore | Nicht mehr angemeldet; frischer Login erforderlich. |
| E09 | Backup gleichzeitig mit Finalisierung und PDF-Bereinigung | Jeder erforderliche referenzierte Dateihash im Snapshot aufloesbar. |
| E10 | Mehrfacher Restore alter Backups | Restore-Historie extern nachvollziehbar; kein stilles Zuruecksetzen des Nachweises. |

Orte: bestehende Backup-, Session-, Scheduler- und n8n-Backup-Tests;
neu `test/integration/restoreRecovery.test.js` mit echten temporaeren DB-Dateien
und Kindprozessen. Keine ausschliesslich gemockte Wiederherstellungsabnahme.

## F. Export und Archivierungsnachweis

### Aenderungen

- Exportvertrag versionieren: Job-/Gruppen-ID, Dokumentversion, finaler SHA-256,
  Freigabe-Snapshot und eindeutige Export-ID. Download-URL an Dokumentversion
  binden; keine andere PDF als Fallback unter derselben Export-ID liefern.
- n8n archiviert zuerst und bestaetigt anschliessend Export-ID, Version,
  Dokumenthash und externe Archiv-ID. Portal vergleicht sie mit dem Auftrag.
- Wiederholte identische Bestaetigung ist erfolgreich und wirkungslos;
  widerspruechliche/veraltete Bestaetigung liefert 409. Ergebnis protokollieren.
- Bestaetigung loescht nicht sofort. Loeschfreigabe erst nach festgelegter
  Wiederherstellungsfrist und bestaetigtem Archivierungszustand. Fehler beim
  Loeschen separat nachholen, Quittung behalten.
- Periodischen Abgleich mit dem Zielarchiv spezifizieren. Ein von n8n gemeldeter
  Hash allein beweist noch keine dauerhafte Speicherung; reale Archivabfrage
  bzw. archivseitige Quittung ist Teil der externen Abnahme.
- Alten n8n-Vertrag koordiniert abloesen. Alter Client darf nach Umstellung
  keine unbestaetigte Loeschung ausloesen. Rueckstau ist einem Belegverlust
  vorzuziehen und muss alarmiert werden.

### Tests

| ID | Testfall | Erwartung |
| --- | --- | --- |
| F01 | Gueltiger Einzel-/Gruppenexport mit Quittung | Exakt angebotene Bytes/Snapshot archiviert; Quittung nachvollziehbar. |
| F02 | Fehlende Archiv-ID, falscher Hash oder veraltete Version | 400/409; keine Loeschung und kein bestaetigter Archivierungszustand. |
| F03 | Gleiches ACK mehrfach, parallele ACKs, abweichendes zweites ACK | Ein wirksamer Vorgang; identisch erfolgreich, abweichend 409. |
| F04 | Download erfolgreich, Archivierung fehlgeschlagen oder ACK verloren | Wiederholung moeglich; keine verlorene Datei oder doppelte fachliche Buchung. |
| F05 | Aufbewahrungsfrist vor/nach Grenzzeit; Loeschfehler | Vorher keine Loeschung, danach kontrollierte idempotente Bereinigung. |
| F06 | Alte Download-URL nach neuer Dokumentversion | Alte autorisierte Version oder Ablehnung; niemals stillschweigend neue/falsche Bytes. |
| F07 | Zielarchiv meldet Dokument fehlend oder anderen Hash | Alarm und Loeschsperre; Wiederherstellungsprozess ausgeloest. |

Orte: `test/integration/n8n/jobs.test.js`, `downloads.test.js`,
`splitgruppen-e2e.test.js`, `test/unit/cronJobs.test.js`;
zusaetzlich Contract-Tests mit simuliertem Archiv und Staging-Abnahme mit n8n.
Bestehende Tests fuer sofortiges Loeschen und 409 bei identischem Wiederholungs-ACK
auf den neuen Vertrag umstellen.

## G. Migration, Betrieb und Gesamtabnahme

### Datenmigration und Rollout

1. Bestehende Belege inventarisieren: offene, fertige, zeitgestempelte,
   abgeholte, archivierte und Splitgruppen; Dateien/Hashes abgleichen.
2. Additive Schemaaenderungen zuerst ausrollen. Historische Werte aus
   nachweisbaren Artefakten uebernehmen; fehlende Daten als unbekannt markieren.
   Aktuelle CT-/Kontodaten nicht als historische Freigabedaten ausgeben.
3. Noch nicht exportierte Altdaten ohne belastbaren Snapshot in eine
   Nachpruefung stellen. Bereits archivierte Daten bleiben lesbar, mit
   kenntlich gemachtem Nachweisumfang. Auditbefunde nicht durch Backfill verdecken.
4. Strengere Hash-Trigger erst mit der neuen Finalisierung aktivieren; vorher
   vorhandene Hash-/Dateiabweichungen klaeren. Migration wiederholbar testen.
5. Backup-Key und n8n-Vertrag in Staging gemeinsam umstellen, dann koordiniert
   produktiv aktivieren. Kompatibilitaetsfenster konkret dokumentieren.
6. Rollback vorab testen: kompatible App-Version verwenden oder gesamten
   konsistenten Stand wiederherstellen. Keine destruktive Schema-Rueckmigration
   bei zwischenzeitlich neu entstandenen Freigaben.

### Weitere Abnahmetests

| ID | Pruefung | Kriterium |
| --- | --- | --- |
| G01 | Upgrade aus mehreren alten Schema-/Datenstaenden, zweimaliger Start | Kein Verlust von Historie, Rollen oder Dokumentreferenzen. |
| G02 | Ende zu Ende: Eingang, Kontierung, Ablehnung/Korrektur, zwei Freigaben, TSA, Export, Restore, Pruefung | Durchgaengig gleiche Version/Hashes und lueckenlos zuordenbare Ereignisse. |
| G03 | Spesen-Selbstfreigabe, Vertretung, Eskalation, Rollenwechsel | Vier-Augen-Prinzip und Job-Autorisierung auch nach Umbauten erhalten. |
| G04 | HTTP-Produktionskonfiguration, fehlendes STARTTLS, gefaelschte Forwarded-Header | Unsichere Konfiguration abgewiesen bzw. Zugriff am echten Proxy begrenzt; Testumgebung explizit getrennt. |
| G05 | Austritt/Rechteentzug in ChurchTools | Zugriff innerhalb der festgelegten Frist beendet; zugehoeriger Sync-Ausfall alarmiert. |
| G06 | TSA/SMTP/Archiv/Backupziel ausgefallen, Disk voll, Dokument fehlt | Sichtbarer Rueckstau und externer Alarm; Health-/Readiness-Signale nicht irrefuehrend. |
| G07 | Grosse/komplexe PDFs und Uploadlast auf Staging | Vereinbarte Speicher-/Laufzeitgrenzen eingehalten; andere Requests bleiben bedienbar. |
| G08 | Unveraenderliches Audit-/Archivziel: Aendern/Loeschen mit App-Zugang versuchen | Betreiberseitige Zugriffstrennung und Aufbewahrung nachweisbar wirksam. |

CI: bestehendes `node:test` und Supertest beibehalten. Pro Paket gezielte Tests,
danach einmal volle Suite; Fehler- und Migrationsproben in separatem Job.
Netzwerk-Fixtures statt Live-TSA/ChurchTools in CI. Uhren und Synchronisations-
barrieren injizieren statt zufaelliger Sleeps. Sicherheitstests ueber `createApp`
mit echter Session-/CSRF-/Rechte-Middleware ausfuehren, nicht nur isolierte Router.
CI-Provider an das tatsaechliche Repository-Hosting anpassen.

Vor Produktivabnahme vom Betreiber festzulegen: TSA-Vertrauensanker/Policy,
Aufbewahrungs- und Wiederherstellungsfristen, RPO/RTO, Rechteentzugsfrist,
Audit-/Archivziel, n8n-Verantwortung und Alarmempfaenger. Diese Werte sind
externe Abnahmekriterien; dafuer werden keine ungeprueften Garantien angenommen.

Dokumentation je Paket nachziehen: Rechte-Matrix, Datenmodell, Workflow,
Zeitstempelbescheinigung, Backup-/Restore-Runbook und n8n-Vertrag. Managerrechte,
acht Hintergrundjobs und echtes Rechnungsdatum berichtigen. Vendorte Assets
mit Version/Herkunft und Updateverantwortung inventarisieren.

Ein Befund gilt erst als geschlossen, wenn Implementierung und relevanter
Negativtest vorliegen, Migration erprobt ist, Dokumentation stimmt und bei
externen Kontrollen ein Staging-Nachweis existiert. Gruene lokale Tests allein
schliessen keine Betreiber-/Archivierungsanforderung ab.
