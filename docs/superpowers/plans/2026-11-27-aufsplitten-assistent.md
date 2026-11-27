# Aufsplitten-Assistent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aufsplitten als dreistufiger Assistent auf der Kontierungsseite neben dem Beleg, mit gleichmässig verteilten Versandkosten.

**Architecture:** Der bestehende `POST /kontierung/:id/aufsplitten` bleibt der einzige Absende-Weg und bekommt das Feld `versandkosten`. Das Aufsplitten-Formular wird ein Partial in der rechten Spalte von `views/kontierung.ejs` (beide Formulare im DOM, eines sichtbar); ein externes Skript macht daraus Schritte. Die eigene Seite und das Popup entfallen.

**Tech Stack:** Node ≥ 22, Express, EJS, Bootstrap 5, node:test + supertest, Playwright (Verhalten/Responsive).

**Spec:** [docs/superpowers/specs/2026-11-27-aufsplitten-assistent-design.md](../specs/2026-11-27-aufsplitten-assistent-design.md)

## Global Constraints

- Keine Datenbank-Migration, keine neuen Abhängigkeiten oder Umgebungsvariablen, keine Änderung an n8n-Schnittstellen.
- Unverändert: Rechte, Konfliktbehandlung, IBAN-Prüfung, Prüf-Popup, Mails, Splitgruppen-Export, Kreditkarten-Abgleich.
- Feldnamen des POST bleiben (`gesamtbetrag`, `teilKontoId`, `teilBetrag`, `teilPosition`, `teilInteressenskonflikt`, `teilBeleg_<i>`, `kreditorId`, `begruendung`, `typ`, …); neu nur `versandkosten`.
- CSP: kein Inline-Handler; Skripte extern oder mit `nonce`. Jedes Formular mit `_csrf`.
- IDs auf der Seite sind eindeutig: IDs des Assistenten beginnen mit `split-` (Ausnahmen: `aufsplitten-form`, `gesamtbetrag`, `versandkosten`, `teile-container`, `zeile-hinzufuegen`). Die `kontierung-*.js` wirken je Formular, nie über `document`.
- Oberflächentexte Deutsch, Schweizer Schreibweise (kein ß). Beträge mit Punkt und zwei Stellen.
- Version bleibt 1.4.13 (noch nicht committet). **Nicht committen, nicht pushen** ohne Auftrag; im Arbeitsbaum liegen fremde Änderungen (`docs/testdrehbuch/belege/gen.mjs`).
- Volle Suite: `node --test --test-concurrency=2 'test/{unit,integration,sicherheit}/**/*.test.js'` (~7 min). Playwright: `LD_LIBRARY_PATH=/config/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu FONTCONFIG_FILE=/config/.cache/pw-libs/root/fonts.conf`.

## Review Focus

1. Rundung und Gleitkomma: `10.00` Versand auf 3 Teile → `3.33/3.33/3.34`; Teile `0.10 + 0.20` + Versand `0.00` = `0.30` wird angenommen (Task 1).
2. Leere Zeile zwischen zwei Teilen: zählt nicht für den Versandanteil, Belege bleiben der richtigen Zeile zugeordnet (Task 1).
3. Versandkosten `abc`, `-5`, `>= Gesamtbetrag`: 400, nichts angelegt; `10,50` wird angenommen (Task 1).
4. Enter-Taste in Schritt 1 oder 2: sendet nicht ab, sondern wirkt wie «Weiter» (Task 3).
5. Nach «Abbrechen» ist das Kontierungsformular samt Eingaben, Pflichtprüfung und IBAN-Kasten unverändert benutzbar (Task 3).

---

### Task 1: Versandkosten auf dem Server

**Files:**
- Modify: `src/services/aufsplitten.js`, `src/routes/kontierung.js` (POST `/:id/aufsplitten`, ab ca. Zeile 1036)
- Test: `test/unit/aufsplitten.test.js`, `test/integration/kontierung.test.js`

**Interfaces:**
- Produces: `verteileVersandkosten(versandRappen: number, anzahl: number): number[]` und `positionMitVersand(position: string|null, anteilRappen: number): string|null` (exportiert aus `services/aufsplitten.js`).

- [ ] **Step 1: Unit-Tests schreiben**

```js
assert.deepEqual(verteileVersandkosten(1000, 3), [333, 333, 334]);
assert.deepEqual(verteileVersandkosten(2, 3), [0, 0, 2]);
assert.deepEqual(verteileVersandkosten(0, 2), [0, 0]);
assert.equal(positionMitVersand('Pos. 2', 335), 'Pos. 2 (inkl. Versand 3.35)');
assert.equal(positionMitVersand(null, 335), 'inkl. Versand 3.35');
assert.equal(positionMitVersand('Pos. 2', 0), 'Pos. 2');
assert.equal(positionMitVersand(null, 0), null);
```

