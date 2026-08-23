# Hash-Abgleich + Zertifikats-Ansicht für die Zeitstempel-Prüfung — Design

## Kontext

Die bestehende Zeitstempel-Prüfung (`docs/superpowers/specs/2026-08-17-rfc3161-zeitstempel-design.md`, `src/services/zeitstempel.js`, `views/zeitstempel-pruefen.ejs`) beweist bereits kryptografisch, ob eine PDF-Datei seit dem Setzen ihres RFC3161-Zeitstempels verändert wurde (`verifyZeitstempel().gueltig`). Zwei Dinge fehlen aber:

1. **Ein unabhängiger Bezug zum konkreten Job.** RFC3161 beweist nur "dieser exakte Datei-Inhalt existierte unverändert seit Zeitpunkt T" — nicht, dass es sich um die Datei zu genau diesem Job handelt. Würde die unter `job.pdf_pfad` abgelegte Datei versehentlich oder absichtlich durch eine andere, ebenfalls gültig gestempelte PDF ersetzt, würde die RFC3161-Prüfung weiterhin "gültig" melden. Ein Hash-Abgleich gegen einen beim Stempeln in der Datenbank hinterlegten Wert schliesst genau diese Lücke.
2. **Eine für Prüfer/Revisoren verständliche, vorzeigbare Darstellung.** Die aktuelle Karte auf `/zeitstempel-pruefen` ist ein Einzeiler ("✓ Gültiger Zeitstempel vorhanden."). Für den Nachweis gegenüber Dritten (z.B. im Rahmen der GeBüV-konformen Archivierung, siehe Projekt-Memory `project_paperless_archival_goal`) ist eine formellere, druckbare Übersicht sinnvoller.

Diese Spec erweitert die bestehende Prüf-Funktion um beides, ohne neue Subsysteme einzuführen.

## Datenmodell

Neue Spalte `jobs.zeitstempel_datei_hash TEXT` (SHA-256, hex, NULL solange kein Zeitstempel gesetzt ist oder der Job vor Einführung dieser Funktion gestempelt wurde). Migration nach demselben Muster wie die übrigen `zeitstempel_*`-Spalten in `src/db/index.js` (idempotentes `ALTER TABLE`).

`markZeitstempelGesetzt(db, jobId, zeitpunkt, hash)` (`src/db/jobsRepo.js:405`) bekommt einen dritten Parameter:

```js
export function markZeitstempelGesetzt(db, jobId, zeitpunkt, hash) {
  db.prepare('UPDATE jobs SET zeitstempel_gesetzt_am = ?, zeitstempel_datei_hash = ? WHERE id = ?').run(zeitpunkt, hash, jobId);
}
```

Beide bestehenden Aufrufer übergeben ab jetzt konsequent beide Werte zusammen — auch beim Zurücksetzen auf `NULL` im Fehlerfall (`freigabe2.js`, siehe unten), damit die DB nie einen Hash zu einem nicht (mehr) existierenden Zeitstempel behauptet.

## Hash-Berechnung beim Setzen des Zeitstempels

Der Hash wird über die **fertig gestempelten** PDF-Bytes berechnet — dieselben Bytes, die auch auf die Platte geschrieben werden — nicht über `jobs.datei_hash` (der bereits existierende Ingest-Hash, unverändert weiter nur für Duplikaterkennung genutzt, siehe `project_topic_duplikaterkennung_fehlt`). Beide Stellen, die heute schon `zeitstempel_gesetzt_am` setzen, werden erweitert:

**`src/routes/freigabe2.js`** (ca. Zeile 258–275, direkt nach erfolgreichem `setZeitstempel`):

```js
let zeitstempelGesetztAm = null;
let zeitstempelDateiHash = null;
if (tsaUrl) {
  try {
    stamped = await setZeitstempel(stamped, { ... });
    zeitstempelGesetztAm = new Date().toISOString();
    zeitstempelDateiHash = createHash('sha256').update(stamped).digest('hex');
  } catch (err) { ... }
}
```

