# Audit-Nachweis für die Revision — Design

Stand: 2026-10-23. Status: Entwurf, zur Freigabe.

## Absicht und Warum

Das Portal schreibt jede fachliche Änderung transaktional in `audit_ereignisse` und kann daraus
fortlaufende, hashverkettete Pakete erzeugen (`src/services/auditExport.js`,
`npm run audit:export`). Heute geschieht das nur von Hand, und die Pakete bleiben lokal. Damit
beweisen sie nichts gegenüber jemandem mit Server- oder Datenbankzugriff: wer DB und Register
kontrolliert, kann beides konsistent neu berechnen (siehe `docs/audit-externe-nachweise.md`).

Wer die Nachweise nutzt: **Vorstand oder Revision**, typischerweise bei der Jahresprüfung. Die
Frage, die sie beantworten wollen: *Hat jemand mit Admin- oder Serverzugriff das Audit-Log im
Nachhinein verändert?*

Lösung in einem Satz: Das Portal erzeugt automatisch Pakete, lässt deren Hash von der bereits
konfigurierten RFC3161-TSA bestätigen und schickt regelmässig eine kurze Prüfnummer an eine
Person der Revision, die nicht Portal-Admin ist. Bei der Prüfung vergleicht die Revision ihre
letzte Mail mit einer Prüfseite.

## Ziele

- Automatische, lückenlose Erzeugung der Audit-Pakete ohne manuelle Schritte.
- Unabhängige Zeitbestätigung jedes Pakets durch die TSA (DigiCert, bestehende Konfiguration).
- Regelmässige Prüfnummer an ein Postfach ausserhalb der Kontrolle der Portal-Admins.
- Eine für Nicht-Techniker bedienbare Prüfung: Prüfnummer eingeben → klares Ergebnis.

## Nicht-Ziele

- Kein externer WORM-/Objektspeicher, kein Transport der Paketinhalte nach aussen. Pakete bleiben
  im Portal (Register `audit_export_pakete`) und in den Backups.
- Keine personenbezogenen Daten nach aussen: die Mail enthält nur Paketnummer, Hashes, Anzahl,
  Zeitraum und Zeitstempel.
- Keine Änderung am bestehenden Export-Format oder an `npm run audit:export` / `audit:verify`.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Ein Portal-Admin kann die Empfängeradresse still auf sich selbst umbiegen.
- Die Prüfseite meldet "in Ordnung", obwohl die Kette lokal gebrochen ist oder Pakete keinen
  Zeitstempel haben.
- Ein TSA-Ausfall führt dazu, dass Pakete fehlen oder die Kette verzweigt.
- Die Mail ist für die Revision unverständlich (Fachjargon ohne Erklärung, was zu tun ist).

## Entschieden (mit dem Nutzer)

- Empfänger sind Vorstand/Revision; es gibt eine Person mit eigener Adresse, die **nicht** Admin
  im Portal ist.
- Ansatz: TSA-Bestätigung der Paket-Hashes + regelmässige Mail der Prüfnummer an diese Person,
  Vergleich über eine Prüfseite. Nach aussen geht nur die Prüfnummer.

## Entscheidungen des Entwurfs (meine Calls, vom Nutzer zu prüfen)

1. **Takt:** Paket + TSA jede Nacht (fester Job, Uhrzeit wie andere Jobs über
   `admin_config` einstellbar, Standard 03:15). Prüfnummer-Mail **monatlich am 1.** (Standard),
   zusätzlich auf Knopfdruck durch Superadmin ("Prüfnummer jetzt senden").