- [ ] **Step 2: Integrationstests schreiben** (Seeds wie die bestehenden Aufsplitten-Tests, `splitLieferant(db)`)
  - `versandkosten wird gleichmässig auf die Teile verteilt`: gesamt `210.00`, versand `10,00`, Teile `120.00`/`80.00`, erste mit Position `Pos. 1` → Kinder `betrag` `125.00`/`85.00`, `rechnungsposition` `Pos. 1 (inkl. Versand 5.00)`/`inkl. Versand 5.00`; Elternjob `210.00`.
  - `Rundungsrest geht an den letzten Teil, leere Zeile zählt nicht`: gesamt `40.00`, versand `10.00`, Zeilen `10.00`, leer, `10.00`, `10.00` → `13.33`, `13.33`, `13.34`.
  - `Gleitkomma`: gesamt `0.30`, ohne Versand, Teile `0.10`/`0.20` → 302.
  - `ungültige Versandkosten`: für `abc`, `-5`, `210.00` (= gesamt) → 400, keine Kinder, Elternstatus unverändert.
  - `Summe ohne Versand passt nicht`: gesamt `210.00`, versand `10.00`, Teile `130.00`/`80.00` → 400, Text enthält `Gesamtbetrag abzüglich Versandkosten (200.00)`.

- [ ] **Step 3: Rot prüfen** — `node --test test/unit/aufsplitten.test.js test/integration/kontierung.test.js` → neue Tests FAIL.

- [ ] **Step 4: Implementieren**
  - Helfer in `aufsplitten.js`: Anteil `Math.floor(v / n)`, Rest an den letzten.
  - Route: `versandkosten` per `text(…, 'Versandkosten', MAX_LAENGE.betrag)`; leer = 0, sonst `BETRAG_PATTERN`, sonst Fehler `Bitte gültige Versandkosten erfassen (z.B. 9.50).`; `>= Gesamtbetrag` → `Die Versandkosten müssen kleiner als der Gesamtbetrag sein.`
  - Summenprüfung in ganzen Rappen: Teile = gesamt − versand. Fehlertext bei Versand > 0: `Die Summe der Teilbeträge (X) muss dem Gesamtbetrag abzüglich Versandkosten (Y) entsprechen.`; ohne Versand bleibt der bisherige Text.
  - Erst nach allen Prüfungen und nach dem Prüf-Popup, vor `bereiteTeilDateienVor`: je Teil `betrag` = (netto + Anteil) als `toFixed(2)`, `position` = `positionMitVersand(…)`. `teileEingabe` (Re-Render) behält die Nettowerte. Befunde prüfen weiter den Gesamtbetrag.
  - `renderAufsplittenForm` bekommt `versandkosten` in `extra` und reicht es an die View.

- [ ] **Step 5: Grün prüfen** — gleicher Befehl, alles PASS.

---

### Task 2: Formular auf die Kontierungsseite

**Files:**
- Create: `views/_aufsplitten_assistent.ejs`, `public/js/aufsplitten-assistent.js`
- Delete: `views/kontierung-aufsplitten.ejs`
- Modify: `src/routes/kontierung.js`, `views/kontierung.ejs`, `views/_ki_bestaetigen.ejs`, `public/js/kontierung-{iban,konto-filter,ki,pflicht}.js`, `public/css/portal.css`
- Test: `test/integration/{kontierung,belegUmschalter,layoutSweep,belegNummer}.test.js`, `test/unit/responsiveSeitenliste.test.js`, `test/responsive/seiten.js`

**Interfaces:**
- Consumes: Task 1 (`versandkosten`).
- Produces: View-Local `split` = `{ offen: boolean, schritt: 1|2|3, gesamtbetrag, versandkosten, teile, begruendung, typ, errors, kiHinweise, rechnungsangaben, values: { kreditorId, ibanEndung, pruefBemerkung }, lieferantFehler, ibanKasten, ibanKastenSichtbar, auffaelligkeiten }`, immer gesetzt, wenn `views/kontierung.ejs` gerendert wird.
- Produces (DOM): `#aufsplitten-bereich[data-start-schritt]`, `#kontierung-bereich`, Öffner `[data-aufsplitten-oeffnen]` (Link auf `?aufsplitten=1`), `[data-aufsplitten-abbrechen]` (Link auf `/kontierung/:id`), `section[data-schritt="1|2|3"]`, `<template id="split-zeile-vorlage">`, `.teil-zeile` wie bisher. Der ausgeblendete Bereich trägt `d-none`.
- `_ki_bestaetigen` bekommt optional `praefix` (ID `<praefix>bestaetigt-<feld>`).

