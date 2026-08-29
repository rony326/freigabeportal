# Kombinierter Bexio-Export für Splitgruppen — Design

## Kontext & Ziel

Wird eine Rechnung aufgesplittet (`POST /kontierung/:id/aufsplitten`,
`src/routes/kontierung.js:489`), wird für jede Splitzeile ein eigener,
vollständig unabhängiger Job angelegt (`createSplitJob`,
`src/db/jobsRepo.js:557`) — eigene Kopie der PDF, eigene Freigabekette, eigener
Zeitstempel. Sobald ein Splitkind Freigabe 2 abschliesst, wird es exakt wie
jeder normale Job **einzeln** über `GET /n8n/jobs/abholbereit`
(`src/routes/n8n/jobs.js:125`) an n8n ausgeliefert und landet als eigene
E-Mail bei Bexio — bei einer Rechnung mit z. B. drei Konten entstehen so drei
separate Bexio-Buchungen zur selben Rechnung, ohne Bezug zueinander, und ohne
erkennbar, welche Position der Rechnung zu welchem Konto gehörte.

Ziel dieses Batches:

1. Ein neues Feld **„Position auf der Rechnung"** pro Splitzeile (Freitext),
   damit im Nachhinein nachvollziehbar ist, welcher Teil der Rechnung zu
   welchem Konto kontiert wurde.
2. Statt N Einzel-Exporten wird eine aufgesplittete Rechnung als **ein**
   zusammengeführtes, einmalig gestempeltes und zeitgestempeltes PDF an n8n
   übergeben, sobald **alle** Splitkinder abgeschlossen sind — mit allen
   Konten, Positionen und allen Freigaben (Freigeber 1+2 je Splitzeile)
   gemeinsam auf einer Stempel- und Verlaufsseite.

**Bewusst ausserhalb dieses Batches:** Wo n8n das fertige Dokument danach
ablegt (Paperless-ngx) und wie es an Bexio verschickt wird (SMTP-Import),
ändert sich nicht — das bleibt vollständig n8n-seitig, wie im bestehenden
Betrieb. Dieses Design ändert nur, **was** das Portal n8n zur Abholung
anbietet, nicht den Versandweg danach.

## Architektur & Übersicht

| Komponente | Zweck | Art |
|---|---|---|
| `jobs.rechnungsposition` | Neue Spalte, Freitext je Splitzeile | Schema |
| `jobs.gruppe_pdf_pfad` / `gruppe_zeitstempel_*` | Neue Spalten auf dem Elternjob für das Merge-Ergebnis | Schema |
| `src/services/splitGruppenExport.js` | Neue Datei: Vollständigkeitsprüfung, Merge-Orchestrierung | Neu |
| `pdfStamp.js` | Neue Funktion `stampGruppenDokument` neben bestehendem `stampAndFinalize` | Erweitert |
| `jobsRepo.js` | Neue Repo-Funktionen (siehe unten), `listAbholbereitJobs` erweitert | Erweitert |
| `n8n/jobs.js` | `/abholbereit` liefert zusätzlich Gruppen-Einträge; `/abholung-bestaetigen` erkennt Gruppen | Erweitert |
| `kontierung-aufsplitten.ejs` / `kontierung.js` | Neues Formularfeld je Splitzeile | Erweitert |

Kein neuer `admin_config`-Schalter — das Verhalten ist nicht optional, es
ersetzt den heutigen (unbeabsichtigten) Einzel-Export von Splitkindern
direkt.

## Datenmodell

```sql
ALTER TABLE jobs ADD COLUMN rechnungsposition TEXT;
ALTER TABLE jobs ADD COLUMN gruppe_pdf_pfad TEXT;
ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_gesetzt_am TEXT;
ALTER TABLE jobs ADD COLUMN gruppe_zeitstempel_datei_hash TEXT;
```

- `rechnungsposition`: nur bei Splitkindern gesetzt (Freitext, z. B. "Pos. 3"
  oder "Art. 4521-A"), bei normalen Jobs immer `NULL`.
