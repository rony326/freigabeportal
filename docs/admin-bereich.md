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

### Farbmodus, Symbole, Kopfleiste

- **Farbmodus-Menü** in der oberen Leiste: Hell, Dunkel, System. Die
  persönliche Wahl „System“ folgt dem Betriebssystem und überschreibt das
  Standard-Theme aus dem Erscheinungsbild; ohne Wahl gilt der Admin-Standard.
- **Symbole** sind SVG aus dem Bootstrap-Icons-Sprite (1.13.2). Das Sprite
  wird mit `node scripts/baueSymbole.js` neu erzeugt, wenn die Symbolliste
  sich ändert; es gibt keinen Build-Schritt zur Laufzeit.
- **Kopfleiste** ab 992 px: haftend und leicht durchscheinend.
- **Ablehnen** verlangt überall im Dialog eine Begründung (sonst nur beim
  Interessenskonflikt Pflicht); der Sendestatus gibt einen Knopf nach 15
  Sekunden oder bei „Zurück“ wieder frei. Kontierung zeigt
  Nebenaktionen unter „Weitere Aktionen“ (siehe
  [rechnungs-workflow.md](rechnungs-workflow.md)). Bestätigungen (Backup
  löschen, Prüfnummer senden) laufen über einen Dialog.

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
| Benachrichtigungen | `/admin/benachrichtigungen` (+ `/:id`, `/:id/zuruecksetzen`, `/:id/test-mail`, `/zusammenfassung/jetzt-ausfuehren`) | **nur** `superadmin`; ersetzt Eskalationszeiten und Mail-Einstellungen (alte URLs leiten per GET weiter) |
| Erscheinungsbild | `/admin/erscheinungsbild` | **nur** `superadmin` |
| Zeitstempel | `/admin/zeitstempel` | **nur** `superadmin` |
| Personen | `/admin/personen` | `superadmin` oder `manager` |
| Mail-Protokoll | `/admin/mails` | Einzelrecht `mails_einsehen` |
| Personen-Sync | `/admin/sync` | `sync_einsehen`; Konfiguration zusätzlich `sync_verwalten`, Force-Aktionen zusätzlich `workflow_eingreifen` |
| Laufende Vorgänge | `/admin/vorgaenge` | Einzelrecht `vorgaenge_einsehen` (Umhängen: `workflow_eingreifen`); `superadmin` ✓, `manager` ✓ (nur ansehen); bei Rapporten Ersetzen/Entfernen/Aufheben ebenfalls `workflow_eingreifen` |
| Abgelehnte Rechnungen | `/admin/abgelehnt` | Einzelrecht `abgelehnt_verwalten` |
| Altfälle | `/admin/altfaelle` | Einzelrecht `workflow_eingreifen` (nicht im Manager-Bündel) |
| Geplante Jobs | `/admin/geplante-jobs` | Einzelrecht `geplante_jobs_verwalten` |
| Audit-Log | `/admin/audit-log` | Einzelrecht `audit_log_einsehen` |
| Datenbank-Backup | `/admin/backup` | **nur** `superadmin` |
| Datei-Quarantäne | `/admin/dateiquarantaene` | **nur** `superadmin` (verwaiste finale Dokumente zurückholen/löschen, Begründung Pflicht) |
| Betrieb & Nutzung | `/admin/betrieb` (+ `/personen/:id`, `/fehler`, `/fehler/:requestId`, `/meldungen`, `/meldungen/:id`, `/banner`, `/datenschutz`, `/status`) | Einzelrecht `betrieb_einsehen`; `superadmin` ✓, `manager` ✗ — siehe [betrieb-und-nutzung.md](betrieb-und-nutzung.md); Status: [statusseite-und-monitoring.md](statusseite-und-monitoring.md) |
| Kreditkarten | `/admin/kreditkarten` | Einzelrecht `kreditkarten_verwalten` |
| Budgets | `/admin/budgets` (+ `/import`, `/import/vorschau`, `/import/bestaetigen`) | Einzelrecht `budgets_verwalten`; `superadmin` ✓, `manager` ✓ — Budget pro Konto und Jahr, Import aus Excel/CSV mit Vorschau, siehe [auswertung.md](auswertung.md#budgets-pflegen) |
| Module | `/admin/module` | **nur** `superadmin`; enthält auch die Schwelle «länger offen» der Auswertung (`auswertung_offen_schwelle_tage`, 1–365, Standard 14) |
| Ersteinrichtung | `/admin/ersteinrichtung` | **nur** `superadmin`; geführter Assistent mit 14 Schritten (8 Pflicht), technische Prüfung, ChurchTools-Test, Testmail, Kernjobs auslösen; Hinweis auf dem Admin-Dashboard ("später" blendet ihn 7 Tage aus); Statusdienst `einrichtung` |
| Testmodus | `/admin/testmodus` | `superadmin` oder `manager`; Spielwiese zum gefahrlosen Ausprobieren, siehe [testmodus.md](testmodus.md) |

Die Seite **Laufende Vorgänge** zeigt alle Vorgänge in `unzugewiesen`, `zugewiesen`, `freigabe2` und `abgelehnt`; mit `workflow_eingreifen` lassen sie sich umhängen. Details: [rechnungs-workflow.md](rechnungs-workflow.md#8-admin-eingriff-laufende-vorgänge-umhängen).

**Rapporte im Dashboard:** Die Liste zeigt auch Rapporte (Status `kenntnisnahme`) mit der Art «Rapport» und dem Stand «n von m» bestätigt; Filter `?typ=rapport`. Auf der Detailseite kann man mit `workflow_eingreifen` je offener Empfängerin bzw. offenem Empfänger **Ersetzen** (neue Person, per Mail informiert) oder **Entfernen** (Begründung mindestens 10 Zeichen) und die ganze Markierung **Aufheben**. Das allgemeine Umhängen ist für Rapporte nicht vorgesehen. Siehe [rechnungs-workflow.md](rechnungs-workflow.md#9-rapporte-status-kenntnisnahme).

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
(Lieferanten mit **Zahlungsart** Überweisung, Dauerauftrag, Lastschrift oder
Kreditkarte, optional mit Default-Konto und „Beträge schwanken stark“), **Zuweisungsregeln**
(Absender-Adresse/-Domain → Kreditor, steuert die Auto-Zuweisung beim
Rechnungseingang) und **hinterlegte IBANs** je Kreditor (Basis des
Betrugserkennungs-Abgleichs, siehe
[qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md)). Neue
IBANs entstehen **nur hier** (aus unabhängiger Quelle wie Vertrag oder
Telefonat), nicht mehr von einer Rechnung („IBAN merken“ entfällt). Bei
Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht (Feldfehler
beim Speichern; die letzte IBAN lässt sich nicht löschen); die Liste zeigt
die Zahlungsart, gekürzte IBANs und das Abzeichen „vollständig“ / „IBAN
fehlt“. Unvollständige Kreditoren sind bei der Kontierung nicht wählbar.
Ein
Kreditor lässt sich auch direkt aus der Kontierungs-Seite heraus neu
anlegen (`POST /kontierung/lieferanten`) — erlaubt für `buchhaltung`, `superadmin`,
Einzelrecht `kreditoren_verwalten` oder wer selbst eine offene Kontierung bzw.
Überarbeitung hat (sonst 403).

## Benachrichtigungen (`/admin/benachrichtigungen`)

Eine Seite für alle Mail-Ereignisse; sie ersetzt die früheren Seiten
„Eskalationszeiten“ (`/admin/eskalation`) und „Mail-Einstellungen“
(`/admin/mail-einstellungen`). Beide alten URLs leiten per GET auf das passende
Ereignis weiter (Lesezeichen funktionieren), POSTs auf die alten URLs gibt es
nicht mehr. **Nur `superadmin`.** Menü: Admin → Einstellungen → Benachrichtigungen.

**Aufbau:** links die Ereignisliste nach Bereichen (Allgemein, Rechnungen,
Freigabe 2, Warnungen, Rapporte, Kreditkarten, System & Sicherheit) mit
Suchfeld. Ein Ereignis pro URL (`/admin/benachrichtigungen/<id>`, z. B.
`reminder`), gespeichert wird pro Ereignis. Das Abzeichen „angepasst“ markiert
Ereignisse, deren Text vom Standard abweicht. Auf älteren Installationen mit
früheren Standardtexten kann es fälschlich erscheinen; „Text auf Standard
zurücksetzen“ behebt das. Rechts das gewählte Ereignis mit drei Blöcken:

- **Wann:** die Stunden-Werte bzw. Schwellen des Ereignisses (Reminder und
  Eskalation im Pool, Freigabe 2, Rapporte, Wiederholung des
  Sicherheitsalarms; beim Ereignis „Auffälligkeiten bei Kontierung“ die
  Schwellen der Betragsprüfungen E/F/G). Bei sofort verschickten Ereignissen
  steht der Hinweis, dass die Mail sofort geht. Werte und Validierung wie
  zuvor.
- **Wer:** fester Text, wer automatisch eine Mail bekommt, und bei Ereignissen
  mit konfigurierbaren Empfängern die **zusätzlichen Empfänger** als Kärtchen
  mit ×. Das Suchfeld bietet Gruppen (Buchhaltung, Admin), aktive Personen
  (Name, Mail) und „Andere E-Mail-Adresse eingeben …“. Gespeichert wird als
  Liste mit `gruppe:buchhaltung`, `gruppe:admin`, `person:<ID>` oder
  E-Mail-Adresse; Personen werden beim Versand zur aktuellen Adresse
  aufgelöst, inaktive Personen still übersprungen. Ohne JavaScript bleibt ein
  Textfeld (ein Eintrag pro Zeile). Ein Hinweis „ungespeichert“ erscheint, wenn
  die Liste von der gespeicherten abweicht.
- **Was:** Betreff und Text. Die Variablen stehen als Knöpfe mit lesbaren
  Namen („Name“, „Dateiname“, „Link“ …) bereit und fügen `%variable%` an der
  Cursorposition ein. Eine Live-Vorschau zeigt Beispieldaten; unbekannte
  Variablen werden gewarnt, Pflicht-Hinweise (z. B. `%zusammenfassung%` in der
  Zusammenfassungs-Mail) bleiben. **Test-Mail an mich** schickt den
  gespeicherten Text mit Beispieldaten sofort an die Adresse der angemeldeten
  Person (Betreff „[Test] …“, Typ `testmail`) und wird im Audit-Log
  festgehalten. **Text auf Standard zurücksetzen** fragt per Dialog nach.
  Ereignisse ohne Vorlage (z. B. Sicherheitsalarm) haben keinen Block „Was“.

**Umgezogene Einstellungen:** Die Empfänger der Sync-Fehler-Mails
(`sync_fehler_empfaenger`) und der Audit-Prüfnummer
(`audit_revision_empfaenger`) werden jetzt hier gepflegt; `/admin/sync` und
`/admin/zeitstempel` verlinken nur noch hierher. Die Prüfnummer-Empfänger
akzeptieren **ausschliesslich E-Mail-Adressen** (externe Revision hat kein
Konto); die bestehende Änderungsmail an bisherige und neue Revision bleibt.
Das Ereignis „Zusammenfassung & Versandzeit“ enthält Standard
(sofort/täglich/wöchentlich), Wochentag, Versandzeit, die Digest-Vorlage und
den Knopf „Jetzt ausführen“ für den `mail-digest`-Job. Der Standard gilt für
alle, die auf
[Meine Benachrichtigungen](geplante-jobs-und-benachrichtigungen.md#persönliche-benachrichtigungen-meine-benachrichtigungen)
nichts anderes gewählt haben. `kk_beleg_erinnerung_tage` bleibt unter
`/admin/geplante-jobs`.

Die Zeit-Werte für Freigabe 2 (`freigabe2_reminder_stunden` 24,
`freigabe2_eskalation_stunden` 48, `freigabe2_eskalation_empfaenger`
Default `gruppe:admin`) und Rapporte (`rapport_reminder_stunden` 72,
`rapport_eskalation_stunden` 168, `rapport_eskalation_empfaenger`, leer =
Admin-Gruppe) liegen als eigene Ereignisse auf derselben Seite. Siehe
[geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md#admin-seite-benachrichtigungen).
Der Mail-Typ `iban-warnung` wurde durch `auffaelligkeiten-warnung` ersetzt;
alte `mail_vorlage_iban_warnung_*`-Schlüssel bleiben in bestehenden
Datenbanken ungenutzt liegen.

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
- Empfänger der Prüfnummer (`audit_revision_empfaenger`): werden unter [Benachrichtigungen](#benachrichtigungen-adminbenachrichtigungen) → „Audit-Prüfnummer“ gepflegt (nur E-Mail-Adressen), hier nur Link. Ein Wechsel geht per Mail
  an alte und neue Adresse; Warnung, wenn eine Adresse zu einer Person mit Admin-Rechten gehört;
  Hinweis (auch im Admin-Dashboard), wenn kein Empfänger festgelegt ist.
- Versandrhythmus (`audit_pruefnummer_rhythmus`: monatlich, quartalsweise Jan/Apr/Jul/Okt, jährlich
  Januar) und Versandtag (`audit_pruefnummer_tag`, 1–28). Abschalten sowie Änderung von Rhythmus/Tag
  lösen eine Mail an die Empfänger aus.
- Uhrzeit des nächtlichen Exports (`cron_audit_export_stunde`/`_minute`, Default 03:15) und des
  Mailversands (`cron_audit_pruefnummer_stunde`/`_minute`, Default 07:00), wirksam ohne Neustart.
- Alarmschwelle (`audit_zeitstempel_alarm_tage`, 1–30, Default 3).
- Knopf „Jetzt exportieren und stempeln“ (`POST /admin/zeitstempel/audit-export-jetzt`): führt
  den nächtlichen Lauf `audit-export` sofort aus und zeigt das Ergebnis samt Fehlergrund an.
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
`admin_config`-Key/Value-Store wie jeder andere Schalter. Aktuell vier
Modul-Einträge (Default: **Spesenmodul aktiv**, **Kreditkartenmodul
deaktiviert**, **Rapporte-Modul deaktiviert**):

- **Spesenmodul** (`modul_spesen_aktiv`) — deaktiviert blendet "Spesen einreichen" in der Seitenleiste (Reiter Portal, Gruppe Spesen) aus und lässt `GET /spesen/neu`/`POST /spesen` mit `403` abweisen; bereits eingereichte Spesen-Positionen laufen unverändert durch Freigabe 1/2 (siehe [spesen-einreichung.md](spesen-einreichung.md)).
- **Kreditkartenmodul** (`modul_kreditkarten_aktiv`, Default aus) — deaktiviert blendet "Kreditkartenbelege" in der Seitenleiste (Reiter Portal, Gruppe Belege) aus, blockiert neue Uploads (`GET /kreditkarte`/`POST /kreditkarte/belege` → `403`) und neue Markierungen als Kreditkartenabrechnung; bereits markierte Abrechnungen lassen sich weiter abgleichen, bestehende Teil-Jobs laufen unverändert weiter (siehe [kreditkarten-belege.md](kreditkarten-belege.md#modul-schalter-adminmodule)).
- **Rapporte-Modul** (`modul_rapporte_aktiv`, Default aus) — eingeschaltet erscheint in der Kontierung der dritte Typ «Nur zur Kenntnis (Rapport)»; ausgeschaltet verschwindet die Auswahl, und ein Markieren als Rapport wird mit `409` abgewiesen. Bereits markierte Rapporte laufen unverändert weiter (Bestätigung, Erinnerung, Archivierung). Siehe [rechnungs-workflow.md](rechnungs-workflow.md#9-rapporte-status-kenntnisnahme).
- **Strikte Freigeber1-Prüfung** (`kontierung_strikte_freigeber1_pruefung`, Default aus) — siehe [rechnungs-workflow.md](rechnungs-workflow.md#2-kontierung-status-zugewiesen).

Gedacht als Sammelstelle für künftige, ebenfalls unabhängig einführbare Module.

## Ersteinrichtung (`/admin/ersteinrichtung`)

Nur Superadmin. Geführter Assistent mit 14 Schritten (8 Pflicht), technischer Prüfung, ChurchTools-Test, Testmail und
Auslösen der Kernjobs; Hinweis auf dem Dashboard, den "später" 7 Tage ausblendet. Details: [ersteinrichtung.md](ersteinrichtung.md).

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
Sicherheitsschwellen (SYNC-1) (die Empfänger der Fehler-Mails stehen unter [Benachrichtigungen](#benachrichtigungen-adminbenachrichtigungen) → „Sync-Fehler“) und listet **blockierte Rechnungen**
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

Zeitplan-Konfiguration und manuelles Sofort-Auslösen von neun der sechzehn
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
Lauf-ID an (50 Einträge je Cursor-Seite). Der Bereich hat eigene Filter
(Parameter `h_*`): Objekt, Hintergrundlauf (`lauf_typ`, z. B. `audit-export`),
Aktion, Person (Name oder ID), Zeitraum und Freitext über Objekt-ID,
Vorher/Nachher, Begründung, Request- und Lauf-ID. „Ältere Änderungen“ behält
die Filter. Ist nur ein Filter der Zeitleiste gesetzt, wird der
Änderungsbereich ausgeblendet; die beiden Filter sind voneinander unabhängig.
Laufeinträge (`hintergrundlauf`) halten nur den Status fest, nicht den
Fehlergrund. Lokale Audit-Exportpakete
werden über die CLI erzeugt, siehe [externe Audit-Nachweise](audit-externe-nachweise.md).
