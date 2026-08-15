# Freigabeportal — Sub-Phase D2: Freigabe-Workflow-UI

Status: approved (Sub-Phase D2 only)
Datum: 2026-08-15

## Kontext

Phase A (Fundament & Auth), Phase B (Admin-Bereich), Phase C (n8n-Schnittstelle &
Job-Datenmodell) und Sub-Phase D1 (PDF-Verarbeitung) sind abgeschlossen und auf `master`
gemerged. D1 liefert zwei reine PDF-Service-Module (`renderFirstPageThumbnail`,
`stampAndFinalize`) und eine admin-konfigurierbare Visum-Seiten-Position — beide Funktionen
existieren, aber `stampAndFinalize` ist bewusst noch nirgends verdrahtet.

D2 liefert die eigentliche Browser-Oberfläche für den Freigabe-Workflow: Pool-Übersicht (inkl.
Thumbnail-Anzeige), Kontierung + Freigabe 1 "aus einer Hand", Freigabe-2-Split-View, und die
Verdrahtung von `stampAndFinalize` beim Abschluss.

### Phasenplan (Kontext, aus D1 übernommen)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- Phase B – Admin-Bereich (abgeschlossen, gemerged)
- Phase C – n8n-Schnittstelle & Job-Datenmodell (abgeschlossen, gemerged)
- Phase D – Freigabe-Workflow-UI
  - D1 – PDF-Verarbeitung (abgeschlossen, gemerged)
  - **D2 – Freigabe-Workflow-UI (dieses Dokument)**
  - D3 – Ablehnung/Rückweg & Mailversand
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

### Bewusst ergänzte Lücke: "Meine Aufgaben"

