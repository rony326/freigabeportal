# Mail-Empfang & -Versand nativ im Portal — Design

## Kontext & Ziel

Das Lastenheft (`docs/superpowers/specs/rechnungsfreigabe.md`) sieht n8n als
alleiniges Mail-Gateway vor: n8n pollt das Rechnungspostfach per IMAP, extrahiert
den PDF-Anhang und pusht ihn per API-Key-Upload an `POST /n8n/jobs`; am anderen
Ende des Flows holt n8n abgeschlossene Jobs über `GET /n8n/jobs/abholbereit` ab,
lädt sie in Paperless-ngx und verschickt sie per SMTP an die Bexio-Importadresse.
Das Portal selbst verschickt heute ausschliesslich reine Text-Benachrichtigungen
(Zuweisung/Reminder/Eskalation/Ablehnung, `services/notify.js`) — kein Empfang,
keine Anhänge, kein Bexio- oder Lieferanten-Versand.

Dieses Design bringt vier bisher n8n-exklusive bzw. gar nicht existierende
Fähigkeiten direkt ins Portal: **E-Mail-Empfang** (natives IMAP-Polling),
**PDF-Sanitization**, **PDF/A-Konvertierung** und **erweiterten Versand**
(Anhänge an Benachrichtigungen, Bexio-Versand, optionale
Zahlungsbestätigung an den Lieferanten).

**Bewusst kein Ersatz für n8n als Ganzes** — n8n bleibt für Scanner-Uploads
(`POST /n8n/jobs` ändert sich nicht) und für die Paperless-ngx-Ablage
(`/n8n/jobs/abholbereit`-Flow ändert sich nicht) zuständig, da Paperless-ngx
intern/on-prem ist und dieses Design das nicht anfasst.

## Architektur & Übersicht

Alle neuen Komponenten sind reines JS/WASM (keine System-Pakete wie
Ghostscript/qpdf) — läuft unverändert auf dem Infomaniak-Managed-Node-Hosting:

| Komponente | Zweck | Neue Abhängigkeit |
|---|---|---|
| `services/imapReceiver.js` | Pollt das Rechnungspostfach per IMAP, extrahiert PDF-Anhänge | `imapflow` + `mailparser` |
| `services/pdfSanitize.js` | Entfernt aktive Inhalte aus jedem eingehenden PDF | keine (pdf-lib) |
| `services/pdfa.js` | Best-effort PDF/A-Konvertierung am Ende des Freigabe-Flows | keine (pdf-lib) |
| `services/mailer.js` (erweitert) | Anhänge beim Versand | keine (nodemailer unterstützt das nativ) |
| Bexio-/Zahlungsbestätigungs-Versand | Hook im Abschluss von `freigabe2.js` | keine |

`imapflow`/`mailparser` sind bewusst gewählt: beide vom nodemailer-Autor
gepflegt, pure JS, kein natives Binary — passt zum bereits vorhandenen
nodemailer-Ökosystem und zur Hosting-Einschränkung.

### Vier unabhängige Admin-Schalter statt fest verdrahteter Architektur

Der Betrieb soll flexibel zwischen "alles im Tool", "alles via n8n" und
gemischten Konstellationen wechseln können, ohne Code-Änderung — daher vier
unabhängige `admin_config`-Werte statt eines globalen Modus:

- **`mail_empfang_modus`**: `n8n` | `portal`. Steuert nur, ob der neue interne
  IMAP-Poller läuft. `POST /n8n/jobs` bleibt in jedem Fall erreichbar (Scanner
  braucht ihn immer). Default `n8n` — ändert am heutigen Betrieb nichts, bis
  aktiv umgeschaltet wird.
- **`bexio_versand_modus`**: `n8n` | `portal`. Steuert, ob das Portal beim
  Job-Abschluss selbst an Bexio verschickt, oder ob (wie heute) n8n über den
  Abholung-Flow verschickt. Default `n8n`.
- **`pdf_sanitization_modus`**: `n8n` | `portal`. `n8n` bedeutet: die
  Sanitization wird ausserhalb des Portals gelöst (z. B. über einen
  Stirling-PDF-Schritt in n8n) — das Portal überspringt seinen eigenen
  Sanitization-Schritt. Default **`portal`** (abweichend von den beiden oben) —
  es gibt aktuell *nirgendwo* eine Sanitization, weder im Portal noch in n8n;
  ein `n8n`-Default würde die Funktion also faktisch abschalten statt einen
  bestehenden Zustand zu bewahren.
- **`pdf_pdfa_modus`**: `n8n` | `portal`. Gleiche Logik wie oben, gleicher
  Default `portal`.