- [ ] **Step 1: Tests umschreiben/ergänzen**
  - `GET /kontierung/:id/aufsplitten leitet auf die Kontierung mit offenem Assistenten` → 302, `Location` `/kontierung/<id>?aufsplitten=1`. 403/409 wie bisher (zugriffSweep, kkMarkierung bleiben unverändert grün).
  - `GET /kontierung/:id enthält Beleg, Kontierungsformular und ausgeblendeten Assistenten`: `id="kontierung-preview-frame"`, `id="aufsplitten-form"`, kein `aufsplitten-modal`; mit `?aufsplitten=1` trägt `#kontierung-bereich` `d-none`.
  - `jede id auf der Kontierungsseite ist eindeutig` (alle ` id="…"` ausserhalb `<template>` sammeln, keine Doppel), einmal mit KI-Feldern und ohne QR.
  - Fehler-Rerender: ungültiger Gesamtbetrag → 400, Seite enthält Fehlertext, `data-start-schritt="1"`, eingegebene Teile und `versandkosten`; falsche Summe → `data-start-schritt="2"`; Prüf-Popup → 200, `data-start-schritt="3"`, `form="aufsplitten-form"`.
  - Die bisherigen GET-Tests zu Vorbelegung/Typ/Kontenliste auf `GET /kontierung/:id` umstellen; Tests zu Query-Vorbelegung (`?betrag=`, `?typ=`) entfallen (übernimmt Task 3 im Browser). Gesamtbetrag-Vorbelegung bleibt: `job.betrag || qr_betrag || betrag_vorschlag`.
  - Seitenlisten: View `kontierung-aufsplitten` entfernen; in `seiten.js` die zwei Einträge «Aufsplitten»/«Aufsplitten im Modal» durch `{ name: 'Aufsplitten', view: 'kontierung', pfad: '/kontierung/{anna}?aufsplitten=1', als: 'test-1', pdf: true }` ersetzen; `belegUmschalter`/`layoutSweep` auf die neue URL.

- [ ] **Step 2: Rot prüfen** — die geänderten Testdateien → FAIL.

- [ ] **Step 3: Server** — die Locals des `GET /:id` in `kontierungLocals(req, job)` ziehen; `renderAufsplittenForm` (Signatur bleibt, plus `extra.schritt`) rendert damit `kontierung` mit `split.offen = true`, `errors: []`. Startschritt: 1, wenn ein Fehler aus Gesamtbetrag, Versandkosten, Lieferant, IBAN-Endung, Zahlungsziel oder KI-Bestätigung stammt; sonst 2; Prüf-Popup und PDF-503: 3. `GET /:id/aufsplitten` prüft wie bisher und leitet weiter. Auch der Rapport-Rerender und der Kontierungs-Rerender bekommen ein geschlossenes `split`.

- [ ] **Step 4: Views und Skripte** — Inhalt der alten View ins Partial, in der Reihenfolge Schritt 1 (Typ, Lieferant, Gesamtbetrag, Versandkosten mit Hinweis «Wird gleichmässig auf alle Teile verteilt.», Rechnungsnummer/Zahlungsziel, IBAN-Kasten), Schritt 2 (Teile untereinander, Teilbetrag beschriftet «Teilbetrag ohne Versand», Begründung), Schritt 3 (`<div id="split-zusammenfassung">`, Knopf «Aufsplitten»). Ohne JS stehen alle Schritte untereinander. Zeilen-Logik (hinzufügen, entfernen, Konflikt-Hidden, `teilBeleg_<i>`) aus dem Inline-Skript nach `aufsplitten-assistent.js`. Pflicht-Banner je Formular (`data-pflicht-banner="<formId>"`), `kontierung-pflicht.js` bedient alle `form[data-pflicht-pruefung]`. Das Rapport-Skript blendet `[data-aufsplitten-oeffnen]` aus. Modal samt iframe-Skript löschen.

- [ ] **Step 5: Grün prüfen** — volle Suite → 0 fail.

---

### Task 3: Assistent im Browser

**Files:**
- Modify: `public/js/aufsplitten-assistent.js`, `public/js/kontierung-pflicht.js`, `views/_aufsplitten_assistent.ejs`, `public/css/portal.css`
- Test: Create `test/unit/aufsplittenAssistent.test.js` (Lademuster wie `test/unit/kontierungPflicht.test.js`); Rewrite `test/verhalten/aufsplitten.test.js`

**Interfaces:**
- Consumes: DOM aus Task 2.
- Produces: `rappen(text: string): number|null`, `verteile(versandRappen: number, anzahl: number): number[]` (gleiche Regel wie Task 1), `stand(gesamt: string, versand: string, teile: string[]): { ziel, verteilt, offen }` in Rappen oder `null` bei ungültigem Gesamtbetrag.
- `kontierung-pflicht.js` löst vor dem Fokussieren eines Banner-Links `pflicht:zeige` (bubbles) auf dem Zielfeld aus.

