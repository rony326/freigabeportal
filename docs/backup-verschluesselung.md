# Verschluesselte Backups

Stand: 2026-09-28. Neue Sicherungen werden als `.fpbak` mit AES-256-GCM
verschluesselt und authentifiziert. Ohne gueltigen Schluesselbund scheitert der
Backup-Lauf; es gibt keinen Klartext-Fallback. Der Serverstart bleibt moeglich.
Fehlgeschlagene Sicherungen deshalb im Betrieb aktiv ueberwachen.

## Schluesselbereitstellung

`BACKUP_KEYRING_FILE` bezeichnet eine separate JSON-Datei. Voraussetzungen:

- Regulare Datei, maximal 16 KiB, Modus 0600 oder 0400, keine Gruppen-/Fremdrechte.
- Keine Symlinks oder mehrfachen Hardlinks; ausserhalb von JOBS_DIR, BRANDING_DIR
  und BACKUP_DIR. Verzeichnis nur fuer berechtigte Betriebsverantwortliche zugaenglich.
- Portal muss lesen koennen; Schluessel nicht in Git, Jobdaten, Admin-Konfiguration,
  Logs, n8n-Credentials oder zusammen mit dem Backup ablegen.
- Separat gesicherte Offline-Kopie samt Schluessel-ID und Freigabe erforderlich.
  Schluesselverlust bedeutet Verlust der Wiederherstellbarkeit.

In einem bereits vorbereiteten geschuetzten Verzeichnis erzeugt dieser Befehl
eine neue Datei exklusiv, ohne den Schluessel auf der Konsole auszugeben:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify({version:1, activeKeyId:"backup-2026-09", keys:[{id:"backup-2026-09", keyHex:randomBytes(32).toString("hex")}]})+"\n", {flag:"wx", mode:0o600});' /etc/freigabeportal/backup-keys.json
```

Deployment-Konfiguration:

```dotenv
BACKUP_KEYRING_FILE=/etc/freigabeportal/backup-keys.json
```

Der Schluesselbund hat Version 1, `activeKeyId` und ein Array `keys` mit jeweils
`id` und `keyHex` (32 zufaellige Bytes als 64 kleine Hexzeichen). Maximal 16
eindeutige Schluessel; IDs bestehen aus 1-64 ASCII-Buchstaben, Ziffern, `_` oder `-`.
Keine Passwortableitung: ausschliesslich kryptographisch zufaellige Schluessel
verwenden, niemals API-Schluessel wiederverwenden.

## Format und Pruefung

Die binaere Huelle enthaelt `FPBACK01` (8 Bytes), die ID-Laenge (1 Byte), die
Schluessel-ID, einen zufaelligen 12-Byte-Nonce, das verschluesselte Format-2-ZIP
und einen 16-Byte-GCM-Tag. Der komplette Header ist Additional Authenticated Data.
Unbekannte Versionen, unbekannte IDs, Manipulation und fehlender Tag werden abgelehnt.
ZIP-Parsing und Restore-Staging beginnen erst nach erfolgreicher GCM-Pruefung.
Danach gelten weiterhin alle Manifest-/Datei-/SQLite-Pruefungen des inneren ZIPs.
Siehe [Node.js Crypto](https://nodejs.org/api/crypto.html#deciphersetauthtagbuffer-encoding).

Das ZIP-Limit bleibt 256 MiB, die Huelle addiert maximal 101 Bytes.
Erstellung, Verschluesselung und Pruefung laufen synchron im Speicher; Spitzenbedarf
und Laufzeit auf dem Zielhost testen. Der SQLite-Snapshot entsteht weiterhin
voruebergehend unverschluesselt in einem privaten temporaeren Verzeichnis.
Host-/Datentraegerverschluesselung und geschuetzter Temp-Speicher bleiben erforderlich.

Veroeffentlichung: private temporaere Datei, Datei-fsync, atomarer Hardlink auf
den endgueltigen Namen ohne Ueberschreiben, Entfernen des Temp-Namens und
Verzeichnis-fsync. Lokales POSIX-Dateisystem mit Hardlink-Unterstuetzung erforderlich.
Ein harter Abbruch kann Temp-Dateien hinterlassen; diese werden nicht ausgeliefert.
Nach einem Abbruch zwischen Link und Temp-Loeschung kann der Download wegen mehrerer
Hardlinks blockieren. Solche Faelle muessen im Wartungsfenster geprueft werden.

## Rotation und Wiederherstellung

Neuen zufaelligen Schluessel unter neuer ID hinzufuegen und `activeKeyId` umstellen.
Datei privat vorbereiten und atomar ersetzen; sie wird je Sicherung/Pruefung neu
gelesen. Alte Schluessel unveraendert behalten, solange zugehoerige Backups benoetigt
werden. Eine ID niemals fuer anderes Schluesselmaterial wiederverwenden.
Neue Sicherung und Wiederherstellung alter/neuer Sicherungen vor Freigabe testen.

`backup:verify` und `backup:restore` verlangen denselben separat bereitgestellten
Schluesselbund, akzeptieren ausschliesslich die authentifizierte Huelle und nennen
Schluessel-ID/Algorithmus im Ergebnis. Restore protokolliert diese Angaben im
Auditdatensatz und Aktivierungszeiger. SHA-256 bezieht sich auf die verschluesselte
Datei und bleibt fuer die ausdrueckliche Auswahl des gewuenschten Backups Pflicht.
Siehe [Offline-Wiederherstellung](offline-restore.md).

## n8n und Altsicherungen

`/api/n8n/backup/latest` liefert nur `.fpbak` als `application/octet-stream`.
n8n soll diese Bytes unveraendert mit dem getrennten `BACKUP_API_KEY` abholen und
extern sichern; keine Entschluesselung im Workflow. Alte ZIPs werden nicht als
Fallback ausgeliefert und von der automatischen Retention nicht entfernt.
Administratoren koennen vorhandene ZIPs weiterhin explizit herunterladen/loeschen.
Download folgt keinen symbolischen oder mehrfachen Hardlinks.

Alte ZIPs bleiben vertraulicher Klartext und werden nicht automatisch konvertiert.
Ihr Import ist im aktuellen Restore gesperrt. Vor Umstellung ein neues verschluesseltes
Backup mit erfolgreicher Wiederherstellungsprobe anlegen. Ein gesonderter,
freigegebener Migrationsweg fuer alte ZIPs steht aus. Blosses Umbenennen oder
nachtraegliches Verschluesseln beweist nicht die urspruengliche Herkunft.

## Sicherheitsgrenzen

AES-GCM schuetzt Vertraulichkeit und Authentizitaet gegen Angreifer **ohne**
Schluessel. Jeder Schluesselinhaber kann auch gueltige Backups erzeugen; es ist
kein unabhaengiger Signaturnachweis des Portalservers. Ein kompromittierter Host,
Schluesseldiebstahl, Loeschung und Wiederholung eines alten gueltigen Backups sind
damit nicht ausgeschlossen. Unveraenderliche externe Aufbewahrung, unabhaengige
Herkunftssicherung, Schluesselverwaltung und reale Disaster-Recovery-Abnahme bleiben
Betriebsaufgaben bzw. offene Hardening-Punkte.