Der bestehende `markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm)`-Aufruf in der Transaktion (Zeile 301) wird zu `markZeitstempelGesetzt(db, job.id, zeitstempelGesetztAm, zeitstempelDateiHash)`. Der bestehende Rücksetz-Aufruf im `renameSync`-Fehlerfall (Zeile 328) wird zu `markZeitstempelGesetzt(db, job.id, null, null)` — aus demselben Grund, aus dem dort heute schon `zeitstempel_gesetzt_am` zurückgesetzt wird: die Datei auf der Platte hat in diesem Fall keinen Zeitstempel, also darf auch kein Hash dazu behauptet werden.

**`src/services/cronJobs.js`** (ca. Zeile 229–233, `runZeitstempelNachholenJob`): analog — Hash aus `stamped` berechnen, an `markZeitstempelGesetzt(db, job.id, new Date().toISOString(), zeitstempelDateiHash)` übergeben.

`createHash` aus `node:crypto` ist in beiden Dateien neu zu importieren (in `src/routes/n8n/jobs.js` bereits so verwendet, gleiches Muster).

## Erweiterung der Prüf-Logik

`verifyZeitstempel` (`src/services/zeitstempel.js`) bekommt einen optionalen zweiten Parameter `erwarteterHash` und berechnet den Datei-Hash unabhängig vom RFC3161-Ergebnis (der Hash-Abgleich ist eine eigenständige Aussage, kein Teilschritt der RFC3161-Prüfung):

```js
export async function verifyZeitstempel(pdfBuffer, erwarteterHash = null) {
  const dateiHash = createHash('sha256').update(pdfBuffer).digest('hex');
  const hashUebereinstimmung = erwarteterHash != null ? dateiHash === erwarteterHash : null;
  const basis = { dateiHash, hashUebereinstimmung };

  let extrahiert;
  try {
    extrahiert = await extractTimestamps(pdfBuffer);
  } catch {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  if (extrahiert.length === 0) {
    return { vorhanden: false, gueltig: false, zeitpunkt: null, tsaPolicy: null, ...basis };
  }
  const verifiziert = await verifyTimestamp(extrahiert[0], { pdf: pdfBuffer });
  return {
    vorhanden: true,
    gueltig: verifiziert.verified,
    zeitpunkt: verifiziert.info.genTime.toISOString(),
    tsaPolicy: verifiziert.info.policy,
    ...basis,
  };
}
```

`hashUebereinstimmung` ist `null` (nicht `true`/`false`), wenn kein Vergleichswert übergeben wurde — das deckt sowohl den generischen Upload-Pfad (kein Job-Bezug) als auch Jobs ab, die vor Einführung dieser Funktion gestempelt wurden (`zeitstempel_datei_hash IS NULL`), ohne Sonderfall-Code.

`src/routes/zeitstempelPruefen.js`, `GET /` mit `jobId`, übergibt neu den gespeicherten Wert:

```js
const ergebnis = await verifyZeitstempel(readFileSync(job.pdf_pfad), job.zeitstempel_datei_hash);
```

Der Upload-Pfad (`POST /`, kein Job) ruft `verifyZeitstempel(req.file.buffer)` weiterhin ohne zweiten Parameter auf — unverändert.

## UI Teil 1: Erweiterte Status-Karte

`views/zeitstempel-pruefen.ejs` zeigt statt des Einzeilers eine Checkliste mit Gesamtverdikt:

```
┌──────────────────────────────────────────────┐
│ ✓ Zeitstempel vorhanden                       │
│ ✓ Kryptografisch gültig (RFC3161)             │
│ ✓ Hash stimmt mit Datenbank überein           │
│                                                │
│ ✓ Diese Datei ist nachweislich unverändert.   │  ← grünes Banner
│                                                │
│ Zeitpunkt: 2026-08-23T10:14:02Z               │
│ TSA-Policy: 1.2.3.4.5                         │
│                                                │
│ [ Zertifikat anzeigen ]                       │
└──────────────────────────────────────────────┘
```