- **`zahlungsbestaetigung_aktiv`**: `0` | `1`. Kein Modus-Schalter, da es dafür
  keinen bestehenden n8n-Pfad gibt, der bewahrt werden müsste — reines
  Ein/Aus, Default `0`.

**Bekannter, bewusst nicht automatisch verhinderter Konflikt:** Ist
`mail_empfang_modus = portal`, aber `pdf_sanitization_modus = n8n` gesetzt,
sieht n8n die betroffene Mail nie — das PDF bliebe unsanitized, weil niemand
es verarbeitet. Das lässt sich nicht ohne das Sperren ganzer
Konfigurationskombinationen verhindern; stattdessen bekommt die neue
Admin-Seite (siehe unten) einen Hinweistext, der diese Abhängigkeit erklärt.
Ebenso: schaltet ein Admin `bexio_versand_modus` auf `portal`, ohne den
entsprechenden n8n-Workflow-Schritt zu deaktivieren, geht die Rechnung
doppelt an Bexio raus — das Portal hat keinen Zugriff auf n8n (intern,
on-prem) und kann das nicht selbst verhindern. Beides wird im Hinweistext der
Admin-Seite und in der README als Betriebs-Verantwortung dokumentiert.

## Datenmodell

- `admin_config` neu (mit Defaults): `mail_empfang_modus` (`n8n`),
  `bexio_versand_modus` (`n8n`), `pdf_sanitization_modus` (`portal`),
  `pdf_pdfa_modus` (`portal`), `zahlungsbestaetigung_aktiv` (`0`),
  `bexio_import_adresse` (``), `cron_imap_abruf_intervall_minuten` (`10`).
- `.env` neu, gleiches Muster wie die bestehenden `SMTP_*`-Variablen
  (Zugangsdaten gehören zu Secrets in `.env`, nicht in die DB):
  `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_ORDNER`. Optional
  bis ein IMAP-Zugang final konfiguriert ist — analog zu SMTP fällt der
  IMAP-Poller bei fehlender Konfiguration auf "inaktiv, loggt eine
  Warnung" zurück statt den Prozess-Start zu blockieren.
- `jobs` neu: `bexio_versendet_am TEXT` (nullable) — gleiches Muster wie
  `zeitstempel_gesetzt_am`, Basis für den Nachhol-Retry unten.
- `mail_log.typ`-CHECK erweitert um `'bexio-versand'` und
  `'zahlungsbestaetigung'`.

Keine Schemaänderung an `debitoren` — die Zahlungsbestätigung nutzt
`job.absender` als Empfänger (siehe Ablauf-Abschnitt), keine gepflegte
Lieferanten-E-Mail-Adresse.

## Ablauf & Fehlerbehandlung

### Empfang (`mail_empfang_modus = portal`)

Neuer Scheduler-Job nach dem bestehenden `scheduleInterval`-Muster
(`services/scheduler.js`), Intervall aus `cron_imap_abruf_intervall_minuten`
live nachgelesen (wie bei den vier bestehenden Jobs). Pro Lauf:

1. Verbindung per `imapflow` zum konfigurierten Postfach/Ordner (`IMAP_ORDNER`).
2. Für jede ungelesene Mail: Parsing per `mailparser`, iterieren über
   Attachments, nur `application/pdf` (bzw. Magic-Bytes-Check wie im
   bestehenden `isPdf()` aus `n8n/jobs.js`) berücksichtigen — andere
   Dateitypen werden ignoriert (kein Konvertieren aus Bildern/Office-Docs,
   wie besprochen).
3. Pro gefundenem PDF: derselbe Intake-Pfad wie der bestehende
   `POST /n8n/jobs`-Handler (`quelle: 'lieferant'`, `absender` = Envelope-From,
   `dateiname` = Original-Dateiname oder Fallback, `datei_hash`-Dedup,
   Thumbnail, QR-Scan, Auto-Zuweisung per Zuweisungsregel) — die gemeinsame
   Logik wird aus `n8n/jobs.js` in eine importierbare Funktion extrahiert,
   damit sie nicht dupliziert wird.
4. Mail ohne PDF-Anhang oder mit korruptem PDF (`isPdf()` schlägt fehl): Mail
   wird in einen `Fehler`-Unterordner verschoben, keine Job-Anlage.
   Erfolgreich verarbeitete Mails (mind. ein Job angelegt) wandern in einen
   `Verarbeitet`-Unterordner. Das Verschieben statt reinem Flag-Setzen macht
   den Zustand für einen Admin direkt im Mail-Client nachvollziehbar und ist
   robuster gegen ein zwischenzeitliches Postfach-Reset als IMAP-Flags.
5. Verschieben passiert erst **nach** erfolgreichem `createJob` (bzw. nach
   dem Schreiben in den Fehler-Ordner bei Ablehnung) — ein Absturz mitten im
   Lauf lässt die Mail unverändert im Posteingang, der nächste Lauf verarbeitet
   sie erneut; `datei_hash`-Dedup (bereits vorhanden) macht ein doppeltes
   `createJob` für dasselbe PDF ungefährlich.

