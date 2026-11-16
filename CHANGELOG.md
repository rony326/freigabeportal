# Changelog

Alle nennenswerten Änderungen am Freigabeportal. Versionierung nach
[Semantic Versioning](https://semver.org/lang/de/).

## Unveröffentlicht

- Personen: Die Liste «Herkunft der Rechte» entfällt. Liefert eine Gruppe ein Recht, ist dessen Checkbox
  angehakt und grau, daneben «über Gruppe X»; ein zusätzlich direkt vergebenes Recht bleibt beim Speichern
  erhalten («(auch direkt)»). Feste Rechte wie «Gruppenrechte verwalten» stehen als Textzeile darunter.

## [1.4.0] – 2026-11-16

Versandquittung für Bexio und Durchlauf-Test. Release Notes: [docs/releases/v1.4.0.md](docs/releases/v1.4.0.md).
Automatische Datenbank-Migration (neue Tabelle `bexio_versand`), keine neuen Umgebungsvariablen für das Portal.

- Durchlauf-Test (`npm run durchlauf`, [docs/durchlauf-test.md](docs/durchlauf-test.md)): automatischer
  End-to-End-Durchlauf gegen eine Testinstanz mit Playwright. Person A und B melden sich einmal an
  (`npm run durchlauf:anmelden -- a|b`, Sitzung 8 h); nach der von Hand geschickten Testmail kontiert das Werkzeug
  als A, gibt als B frei und wartet auf die Abholung durch n8n (optional Archivquittung über den nur lesenden
  Abruf `archivierung-ausstehend`). Stufe «An Bexio gemeldet»: liest die Versandquittung auf der Belegseite
  `/zeitstempel-pruefen?jobId=` (als B, sonst A); `DURCHLAUF_ENDE=bexio_gemeldet` wartet darauf, sonst nur zur Info.
  Bericht je Beleg und Schritt, Fehlerbilder, Handprüf-Liste für Paperless/Bexio (mit Message-ID, falls gemeldet).
  Konfiguration in `.env.durchlauf` (Vorlage `.env.durchlauf.example`), ohne Standard-Zieladresse. Keine Änderung am Portal.
- Versandquittung für Bexio: n8n meldet nach dem Mailversand an das Bexio-Eingangspostfach die Antwort des
  Mailservers an `POST /api/n8n/jobs/:id/bexio-versand-bestaetigen` (Export-ID, Empfänger, Message-ID,
  SMTP-Antwort, Versandzeitpunkt). Nur 2xx ohne abgelehnten Bexio-Empfänger wird quittiert (sonst 422);
  gleiche Message-ID ist idempotent. Nachzügler über `GET /api/n8n/jobs/bexio-versand-ausstehend`. Die
  Belegseite («Jetzt prüfen») zeigt «An Bexio gesendet: …» bzw. «noch nicht gemeldet». Die SMTP-Antwort belegt
  nur die Annahme durch den eigenen Mailserver, nicht die Zustellung bei Bexio. Automatische Migration: neue
  append-only Tabelle `bexio_versand` (mit Audit). n8n: neuer HTTP-Request-Knoten nach «Send Email»
  ([Anleitung](docs/n8n-schnittstelle.md#versand-an-bexio-bestätigen)).

## [1.3.0] – 2026-11-16

Sicherheits- und Stabilitäts-Release nach der Prüfung vom 15.11.2026 (Befunde S1–S9, U1–U5, B1–B5).
Release Notes: [docs/releases/v1.3.0.md](docs/releases/v1.3.0.md). Neue optionale Umgebungsvariablen,
automatische Datenbank-Migration, neue 503-Antworten für n8n.

- PDF-Verarbeitung in Worker-Threads (B2): n8n-Eingang, Kreditkartenbelege, Spesen, Beleg anhängen,
  Stempel bei Freigabe 2 und Rapport, Splitgruppen-Dokument. Bei Überlastung 503 mit `Retry-After: 60`
  (Personen: Formular mit Hinweis, nichts gespeichert; n8n: `pdf_verarbeitung_ausgelastet`). Neuer Dienst
  `pdf_verarbeitung` auf Statusseite und `/healthz`. Neue Variablen `PDF_WORKER`, `PDF_WORKER_ANZAHL`,
  `PDF_WORKER_SPEICHER_MB`, `PDF_WORKER_ZEITLIMIT_FAKTOR`. Hauptprozess lädt mupdf nicht mehr (~25 MB weniger).
- Gleichzeitigkeit: identische PDFs ergeben einen Vorgang, zwei Kontierungen mit Beleg ergeben einmal 409,
  eine Splitgruppe wird genau einmal exportiert. Beleg wird vor dem Speichern angehängt (bisher 500 bei
  gespeicherter Kontierung ohne Beleg).
- ChurchTools-Gruppen (S1, B1, B5): nur aktive Mitglieder, vollständige Liste (bisher 10), ID aus
  `domainIdentifier`, Abbruch statt halber Liste. Doku zum sofortigen Rollenentzug (S9).
- Bildbelege höchstens 40 Megapixel (S2); PNG muss vollständig sein (abgeschnittenes PNG liess pdf-lib endlos
  hängen). Uploads höchstens 60 MB je Anfrage, Zuständigkeit vor dem Upload (S3). Grenzen auf der Spesen-Seite (U5).
- IBAN-Änderungen lösen sofort die Mail `iban-aenderung` aus; Warnung in Freigabe 2 bei IBAN jünger als
  14 Tage (S4). Migration: `kreditor_ibans.erstellt_von`, Mailtyp im CHECK von `mail_log`.
- Schreib-Limits je Person: 10 Spesenabrechnungen, 5 Fehlermeldungen pro Stunde (S5). Öffentlicher Begrenzer
  zählt Angemeldete je Person statt je IP (Büro hinter einer IP).
- TSA: Adresse nur `https://` und öffentlich (S6), `TSA_PASSWORT` hat Vorrang vor dem Datenbankwert (S7),
  Sperrliste bricht beim Lesen bei 4 MB ab (B4).
- Texteingaben mit Höchstlängen und 400 statt 500 bei mehrfach gesendeten Feldern (S8); Begründung nur aus
  Leerzeichen gilt als leer (B3).
- Rücksprung nach der Anmeldung auf die ursprüngliche Seite (U1), Hinweis vor Sitzungsablauf (U2), Rückfrage
  vor heiklen Aktionen (U3), 429 und Download-Fehler als Fehlerseite statt JSON (U4).
- Abhängigkeiten: mupdf 1.28.6, express-rate-limit 8.7.4, nodemailer 10.6.0, csrf-csrf 4.1.0,
  read-excel-file 9.3.17. Monatlicher Termin für `npm audit` und pdf.js-Prüfung in der Betriebsdoku.

## [1.2.3] – 2026-11-15

Bedienungs-Release für Gelegenheitsnutzer. Release Notes: [docs/releases/v1.2.3.md](docs/releases/v1.2.3.md).
Keine Datenbank-Migration, keine neuen Umgebungsvariablen.

- Schriftgrösse pro Person (Menü „A“: Normal, Gross, Sehr gross), grössere Klickflächen.
- Hilfe-Knopf mit Kurzanleitung je Seite (`src/services/hilfetexte.js`).
- Grüner Bestätigungshinweis nach Freigeben, Ablehnen, Kontieren und Weitergabe wegen Befangenheit.
- Leere Listen erklären, was zu tun ist.
- Befangenheits-Frage als Karte mit zwei Auswahlknöpfen (Kontierung, Freigabe 2, Spesen-Freigabe 1);
  bei „Ja“ erscheint die Folge, „Ablehnen“ verschwindet. Server-Logik unverändert.
- Menü-Design: aktiver Punkt ohne Balken links, als getönte abgerundete Fläche.

## [1.2.2] – 2026-11-11

Dokumentations-Release, keine Code-Änderung. Release Notes: [docs/releases/v1.2.2.md](docs/releases/v1.2.2.md).

- Dokumentation: sämtliche Quelldateien (`src/`) haben jetzt einen Dateikopf, kurze
  Funktionsdoku (JSDoc bei Services und Repos) und Routenkommentare; alle
  Kommentare sind deutsch. Neu: [docs/code-landkarte.md](docs/code-landkarte.md)
  (Einstieg für Übernehmende). Korrigiert: Zahl der Hintergrund-Jobs in
  `architektur.md`, Sitzung/Cookie und Sicherheits-Header in `architektur.md` und
  `auth-und-rechte.md`, fehlende Variablen im README. Keine Code-Änderung.

## [1.2.1] – 2026-11-11

Sicherheits-Wartungsversion nach einem vollständigen Sicherheitsdurchgang (keine
kritischen oder hohen Funde). Release Notes:
[docs/releases/v1.2.1.md](docs/releases/v1.2.1.md). Keine Datenbank-Migration.
**Einmalige Neuanmeldung aller Personen** (neuer Cookie-Name).

- Sitzungs-Cookie hinter HTTPS als `__Host-portal.sid`, Sitzungsdauer 8 statt 24
  Stunden (Rollenentzug aus ChurchTools wirkt früher).
- Wartungsmodus: Warnung im Banner nach über 4 Stunden (Sicherheitsalarme werden
  zurückgehalten), `/downloads/*` antwortet für Nicht-Berechtigte mit JSON-503,
  Pfadprüfungen unabhängig von Gross-/Kleinschreibung.
- n8n-Eingang: abgelehnter Dateiname wird als JSON-Text geloggt (keine
  Log-Injection).
- Superadmin-Prüfung in Freigabe 2, Spesen-Freigabe 1, Ablehnung und
  Kontierungszugriff über `personHasRole` statt handgebauter Gruppenprüfung.

## [1.2.0] – 2026-11-11

Release Notes: [docs/releases/v1.2.0.md](docs/releases/v1.2.0.md). Enthält eine
Datenbank-Migration (läuft beim Start).

- Rechte pro Gruppe: Admin → Gruppenrechte (Superadmin, Manager, Buchhaltung),
  effektive Rechte = Gruppen ∪ Einzelrechte, Herkunft in der Personenliste,
  «Gruppenrechte verwalten» fest für Superadmin, alle bisher rollengebundenen
  Admin-Seiten mit eigenem Recht, Änderungen im Audit-Log.
- Konten mit Buchungsart (Rechnung / Gutschrift / beides): Kontierung und
  Aufsplitten filtern die Konto-Auswahl nach Typ, serverseitige Prüfung; Spesen
  als Rechnung, Kreditkarten nach Vorzeichen; «Art des Belegs» steht in der Kontierung vor dem Konto; Standard-Konto von Lieferanten
  muss Rechnungen erlauben.
- Wartungsmodus für Updates: Wartungsseite (503), Mails zurückgehalten, n8n-Eingang
  503 mit Retry-After, geplante Jobs pausiert (ausser Datenbank-Sicherung).

## [1.1.1] – 2026-11-11

Wartungsversion. Release Notes:
[docs/releases/v1.1.1.md](docs/releases/v1.1.1.md).

- Admin → Kreditoren: «Neuer Kreditor» auf eigener Seite statt Formular unter
  der Liste; Zuweisungsregel und IBAN hinzufügen als Karten.
- Admin → Benachrichtigungen: Empfänger-Kärtchen und gewähltes Ereignis im Look
  des übrigen Portals.
- Markenfarbe statt Standard-Blau für angehakte Felder, Fokusrahmen und
  Nummern-Kreise.
- Release Notes ergänzt um wichtige 1.1.0-Punkte (Aufsplitten verlangt einen
  Lieferanten, Schnellanlage nur für Admins, Benachrichtigungen nur für
  Superadmins).

## [1.1.0] – 2026-11-11

Release Notes: [docs/releases/v1.1.0.md](docs/releases/v1.1.0.md).

- Betrugserkennung: Zahlungsart und Pflicht-IBAN pro Lieferant (Lieferanten
  ohne IBAN sind bei der Kontierung nicht wählbar), internationale IBANs in den
  Stammdaten, „IBAN merken“ entfernt.
- Prüf-Popup vor dem Speichern der Kontierung und beim Aufsplitten
  (Auffälligkeiten A–G, eine gemeinsame Warn-Mail `auffaelligkeiten-warnung`,
  ersetzt `iban-warnung`), manuelle IBAN-Kontrolle ohne QR-Code,
  Anzeige bestätigter Auffälligkeiten für Freigeber und Admin.
- Admin → Benachrichtigungen pro Ereignis (Wann/Wer/Was, Empfänger-Auswahl,
  Variablen-Knöpfe, Live-Vorschau, Test-Mail) ersetzt Eskalationszeiten und
  Mail-Einstellungen; alte URLs leiten weiter.
- Du-Form auf `/audit-pruefen` und in allen Standard-Mailtexten, Logo
  verlinkt auf die Startseite und bleibt mobil links.

## [1.0.1] – 2026-11-10

Wartungsversion. Release Notes:
[docs/releases/v1.0.1.md](docs/releases/v1.0.1.md).

- Audit-Log: Filter für die Änderungshistorie (Objekt, Hintergrundlauf,
  Aktion, Person, Zeitraum, Freitext).
- Admin → Zeitstempel: Knopf „Jetzt exportieren und stempeln“ zeigt das
  Ergebnis des Audit-Exports samt Fehlergrund sofort an.

## [1.0.0] – 2026-11-09

Erste produktive Version. Ausführliche Release Notes:
[docs/releases/v1.0.0.md](docs/releases/v1.0.0.md).

- Rechnungsfreigabe: Eingang über n8n, Pool, Kontierung inkl. Gutschriften
  und Aufsplitten, Freigabe 1/2 im Vier-Augen-Prinzip, Ablehnung,
  Splitgruppen-Export, Rapporte zur Kenntnisnahme, Kommentare.
- Spesen-Einreichung und Kreditkarten-Belege mit Abgleich gegen die
  Monatsabrechnung.
- Auswertung mit Budgets, Durchlaufzeiten und CSV-Export.
- QR-Bill-Erkennung mit IBAN-Betrugsprüfung, Duplikaterkennung.
- RFC3161-Zeitstempel mit lokaler Ketten-/Sperrlistenprüfung,
  snapshot-gebundener Export, Archivquittung, Audit-Log und
  zeitgestempelte Audit-Pakete für die Revision.
- Admin-Bereich mit fünfzehn Einzelrechten, Ersteinrichtungs-Assistent,
  Statusseite, Testmodus, verschlüsselten Backups und Offline-Restore.
- Einheitliches, responsives Layout mit Hell-/Dunkelmodus.
- Mindestversion Node.js 22.23.4.

## [0.1.0-rc.1] – 2026-08-24

Release-Kandidat: Fundament mit ChurchTools-Login, Admin-Bereich,
n8n-Schnittstelle, Freigabe-Workflow und Datenbank-Backup.

[1.1.1]: https://github.com/rony326/freigabeportal/releases/tag/v1.1.1
[1.1.0]: https://github.com/rony326/freigabeportal/releases/tag/v1.1.0
[1.0.1]: https://github.com/rony326/freigabeportal/releases/tag/v1.0.1
[1.0.0]: https://github.com/rony326/freigabeportal/releases/tag/v1.0.0
[0.1.0-rc.1]: https://github.com/rony326/freigabeportal/releases/tag/v0.1.0-rc.1
