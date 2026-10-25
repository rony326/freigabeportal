# Responsive-Durchgang — Design

Stand: 2026-10-25. Status: Entwurf, zur Freigabe.
Teil 6 (letzter) des Backlogs vor dem Launch. Alle neuen Seiten aus Teil 1–5 werden bereits
responsive gebaut; dieser Durchgang zieht die bestehenden Seiten nach und sichert das Ergebnis mit
einem Browser-Test ab.

## Absicht und Warum

Im Portal wird auch **am Handy und am Tablet** gearbeitet. Es gibt keine einzelne Schmerzstelle;
Ziel ist, dass das ganze Portal auf allen Geräten bedienbar ist — "zu 100 % responsive".

## Ziele (Definition von "100 % responsive")

1. Drei Referenzbreiten funktionieren auf **jeder** Seite: **Handy 360 px**, **Tablet 768 px**
   (hoch) und **1024 px** (quer), **Desktop 1280 px**.
2. **Kein seitliches Scrollen der Seite**; einzige Ausnahme sind breite Tabellen in ihrem eigenen
   Rahmen. Am Handy werden Aufgaben-Tabellen zu Karten (bestehende Kachelansicht als Standard bei
   kleiner Breite).
3. **Bedienelemente** auf Touch-Geräten mindestens **44 px** hoch/breit; Formulare einspaltig am
   Handy.
4. **Seitenleiste** als Aufklapp-Menü auf Handy und Tablet (besteht unter 992 px).
5. **PDF-Seiten** (Kontierung, Freigabe 2, Spesen-Freigabe 1, Kreditkarten-Abgleich, Pool-
   Vorschau, Aufsplitten): Vorschau und Formular am Handy/Tablet hoch **untereinander** mit
   Umschalter "Beleg / Formular"; statt eingebettetem PDF ein **Vorschaubild** (bestehende
   Thumbnails) und ein Knopf **"PDF öffnen"** (neuer Tab), weil iOS/iPadOS eingebettete PDFs nicht
   zuverlässig scrollbar anzeigen.
6. **Automatischer Browser-Test** mit **Playwright** (Entwicklungsabhängigkeit, Nutzerentscheid):
   jede Seite in den drei Breiten, Prüfung auf seitliches Scrollen
   (`document.documentElement.scrollWidth > clientWidth`), zu kleine Touch-Ziele und sichtbares
   Menü.

## Gefundene Problemstellen (Bestandsaufnahme 2026-10-25)

- Eingebettete PDF-Vorschau (85 vh) in `kontierung.ejs`, `freigabe2.ejs`, `spesen-freigabe1.ejs`,
  `kk-abgleich.ejs`, `pool.ejs`, `kontierung-aufsplitten.ejs`.
- Feste Spaltenaufteilung ohne Breakpoint (`col-N`): `kontierung-aufsplitten.ejs` (11),
  `admin/geplante-jobs.ejs` (13), `admin/zeitstempel-form.ejs` (5), `kontierung.ejs` (4),
  `admin/mail-einstellungen-form.ejs` (2), `admin/backup.ejs` (2).
- 77 Knöpfe in `btn-sm` (Touch-Ziel < 44 px).
- `portal.css` kennt nur Breakpoints ≥ 992 px und ≥ 1200 px; keine Tablet-Zwischenstufe.
- Unkritisch, aber mitprüfen: `max-width` 760/720/360 px in `kreditkarte-beleg-bearbeiten.ejs`,
  `admin/kreditkarten-form.ejs`, `admin/backup.ejs`.
- Bereits gut: alle 24 Tabellen-Seiten haben Scroll-Rahmen; Seitenleiste als Offcanvas; ein
  gemeinsames Seitengerüst mit korrektem Viewport.

## Nicht-Ziele

- Kein neues visuelles Design (Farben, Schrift, Branding bleiben).
- Keine App, kein Offline-Betrieb.
- Keine Änderung an PDFs/Stempeln.

## Anti-Ziele

- Desktop wird schlechter (mehr Klicks, weniger Information auf grossen Bildschirmen).
- Funktionen sind am Handy versteckt oder fehlen.
- Der Browser-Test wird zur Pflicht auf dem Server oder verlangsamt `npm test` spürbar
  (läuft getrennt als `npm run test:responsive`).

## Vom Nutzer entschieden

1. Ganzes Portal, Handy und Tablet, ohne einzelne Schwerpunkte.
2. Definition und Bestandsaufnahme wie oben bestätigt.
3. **Playwright** als Entwicklungswerkzeug mit Browser-Test.

## Entscheidungen des Entwurfs (meine Calls)

1. **Touch-Ziele zentral**: `@media (pointer: coarse)` in `portal.css` hebt `.btn-sm`,
   Formular-Controls, Paginierung und Menüpunkte auf mindestens 44 px; Desktop mit Maus unverändert.
2. **Tablet-Zwischenstufe** 768–991 px in `portal.css` (zweispaltige Formulare wo sinnvoll,
   Inhalte nicht gestreckt).
3. **Spaltenaufteilung**: `col-N` → `col-12 col-md-N` (bzw. passende Breakpoints); im
   Aufsplitten-Formular wird jede Zeile am Handy zu einer Karte mit Beschriftungen.
4. **Standardansicht Kacheln** unter 768 px für alle Listen mit Ansicht-Umschalter, sofern die
   Person nichts anderes gewählt hat.
5. **PDF-Umschalter** ohne neue Bibliothek: CSS-Breakpoint + kleines Skript; der Knopf
   "PDF öffnen" nutzt die bestehende signierte Vorschau-URL (inkl. Auffrischen).
6. **Browser-Test**: `npm run test:responsive` startet die App mit Testdatenbank und Beispieldaten
   (nutzt die Beispieldaten des Testmodus, Teil 3), meldet sich über die Test-Sitzung als
   Superadmin an und besucht eine Liste aller GET-Seiten (aus den Routen bzw. einer gepflegten
   Liste, die `layoutSweep` ergänzt). Playwright-Version exakt gepinnt; Browser-Download beim
   ersten Lauf (`npx playwright install chromium`). Nicht Teil von `npm test`.
7. Reihenfolge innerhalb des Durchgangs: zuerst Browser-Test (rot), dann Korrekturen, bis grün.

## Einschränkungen

- Bootstrap 5 und bestehendes `portal.css` bleiben die Grundlage.
- Kein Build-Schritt (kein Sass/PostCSS).

## Dem Builder überlassen

- Genaue Breakpoints einzelner Komponenten, Gestaltung des Umschalters.
- Seitenliste für den Browser-Test und Testdaten-Aufbau.
- Doku: README-Abschnitt "Responsive testen".
