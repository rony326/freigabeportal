# Betrieb & Nutzung

Das Portal erfasst, wer es womit nutzt und wo Fehler auftreten. Zweck: Wartung,
Weiterentwicklung und Sicherheit. Entwurf und Begründung:
[superpowers/specs/2026-10-24-nutzungsdaten-fehler-banner-design.md](superpowers/specs/2026-10-24-nutzungsdaten-fehler-banner-design.md).

## Was erfasst wird – und was nicht

| Daten | Tabelle | Inhalt |
|---|---|---|
| Seitenaufrufe | `nutzung_seitenaufrufe` | Person, Zeitpunkt, Methode, Pfad (`req.path`, **ohne Query-String**), `pfad_muster` (Zahlensegmente als `:id`, z. B. `/kontierung/:id/aufsplitten`), Status, Antwortzeit, Gerätetyp, Browser, Betriebssystem, Anfrage-ID |
| Anmeldungen | `nutzung_anmeldungen` | Zeitpunkt, Person, Erfolg/Grund, IP-Adresse, Geräte-ID, User-Agent, Kennzeichen „neues Gerät“ |
| Geräte | `nutzung_geraete` | je Person und Geräte-ID: erstmals/zuletzt gesehen, User-Agent, Gerätetyp, Browser, Betriebssystem |
| Fehler | `betrieb_fehler` | Anfrage-ID (eindeutig), Zeitpunkt, Person, Methode, Pfad, Status, Meldung, Stacktrace (nur serverseitig), User-Agent, Geräte-ID |
| Fehlermeldungen | `betrieb_fehlermeldungen` | von Personen gemeldete Probleme: Beschreibung (max. 2000 Zeichen), Seite, Verknüpfung zum Fehler, Status `offen`/`in_arbeit`/`erledigt`, Notiz |
| Banner | `banner`, `banner_ausgeblendet` | Mitteilungen und welche Person welches Info-Banner weggeklickt hat |

Seitenaufrufe werden nur für **angemeldete, aktive Personen** und nur für Antworten mit
`text/html` erfasst (Weiterleitungen zählen nicht). Ausgenommen sind die Präfixe
`/api/n8n`, `/internal/cron`, `/branding`, `/downloads/` sowie statische Dateien.
Gespeichert werden **nie** Formularinhalte, Query-Parameter (Suchbegriffe), Beträge,
Dokumente oder Header ausser dem User-Agent. Gerät, Browser und Betriebssystem werden
aus dem User-Agent mit einfachen Regeln bestimmt (`src/services/nutzung.js`).

Erfassen darf eine Anfrage nie scheitern lassen: Fehler beim Schreiben werden
gefangen und höchstens einmal pro Stunde mit `console.error` gemeldet.

## Aufbewahrung

Der Job `nutzungsdaten-bereinigung` (täglich 03:45, Europe/Zürich;
`cron_nutzungsdaten_bereinigung_stunde`/`_minute`) löscht:

| Daten | Frist |
|---|---|
| Seitenaufrufe | 90 Tage |
| Anmeldungen, Fehler, Fehlermeldungen | 365 Tage |
| Geräte | 365 Tage nach `zuletzt_am` |
| `banner_ausgeblendet` | sobald das Banner (`bis`) mehr als 365 Tage abgelaufen ist |

Die Banner selbst bleiben bestehen. Das Löschen von Fehlermeldungen schreibt
Audit-Einträge (Trigger); darin sind `beschreibung`, `seite` und `user_agent` als
`[redacted]` geschwärzt, damit die Inhalte nicht über die Frist hinaus im unveränderlichen
Audit-Log bleiben (Einträge vor dieser Änderung sind nicht nachträglich geschwärzt); die Nutzungstabellen sind bewusst nicht im Audit-Log
(Massendaten). Backups enthalten die Daten bis zu ihrem eigenen Ablauf.

## Recht `betrieb_einsehen` („Betrieb & Nutzung“)

Additives Einzelrecht. `superadmin` hat es über sein Bundle, `manager` **nicht**
(Personendaten; wie `sync_verwalten`/`workflow_eingreifen` ausgenommen). Es erlaubt
alle Seiten unter `/admin/betrieb`, das Bearbeiten von Fehlermeldungen und das
Verwalten der Banner. Vergabe: Admin → Stammdaten → Personen.

## Seiten

