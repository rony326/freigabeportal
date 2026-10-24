# Nutzungsdaten, Fehlermeldungen und Banner — Design

Stand: 2026-10-24. Status: Entwurf, zur Freigabe.
Teil 2 des Reportings (Teil 1: `2026-10-24-rechnungs-reporting-design.md`).

## Absicht und Warum

Für **Wartung und Weiterentwicklung** soll sichtbar sein, wer das Portal womit und wie nutzt
(Geräte, Browser, Seiten) und wo Fehler auftreten. Für **Sicherheit** sollen Anmeldungen
nachvollziehbar sein und eine Person merken, wenn sich jemand von einem neuen Gerät mit ihrem
Konto anmeldet. Nutzerinnen und Nutzer sollen Fehler mit den technischen Details direkt melden
können. Über ein **Banner** sollen Updates, Wartungen und Hinweise angekündigt werden.

## Ziele

1. **Nutzungsdaten** pro Person: Seitenaufrufe (Seite, Zeitpunkt, Gerät/Browser,
   Antwortzeit, Status) und Anmeldungen (Zeitpunkt, Gerät/Browser, IP-Adresse, Erfolg).
2. **Übersicht "Betrieb & Nutzung"**: Geräte- und Browserverteilung, meistgenutzte Seiten,
   langsame Seiten, Fehlerhäufigkeit, aktive Personen; Filter nach Zeitraum und Person;
   Detailansicht pro Person (Anmeldungen, Geräte, letzte Aufrufe, Fehler).
3. **Fehler** automatisch erfassen (jeder 5xx und jede unbehandelte Ausnahme) mit Anfrage-ID,
   Seite, Person, Browser, Zeitpunkt und technischem Ablauf (Stacktrace, nur serverseitig).
4. **Fehler melden**: Fehlerseite zeigt eine kurze Fehler-ID und "Fehler melden" mit
   optionaler Beschreibung; Meldung verknüpft mit dem erfassten Fehler; Mail an die
   Berechtigten.
5. **Neues Gerät**: Anmeldung von einem Gerät, das für diese Person noch nie gesehen wurde →
   Mail an die Person selbst.
6. **Banner**: Mitteilung mit Text, Art (Info, Wartung, Warnung) und Zeitraum, oben auf allen
   Seiten für alle Angemeldeten.
7. **Datenschutzhinweis** zu den Nutzungsdaten, einmalig über ein Banner und dauerhaft auf
   einer Seite "Datenschutz" verlinkt.

## Nicht-Ziele

- Kein Tracking ausserhalb des Portals, keine Drittanbieter-Analytics, keine Cookies ausser dem
  bestehenden Session-Cookie und einer Geräte-Kennung (s. u.).
- Keine IP-Geolokalisierung (bräuchte einen externen Dienst).
- Kein Erfassen von Formularinhalten, Beträgen oder Dokumenten in den Nutzungsdaten.
- Keine automatische Sperre bei Verdacht (nur Mail).
- Banner nicht auf öffentlichen Seiten (Login, `/audit-pruefen`).

## Anti-Ziele

- Stacktraces oder interne Details werden Nutzerinnen und Nutzern angezeigt.
- Nutzungsdaten werden länger als vereinbart aufbewahrt.
- Das Erfassen bremst oder bricht eine Seite (Fehler im Erfassen dürfen nie den Aufruf
  scheitern lassen).
- Wer die Nutzungsdaten sieht, kann Fehlermeldungen oder Banner unbemerkt verändern
  (Änderungen im Audit-Log).

## Vom Nutzer entschieden

1. Nutzungsdaten sind **einzelnen Personen zugeordnet**.
2. Zugriff über ein **eigenes Recht**.
3. Fehler erfassen und **Fehler melden mit Trace** durch die Person.
4. **Banner** für Updates und Ankündigungen, im selben Bereich.
5. Aufbewahrung: **Seitenaufrufe 90 Tage**, **Anmeldungen, Fehler und Fehlermeldungen 1 Jahr**.
6. Warnung bei **neuem Gerät an die Person selbst**.

## Entscheidungen des Entwurfs (meine Calls, vom Nutzer zu prüfen)

1. **Recht `betrieb_einsehen`** ("Betrieb & Nutzung"): sieht Nutzungsdaten und Fehler,
   bearbeitet Fehlermeldungen (Status offen / in Arbeit / erledigt, Notiz) und verwaltet
   Banner. Superadmin hat es über das Bundle; **Manager nicht** automatisch (Personendaten),
   analog `sync_verwalten`/`workflow_eingreifen` in `personHasPermission`.
