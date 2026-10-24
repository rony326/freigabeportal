# Rechnungs-Reporting (Teil 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop-Seite "Auswertung" mit Kennzahlen, Budget pro Konto, Durchlaufzeiten, Engpässen pro Person und Lieferanten, Budgetpflege durch den Kassier und optionalem Budget-Import.

**Architecture:** Neue Tabelle `konto_budgets`, zwei additive Rechte, ein Service `auswertung.js` mit reinen Aggregationsfunktionen (SQL + kleine JS-Nachbearbeitung), Seite `/auswertung` mit CSV-Export, Admin-Seite `/admin/budgets` mit Import.

**Tech Stack:** Node.js, Express 4, EJS, node:sqlite, `node:test` + supertest; für XLSX-Import `read-excel-file` (Node-Einstieg `read-excel-file/node`, exakte Version pinnen).

**Spec:** `docs/superpowers/specs/2026-10-24-rechnungs-reporting-design.md`
**Visuelle Vorlage:** https://claude.ai/artifact/Q7JeqZcXV8ZMwL7CF4Ri9U (Desktop)

## Global Constraints

- Rechte: `auswertung_einsehen` ("Auswertung einsehen (alle Konten)"), `budgets_verwalten` ("Budgets verwalten") — additiv in `RIGHTS` (`src/db/securitySchema.js`), `GRANTABLE_BERECHTIGUNGEN` und `BERECHTIGUNG_LABELS` (`src/middleware/permissions.js`); Superadmin/Manager über ihr Bundle.
- Zugang `/auswertung`: `auswertung_einsehen` → alle Konten, alle Abschnitte. Sonst: Person ist `freigeber1_id` oder `stellvertreter1_id` mindestens eines aktiven Kontos → nur diese Konten, Abschnitt "Wo Rechnungen liegen" ausgeblendet. Sonst 403.
- "Freigegeben" = `status IN ('abgeschlossen','abgeholt','archiviert')`, Zeitraum über das **Zürcher Datum** von `abgeschlossen_am`.
- "In Freigabe" = aktueller Stand `status IN ('zugewiesen','freigabe2')` mit `konto_id`; `unzugewiesen` zählt nur in der Kennzahl (Konto unbekannt).
- Betrag = `CAST(betrag AS REAL)`, bei `typ = 'gutschrift'` negativ; `betrag IS NULL` zählt 0 und wird in der Fussnote als "N Rechnungen ohne Betrag" genannt; `qr_waehrung = 'EUR'` als "N Rechnungen in EUR, nicht umgerechnet".
- Status `abgelehnt`, `geloescht`, `aufgesplittet` zählen nie als Ausgabe (Split- und KK-Eltern sind `aufgesplittet`, ihre Teile zählen je Konto).
- Zeitraum-Voreinstellungen: `jahr` (1.1. laufendes Jahr bis heute, Default), `12m` (heute − 365 Tage bis heute), `vorjahr`, `eigen` (`von`, `bis` als `YYYY-MM-DD`, `von ≤ bis`, max. 5 Jahre).
- Budget pro Konto und Kalenderjahr; bei Zeitraum über mehrere Jahre gilt das Jahr von `bis` (Hinweis auf der Seite).
- Config `auswertung_offen_schwelle_tage` Default `'14'` (1–365), auf Admin → Module.
- Median = Mittelwert der beiden mittleren Werte bei gerader Anzahl; "langsamste 10 %" = 90. Perzentil nach Nearest-Rank (`ceil(0.9·n)`-tes Element); Werte in Tagen mit einer Nachkommastelle.
- CSV: Semikolon, UTF-8 mit BOM, Dezimalpunkt, Dateiname `auswertung-<abschnitt>-<von>-<bis>.csv`.
- UI Deutsch, "du", Schweizer Schreibweise; Beträge `CHF 12'345.60` (Apostroph als Tausendertrennzeichen); Shell-Layout mit Seitenleiste.
- Jeder Task endet mit `npm test` grün (aktuell 1895 Tests).

## Review Focus

1. Gutschrift, abgelehnte, gelöschte und aufgesplittete Elternrechnungen im selben Zeitraum → Summe entspricht nur den echten Ausgaben (Task 2 Test `Zählregeln`).
2. Freigabe kurz vor Mitternacht Zürich (z. B. 31.12. 23:30 Lokalzeit = 22:30Z) → fällt ins richtige Jahr (Task 2 Test `Zürcher Datumsgrenze`).
3. Freigeber 1 manipuliert `?konto=<fremdes Konto>` → keine fremden Zahlen, 403 oder leer (Task 4 Test `fremdes Konto per Filter`).
4. Konto ohne Budget im Jahr → Zeile mit "kein Budget" statt Division durch null (Task 2 Test `kein Budget`).
5. Import mit unbekannter Kontonummer, leerer Zeile, Betrag "12'000.–" oder "12 000,50" → Vorschau meldet bzw. liest korrekt, nichts gespeichert vor Bestätigung (Task 5 Tests).

