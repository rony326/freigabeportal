# Admin-Bereich

Der gesamte Admin-Bereich hängt unter `/admin`. Der äussere Zugriffsschutz
(`requireAdminAreaAccess`) lässt jede aktive Person hinein, die entweder
`superadmin`, `manager` ist, oder mindestens ein additives Einzelrecht
besitzt — pro Unterbereich entscheidet danach eine **eigene, feinere**
Prüfung, ob die Seite tatsächlich sichtbar/bedienbar ist. Das
Admin-Dashboard selbst (`GET /admin`) zeigt nur eine
Zeitstempel-Rückstands-Warnung, keine geschützten Daten.

Hintergrund: Bis zur Einführung der additiven Einzelrechte
(`person_berechtigungen`) war der gesamte Admin-Bereich ausschliesslich
über eine einzige ChurchTools-Gruppe erreichbar. Das ist heute
feingranularer — siehe [auth-und-rechte.md](auth-und-rechte.md).

## Rechte-Matrix

| Seite | Route | benötigtes Recht |
|---|---|---|
| Dashboard | `/admin` | jedes Einzelrecht, `superadmin` oder `manager` |
| Konten | `/admin/konten` | Einzelrecht `konten_verwalten` |
| Debitoren | `/admin/debitoren` | Einzelrecht `debitoren_verwalten` |
| Eskalationszeiten | `/admin/eskalation` | **nur** `superadmin` |
| Erscheinungsbild | `/admin/erscheinungsbild` | **nur** `superadmin` |
| Zeitstempel | `/admin/zeitstempel` | **nur** `superadmin` |
| Personen | `/admin/personen` | `superadmin` oder `manager` |
| E-Mail-Protokoll | `/admin/mails` | Einzelrecht `mails_einsehen` |
| Personen-Sync | `/admin/sync` | Einzelrecht `sync_einsehen` |
| Abgelehnte Rechnungen | `/admin/abgelehnt` | Einzelrecht `abgelehnt_verwalten` |
| Geplante Jobs | `/admin/geplante-jobs` | Einzelrecht `geplante_jobs_verwalten` |
| Datenbank-Backup | `/admin/backup` | **nur** `superadmin` |

Die mit **nur `superadmin`** markierten Bereiche lassen sich als
Einzelrecht gar nicht vergeben — strukturell abgesichert über den
`CHECK`-Constraint auf `person_berechtigungen` (siehe
[datenmodell.md](datenmodell.md#person_berechtigungen)).

## Konten (`/admin/konten`)

Verwaltet die Kostenstellen ("Konten") mit ihren vier Rollen (Freigeber
1/2 + je ein Stellvertreter). `validateKontoRoles` erzwingt vier
unterschiedliche, aktive Personen; eine bereits zugewiesene, in
ChurchTools nicht mehr auflösbare Person bleibt erhalten, kann aber nicht
neu zugewiesen werden. Konten lassen sich deaktivieren statt löschen
(historische Rechnungen bleiben referenzierbar).

## Debitoren (`/admin/debitoren`)

Drei zusammengehörige Tabellen auf einer Seite: **Debitoren**
(Lieferanten, optional mit Default-Konto), **Zuweisungsregeln**
(Absender-Adresse/-Domain → Debitor, steuert die Auto-Zuweisung beim
Rechnungseingang) und **hinterlegte IBANs** je Debitor (Basis des
Betrugserkennungs-Abgleichs, siehe
[qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md)). Ein
Debitor lässt sich auch direkt aus der Kontierungs-Seite heraus neu
anlegen (`POST /kontierung/lieferanten`).

## Eskalationszeiten (`/admin/eskalation`)

Konfiguriert, nach wie vielen Stunden eine unbeanspruchte Pool-Rechnung
eine Reminder- bzw. eine Eskalations-Mail auslöst, sowie die jeweiligen
Empfängerlisten (E-Mail-Adressen oder die Tokens `gruppe:buchhaltung` /
`gruppe:admin`) — inklusive der IBAN-Abweichungs-Empfänger. Siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md).

## Erscheinungsbild (`/admin/erscheinungsbild`)

Corporate-Design-Anpassung: Primär-/Sekundärfarbe, Standard-Theme
(hell/dunkel/System), Logo-Upload (max. 2 MB, Magic-Byte-geprüft
PNG/JPEG, nicht nur der deklarierte MIME-Typ), Logo-Ausrichtung,
Footer-Text, Seitentitel, sowie ob das Audit-Log lokale Zeit
(Europe/Zürich) statt UTC anzeigt.

## Zeitstempel (`/admin/zeitstempel`)

RFC3161-TSA-Konfiguration (URL, optionale Basic-Auth-Zugangsdaten,
Warnschwelle in Stunden) — siehe
[zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md).

## Datenbank-Backup (`/admin/backup`)

Manuelle und geplante (täglich, Default 03:00) Sicherung von DB +
`JOBS_DIR` + `BRANDING_DIR` als ein ZIP-Archiv nach `BACKUP_DIR`, mit
konfigurierbarer Aufbewahrung (Default: die letzten 14). Download/Löschen
einzelner lokaler Backups, sowie eine Wiederherstellung (Datei-Upload +
Pflicht-Bestätigungstext "WIEDERHERSTELLEN"), die einen automatischen
Sicherheits-Snapshot des vorherigen Standes anlegt, bevor sie Live-Dateien
ersetzt. **Nur `superadmin`** — kein vergebbares Einzelrecht, strenger
eingestuft als die drei bereits gesperrten Bereiche, weil das Archiv das
RFC3161-TSA-Passwort im Klartext enthält. Details:
[2026-08-24-datenbank-backup-design.md](superpowers/specs/2026-08-24-datenbank-backup-design.md).

## Personen (`/admin/personen`)

Read-only-Liste aller aus ChurchTools synchronisierten Personen mit
abgeleiteter Rolle (Superadmin/Manager/Benutzer). Nur ein `superadmin`
kann hier zusätzlich die additiven Einzelrechte pro Person setzen
(`POST /admin/personen/:id/berechtigungen`) — siehe
[auth-und-rechte.md](auth-und-rechte.md).

## E-Mail-Protokoll (`/admin/mails`)

Vollständiges Protokoll jedes Zustellversuchs (`mail_log`, siehe
[datenmodell.md](datenmodell.md)), inklusive Volltext und
Fehlschlags-Details, mit einer "erneut senden"-Funktion pro Eintrag.

## Personen-Sync (`/admin/sync`)

Zeigt den Verlauf der letzten Sync-Läufe, erlaubt das Konfigurieren der
Sicherheitsschwellen (SYNC-1) und listet **blockierte Rechnungen**
("stalled jobs") mit einer Force-Freigeben-Funktion. Details:
[personen-sync.md](personen-sync.md).

## Abgelehnte Rechnungen (`/admin/abgelehnt`)

Übersicht aller Rechnungen im Status `abgelehnt` mit der Möglichkeit, sie
endgültig zu löschen (Soft-Delete + Protokoll) — mit eingebautem
Selbstschutz gegen Löschung durch den eigenen Ablehner. Siehe
[rechnungs-workflow.md](rechnungs-workflow.md#4-ablehnung-überarbeitung-löschung).

## Geplante Jobs (`/admin/geplante-jobs`)

Zeitplan-Konfiguration und manuelles Sofort-Auslösen der vier
Hintergrund-Jobs, inklusive ihrer Lauf-Historie. Details:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md).