2. **Empfängeradresse** `audit_revision_empfaenger` (eine oder mehrere Adressen, komma-getrennt),
   nur durch **Superadmin** änderbar auf der bestehenden Seite **Admin → Zeitstempel**
   (`/admin/zeitstempel`, bereits `requireRole(config, 'superadmin')`). Jede Änderung
   - wird über die bestehenden Audit-Trigger auf `admin_config` protokolliert,
   - löst sofort eine Mail an **alte und neue** Adresse aus ("Empfänger der Audit-Prüfnummer wurde
     geändert von … zu … durch …"),
   - zeigt eine Warnung, wenn eine Adresse zu einer Person mit Rolle superadmin gehört (nicht
     blockierend; kleine Organisationen haben evtl. keine Alternative).
3. **Prüfseite** `GET/POST /audit-pruefen`, öffentlich wie `/zeitstempel-pruefen` (die Revision hat
   evtl. kein Portal-Login), mit dem bestehenden Rate-Limit. Eingabe: Paketnummer + Prüfnummer
   (Paket-Hash, 64 Hex; Leerzeichen/Gross-Klein tolerieren). Ausgabe ohne Personendaten.
4. **Prüfnummer** = `paket_sha256` des jeweils neuesten Pakets. In der Mail zusätzlich in 4er-Gruppen
   formatiert zur Lesbarkeit; die Prüfseite akzeptiert beides.
5. **Leeres Intervall:** Gibt es seit dem letzten Paket keine neuen Ereignisse, entsteht kein Paket
   (bestehendes Verhalten). Die Monatsmail nennt dann das letzte vorhandene Paket.
6. **TSA-Fehler:** Das Paket wird trotzdem erzeugt und registriert; der Zeitstempel wird beim
   nächsten Lauf nachgeholt (alle Pakete ohne Nachweis, älteste zuerst). Ist ein Paket länger als
   3 Tage ohne Zeitstempel, löst das einen Sicherheitsalarm aus. `src/services/sicherheitsalarme.js`
   kennt heute nur einen Alarmtyp (`backup_loeschung_offen`); der Builder ergänzt einen zweiten
   Typ `audit_zeitstempel_offen` (Schlüssel = Paketnummer) in derselben Tabelle und demselben
   Versand, ohne den Backup-Alarm zu verändern. Die Monatsmail nennt offen die Zahl der Pakete
   ohne Zeitstempel.
7. **Fehlende Empfängeradresse:** Pakete und Zeitstempel laufen trotzdem; die Monatsmail entfällt,
   und Admin → Zeitstempel sowie das Admin-Dashboard zeigen einen deutlichen Hinweis
   "Revision-Empfänger nicht festgelegt".

## Bausteine

### Nächtlicher Job `audit-export`
- Ruft wiederholt `erstelleAuditExportPaket` auf, bis keine Ereignisse mehr ausstehen (Paketgrösse
  bleibt max. 5000).
- Holt für jedes Paket ohne Nachweis einen RFC3161-Zeitstempel über den `paket_sha256`
  (SHA-256-MessageImprint direkt über die 32 Hash-Bytes bzw. über die kanonische Manifest-Bytes —
  Wahl dem Builder überlassen, muss im Prüfpfad identisch sein). Prüft Bindung und Kette wie bei
  den PDFs (`validateTimestampBinding`, `verifyTsaChain`) und speichert Token + Nachweis.
- Speicherung: neue Tabelle `audit_export_zeitstempel` (paket_nr PK → audit_export_pakete.id,
  token BLOB, gen_time, nachweis JSON, erstellt_am), UPDATE/DELETE per Trigger gesperrt wie
  `audit_export_pakete`, und in die zentrale Audit-Trigger-Liste aufgenommen.
- Läuft über `auditedJob(...)` und `cron_log` (Job-Name in den `cron_log`-CHECK aufnehmen,
  bestehendes Rebuild-Muster).

### Monatliche Prüfnummer-Mail
- Neuer Mail-Typ `audit-pruefnummer` (CHECK-Erweiterung `mail_log` per Rebuild), **immer sofort**
  (in `IMMER_SOFORT_TYPEN`), Vorlage in den Mail-Einstellungen bearbeitbar.
- Inhalt (Standardvorlage, verständlich für Nicht-Techniker): Paketnummer, Prüfnummer, Zeitraum
  (erstes/letztes Ereignis), Anzahl Ereignisse insgesamt, Zeitstempel (Datum/Uhrzeit, TSA-Name),
  Anzahl Pakete ohne Zeitstempel, Link zur Prüfseite, kurze Anleitung: *"Bitte diese Mail
  aufbewahren. Bei der Prüfung Paketnummer und Prüfnummer auf der Prüfseite eingeben."*
- Versand an die konfigurierte Adresse; Job-Name `audit-pruefnummer`, monatlich (neue
  `scheduleMonthly`-Hilfe oder täglicher Lauf mit Tages-Check — Builder).

### Prüfseite `/audit-pruefen`
Prüft und zeigt je Punkt grün/rot mit Klartext:
1. Paket mit dieser Nummer existiert und sein `paket_sha256` entspricht der Prüfnummer.
2. Register-Prüfung `pruefeAuditExportRegister` ohne Befunde (Kette lückenlos, Inhalte stimmen mit
   der DB überein, Bereiche schliessen an).
3. Dieses Paket und alle älteren haben einen gültigen Zeitstempel; `gen_time` liegt nicht vor
   `erstellt_am` und höchstens 7 Tage danach (sonst Hinweis "Zeitstempel verspätet").
4. Seit diesem Paket entstandene Pakete: Anzahl und ob auch sie verkettet und gestempelt sind.
Ergebnis-Zusammenfassung: "Keine Veränderung festgestellt" nur wenn 1–3 grün. Druckbar wie die
bestehende Prüfbescheinigung (`/zeitstempel-pruefen`).

Ehrliche Grenze, auf der Seite und in der Doku genannt: Die Seite läuft im Portal selbst. Ein
Angreifer mit vollem Serverzugriff könnte auch sie verfälschen. Für eine vertiefte Prüfung bleibt
die Offline-Prüfung einer Backup-Kopie mit `npm run audit:verify` plus Vergleich der
TSA-Token gegen die gemailten Prüfnummern. Für den Zweck (Jahresprüfung eines Vereins) ist die
Hürde damit von "eine SQL-Zeile" auf "Code des Portals fälschen" gestiegen.

## Einschränkungen

- Bestehende TSA-Konfiguration (`tsaConfig`, Vertrauensanker DigiCert, CRL) wird
  wiederverwendet; ohne TSA-Konfiguration laufen nur Pakete + Mail, die Prüfseite zeigt dann
  "kein Zeitstempel konfiguriert" (rot).
- Infomaniak-Node-Hosting: alles läuft im Node-Prozess über den bestehenden Scheduler.
- Migrationen: CHECK-Erweiterungen nur per bestehendem `erweitereCheckPerRebuild`, vor
  `migrateSecuritySchema`.

## Dem Builder überlassen

- Genaue Form des TSA-Requests für einen Hash (statt PDF), solange Bindung und Kettenprüfung
  denselben Standard wie bei PDFs erfüllen.
- Monatliche Planung (eigene Scheduler-Hilfe vs. täglicher Check).
- Layout der Prüfseite im bestehenden Shell-Layout.
- Tests: Job (Pakete bis leer, Nachholen nach TSA-Fehler, keine verzweigte Kette), Mail (Inhalt,
  Empfängerwechsel an alt+neu), Prüfseite (richtige/falsche Prüfnummer, gebrochene Kette, Paket
  ohne Zeitstempel, verspäteter Zeitstempel), Migrationen, CSRF-Sweep für das neue POST.
- Doku-Updates: `docs/audit-externe-nachweise.md` (Ist-Stand, Bedrohungsmodell-Zeilen),
  `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/admin-bereich.md`, `docs/datenmodell.md`.

## Präzisierungen beim Planen (2026-10-23)

Technische Anpassungen nach Abgleich mit dem Code; das freigegebene Verhalten bleibt gleich.

- **Prüfseite ohne Login:** `/zeitstempel-pruefen` verlangt in Wirklichkeit ein Login. `/audit-pruefen`
  wird deshalb als eigene öffentliche Seite mit `publicLimiter` eingehängt. Sie ist rein lesend und
  nimmt Paketnummer und Prüfnummer als Query-Parameter (`GET /audit-pruefen?paket=N&pruefnummer=…`),
  damit kein CSRF-Token nötig ist und der Link aus der Mail direkt zum Ergebnis führt.
- **Zeitstempel-Tabelle:** `audit_export_zeitstempel` entsteht in `migrateAuditExportSchema` neben
  `audit_export_pakete`, mit denselben UPDATE/DELETE-Sperren. Wie `audit_export_pakete` steht sie
  **nicht** in der zentralen Audit-Trigger-Liste (das Register ist selbst der Nachweis, und die
  Migration läuft nach `migrateSecuritySchema`).
- **Alarm bei fehlendem Zeitstempel:** statt eines zweiten Typs in `sicherheitsalarme` (die Tabelle
  und ihr Versand sind fest auf Backup-Löschungen zugeschnitten) verschickt der nächtliche Job selbst
  höchstens alle 24 h eine Mail an `sicherheitsalarm_empfaenger`, protokolliert als
  `mail_log.typ = 'sicherheitsalarm'`.
- **Zeitplan:** wie bei der TSA-Sperrlisten-Erneuerung über `admin_config`-Schlüssel ohne eigene
  UI und ohne `cron_log`-Eintrag (`cron_audit_export_stunde/minute`, Standard 03:15;
  `cron_audit_pruefnummer_stunde/minute`, Standard 07:00). Der Lauf ist über `auditedJob` im
  Audit-Log sichtbar.
- **Was die TSA bestätigt:** Der MessageImprint ist SHA-256 über die UTF-8-Bytes der 64-stelligen
  hexadezimalen Prüfnummer (`paket_sha256`). Ein externer Prüfer kann das mit Standardwerkzeugen
  nachrechnen.

## Einstellbar über die Admin-Oberfläche (Nutzerwunsch 2026-10-23)

Alle Einstellungen im Abschnitt "Audit-Nachweis für die Revision" auf **Admin → Zeitstempel**
(nur Superadmin):

| Einstellung | Schlüssel | Werte | Standard |
| --- | --- | --- | --- |
| Funktion aktiv | `modul_audit_nachweis_aktiv` | `1`/`0` | `1` |
| Versandrhythmus | `audit_pruefnummer_rhythmus` | `monatlich`, `quartalsweise` (Jan/Apr/Jul/Okt), `jaehrlich` (Januar) | `monatlich` |
| Versandtag im Monat | `audit_pruefnummer_tag` | 1–28 | 1 |
| Uhrzeit nächtlicher Export | `cron_audit_export_stunde` / `_minute` | 0–23 / 0–59 | 03:15 |
| Uhrzeit Mailversand | `cron_audit_pruefnummer_stunde` / `_minute` | 0–23 / 0–59 | 07:00 |
| Alarmschwelle | `audit_zeitstempel_alarm_tage` | 1–30 Tage | 3 |

Meine Calls dazu:
- Der Schalter liegt **nicht** unter Admin → Module, sondern auf derselben Superadmin-Seite: das
  Abschalten des Nachweises ist sicherheitsrelevant und soll nicht über ein Teilrecht möglich sein.
- **Abschalten und jede Änderung von Rhythmus/Tag** lösen wie der Empfängerwechsel sofort eine Mail an
  die eingetragenen Revisions-Empfänger aus ("Audit-Nachweis wurde deaktiviert/geändert von … durch …").
  Sonst könnte jemand den Nachweis still abstellen.
- Abgeschaltet: kein Export, keine Stempel, keine Mails, kein Alarm. Die Prüfseite bleibt für die
  vorhandenen Pakete nutzbar und zeigt den Hinweis "automatischer Nachweis ist derzeit abgeschaltet".
  Nach dem Wiedereinschalten holt der nächste Lauf alle ausstehenden Ereignisse nach.
- Uhrzeiten wirken ohne Neustart (der Scheduler liest sie bei jeder Planung neu).