| Route | Zugriff | Zweck |
|---|---|---|
| `GET/POST /fehler-melden` | eingeloggt | Problem melden (CSRF); Link „Problem melden“ in der Seitenleiste, auf der Fehlerseite mit vorbelegter Fehler-ID (`?fehler=…`); optional `?seite=/…` |
| `POST /banner/:id/ausblenden` | eingeloggt | Info-Banner für sich selbst wegklicken; Rücksprung auf den Portal-Pfad im Feld `zurueck`, sonst `/pool` |
| `GET /datenschutz` | eingeloggt | Datenschutzhinweis |
| `GET /admin/betrieb` | `betrieb_einsehen` | Übersicht: Geräte-/Browserverteilung, meistgenutzte und langsame Seiten (Median/p90), Fehlerhäufigkeit, aktive Personen; Filter nach Zeitraum und Person |
| `GET /admin/betrieb/personen/:id` | `betrieb_einsehen` | Anmeldungen (letzte 50), Geräte, letzte 100 Aufrufe einer Person |
| `GET /admin/betrieb/fehler`, `/fehler/:requestId` | `betrieb_einsehen` | erfasste Fehler mit Details |
| `GET /admin/betrieb/meldungen`, `/meldungen/:id` (+ `POST`) | `betrieb_einsehen` | Fehlermeldungen; Status und Notiz setzen |
| `GET/POST /admin/betrieb/banner`, `/banner/:id`, `POST /banner/:id/deaktivieren` | `betrieb_einsehen` | Banner anlegen, bearbeiten, deaktivieren |
| `GET/POST /admin/betrieb/datenschutz` | `betrieb_einsehen` | Datenschutztext bearbeiten |

## Neues-Gerät-Mail

Das Gerät wird über das Cookie `fp_geraet` erkannt: 32 Hex-Zeichen zufällig, HttpOnly,
SameSite=Lax, Secure wenn die Session-Cookies Secure sind, 2 Jahre gültig; ein
ungültiger Wert wird ersetzt. „Neues Gerät“ heisst: Diese Geräte-ID wurde für die Person
noch nie gesehen (nicht bei der allerersten Anmeldung überhaupt). Dann geht die Mail
`neues-geraet` an die Person selbst: Zeitpunkt, Gerät, IP-Adresse und Hinweis, wen sie
kontaktieren soll (`betrieb_kontakt_email`; leer = „die Portal-Administration“). Wer das
Cookie löscht oder ein privates Fenster nutzt, gilt als neues Gerät – die Mail sagt das.
Es gibt keine automatische Sperre. Der Mail-Typ ist bearbeitbar (Admin → Benachrichtigungen) und
wird immer sofort zugestellt – im Hintergrund über die Mail-Outbox, die Anmeldung wartet
nicht auf den Mailserver.

## Fehler und „Problem melden“

Unbehandelte Fehler (Ausnahmen) werden mit der Anfrage-ID erfasst (Pfad auf 500 Zeichen
gekürzt). Kaputte Anfrage-Inhalte (Body-Parser, `entity.*`) gelten nicht als Serverfehler:
Antwort 400 „Ungültiger Anfrage-Inhalt.“, erfasst nur mit angemeldeter Person – anonyme
Anfragen füllen `betrieb_fehler` nicht. Die Fehlerseite
zeigt nur die **ersten 8 Zeichen** als Fehler-ID, nie einen Stacktrace; gesucht wird per
Präfix (mindestens 8 Zeichen, auch die volle UUID). Die Seite, auf der das Problem auftrat,
kommt aus einem versteckten Formularfeld `seite` (die Referrer-Policy `no-referrer`
verhindert den Referer); angenommen wird nur ein Portal-Pfad (`/…`, nicht `//`, ohne
Backslash, Leerzeichen, Query oder Hash, höchstens 500 Zeichen). Die Meldung (Beschreibung optional) wird gespeichert und
per Mail `fehlermeldung` an alle Personen mit `betrieb_einsehen` verschickt (immer sofort,
im Hintergrund, bearbeitbare Vorlage; die Dankesseite wartet nicht auf den Mailserver). Dieselbe Anfrage-ID erscheint im Audit-Log, so lassen sich Fehler,
Audit-Einträge und Logs zusammenführen.

## Banner

Arten: `info` (wegklickbar, pro Person serverseitig gemerkt), `wartung` und `warnung`
(nicht wegklickbar bis zum Ende des Zeitraums). Reihenfolge: `wartung`, `warnung`, `info`,
dann `von` aufsteigend. Nur Text (escaped), Zeilenumbrüche erlaubt, optionaler Link
`https://…` oder `/…`. Banner erscheinen für Angemeldete im Shell-Layout, nicht auf
öffentlichen Seiten. Beim ersten Start wird einmalig ein Info-Banner auf den
Datenschutzhinweis angelegt (Marker `betrieb_datenschutz_banner_angelegt`, er wird nach
Löschen nicht neu angelegt).

