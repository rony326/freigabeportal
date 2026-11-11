# Changelog

Alle nennenswerten Änderungen am Freigabeportal. Versionierung nach
[Semantic Versioning](https://semver.org/lang/de/).

## [1.2.0] – 2026-11-11

Release Notes: [docs/releases/v1.2.0.md](docs/releases/v1.2.0.md). Enthält eine
Datenbank-Migration (läuft beim Start).

- Rechte pro Gruppe: Admin → Gruppenrechte (Superadmin, Manager, Buchhaltung),
  effektive Rechte = Gruppen ∪ Einzelrechte, Herkunft in der Personenliste,
  «Gruppenrechte verwalten» fest für Superadmin, alle bisher rollengebundenen
  Admin-Seiten mit eigenem Recht, Änderungen im Audit-Log.
- Konten mit Buchungsart (Rechnung / Gutschrift / beides): Kontierung und
  Aufsplitten filtern die Konto-Auswahl nach Typ, serverseitige Prüfung; Spesen
  als Rechnung, Kreditkarten nach Vorzeichen; Standard-Konto von Lieferanten
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
