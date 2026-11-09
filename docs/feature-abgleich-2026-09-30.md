# Dokumentation gegen Features geprüft

Stand: 2026-11-09, Release **1.0.0** (erster Abgleich 2026-09-30).
Grundlage: Router und Middleware in `src/app.js`, Services,
Datenbankmigrationen und vorhandene Tests. Dies ist ein Abgleich mit dem
Repository, keine Abnahme der produktiven Installation. Historische Design-
und Umsetzungspläne bleiben als solche erhalten.

## Implementierter Funktionsumfang

| Bereich | Im Code vorhanden | Dokumentation |
|---|---|---|
| Anmeldung und Rechte | ChurchTools-OAuth2, Personen-Sync, Rollen `buchhaltung`/`manager`/`superadmin`, fünfzehn Einzelrechte | [Rechte](auth-und-rechte.md), [Sync](personen-sync.md) |
| Rechnungen | Pool, Zuweisung, Kontierung, Gutschriften, Freigabe 1/2, Interessenskonflikte, Ablehnung, Aufsplitten, Splitgruppen-Export | [Workflow](rechnungs-workflow.md) |
| Rapporte | Belege nur zur Kenntnis: Bestätigung durch alle Empfänger:innen, Erinnerung/Eskalation, Archivierung über eigene n8n-Endpunkte | [Rapporte](rechnungs-workflow.md#9-rapporte-status-kenntnisnahme) |
| Kommentare | Kommentare mit @Erwähnungen, Mails, Abschnitt auf dem finalen PDF | [Kommentare](kommentare.md) |
| Stellvertretung | Selbstverwalteter Ferienmodus mit additiver Stellvertretung | [Workflow](rechnungs-workflow.md#ferienmodus--abwesenheits-stellvertretung) |
| Spesen | Einzel-/Sammeleinreichung, eigene Freigabe 1, zweite Freigabe, Modul abschaltbar | [Spesen](spesen-einreichung.md) |
| Kreditkarten | Upload, Mail-Entwürfe, Kartenerkennung, Abgleich, Vorschläge, Erinnerungen, Fristlöschung | [Kreditkarten](kreditkarten-belege.md) |
| Auswertung | Kennzahlen, Budget pro Konto, Durchlaufzeit, Engpässe, Lieferanten, CSV-Export, Budget-Import | [Auswertung](auswertung.md) |
| Zahlungsintegrität | QR-/IBAN-Prüfung, Zahlungsbestätigung, unveränderliche Snapshots, Altfallentscheidungen | [Export und Zahlung](export-und-zahlungsintegritaet.md) |
| Archivübergabe | Exportmanifest, Datei-Hashbindung, Archivquittung; externer Workflow erforderlich | [Paperless-Vertrag](n8n-paperless-archivierung.md) |
| Zeitstempel | Anfrage-/ESS-Bindung, lokale Root- und CRL-Prüfung, automatische CRL-Erneuerung, gespeicherte Evidenz, Nachholung | [Zeitstempel](zeitstempel-und-pruefbescheinigung.md), [Vertrauensanker](tsa-vertrauensanker.md) |
| Administration | Stammdaten, Rechte, Module, Branding, Mailvorlagen, Jobpläne, Quarantäne, laufende Vorgänge mit Umhängen, Einrichtungsassistent | [Admin](admin-bereich.md), [Ersteinrichtung](ersteinrichtung.md) |
| Betrieb | Statusseite, `/healthz` mit Überwachungsschlüssel, Nutzungsdaten, Fehlermeldungen, Banner, Datenschutzhinweis | [Status](statusseite-und-monitoring.md), [Betrieb](betrieb-und-nutzung.md) |
| Testmodus | Abgeschottete Spielwiese mit Beispieldaten und Test-Postfach | [Testmodus](testmodus.md) |
| Hintergrundverarbeitung | Sechzehn Scheduler-Jobs, persistente Mailzustellung und Digest | [Jobs](geplante-jobs-und-benachrichtigungen.md) |
| Sicherung | Verschlüsselte Backups, separater Download-Key, Offline-Restore/Rollback, Prozesssperre | [Backups](backup-verschluesselung.md), [Restore](offline-restore.md) |
| Audit | Fachliche Zeitleiste, Änderungsprotokoll, Request-/Lauf-IDs, Zugriffsverweigerungen, nächtliche TSA-gestempelte Audit-Pakete, öffentliche Prüfseite `/audit-pruefen` | [Audit-Korrelation](audit-paket-request-korrelation.md), [Härtung](audit-paket-haertung-2026-09-29.md), [Externe Nachweise](audit-externe-nachweise.md) |
| Oberfläche | Einheitliches Layout mit Seitenleiste, Tabellen-/Kachelansicht, Hell-/Dunkelmodus, responsive bis 360 px, CSP mit Nonce | [Architektur](architektur.md#oberfläche-layout-und-responsive) |

## Bei den Abgleichen korrigiert

2026-11-09 (Release 1.0.0):

- README und Architektur: Node-Mindestversion 22.23.4 statt 22.13.0
  (wie `engines` in `package.json`).
- Architektur: `/internal/cron` löst zehn statt acht Jobs aus.
- README Go-Live-Checkliste: Cron-Routen `rapport-erinnerungen` und
  `tsa-crl-aktualisierung` ergänzt.
- Rechte: Rollentabelle beschrieb den Manager noch mit „nur `/admin/personen`“;
  korrigiert auf das tatsächliche Rollen-Bundle.
- Dokumentationsindex: historische Prüf- und Review-Berichte verlinkt.

2026-09-30:

- Architektur: elf statt sechs Jobs; Bootstrap mit Datenspeichersperre,
  Aktivierungsdatei und Migrationen; fehlende Kreditkarten-/Ferienmodus-Routen,
  separater Backup-Key sowie CSRF-/Audit-Middleware ergänzt.
- Rechte: elf statt sieben/neun Einzelrechte und sieben exklusive
  Superadmin-Bereiche; zusätzliche Rechte für Sync-Konfiguration/Force-Aktionen.
- Audit-Ansicht: Kreditkartenereignisse und separater Änderungsbereich ergänzt,
  einschliesslich der Einschränkung, dass dessen Einträge nicht fachlich gefiltert werden.
- Datenmodell: zusätzliche Nachweis-/Betriebstabellen, finale Hashes und
  gespeicherte TSA-Pflicht ergänzt; frühere Live-Restore-Erklärung entfernt.
- Zeitstempel: neue Token-Prüfung und eingeschränkte Upload-Verifikation
  unterschieden; automatische Quarantäne verwaister finaler PDFs dokumentiert.
- Dokumentationsindex: Archivvertrag, Vertrauensanker und Audit-Korrelation
  verlinkt; Backup-Downloadpfad in der Audit-Dokumentation korrigiert.

## Entwürfe und verbleibende Grenzen

**Raumvermietung**, **Vertragsmanagement** und der **direkte
Mail-Empfang/-Versand im Portal** sind Design-Entwürfe unter
`superpowers/specs/`; der **Ferienplaner** liegt als Entwurf auf einem
separaten Branch; dafür gibt es keine implementierten Router, Services,
Views oder Fachtabellen. Der Rechnungseingang erfolgt über n8n; ein manueller
PDF-Upload von Rechnungen im Portal ist bewusst nicht vorgesehen.

Die produktive n8n-/Paperless-Umstellung (inkl. Rapport-Zweig) und
Betriebsabnahmen bleiben offen. Die Upload-Prüfansicht führt keine historische
TSA-Ketten-/Sperrprüfung durch; LTV und OCSP fehlen. Audit-Pakete entstehen
seit 2026-10-23 automatisch (Jobs `audit-export`, `audit-pruefnummer`) und
werden per RFC3161 gestempelt; nur Prüfnummern gehen per Mail an die
Revision. Ein automatischer Transport der Paketinhalte und ein unabhängig
kontrolliertes unveränderliches Ziel sind weiterhin nicht implementiert.
Altfallentscheidungen besitzen einen eigenen unveränderlichen Nachweis und
sind seit 2026-10-23 auch in der zentralen Audit-Trigger-Liste enthalten.