### Sanitization (`pdf_sanitization_modus = portal`)

Läuft für **jedes** eingehende PDF unabhängig von der Quelle (Scanner-Upload,
n8n-Push, natives IMAP) direkt bei Job-Anlage, vor Thumbnail-Rendering und
QR-Scan — Verteidigung in der Tiefe, nicht nur für den Mail-Weg. Neue
Funktion `sanitizePdf(buffer)` in `services/pdfSanitize.js`, via pdf-lib:

- Entfernt `/OpenAction` aus dem Catalog.
- Entfernt den `/Names`-Eintrag `/JavaScript` (kompletter JS-Names-Tree).
- Entfernt `/Names`-Eintrag `/EmbeddedFiles`.
- Iteriert alle Seiten und deren `/Annots`: entfernt `/AA` (Additional
  Actions) auf Seiten- und Annotation-Ebene sowie Links mit
  `/A`-Subtype `/Launch` oder `/JavaScript`.

Bewusst **kein** Rasterizing/Flatten (verworfene Alternative) — Text- und
QR-Ebene bleiben erhalten, da sowohl `qrBillScan.js` als auch das
Paperless-ngx-Volltextsuche-Ziel (siehe Projekt-Memory zum Papierarchiv-Ziel)
davon abhängen. Fehlschläge (kaputtes/nicht parsbares PDF) werfen einen
deutschsprachigen Fehler nach demselben Muster wie `pdfStamp.js`s
`stampAndFinalize` — der Aufrufer (Job-Intake) behandelt das wie ein
ungültiges PDF und lehnt den Upload ab, statt ein unsanitiztes PDF
durchzulassen.

### PDF/A (`pdf_pdfa_modus = portal`)

Neue Funktion `convertToPdfA(buffer)` in `services/pdfa.js`, eingehängt in
`freigabe2.js` zwischen bestehenden Schritten:

```
stampAndFinalize  →  convertToPdfA  →  setZeitstempel
```

PDF/A-Konvertierung **muss** vor dem RFC3161-Zeitstempel laufen, sonst
invalidiert die nachträgliche Byte-Änderung den bereits gesetzten Zeitstempel.
Nebenbefund aus der Recherche: `pdfStamp.js` nutzt aktuell
`StandardFonts.Helvetica` — eine nicht eingebettete Standardschrift, was für
PDF/A grundsätzlich unzulässig ist. Im Zuge dieses Batches wird die
Stempel-Seite auf eine eingebettete Schrift (Font-Datei per `doc.embedFont()`
mit Subsetting) umgestellt, damit zumindest der vom Portal selbst erzeugte
Teil des Dokuments PDF/A-tauglich ist.

`convertToPdfA` setzt zusätzlich: XMP-Metadaten-Stream mit PDF/A-2B-
Konformitätsangabe, ein sRGB-`OutputIntent` (gebündeltes Standard-ICC-Profil),
Dokument-ID, `/Producer`/`/CreationDate`/`/ModDate`, entfernt `/Encrypt` falls
gesetzt.

**Explizit keine ISO-zertifizierte PDF/A-Konformität** — wie in der
Klärung besprochen, kann eine reine JS/WASM-Lösung ohne Ghostscript/qpdf
Schriften und Farbräume in bereits bestehenden, von Dritten erzeugten
Seiten des Original-PDFs nicht rückwirkend reparieren. Das deckt den
praktischen GeBüV-Archivierungszweck ab, ist aber keine
Zertifizierungsgarantie — wird so auch in der README/Admin-Hilfe
kommuniziert.

### Versand

**Anhänge an bestehende Benachrichtigungen**: `mailer.js`s `sendMail()` und
`notify.js`s `sendNotification()` bekommen einen optionalen `attachments`-
Parameter (nodemailer-natives `attachments: [{ filename, content }]`),
durchgereicht von den Aufrufstellen, die eine Job-PDF zur Hand haben
(z. B. Zuweisungs-Mail in `n8n/jobs.js` und im neuen IMAP-Empfangspfad).