2. **Geräte-Kennung**: zufällige ID in einem eigenen, langlebigen Cookie (`fp_geraet`,
   HttpOnly, SameSite=Lax, Secure, 2 Jahre). "Neues Gerät" = Kennung für diese Person noch nie
   gesehen. Fehlt das Cookie (gelöscht, privates Fenster), gilt das Gerät als neu — die Mail
   sagt das ehrlich ("oder du hast deine Browserdaten gelöscht"). Gerät/Browser werden aus dem
   User-Agent grob bestimmt (Desktop/Tablet/Handy, Browser-Familie und Hauptversion,
   Betriebssystem); der rohe User-Agent wird mitgespeichert.
3. **Mail "Neue Anmeldung"** an die Person: Zeitpunkt, Gerät/Browser, IP-Adresse, Hinweis
   "Warst du das nicht? Melde dich bei …" (Kontakt = Admin-Adresse aus der Konfiguration).
   Nicht bei der allerersten Anmeldung einer Person überhaupt. Mail-Typ `neues-geraet`,
   bearbeitbare Vorlage, immer sofort.
4. **Seitenaufrufe**: nur angemeldete Personen, nur HTML-Seiten (keine Assets, keine
   Maschinen-Routen `/api/n8n`, `/internal/cron`), Pfad **ohne Query-String** und mit IDs
   normalisiert (`/kontierung/:id`) für die Statistik, der echte Pfad zusätzlich für die
   Detailansicht.
5. **Fehler-ID** = die bestehende Anfrage-ID (Request-Korrelation des Audit-Pakets), gekürzt
   angezeigt (8 Zeichen) — so lassen sich Fehler, Audit-Einträge und Logs zusammenführen.
6. **Fehler melden**: Formular auf der Fehlerseite (CSRF), Beschreibung optional, max. 2000
   Zeichen; auch ohne vorangegangenen Fehler über einen Link "Problem melden" in der
   Seitenleiste. Mail an alle Personen mit `betrieb_einsehen` (Typ `fehlermeldung`).
7. **Banner**:
   - Art Info: wegklickbar (pro Person gemerkt, serverseitig).
   - Art Wartung und Warnung: nicht wegklickbar, bis der Zeitraum endet.
   - Mehrere gleichzeitig gültige Banner stehen untereinander, die Wartung zuerst.
   - Kein HTML, nur Text; Zeilenumbrüche erlaubt; ein optionaler Link (`https://` oder
     relativer Portal-Pfad).
8. **Datenschutzhinweis**: beim Start einmalig als Info-Banner angelegt; Seite `/datenschutz`
   mit Text (Welche Daten, Zweck, Aufbewahrung, wer Zugriff hat), Text über Admin → Betrieb
   bearbeitbar; Link im Fuss der Seitenleiste.
9. **Löschung** nach Ablauf über einen täglichen Job (`nutzungsdaten-bereinigung`).
10. **Performance**: Seitenaufrufe werden gesammelt geschrieben (am Ende der Anfrage, ein
    INSERT; bei Fehler still verwerfen und einmal pro Stunde loggen). Keine Audit-Trigger auf
    den Nutzungsdaten-Tabellen (Masse), aber auf Bannern, Fehlermeldungs-Status und
    Datenschutztext.

## Einschränkungen

- Bestehende Bausteine: `auditRequestContext`/`currentAuditRequestId` (Anfrage-ID),
  zentraler Fehler-Handler in `src/app.js`, Session-Login in `src/routes/auth.js`,
  Mail-Outbox (`sendNotification`), Scheduler, additive Rechte, Shell-Layout.
- Schweizer Datenschutzgesetz (revDSG): Information der Betroffenen (Datenschutzhinweis),
  Zweckbindung, Aufbewahrung begrenzt.
- Backups enthalten die Nutzungsdaten bis zu deren Ablauf in den Backups.

## Dem Builder überlassen

- Tabellenschema, Indizes, Aggregationsabfragen.
- User-Agent-Erkennung ohne neue Abhängigkeit (einfache Regeln reichen) oder mit einer kleinen,
  gepflegten Bibliothek, falls die Regeln nicht reichen.
- Layout der Übersicht im Shell-Layout (Desktop).
- Tests: Erfassen scheitert nie den Aufruf, Datenschutz (kein Query-String, keine
  Formularinhalte), Neues-Gerät-Logik inkl. erste Anmeldung, Banner-Sichtbarkeit und
  Wegklicken, Löschfristen, Rechte, Fehlerseite ohne Stacktrace.
