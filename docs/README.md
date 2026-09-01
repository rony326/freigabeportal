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
| [architektur.md](architektur.md) | Systemüberblick, Tech-Stack, Middleware-Pipeline, Router-Übersicht, Sicherheitsmechanismen |
| [auth-und-rechte.md](auth-und-rechte.md) | ChurchTools-OAuth2-Login, Rollenmodell (Gruppen) und additive Einzelrechte, Job-Autorisierung |
| [datenmodell.md](datenmodell.md) | Alle Datenbanktabellen, ER-Diagramm, wichtige Constraints |
| [rechnungs-workflow.md](rechnungs-workflow.md) | Der zentrale Prozess: Status-Modell einer Rechnung, Kontierung, Gutschriften, Freigabe 1/2, Ablehnung, Aufsplitten, Splitgruppen-Export, Löschung |
| [spesen-einreichung.md](spesen-einreichung.md) | Zweite Domäne neben Lieferantenrechnungen: Spesen/Auslagen-Einreichung durch die Person selbst, eigene Freigabe-1-Seite |
| [n8n-schnittstelle.md](n8n-schnittstelle.md) | API-Vertrag für Rechnungseingang und -abholung durch n8n |
| [qr-bill-und-betrugserkennung.md](qr-bill-und-betrugserkennung.md) | Swiss-QR-Bill-Erkennung und IBAN-Abgleich gegen hinterlegte Lieferanten-IBANs |
| [zeitstempel-und-pruefbescheinigung.md](zeitstempel-und-pruefbescheinigung.md) | RFC3161-Zeitstempel, Nachhol-Mechanismus, Verifikations- und Zertifikatsseite |
| [admin-bereich.md](admin-bereich.md) | Alle Admin-Seiten mit den jeweils benötigten Rechten |
| [geplante-jobs-und-benachrichtigungen.md](geplante-jobs-und-benachrichtigungen.md) | Die sechs automatischen Hintergrund-Jobs, E-Mail-Versand, Eskalationslogik |
| [personen-sync.md](personen-sync.md) | Nächtlicher ChurchTools-Personen-/Gruppen-Sync, Schutzmechanismen, "stalled jobs" |

Phasenpläne und historische Design-Dokumente der einzelnen Ausbaustufen
liegen weiterhin in [`superpowers/specs/`](superpowers/specs/) und
[`superpowers/plans/`](superpowers/plans/) — diese hier beschreiben den
aktuellen Stand des Systems, nicht dessen Entstehungsgeschichte.
