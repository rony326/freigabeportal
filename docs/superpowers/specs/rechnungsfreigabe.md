# Prompt für Claude Code: Rechnungsfreigabe-Workflow

Baue eine Anwendung für einen automatisierten, mehrstufigen Rechnungsfreigabeprozess für eine Schweizer Kirchgemeinde. Das System besteht aus einem öffentlich erreichbaren Freigabe-Portal und einer Anbindung an ein bereits bestehendes internes n8n. Lies dieses gesamte Dokument, bevor du mit der Implementierung beginnst — die Reihenfolge der Abschnitte ist absichtlich: Kontext, dann Architektur, dann Datenmodell, dann Ablauf, dann Schnittstellen, dann Sicherheit, dann Fallstricke, dann offene Entscheidungen.

## 1. Kontext und Ziel

Rechnungen (per Scanner oder direkt vom Lieferanten per Mail) sollen automatisiert kontiert, durch zwei unabhängige Personen freigegeben ("visiert"), fälschungssicher archiviert und an den externen Treuhänder (Bexio) weitergeleitet werden — ohne manuellen Medienbruch, aber mit echtem Vier-Augen-Prinzip und Interessenskonflikt-Handling.

## 2. Architektur und Komponenten

| Komponente | Rolle | Erreichbarkeit | Bereits vorhanden? |
|---|---|---|---|
| n8n | Orchestrierung: Mail-Eingang, PDF-Merge, Polling, Ablage, Mailversand | **intern, on-prem, darf NICHT exponiert werden** | Ja |
| Freigabe-Portal | Zuweisung, Kontierung, Freigabe-UI, Admin-Bereich | **öffentlich, gehostet auf Infomaniak Node.js-Webhosting** | Nein — dies ist der Kern deiner Aufgabe |
| ChurchTools | Identitätsprovider (OAuth2), Personen- und Gruppenverwaltung | öffentlich, extern | Ja, inkl. bestehender Nutzerdaten |
| Paperless-ngx | Archiv mit Volltextsuche | **intern, darf NICHT exponiert werden** | Ja |
| Bexio (Treuhänder) | Externe Buchhaltung | nur per E-Mail-Import erreichbar, kein API-Zugriff | — |

**Kritische Randbedingung:** Das Freigabe-Portal ist die einzige Komponente, die von aussen erreichbar sein darf. n8n kann daher keine eingehenden Aufrufe (Webhooks) vom Portal empfangen — es muss stattdessen aktiv beim Portal nachfragen (**Polling**, kein Push).

Baue das Portal als eigenständige Node.js/Express-Anwendung (kompatibel mit Infomaniak Node.js-Hosting), mit einer leichtgewichtigen Datenbank (SQLite ist ausreichend für die erwartete Last).

## 3. Datenmodell

### Job (eine Rechnung im Workflow)
```
id, eingang_am, quelle (scanner|lieferant), absender, dateiname
pdf_pfad (lokal auf dem Portal, siehe Abschnitt Sicherheit für Löschfristen)
status: unzugewiesen → zugewiesen → kontiert → freigabe1 → freigabe2 → abgeschlossen → abgeholt → archiviert
        (zusätzlich: abgelehnt als Terminalzustand mit Rückweg, siehe Abschnitt 6)
konto_id (FK auf Konten, wird bei Kontierung gesetzt)
freigaben: Liste aus { person_id, rolle (freigeber1|freigeber2), zeitpunkt, ip,
           interessenskonflikt: bool, kommentar, eskaliert_von (falls Stellvertreter einsprang) }
abgelehnt_von, ablehnungsgrund (falls zutreffend)
fetched_by_n8n_at (null bis n8n den Job final abgeholt hat)
```

### Konten (Admin-verwaltet)
```
id, kontonummer, bezeichnung
freigeber1_id       -- Budgetverantwortlicher: kontiert UND visiert selbst (Freigabe 1)
stellvertreter1_id  -- übernimmt Kontierung + Freigabe 1 komplett bei Interessenskonflikt von freigeber1_id
freigeber2_id       -- zweite, unabhängige Freigabe
stellvertreter2_id  -- übernimmt Freigabe 2 bei Interessenskonflikt von freigeber2_id
```
Validierung beim Anlegen/Bearbeiten: `freigeber1_id != freigeber2_id` muss hart erzwungen werden (siehe Fallstricke).