Das Lastenheft beschreibt für auto-zugewiesene Jobs (Zuweisungsregel-Treffer) keinen
Einstiegspunkt außer der Zuweisungs-Mail — die laut Phasenplan aber erst in D3 tatsächlich
verschickt wird. Ohne Mail und ohne eigene Übersicht gäbe es für die zugewiesene Person keine
Möglichkeit, überhaupt zu erfahren, dass ein Job auf sie wartet. D2 ergänzt daher die
Pool-Übersicht um zwei zusätzliche Abschnitte ("Meine offenen Kontierungen", "Meine
Freigaben"), damit D2 für sich allein benutzbar ist, auch bevor D3 den Mailversand liefert.

## Architektur & Routen

Neue Server-gerenderte Seiten (EJS, wie der gesamte Rest der App — kein Client-seitiges
Fetch-Rendering von Listen):

- **`GET /pool`** — Pool-Übersicht (unzugewiesene Jobs) plus die beiden "Meine..."-Abschnitte.
  Rendert serverseitig direkt über Repo-Funktionen. Die bestehenden `GET /api/pool` und
  `POST /api/pool/:id/beanspruchen` JSON-Endpunkte (Phase C) bleiben unverändert; "Beanspruchen"
  ruft `POST /api/pool/:id/beanspruchen` per Fetch auf (damit ein 409-Konflikt inline behandelt
  werden kann, ohne vollen Reload), bei Erfolg → Redirect zu `/kontierung/:id`.
- **`GET/POST /kontierung/:id`** — Kontierung + Freigabe 1 aus einer Hand. Zugriff nur für
  `job.zugewiesen_an === currentPerson`.
- **`GET/POST /freigabe2/:id`** — Freigabe-2-Split-View. Zugriff nur für die aktuell zuständige
  Person (siehe unten).
- Klick auf ein Pool-Thumbnail öffnet ein rein client-seitiges `<dialog>` mit eingebettetem
  `<iframe>` auf eine beim Seiten-Rendern bereits erzeugte signierte Download-URL — keine eigene
  Route, kein Beanspruchen-Trigger.

**Neue Route für Thumbnails**: Bislang liegt `thumbnail_pfad` nur auf der Platte, nichts liefert
es aus. Neuer Endpunkt `GET /api/pool/:id/thumbnail`, unter dem bestehenden
`requireRole(config, 'buchhaltung')`-Schutz von `/api/pool` (Session-Auth reicht — anders als
beim PDF-Download gibt es hier keinen maschinellen n8n-Client, der eine Signatur bräuchte).

**PDF-Anzeige überall** (Pool-Vorschau, Kontierung, Freigabe 2): `<iframe>`/`<embed>` auf die
bestehende signierte `/downloads/:jobId`-URL (`buildSignedDownloadUrl`, Phase C) — nutzt den
nativen Browser-PDF-Viewer, kein neuer Rendering-Code.

**Zugriffskontrolle**:
- Kontierung: nur `job.zugewiesen_an`, und nur solange `job.status === 'zugewiesen'`.
- Freigabe 2: nur die aktuell wirksame Freigeber2-Identität — normalerweise
  `konto.freigeber2_id`, nach einer Eskalation `konto.stellvertreter2_id` (siehe Datenmodell).
  Konto-Dropdown in der Kontierung ist auf Konten beschränkt, bei denen die aktuelle Person
  `freigeber1_id` oder `stellvertreter1_id` ist — der admin-konfigurierte Freigeber1-Bezug ist
  eine echte Zugriffsgrenze, keine reine Routing-Empfehlung.

## Datenmodell

**Neue Datei `src/db/freigabenRepo.js`** (Tabelle `freigaben` existiert seit Phase C, aber ohne
Repo-Funktionen): `createFreigabe(db, { jobId, personId, rolle, ip, interessenskonflikt,
kommentar, eskaliertVon })` und `listFreigabenByJob(db, jobId)`. Eine Zeile pro tatsächlich
erteilter Freigabe (Freigeber1 oder Freigeber2) — nicht pro Konflikt-Meldung.

**Vier neue, nullable Spalten auf `jobs`** — schließen eine echte Datenlücke: Wenn eine Person
einen Interessenskonflikt meldet, geht die Aufgabe komplett an die zuständige Stellvertretung
über, aber wer sie letztlich erledigt, muss sich später erinnern können, wer eskaliert hat und
warum (für `freigaben.eskaliert_von`/`kommentar`). Bis zur tatsächlichen Freigabe gibt es dafür
sonst keinen Platz:

```sql
ALTER TABLE jobs ADD COLUMN freigabe1_eskaliert_von TEXT REFERENCES personen(churchtools_person_id);
ALTER TABLE jobs ADD COLUMN freigabe1_eskalationsgrund TEXT;
ALTER TABLE jobs ADD COLUMN freigabe2_eskaliert_von TEXT REFERENCES personen(churchtools_person_id);
ALTER TABLE jobs ADD COLUMN freigabe2_eskalationsgrund TEXT;
```

Werden beim Eskalieren gesetzt, beim tatsächlichen Erteilen der jeweiligen Freigabe in die
entsprechende `freigaben`-Zeile übernommen (`eskaliert_von`, `kommentar`) und danach wieder auf
`null` zurückgesetzt — die `freigaben`-Tabelle bleibt die dauerhafte Audit-Quelle, die
`jobs`-Spalten sind nur ein Zwischenspeicher für die laufende Übergabe.

**Kein neues Feld für "wer ist gerade für Freigabe 2 zuständig"** — wird zur Laufzeit berechnet:
`freigabe2_eskaliert_von IS NULL ? konto.freigeber2_id : konto.stellvertreter2_id`. Für
Freigabe 1 existiert das Äquivalent schon: `zugewiesen_an` wird beim Eskalieren direkt auf
`stellvertreter1_id` umgesetzt (bereits seit Phase C vorhanden, keine Erweiterung nötig).

**Kein neues Feld für "gestempeltes PDF"** (wie in der D1-Spec offengelassen) — die gestempelten
Bytes überschreiben `pdf_pfad` direkt (atomar über Temp-Datei + Rename), sobald Freigabe 2
abgeschlossen wird. `thumbnail_pfad` bleibt unverändert (zeigt weiterhin die ursprüngliche erste
Seite).

**Neue Repo-Funktionen auf `jobsRepo.js`**: `listZugewiesenJobsForPerson(db, personId)`
(`status='zugewiesen' AND zugewiesen_an=?`) und `listFreigabe2JobsForPerson(db, personId)`
(`status='freigabe2' AND (konto.freigeber2_id=? OR (freigabe2_eskaliert_von IS NOT NULL AND
konto.stellvertreter2_id=?))`, Join auf `konten`).

## Kontierung + Freigabe 1 (`GET/POST /kontierung/:id`)

**Zugriff**: 403, wenn `currentPerson.churchtools_person_id !== job.zugewiesen_an` oder
`job.status !== 'zugewiesen'`.

**Formular**: Konto-Dropdown, gefiltert auf Konten, bei denen `currentPerson` `freigeber1_id`
oder `stellvertreter1_id` ist — bei auto-zugewiesenen Jobs vorausgewählt auf `job.konto_id`,
bleibt aber änderbar (falls die Zuweisungsregel danebenlag und diese Person mehrere eigene
Konten hat). Darunter: Interessenskonflikt Nein/Ja + Begründungsfeld (Pflicht, wenn Ja).

**Bei Absenden ohne Konflikt** (eine Transaktion):
1. `job.konto_id` = gewähltes Konto
2. `createFreigabe(db, { jobId, personId: currentPerson, rolle: 'freigeber1', ip,
   interessenskonflikt: false, kommentar: null, eskaliertVon: job.freigabe1_eskaliert_von })` —
   `eskaliertVon` kommt aus der Job-Spalte, falls diese Person selbst als Stellvertretung
   einsprang, sonst `null`
3. `job.freigabe1_eskaliert_von`/`-grund` zurücksetzen
4. `job.status = 'freigabe2'` — die Zwischenzustände `kontiert`/`freigabe1` aus dem
   Phase-C-Schema werden nie persistent erreicht, da Kontierung und Freigabe 1 laut Lastenheft
   "aus einer Hand" passieren, also in einer Transaktion

**Bei Absenden mit Konflikt** (eine Transaktion):
1. `job.konto_id` = gewähltes Konto (wird trotzdem gespeichert — reine Dateneingabe, kein
   Interessenskonflikt-Akt)
2. `job.zugewiesen_an` = `konto.stellvertreter1_id`
3. `job.freigabe1_eskaliert_von` = `currentPerson`, `job.freigabe1_eskalationsgrund` =
   Begründungstext
4. `job.status` bleibt `'zugewiesen'` — die Stellvertretung sieht den Job jetzt unter "Meine
   offenen Kontierungen" und durchläuft denselben Kontierungs-Screen (Konto ist durch Schritt 1
   schon fix, taucht aber trotzdem im eigenen gefilterten Dropdown auf, da sie als
   `stellvertreter1_id` berechtigt ist)