**Bexio-Versand** (`bexio_versand_modus = portal`): Hook direkt nach
erfolgreichem `abschliessenFreigabe2`-Commit in `freigabe2.js`, analog zum
bereits etablierten Zeitstempel-Muster — best-effort inline versucht,
Fehler wird geloggt (`mail_log`, `typ: 'bexio-versand'`, `status:
'fehlgeschlagen'`) statt die Anfrage scheitern zu lassen, `job.status` bleibt
in jedem Fall `abgeschlossen`. Neuer Cron-Job `bexio-nachholen`
(`cronJobs.js`, gleiches Muster wie `zeitstempel-nachholen`, eigener
`cron_bexio_nachholen_intervall_minuten`-Wert) holt periodisch alle Jobs mit
`status = 'abgeschlossen'` und `bexio_versendet_am IS NULL` und versucht den
Versand erneut, bis er glückt.
Betreff/Text enthalten alle Metadaten (Kontonummer, Freigeber 1+2 inkl.
Interessenskonflikt-Status, Rechnungsnummer, Betrag), Anhang ist die finale
PDF (nach `convertToPdfA`/`setZeitstempel`), Empfänger `bexio_import_adresse`.
Bei Erfolg: `bexio_versendet_am = jetzt`.

**Zahlungsbestätigung an Lieferant** (`zahlungsbestaetigung_aktiv = 1`):
gleicher Trigger-Punkt wie Bexio-Versand, aber nicht Teil des
Nachhol-Retries (kein neues `*_versendet_am`-Feld — geringere Kritikalität
als der Bexio-Versand, ein einmaliger Best-effort-Versuch reicht,
Fehlschlag wird nur geloggt). Empfänger = `job.absender`; ist kein
`absender` gesetzt (z. B. `quelle = 'scanner'`), wird der Versand
stillschweigend übersprungen (kein Fehlerfall).

## Admin-GUI

Neue Seite `/admin/mail-einstellungen` (neue Route unter `routes/admin/`,
gleiches Muster wie `routes/admin/eskalation.js`):

- Die vier Modus-Schalter (Select mit `n8n`/`portal`) plus
  Zahlungsbestätigung-Checkbox, mit Hinweistext zu den beiden oben
  beschriebenen Konfigurationsfallstricken (Sanitization-Lücke,
  doppelter Bexio-Versand).
- `bexio_import_adresse`-Textfeld.
- IMAP-Ordner (`IMAP_ORDNER`, read-only-Anzeige aus `.env` — kein
  DB-Wert) und `cron_imap_abruf_intervall_minuten`.
- Ein "Posteingang jetzt abrufen"-Button, der den IMAP-Poll-Lauf manuell
  auslöst (gleiches Muster wie die bestehenden manuellen Cron-Trigger unter
  `/internal/cron/*`, hier aber im Admin-UI verdrahtet statt nur per HTTP).

`/admin/mails` (bestehende Mail-Log-Ansicht) bekommt keine strukturelle
Änderung, zeigt aber automatisch die neuen `typ`-Werte durch die bereits
generische Darstellung.

## Tests

- Unit-Tests: `sanitizePdf()` (JS/OpenAction/EmbeddedFiles/AA-Actions
  entfernt, Text bleibt lesbar), `convertToPdfA()` (XMP/OutputIntent
  vorhanden, gültiges PDF bleibt ladbar), IMAP-Attachment-Filter
  (nur PDF, Magic-Bytes-Check), Bexio-Mail-Text-Aufbau (alle
  Metadatenfelder vorhanden).
- Integrationstests: kompletter Empfangspfad gegen einen
  `imapflow`-Testdouble (kein echter IMAP-Server im Testlauf) —
  Mail mit PDF → Job angelegt, sanitized; Mail ohne PDF → in
  Fehler-Ordner verschoben, kein Job. Bexio-Nachhol-Cron: ein
  `abgeschlossen`-Job ohne `bexio_versendet_am` wird beim Lauf verschickt
  und markiert, ein bereits versendeter wird übersprungen (Idempotenz,
  gleiches Muster wie die bestehende `zeitstempel-nachholen`-Suite).
- Ende-zu-Ende-Test nach D1–D4/E1/E2-Muster: Job über die echten Routen bis
  `abgeschlossen` treiben mit allen vier Modus-Schaltern auf `portal`,
  bestätigen dass PDF sanitized+PDF/A-konvertiert+zeitgestempelt ist und
  eine Bexio-Mail mit Anhang im `mail_log` steht.

## Nicht Teil von diesem Batch

Kein automatisches Verhindern widersprüchlicher Modus-Kombinationen (siehe
Architektur-Abschnitt) — nur Hinweistext. Keine gepflegte
Lieferanten-E-Mail-Adresse in `debitoren` (Zahlungsbestätigung nutzt
`job.absender`). Keine Konvertierung von Nicht-PDF-Anhängen (Bilder/Office-
Dokumente) zu PDF. Keine Nachhol-Retry-Logik für die Zahlungsbestätigung
(nur für Bexio-Versand, siehe oben). Keine Änderung an
`/n8n/jobs/abholbereit` oder der Paperless-ngx-Anbindung — die bleibt
vollständig bei n8n. Keine ISO-Zertifizierung der PDF/A-Ausgabe.
