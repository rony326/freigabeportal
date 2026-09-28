# Backup-Sicherheitsstand

Stand: 2026-09-27. Die folgenden Pruefungen sind implementiert.
Der [Offline-Restore](offline-restore.md) bereitet einen neuen Datenstand vor und
schaltet ihn erst nach Validierung atomar aktiv. Prozesssperre, Pfadumsetzung,
Rueckwechsel und Abbruchtests sind implementiert; die Betriebsabnahme bleibt offen.
HTTP-Live-Restore bleibt mit 423 gesperrt. Die alte `restoreBackupArchive`-Funktion
wirft auch bei direktem Aufruf einen Fehler.

## Format 2

Neue Backups enthalten `db.sqlite`, Dateien unter `jobs/` und `branding/`
sowie `manifest.json`. Das Manifest nennt:

- `formatVersion: 2` und `erstelltAm`;
- `dateiAnzahlJobs` und `dateiAnzahlBranding` als Ganzzahlen;
- `dateien`: vollstaendige Liste `{pfad, groesse, sha256}` fuer jede Datei ausser dem Manifest;
- `quellpfade`: absolute Jobs-/Branding-Verzeichnisse und Arbeitsverzeichnis der Sicherung.

Beim Pruefen muessen alle deklarierten Dateien vorhanden sein; zusaetzliche
Dateien, falsche Groessen, falsche Hashes oder abweichende Dateianzahlen fuehren
zur Ablehnung. Fehlende/alte/kuenftige oder als Text statt Zahl angegebene
Formatversionen werden nicht stillschweigend akzeptiert.

**Format-1-Backups aufbewahren.** Sie sind nicht automatisch als sicherer
Restore-Eingang zugelassen. Ein gesonderter, getesteter Konvertierungsprozess
steht noch aus; nicht lediglich die Versionsnummer im JSON aendern.

## Schutzpruefungen

- Keine absoluten ZIP-Pfade, `..`, Backslashes, Laufwerkspraefixe, Steuerzeichen,
  leeren Pfadsegmente oder abschliessenden Punkte/Leerzeichen.
- Keine symbolischen Links oder Spezialdateien. Auch die Sicherungserstellung
  folgt keinen als Dateien eingebrachten Symlinks.
- Keine mehrfachen portablen Pfade (NFC, ohne Gross-/Kleinschreibungsunterscheidung)
  oder Datei-/Verzeichniskollisionen.
- Pruefung der deklarierten Groessen vor dem Entpacken sowie SHA-256/Laenge der echten Bytes.
- Snapshot-DB wird nur lesend mit `trusted_schema = OFF` geprueft:
  `integrity_check`, `foreign_key_check`, erforderliche Tabellen,
  aktive Beleg-/Logo-Dateireferenzen und gespeicherte finale PDF-Hashes.
- Historisch bereits abgeholte/archivierte/geloeschte Dateien duerfen fehlen.
  Das ist kein Nachweis ihrer Archivierung; vorhandene Pfade muessen weiterhin
  innerhalb der deklarierten Sicherungsverzeichnisse liegen.
- Aktive Sessions werden aus der Snapshot-Kopie sicher geloescht, danach wird
  SQLite verdichtet. Laufende Sessions der Live-DB bleiben unberuehrt.
  Der Validator lehnt Sicherungen mit Session-Zeilen ab.

## Ressourcenlimits

Aktuell feste Grenzen in `BACKUP_LIMITS`:

| Grenze | Wert |
| --- | --- |
| ZIP-Eingabe/-Ausgabe | 256 MiB |
| Einzeldatei entpackt | 128 MiB |
| Entpackte Gesamtgroesse | 512 MiB |
| ZIP-Eintraege inklusive Manifest | 10.000 |
| Manifest | 4 MiB |

Das sind Format-/Entpackgrenzen, keine Garantie fuer den gesamten RAM-Verbrauch
des Prozesses. Erstellung und Pruefung laufen noch synchron mit Puffern im Speicher.
Groessere Datenbestaende benoetigen einen separat getesteten Streaming-/Wartungsprozess;
die Limits nicht ungeprueft anheben. Ein Fehler wird als fehlgeschlagener Backup-Lauf
protokolliert; bestehende Sicherungen werden dadurch nicht ersetzt.

## Verbleibende Grenzen

SHA-256 im selben ZIP erkennt Inkonsistenzen, aber beweist nicht die Herkunft:
wer das gesamte Archiv austauschen kann, kann auch das Manifest neu berechnen.
Authentifizierte Verschluesselung bzw. ein unabhaengig geschuetzter Herkunftsnachweis
und geschuetzte externe Aufbewahrung stehen noch aus.

Neue Backup-Dateien werden exklusiv mit Modus 0600 angelegt. Trotzdem enthalten sie
weiterhin vertrauliche Konfiguration wie TSA-Zugangsdaten im Klartext.
Nur der getrennte `BACKUP_API_KEY` darf sie abrufen; Zugriff und externe Ablage sind
entsprechend zu beschraenken. Vorhandene Backups werden nicht automatisch umgeschrieben.

Eine erfolgreiche Validierung ist **keine** Freigabe fuer einen Live-Restore.
Prozesssperre und Generationswechsel gelten fuer den aktualisierten Server und
das Wartungs-CLI. Direkte DB-Schreiber und alte Serverversionen muessen manuell
gestoppt werden. Eine reale Wiederherstellungsprobe auf dem Zielsystem fehlt noch.