### Zuweisungsregeln (Admin-verwaltet)
```
id, absender_muster (E-Mail oder Domain des Lieferanten), konto_id
```
Wird beim Job-Eingang geprüft, um automatisch einen `konto_id` vorzuschlagen und die Rechnung direkt an `freigeber1_id` dieses Kontos zuzustellen, statt in den offenen Pool zu legen.

### Personen (Sync aus ChurchTools, siehe Abschnitt 5)
```
churchtools_person_id, vorname, nachname, email, aktiv (bool), gruppen (Array von ChurchTools-Gruppen-IDs),
last_synced_at
```

## 4. Prozessablauf im Detail

1. **Eingang**: n8n pollt intern das Rechnungspostfach (IMAP), extrahiert den PDF-Anhang.
2. **Vorverarbeitung**: n8n hängt eine schlichte Visum-Deckseite an (Titel "Visum / Rechnungsfreigabe", zwei Blöcke "Geprüft und freigegeben von" ohne Linien und ohne eingebettete `{{tag}}`-Formularfelder — diese wurden getestet und werden von der Ziel-PDF-Verarbeitung nicht zuverlässig erkannt, also rein informativ als Platzhalter für die spätere Stempelung).
3. **Job-Erstellung**: n8n sendet PDF + Basismetadaten per API-Key-authentifiziertem POST an das Portal.
4. **Zuweisung**: Bei Regel-Treffer (Absender → Konto) automatische Zustellung an `freigeber1_id` des Kontos. Ohne Treffer: Job landet im Pool, sichtbar nur für Mitglieder der ChurchTools-Gruppe "Buchhaltung", mit atomarem "Beanspruchen"-Mechanismus.
5. **Kontierung + Freigabe 1 (aus einer Hand)**: Die zugewiesene Person (`freigeber1_id`, oder bei Interessenskonflikt `stellvertreter1_id`) wählt das Konto aus einem Dropdown (Admin-gepflegte Liste, kein Freitext, keine Kostenstelle — nur Kontonummer + Bezeichnung), bestätigt "kein Interessenskonflikt" oder erklärt einen mit Begründung. Bei erklärtem Konflikt: die komplette Kontierung + Freigabe 1 geht an `stellvertreter1_id` desselben Kontos, mit Audit-Eintrag.
6. **Freigeber 2 wird bestimmt**: Sobald das Konto feststeht, liest das System `freigeber2_id` aus der Konto-Konfiguration aus — nicht vorher bestimmbar.
7. **Freigabe 2**: Split-View-Ansicht (links scrollbare PDF-Vorschau aller Seiten inkl. Visum-Seite, rechts fest sichtbares Panel mit Kontierungs-Zusammenfassung, Interessenskonflikt-Erklärung, Freigeben/Ablehnen-Buttons). Bei Konflikt: `stellvertreter2_id` übernimmt.
8. **Abschluss**: Nach beiden Freigaben wird das PDF final gestempelt (Namen, ChurchTools-Identität, Zeitstempel, IP, Interessenskonflikt-Status beider Freigaben) und geflattened (nicht mehr editierbar). Status → `abgeschlossen`.
9. **Abholung durch n8n**: n8n pollt periodisch (Cron, Vorschlag: alle 5–15 Minuten) den Endpunkt für abgeschlossene, noch nicht abgeholte Jobs. Download von PDF + strukturierten Metadaten. Zweiphasiges Markieren (zuerst "wird verarbeitet", erst nach erfolgreichem Downstream-Schritt endgültig "abgeholt") — siehe Fallstricke zur Idempotenz.
10. **Ablage**: n8n lädt das fertige PDF inkl. Custom Fields (Kontonummer, Freigeber 1, Freigeber 2, Interessenskonflikt-Status, Rechnungsnummer, Betrag) in Paperless-ngx.
11. **Versand an Treuhänder**: n8n verschickt das PDF per SMTP an die Bexio-Importadresse — **ausschliesslich** beim Übergang in Status `abgeschlossen`, niemals davor oder parallel zu einer noch offenen Freigabe.
12. **Löschung auf dem Portal**: Nach erfolgreicher Abholung durch n8n wird das PDF (und optional die Job-Daten) aktiv vom Portal gelöscht, um sensible Finanzdaten nicht dauerhaft extern zu lagern.