- `gruppe_pdf_pfad`/`gruppe_zeitstempel_*` werden **ausschliesslich auf dem
  Elternjob** (dem Job mit `status = 'aufgesplittet'`) gesetzt, nie auf den
  Kindern. Gleiche Namenslogik wie die bestehenden `zeitstempel_*`-Spalten.
- Gleiche Manipulationsschutz-Trigger wie für `zeitstempel_datei_hash`/
  `zeitstempel_gesetzt_am` (schema.sql:145-161), 1:1 übertragen auf
  `gruppe_zeitstempel_datei_hash`/`gruppe_zeitstempel_gesetzt_am`: einmal
  gesetzt, nicht mehr auf einen anderen Wert änderbar.

## Ablauf & Fehlerbehandlung

### 1. Aufsplitten-Formular

`kontierung-aufsplitten.ejs` bekommt pro Zeile ein neues Textfeld
`teilPosition_<i>`, analog zu den bestehenden `teilKontoId`/`teilBetrag`-
Feldern. `POST /:id/aufsplitten` (`kontierung.js:489`) liest das Array
parallel zu `teilKontoId`/`teilBetrag` aus und reicht es an `createSplitJob`
durch (`jobsRepo.js:557`, neuer Parameter `rechnungsposition`). Kein
Pflichtfeld — leer bleibt erlaubt (nicht jede Rechnung hat sinnvolle
Positionsangaben).

### 2. Vollständigkeitsprüfung & Trigger

Neue Funktion `pruefeUndFinalisiereSplitGruppe(db, config, parentJobId)` in
`splitGruppenExport.js`, aufgerufen von zwei Stellen:

- **`freigabe2.js`**, direkt nach dem erfolgreichen `renameSync` des eigenen
  gestempelten PDFs (nach Zeile ~330) — wenn `job.aufgesplittet_von` gesetzt
  ist, wird die Funktion mit dem Elternjob aufgerufen.
- **Der Lösch-Route für Splitkinder** (Soft-Delete auf `status =
  'geloescht'`, siehe `project_bug_abgelehnt_loeschung_rechte_und_archivierung`-
  Feature) — falls die gelöschte Zeile die letzte Blockade einer sonst
  vollständigen Gruppe war.

Die Funktion:

1. Lädt alle Geschwister via `listSplitKinder(db, parentJobId)`.
2. Ignoriert Kinder mit `status = 'geloescht'`.
3. Bricht ohne Aktion ab, wenn ein verbliebenes Kind `status = 'abgelehnt'`
   hat (Gruppe bleibt blockiert, bis ein Admin die Zeile löst) oder wenn
   irgendein verbliebenes Kind noch nicht `status = 'abgeschlossen'` ist.
4. Sind alle verbliebenen Kinder `abgeschlossen`, wird der Merge ausgelöst
   (Schritt 3).

Best-effort, wie das bestehende Zeitstempel-Muster: schlägt der Merge fehl
(korruptes PDF, TSA nicht erreichbar), wird der Fehler geloggt, die
Kind-Jobs bleiben unverändert `abgeschlossen` (kein Datenverlust), und ein
neuer Cron-Job `split-gruppen-nachholen` (gleiches Muster wie
`zeitstempel-nachholen`, `cronJobs.js`) prüft periodisch alle Elternjobs mit
`status = 'aufgesplittet'` und `gruppe_pdf_pfad IS NULL`, ob sie inzwischen
vollständig sind, und holt den Merge nach.

### 3. Merge & kombinierter Stempel

Neue Funktion `stampGruppenDokument(basisPdfBuffer, positionen)` in
`pdfStamp.js`, wiederverwendet `drawFreigabeBlock`/`drawVerlauf`/`wrapLine`:

1. **Basis:** die unveränderte Original-PDF des Elternjobs (`parentJob.pdf_pfad`
   — bleibt beim Aufsplitten unangetastet, siehe Kommentar bei
   `markJobAufgesplittet`, `jobsRepo.js:545-547`) wird geladen. Das ist die
   Rechnung selbst, ohne Stempelseiten, genau einmal — nicht die N
   Einzelkopien der Kinder.