---

### Task 1: Budgets-Tabelle, Rechte, Einstellung

**Files:**
- Modify: `src/db/schema.sql` oder neue `src/db/budgetSchema.js` mit `migrateBudgetSchema(db)` vor `migrateSecuritySchema` in `src/db/index.js`; `src/db/securitySchema.js` (`RIGHTS`, zentrale Audit-Liste `konto_budgets: 'konto_id'`), `src/middleware/permissions.js`, `src/db/adminConfigRepo.js`, `src/routes/admin/module.js` + `views/admin/module-form.ejs` (Feld `auswertungOffenSchwelleTage`)
- Create: `src/db/budgetRepo.js`
- Test: `test/unit/budgetRepo.test.js`, `test/integration/admin/module.test.js` (bestehend erweitern)

**Interfaces:**
- Produces Tabelle `konto_budgets(konto_id INTEGER NOT NULL REFERENCES konten(id), jahr INTEGER NOT NULL CHECK(jahr BETWEEN 2000 AND 2100), betrag REAL NOT NULL CHECK(betrag >= 0), geaendert_von TEXT, geaendert_am TEXT NOT NULL, PRIMARY KEY(konto_id, jahr))`.
- Produces (`budgetRepo.js`): `getBudget(db, kontoId, jahr) → number|null`, `listBudgetsFuerJahr(db, jahr) → Map<kontoId, number>`, `setzeBudget(db, { kontoId, jahr, betrag, personId })` (Upsert), `entferneBudget(db, kontoId, jahr)`.
- Produces: Rechte und Config wie in Global Constraints. Modul-Formular validiert 1–365 (400 + Re-Render).