Regeln:
- Grünes Gesamtbanner nur, wenn `vorhanden && gueltig && hashUebereinstimmung !== false` (also `true` oder `null` — ein fehlender Vergleichswert ist kein Fehlschlag, nur eine fehlende zusätzliche Bestätigung).
- Rotes Gesamtbanner, sobald `gueltig === false` **oder** `hashUebereinstimmung === false`, mit passendem Text ("Datei wurde nach dem Zeitstempel verändert" bzw. "Datei weicht vom in der Datenbank hinterlegten Original ab").
- Hash-Zeile zeigt bei `hashUebereinstimmung === null` `– kein Vergleichswert vorhanden` statt ✓/✗ (z.B. beim generischen Upload-Tool oder bei Alt-Jobs).
- Button "Zertifikat anzeigen" nur wenn `job` gesetzt ist **und** `ergebnis.vorhanden` — verlinkt auf `/zeitstempel-pruefen/zertifikat?jobId=<id>`. Beim generischen Upload-Pfad gibt es kein Zertifikat (kein Job-Datensatz, dessen Metadaten es zeigen könnte).

## UI Teil 2: Zertifikats-Seite

Neue Route `GET /zeitstempel-pruefen/zertifikat?jobId=<id>` in `src/routes/zeitstempelPruefen.js`, gleiche Autorisierung (`canViewJobPdf`) und Datei-Existenzprüfung wie der bestehende `GET /`-Handler mit `jobId`, ruft intern dieselbe `verifyZeitstempel(buffer, job.zeitstempel_datei_hash)` auf.

Neue View `views/zeitstempel-zertifikat.ejs`: eine eigenständige, formell gestaltete "Prüfbescheinigung" (kein rechtsverbindliches Signaturzertifikat im PKI-Sinn — RFC3161 bescheinigt Zeitpunkt+Unverändertheit, keine Identität — die Seite wird entsprechend als "Prüfbescheinigung", nicht als "Zertifikat" im technischen Sinn beschriftet, um keine falschen Erwartungen zu wecken):

- Umrandeter Block mit Portal-Branding (bestehendes `branding`-Objekt, wie in `_header.ejs` verwendet).
- Job-Kontext: Rechnungsnummer, Lieferant, Betrag (`job.rechnungsnummer`, `job.lieferant`, `job.betrag` — bereits vorhandene Spalten).
- Prüfergebnis: dieselbe Checkliste wie Teil 1, zusätzlich die vollen Hash-Werte (aktuell berechneter Hash der Datei und in der DB hinterlegter Hash, beide sichtbar — bei Übereinstimmung optisch als ein Wert lesbar, bei Abweichung deutlich als zwei unterschiedliche Werte).
- Zeitpunkt, TSA-Policy.
- Ausstellungsvermerk: "Diese Bescheinigung wurde erstellt am `<jetzt>` durch `<angemeldete Person>`."
- `<style>`-Block mit `@media print` (Navigation, Header, Buttons via Klasse `.no-print` ausblenden; Block bekommt einen sichtbaren Rahmen auch im Druck).
- Button "Drucken / als PDF speichern" → `<button onclick="window.print()">` (Klasse `.no-print`). Kein serverseitiges PDF-Rendering, keine neue Abhängigkeit — die Browser-Druckfunktion reicht für "als PDF speichern".
- Link zurück zur Status-Karte (`/zeitstempel-pruefen?jobId=<id>`).

## Testing