2. **Beleg-Seiten je Kind:** wurde bei einer Splitzeile ein Beleg angehängt
   (`mergeBelegFuerJob`, `kontierung.js:586`, nutzt `mergeBelegInPdf` aus
   `belegAnhaengen.js`, das Beleg-Seiten immer **anhängt**, nie einfügt), hat
   die Kind-PDF mehr Seiten als die Basis. Die Differenz
   (`kindSeitenzahl - basisSeitenzahl`) sind die angehängten Beleg-Seiten;
   sie werden per `copyPages` aus der Kind-PDF in das Gruppendokument
   übernommen, gruppiert direkt nach der zugehörigen Position.
3. **Kombinierte Stempelseite:** eine neue Seite mit einem Block pro
   Splitzeile (Konto, Betrag, Position auf der Rechnung, Freigabe-1- und
   Freigabe-2-Block wie heute einzeln), analog zu `stampAndFinalize`, aber
   in einer Schleife statt einem einzelnen Konto-Block.
4. **Kombinierter Verlauf:** alle `freigaben`-Zeilen aller Kinder
   (`listFreigabenByJob` je Kind), chronologisch sortiert, jeder Eintrag mit
   Präfix `Konto <Kontonummer> (Pos. <Position>):` vor dem bestehenden
   Format, damit bei mehreren Konten erkennbar bleibt, welcher Verlaufs-
   Eintrag zu welcher Position gehört.

Ergebnis wird — gleiches Sicherheitsmuster wie in `freigabe2.js:280-330` —
zuerst in eine `.tmp`-Datei geschrieben, dann erst nach erfolgreichem Setzen
des Zeitstempels (Schritt 4) atomar an ihren finalen Pfad umbenannt.

### 4. Zeitstempel

Frischer RFC3161-Zeitstempel auf das fertige Gruppendokument, über die
bestehende `setZeitstempel`-Funktion (`zeitstempel.js:25`) — keine
Neuentwicklung. Gilt nur für das neue Dokument; die bereits gesetzten
Einzel-Zeitstempel der Kind-PDFs bleiben unverändert gültig (die Kind-Dateien
selbst werden erst beim Abholen der Gruppe gelöscht, siehe unten — sie sind
bis dahin weiterhin einzeln über die normalen Job-Ansichten im Portal
einsehbar).

Erfolgreich gesetzt, wird per neuer Repo-Funktion `markGruppeExportiert(db,
parentJobId, { pdfPfad, zeitstempelGesetztAm, zeitstempelDateiHash })`
(mirrors `markZeitstempelGesetzt`, `jobsRepo.js:405`) auf dem Elternjob
hinterlegt.

### 5. n8n-Schnittstelle

`listAbholbereitJobs` (`jobsRepo.js:125`) bekommt eine zusätzliche
Bedingung `AND aufgesplittet_von IS NULL` — Splitkinder werden ab sofort nie
mehr einzeln angeboten, unabhängig vom Gruppenstatus.

Neue Repo-Funktion `listAbholbereitGruppen(db, staleAfterMs,
nurMitZeitstempel)`, gleiches Stale/Refetch-Muster wie
`listAbholbereitJobs`, aber auf Elternjobs mit `gruppe_pdf_pfad IS NOT NULL`
(und, falls `nurMitZeitstempel`, zusätzlich `gruppe_zeitstempel_gesetzt_am
IS NOT NULL`).

`GET /n8n/jobs/abholbereit` (`n8n/jobs.js:125`) mischt beide Listen in die
Antwort; ein Gruppen-Eintrag unterscheidet sich durch ein zusätzliches Feld
`positionen`:

```jsonc
{
  "id": 42,                     // Elternjob-ID
  "eingang_am": "...", "quelle": "...", "absender": "...",
  "lieferant": "...", "rechnungsnummer": "...", "betrag": "...",  // Summe/Original
  "positionen": [
    { "konto_id": 7, "konto_kontonummer": "6500", "konto_bezeichnung": "...", "betrag": "120.00", "position": "Pos. 1" },
    { "konto_id": 9, "konto_kontonummer": "6600", "konto_bezeichnung": "...", "betrag": "80.00", "position": "Pos. 2" }
  ],
  "download_url": "..."          // zeigt auf gruppe_pdf_pfad
}
```

