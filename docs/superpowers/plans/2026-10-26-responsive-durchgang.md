# Responsive-Durchgang — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede Seite des Portals ist bei 360, 768, 1024 und 1280 px bedienbar; ein Playwright-Browsertest (`npm run test:responsive`) sichert das ab.

**Architecture:** Zuerst ein eigenständiger Browsertest (rot), der die App mit einer Spiel-Datenbank aus den Testmodus-Beispieldaten startet (Test-Instanz `createApp({ ..., testmodus: true })`, Sitzung als Beispielperson Dora = Superadmin) und eine gepflegte Seitenliste in allen Breiten prüft. Dann zentrale CSS-Regeln (`public/css/portal.css`: Touch-Ziele, Tablet-Stufe), Spalten-Korrekturen, der PDF-Umschalter, und Einzelkorrekturen, bis der Test grün ist.

**Tech Stack:** Node.js ESM, Express 4, EJS, Bootstrap 5 (vendor), `playwright` (exakt gepinnte devDependency, Chromium), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-25-responsive-durchgang-design.md`

## Global Constraints

- Breiten exakt: 360 (Handy, `isMobile`, `hasTouch`), 768 und 1024 (Tablet, `hasTouch`), 1280 (Desktop, Maus).
- Kein seitliches Scrollen: `document.documentElement.scrollWidth <= document.documentElement.clientWidth` (Toleranz 1 px). Ausnahme: Tabellen in `.table-responsive` (deren innere Breite zählt nicht).
- Touch-Ziele bei Touch-Breiten: jedes sichtbare `a.btn, button, input:not([type=hidden]), select, textarea, .form-check-input`-Klickziel ≥ 44 × 44 px (Box inkl. Label bei Checkbox/Radio, wenn das Label klickbar ist); Desktop mit Maus unverändert.
- Unter 992 px ist das Menü (Offcanvas-Knopf) sichtbar und öffnet die Seitenleiste.
- Kein Build-Schritt, kein Sass; Bootstrap 5 und `portal.css` bleiben Grundlage; Desktop-Darstellung ≥ 1200 px unverändert (keine zusätzlichen Klicks).
- `npm run test:responsive` ist **nicht** Teil von `npm test`; `npm test` bleibt grün (aktuell 2275) und spürbar gleich schnell. Playwright-Version exakt gepinnt (keine `^`), Browser über `npx playwright install chromium`.
- PDF-Seiten (`kontierung.ejs`, `freigabe2.ejs`, `spesen-freigabe1.ejs`, `kk-abgleich.ejs`, `pool.ejs`-Vorschau, `kontierung-aufsplitten.ejs`): unter 992 px Umschalter "Beleg / Formular", statt eingebettetem PDF das bestehende Vorschaubild (`/downloads/:jobId/thumbnail`) und Knopf "PDF öffnen" (neuer Tab, bestehende signierte URL inkl. Auffrischen); ab 992 px wie heute.

## Review Focus

1. Sehr lange Inhalte (Dateiname ohne Leerzeichen, IBAN, langer Kreditor, lange Kommentarzeile) bei 360 px → kein seitliches Scrollen (Task 1 Seitendaten enthalten solche Werte).
2. Formular mit Fehlermeldungen (422) bei 360 px → Fehlermeldungen sichtbar, kein Überlauf (Task 1: mindestens Kontierung und Spesen neu mit Fehlerzustand).
3. Testmodus-Band plus Banner plus Kopfzeile bei 360 px → Inhalt bleibt erreichbar (Band nicht höher als 30 % des Bildschirms) (Task 1).
4. PDF-Umschalter ohne JavaScript → beide Bereiche untereinander sichtbar (Task 3 Test).
5. Breite Tabellen (Admin-Listen) → nur der Tabellenrahmen scrollt, Seite nicht (Task 1).

---

### Task 1: Browsertest (rot)

**Files:**
- Modify: `package.json` (devDependency `playwright` exakt, Script `"test:responsive": "node test/responsive/run.js"`)
- Create: `test/responsive/run.js`, `test/responsive/seiten.js`, `test/responsive/server.js`
- Test: der Lauf selbst; plus `test/unit/responsiveSeitenliste.test.js` (läuft in `npm test`, ohne Browser)

**Interfaces:**
- `server.js`: `async starteResponsiveServer() → { url, stop() }` — temporäres Verzeichnis, echte DB-Datei, `erstelleSpielwiese` (Testmodus-Beispieldaten), Test-Instanz der App hinter einer kleinen Hülle, die `req.session = { id, testmodus: { personId: 'test-4' } }` setzt (Dora; Personenwechsel per Query `?als=test-1` für Seiten, die eine andere Rolle brauchen); Zusatzdaten für Review Focus 1 (lange Werte) werden in der Spiel-DB ergänzt.
- `seiten.js`: `export const SEITEN = [{ pfad, als?, name, fehlerzustand? }]` — alle GET-Seiten (aus `layoutSweep`-Liste plus Detailseiten mit Beispiel-IDs); Seiten, die nur in der echten App existieren (`/admin/testmodus`, `/admin/betrieb/status`, `/admin/backup`), werden ausgelassen und in der Datei begründet.
- `run.js`: Chromium, je Seite × Breite: Überlauf-Prüfung, Touch-Ziel-Prüfung (Touch-Breiten), Menü-Prüfung (< 992), Band-Höhe (Review Focus 3); Ausgabe je Verstoss `Breite Seite Art Selektor Masse`, Zusammenfassung, Exit-Code 1 bei Verstössen; Screenshots der Verstösse nach `test-results/responsive/` (git-ignoriert).
- `responsiveSeitenliste.test.js`: jede `layoutSweep`-Seite ist in `SEITEN` enthalten oder ausdrücklich ausgenommen.

- [ ] **Step 1:** Playwright installieren (exakte Version, passend zum vorhandenen Browser-Cache, sonst `npx playwright install chromium`), Harness bauen.
- [ ] **Step 2:** `npm run test:responsive` ausführen → **erwartet rot**; Verstoss-Liste in den Bericht kopieren (Anzahl je Art/Breite).
- [ ] **Step 3:** `npm test` → PASS.
- [ ] **Step 4:** Commit `test(responsive): Browsertest für alle Seiten`.

### Task 2: Zentrale CSS-Regeln und Spaltenaufteilung

**Files:**
- Modify: `public/css/portal.css`, `views/kontierung-aufsplitten.ejs`, `views/admin/geplante-jobs.ejs`, `views/admin/zeitstempel-form.ejs`, `views/kontierung.ejs`, `views/admin/mail-einstellungen-form.ejs`, `views/admin/backup.ejs`, weitere Views laut Verstoss-Liste
- Test: `npm run test:responsive` (Verstösse Touch/Überlauf deutlich weniger), bestehende Tests

**Interfaces:**
- `@media (pointer: coarse)`: `.btn-sm`, `.btn`, `.form-control`, `.form-select`, `.page-link`, Seitenleisten-Links, `.form-check` (Label-Fläche) ≥ 44 px; Desktop/Maus unverändert.
- Tablet-Stufe `@media (min-width: 768px) and (max-width: 991.98px)`: Inhalte nicht gestreckt, zweispaltige Formulare wo sinnvoll.
- `col-N` ohne Breakpoint → `col-12 col-md-N` (bzw. passend); Aufsplitten-Zeilen am Handy als Karte mit sichtbaren Beschriftungen.

- [ ] **Step 1:** Änderungen; `npm run test:responsive`, Verstoss-Zahlen vorher/nachher in den Bericht.
- [ ] **Step 2:** `npm test` → PASS (Markup-Tests anpassen, wo Klassen geprüft werden).
- [ ] **Step 3:** Commit `style(responsive): Touch-Ziele, Tablet-Stufe, Spalten`.

### Task 3: PDF-Seiten mit Umschalter

**Files:**
- Create: `views/_beleg_umschalter.ejs`, `public/js/belegUmschalter.js`
- Modify: die sechs PDF-Views aus Global Constraints und ihre Routen (Thumbnail-URL/Download-URL bereitstellen, falls nicht vorhanden)
- Test: `test/integration/belegUmschalter.test.js`, `npm run test:responsive`

**Interfaces:**
- Partial erhält `{ jobId, pdfUrl, thumbnailUrl, refreshUrl }`; rendert ab 992 px das bisherige eingebettete PDF, darunter (unter 992 px) Umschalter-Knöpfe "Beleg" / "Formular" (`aria-pressed`), Vorschaubild mit Link und Knopf "PDF öffnen" (`target="_blank" rel="noopener"`); Auffrischen der signierten URL wie bestehend. Ohne JS: beide Bereiche untereinander (Review Focus 4).

- [ ] **Step 1: Failing tests:** jede der sechs Seiten enthält Umschalter, Vorschaubild und "PDF öffnen" mit korrekter URL; ohne JS-Klasse sind beide Bereiche sichtbar (Markup); Desktop-Markup enthält weiterhin das eingebettete PDF.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`; `npm run test:responsive` für die sechs Seiten ohne Verstoss.
- [ ] **Step 5:** Commit `feat(responsive): Beleg/Formular-Umschalter auf PDF-Seiten`.

### Task 4: Restliche Verstösse und Doku

**Files:**
- Modify: Views/CSS laut verbleibender Verstoss-Liste; `README.md` (Abschnitt "Responsive testen"), `docs/` passende Stelle (Layout/Architektur)
- [ ] **Step 1:** Verstösse beheben, bis `npm run test:responsive` grün ist (Exit 0). Echte Ausnahmen nur mit Begründung in `seiten.js` und im Bericht.
- [ ] **Step 2:** README-Abschnitt: Installation (`npm ci`, `npx playwright install chromium`), Ausführen, Ausgabe lesen, Seite hinzufügen.
- [ ] **Step 3:** `npm test` → PASS; `npm run test:responsive` → PASS.
- [ ] **Step 4:** Commit `style(responsive): alle Seiten in allen Breiten` und `docs: Responsive testen`.
