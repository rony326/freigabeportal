# Changelog

Alle nennenswerten Änderungen am Freigabeportal. Versionierung nach
[Semantic Versioning](https://semver.org/lang/de/).

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

[1.0.0]: https://github.com/rony326/freigabeportal/releases/tag/v1.0.0
[0.1.0-rc.1]: https://github.com/rony326/freigabeportal/releases/tag/v0.1.0-rc.1