## Freigabe 2 (`GET/POST /freigabe2/:id`) + Abschluss

**Zugriff**: 403, wenn `job.status !== 'freigabe2'` oder `currentPerson` nicht der aktuell
zuständigen Person entspricht (siehe Datenmodell).

**Ansicht**: Split-View wie im Lastenheft — links scrollbarer `<iframe>` mit allen PDF-Seiten,
rechts ein fixiertes Panel mit Kontierungs-Zusammenfassung (Konto, Freigeber-1-Identität, deren
Interessenskonflikt-Status/Begründung) und dem eigenen Interessenskonflikt-Feld. **Nur ein
"Freigeben"-Button — kein "Ablehnen" in D2.** Der Rückweg bei Ablehnung ist laut Phasenplan
explizit D3s Aufgabe; ein Button, der noch nichts tut, wäre irreführender als sein bewusstes
Fehlen in dieser Sub-Phase.

**Bei Freigeben ohne Konflikt** (eine Transaktion):
1. `createFreigabe(db, { jobId, personId: currentPerson, rolle: 'freigeber2', ip,
   interessenskonflikt: false, kommentar: null, eskaliertVon: job.freigabe2_eskaliert_von })`
2. `job.freigabe2_eskaliert_von`/`-grund` zurücksetzen
3. **Abschluss, im selben Request**: `stampData` aus beiden `freigaben`-Zeilen zusammenbauen
   (Name, ChurchTools-Identität, Zeitpunkt, IP, Interessenskonflikt-Status je Freigabe),
   `getConfigValue(db, 'visum_seite_position')` lesen, `stampAndFinalize(pdfBuffer, stampData,
   position)` aufrufen, Ergebnis atomar (Temp-Datei + Rename) über `job.pdf_pfad` schreiben,
   `job.status = 'abgeschlossen'`
