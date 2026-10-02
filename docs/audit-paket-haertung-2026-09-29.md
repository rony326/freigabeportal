# Audit-Paket: Code-Haertung 2026-09-29

Branch `feature/code-hardening-2026-09-29`, Ausgangspunkt `c4abd67`. Sechs getrennt pruefbare
Commits, nicht gepusht. Keine produktiven Daten veraendert, keine externen Dienste kontaktiert.
Keine Audit-Freigabe; gruene Tests ersetzen weder Review noch Betriebsabnahme.

| Commit | Paket |
| --- | --- |
| `b83cc20` | 1 Verweigerte Zugriffe und protokollierte Datei-Loeschungen |
| `c38d3d4` | 2 Quarantaene verwaister finaler Dateien |
| `421c69d` | 3 Alarmierung offener Backup-Loeschabsichten |
| `32c73f3` | 5 TSA-Pruefevidenz |
| `4452426` | 4 Lokale Grundlage fuer externe Audit-Nachweise ([Bedrohungsmodell](audit-externe-nachweise.md)) |
| `2fb5b8f` | 6 Kreditoren statt Debitoren ([eigenes Dokument](kreditoren-statt-debitoren.md)) |

Parallelarbeit: Im Worktree `../freigabeportal-audit` (Branch `codex/audit-hardening`) liegt ein
nicht committeter Patch (`altfall_entscheidungen` in der Audit-Trigger-Liste plus
`test/unit/altfallAudit.test.js`). Er wurde hier nicht uebernommen. Ein simulierter
3-Wege-Merge von `src/db/securitySchema.js` ist konfliktfrei; sein Test besteht auf diesem Stand.

## 1. Verweigerte Zugriffe und Datei-Eingriffe

`src/services/zugriffsAudit.js`, Tabelle `audit_zugriff_drosselung`.

- Protokolliert: fehlende Anmeldung/inaktive Person, fehlende Rolle, fehlendes Einzelrecht (mit
  Rechtname aus dem Katalog), kein Admin-Bereich, CSRF-Fehler, ungueltiger API-Key/Backup-Key,
  ungueltiges Cron-Secret, ungueltiger OAuth-State. Routeninterne 401/403 (z.B. fremder Beleg)
  ueber eine `finish`-Rueckfallebene, die Akteur, Request-ID und Laufkontext vorher festhaelt.
- Gespeichert als `audit_ereignisse` (Objekt `zugriff`): Grund, Status, Methode, Bereich aus
  fester Liste (keine IDs, kein Query-String), ggf. Recht. Keine Header, Cookies, Tokens,
  Schluessel, Bodies, IPs. Akteur und Request-ID ueber den bestehenden Kontext.
- Wachstum: je Stundenfenster hoechstens 3 Einzelereignisse je Grund/Bereich/Akteur, 50
  Einzelereignisse und 25 Drosselhinweise gesamt, 200 Schluessel; darueber nur Zaehler
  (Ueberlaufschluessel). Obergrenze damit ca. 75 Ereignisse pro Stunde.
- Audit-Ausfall: Die Entscheidung faellt vor der Protokollierung. Fehler werden per Savepoint
  zurueckgerollt, gezaehlt (`zugriffsAuditFehlerStatus`) und nur mit Fehlercode geloggt. Status
  und Antwort bleiben unveraendert; ein Audit-Fehler gewaehrt nie Zugriff.
- Nicht protokolliert: 429 der Rate-Limiter und 404.
- Datei-Eingriffe: PDF-Bereinigung loescht archivierte Beleg-/Gruppen-PDFs und Thumbnails ueber
  `src/services/dateiAudit.js` (Absicht mit SHA-256/Groesse -> Unlink -> Ergebnis, nur Dateiname
  protokolliert, keine Symlinks). Scheitert die Absicht, bleibt die Datei und der Job wird nicht
  archiviert.
- Tests: `test/integration/zugriffsAudit.test.js` (echte App: Anmeldung, Rechte, CSRF, API-Key,
  Redaction, Drosselung, Audit-Ausfall, unveraenderte Entscheidung, Rueckfallebene),
  `test/unit/zugriffsAudit.test.js`, `test/unit/dateiAudit.test.js`.

