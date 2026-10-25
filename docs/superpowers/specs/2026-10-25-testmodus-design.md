# Testmodus (Spielwiese) — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 3 des Backlogs vor dem Launch.

## Absicht und Warum

Admins sollen (a) die **Abläufe** des Portals mit Beispieldaten durchspielen und vorführen können
(Kontieren, Freigeben, Ablehnen, Aufsplitten, Spesen, Kreditkarten) und (b) **Einstellungen
gefahrlos ausprobieren** (Eskalationszeiten, Module, Mailvorlagen, Banner, Zuweisungsregeln …),
ohne dass im echten Betrieb etwas passiert.

## Ziele

1. Ein Admin schaltet den Testmodus für **seine eigene Sitzung** ein und aus. Solange er an ist,
   arbeitet er ausschliesslich in einer **getrennten Spiel-Datenbank**; ein deutliches Band
   "Testmodus — nichts hier ist echt" steht oben auf jeder Seite.
2. **Keine Wirkung nach aussen** im Testmodus: Mails werden nur in einem Test-Postfach angezeigt,
   keine ChurchTools-Schreib- oder Leseaufrufe (Personen/Gruppen kommen aus den Beispieldaten),
   keine Übergabe an n8n/Paperless/Bexio, keine echten Zeitstempel (Zeitstempel-Schritte werden
   übersprungen und als "Testmodus" markiert), keine Backups der Spiel-Datenbank.
3. **Beispieldaten**: Beispielpersonen mit Rollen (z. B. Anna Freigeberin 1, Ben Freigeber 2,
   Carla Spesen-Einreicherin, Dora Admin), zwei bis drei Konten, Kreditoren, einige Rechnungen in
   verschiedenen Stufen (Pool, zugewiesen, Freigabe 2, abgelehnt, abgeschlossen) mit
   Beispiel-PDFs, eine Spesenabrechnung.
4. **Einstellungen**: Die Spiel-Datenbank startet mit einer **Kopie der aktuellen Einstellungen**
   (admin_config ohne Geheimnisse, Mailvorlagen, Module, Eskalationszeiten, Branding), damit man
   auf dem echten Stand ausprobiert.
5. **Rolle wechseln**: Im Testmodus wählt man oben, als welche Beispielperson man handelt — so lässt
   sich ein ganzer Ablauf inkl. Vier-Augen-Prinzip allein durchspielen.
6. **Zurücksetzen**: Knopf "Spielwiese zurücksetzen" stellt Beispieldaten und Einstellungs-Kopie
   neu her.

## Nicht-Ziele

- **Keine Übernahme** von Einstellungen aus dem Testmodus in den echten Betrieb per Knopf
  (Nutzerentscheid: manuell nachstellen).
- Kein Testmodus für Nicht-Admins (Schulung neuer Freigebender läuft über einen Admin, der
  vorführt).
- Keine Kopie echter Rechnungen, Personen oder Belege in die Spielwiese.

## Anti-Ziele

- Eine Aktion im Testmodus verändert die echte Datenbank, verschickt eine echte Mail oder ruft
  ChurchTools, n8n, Paperless, Bexio oder den Zeitstempeldienst auf.
- Man vergisst, dass man im Testmodus ist (Band muss unübersehbar sein, auch am Handy).
- Echte Personen- oder Rechnungsdaten tauchen in der Spielwiese auf.

## Vom Nutzer entschieden

1. Zweck: **Abläufe demonstrieren** und **Einstellungen testen**.
2. Bewährte Einstellungen werden **manuell** ins echte Portal übernommen.
3. Einschalten dürfen **nur Admins**.

## Entscheidungen des Entwurfs (meine Calls)

1. **"Admins"** = Superadmin und Manager (die beiden Admin-Rollen); kein eigenes Einzelrecht.
2. **Architektur**: eine zweite, vollständig getrennte App-Instanz mit eigener SQLite-Datei
   (`<DB_PATH>.testmodus.db`), eigenem Dateiverzeichnis (`<JOBS_DIR>-testmodus`), einem
   Test-Mailer (schreibt nur ins Test-Postfach), deaktivierter ChurchTools-, n8n-, TSA- und
   Backup-Anbindung und **ohne Scheduler** (Jobs nur per Knopf auf der Testmodus-Seite).
   Eine Weiche ganz vorne in der echten App leitet Anfragen einer Sitzung mit eingeschaltetem
   Testmodus an die Test-Instanz weiter. Anmeldung und Sitzung bleiben in der echten App; in der
   Test-Instanz ist `currentPerson` die gewählte Beispielperson.
3. **Einschalten/Ausschalten**: auf `Admin → Testmodus`; Ausschalten zusätzlich direkt im Band.
   Beim Abmelden endet der Testmodus. Ein- und Ausschalten wird im echten Audit-Log vermerkt.
4. **Test-Postfach**: Seite im Testmodus, die alle "gesendeten" Mails mit Empfänger, Betreff und
   Text zeigt.
5. **Uploads im Testmodus** sind erlaubt (eigene PDFs zum Ausprobieren) und landen nur im
   Test-Verzeichnis; Zurücksetzen löscht sie.
6. **Kopierte Einstellungen**: alle `admin_config`-Werte ausser Schlüsseln, deren Name
   `secret`, `token`, `pass`, `key` enthält, sowie ausser `monitoring_secret`; Branding-Dateien
   werden kopiert.
7. **Statusseite/Monitoring** berücksichtigen den Testmodus nicht (beziehen sich nur auf den echten
   Betrieb).
8. **Responsive**, Band auch am Handy sichtbar.

## Einschränkungen

- `createApp` erhält heute `db`, `config`, `mailer` — die Test-Instanz wird mit eigenen Werten
  derselben Funktion erzeugt; Stellen, die globale Singletons nutzen (z. B. Scheduler-Start,
  Sync-Token), müssen in der Test-Instanz nachweislich aus sein.
- Beispiel-PDFs liegen im Repository (kleine, selbst erzeugte Dateien ohne echte Daten).

## Dem Builder überlassen

- Genaue Beispieldaten und Beispiel-PDFs.
- Wie die Weiche die Sitzung erkennt (Session-Flag) und wie die Test-Instanz die Beispielperson
  bestimmt.
- Tests: Isolation (Aktion im Testmodus → echte DB unverändert, kein Mailer-/fetch-Aufruf nach
  aussen), nur Admins, Zurücksetzen, Rollenwechsel inkl. Vier-Augen, Band auf jeder Seite,
  Abmelden beendet Testmodus, keine Geheimnisse kopiert.
