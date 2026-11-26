# Spesen-Bestätigungsmail an die einreichende Person

Stand: 2026-11-26 · Status: Entwurf zur Freigabe

## Absicht

Wer Spesen einreicht, erfährt heute nur von Ablehnungen. Neu bekommt die einreichende Person eine Bestätigung, sobald ihre
Spesenabrechnung vollständig erledigt ist: mit den gestempelten Belegen als Anhang und dem Vermerk, dass die Spesen nun zur
Auszahlung vorbereitet werden. Die Mail ist zugleich Quittung für die eigenen Unterlagen. Ein Portal-Link genügt dafür nicht,
weil die Beleg-PDFs 7 Tage nach der Archivquittung gelöscht werden (`ARCHIVE_RETENTION_MS`, Job `pdf-bereinigung`).

## Ziele

- Eine Mail **pro Spesenabrechnung** (`spesenabrechnungen`), nicht pro Position.
- Ausgelöst, sobald **jede** Position der Abrechnung erledigt ist:
  - *freigegeben*: n8n hat den Versand an Bexio bestätigt (`POST /api/n8n/jobs/:id/bexio-versand-bestaetigen`, Eintrag in `bexio_versand`), oder
  - *nicht durchgekommen*: Status `abgelehnt` oder `geloescht`.
- Mindestens eine Position muss freigegeben sein; sonst keine Bestätigung (die Ablehnungsmails genügen).
- Inhalt: freigegebene Positionen (Beschreibung, Betrag, Summe) mit ihren gestempelten PDFs als Anhang; abgelehnte/gelöschte
  Positionen werden kurz erwähnt (Beschreibung, Betrag, Ablehnungsgrund), ohne Anhang.
- Bleibt eine Position offen, wartet die Mail, auch wochenlang.
- Höchstens eine Bestätigung pro Abrechnung, auch bei doppelten n8n-Meldungen oder parallelen Auslösern.
- Text als bearbeitbare Vorlage unter Admin → Benachrichtigungen (Muster `mailTemplates.js`, `%platzhalter%`).

## Nicht-Ziele

- Keine Änderung am n8n-Workflow; die bestehende Versandquittung ist der Auslöser.
- Keine Auszahlungsfunktion, kein Auszahlungsdatum, keine IBAN in der Mail.
- Keine Bestätigung pro Position, keine Zwischenmeldung «2 von 3 erledigt».
- Keine Bestätigung für Rechnungen, Kreditkarten oder Rapporte.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Nach dem Deployment gehen Bestätigungen für **alte**, längst erledigte Abrechnungen raus.
- Dieselbe Abrechnung wird zweimal bestätigt.
- Eine Mail kommt ohne Anhang an, weil die Bereinigung das PDF inzwischen gelöscht hat.
- Die Bestätigung landet im Digest und kommt erst Tage später.

## Ansätze

| | Ansatz | Abwägung |
|---|---|---|
| **A (gewählt)** | Zentrale Prüfung «Abrechnung erledigt?» bei jedem Ereignis, das eine Position abschliesst (Bexio-Versandquittung, Ablehnung), plus nächtlicher Nachhol-Durchlauf | Mail sofort nach dem letzten Ereignis; Prüfung muss an den Auslösestellen eingehängt werden |
| B | Nur ein periodischer Job (z. B. alle 15 Min.) sucht erledigte Abrechnungen | Eine einzige Stelle im Code, aber Verzögerung und ein weiterer Takt im Scheduler |
| C | n8n verschickt die Mail selbst | Verworfen: n8n kennt weder die Abrechnungs-Gruppierung noch die Mailadresse (nur `eingereicht_von` als CT-ID), und es fehlen Vorlagen, Outbox und Audit |

Entschieden von der auftraggebenden Person: Versand im Portal, Auslöser Bexio-Versandquittung, eine Mail pro Abrechnung,
abgelehnte Positionen erwähnen, auf offene Positionen warten, Ansatz A.

## Entwurf

### 1. Erledigt-Prüfung (neuer Service `services/spesenBestaetigung.js`)

`pruefeSpesenBestaetigung(db, spesenabrechnungId)`:

1. Abrechnung laden; ist `bestaetigung_am` bereits gesetzt → nichts tun.
2. Alle Positionen (`jobs.spesenabrechnung_id = ?`) laden.
3. Jede Position ist *freigegeben* (es gibt eine Zeile in `bexio_versand` zum Job) oder *nicht durchgekommen* (`abgelehnt`,
   `geloescht`). Sonst → nichts tun.
4. Keine freigegebene Position → `bestaetigung_am` mit Vermerk «keine» setzen (damit der Nachhol-Durchlauf sie nicht ewig
   wieder prüft), keine Mail.
5. Sonst in **einer Transaktion** (`BEGIN IMMEDIATE`): Marker `bestaetigung_am` setzen (bedingt `WHERE bestaetigung_am IS NULL`,
   0 Zeilen → abbrechen, jemand anderes war schneller), Mail mit Anhängen in `mail_log` einreihen.

Aufgerufen von:
- `bestaetigeBexioVersand` (nach Commit, nur wenn `job.quelle = 'spesen'` und die Quittung neu ist),
- den beiden Ablehnungswegen für Spesen (`routes/spesenFreigabe1.js` und `routes/freigabe2.js`, nach erfolgreichem `ablehnenJob`),
- einem nächtlichen Nachhol-Durchlauf (alle Abrechnungen mit `bestaetigung_am IS NULL`, deren Positionen alle erledigt sind).

Löschen braucht keinen eigenen Aufruf: Gelöscht werden darf nur ein bereits abgelehnter Vorgang, der schon als erledigt zählt.

