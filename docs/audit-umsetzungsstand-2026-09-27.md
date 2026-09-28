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
  nach dem Abschalten der globalen TSA-Einstellung bestehen.
- PDF-Pruefung verlangt vollstaendige ByteRange-Abdeckung. Gruppen verwenden Gruppen-PDF
  und Gruppenhash. Fehlende Zertifikatsvertrauenspruefung wird sichtbar ausgewiesen.
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
  Sicherung entfernt und die Snapshot-DB verdichtet. Neue ZIP-Dateien haben Modus 0600.
  Format 1 wird nicht automatisch akzeptiert. Siehe [Backup-Sicherheitsstand](backup-sicherheit.md).
- Offline-Restore: separate Datenstaende, atomarer Aktivierungszeiger, gemeinsame
  Server-/Wartungssperre, Pfadumsetzung, Session-Invalidierung, Auditjournal und
  Rueckwechsel. Der alte Live-Restore-Service ist auch direkt gesperrt. Tests umfassen
  SIGKILL vor/nach Aktivierung sowie echten Serverstart/SIGTERM. [Betriebsablauf](offline-restore.md).

## Noch offen und abnahmerelevant

- DigiCert: konfigurierbarer, gepruefter Truststore, Vertrauensketten-/Sperrstatuspruefung,
  Pruefung eingehender TSA-Antworten und historische Langzeitvalidierung. Ein mathematisch
  gueltiger Zeitstempel bedeutet derzeit ausdruecklich nicht "vertrauenswuerdiger Dienst".
- Paperless-ngx: externe n8n-Umstellung und reale Upload-/Ruecklese-/Wiederanlaufprobe
  fehlen noch. Die technische Loeschsperre aus F12 ist umgesetzt. Die Quittung
  bleibt eine Aussage des authentifizierten n8n-Workflows, keine direkte Portal-Pruefung
  von Paperless. Mehrere Dokumentversionen je Job und mehrere Zielarchive sind nicht implementiert.
- Backup/Restore: authentifizierte Verschluesselung, Herkunftsnachweis und reale
  Wiederherstellungs-/Stromausfallprobe auf dem Zielhost fehlen. Die Sperre setzt
  kooperierende Prozesse voraus; Mehrhost-Betrieb und direkte DB-Schreiber sind nicht abgedeckt.
- Externer unveraenderlicher Audit-Export, Request-Korrelation und komplette
  Ereignisabdeckung (einschliesslich Backup-Loeschungen) fehlen noch.
- Vollstaendige Snapshot-Bindung aller Exportmetadaten, Bestaetigung von Zahlungsdaten
  vor Freigabe, Freigabe-Sperre bei fehlender Spesen-IBAN und abgesicherte Altfallmigration.
- Gruppenfinalisierung verwendet noch nicht dieselbe atomare Dateistrategie wie Einzeljobs.
  Crash-Wiederanlauf und Bereinigung verwaister finaler Dateien brauchen weitere Tests.
- Staging-Migration, Wiederherstellungsprobe, Last-/Absturztests und reale Betriebsabnahme.

## Betrieb: DigiCert, Paperless-ngx und n8n

Vom Betreiber bestaetigt: TSA DigiCert, Zielarchiv Paperless-ngx;
der Betreiber pflegt den n8n-Workflow selbst. Keine Zugangsdaten im Repository ablegen.

Bereits notwendige Umstellung: Der Backup-Workflow braucht ein eigenes Credential
fuer `BACKUP_API_KEY`. Job-Workflows behalten `N8N_API_KEY`.
Neue Einzeljobs exportieren gespeicherte Zahlungsdaten. Altfaelle und fehlende IBANs
muessen vor Zahlungsfreigabe abgefangen werden; nicht automatisch aus aktuellen Stammdaten auffuellen.

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
Ergebnis am 2026-09-27: 1.290 Tests bestanden, null fehlgeschlagen;
Dependency-Scan: null bekannte Schwachstellen; Whitespace-Pruefung ohne Befund.
Ein erfolgreicher Testlauf ersetzt weder die noch offenen Anforderungen noch die Betriebsabnahme.
