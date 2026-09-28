# Audit-Behebung: Umsetzungsstand

Stand: 2026-09-27. Keine Audit-Freigabe; die Umsetzung ist noch nicht abgeschlossen.
Die Test-IDs im Behebungsplan sind Abnahmeanforderungen, keine Erfolgsmeldungen.

## Bereits umgesetzt

- Abhaengigkeiten aktualisiert; `npm audit --json` meldet null bekannte Schwachstellen.
- `sync_einsehen` erlaubt nur Lesen. Konfiguration braucht `sync_verwalten`,
  Force-Aktionen brauchen `workflow_eingreifen`. Manager erhalten diese beiden
  Rechte nicht automatisch. Zusaetzlich bleibt das Leserecht fuer den Bereich erforderlich.
- Force-Aktionen brauchen eine Begruendung und pruefen den blockierten Zustand
  in der Transaktion erneut. Konfiguration und Audit werden gemeinsam gespeichert.
- Automatische, transaktionale Aenderungsprotokolle fuer Rechte, Personen, Konten,
  Debitoren/IBANs, Regeln, Konfiguration, Jobs und Freigaben. Lokale UPDATE-/DELETE-Sperre;
  TSA-Passwoerter werden redigiert. Historischer Akteurname wird gespeichert.
- Einzeljob-Finalisierung schreibt zuerst eine neue, synchronisierte PDF-Datei.
  Freigabe, Dateizeiger, Snapshot und Hash werden anschliessend gemeinsam committed.
  Nach asynchronen Aufrufen werden Job, Konto, Berechtigung und Quelldatei erneut geprueft.
  Auch der Zeitstempel-Nachholjob schreibt eine neue Datei statt die bestehende zu ersetzen.
- Konto und Spesen-Zahlungsdaten stammen beim Export aus dem Freigabe-Snapshot,
  nicht aus inzwischen geaenderten Stammdaten. Altfaelle ohne Snapshot liefern
  `nachweis_status: historisch_unvollstaendig`, Konto/Zahlungsdaten bleiben unbekannt.
- Einmal gesetzte Zeitstempel-Hashes, Zeitpunkte und Snapshots koennen auch nicht
  ueber NULL zurueckgesetzt werden. Pflicht zum Zeitstempel bleibt fuer neue Einzeljobs
  nach dem Abschalten der globalen TSA-Einstellung bestehen. Das gilt nun auch
  fuer Gruppen; eine einmal gespeicherte Pflicht kann nicht zurueckgesetzt werden.
- Gruppenfinalisierung: exklusive dauerhafte neue Datei, erneuter Vergleich von
  Gruppenstand, Freigaben und Quelldateien nach TSA-I/O, transaktionales Speichern
  von Dateizeiger und unveraenderlichem finalen Hash auch ohne TSA. Gespeicherte
  Teilbeleg-Hashes werden vor dem Zusammenfuehren geprueft.
- PDF-Pruefung verlangt vollstaendige ByteRange-Abdeckung. Gruppen verwenden Gruppen-PDF
  und Gruppenhash. Fehlende Zertifikatsvertrauenspruefung wird sichtbar ausgewiesen.
- Eingehende TSA-Antworten werden vor Speicherung an die konkrete Anfrage gebunden:
  Erfolgsstatus, Dokumenthash/Algorithmus, Nonce, TSTInfo und einzelner Unterzeichner.
  Die resultierende PDF muss eine gueltige Signatur mit ESS-Attribut und vollstaendige
  ByteRange-Abdeckung haben. Tests verwenden passend signierende lokale OpenSSL-TSA-Antworten.
  Neue Antworten verlangen ausserdem eine passende ESS-Bindung an das eindeutig
  bestimmte Signierzertifikat, kritische exklusive Zeitstempel-EKU und Gueltigkeit
  zum behaupteten Zeitstempel- sowie lokalen Empfangszeitpunkt. Neue Zeitstempel
  verlangen nun auch eine PKI.js-Kettenpruefung zu einem separat konfigurierten,
  SHA-256-festgelegten Root-CA-Buendel. Ohne Buendel bleiben TSA-pflichtige Exporte
  gesperrt. Aktuelle lokal bereitgestellte, direkt signierte CRLs sind nun fuer
  alle Nicht-Root-Zertifikate verpflichtend. Fehlende/veraltete Listen und gesperrte
  Zertifikate blockieren. Reale DigiCert-Zuordnung und Betriebsabnahme bleiben offen.
  [Konfiguration und Grenzen](tsa-vertrauensanker.md).
