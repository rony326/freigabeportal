# Sub-Phase E2, Batch 2 – PDF-Bereinigung — Design

## Kontext & Phasenplan

Dies ist der zweite Teil der Sub-Phase E2 (Security-Review-Pass), die auf Phase E1
(Rate-Limiting, gemerged) folgt. Die E2-Sicherheitsprüfung wurde als vier
unabhängige Batches organisiert:

- **Batch 1 – gebündelte Einzelfixes** (bereits gemerged): 19 kleinere, in sich
  abgeschlossene Sicherheitsfindings (Session-Fixation, IDOR, Vier-Augen-Prinzip-
  Umgehung, Input-Validierung usw.).
- **Batch 2 – PDF-Bereinigung** (dieses Dokument): drei zusammenhängende Findings
  rund um die im Lastenheft explizit als Kernanforderung markierte aktive
  PDF-Löschung.
- **Batch 3 – ChurchTools-Sync-Robustheit**: Mass-Deaktivierungs-Schutz,
  Sync-Warnungen sichtbar machen, Stellvertreter-Eskalation bei doppeltem
  Interessenskonflikt.
- **Batch 4 – Autorisierungsmodell-Entscheidung**: ob `/kontierung`/`/freigabe2`/
  `/abgelehnt` weiterhin an Buchhaltungs-Gruppenmitgliedschaft gekoppelt bleiben.

### Wichtiger Fund während der Recherche

Das Lastenheft (`docs/superpowers/specs/rechnungsfreigabe.md`, Abschnitt 3 und
Abschnitt 4 Schritt 12) definiert den Job-Lebenszyklus explizit als
`... → abgeschlossen → abgeholt → archiviert` und verlangt: *"Nach erfolgreicher
Abholung durch n8n wird das PDF ... aktiv vom Portal gelöscht."* Der Status
`archiviert` existiert bereits im `jobs.status`-CHECK-Constraint des Schemas —
aber **kein Code-Pfad setzt ihn je**. Dieser Batch schliesst diese Lücke: die
Bereinigungs-Sweep aus diesem Design ist der fehlende Mechanismus, der Jobs von
`abgeholt` nach `archiviert` überführt, sobald ihre Dateien nachweislich gelöscht
sind.

## Architektur & Übersicht

Ein neuer Cron-Endpunkt `POST /internal/cron/pdf-bereinigung` führt drei
unabhängige Sweeps in einem Aufruf aus (nach dem Vorbild von
`pool-erinnerungen`, das Reminder und Eskalation bündelt):

1. **Abgeholt-Aufräumen** (behebt den Finding, dass ein fehlgeschlagenes
   `unlinkSync` nach Abholung eine PDF unwiederbringlich verwaist zurücklässt):
   für jeden Job mit `status = 'abgeholt'` wird versucht, `pdf_pfad`/
   `thumbnail_pfad` zu löschen, falls sie noch existieren; sobald beide
   nachweislich weg sind, wechselt der Job zu `status = 'archiviert'`.
2. **Tmp-Sweep** (behebt das Finding, dass ein Prozessabsturz zwischen
   Tmp-Schreiben und Rename in `freigabe2.js`s Stempel-Flow eine verwaiste,
   voll gestempelte `.tmp`-Datei hinterlässt): löscht `*.tmp`-Dateien in
   `jobsDir`, die älter als 1 Stunde sind.
3. **mail_log-Bereinigung** (behebt das Finding, dass `mail_log` rechnungs-
   identifizierende Texte unbegrenzt aufbewahrt, länger als die PDFs selbst
   existieren): löscht `mail_log`-Zeilen älter als `mail_log_aufbewahrung_tage`.

Der bestehende Abholungs-Endpunkt (`n8n/jobs.js`s `POST /:id/abholung-bestaetigen`)
behält seinen sofortigen Best-Effort-Löschversuch (jetzt in try/catch gekapselt,
damit ein Fehlschlag die Anfrage nie zum Absturz bringt) — die Sweep ist das
Sicherheitsnetz, nicht der Primärpfad. Löschung geschieht also im Normalfall
weiterhin sofort bei Abholung; die Sweep fängt nur auf, was dabei fehlschlägt,
plus alle bereits vor diesem Batch entstandenen Altlasten.

**Explizit ausserhalb des Scopes**: `abgelehnt`-, blockierte oder nie
beanspruchte Pool-Jobs werden **nie** automatisch gelöscht — das würde die
"Überarbeiten"-Möglichkeit einer abgelehnten Rechnung dauerhaft zunichtemachen.
Nur `status = 'abgeholt'` (die Rechnung wurde bereits erfolgreich an
Paperless-ngx/Bexio übergeben, siehe Lastenheft Abschnitt 2) ist je ein
Lösch-Kandidat.

## Datenmodell

Minimal:

- `jobs.archiviert_am TEXT` (neu, nullable) — Zeitstempel, wann die Sweep beide
  Dateien als gelöscht bestätigt und den Job archiviert hat. Nicht zwingend für
  die Sweep-Logik selbst nötig (sie prüft bei jedem Lauf direkt die
  Datei-Existenz, ist also von Natur aus idempotent ohne Zeitstempel), aber
  nützlich für Admin-Sichtbarkeit/Audit-Trail, konsistent mit den bestehenden
  `*_gesendet_at`-Spalten im Schema.
