# Kommentare an Rechnungen — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 4 des Backlogs vor dem Launch.

## Absicht und Warum

Rückfragen zu Rechnungen laufen heute **per Mail oder bilateral im Büro**. Sie gehen verloren, die
Beteiligten wissen nicht voneinander, und später ist nicht nachvollziehbar, warum etwas so
entschieden wurde. Neu hängt die Rückfrage direkt an der Rechnung (bzw. Spesenposition).

## Ziele

1. Kommentar-Bereich auf den Seiten einer Rechnung/Spesenposition (Kontierung, Freigabe 2,
   Ablehnung/Überarbeitung, Admin → Vorgang-Detail, abgeschlossene Ansicht).
2. Kommentare mit Verfasser, Zeitpunkt, Text (max. 2000 Zeichen, nur Text, Zeilenumbrüche).
3. Benachrichtigung der übrigen Beteiligten per Mail; `@Name` holt gezielt eine Person dazu.
4. Kommentare sind **unveränderlich**; Korrekturen als Nachtrag.

## Nicht-Ziele

- Keine Anhänge an Kommentaren.
- Kein Chat/Live-Update.

## Anti-Ziele

- Eine Person sieht oder kommentiert eine Rechnung, die sie sonst nicht sehen dürfte (auch nicht
  über `@Name`).
- Kommentare lassen sich nachträglich ändern oder löschen.
- Mail-Flut: jeder Kommentar schickt mehrere Mails an Unbeteiligte.

## Vom Nutzer bestätigt

1. Heute: Rückfragen per Mail oder im Büro.
2. Wer kommentieren kann = wer die Rechnung sehen darf (zuständige Person, Freigeber 1 und 2 des
   Kontos, einreichende Person bei Spesen, Admins mit Recht auf Vorgänge).
3. Benachrichtigung der Beteiligten per Mail, `@Name` für gezieltes Dazuholen (nur Personen, die
   die Rechnung sehen dürfen).
4. Unveränderlich, Nachtrag möglich.
5. Abgeschlossene Rechnungen: Kommentare sichtbar, keine neuen.
6. Kommentare erscheinen **auch auf dem PDF** (im gestempelten Verlauf).

## Entscheidungen des Entwurfs (meine Calls)

1. **Auf dem PDF**: Beim Erstellen des finalen PDFs (Freigabe 2, `stampAndFinalize` in
   `src/services/pdfStamp.js`) erscheinen alle Kommentare des Vorgangs in einem eigenen Abschnitt
   "Rückfragen und Kommentare" der Verlaufsseite(n), chronologisch mit Verfasser und Zeitpunkt
   (Europe/Zurich). Bei Splitgruppen enthält das gemeinsame Gruppen-PDF die Kommentare je Teil.
   Weil nach der Freigabe keine neuen Kommentare möglich sind, ist der Stand auf dem PDF
   vollständig. Der Stempel-Font kann nur WinAnsi (Helvetica): nicht darstellbare Zeichen (Emoji,
   fremde Schriften) werden beim Stempeln durch `?` ersetzt — im Portal bleibt der Originaltext;
   lange Kommentare umbrechen und laufen auf Folgeseiten weiter. Bereits archivierte PDFs werden
   nicht nachträglich geändert.
2. **Sichtbarkeit** nutzt die bestehenden Prüfungen (`canViewJobPdf` / jobAuthorization bzw. die
   Zugriffsregeln der jeweiligen Seite); eine zentrale Funktion `darfKommentieren(db, config,
   person, job)` und `darfKommentareSehen(...)`.
3. **Beteiligte** (Empfänger der Mail): aktuell zuständige Person (über
   `ermittleZustaendigkeit`), Freigeber 1 und 2 des Kontos (inkl. aktiver Ferienvertretung),
   einreichende Person bei Spesen, alle früheren Kommentierenden dieses Vorgangs, und per `@Name`
   Erwähnte — jeweils nur, wenn sie den Vorgang sehen dürfen; die schreibende Person nie.
   Admins ohne eigene Rolle am Vorgang werden nur per `@Name` benachrichtigt.
4. **`@Name`**: Auswahl aus einer Liste der Personen, die den Vorgang sehen dürfen (Eingabehilfe
   im Formular, ohne JS weiterhin als Freitext `@Vorname Nachname` erkannt). Unbekannte oder
   nicht berechtigte Namen werden beim Absenden gemeldet, nicht still ignoriert.
5. **Mail-Typ** `kommentar`, bearbeitbare Vorlage; respektiert die persönlichen
   Benachrichtigungs-Einstellungen (Teil 5 des Backlogs), bis dahin sofort.
6. **Abgeschlossen** = Status `abgeschlossen`, `abgeholt`, `archiviert`, `geloescht`.
7. **Audit**: neue Tabelle `kommentare` (append-only per Trigger, in der zentralen Audit-Liste).
8. **Anzeige in Listen**: Sprechblasen-Symbol mit Anzahl in Aufgaben-Liste/Kacheln, wenn ein
   Vorgang Kommentare hat; "neu" für Kommentare seit dem letzten Öffnen durch die Person.
9. **Responsive**.

## Einschränkungen

- Bestehende Seiten-Layouts (Shell, Kachel-/Tabellenansicht), CSRF, Mail-Outbox, Audit-Trigger.
- Splitgruppen: Kommentare hängen am einzelnen Teil-Vorgang; der Elternvorgang zeigt die
  Kommentare seiner Teile nicht automatisch (Builder darf einen Hinweis-Link ergänzen).

## Dem Builder überlassen

- Darstellung im Seitenlayout, Eingabehilfe für `@Name`.
- Datenmodell im Detail (z. B. `kommentare(id, job_id, person_id, text, erwaehnt JSON, zeitpunkt)`
  plus `kommentar_gelesen(job_id, person_id, zuletzt_am)`).
- Tests: Kommentare auf dem finalen PDF (Einzel- und Gruppen-PDF, Umbruch, Emoji → `?`, Hash/
  Zeitstempel-Ablauf unverändert gültig), Sichtbarkeit/Berechtigung pro Rolle, `@Name` nur Berechtigte, keine Mail an die
  schreibende Person, unveränderlich (Trigger), abgeschlossen = keine neuen, "neu"-Markierung,
  XSS im Text.