- HTTP-Live-Restore ist mit 423 gesperrt. Backup-API verwendet ausschliesslich
  `BACKUP_API_KEY`; ohne diesen Wert bleibt sie geschlossen. Derselbe Wert wie
  `N8N_API_KEY` wird beim Start abgelehnt.
- Archivuebergabe: festgeschriebener Exportnachweis mit UUID/SHA-256 und
  hashgebundener Download, unveraenderliche Paperless-Quittung mit Dokument-/Task-ID,
  idempotente Bestaetigung. Legacy-ACK loescht nicht mehr. Die Bereinigung verlangt
  Quittung, sieben Tage Wartezeit und unveraenderte Dateien. Ausstehende Quittungen
  sind ueber eine paginierte API-Liste abfragbar. Details im
  [Archivvertrag](n8n-paperless-archivierung.md).
- Backup-Format 2: verbindliches Dateimanifest mit SHA-256/Groessen, Entpacklimits,
  Pfad-/Link-/Kollisionspruefung, SQLite-Integritaet/Fremdschluessel und Abgleich
  aktiver Dateireferenzen sowie finaler Beleg-Hashes. Sessions werden nur in der
  Sicherung entfernt und die Snapshot-DB verdichtet. Neue Sicherungsdateien haben Modus 0600.
  Format 1 wird nicht automatisch akzeptiert. Siehe [Backup-Sicherheitsstand](backup-sicherheit.md).
- Neue Backups werden in einer AES-256-GCM-Huelle mit authentifiziertem Header
  gespeichert und erst nach Datei-fsync atomar veroeffentlicht. Separater privater
  Schluesselbund ist Pflicht; Restore authentifiziert vor ZIP-Parsing/Extraktion.
  n8n liefert nur `.fpbak`, alte Klartext-ZIPs werden nicht automatisch geloescht
  oder importiert. [Schluesselverwaltung und Grenzen](backup-verschluesselung.md).
- Offline-Restore: separate Datenstaende, atomarer Aktivierungszeiger, gemeinsame
  Server-/Wartungssperre, Pfadumsetzung, Session-Invalidierung, Auditjournal und
  Rueckwechsel. Der alte Live-Restore-Service ist auch direkt gesperrt. Tests umfassen
  SIGKILL vor/nach Aktivierung sowie echten Serverstart/SIGTERM. [Betriebsablauf](offline-restore.md).

## Noch offen und abnahmerelevant

- DigiCert: konkrete TSA-URL, unabhaengig freigegebene Root-CAs und echte
  Betriebsabnahme einschliesslich CRL-Bereitstellung/Erneuerung; OCSP, Delta-/indirekte
  CRLs, persistierte Sperrevidenz, weitere Zertifikats-/ESS-Kettenbeschraenkungen
  und historische Langzeitvalidierung. Der konfigurierbare Truststore und die
  Kettenpruefung fuer neue Zeitstempel sind mit lokalen Test-CAs umgesetzt. Ein mathematisch
  gueltiger Zeitstempel allein bedeutet weiterhin nicht "vertrauenswuerdiger Dienst".
- Paperless-ngx: externe n8n-Umstellung und reale Upload-/Ruecklese-/Wiederanlaufprobe
  fehlen noch. Die technische Loeschsperre aus F12 ist umgesetzt. Die Quittung
  bleibt eine Aussage des authentifizierten n8n-Workflows, keine direkte Portal-Pruefung
  von Paperless. Mehrere Dokumentversionen je Job und mehrere Zielarchive sind nicht implementiert.