Normale (nicht gesplittete) Jobs behalten exakt ihre heutige Form ohne
`positionen`-Feld — kein Breaking Change für den bestehenden n8n-Workflow
bei unveränderten Rechnungen.

`POST /:id/abholung-bestaetigen` (`n8n/jobs.js:155`) erkennt anhand der ID,
ob es sich um einen normalen Job oder einen Gruppen-Elternjob handelt (neue
Repo-Funktion `istGruppenElternjob(db, id)` prüft `gruppe_pdf_pfad IS NOT
NULL`). Bei einer Gruppe ruft die Route eine neue Funktion
`confirmGruppenAbholung(db, parentJobId)` auf: setzt **alle** nicht
gelöschten Kinder auf `status = 'abgeholt'` und liefert deren `pdf_pfad`/
`thumbnail_pfad` sowie den `gruppe_pdf_pfad` des Elternjobs zurück; die Route
löscht anschliessend alle diese Dateien von der Platte (gleiches
`unlinkSync`-Muster wie heute, nur für mehrere Dateien statt einer). Der
Elternjob selbst bleibt wie bisher dauerhaft mit `status = 'aufgesplittet'`
als historische Referenz erhalten (`pdf_pfad` zeigt weiterhin auf die
unangetastete Originaldatei, die nicht gelöscht wird).

## Tests

- Unit: `stampGruppenDokument` mit 2 und mit 5 Positionen (Layout/Umbruch),
  Beleg-Seiten-Erkennung über Seitenzahl-Differenz, kombinierter Verlauf
  über mehrere Kinder korrekt chronologisch sortiert und mit Konto-Präfix.
- Unit: `pruefeUndFinalisiereSplitGruppe` — vollständige Gruppe löst aus,
  unvollständige Gruppe löst nicht aus, Gruppe mit einer `abgelehnt`-Zeile
  bleibt blockiert, gelöschte Zeile wird bei der Vollständigkeitsprüfung
  ignoriert.
- Integration: kompletter Aufsplitten-Flow mit 3 Konten über die echten
  Routen bis alle 3 Kinder `abgeschlossen` sind → ein Gruppen-Eintrag mit 3
  `positionen` erscheint in `/abholbereit`, kein Einzel-Eintrag für die
  Kinder. `/abholung-bestaetigen` auf die Gruppen-ID löscht alle 3
  Kind-Dateien plus die Gruppen-Datei und setzt alle 3 Kinder auf
  `abgeholt`.
- Regression: ein normaler (nicht gesplitteter) Job durchläuft
  `/abholbereit`/`/abholung-bestaetigen` unverändert wie heute (kein
  `positionen`-Feld, bestehende Payload-Form).
- `csrfSweep.test.js` erweitern, falls die neue `teilPosition_<i>`-Eingabe
  eine neue Route berührt (voraussichtlich nicht — nutzt die bestehende,
  bereits geschützte Aufsplitten-Route).

## Nicht Teil von diesem Batch

Kein neuer `admin_config`-Schalter — Verhalten ersetzt den heutigen
Einzel-Export ersatzlos, ist nicht umschaltbar. Keine Änderung am
n8n-seitigen Versandweg zu Bexio oder zur Paperless-ngx-Ablage — beides
bleibt vollständig extern. Kein manuelles "jetzt exportieren"-Admin-UI für
unvollständige oder feststeckende Gruppen (Auflösen einer blockierten Gruppe
läuft über die bestehende Lösch-/Neuzuweisungs-Funktion für die abgelehnte
Zeile, nicht über eine neue Oberfläche). Keine Re-Zeitstempelung oder
sonstige Behandlung des Falls, dass ein bereits exportiertes und
abgeholtes Gruppendokument nachträglich korrigiert werden müsste — dafür
gilt der bestehende Korrektur-Workflow für abgeschlossene Jobs unverändert
(neuer Job, keine Änderung an einem einmal ausgelieferten Dokument).