## Datenschutzhinweis und revDSG

`/datenschutz` zeigt den Text aus `datenschutz_text` (Platzhalter `%kontakt%`), in der
Seitenleiste in der Gruppe „Persönlich“ verlinkt. Er nennt, welche Daten erfasst werden, den Zweck, die
Aufbewahrung und wer Zugriff hat. Bezug zum Schweizer Datenschutzgesetz (revDSG):
Information der Betroffenen, Zweckbindung (nur Wartung, Weiterentwicklung, Sicherheit),
Datensparsamkeit (keine Inhalte, kein Query-String) und begrenzte Aufbewahrung durch den
automatischen Löschjob. Der Standardtext nennt auch das Cookie `fp_geraet` (Erkennung
neuer Geräte) sowie die Fristen für Fehlermeldungen (1 Jahr) und Geräte (1 Jahr nach
letzter Nutzung). Der Standard gilt nur, solange noch kein Text gespeichert ist:
**bestehende Installationen behalten ihren gespeicherten Text** und müssen ihn bei Bedarf
unter Admin → Betrieb & Nutzung → Datenschutz selbst ergänzen. Der Text muss von der
Betreiberin bei Bedarf rechtlich geprüft und angepasst werden.

## Wartungsmodus für Updates

Für Updates und Backups gibt es unter **Admin → Betrieb → Wartungsmodus** (`/admin/wartungsmodus`, Recht
`wartungsmodus_schalten`, Standard nur Superadmin) einen Schalter. Zweck: ein **konsistenter Stand** für das
Backup — während des Modus verändern weder Rechnungsverarbeitung noch Mailversand die Daten.

Empfohlener Ablauf: **Modus an → Backup ziehen → Update einspielen → Modus aus.**

Solange der Modus aktiv ist:

- **Personen:** sehen auf jeder Seite (ausser Login, `/healthz`) eine Wartungsseite (HTTP 503) mit dem optionalen
  Hinweis (z. B. «Update bis ca. 14:00»). Wer das Recht hat, arbeitet weiter und sieht oben einen Banner
  «Wartungsmodus aktiv».
- **Mails:** werden nicht versendet. Die Outbox hält alles zurück (Status `eingereiht`/`geplant`, kein Versuch
  gezählt), nichts geht verloren; nach dem Ausschalten stellt der Job `mail-zustellung` bzw. der Digest zu.
  Dasselbe gilt für Sicherheitsalarme. «Erneut versenden» im Mail-Protokoll sendet nichts und weist darauf hin.
- **Rechnungseingang:** `/api/n8n/jobs`, `/api/n8n/kk-belege`, `/api/n8n/rapporte` und `/internal/cron/*`
  antworten mit **503** und `Retry-After: 300` (JSON `{"error":"wartungsmodus"}`). Das Portal puffert nichts;
  **n8n muss die Anfrage später erneut versuchen** (siehe [n8n-schnittstelle.md](n8n-schnittstelle.md#wartungsmodus-503)).
  Kommt trotzdem etwas rein, entstünde ein Delta zum Backup — genau das soll vermieden werden.
- **Offen bleiben:** `/api/n8n/backup/*` (Backup-Abholung), `/healthz` und `/auth/*`.
- **Geplante Jobs** pausieren (Läufe werden übersprungen, nicht nachgeholt); die **Datenbank-Sicherung läuft
  weiter**, sie liest nur.
- **Audit-Log:** Ein- und Ausschalten (und der Hinweistext) steht als Änderung an `admin_config`
  (`wartungsmodus_aktiv`, `wartungsmodus_hinweis`) mit Person und Zeitpunkt im Audit-Log.
- **`/healthz`** (mit Monitoring-Schlüssel) enthält `"wartungsmodus": true|false`; der Modus ist kein Fehler.

## Bekannte Grenzen

- Für Problemmeldungen gibt es **kein eigenes Rate-Limit**, nur den allgemeinen
  Session-Limiter.
- Die Übersicht berechnet Median und p90 im Speicher aus den Zeilen; bei der heutigen
  Datenmenge unkritisch, bei sehr viel Verkehr müsste es in SQL verlagert werden.
