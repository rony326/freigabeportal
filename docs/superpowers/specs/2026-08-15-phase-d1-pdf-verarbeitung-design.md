# Freigabeportal — Sub-Phase D1: PDF-Verarbeitung

Status: approved (Sub-Phase D1 only)
Datum: 2026-08-15

## Kontext

Phase A (Fundament & Auth), Phase B (Admin-Bereich) und Phase C (n8n-Schnittstelle &
Job-Datenmodell) sind abgeschlossen und auf `master` gemerged. Phase C liefert das
Job-Datenmodell und die reinen API-Endpunkte (Job-Erstellung, Pool, signierte Downloads,
zweiphasiges Abholen) — bewusst ohne Browser-UI.

Das ursprüngliche Lastenheft bündelt den Rest unter "Phase D – Freigabe-Workflow-UI". Diese
Bündelung ist zu gross für einen einzelnen Implementierungsplan: Sie umfasst mehrere weitgehend
unabhängige Subsysteme — PDF-Verarbeitung (Thumbnail-Rendering + Stempelung), die eigentliche
Freigabe-Workflow-UI (Pool-Seite, Kontierung, Freigabe2-Split-View) und Ablehnung/Rückweg samt
tatsächlichem Mailversand. Phase D wird daher in Sub-Phasen zerlegt, jede mit eigenem
Spec-/Plan-/Implementierungszyklus:

- **D1 – PDF-Verarbeitung (dieses Dokument)**: Thumbnail-Rendering und PDF-Stempelung als reine,
  isoliert testbare Service-Module. Technisch das riskanteste Stück von Phase D, da Infomaniaks
  Node.js-Webhosting vermutlich keine nativen Module erlaubt — beide benötigten Bibliotheken
  müssen daher WASM/pure-JS sein.
- **D2 – Freigabe-Workflow-UI**: Pool-Seite (inkl. Thumbnail-Anzeige), Kontierung, Freigabe2
  Split-View, Verdrahtung der D1-Stempel-Funktion beim Abschluss.
- **D3 – Ablehnung/Rückweg & Mailversand**: Rückwärtspfad bei Ablehnung, tatsächlicher Versand
  von Zuweisungs-/Reminder-/Eskalations-Mails.

Die genaue Aufteilung von D2/D3 wird beim jeweiligen Brainstorming vor der jeweiligen Sub-Phase
präzisiert; sie ist hier nur als Kontext genannt.

### Phasenplan (Kontext, aus Phase C übernommen)

- Phase A – Fundament & Auth (abgeschlossen, gemerged)
- Phase B – Admin-Bereich (abgeschlossen, gemerged)
- Phase C – n8n-Schnittstelle & Job-Datenmodell (abgeschlossen, gemerged)
- **Phase D – Freigabe-Workflow-UI**
  - **D1 – PDF-Verarbeitung (dieses Dokument)**
  - D2 – Freigabe-Workflow-UI (Pool, Kontierung, Freigabe2)
  - D3 – Ablehnung/Rückweg & Mailversand
- Phase E – Härtung & Deployment (inkl. Rate-Limiting)

## Bibliotheken

Beide benötigten Bibliotheken sind WASM/pure-JS, keine nativen Abhängigkeiten — passend zur
Infomaniak-Einschränkung:

- **`mupdf`** (offizielles Artifex-WASM-Paket) fürs Thumbnail-Rendering: PDF-Seite → PNG.
- **`pdf-lib`** fürs Stempeln: reines JS, zeichnet Text auf feste Koordinaten. Da laut Lastenheft
  bewusst keine PDF-Formularfelder verwendet werden (in einem früheren Test als unzuverlässig
  erkannt verworfen), ist das Ergebnis automatisch "flach" — kein separater Flatten-Schritt nötig.

## Architektur & Geltungsbereich

- Zwei reine Service-Module, **keine neue Route, kein UI**: `src/services/thumbnail.js`
  (Rendering) und `src/services/pdfStamp.js` (Stempelung).
- Thumbnail-Rendering wird **jetzt schon verdrahtet** — in die bestehende
  `POST /api/n8n/jobs`-Route (Phase C), da diese schon existiert und testbar ist.
- Die Stempel-Funktion bleibt in D1 **unverdrahtet** (reine, isoliert getestete
  Bibliotheksfunktion) — D2 ruft sie beim Abschluss von Freigabe2 auf, sobald diese Route
  existiert.
- Beide Funktionen arbeiten rein mit Buffern (kein Datei-I/O in den Funktionen selbst) — der
  jeweilige Aufrufer entscheidet, wo/ob gespeichert wird. Hält die Funktionen klein, pur und
  leicht testbar.

## Datenmodell

- Neue Spalte `jobs.thumbnail_pfad` (nullable TEXT).
- Kein neues Feld für "gestempeltes PDF" — das ist D2's Entscheidung, wie/wo das Ergebnis der
  Stempel-Funktion abgelegt wird.

## Thumbnail-Rendering