- [ ] **Step 1: Failing tests:** `setzeBudget/getBudget/Upsert`; `negativer Betrag wirft`; `Audit-Ereignis bei Budgetänderung`; `Rechte vergebbar und beschriftet`; `Schwelle speichern/validieren`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(auswertung): Budgets, Rechte und Einstellung`.

### Task 2: Auswertungs-Service

**Files:**
- Create: `src/services/auswertung.js`
- Test: `test/unit/auswertung.test.js`

**Interfaces:**
- Consumes: `listBudgetsFuerJahr` (Task 1), `ermittleZustaendigkeit(db, job)` aus `src/services/vorgangZustaendigkeit.js`, `personHasPermission` aus `src/middleware/permissions.js`.
- Produces:
  - `parseZeitraum(query, heute = zuerichHeute()) → { von, bis, art, budgetJahr, fehler?: string }`.
  - `zugangFuer(db, config, person) → { alle: boolean, kontoIds: number[] | null, engpaesse: boolean } | null` (null = kein Zugang).
  - `kennzahlen(db, { von, bis, kontoIds, schwelleTage, heute }) → { freigegeben: { betrag, anzahl }, inFreigabe: { betrag, anzahl }, medianTage: number|null, langeOffen: { anzahl, aeltesteTage: number|null }, ohneBetrag: number, inEur: number }`.
  - `budgetProKonto(db, { von, bis, budgetJahr, kontoIds }) → Array<{ kontoId, kontonummer, bezeichnung, verantwortlich: string|null, budget: number|null, freigegeben, inFreigabe, ausschoepfung: number|null, ueberBudget: boolean }>` (aktive Konten; sortiert nach Kontonummer).
  - `durchlaufzeiten(db, { von, bis, kontoIds }) → Array<{ stufe: 'pool'|'freigabe1'|'freigabe2', median, p90, anzahl }>` — Pool = `eingang_am` bis erstes Verlassen von `unzugewiesen` (aus `audit_ereignisse`: `objekt='jobs'`, `aktion='UPDATE'`, `json_extract(vorher,'$.status')='unzugewiesen'` und `json_extract(nachher,'$.status')<>'unzugewiesen'`; keins vorhanden → 0); Freigabe 1 = Pool-Ende bis letzter `freigaben.rolle='freigeber1'`; Freigabe 2 = dieser Zeitpunkt bis `abgeschlossen_am`. Nur im Zeitraum freigegebene Rechnungen.
  - `engpaesse(db, { kontoIds, heute }) → Array<{ personId: string|null, name, art: 'person'|'pool'|'admin', stufe: 'Pool'|'Kontierung & Freigabe 1'|'Spesen-Freigabe 1'|'Freigabe 2'|'Überarbeitung', anzahl, aeltesteTage }>` — laufende Status (`LAUFENDE_STATUS`), gruppiert nach Zuständigkeit **und** Stufe; Alter seit Eintritt in die aktuelle Stufe (`freigabe2` → `freigabe2_seit`; sonst letzte `audit_ereignisse`-Änderung von `status` oder `zugewiesen_an` auf den heutigen Wert; Fallback `eingang_am`); sortiert nach `aeltesteTage` absteigend.
  - `lieferanten(db, { von, bis, kontoIds }) → Array<{ name, anzahl, betrag, anteil, konten: string[] }>` — Gruppe = Kreditor (`kreditoren.name`), Spesen als "Spesen (Rückerstattung)", ohne Kreditor "(kein Kreditor)"; `konten` = bis zu 2 Kontonummern mit grösstem Betrag; sortiert nach Betrag absteigend; `anteil` 0–1.
  - `median(werte)`, `perzentil90(werte)`, `formatChf(betrag) → "CHF 12'345.60"`, `zuerichDatum(iso) → 'YYYY-MM-DD'`.

- [ ] **Step 1: Failing tests** (Daten direkt per Repo/SQL anlegen): `Zählregeln` (Konto A: Rechnung 100, Gutschrift 30, abgelehnt 50, gelöscht 70; Split-Eltern 200 mit Teilen 120 auf A und 80 auf B → freigegeben gesamt 270, Konto A 190, Konto B 80); `Zürcher Datumsgrenze` (`abgeschlossen_am '2026-12-31T22:30:00Z'` zählt 2027 nicht, `'2026-12-31T23:30:00Z'` zählt 2027); `kein Budget` (budget null, ausschoepfung null, keine Exception); `über Budget`; `Median/P90` (`[1,2,3,4] → 2.5 / 4`, `[5] → 5 / 5`, `[] → null`); `Pool-Zeit aus Audit, 0 bei direkter Zuweisung`; `engpaesse gruppiert, Pool und Admin-Gruppe als eigene Zeilen, Alter seit Stufeneintritt`; `lieferanten mit Spesen und ohne Kreditor`; `kontoIds-Filter wirkt auf alle Funktionen`; `zugangFuer` (Recht → alle; nur F1/SV1 → deren Konten, engpaesse false; niemand → null); `ohneBetrag/inEur gezählt`; `parseZeitraum` (Presets, eigen, ungültig → fehler).
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(auswertung): Kennzahlen, Budget, Durchlaufzeiten, Engpässe, Lieferanten`.

### Task 3: Budgets pflegen (/admin/budgets)

**Files:**
- Create: `src/routes/admin/budgets.js`, `views/admin/budgets.ejs`
- Modify: `src/app.js` (Mount hinter `requirePermission(db, config, 'budgets_verwalten')`), `src/services/navigation.js` (Admin → Stammdaten "Budgets", Flag `budgets`), Admin-Nav-Flags
- Test: `test/integration/admin/budgets.test.js`, `test/integration/csrfSweep.test.js`

**Interfaces:**
- `GET /admin/budgets?jahr=` (Default laufendes Jahr): Tabelle aller aktiven Konten (Nummer, Bezeichnung, Freigeber 1, Budget-Eingabefeld, Vorjahresbudget als Hinweis); Jahr wechseln.
- `POST /admin/budgets` (CSRF): Felder `jahr`, `budget_<kontoId>`; leer = Budget entfernen; Beträge mit `'`, Leerzeichen, `,` oder `.` als Dezimaltrenner tolerieren über `parseBetrag(text) → number|null` (in `src/services/auswertung.js` exportiert); ungültig → 400, nichts gespeichert; Erfolg → Redirect mit Hinweis.