- Backup/Restore: unabhaengiger Herkunftsnachweis gegen kompromittierte
  Schluesselinhaber, externe unveraenderliche Aufbewahrung, Schluessel-Betriebsabnahme,
  Migration alter Klartext-ZIPs und reale Wiederherstellungs-/Stromausfallprobe
  auf dem Zielhost fehlen. Authentifizierte Verschluesselung ist umgesetzt. Die Sperre setzt
  kooperierende Prozesse voraus; Mehrhost-Betrieb und direkte DB-Schreiber sind nicht abgedeckt.
- Externer unveraenderlicher Audit-Export, Request-Korrelation und komplette
  Ereignisabdeckung (einschliesslich Backup-Loeschungen) fehlen noch.
- Vollstaendige Snapshot-Bindung aller Exportmetadaten, Zahlungsdaten-Bestaetigung
  fuer andere Belegarten als Spesen und abgesicherte Altfallmigration.
- Automatische Bereinigung verwaister finaler Dateien fehlt weiterhin. Ein SIGKILL
  vor dem Gruppen-Commit kann eine unreferenzierte Datei hinterlassen; Wiederanlauf
  und Commit-Grenze sind getestet, reale Stromausfall-/Zielhostproben stehen aus.
- Staging-Migration, Wiederherstellungsprobe, Last-/Absturztests und reale Betriebsabnahme.

## Betrieb: DigiCert, Paperless-ngx und n8n

Vom Betreiber bestaetigt: TSA DigiCert, Zielarchiv Paperless-ngx;
der Betreiber pflegt den n8n-Workflow selbst. Keine Zugangsdaten im Repository ablegen.

Bereits notwendige Umstellung: Der Backup-Workflow braucht ein eigenes Credential
fuer `BACKUP_API_KEY`. Job-Workflows behalten `N8N_API_KEY`.
Zusaetzlich BACKUP_KEYRING_FILE separat bereitstellen und sichern; n8n speichert
die neue `.fpbak`-Datei unveraendert, ohne Schluessel oder Entschluesselung.
Neue Einzeljobs exportieren gespeicherte Zahlungsdaten. Seit der Ergaenzung vom
2026-09-28 sperrt Freigabe 2 neue Spesen bei fehlender/ungueltiger Schweizer IBAN,
fehlendem Kontoinhaber oder CT-Ausfall. Eine ausdrueckliche Bestaetigung des
angezeigten Zahlungs-/Vorgangsstands ist erforderlich; Aenderungen verlangen
erneute Bestaetigung. Der Snapshot dokumentiert Person, Zeitpunkt und Stand.
Altfaelle muessen weiterhin vor Zahlungsfreigabe abgefangen werden;
nicht automatisch aus aktuellen Stammdaten auffuellen.

Implementierter Portal-Vertrag, extern noch umzustellen:

1. Exportmanifest und dessen hashgebundene PDF abholen; SHA-256 lokal vergleichen.
2. PDF an Paperless-ngx hochladen. Die Upload-Antwort mit Task-ID ist noch kein Archivnachweis.
3. Task bis zum erfolgreichen Abschluss verfolgen und Dokument-ID ermitteln.
4. Originaldokument wieder herunterladen, nicht die OCR-/Archivvariante; SHA-256 vergleichen.
5. Dokument-ID, Task-ID, Hash und Export-ID an `archivierung-bestaetigen` senden.
6. Bei Timeout/Fehler kontrolliert wiederholen; keine lokale Loeschung ohne bestaetigte Quittung.

Die konkreten Paperless-Endpunkte und Versionsparameter sind gegen die eingesetzte
Version zu testen. Ohne erfolgreiche Quittung bleiben lokale Dateien jetzt technisch gesperrt.

## Verifikation