- `admin_config` erhält den Schlüssel `mail_log_aufbewahrung_tage` (Default `'90'`).

Keine weiteren Schemaänderungen — `archiviert` existiert bereits im
`jobs.status`-CHECK-Constraint. Da `abgeholt`-Jobs bereits aus jeder bestehenden
Abfrage herausfallen (Pool-Liste, Freigabe-2-Liste usw. filtern alle auf frühere
Status), ändert der weitere Übergang zu `archiviert` an keinem bestehenden
Verhalten etwas — ein bereits unsichtbarer Status wird zu einem anderen bereits
unsichtbaren Status.

`pdf_pfad` bleibt auch nach Archivierung als historische Spur stehen (nicht auf
NULL gesetzt) — die Spalte ist `NOT NULL`, ein Zurücksetzen bräuchte eine
Schemaänderung ohne echten Nutzen, da kein Code-Pfad `pdf_pfad` für einen
`archiviert`-Job je liest.

## Ablauf & Fehlerbehandlung

`POST /internal/cron/pdf-bereinigung` ist automatisch durch das bestehende
Blanket-Guard (`requireCronSecret` + `machineLimiter`) an der
`/internal/cron`-Mount-Stelle abgesichert — kein zusätzlicher Route-Guard nötig.

1. **Archivieren**: `SELECT * FROM jobs WHERE status = 'abgeholt'`. Für jeden
   Job: Löschversuch für `pdf_pfad` (falls `existsSync`) und `thumbnail_pfad`
   (falls gesetzt und `existsSync`), jeweils einzeln in try/catch, Fehler
   werden laut geloggt, nie geworfen. Existiert eine Datei bereits nicht mehr
   (weil der sofortige Löschversuch bei Abholung schon erfolgreich war), zählt
   das als Erfolg für diese Datei. Sind beide Dateien nach dem Versuch
   nachweislich weg, wechselt der Job zu `status = 'archiviert'`,
   `archiviert_am = jetzt`. Bleibt eine Datei bestehen, bleibt der Job in
   `abgeholt` und wird beim nächsten Lauf erneut versucht — kein Fehler wird
   an den Aufrufer durchgereicht, kein Job bleibt in einem kaputten
   Zwischenzustand.
2. **Tmp-Sweep**: `readdirSync(jobsDir)`, gefiltert auf `.tmp`-Endung
   (die einzige Quelle solcher Dateien ist `freigabe2.js`s Schreiben-dann-
   Umbenennen), Alter via `statSync(...).mtimeMs` gegen die 1-Stunden-Schwelle
   geprüft, Löschung einzeln in try/catch.
3. **mail_log-Bereinigung**: liest `mail_log_aufbewahrung_tage` aus
   `admin_config`, `DELETE FROM mail_log WHERE versucht_am < ?` mit der
   berechneten ISO-Schwelle.

Antwort: `{ status: 'erfolg', archiviert: N, tmpGeloescht: N, mailLogGeloescht: N }`
— gleiche Form wie `pool-erinnerungen`s bestehende Antwort.

## Tests

- Unit-Tests für neue Repo-Funktionen: `listAbgeholtJobs`/`archivierenJob`
  (`jobsRepo.js`), `mail_log_aufbewahrung_tage`-Default (`adminConfigRepo.js`),
  eine Prune-Funktion in `mailLogRepo.js`.
- Integrationstests für die Sweep: ein `abgeholt`-Job mit noch vorhandenen
  Dateien → wird bereinigt, gelöscht, archiviert; ein `abgeholt`-Job, dessen
  Dateien bereits weg sind → wird sofort archiviert (idempotent, deckt sowohl
  den Vorwärtsfix als auch bereits vor diesem Batch entstandene Altlasten ab);
  verwaiste `.tmp`-Dateien unterschiedlichen Alters → nur die alten werden
  gelöscht; `mail_log`-Zeilen auf beiden Seiten der Aufbewahrungsfrist → nur
  die alten werden entfernt.
- Ein Ende-zu-Ende-Test nach dem Muster von D1–D4/E1: einen echten Job über die
  echten Routen bis `abgeholt` treiben, die Sweep zweimal laufen lassen (der
  zweite Lauf beweist Idempotenz — nichts mehr zu tun), `archiviert` bestätigen.

## Nicht Teil von diesem Batch

Keine automatische Löschung für `abgelehnt`-, blockierte oder nie beanspruchte
Jobs (bewusste Entscheidung, siehe Architektur-Abschnitt). Kein Admin-Bereich
zum Durchsuchen archivierter Jobs. Keine admin-konfigurierbare Tmp-Datei-
Alters-Schwelle (fest auf 1 Stunde — eine Ops-Konstante, keine Geschäftsregel).
Kein Retry-Limit oder Dead-Letter-Tracking für wiederholt fehlschlagende
Löschungen (lautes Loggen genügt für diesen Batch, wie von der Sicherheits-
prüfung selbst empfohlen). Batch 3 (Sync-Robustheit) und Batch 4
(Autorisierungsmodell) sind eigene Design-Zyklen.