- `renderFirstPageThumbnail(pdfBuffer)` → PNG-Buffer. Via `mupdf`: öffnet das PDF aus dem Buffer,
  lädt Seite 0, rendert als Pixmap mit fester, kleiner Skalierung (Ziel: ~200px Breite, passend
  für eine Listen-Zeile), gibt PNG-Bytes zurück.
- Verdrahtung in `POST /api/n8n/jobs`: nach erfolgreicher PDF-Validierung (Magic-Bytes-Check)
  wird das Thumbnail gerendert und unter `config.jobsDir` als `<gleicher-basisname>.png`
  gespeichert; Pfad landet in `jobs.thumbnail_pfad`.
- **Fehlerbehandlung bewusst nicht blockierend**: Ein Rendering-Fehler (z.B. ein PDF, das die
  Magic-Bytes-Prüfung besteht, aber intern beschädigt ist) darf die Job-Erstellung **nicht**
  verhindern — das Thumbnail ist eine Komfort-Funktion für die spätere Pool-UI (D2), nicht Teil
  des Kern-Workflows. Bei Fehler: Job wird trotzdem angelegt, `thumbnail_pfad` bleibt `null`,
  Fehler wird serverseitig geloggt, n8n bekommt weiterhin `201` mit Job-Daten (keine
  Fehlermeldung für einen rein kosmetischen Ausfall).

## PDF-Stempelung

- `stampAndFinalize(pdfBuffer, stampData)` → gestempeltes PDF als Buffer. Via `pdf-lib`: lädt das
  PDF, nimmt die **letzte Seite** (dort liegt laut n8n-Merge-Reihenfolge die Visum-Deckseite),
  zeichnet Text in die zwei vorgesehenen Blöcke ("Geprüft und freigegeben von" — Freigeber1 und
  Freigeber2) an festen Koordinaten.
- `stampData`-Form: `{ freigeber1: { name, identitaet, zeitpunkt, ip, interessenskonflikt,
  kommentar }, freigeber2: { ...gleiche Felder... } }`. `zeitpunkt` wird als UTC-ISO-String
  übergeben und beim Stempeln nach Europe/Zurich lokalisiert dargestellt (konsistent mit der
  Zeitzonen-Regel aus Phase A).
- Da nie echte PDF-Formularfelder befüllt werden (bewusst, laut Lastenheft), ist das Ergebnis
  automatisch nicht-interaktiv — kein separater "Flatten"-Schritt nötig.

## Fehlerbehandlung

- Thumbnail-Rendering-Fehler: siehe oben, nicht blockierend, geloggt, Job wird trotzdem mit
  `201` angelegt.
- Stempel-Fehler (z.B. PDF hat keine Seiten, oder ist nicht mehr gültig ladbar): Funktion wirft
  einen Error mit deutscher Meldung — hier **ist** ein Fehler blockierend, da eine
  fehlgeschlagene Stempelung bedeuten würde, dass der Abschluss-Schritt (D2) nicht sauber
  abgeschlossen werden kann. D2 entscheidet dann, wie es dem Nutzer angezeigt wird.

## Tests

Wie in Phase A/B/C: echte PDF-Bytes (Magic-Bytes-Fixture, echte mehrseitige PDF-Fixture für
Rendering-/Stempel-Tests), keine Mocks der eigenen Business-Logik.

- **Thumbnail**: echte mehrseitige PDF-Fixture → PNG-Buffer mit korrektem PNG-Header
  (`89 50 4E 47`); eine absichtlich kaputte PDF-Fixture → Funktion wirft einen definierten Error
  (kein Crash, kein leeres/stilles Ergebnis); Integrationstest gegen `POST /api/n8n/jobs` prüft,
  dass `thumbnail_pfad` gesetzt und die referenzierte Datei ein gültiges PNG ist, UND dass ein
  absichtlich kaputtes "PDF" (gültiger `%PDF`-Header, aber sonst Datenmüll) den Job trotzdem mit
  `201` anlegt, nur ohne Thumbnail.
- **Stempelung**: echte PDF-Fixture → Ergebnis ist ein gültiges, erneut mit `pdf-lib` ladbares
  PDF mit unveränderter Seitenzahl; zusätzlich wird der Text der letzten Seite über `mupdf`
  extrahiert (das ohnehin schon Dependency ist) und geprüft, dass Name, Zeitstempel-Bestandteile
  und der Interessenskonflikt-Status beider Blöcke tatsächlich im extrahierten Text vorkommen —
  ein aussagekräftiger Test statt nur "es warf keinen Fehler".

## Nicht Teil von Sub-Phase D1

Pool-Seite (inkl. Thumbnail-Anzeige), Kontierung, Freigabe2-Split-View, die tatsächliche
Verdrahtung von `stampAndFinalize` in einen Abschluss-Endpunkt, Ablehnung/Rückweg-Workflow,
tatsächlicher Versand von Zuweisungs-/Reminder-/Eskalations-Mails — all das ist D2/D3.
Rate-Limiting auf den bestehenden öffentlichen Endpunkten ist Phase E.