Neue Regressionstests decken insbesondere NULL-Reset, Audit-Manipulation und
Rollback, Geheimnisredaktion, Gruppen-Dokumentauswahl, ungesicherte PDF-Anhaenge,
Sync-Rechte, Begruendungspflicht, nicht blockierte Jobs und getrennte Backup-Schluessel ab.
Weitere Tests pruefen Archivquittungen, identische/parallele Wiederholungen,
Gruppen-Rollback, Sieben-Tage-Grenze, Hashbindung, fehlende Quittungen,
ZIP-Pfadangriffe, deklarierte Entpackgroessen, Dateimanifeste, Fremdschluessel,
fehlende Belege und die Entfernung von Sessions aus Snapshot-Dateien.
Offline-Restore-Tests decken Prozesssperren, Pfadumsetzung, Rueckwechsel,
Session-Invalidierung, Fehler vor/nach Aktivierung, echte SIGKILL-Abbrueche
und echten Serverstart/SIGTERM auf einer Testgeneration ab.
Der Gesamtstand wird mit `npm test`, `npm audit --json` und `git diff --check` geprueft.
Zahlungsdaten-Tests pruefen fehlende/ungueltige IBANs, fehlende Kontoinhaber,
CT-Ausfall, nicht bestaetigte und manipulierte Formularstaende sowie Aenderungen
von Kontoinhaber und Betrag. Ablehnung/Eskalation bleiben erreichbar; der
Spesen-End-to-End-Test umfasst die ausdrueckliche Bestaetigung.
Gruppen-Tests pruefen die dauerhafte TSA-Pflicht, Export-/ACK-Sperren,
veraenderte Teilbelege, Betraege, Freigaben und TSA-Konfiguration waehrend I/O,
DB-Fehler mit Wiederholung sowie echte SIGKILL-Abbrueche vor/nach Commit.
Migration und Audit-Abdeckung des neuen Gruppenhashes sowie dessen Pruefung
im Backup sind ebenfalls abgedeckt.
TSA-Tests signieren konkrete Anfragen und verwerfen falsche/fehlende Nonces,
abweichende Hashes/Algorithmen, Warnstatus, manipulierte Signaturen und fremde
Antworten. Freigabe, Nachholjob und Gruppenfinalisierung behalten dabei die
Exportsperre. Zertifikatstests pruefen ESS-Hash/-Aussteller, Mehrdeutigkeiten,
kritische exklusive EKU und Gueltigkeit zum Empfangs-/Zeitstempelzeitpunkt.
Truststore-Tests pruefen Dateihash, PEM-Grenzen, Symlinks, Root-/Leaf-Trennung,
mehrstufige Ketten und die Bindung an den tatsaechlichen Unterzeichner. Ein
selbstsignierter Antwortgeber sowie fehlende/abgelaufene Zwischenzertifikate
werden abgewiesen. Der Freigabeweg ist mit Test-Vertrauensankern und ohne
konfigurierte Anker geprueft; reale DigiCert-Endpunkte wurden nicht kontaktiert.
CRL-Tests pruefen authentisch signierte Sperrungen von Signier- und
Zwischenzertifikaten, fehlende Ausstellerlisten, abgelaufene/zukuenftige Listen,
fehlendes nextUpdate, falsche Signaturen und gleichnamige fremde Aussteller.
Dateigrenzen, Symlinks, SHA-1, cRLSign, nicht unterstuetzte Erweiterungen und
die Exportsperre im Freigabeweg sind ebenfalls abgedeckt. CRL-Erneuerung und
DigiCert-Kompatibilitaet sind damit noch nicht betrieblich abgenommen.
Backup-Huellentests pruefen Roundtrip, zufaellige Nonces, Manipulation jedes
Envelope-Bytes, Abschneiden/Anhaengen, falsche/fehlende Schluessel und Rotation.
Unverschluesselte ZIPs werden abgelehnt; auch ein neu berechneter SHA-256 kann
die GCM-Pruefung nicht umgehen. Privater Schluesselbund, kollisionsfreie
Veroeffentlichung, CLI-Authentifizierung, Link-sichere Downloads und fehlender
Klartext-Fallback sind abgedeckt. Restore-/SIGKILL-Tests verwenden nun verschluesselte
Sicherungen. Reale Schluesselbereitstellung und Wiederherstellungsprobe bleiben offen.

Ergebnis am 2026-09-28: 1.378 Tests bestanden, null fehlgeschlagen;
Dependency-Scan: null bekannte Schwachstellen; Whitespace-Pruefung ohne Befund.
Ein erfolgreicher Testlauf ersetzt weder die noch offenen Anforderungen noch die Betriebsabnahme.