- [ ] **Step 1: Failing tests:** Zugang (ohne Recht 403, mit 200); `speichern, leeren entfernt, ungültig 400 ohne Teilspeicherung`; `parseBetrag("12'000.–")=12000, ("12 000,50")=12000.5, ("abc")=null`; CSRF-Sweep.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(auswertung): Budgets pflegen`.

### Task 4: Seite /auswertung mit Export

**Files:**
- Create: `src/routes/auswertung.js`, `views/auswertung.ejs`
- Modify: `src/app.js` (Mount `/auswertung` hinter `requireLogin()`), `src/services/navigation.js` (Portal → Arbeit "Auswertung", Flag `auswertungSichtbar`), `src/middleware/nav.js`
- Test: `test/integration/auswertung.test.js`, Sweeps (`layoutSweep`, `csrfSweep`)

**Interfaces:**
- Consumes: alle Funktionen aus Task 2.
- `GET /auswertung` mit `zeitraum`, `von`, `bis`, `konto` (Kontonummer oder leer): Layout wie die Vorlage (Kennzahlen, Budget-Tabelle mit Balken, Durchlaufzeit, "Wo Rechnungen liegen" nur bei `engpaesse`, Lieferanten), Fussnoten mit Zählregeln, Budget-Jahr-Hinweis, EUR-/ohne-Betrag-Hinweise. Name in "Wo Rechnungen liegen" verlinkt auf `/admin/vorgaenge?person=<id>` nur wenn der Betrachter `vorgaenge_einsehen` hat.
- `konto`-Filter wird mit `zugangFuer().kontoIds` geschnitten; fremdes Konto → 403 "Für dieses Konto hast du keine Auswertung."
- `GET /auswertung/export/:abschnitt.csv` mit `abschnitt ∈ budget|durchlauf|engpaesse|lieferanten` und denselben Filtern; `engpaesse` nur bei Zugang; Spalten = sichtbare Tabellenspalten.

- [ ] **Step 1: Failing tests:** Zugang (Recht 200 alle Abschnitte; F1 200 nur eigene Konten ohne Engpässe; Nicht-Berechtigter 403); `fremdes Konto per Filter → 403`; `Zahlen in der Seite stimmen mit Service`; `ungültiger Zeitraum → Meldung, Default angezeigt`; `CSV-Export: BOM, Semikolon, Dateiname, nur sichtbare Abschnitte`; `Link auf Vorgänge nur mit vorgaenge_einsehen`; Navigation nur für Berechtigte; Sweeps grün.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(auswertung): Seite Auswertung mit Export`.

### Task 5: Budget-Import (optional)

**Files:**
- Modify: `package.json` (+ `read-excel-file`, exakte Version), `src/routes/admin/budgets.js`, `views/admin/budgets.ejs`
- Create: `src/services/budgetImport.js`
- Test: `test/unit/budgetImport.test.js`, `test/integration/admin/budgets.test.js`

**Interfaces:**
- Produces: `async leseTabelle(buffer, dateiname) → string[][]` (CSV mit `;` oder `,` automatisch erkannt, UTF-8 mit/ohne BOM; `.xlsx` über `read-excel-file/node`, erstes Blatt; andere Endung → Fehler), `ordneZu(zeilen, { spalteKonto: number, spalteBetrag: number, hatKopfzeile: boolean }, konten) → { gueltig: Array<{ kontoId, kontonummer, betrag, bisher: number|null }>, fehler: Array<{ zeile: number, grund: string }> }`.
- Ablauf: `POST /admin/budgets/import` (multipart, max. 2 MB, CSRF) → Vorschau mit Spaltenauswahl (Default: erste Spalte Konto, zweite Betrag, Kopfzeile erkannt wenn Betragszelle der ersten Zeile keine Zahl ist), gültige Zeilen und Fehlerzeilen; `POST /admin/budgets/import/bestaetigen` speichert nur die gültigen Zeilen für das gewählte Jahr. Die Vorschau-Daten werden in der Session (nicht im Formular) gehalten, max. 15 min.

- [ ] **Step 1: Failing tests:** `CSV mit Semikolon und BOM`, `CSV mit Komma`, `XLSX-Datei` (kleine Fixture in `test/helpers`), `unbekannte Kontonummer und leere Zeile als Fehler`, `Betragsformate über parseBetrag`, `nichts gespeichert vor Bestätigung`, `Bestätigung speichert nur gültige Zeilen`, `falsche Endung → Meldung`, `zu gross → Meldung`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(auswertung): Budget-Import aus CSV und Excel`.

### Task 6: Dokumentation

**Files:**
- Create: `docs/auswertung.md` (Zweck, Zielgruppen, Zugriffsregeln, Zählregeln, Durchlaufzeit-Definition, Budget-Pflege und Import, Export)
- Modify: `docs/README.md`, `docs/auth-und-rechte.md` (zwei Rechte), `docs/admin-bereich.md` (Budgets, Schwelle), `docs/datenmodell.md` (`konto_budgets`), `docs/architektur.md` (Routen)

- [ ] **Step 1:** Doku schreiben; Routen, Rechte und Schlüssel per `grep` im Code prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Auswertung Rechnungen dokumentieren`.
