# Backup-Sicherheitsstand

Stand: 2026-09-28. Die folgenden Pruefungen sind implementiert.
Der [Offline-Restore](offline-restore.md) bereitet einen neuen Datenstand vor und
schaltet ihn erst nach Validierung atomar aktiv. Prozesssperre, Pfadumsetzung,
Rueckwechsel und Abbruchtests sind implementiert; die Betriebsabnahme bleibt offen.
HTTP-Live-Restore bleibt mit 423 gesperrt. Die alte `restoreBackupArchive`-Funktion
wirft auch bei direktem Aufruf einen Fehler.

## Format 2

Neue `.fpbak`-Backups haben eine AES-256-GCM-Huelle (`FPBACK01`). Erstellung,
CLI-Pruefung und Restore verlangen `BACKUP_KEYRING_FILE`; ohne Schluessel kein
Klartext-Fallback. [Installation, Rotation und Grenzen](backup-verschluesselung.md).
Das innere Format-2-ZIP enthaelt `db.sqlite`, Dateien unter `jobs/` und `branding/`
sowie `manifest.json`. Das Manifest nennt:

- `formatVersion: 2` und `erstelltAm`;
- `dateiAnzahlJobs` und `dateiAnzahlBranding` als Ganzzahlen;
- `dateien`: vollstaendige Liste `{pfad, groesse, sha256}` fuer jede Datei ausser dem Manifest;
- `quellpfade`: absolute Jobs-/Branding-Verzeichnisse und Arbeitsverzeichnis der Sicherung.

Beim Pruefen muessen alle deklarierten Dateien vorhanden sein; zusaetzliche
Dateien, falsche Groessen, falsche Hashes oder abweichende Dateianzahlen fuehren
zur Ablehnung. Fehlende/alte/kuenftige oder als Text statt Zahl angegebene
Formatversionen werden nicht stillschweigend akzeptiert.

**Alte Klartext-ZIPs (Format 1 und 2) aufbewahren.** Sie sind nicht automatisch als sicherer
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

SHA-256 im selben ZIP erkennt Inkonsistenzen, aber beweist nicht die Herkunft.
Die neue GCM-Huelle verhindert Manipulation durch Angreifer ohne Schluessel.
Ein unabhaengiger Herkunftsnachweis gegen kompromittierte Schluesselinhaber
und geschuetzte externe Aufbewahrung stehen weiterhin aus.

Neue Backup-Dateien werden mit Modus 0600 verschluesselt und erst nach Datei-fsync
atomar veroeffentlicht. Das entschluesselte ZIP enthaelt weiterhin vertrauliche
Konfiguration; der SQLite-Snapshot liegt temporaer unverschluesselt auf dem Host.
Nur der getrennte `BACKUP_API_KEY` darf den n8n-Download abrufen. Dieser liefert
ausschliesslich neue `.fpbak`-Dateien; bestehende Klartext-ZIPs werden weder
automatisch umgeschrieben noch durch Retention geloescht.

Eine erfolgreiche Validierung ist **keine** Freigabe fuer einen Live-Restore.
Prozesssperre und Generationswechsel gelten fuer den aktualisierten Server und
das Wartungs-CLI. Direkte DB-Schreiber und alte Serverversionen muessen manuell
gestoppt werden. Eine reale Wiederherstellungsprobe auf dem Zielsystem fehlt noch.
