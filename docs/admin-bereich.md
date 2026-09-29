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
| Kreditoren | `/admin/kreditoren` | Einzelrecht `kreditoren_verwalten` |
| Eskalationszeiten | `/admin/eskalation` | **nur** `superadmin` |
| Erscheinungsbild | `/admin/erscheinungsbild` | **nur** `superadmin` |
| Zeitstempel | `/admin/zeitstempel` | **nur** `superadmin` |
| Personen | `/admin/personen` | `superadmin` oder `manager` |
| E-Mail-Protokoll | `/admin/mails` | Einzelrecht `mails_einsehen` |
| Personen-Sync | `/admin/sync` | Einzelrecht `sync_einsehen` |
| Abgelehnte Rechnungen | `/admin/abgelehnt` | Einzelrecht `abgelehnt_verwalten` |
| Altfälle | `/admin/altfaelle` | Einzelrecht `workflow_eingreifen` (nicht im Manager-Bündel) |
| Geplante Jobs | `/admin/geplante-jobs` | Einzelrecht `geplante_jobs_verwalten` |
| Audit-Log | `/admin/audit-log` | Einzelrecht `audit_log_einsehen` |
| Datenbank-Backup | `/admin/backup` | **nur** `superadmin` |
| Kreditkarten | `/admin/kreditkarten` | Einzelrecht `kreditkarten_verwalten` |
| Module | `/admin/module` | **nur** `superadmin` |
| Mail-Einstellungen | `/admin/mail-einstellungen` | **nur** `superadmin` |

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

## Kreditkarten (`/admin/kreditkarten`)

