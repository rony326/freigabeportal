# Admin-Bereich

Der gesamte Admin-Bereich hängt unter `/admin`. Der äussere Zugriffsschutz
(`requireAdminAreaAccess`) lässt jede aktive Person hinein, die entweder
`superadmin`, `manager` ist, oder mindestens ein additives Einzelrecht
besitzt — pro Unterbereich entscheidet danach eine **eigene, feinere**
Prüfung, ob die Seite tatsächlich sichtbar/bedienbar ist. Das
Übersichtsseite selbst (`GET /admin`) zeigt nur eine
Zeitstempel-Rückstands-Warnung, keine geschützten Daten.

Hintergrund: Bis zur Einführung der additiven Einzelrechte
(`person_berechtigungen`) war der gesamte Admin-Bereich ausschliesslich
über eine einzige ChurchTools-Gruppe erreichbar. Das ist heute
feingranularer — siehe [auth-und-rechte.md](auth-und-rechte.md).

## Navigation und Layout

Alle Seiten teilen dasselbe Grundgerüst:

- **Obere Leiste:** Logo (Ausrichtung aus dem Erscheinungsbild), die Reiter
  „Portal“ und „Admin“ (Admin nur mit mindestens einem Admin-Recht), rechts
  „Angemeldet als“, Farbmodus und Abmelden. Unter 992 px öffnet „☰“ die
  Seitenleiste als Offcanvas.
- **Seitenleiste mit Gruppen** (Quelle: `src/services/navigation.js`). Portal:
  Arbeit (Aufgaben, mit Zähler offener Aufgaben), Spesen, Belege, Persönlich.
  Admin: Vorgänge, Stammdaten, Einstellungen, Betrieb. Menüpfade in der
  Doku folgen dieser Struktur, z. B. „Admin → Stammdaten → Konten“. Seiten
  mit PDF-Vorschau (Kontierung, Freigabe 2, Spesen-Freigabe 1,
  KK-Abgleich) zeigen die Seitenleiste auf Icons eingeklappt; ihre
  Schaltflächen (Zurück, Vorschau neu laden, + Lieferant) stehen in einer
  Aktionszeile über dem Inhalt.
- **Einheitliche Breite** (max. 1320 px) und derselbe Seitenkopf (Titel,
  Hauptaktion, Ansichtsumschalter) auf jeder Seite. Der Titel von `/admin`
  lautet „Übersicht“.

### Kachelansicht

Sieben Listen bieten den Umschalter „☰ Tabelle | ▦ Kacheln“: Aufgaben,
Meine Spesen, Abgeschlossene Rechnungen, Kreditkartenbelege sowie
Admin → Vorgänge → Laufende Vorgänge, Abgelehnte Rechnungen und Altfälle.
Die Wahl wird pro Liste und pro Gerät im Cookie `ansicht_<schluessel>`
gespeichert (1 Jahr). Ohne Wahl gilt: Tabelle auf grossen, Kacheln auf
kleinen Bildschirmen. Schlüsseltabelle und Cookie-Logik:
`src/middleware/ansicht.js`.

## Rechte-Matrix

