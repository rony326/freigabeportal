# Changelog

Alle nennenswerten Änderungen am Freigabeportal. Versionierung nach
[Semantic Versioning](https://semver.org/lang/de/).

## Unveröffentlicht

- Abhängigkeiten aktualisiert (ohne Hauptversionssprung): mupdf 1.28.0 → 1.28.6, express-rate-limit
  8.6.2 → 8.7.4, nodemailer 10.2.1 → 10.6.0, csrf-csrf 4.0.3 → 4.1.0, read-excel-file 9.3.12 → 9.3.17.
- Doku: `docs/betrieb-und-nutzung.md` hält einen monatlichen Termin fest (`npm audit` und Prüfung der
  mitgelieferten pdf.js-Kopie, aktuell 6.2.108, auf neue Meldungen).

- Texteingaben (Befund S8): Absender, Rechnungsnummer, Begründungen, Verwendungszweck, Titel, Positionen,
  Bemerkungen, Lieferantenname und Fehlerbeschreibung haben jetzt Höchstlängen (einzeilig 200,
  Rechnungsnummer 100, Texte 2000 Zeichen), festgelegt an einer Stelle (`src/utils/eingabe.js`), geprüft auf
  dem Server und als `maxlength` in den Formularen. Mehrfach gesendete oder verschachtelte Felder enden
  nicht mehr in Fehler 500, sondern in einer verständlichen Fehlermeldung (400, bei Feldern am Feld).
  Mehrere Positionen (Spesen, Aufsplitten) bleiben möglich.
- Pflichtbegründungen (Befund B3): Eine Begründung nur aus Leerzeichen gilt als leer (Ablehnung und
  Interessenskonflikt in Kontierung, Aufsplitten, Freigabe 2 und Spesen-Freigabe 1); gespeichert wird der
  getrimmte Text.
- Schreib-Limits je Person (Befund S5): Spesen einreichen höchstens 10 Abrechnungen, Problem melden
  höchstens 5 Meldungen je Stunde und angemeldeter Person (bisher nur der allgemeine Limiter mit
  300 Anfragen je 15 Minuten). Bei Überschreitung Fehlerseite 429 mit Wartezeit bzw. JSON.
  Formularfehler (Status 400) zählen nicht mit.
- ChurchTools-Gruppenmitglieder (S1, B1, B5): Es zählen nur noch aktive Mitgliedschaften
  (`group_member_statuses[]=active`, zusätzlich im Code geprüft); Anfragen, Wartelisten und
  zur Löschung vorgemerkte Einträge erhalten keine Rolle mehr. Die Mitgliederliste wird mit
  `limit=200` seitenweise vollständig gelesen (bisher nur die ersten 10). Die Personen-ID wird aus
  `person.domainIdentifier` gelesen, ersatzweise aus `personId`. Ein Fehler auf einer Seite
  bricht ab, statt eine unvollständige Liste zu liefern. Bisher wegen der 10er-Grenze fehlende
  Rolleninhaber erhalten ihre Rolle beim nächsten Sync zurück.
- Doku (S9): `docs/auth-und-rechte.md` erklärt, dass ein Rollenentzug erst mit dem nächtlichen Sync
  oder der nächsten Anmeldung wirkt und wie der Sync von Hand gestartet wird.
- Bild-Belege (JPG/PNG) werden vor dem Einbetten auf höchstens 40 Megapixel geprüft (Breite und
  Höhe aus dem Bildkopf, ohne Dekodieren); zu grosse oder nicht lesbare Bilder werden mit
  verständlicher Meldung abgelehnt statt den Prozess zu blockieren (Befund S2). Gilt für Spesen,
  Kontierung, Aufsplitten, Kreditkarten-Belege, KK-Abgleich und den n8n-Belegeingang.
- Upload-Anfragen sind auf 60 MB gesamt begrenzt (bisher bis zu 500 MB je Anfrage im
  Arbeitsspeicher); bei Überschreitung wird sofort mit Fehler 413 und einer verständlichen
  Seite abgebrochen. Auf `/kontierung/:id` (Kontieren, Aufsplitten, KK-Abgleich) wird die
  Zuständigkeit schon vor dem Upload geprüft (Befund S3).
- Spesen-Seite nennt die Grössengrenzen für Belege (Datei, Megapixel, gesamt) (Befund U5).

Korrekturen aus der Prüfung 2026-11-15 (Anmeldung, Sitzung, Fehlerseiten). Keine Datenbank-Migration,
keine neuen Umgebungsvariablen.

- Rücksprung nach der Anmeldung: Wer ohne Sitzung einen Link auf eine geschützte Seite öffnet, wird
  angemeldet und landet danach dort (statt immer in `/pool`). Nur eigene Seitenpfade, nie bei POST,
  Downloads oder Maschinenrouten. Die 401-Seite hat eine freundliche Überschrift und den Knopf «Anmelden».
- Sitzungsablauf: Auf Formularseiten erscheint 10 Minuten vor dem Ablauf ein Hinweis «Deine Anmeldung
  läuft um HH:MM ab»; 401- und CSRF-Fehlerseite sagen klar, dass die Anmeldung abgelaufen ist.
  Die 8 Stunden bleiben unverändert, ohne Keep-alive.
- Fehler 429 (zu viele Anfragen) und die Fehler von `/downloads/:id/oeffnen` erscheinen im Browser als
  normale Fehlerseite (429 mit «in etwa N Minuten»); fetch- und Maschinenaufrufe bekommen weiter JSON.

Korrekturrunde nach der Prüfung vom 2026-11-15 (Admin-Bereich).

- S7: Umgebungsvariable `TSA_PASSWORT` hat Vorrang vor dem in der Datenbank gespeicherten TSA-Passwort;
  der Datenbankwert bleibt Rückfall. Das Formular unter Admin → Zeitstempel weist darauf hin (ohne das Passwort anzuzeigen).
  README und `.env.example` ergänzt.
- B4: Der Download einer TSA-Sperrliste zählt die Bytes beim Lesen mit und bricht bei mehr als 4 MB ab
  (Verbindung wird geschlossen), statt die Grenze erst nach dem vollständigen Laden zu prüfen.
- S6: Die TSA-Adresse muss `https://` sein und auf einen öffentlich erreichbaren Server zeigen (keine privaten,
  Loopback- oder Link-Local-Ziele; Hostnamen werden aufgelöst, jede Adresse geprüft). Eine bereits gespeicherte,
  nun unzulässige Adresse (z. B. `http://`) wird weiter benutzt, aber beim Start im Log und auf der Seite Admin →
  Zeitstempel gewarnt. Prüfung nur beim Speichern, nicht bei jeder Verwendung (DNS-Rebinding, Ausfallrisiko).
- S4: Wer eine Lieferanten-IBAN hinzufügt oder löscht (oder einen Lieferanten mit IBAN anlegt), löst immer sofort die
  Mail `iban-aenderung` an Buchhaltung und Administration aus (Empfänger und Text unter Admin → Benachrichtigungen
  einstellbar). In Freigabe 2 erscheint ein Warnkasten, wenn die IBAN der Rechnung jünger als 14 Tage ist.
  Datenbank: neue Spalte `kreditor_ibans.erstellt_von` (Altbestand NULL = unbekannt) und neuer Mailtyp
  `iban-aenderung` im CHECK von `mail_log` (automatische Migration beim Start).
- U3: Rückfrage vor heiklen Aktionen: IBAN löschen, Zuweisungsregel löschen, Datei endgültig löschen (Quarantäne),
  Konto deaktivieren, Kreditkartenbeleg verwerfen, Rapport-Markierung aufheben (Rapport-Seite und Vorgang im Admin).

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