4. Schlägt das Stempeln fehl (D1s Fehlerverhalten: wirft einen deutschen `Error`), wird **keine**
   der obigen Änderungen committet — Formular wird mit einer Fehlermeldung neu angezeigt, der Job
   bleibt in `freigabe2`, ein erneuter Versuch ist möglich

**Bei Freigeben mit Konflikt**: analog zu Freigabe 1 — `freigabe2_eskaliert_von`/`-grund`
setzen, Status bleibt `freigabe2`, ab jetzt ist `stellvertreter2_id` zuständig, keine
`freigaben`-Zeile, kein Abschluss.

Damit ist `stampAndFinalize` (D1) der einzige Ort, an dem PDF-Inhalte final verändert werden,
und `GET /api/n8n/jobs/abholbereit`/`POST /api/n8n/jobs/:id/abholung-bestaetigen` (Phase C)
funktionieren unverändert weiter, sobald `status = 'abgeschlossen'` erreicht ist.

## Pool-Übersicht (`GET /pool`)

Drei Abschnitte auf einer Seite, jeweils leer ausblendbar:

- **Pool**: `listPoolJobs` (unzugewiesen), pro Zeile Thumbnail (`<img
  src="/api/pool/:id/thumbnail">`, Fallback-Platzhalter wenn `thumbnail_pfad` `null` ist), Alter
  (`eingang_am`), "Beanspruchen"-Button (Fetch → `POST /api/pool/:id/beanspruchen`, bei 409
  Inline-Fehlermeldung + Zeile aus der Liste entfernen)
- **Meine offenen Kontierungen**: `listZugewiesenJobsForPerson`, Link zu `/kontierung/:id`
- **Meine Freigaben**: `listFreigabe2JobsForPerson`, Link zu `/freigabe2/:id`

## Fehlerbehandlung

- Zugriff auf `/kontierung/:id` oder `/freigabe2/:id` außerhalb der erlaubten Rolle/des
  erlaubten Status → 403 mit der bestehenden `error.ejs`-Seite (wie `requireRole` es schon
  macht), keine Detailinfo darüber, wer stattdessen zuständig wäre.
- Ungültige Konto-Auswahl (nicht in der gefilterten eigenen Liste, oder inaktiv) → 400, Formular
  mit Fehler neu gerendert, nichts persistiert.
- Interessenskonflikt = Ja ohne Begründungstext → 400, Formular neu gerendert.
- Stempel-Fehler beim Abschluss → siehe oben, kein Teilzustand wird gespeichert.
- Alle Datenbankänderungen pro Formular-Submit laufen in einer einzigen `node:sqlite`-Transaktion
  (synchron, wie im restlichen Projekt), damit z. B. "Konto setzen + Freigabe-Zeile anlegen +
  Status wechseln" nie halb angewendet wird.

## Tests

Wie in Phase A–D1: echte HTTP-Requests via `supertest`, echte In-Memory-SQLite-DB, echte
PDF-Fixtures (die `buildPdfFixture`-Helferfunktion aus D1 wird wiederverwendet), keine Mocks der
eigenen Business-Logik.

- Zugriffskontrolle für alle drei neuen Routen, inkl. des Falls "die falsche Person aus der
  `buchhaltung`-Gruppe bekommt 403" (nicht nur "keine Session bekommt 401").
- Der komplette Konflikt-Eskalations-Pfad für Freigabe 1 und Freigabe 2, inkl. Prüfung, dass die
  Eskalations-Spalten danach wieder `null` sind und korrekt in der `freigaben`-Zeile landen.
- Happy-Path Ende-zu-Ende: Pool → Beanspruchen → Kontierung → Freigabe 2 → `abgeschlossen` mit
  gestempeltem PDF, per `mupdf`-Textextraktion verifiziert (wie in D1).
- Ein fehlgeschlagenes Stempeln lässt den Job unverändert in `freigabe2`.
- Konto-Dropdown-Filterung: eine Person ohne eigene Konten sieht ein leeres Dropdown und kann
  nicht kontieren; eine Person mit mehreren eigenen Konten sieht alle davon.

## Nicht Teil von Sub-Phase D2

Ablehnung/Rückweg-Workflow (kein "Ablehnen"-Button in der Freigabe-2-Ansicht), tatsächlicher
Versand von Zuweisungs-/Reminder-/Eskalations-Mails — beides D3. Rate-Limiting auf den neuen
Routen ist Phase E.
