# Dokumentation gegen Features geprüft

Stand: 2026-09-30. Grundlage: Router und Middleware in `src/app.js`,
Services, Datenbankmigrationen und vorhandene Tests. Dies ist ein Abgleich
mit dem Repository, keine Abnahme der produktiven Installation.
Historische Design- und Umsetzungspläne bleiben als solche erhalten.

## Implementierter Funktionsumfang

| Bereich | Im Code vorhanden | Dokumentation |
|---|---|---|
| Anmeldung und Rechte | ChurchTools-OAuth2, Personen-Sync, Rollen, elf Einzelrechte | [Rechte](auth-und-rechte.md), [Sync](personen-sync.md) |
| Rechnungen | Pool, Zuweisung, Kontierung, Freigabe 1/2, Interessenskonflikte, Ablehnung, Aufsplitten, Gruppenexport | [Workflow](rechnungs-workflow.md) |
| Stellvertretung | Selbstverwalteter Ferienmodus mit additiver Stellvertretung | [Workflow](rechnungs-workflow.md#ferienmodus--abwesenheits-stellvertretung) |
| Spesen | Einzel-/Sammeleinreichung, eigene Freigabe 1, zweite Freigabe | [Spesen](spesen-einreichung.md) |
| Kreditkarten | Upload, Mail-Entwürfe, Kartenerkennung, Abgleich, Vorschläge, Erinnerungen, Fristlöschung | [Kreditkarten](kreditkarten-belege.md) |
| Zahlungsintegrität | QR-/IBAN-Prüfung, Zahlungsbestätigung, unveränderliche Snapshots, Altfallentscheidungen | [Export und Zahlung](export-und-zahlungsintegritaet.md) |
| Archivübergabe | Exportmanifest, Datei-Hashbindung, Archivquittung; externer Workflow erforderlich | [Paperless-Vertrag](n8n-paperless-archivierung.md) |
| Zeitstempel | Anfrage-/ESS-Bindung, lokale Root- und CRL-Prüfung, gespeicherte Evidenz, Nachholung | [Zeitstempel](zeitstempel-und-pruefbescheinigung.md), [Vertrauensanker](tsa-vertrauensanker.md) |
| Administration | Stammdaten, Rechte, Module, Branding, Mailvorlagen, Jobpläne, Quarantäne | [Admin](admin-bereich.md) |
| Hintergrundverarbeitung | Elf Scheduler-Jobs, persistente Mailzustellung und Digest | [Jobs](geplante-jobs-und-benachrichtigungen.md) |
| Sicherung | Verschlüsselte Backups, separater Download-Key, Offline-Restore/Rollback, Prozesssperre | [Backups](backup-verschluesselung.md), [Restore](offline-restore.md) |
| Audit | Fachliche Zeitleiste, Änderungsprotokoll, Request-/Lauf-IDs, Zugriffsverweigerungen, lokale Exportpakete | [Audit-Korrelation](audit-paket-request-korrelation.md), [Härtung](audit-paket-haertung-2026-09-29.md), [Export](audit-externe-nachweise.md) |

## Bei diesem Abgleich korrigiert

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

**Raumvermietung** und **Vertragsmanagement** sind Design-Entwürfe unter
`superpowers/specs/`; im aktuellen Repository gibt es dafür keine implementierten
Router, Services, Views oder Fachtabellen. Auch direkter Mail-Empfang im Portal
ist nicht implementiert; der Eingang erfolgt über n8n.

Die produktive n8n-/Paperless-Umstellung, konkrete DigiCert-Konfiguration mit
externer CRL-Erneuerung und Betriebsabnahmen bleiben offen. Die Upload-Prüfansicht
führt keine historische TSA-Ketten-/Sperrprüfung durch; LTV und OCSP fehlen.
Audit-Pakete können lokal erzeugt werden, aber automatischer Transport und ein
unabhängig kontrolliertes unveränderliches Ziel sind nicht implementiert.
Altfallentscheidungen besitzen einen eigenen unveränderlichen Nachweis, sind
aber weiterhin nicht in der zentralen Audit-Trigger-Liste enthalten.