## 5. Auth, Rollen und Nutzer-Sync

**Zwei getrennte Auth-Mechanismen auf dem Portal, sauber trennen:**
- **ChurchTools OAuth2 (Authorization Code Flow)** für den Login von Menschen (Freigebende, Kontierende, Admins). ChurchTools ist bereits als OAuth-Server konfigurierbar (System-Einstellungen → Integrationen → Login bei Drittsystemen).
- **API-Key (Shared Secret)** für die Maschine-zu-Maschine-Kommunikation mit n8n. Niemals mit dem OAuth-Flow vermischen.
- **ChurchTools-Login-Token eines separaten technischen Service-Accounts** für den Nutzer-Sync (siehe unten) — wieder getrennt von den beiden anderen.

**Rollen werden aus ChurchTools-Gruppenzugehörigkeit abgeleitet**, nicht manuell im Portal vergeben: Mitglied "Buchhaltung" → sieht/beansprucht den Pool, Mitglied "Portal-Admin" → Zugriff auf den Admin-Bereich. Matche über die stabile ChurchTools-Gruppen-ID, nicht über den Namen (Umbenennungen dürfen die Zuordnung nicht brechen).

**Nutzer-Sync (Delta-Sync, ChurchTools-Nutzer sind bereits vorhanden):**
- Nächtlicher Cron-Job im Portal fragt über den technischen Service-Account die relevanten ChurchTools-Gruppen ab.
- Neue/geänderte Personen werden upserted.
- Personen, die lokal aktiv sind, aber nicht mehr in der aktuellen Gruppenliste auftauchen, werden **deaktiviert, nicht gelöscht** (Audit-Trail alter Freigaben muss erhalten bleiben).
- Zusätzlich: Just-in-Time-Auffrischung der Profildaten bei jedem echten OAuth-Login als Sicherheitsnetz zwischen den nächtlichen Syncs.

## 6. Admin-Bereich

Geschützter dritter Bereich derselben Anwendung, Zugriff nur für ChurchTools-Gruppe "Portal-Admin":
- **Konten-Verwaltung**: CRUD für Konten mit den vier Rollen (Freigeber 1, Stellvertreter 1, Freigeber 2, Stellvertreter 2), Personen-Dropdowns befüllt aus der lokal gesyncten Personenliste.
- **Zuweisungsregeln**: Lieferant/Absender → Konto.
- **Eskalationszeiten**: Reminder- und Eskalationsfristen für den Pool (Vorschlag: Reminder nach 24h, Eskalation nach 48h an eine feste Fallback-Instanz).

## 7. UI-Anforderungen

- **Pool-Übersicht**: Liste offener, unzugewiesener Rechnungen mit kleinem Vorschau-Thumbnail pro Zeile (serverseitig beim Job-Anlegen einmalig als PNG der ersten Seite gerendert, nicht bei jedem Listenaufruf neu), Alter, Betrag, "Beanspruchen"-Button. Klick aufs Thumbnail öffnet ein leichtes Vorschau-Overlay ohne Beanspruchen-Aktion, damit reines Ansehen keine Zuständigkeit auslöst.
- **Freigabe-Detailansicht**: Split-View — links scrollbarer Bereich mit allen PDF-Seiten, rechts ein fest sichtbares Panel mit Kontierung/Interessenskonflikt/Freigeben/Ablehnen, das beim Scrollen links stehen bleibt.
- Alle Texte, Labels und E-Mail-Benachrichtigungen auf Deutsch.

## 8. Sicherheitsanforderungen

- TLS zwingend auf dem Portal (Infomaniak Node.js-Hosting).
- Rate-Limiting auf allen öffentlichen Endpunkten.
- Keine sensiblen Daten (Rechnungsnummern, Beträge) in URLs — nur in Request-/Response-Bodies.
- PDF-Downloads nur über kurzlebige, signierte Links, nicht über dauerhaft gültige statische Pfade.
- Atomare Datenbank-Operation beim "Beanspruchen" (`UPDATE ... WHERE assigned_to IS NULL`), um Race Conditions bei gleichzeitigen Klicks zu verhindern.
- Aktive Löschung von PDFs nach erfolgreicher Abholung durch n8n.

