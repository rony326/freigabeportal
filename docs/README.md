# Dokumentation

Diese Dokumentation ergänzt die kurze Setup-/Deployment-Anleitung im
[Haupt-README](../README.md) um eine fachliche und technische Beschreibung
des gesamten Tools: Architektur, Datenmodell, Workflows und Prozesse,
jeweils mit Diagrammen.

Zielgruppe: Entwickler:innen, die sich neu einarbeiten, und alle, die den
fachlichen Ablauf (Rechnungsfreigabe, Vier-Augen-Prinzip, Eskalationen)
nachvollziehen wollen, ohne den Code zu lesen.

| Dokument | Inhalt |
|---|---|
| [feature-abgleich-2026-09-30.md](feature-abgleich-2026-09-30.md) | Abgleich mit dem Code: verfügbare Features, Entwürfe und verbleibende Betriebsabnahmen |
| [architektur.md](architektur.md) | Systemüberblick, Tech-Stack, Middleware-Pipeline, Router-Übersicht, Sicherheitsmechanismen |
| [auth-und-rechte.md](auth-und-rechte.md) | ChurchTools-OAuth2-Login, Rollenmodell (Gruppen) und additive Einzelrechte, Job-Autorisierung |
| [datenmodell.md](datenmodell.md) | Alle Datenbanktabellen, ER-Diagramm, wichtige Constraints |
| [rechnungs-workflow.md](rechnungs-workflow.md) | Der zentrale Prozess: Status-Modell einer Rechnung, Kontierung, Gutschriften, Freigabe 1/2, Ablehnung, Aufsplitten, Splitgruppen-Export, Löschung |
| [rechnungs-workflow.md#9-rapporte-status-kenntnisnahme](rechnungs-workflow.md#9-rapporte-status-kenntnisnahme) | Rapporte (nur zur Kenntnis): Markierung in der Kontierung, Bestätigung durch alle Empfänger:innen, Erinnerung/Eskalation, Admin-Eingriff, Archivierung über eigene n8n-Endpunkte |
| [kommentare.md](kommentare.md) | Kommentare an Rechnungen: Sichtrecht, @Erwähnungen, Mails und Links, Unveränderlichkeit, Marke „neu“, Abschnitt auf dem finalen PDF, Konflikt bei Freigabe 2 |
| [spesen-einreichung.md](spesen-einreichung.md) | Zweite Domäne neben Lieferantenrechnungen: Spesen/Auslagen-Einreichung durch die Person selbst, eigene Freigabe-1-Seite |
| [auswertung.md](auswertung.md) | Seite Auswertung: Kennzahlen, Budget pro Konto, Durchlaufzeit, wo Rechnungen liegen, Lieferanten, Zählregeln, CSV-Export; Budgets pflegen und aus Excel/CSV importieren; Rechte `auswertung_einsehen`, `budgets_verwalten` |
| [kreditkarten-belege.md](kreditkarten-belege.md) | Dritte Domäne: Vorab-Erfassung von Kreditkartenbelegen, Abgleich gegen die Monatsabrechnung als erweitertes Aufsplitten |
| [n8n-schnittstelle.md](n8n-schnittstelle.md) | API-Vertrag für Rechnungseingang (inkl. PDF-Eingangsprüfung) und -abholung durch n8n |
| [n8n-paperless-archivierung.md](n8n-paperless-archivierung.md) | Exportmanifest, hashgebundener Download und Archivquittung |
| [tsa-vertrauensanker.md](tsa-vertrauensanker.md) | Deployment von Root-CAs und CRLs, Prüfprofil und Grenzen |
| [audit-paket-request-korrelation.md](audit-paket-request-korrelation.md) | Request-/Lauf-IDs und protokollierte Backup-Löschungen |
| [export-und-zahlungsintegritaet.md](export-und-zahlungsintegritaet.md) | Snapshot-gebundener Export, Zahlungsbestätigung je Belegart, Altfälle ohne Freigabenachweis |
| [qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md) | Pflicht-IBAN und Zahlungsart pro Lieferant, Swiss-QR-Bill-Erkennung, Prüfungen und Prüf-Popup bei der Kontierung, manuelle IBAN-Kontrolle |
| [zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md) | RFC3161-Zeitstempel, Nachhol-Mechanismus, Verifikations- und Zertifikatsseite |
| [ersteinrichtung.md](ersteinrichtung.md) | Geführter Einrichtungsassistent `/admin/ersteinrichtung`: 14 Schritte, Messregeln, Tests, Dashboard-Hinweis, Statusdienst `einrichtung` |
| [admin-bereich.md](admin-bereich.md) | Alle Admin-Seiten mit den jeweils benötigten Rechten, inkl. Seite Benachrichtigungen (Wann/Wer/Was pro Ereignis) |
| [geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md) | Die sechzehn automatischen Hintergrund-Jobs, persistente Mailzustellung mit Wiederholung, Eskalationslogik, Verhalten nach Neustart |
| [personen-sync.md](personen-sync.md) | Nächtlicher ChurchTools-Personen-/Gruppen-Sync: Zugangsmodell (Gruppenaustritt vs. entzogener Zugang vs. Ausfall), Schutzmechanismen, "stalled jobs" |
| [backup-verschluesselung.md](backup-verschluesselung.md) | **Verbindlich:** verschlüsselte `.fpbak`-Sicherungen, Schlüsselbund und Schlüsselaufbewahrung, Rotation, n8n-Abholung, Altsicherungen |
| [offline-restore.md](offline-restore.md) | **Verbindlich:** Offline-Wiederherstellung und Rückwechsel, Prozesssperre, verwaiste Sperren |
| [backup-sicherheit.md](backup-sicherheit.md) | Prüfungen und Grenzen des Backup-/Restore-Formats |
| [kreditoren-statt-debitoren.md](kreditoren-statt-debitoren.md) | Fachliche Korrektur der Bezeichnung, Migration, Kompatibilität, Deployment-Schritte |
| [audit-paket-haertung-2026-09-29.md](audit-paket-haertung-2026-09-29.md) | Zugriffsverweigerungen, Datei-Quarantäne, Sicherheitsalarme, TSA-Evidenz |
| [betrieb-und-nutzung.md](betrieb-und-nutzung.md) | Nutzungsdaten, Fehlererfassung und „Problem melden“, Neues-Gerät-Mail, Banner, Datenschutzhinweis, Aufbewahrungsfristen, Recht `betrieb_einsehen` |
| [testmodus.md](testmodus.md) | Testmodus (Spielwiese) für Superadmin und Manager: Beispieldaten, Abschottung, Test-Postfach, Zurücksetzen |
| [testdrehbuch/](testdrehbuch/README.md) | Quellen für Testdrehbuch, Go-Live-Checkliste und Testbelege; wie man sie neu baut und pflegt |
| [statusseite-und-monitoring.md](statusseite-und-monitoring.md) | Statusseite `/admin/betrieb/status`, Dienste und Grenzwerte, `/healthz` mit Überwachungsschlüssel, Uptime-Kuma-Anleitung |
| [audit-externe-nachweise.md](audit-externe-nachweise.md) | Bedrohungsmodell und lokale Grundlage für externe Audit-Nachweise |
| [pruefbericht-2026-10.md](pruefbericht-2026-10.md) | Prüfbericht Abschlussprüfung Oktober 2026: Funde, Behebungen, Checklisten für Infomaniak und Geheimnisse |

## Releases

| Version | Datum | Release Notes |
|---|---|---|
| 1.2.0 | 2026-11-11 | [releases/v1.2.0.md](releases/v1.2.0.md) |
| 1.1.1 | 2026-11-11 | [releases/v1.1.1.md](releases/v1.1.1.md) |
| 1.1.0 | 2026-11-11 | [releases/v1.1.0.md](releases/v1.1.0.md) |
| 1.0.1 | 2026-11-10 | [releases/v1.0.1.md](releases/v1.0.1.md) |
| 1.0.0 | 2026-11-09 | [releases/v1.0.0.md](releases/v1.0.0.md) |

Kurzfassung aller Versionen: [`CHANGELOG.md`](../CHANGELOG.md).

## Historische Prüf- und Review-Berichte

Momentaufnahmen früherer Prüfungen. Sie beschreiben den Stand zum
jeweiligen Datum; der aktuelle Stand steht in den Dokumenten oben.

| Dokument | Inhalt |
|---|---|
| [audit-review-2026-09-27.md](audit-review-2026-09-27.md) | Audit-Review vom 27.09.2026: Funde |
| [audit-behebungsplan-2026-09-27.md](audit-behebungsplan-2026-09-27.md) | Behebungsplan zu diesem Review |
| [audit-umsetzungsstand-2026-09-27.md](audit-umsetzungsstand-2026-09-27.md) | Umsetzungsstand der Behebungen |
| [review-frischer-blick-2026-09-29.md](review-frischer-blick-2026-09-29.md) | Review „frischer Blick“ vom 29.09.2026 |

Phasenpläne und historische Design-Dokumente der einzelnen Ausbaustufen
liegen weiterhin in [`superpowers/specs/`](superpowers/specs/) und
[`superpowers/plans/`](superpowers/plans/) — diese hier beschreiben den
aktuellen Stand des Systems, nicht dessen Entstehungsgeschichte.