Liste, Neu, Bearbeiten, Deaktivieren/Reaktivieren der Kreditkarten für die
Vorab-Erfassung von Belegen (Bezeichnung, Endziffern, verantwortliche
Person, Erfass-Modus, optionale Erfasser-Liste, sowie optional
**Absender der Abrechnungs-Mail** — z. B. `viseca.ch` oder
`abrechnung@bank.ch`, Basis der automatischen Kartenerkennung beim
n8n-Eingang). Einzelrecht `kreditkarten_verwalten`. Details:
[kreditkarten-belege.md](kreditkarten-belege.md#2-verwaltung-adminkreditkarten)
und [kreditkarten-belege.md](kreditkarten-belege.md#6b-automatische-kartenerkennung).

## Kreditoren (`/admin/kreditoren`)

Drei zusammengehörige Tabellen auf einer Seite: **Kreditoren**
(Lieferanten, optional mit Default-Konto), **Zuweisungsregeln**
(Absender-Adresse/-Domain → Kreditor, steuert die Auto-Zuweisung beim
Rechnungseingang) und **hinterlegte IBANs** je Kreditor (Basis des
Betrugserkennungs-Abgleichs, siehe
[qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md)). Ein
Kreditor lässt sich auch direkt aus der Kontierungs-Seite heraus neu
anlegen (`POST /kontierung/lieferanten`).

## Eskalationszeiten (`/admin/eskalation`)

Konfiguriert, nach wie vielen Stunden eine unbeanspruchte Pool-Rechnung
eine Reminder- bzw. eine Eskalations-Mail auslöst, sowie die jeweiligen
Empfängerlisten (E-Mail-Adressen oder die Tokens `gruppe:buchhaltung` /
`gruppe:admin`) — inklusive der IBAN-Abweichungs-Empfänger. Zusätzlich
dieselben Werte für Rechnungen, die in `freigabe2` festhängen:
`freigabe2_reminder_stunden` und `freigabe2_eskalation_stunden` (Defaults
24 bzw. 48 Stunden) sowie die Eskalations-Empfängerliste
`freigabe2_eskalation_empfaenger` (Default `gruppe:admin`) — der Reminder
selbst geht an keine konfigurierbare Liste, sondern immer an die
tatsächlich zuständige Person. Siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#freigabe2-erinnerungen).

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

## Module (`/admin/module`)

Ein/Aus-Schalter für optionale Portal-Bereiche, gespeichert im
`admin_config`-Key/Value-Store wie jeder andere Schalter. Aktuell drei
Modul-Einträge (Default: **Spesenmodul aktiv**, **Kreditkartenmodul
deaktiviert**):

- **Spesenmodul** (`modul_spesen_aktiv`) — deaktiviert blendet "Spesen einreichen" aus dem Hauptmenü aus und lässt `GET /spesen/neu`/`POST /spesen` mit `403` abweisen; bereits eingereichte Spesen-Positionen laufen unverändert durch Freigabe 1/2 (siehe [spesen-einreichung.md](spesen-einreichung.md)).
- **Kreditkartenmodul** (`modul_kreditkarten_aktiv`, Default aus) — deaktiviert blendet "Meine Kreditkartenbelege" aus dem Hauptmenü aus, blockiert neue Uploads (`GET /kreditkarte`/`POST /kreditkarte/belege` → `403`) und neue Markierungen als Kreditkartenabrechnung; bereits markierte Abrechnungen lassen sich weiter abgleichen, bestehende Teil-Jobs laufen unverändert weiter (siehe [kreditkarten-belege.md](kreditkarten-belege.md#modul-schalter-adminmodule)).
- **Strikte Freigeber1-Prüfung** (`kontierung_strikte_freigeber1_pruefung`, Default aus) — siehe [rechnungs-workflow.md](rechnungs-workflow.md#2-kontierung-status-zugewiesen).

Gedacht als Sammelstelle für künftige, ebenfalls unabhängig einführbare Module.

## Mail-Einstellungen (`/admin/mail-einstellungen`)

Editierbare Betreff-/Text-Vorlagen (`%variable%`-Platzhalter) für alle
Mail-Typen (inkl. `freigabe2-reminder`/`freigabe2-eskalation`, siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#freigabe2-erinnerungen),
sowie die drei Kreditkarten-Typen `kk-abrechnung-zugewiesen`,
`kk-beleg-erinnerung` und `kk-beleg-eingegangen`, siehe
[kreditkarten-belege.md](kreditkarten-belege.md#3-abrechnung-markieren-und-übergeben)
und [geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#benachrichtigungen-e-mail))
plus die Digest-Vorlage, sowie der globale Batching-Schalter
(sofort vs. täglich gesammelt) mit Versandzeit und manuellem "Jetzt
ausführen" für den `mail-digest`-Job. **Nur `superadmin`**, wie
Eskalationszeiten/Erscheinungsbild/Zeitstempel/Backup. Details:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#benachrichtigungen-e-mail)
und
[2026-09-07-mail-vorlagen-und-batching-design.md](superpowers/specs/2026-09-07-mail-vorlagen-und-batching-design.md).

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

## Altfälle (`/admin/altfaelle`)

Abgeschlossene, noch nicht an n8n übergebene Belege und Splitgruppen ohne
belastbaren Freigabe- oder Zahlungsnachweis. Sie bleiben für den Export
gesperrt, bis hier mit Pflichtbegründung entschieden wird: *nachbestätigen*
(angezeigter Stand wird Übergabestand) oder *nur archivieren* (keine
Zahlung). Jeder Wert zeigt seine Herkunft; Entscheidungen sind
unveränderlich. Siehe
[export-und-zahlungsintegritaet.md](export-und-zahlungsintegritaet.md#altfälle).

## Geplante Jobs (`/admin/geplante-jobs`)

Zeitplan-Konfiguration und manuelles Sofort-Auslösen von sieben der neun
Hintergrund-Jobs (`datenbank-sicherung` und `mail-digest` haben eigene
Konfigurationsseiten, siehe oben), inklusive ihrer Lauf-Historie. Dazu
gehören auch der eigene An/Aus-Schalter und die Tage-Schwelle für
`kk-beleg-erinnerungen`, sowie — als Teil der Konfiguration von
`pdf-bereinigung` — die Aufbewahrungsfrist, nach der Dateien verworfener
Kreditkartenbelege gelöscht werden (`kk_beleg_verworfen_loeschen_tage`,
Default 90 Tage). Details:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md).

## Audit-Log (`/admin/audit-log`)

Durchsuchbare, paginierte Gesamtsicht über alle Rechnungen hinweg — führt
zwei Quellen in einer gemeinsamen Zeitleiste zusammen: `freigaben` (jedes
Freigabe-, Ablehnungs-, Eskalations- und IBAN-Abweichungs-Ereignis über
alle Jobs) und `job_loeschungen` (das Löschprotokoll endgültig gelöschter
Rechnungen). Filterbar nach Person, Konto, Zeitraum (Von/Bis) sowie
Ereignis-Typ, zusätzlich eine Freitext-Suche über Kommentar/Begründung
und Dateiname. Einzelrecht `audit_log_einsehen` — `superadmin` und
`manager` erhalten es automatisch über ihr Rollen-Bundle, sonst gilt
dieselbe additive Vergabe wie bei den übrigen vergebbaren Bereichen
(siehe [auth-und-rechte.md](auth-und-rechte.md)).