Ein Fehler in der Bestätigung darf die Versandquittung bzw. die Ablehnung **nie** scheitern lassen: Aufruf nach dem Commit,
Fehler protokollieren; der Nachhol-Durchlauf holt es nach.

### 2. Beleg-Kopie für den Anhang

Bei jeder neuen Bexio-Versandquittung einer Spesenposition wird das gestempelte End-PDF (das Exportdokument, dessen Hash im
Exportnachweis steht) in ein eigenes Verzeichnis kopiert (`<DATA_DIR>/mail-anhaenge/`) und in einer neuen Tabelle vermerkt
(Job, Pfad, SHA-256). Dadurch hat die Mail ihren Anhang auch dann, wenn die Abrechnung erst nach der 7-Tage-Frist erledigt
ist. Fehlt das PDF bereits beim Kopieren (sollte nicht vorkommen), wird die Position in der Mail ohne Anhang aufgeführt und
eine Warnung protokolliert.

### 3. Anhänge in der Mail-Outbox

- `mailer.sendMail({to, subject, text, attachments})` reicht `attachments` an nodemailer durch.
- Neue Tabelle `mail_anhaenge` (mail_log_id, dateiname, pfad, sha256); `reiheMailEin` nimmt optional eine Anhangsliste an.
- Die Zustellung liest die Dateien beim Versuch, prüft den Hash und hängt sie an. Fehlt eine Datei → Versuch scheitert
  mit klarer Fehlermeldung (normaler Wiederholungsweg, sichtbar unter `/admin/mails`).
- Nach `versendet` werden die Anhangsdateien gelöscht (mit Audit, wie andere Dateilöschungen). Bei `fehlgeschlagen` bleiben
  sie für die manuelle Wiederholung liegen und fallen unter die bestehende `mail_log`-Aufbewahrung.
- Dateiname im Anhang: lesbar aus Abrechnungstitel und Positionsnummer (Muster `belegName.js`).

### 4. Mailtyp und Vorlage

- Neuer Typ `spesen-bestaetigung`: in `TYP_ZU_KEY_INFIX`, `mail_log`-CHECK (Migration), Standardtexte in
  `adminConfigRepo.js` DEFAULTS, Vorlagen-Editor unter Admin → Benachrichtigungen.
- **Immer sofort**, nie im Digest (Anhänge passen nicht in die Sammelmail): in die Liste der Sofort-Typen in `notify.js`.
- Platzhalter: `%name%`, `%titel%`, `%eingereicht_am%`, `%positionen%` (freigegebene, je Zeile Beschreibung + Betrag),
  `%summe%`, `%nicht_freigegeben%` (abgelehnte/gelöschte mit Grund; leer, wenn keine), `%portal_url%`.
- Standardtext sinngemäss: «Deine Spesenabrechnung «%titel%» ist freigegeben. Die folgenden Positionen werden nun zur
  Auszahlung vorbereitet: … Die gestempelten Belege findest du im Anhang.»

### 5. Kein Massenversand beim Deployment

Die Migration, die `spesenabrechnungen.bestaetigung_am` anlegt, setzt für alle Abrechnungen, die zu diesem Zeitpunkt schon
erledigt sind, den Wert auf den Migrationszeitpunkt mit Vermerk «altbestand». Nur Abrechnungen, die nach dem Deployment
erledigt werden, bekommen eine Mail.

### 6. Ein-/Ausschalter

Admin → Benachrichtigungen erhält einen Schalter «Spesen-Bestätigung an Einreichende» (Standard: an). Ist er aus, setzt die
Prüfung den Marker trotzdem (Vermerk «deaktiviert»), damit beim Wiedereinschalten keine Altlast nachgeschickt wird.

### 7. Doku und Tests

- Doku: `docs/benachrichtigungen` bzw. Mail-Typen-Liste, `docs/n8n-schnittstelle.md` (Bexio-Quittung löst bei Spesen die
  Bestätigung aus), Anwender-Anleitung (Abschnitt Spesen), Testdrehbuch (neues Szenario).
- Tests: alle drei Positionen freigegeben → eine Mail mit drei Anhängen; 2 freigegeben + 1 abgelehnt (Ablehnung als
  letztes Ereignis) → Mail erwähnt Ablehnung; alle abgelehnt → keine Mail; offene Position → keine Mail; doppelte
  Bexio-Quittung → eine Mail; PDF nach Bereinigung gelöscht → Anhang aus Kopie; Migration markiert Altbestand;
  Schalter aus → keine Mail; Fehler in der Bestätigung lässt die Quittung trotzdem durch.

## Vom Bauenden selbst zu klären / eigene Entscheidungen (zur Prüfung markiert)

- **Eigene Entscheidung:** `geloescht` zählt wie `abgelehnt` als «nicht durchgekommen».
- **Eigene Entscheidung:** Schalter mit Standard «an» (Abschnitt 6).
- **Eigene Entscheidung:** Übersteigen die Anhänge zusammen 15 MB, geht die Mail ohne Anhänge raus, mit dem Hinweis, die
  Belege bei der Finanzverwaltung anzufordern, und `/admin/mails` zeigt eine Warnung. Spesenbelege sind in der Regel klein;
  eine Aufteilung auf mehrere Mails wäre unverhältnismässig.
- **Eigene Entscheidung:** Keine IBAN in der Mail (Nicht-Ziel), auch nicht maskiert.
- Abgelehnte Spesenpositionen sind heute faktisch endgültig (keine Wiederöffnen-Liste für Spesen). Falls ein Admin-Weg
  (z. B. Umhängen) eine abgelehnte Position wieder aktiv machen kann, bevor die Bestätigung raus ist, wird sie einfach
  wieder als offen gezählt; nach dem Versand ist das ohne Wirkung auf die Mail.
- Name der neuen Spalte/Tabellen und genaue Verzeichnisstruktur.
