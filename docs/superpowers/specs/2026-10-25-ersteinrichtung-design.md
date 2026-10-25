# Geführte Ersteinrichtung — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 2 des Backlogs vor dem Launch. Baut auf der Statusseite auf
(`2026-10-25-statusseite-monitoring-design.md`).

## Absicht und Warum

Das Portal soll nicht nur vom Entwickler, sondern **auch von Personen ohne technisches Wissen**
in Betrieb genommen werden können (z. B. eine weitere Gemeinde, oder wenn der Entwickler nicht
verfügbar ist). Heute steht die Einrichtung verstreut im README (Umgebungsvariablen,
Superadmin-Bootstrap, Go-Live-Checkliste mit `curl`-Befehlen). Ein Assistent im Portal soll durch
alles führen und zeigen, was noch fehlt.

## Ziele

1. **Assistent** `Admin → Ersteinrichtung` mit Schritten, Fortschritt und "später weitermachen".
2. **Technische Grundlagen prüfen** (bleiben beim Hoster): Umgebungsvariablen vorhanden und gültig,
   Speicherpfade beschreibbar und nicht im Deploy-Verzeichnis, HTTPS/`PUBLIC_BASE_URL` stimmt,
   ChurchTools-Verbindung (Testabruf der Gruppen mit dem Sync-Token), Mailversand (Testmail an die
   eigene Adresse). Bei Fehlern: verständliche Erklärung, was fehlt und wo man es beim Hoster
   einträgt — ohne geheime Werte anzuzeigen.
3. **Im Portal einrichten**, je ein Schritt mit Link/Formular zur bestehenden Admin-Seite:
   Name und Logo · Rollen/Gruppen kontrollieren (wer ist Superadmin, Manager) · Konten mit
   Freigebenden · Kreditoren · Zeitstempeldienst · Mailvorlagen (optional) · Module ·
   Backup (eine Sicherung auslösen und prüfen) · Monitoring-Schlüssel · Kontaktadresse und
   Datenschutztext · erster ChurchTools-Abgleich.
4. **Go-Live-Prüfung** am Schluss als Hilfe zur Go-Live-Checkliste im README (Cron-Läufe einmal
   auslösen, Testmail zugestellt, Sicherung vorhanden, Statusseite ohne Fehler). Die README-Liste
   bleibt unverändert die massgebliche Anleitung (Nutzerentscheid).

## Nicht-Ziele

- ChurchTools-, SMTP- und andere Zugangsdaten werden **nicht** im Portal gespeichert (bleiben
  Umgebungsvariablen beim Hoster).
- Kein Import von Stammdaten (nicht gewählt).
- Kein Installations-Assistent vor dem ersten Start (ohne Umgebungsvariablen startet das Portal
  nicht; dafür bleibt die README-Anleitung).

## Anti-Ziele

- Der Assistent zeigt Geheimnisse (Tokens, Passwörter, Schlüssel) an oder speichert sie.
- Ein Schritt gilt als erledigt, obwohl die Sache nicht funktioniert (z. B. Mail "eingerichtet",
  aber nie zugestellt).
- Der Assistent blockiert den normalen Betrieb oder lässt sich nicht überspringen.

## Vom Nutzer entschieden

1. Auch **andere Personen** sollen einrichten können.
2. Technische Zugangsdaten **bleiben beim Hoster**; der Assistent **prüft** sie und erklärt; alles
   andere wird im Portal Schritt für Schritt erledigt.
3. Der Assistent ist eine **Hilfe**; die Go-Live-Checkliste im README wird **nicht ersetzt**.

## Entscheidungen des Entwurfs (meine Calls)

1. **Zugang**: nur Superadmin (wer per `CT_GROUP_ID_ADMIN` Superadmin ist). Der erste Superadmin
   entsteht weiterhin über die ChurchTools-Gruppe; der Assistent erklärt das im ersten Schritt
   und zeigt, wer aktuell Superadmin/Manager ist.
2. **Anzeige**: Solange nicht alle Pflichtschritte erledigt sind, zeigt das Admin-Dashboard einen
   Hinweis "Ersteinrichtung: 5 von 12 Schritten erledigt" mit Link; ein Superadmin kann ihn mit
   "später" für 7 Tage ausblenden. Kein Zwang, keine Sperre.
3. **Erledigt-Status wird gemessen, nicht angeklickt**, wo es geht: z. B. "Konten" erledigt, sobald
   ein aktives Konto mit Freigeber 1 und 2 existiert; "Backup" erledigt, wenn eine Sicherung jünger
   als 7 Tage existiert und `backup:verify`-gleiche Prüfung im Portal ok ist; "Mail" erledigt, wenn
   die Testmail als `versendet` protokolliert ist. Nur für rein inhaltliche Schritte (Mailvorlagen,
   Datenschutztext gelesen) gibt es "als erledigt markieren".
4. **Pflicht vs. optional**: Pflicht = technische Grundlagen, Konten, Zeitstempeldienst *oder*
   bewusst "ohne Zeitstempel", Backup, ChurchTools-Abgleich, Kontaktadresse. Optional = Logo,
   Mailvorlagen, Module, Kreditoren, Monitoring.
5. **Tests im Assistenten**: "ChurchTools testen" ruft die konfigurierten Gruppen über den
   Sync-Token ab und zeigt Gruppenname und Mitgliederzahl; "Testmail senden" schickt an die
   Adresse des Superadmins über die normale Warteschlange und zeigt den Status live (Neu laden).
   "Cron-Läufe auslösen" startet die Jobs direkt im Prozess (kein `curl`, kein Cron-Secret nötig).
6. **Umgebungsvariablen-Prüfung** nutzt die bestehende Validierung (`config/env.js`) und meldet
   pro Variable nur "fehlt", "zu kurz", "ungültig" oder "ok" — nie den Wert. Speicherpfade: prüft
   Schreibbarkeit und warnt, wenn ein Pfad innerhalb des Anwendungsverzeichnisses liegt.
7. **Verknüpfung mit der Statusseite**: offene Pflichtschritte erscheinen dort als eigener Dienst
   `einrichtung` (Warnung), damit Uptime Kuma es auch sieht; nach Abschluss `ok`.
8. **Responsive** wie alle neuen Seiten.

## Einschränkungen

- Bestehende Admin-Seiten werden verlinkt, nicht nachgebaut.
- Jobs werden über die bestehenden Job-Funktionen ausgelöst (wie Admin → Geplante Jobs).
- Audit: jeder "als erledigt markieren"-Klick und jedes Auslösen eines Tests landet im Audit-Log.

## Dem Builder überlassen

- Darstellung (Schrittliste mit Status, je Schritt Erklärung + Aktion).
- Genaue Texte (verständlich, ohne Fachjargon; Hoster-Hinweise allgemein, Infomaniak als
  Beispiel).
- README: Go-Live-Checkliste bleibt bestehen; nur ein kurzer Hinweis, dass der Assistent im Portal
  dabei hilft.
- Tests: Erledigt-Messung pro Schritt, keine Geheimnisse in der Antwort, nur Superadmin, Dashboard-
  Hinweis und "später", Statusdienst `einrichtung`.