## 2. Verwaiste finale Dateien

`src/services/verwaisteDateien.js`, Tabelle `datei_quarantaene`, Admin `/admin/dateiquarantaene`.

- Commit-Grenze: `writeFinalDocument` schreibt `final-<uuid>.pdf` vor dem DB-Commit (Einzel,
  Nachholjob, Gruppe). Abbruch dazwischen hinterlaesst eine nie referenzierte Datei.
- Erkennung im PDF-Bereinigungslauf oder manuell: nur Namensmuster, nur regulaere Dateien,
  Mindestalter (Standard 24 h, mindestens 1 h), nicht waehrend laufender Nachholjobs.
- Unter `BEGIN IMMEDIATE` erneut geprueft: Dateiname in keiner Textspalte aktiver Tabellen
  (inkl. Snapshots/Manifeste) und nicht im Auditprotokoll, SHA-256 keinem finalen/Export-Hash
  gleich, Inode/Groesse/mtime unveraendert. Dann nicht ueberschreibendes Verschieben
  (link+unlink) in `jobsDir/quarantaene-verwaiste-dateien/` samt Nachweiszeile und Audit;
  Commit-Fehler verschiebt zurueck.
- Nichts wird automatisch geloescht. Zurueckholen oder endgueltiges Loeschen nur durch
  Superadmin mit CSRF und Begruendung; vor dem Loeschen erneute Hash-/Referenzpruefung und
  Audit-Klammer. Aktive Restore-Generationen liegen ausserhalb des aktiven `jobsDir` und werden
  nicht betrachtet; Symlink-Verzeichnisse werden abgelehnt.
- Tests: `test/unit/verwaisteDateien.test.js` (Abbruch vor/nach Commit, paralleler Commit,
  Wiederanlauf nach halbem Verschieben, Referenzen, Symlinks, DB-Fehler, Entscheidungen,
  Unveraenderlichkeit), `test/integration/admin/dateiQuarantaene.test.js`.

## 3. Alarmierung offener Backup-Loeschabsichten

`src/services/sicherheitsalarme.js`, Tabelle `sicherheitsalarme`, Scheduler alle 30 min.

- Erkennung liest `listUnresolvedBackupDeletions` vollstaendig; Absichten juenger als 30 min
  werden ignoriert. Je Absicht genau eine Alarmzeile (persistente Deduplizierung).
- Versand ueber den bestehenden Mailer an `sicherheitsalarm_empfaenger` (Standard
  `gruppe:admin`), Protokoll in `mail_log` (Typ `sicherheitsalarm`) und Audit. Faellige Alarme
  werden unter befristeter Sperre beansprucht; parallele Laeufe senden nicht doppelt.
- Fehler (auch fehlende Empfaenger) -> Wiederholung mit 5 min, 10 min ... bis 6 h; nur Fehlercode
  gespeichert. Erinnerung nach `sicherheitsalarm_wiederholung_stunden` (Standard 24 h).
- Ein Alarm klaert nie eine Absicht; zwischenzeitlich gepruefte Absichten beenden nur den Alarm.
  Zustellung ist mindestens einmal (Absturz nach Versand vor Speicherung -> erneuter Versand).
- Tests: `test/unit/sicherheitsalarme.test.js`, Scheduler-Test.

## 5. TSA-Pruefevidenz

Siehe [TSA-Vertrauensanker, Abschnitt Grenzen](tsa-vertrauensanker.md#grenzen-und-rotation).
Fail-closed bleibt erhalten; keine historische Langzeitvalidierung behauptet. Tests:
`test/unit/tsaNachweis.test.js`, Ergaenzungen in `freigabe2.test.js`, `splitGruppenExport.test.js`.

## Neue Konfigurationswerte (admin_config, mit Standard)

`verwaiste_dateien_mindestalter_stunden` (24), `sicherheitsalarm_empfaenger` (`gruppe:admin`),
`sicherheitsalarm_wiederholung_stunden` (24), `cron_sicherheitsalarme_intervall_minuten` (30).
Neue npm-Skripte: `audit:export`, `audit:verify`.