- `src/services/zeitstempel.test.js`: `verifyZeitstempel` mit `erwarteterHash` — Treffer (`hashUebereinstimmung: true`), Abweichung (`false`), kein Vergleichswert übergeben (`null`); Hash wird auch im "kein Zeitstempel gefunden"-Zweig korrekt berechnet und zurückgegeben.
- `src/db/jobsRepo.test.js`: `markZeitstempelGesetzt` schreibt Zeitpunkt und Hash gemeinsam; `null, null` setzt beide zurück.
- `src/routes/freigabe2.test.js`: nach erfolgreichem Zeitstempel ist `jobs.zeitstempel_datei_hash` gesetzt und entspricht dem SHA-256 der final abgelegten Datei; im `renameSync`-Fehlerfall werden beide Felder zurück auf `NULL` gesetzt.
- Unit-Test für `runZeitstempelNachholenJob` (`cronJobs.test.js`): Hash wird beim Nachholen ebenfalls gesetzt.
- `src/routes/zeitstempelPruefen.test.js`: `GET /?jobId=` liefert `hashUebereinstimmung: true` für eine unveränderte Datei, `false` nach manueller Manipulation der Datei auf der Platte (Test schreibt nach dem Stempeln ein Byte um), `null` für einen Job ohne gespeicherten Hash (Alt-Job-Simulation); `POST /` (Upload-Pfad) liefert weiterhin `hashUebereinstimmung: null`.
- Neuer Test für `GET /zeitstempel-pruefen/zertifikat?jobId=`: 403 ohne Berechtigung (wie der bestehende `GET /`-Test), 404 wenn Datei fehlt, 200 mit erwarteten Feldern (Rechnungsnummer, Hash-Werte, Zeitpunkt) im gerenderten HTML bei Erfolg.

## Bewusst nicht Teil dieser Spec (YAGNI)

- Kein serverseitiges PDF-Rendering der Zertifikats-Seite (z.B. via Puppeteer) — Browser-Druckfunktion reicht.
- Keine Zertifikats-Ansicht für den generischen Upload-Pfad (`/zeitstempel-pruefen` ohne `jobId`) — ohne Job-Datensatz gibt es keine Metadaten und keinen DB-Hash, die eine Bescheinigung über den reinen RFC3161-Befund hinaus rechtfertigen würden.
- Keine rückwirkende Hash-Berechnung für bereits gestempelte Bestands-Jobs (`zeitstempel_datei_hash` bleibt für sie `NULL`, Anzeige `– kein Vergleichswert vorhanden`) — ein nachträglich berechneter Hash aus der heutigen Datei wäre kein unabhängiger Nachweis mehr, sondern nur eine Kopie dessen, was ohnehin geprüft wird.
- Keine Historie mehrerer Hash-Werte pro Job — nur der zuletzt beim Stempeln berechnete Wert wird gehalten, wie auch `zeitstempel_gesetzt_am` nur den letzten erfolgreichen Zeitpunkt hält.
- Keine Bescheinigung für Jobs im Status `abgeholt`/`archiviert` — die PDF-Datei existiert dann nicht mehr (bestehende Einschränkung aus der ursprünglichen Zeitstempel-Spec), der "Zertifikat anzeigen"-Button erscheint entsprechend nur für den Status `abgeschlossen`.

## Betroffene/neue Dateien

**Neu:**
- `views/zeitstempel-zertifikat.ejs`

**Geändert:**
- `src/db/schema.sql`, `src/db/index.js` (Migration: `jobs.zeitstempel_datei_hash`)
- `src/db/jobsRepo.js` (`markZeitstempelGesetzt` erweitert um `hash`-Parameter)
- `src/services/zeitstempel.js` (`verifyZeitstempel` erweitert um `erwarteterHash`-Parameter, `dateiHash`/`hashUebereinstimmung` im Rückgabewert)
- `src/routes/freigabe2.js` (Hash-Berechnung nach `setZeitstempel`, angepasste `markZeitstempelGesetzt`-Aufrufe)
- `src/services/cronJobs.js` (dito für `runZeitstempelNachholenJob`)
- `src/routes/zeitstempelPruefen.js` (Hash an `verifyZeitstempel` übergeben, neue Route `GET /zertifikat`)
- `views/zeitstempel-pruefen.ejs` (erweiterte Checkliste, Gesamtbanner, Link zur Zertifikats-Seite)