| Seite | Route | benötigtes Recht |
|---|---|---|
| Übersicht | `/admin` | jedes Einzelrecht, `superadmin` oder `manager` |
| Konten | `/admin/konten` | Einzelrecht `konten_verwalten` |
| Kreditoren | `/admin/kreditoren` | Einzelrecht `kreditoren_verwalten` |
| Eskalationszeiten | `/admin/eskalation` | **nur** `superadmin` |
| Erscheinungsbild | `/admin/erscheinungsbild` | **nur** `superadmin` |
| Zeitstempel | `/admin/zeitstempel` | **nur** `superadmin` |
| Personen | `/admin/personen` | `superadmin` oder `manager` |
| Mail-Protokoll | `/admin/mails` | Einzelrecht `mails_einsehen` |
| Personen-Sync | `/admin/sync` | `sync_einsehen`; Konfiguration zusätzlich `sync_verwalten`, Force-Aktionen zusätzlich `workflow_eingreifen` |
| Laufende Vorgänge | `/admin/vorgaenge` | Einzelrecht `vorgaenge_einsehen` (Umhängen: `workflow_eingreifen`); `superadmin` ✓, `manager` ✓ (nur ansehen) |
| Abgelehnte Rechnungen | `/admin/abgelehnt` | Einzelrecht `abgelehnt_verwalten` |
| Altfälle | `/admin/altfaelle` | Einzelrecht `workflow_eingreifen` (nicht im Manager-Bündel) |
| Geplante Jobs | `/admin/geplante-jobs` | Einzelrecht `geplante_jobs_verwalten` |
| Audit-Log | `/admin/audit-log` | Einzelrecht `audit_log_einsehen` |
| Datenbank-Backup | `/admin/backup` | **nur** `superadmin` |
| Datei-Quarantäne | `/admin/dateiquarantaene` | **nur** `superadmin` (verwaiste finale Dokumente zurückholen/löschen, Begründung Pflicht) |
| Betrieb & Nutzung | `/admin/betrieb` (+ `/personen/:id`, `/fehler`, `/fehler/:requestId`, `/meldungen`, `/meldungen/:id`, `/banner`, `/datenschutz`, `/status`) | Einzelrecht `betrieb_einsehen`; `superadmin` ✓, `manager` ✗ — siehe [betrieb-und-nutzung.md](betrieb-und-nutzung.md); Status: [statusseite-und-monitoring.md](statusseite-und-monitoring.md) |
| Kreditkarten | `/admin/kreditkarten` | Einzelrecht `kreditkarten_verwalten` |
| Module | `/admin/module` | **nur** `superadmin` |
| Ersteinrichtung | `/admin/ersteinrichtung` | **nur** `superadmin`; geführter Assistent mit 14 Schritten (8 Pflicht), technische Prüfung, ChurchTools-Test, Testmail, Kernjobs auslösen; Hinweis auf dem Admin-Dashboard ("später" blendet ihn 7 Tage aus); Statusdienst `einrichtung` |
| Mail-Einstellungen | `/admin/mail-einstellungen` | **nur** `superadmin` |
| Testmodus | `/admin/testmodus` | `superadmin` oder `manager`; Spielwiese zum gefahrlosen Ausprobieren, siehe [testmodus.md](testmodus.md) |