- [ ] **Step 1: Unit-Tests** — `rappen('10,5') === 1050`, `rappen('abc') === null`, `rappen('-1') === null`; `verteile(1000, 3)` → `[333,333,334]`; `stand('210.00','10.00',['120.00',''])` → `{ ziel: 20000, verteilt: 12000, offen: 8000 }`.

- [ ] **Step 2: Verhaltenstests**
  - `Assistent öffnet neben dem Beleg und übernimmt die Werte`: Lieferant und Betrag in der Kontierung setzen → `[data-aufsplitten-oeffnen]` → `#kontierung-preview-frame` sichtbar, nur Schritt 1 sichtbar, `#split-kreditorId` und `#gesamtbetrag` übernommen.
  - `Weiter erst mit gültigen Angaben`: leerer Gesamtbetrag → bleibt in Schritt 1 mit Banner; Schritt 2 mit offenem Rest → bleibt, `#split-stand` zeigt `offen 80.00`.
  - `Zusammenfassung zeigt Versandanteile`: 210.00 / 10.00 / 120.00 + 80.00 → Schritt 3 enthält `125.00` und `85.00`; «Zurück» erhält die Eingaben; «Aufsplitten» landet auf `/pool`.
  - `Enter sendet nicht ab` (Schritt 1 → Schritt 2, URL unverändert).
  - `Abbrechen`: Kontierungsformular sichtbar, vorher getippte Rechnungsnummer noch da, Kontieren mit leerem Konto zeigt dessen Pflicht-Banner.

- [ ] **Step 3: Rot prüfen** — `node --test test/unit/aufsplittenAssistent.test.js`; `npm run test:verhalten` → FAIL.

- [ ] **Step 4: Implementieren**
  - Öffnen/Abbrechen ohne Neuladen (`preventDefault`), Fokus auf die Überschrift. Nur beim **ersten** Öffnen übernehmen: Typ, Betrag, Lieferant (fehlende Option, z. B. neu angelegter Lieferant, mitkopieren), Rechnungsnummer, Zahlungsziel, KI-Haken; danach `change`/`input` auslösen.
  - Kopfzeile «Schritt n von 3» mit «Zurück»/«Weiter». «Weiter» prüft die sichtbaren Felder mit `checkValidity()` (Banner kommt über die `invalid`-Ereignisse) plus KI-Haken (Schritt 1) bzw. mindestens 2 Teile mit Konto und Betrag, `offen === 0`, Begründung bei Konflikt (Schritt 2); Meldungen im Banner.
  - `#split-stand` (`aria-live="polite"`): `Verteilt X von Y – offen Z`; bei negativem Rest `– Z zu viel`.
  - Zusammenfassung je Teil: Konto, Teilbetrag, Versandanteil, Total, Konflikt-Kennzeichen, Belegdateiname; Schlusszeile Summe = Gesamtbetrag. Nur per `textContent` bauen. Leere Zeilen zählen nicht.
  - Start auf `data-start-schritt`; `pflicht:zeige` wechselt auf den Schritt des Feldes.

- [ ] **Step 5: Grün prüfen** — beide Befehle PASS; `npm run test:responsive -- --seite=Aufsplitten` ohne Verstösse an Elementen des Assistenten (bekannte <44-px-Verstösse der Kopfzeile/Seitenleiste bestanden vorher). Screenshots der drei Schritte (1280 px, hell und dunkel) ansehen.

---

### Task 4: Doku und Release-Angaben

**Files:**
- Modify: `docs/rechnungs-workflow.md` (Abschnitt 5, Zeile ~158 und ~420), `CHANGELOG.md`, `docs/releases/v1.4.13.md`, `docs/anleitung/build.py` (ab Zeile 208), `docs/anleitung/aufnahmen/aufnahmen.mjs` (Kapitel `aufsplitten`)

- [ ] **Step 1:** Workflow-Doku: Assistent, drei Schritte, Versandkosten-Regel, GET leitet weiter.
- [ ] **Step 2:** Changelog/Release Notes unter 1.4.13: «Aufsplitten als Assistent neben dem Beleg» und «Feld Versandkosten»; Nachweis mit den tatsächlichen Testzahlen.
- [ ] **Step 3:** Anleitungstext (Schritte, Beispiel mit Versand) und Aufnahme-Skript auf die neuen Selektoren (`?aufsplitten=1`, `#split-kreditorId`, «Weiter»). PDF nicht neu bauen.
- [ ] **Step 4:** Volle Suite und `npm run test:verhalten` → 0 fail; `git status` zeigt nur erwartete Dateien.