## 9. Bekannte Fallstricke — bewusst berücksichtigen, nicht ignorieren

- **Race Conditions beim Beanspruchen**: siehe Sicherheitsanforderungen, zwingend atomar lösen.
- **Doppelte Verarbeitung bei Polling-Fehlern**: zweiphasiges Markieren, n8n-Workflow muss idempotent sein.
- **Das Portal ist der exponierteste Teil der gesamten Kette** — besondere Sorgfalt bei Input-Validierung, Auth, Abhängigkeiten.
- **Sensible Finanzdaten liegen temporär extern** (Infomaniak) — aktive Löschung nach Abholung ist kein optionales Feature, sondern Kernanforderung.
- **ChurchTools als Single Point of Failure fürs Login** — bewusst in Kauf genommen für diesen Anwendungsfall.
- **Freigeber 1 und Freigeber 2 dürfen nie dieselbe Person sein** — bei der Konto-Anlage im Admin-Bereich hart validieren, sonst wird das Vier-Augen-Prinzip stillschweigend ausgehebelt.
- **Zeitpunkt des Bexio-Versands**: darf ausschliesslich nach vollständigem Abschluss erfolgen, siehe Abschnitt 4, Schritt 11 — im Code als expliziten Trigger auf den Statusübergang zu `abgeschlossen` implementieren, nicht als separaten, potenziell parallel laufenden Prozess.
- **Kein vollständig definierter Rückwärtspfad bei Ablehnung**: Baue einen einfachen, funktionierenden Grundmechanismus (Job wird auf Status `abgelehnt` gesetzt, Freigeber 1 bzw. die kontierende Person wird per Mail benachrichtigt, kann den Job erneut bearbeiten und zurück in den Ablauf schicken) — dies ist noch nicht im Detail durchdacht, daher pragmatisch, aber funktional umsetzen.
- **Gruppen-Umbenennungen in ChurchTools**: über Gruppen-ID matchen, nie über den Namen.
- **Personen-Zusammenführungen in ChurchTools**: wenn eine referenzierte Personen-ID beim Sync nicht mehr auflösbar ist, Admin-Warnung ausgeben statt stillschweigend Daten zu verlieren.
- **Merge-Reihenfolge des PDFs**: Visum-Seite konsistent an gleicher Position (letzte Seite) einfügen, damit spätere Stempel-Koordinaten nicht durch unterschiedlich lange Rechnungen verschoben werden.

## 10. Offene Entscheidungen — im Code als konfigurierbar/klar dokumentiert lassen, nicht fest verdrahten

- Ob die generische, personenbasierte "Vorgesetzten-Eskalation" (unabhängig vom Konto-Modell) noch für irgendeine Rolle relevant bleibt, ist nicht abschliessend geklärt — aktuell wird ausschliesslich die kontobasierte Stellvertreter-Logik (Abschnitt 3/4) verwendet. Baue das Datenmodell so, dass eine spätere Ergänzung möglich ist, ohne bestehende Strukturen umzubauen.
- Genaue Eskalationsfristen (24h/48h) sind Vorschläge, sollen im Admin-Bereich änderbar sein, nicht hartcodiert.
- Polling-Intervall von n8n ist ein Kompromiss zwischen Aktualität und Last — als Umgebungsvariable konfigurierbar halten.
- Der Rückwärtspfad bei Ablehnung (Abschnitt 9) ist bewusst als Minimalversion beschrieben und kann iterativ verfeinert werden.

## 11. Technischer Rahmen

- Portal: Node.js/Express, SQLite, lauffähig auf Infomaniak Node.js-Webhosting.
- n8n: bereits vorhanden, on-prem, wird um neue Workflows (IMAP-Trigger, PDF-Merge, Job-Push, Cron-Polling, Paperless-Upload, SMTP-Versand) ergänzt, nicht neu aufgesetzt.
- Kommunikation ausschliesslich über die in Abschnitt 5 beschriebenen, sauber getrennten Auth-Mechanismen.
- Alle Zeitstempel in UTC speichern, in der UI lokal (Europe/Zurich) anzeigen.