Die Seite **Laufende Vorgänge** zeigt alle Vorgänge in `unzugewiesen`, `zugewiesen`, `freigabe2` und `abgelehnt`; mit `workflow_eingreifen` lassen sie sich umhängen. Details: [rechnungs-workflow.md](rechnungs-workflow.md#8-admin-eingriff-laufende-vorgänge-umhängen).

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
optional ein zweites „Logo dunkel“ für den Dunkelmodus (ohne dunkles
Logo erscheint dort das helle; die gedruckte Prüfbescheinigung nutzt
immer das helle; das dunkle lässt sich per Häkchen wieder entfernen),
Footer-Text, Seitentitel, sowie ob das Audit-Log lokale Zeit
(Europe/Zürich) statt UTC anzeigt.

## Zeitstempel (`/admin/zeitstempel`)

RFC3161-TSA-Konfiguration (URL, optionale Basic-Auth-Zugangsdaten,
Warnschwelle in Stunden) — siehe
[zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md).

Abschnitt **Audit-Nachweis für die Revision** (nur Superadmin, Hintergrund in
[audit-externe-nachweise.md](audit-externe-nachweise.md)):

- Funktion aktiv (`modul_audit_nachweis_aktiv`, Default an) — bewusst hier und nicht unter Module.
- Empfänger der Prüfnummer (`audit_revision_empfaenger`, komma-getrennt). Ein Wechsel geht per Mail
  an alte und neue Adresse; Warnung, wenn eine Adresse zu einer Person mit Admin-Rechten gehört;
  Hinweis (auch im Admin-Dashboard), wenn kein Empfänger festgelegt ist.
- Versandrhythmus (`audit_pruefnummer_rhythmus`: monatlich, quartalsweise Jan/Apr/Jul/Okt, jährlich
  Januar) und Versandtag (`audit_pruefnummer_tag`, 1–28). Abschalten sowie Änderung von Rhythmus/Tag
  lösen eine Mail an die Empfänger aus.
- Uhrzeit des nächtlichen Exports (`cron_audit_export_stunde`/`_minute`, Default 03:15) und des
  Mailversands (`cron_audit_pruefnummer_stunde`/`_minute`, Default 07:00), wirksam ohne Neustart.
- Alarmschwelle (`audit_zeitstempel_alarm_tage`, 1–30, Default 3).
- Knopf „Prüfnummer jetzt senden“ (`POST /admin/zeitstempel/audit-pruefnummer-senden`).
- Anzeige des letzten Pakets.

## Datenbank-Backup (`/admin/backup`)

Zeitplan (täglich, Default 03:00, Europe/Zürich), Aufbewahrung (Default: die
letzten 14 `.fpbak`) und manuelles Auslösen der Sicherung von DB +
`JOBS_DIR` + `BRANDING_DIR`. Sicherungen entstehen ausschließlich als
authentifiziert verschlüsselte `.fpbak`-Dateien (AES-256-GCM) in
`BACKUP_DIR`; dafür muss der separat verwahrte Schlüsselbund
`BACKUP_KEYRING_FILE` bereitstehen, sonst scheitert die Sicherung sichtbar
im Verlauf. Die Retention entfernt nur `.fpbak`-Dateien (mit
Lösch-Protokoll); alte Klartext-ZIPs bleiben liegen, bis ein Superadmin sie
ausdrücklich löscht. Einzelne Sicherungen können heruntergeladen oder
gelöscht und ungeklärte Löschabsichten begründet geprüft werden.

**Keine Wiederherstellung im laufenden Betrieb:** `POST
/admin/backup/wiederherstellen` antwortet mit `423`. Restore und Rückwechsel
laufen nur offline über `npm run backup:verify` / `backup:restore` /
`backup:rollback` bei gestopptem Server. Verbindliche Anleitungen:
[backup-verschluesselung.md](backup-verschluesselung.md) (Schlüsselbund,
Aufbewahrung der Schlüssel, Rotation, n8n-Abholung) und
[offline-restore.md](offline-restore.md) (Ablauf, Prozesssperre, verwaiste
Sperren). Ein verpasster Sicherungstermin (Server gestoppt) wird nicht
nachgeholt — siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#neustart-verpasste-termine-und-verwaiste-sperren).
**Nur `superadmin`** — kein vergebbares Einzelrecht. Das historische Design
([2026-08-24-datenbank-backup-design.md](superpowers/specs/2026-08-24-datenbank-backup-design.md))
beschreibt noch den früheren ZIP-/Live-Restore-Stand.

## Module (`/admin/module`)

Ein/Aus-Schalter für optionale Portal-Bereiche, gespeichert im
`admin_config`-Key/Value-Store wie jeder andere Schalter. Aktuell drei
Modul-Einträge (Default: **Spesenmodul aktiv**, **Kreditkartenmodul
deaktiviert**):

- **Spesenmodul** (`modul_spesen_aktiv`) — deaktiviert blendet "Spesen einreichen" in der Seitenleiste (Reiter Portal, Gruppe Spesen) aus und lässt `GET /spesen/neu`/`POST /spesen` mit `403` abweisen; bereits eingereichte Spesen-Positionen laufen unverändert durch Freigabe 1/2 (siehe [spesen-einreichung.md](spesen-einreichung.md)).
- **Kreditkartenmodul** (`modul_kreditkarten_aktiv`, Default aus) — deaktiviert blendet "Kreditkartenbelege" in der Seitenleiste (Reiter Portal, Gruppe Belege) aus, blockiert neue Uploads (`GET /kreditkarte`/`POST /kreditkarte/belege` → `403`) und neue Markierungen als Kreditkartenabrechnung; bereits markierte Abrechnungen lassen sich weiter abgleichen, bestehende Teil-Jobs laufen unverändert weiter (siehe [kreditkarten-belege.md](kreditkarten-belege.md#modul-schalter-adminmodule)).
- **Strikte Freigeber1-Prüfung** (`kontierung_strikte_freigeber1_pruefung`, Default aus) — siehe [rechnungs-workflow.md](rechnungs-workflow.md#2-kontierung-status-zugewiesen).

Gedacht als Sammelstelle für künftige, ebenfalls unabhängig einführbare Module.

## Ersteinrichtung (`/admin/ersteinrichtung`)

Nur Superadmin. Geführter Assistent mit 14 Schritten (8 Pflicht), technischer Prüfung, ChurchTools-Test, Testmail und
Auslösen der Kernjobs; Hinweis auf dem Dashboard, den "später" 7 Tage ausblendet. Details: [ersteinrichtung.md](ersteinrichtung.md).

## Mail-Einstellungen (`/admin/mail-einstellungen`)

Editierbare Betreff-/Text-Vorlagen (`%variable%`-Platzhalter) für alle
Mail-Typen (inkl. `freigabe2-reminder`/`freigabe2-eskalation`, siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#freigabe2-erinnerungen),
sowie die drei Kreditkarten-Typen `kk-abrechnung-zugewiesen`,
`kk-beleg-erinnerung` und `kk-beleg-eingegangen`, sowie `kommentar` (siehe [kommentare.md](kommentare.md)), siehe
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
abgeleiteter Rolle (Superadmin/Manager/Benutzer). Aktive Personen ohne
Verwaltungsgruppe werden neutral als „Portalzugang über ChurchTools-Login“
gekennzeichnet (kein Fehlerzustand); bei deaktivierten Personen steht der
Grund (in ChurchTools gelöscht bzw. archiviert) samt Datum — siehe
[personen-sync.md](personen-sync.md). Nur ein `superadmin`
kann hier zusätzlich die additiven Einzelrechte pro Person setzen
(`POST /admin/personen/:id/berechtigungen`) — siehe
[auth-und-rechte.md](auth-und-rechte.md).

## E-Mail-Protokoll (`/admin/mails`)

Vollständiges Protokoll aller Benachrichtigungen (`mail_log`, siehe
[datenmodell.md](datenmodell.md)) mit Volltext, Status (`eingereiht`,
`geplant`, `versendet`, `fehlgeschlagen`), Anzahl Versuche, nächstem
Versuch und Fehlerdetails. „Erneut versenden“ für `fehlgeschlagen`e Zeilen
legt eine neue Zeile an; „Jetzt erneut versuchen“ versucht eine noch
eingereihte Zeile sofort, ohne Duplikat. Semantik und Wiederholungslogik:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#benachrichtigungen-e-mail).

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

Zeitplan-Konfiguration und manuelles Sofort-Auslösen von acht der fünfzehn
Hintergrund-Jobs (`datenbank-sicherung` und `mail-digest` haben eigene
Konfigurationsseiten, siehe oben; `sicherheitsalarme` nur über
`admin_config`), inklusive ihrer Lauf-Historie — einschließlich des
Wiederholungslaufs `mail-zustellung`. Läufe mit Zustellfehlern stehen dort
auf `fehler`. Dazu
gehören auch der eigene An/Aus-Schalter und die Tage-Schwelle für
`kk-beleg-erinnerungen`, sowie — als Teil der Konfiguration von
`pdf-bereinigung` — die Aufbewahrungsfrist, nach der Dateien verworfener
Kreditkartenbelege gelöscht werden (`kk_beleg_verworfen_loeschen_tage`,
Default 90 Tage). Details:
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md).

## Testmodus (`/admin/testmodus`)

Schaltet die Spielwiese ein oder aus, setzt sie zurück und zeigt die fünf
Beispielpersonen. Im Testmodus laufen alle Seiten ausser den echten Pfaden
(`/auth`, `/healthz`, `/admin/testmodus`, `/admin/betrieb/status`,
`/api/n8n`, `/internal`) in einer abgeschotteten Kopie; Backup-Seite und
Zeitstempel-Einstellungen sind dort gesperrt. Details: [testmodus.md](testmodus.md).

## Audit-Log (`/admin/audit-log`)

Durchsuchbare, paginierte Gesamtsicht über alle Rechnungen hinweg — führt
drei Quellen in einer gemeinsamen Zeitleiste zusammen: `freigaben` (jedes
Freigabe-, Ablehnungs-, Eskalations- und IBAN-Abweichungs-Ereignis über
alle Jobs) und `job_loeschungen` (das Löschprotokoll endgültig gelöschter
Rechnungen) sowie `kk_beleg_ereignisse` (Kreditkartenbelege vor ihrer
Zuordnung zu einem Job). Filterbar nach Person, Konto, Zeitraum (Von/Bis) sowie
Ereignis-Typ, zusätzlich eine Freitext-Suche über Kommentar/Begründung
und Dateiname. Einzelrecht `audit_log_einsehen` — `superadmin` und
`manager` erhalten es automatisch über ihr Rollen-Bundle, sonst gilt
dieselbe additive Vergabe wie bei den übrigen vergebbaren Bereichen
(siehe [auth-und-rechte.md](auth-und-rechte.md)).

Zusätzlich zeigt die ungefilterte Seite die zentralen Änderungen aus
`audit_ereignisse` mit Vorher-/Nachher-Daten, Akteur sowie Request- und
Lauf-ID an (50 Einträge je Cursor-Seite). Sobald ein fachlicher Filter
gesetzt ist, wird dieser separate Änderungsbereich ausgeblendet; die
Filter der Zeitleiste durchsuchen ihn nicht. Lokale Audit-Exportpakete
werden über die CLI erzeugt, siehe [externe Audit-Nachweise](audit-externe-nachweise.md).
