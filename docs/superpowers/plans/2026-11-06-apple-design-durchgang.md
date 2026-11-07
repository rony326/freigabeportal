# Apple-Design-Durchgang — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die 14 Vorschläge aus der Apple-Design-Durchsicht umsetzen: sofortige Rückmeldung, Fehler am Feld, Rückfrage beim Ablehnen, klarere Hierarchie, einheitliche Begriffe/Symbole, ruhiger visueller Feinschliff.

**Architecture:** Ein gemeinsames Verhaltensmodul in `public/js/portal.js` (`window.Portal`: Sendestatus, Bestätigungsdialog, Meldung am Ort) und ein serverseitiger Fehlersammler (`src/utils/feldFehler.js`) tragen die Punkte 1–4. Die übrigen Punkte sind Änderungen an EJS-Partials, `portal.css`, `_brand_styles.ejs` und `navigation.js`. Browserverhalten wird mit einer neuen Playwright-Suite `npm run test:verhalten` geprüft (wie `test:responsive` nicht Teil von `npm test`), Markup mit den bestehenden supertest-/fetch-Integrationstests.

**Tech Stack:** Node.js ESM, Express 4, EJS, Bootstrap 5.3 (vendor), `node:test`, supertest, Playwright (bereits exakt gepinnt, Chromium im Cache), Bootstrap Icons 1.13.2 (neu, nur als Sprite-Quelle).

**Spec:** `docs/superpowers/specs/2026-11-06-apple-design-durchgang-design.md`

## Global Constraints

- Arbeit im Worktree `/config/workspace/freigabeportal-apple-design`, Branch `feature/apple-design-durchgang` (von `master` 18bb8f7). Das Haupt-Arbeitsverzeichnis hat fremde, uncommittete Änderungen — dort nichts anfassen.
- Kein Build-Schritt, kein Sass, kein Framework. Alle Skripte funktionieren ohne JS-Fehler auch dann, wenn ein Element auf der Seite fehlt. Ohne JavaScript bleibt jede Aktion benutzbar (Progressive Enhancement: heutige Formulare/Submits bleiben die Grundlage).
- Jede Bewegung hat einen `@media (prefers-reduced-motion: reduce)`-Fallback ohne Bewegung (höchstens Opazität ≤ 200 ms). Keine Federn, keine Gesten.
- Sichtbare Texte Deutsch (Schweiz): "ss" statt "ß", echte Umlaute. Begriff im Portal: "Lieferant"; Admin-Bereich bleibt "Kreditoren".
- Gespeicherte Bezeichner (DB-Werte, Audit-Aktionen, Formularfeld-Namen wie `zahlungsdaten_bestaetigt`, Werte wie `nicht_geprueft`) bleiben unverändert.
- CSRF: jedes neue POST-Formular trägt `_csrf` (`test/integration/csrfSweep.test.js` muss grün bleiben); fetch-POSTs senden `X-CSRF-Token`.
- Touch-Ziele ≥ 44 px und die übrigen Regeln aus `npm run test:responsive` bleiben erfüllt (Lauf am Ende grün).
- `npm test` grün (Stand master: 2349 Tests). Hinweis: unter Last fallen gelegentlich einzelne Tests zufällig aus — bei rotem Lauf einmal wiederholen, bevor man sucht.
- Neue statische Dateien, die sich ändern können (`public/js/*.js`, Sprite), hängen am Versions-Parameter: `app.locals.assetVersion` in `src/app.js` um die Dateien erweitern und in den Views `?v=<%= locals.assetVersion || 0 %>` anhängen.
- Doku nachziehen, wo Bedienung beschrieben ist (`docs/rechnungs-workflow.md`, `docs/admin-bereich.md`, README falls betroffen).

## Review Focus

1. Formular, das eine Datei herunterlädt oder `target` hat (Backup-Download, Audit-Export), bleibt nach dem Klick nicht gesperrt → kein Sendestatus dort, und Sicherheitsfreigabe nach 15 s (Task 1 Test `sendestatus: Download-Formular bleibt bedienbar`).
2. Zurück-Taste nach dem Senden (bfcache) → Knopf ist wieder normal bedienbar (Task 1 Test `sendestatus: pageshow persisted setzt zurück`).
3. Ablehnen-Dialog abbrechen → nichts wird gesendet, eingetippte Begründung bleibt im Formular stehen (Task 3 Test).
4. Kontierung ablehnen mit leeren Pflichtfeldern → Ablehnen geht trotzdem durch (bestehende `required`-Entfernung muss auch auf dem Dialogweg greifen) (Task 3 Test).
5. Farbmodus "System" bei Admin-Standard "dunkel" und hellem Betriebssystem → Seite hell, ohne Aufblitzen (Task 10 Test).

---

### Task 1: Sendestatus für Formulare und fetch-Knöpfe (+ Verhaltens-Suite)

**Files:**
- Modify: `package.json` (Script `"test:verhalten": "node --test --test-concurrency=1 'test/verhalten/*.test.js'"`)
- Create: `test/verhalten/helfer.js`, `test/verhalten/sendestatus.test.js`
- Modify: `public/js/portal.js`, `public/css/portal.css`, `views/pool.ejs`, `views/kontierung.ejs` (Lieferant anlegen), Download-Formulare (siehe Step 3)

**Interfaces:**
- Produces `test/verhalten/helfer.js`: `async function oeffneSeite(pfad, { als = 'test-4', breite = 1280 } = {}) → { page, server, schliessen() }` — startet `starteResponsiveServer()` (eine Instanz je Testdatei, `before`/`after`), Chromium headless, Person über `?als=`.
- Produces `window.Portal.beschaeftigt(knopf: HTMLElement, arbeit: Promise) → Promise` — setzt `aria-busy="true"`, Klasse `wird-gesendet`, hängt `<span class="spinner-border spinner-border-sm ms-1" aria-hidden="true">` an, entfernt beides, wenn `arbeit` fertig ist (Erfolg oder Fehler), gibt das Ergebnis von `arbeit` weiter.
- Produces Formular-Verhalten: `submit`-Listener (Capture, `document`) für `form[method=post]` ohne `target` und ohne `data-kein-sendestatus`: erster Submit markiert `e.submitter` (oder ersten Submit-Knopf) wie oben; jeder weitere Submit dieses Formulars → `preventDefault()`. Knopf **nicht** `disabled` setzen (sonst fehlt `name=aktion` im Formular). Freigabe nach 15 s; `pageshow` mit `persisted` setzt alle zurück.
- CSS: `.wird-gesendet { pointer-events: none; opacity: .75; }`.

- [ ] **Step 1: Failing tests** in `sendestatus.test.js`:
  - `sendestatus: zweiter Klick auf Kontieren sendet nicht` — Kontierung `ids.anna` als `test-1`, Requests auf `POST /kontierung/<id>` zählen (`page.on('request')`), Knopf zweimal schnell klicken (Server-Antwort per `page.route` um 1 s verzögern) → genau 1 Request; Knopf hat `aria-busy="true"` und `.spinner-border`.
  - `sendestatus: name/value des Knopfs wird mitgesendet` — Request-Body enthält `aktion=kontieren`.
  - `sendestatus: pageshow persisted setzt zurück` — nach Markierung `window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))` → kein `aria-busy`, keine `.wird-gesendet`.
  - `sendestatus: Download-Formular bleibt bedienbar` — Formular mit `data-kein-sendestatus` (per `page.evaluate` eingefügt) → nach Submit keine Markierung.
  - `sendestatus: Beanspruchen zeigt Spinner` — Pool als `test-4`, `/api/pool/*/beanspruchen` per `page.route` 1 s verzögern → `.beanspruchen-btn[aria-busy=true]` sichtbar.
- [ ] **Step 2:** `npm run test:verhalten` → FAIL (keine Markierung).
- [ ] **Step 3:** Implementieren in `portal.js`; Beanspruchen, Zuweisen (`pool.ejs`) und "Anlegen" (Lieferant, `kontierung.ejs`) laufen über `Portal.beschaeftigt`. Download-POSTs finden (`grep -rn "res.download\|attachment" src/routes`) und deren Formulare mit `data-kein-sendestatus` versehen.
- [ ] **Step 4:** `npm run test:verhalten` → PASS; `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Sendestatus für Formulare und Knöpfe`.

### Task 2: Fehler am Feld (Kontierung, Freigabe 2, Spesen-Freigabe 1)

**Files:**
- Create: `src/utils/feldFehler.js`, `views/_fehler_liste.ejs`, `test/unit/feldFehler.test.js`
- Modify: `src/app.js` (Helper in `app.locals`), `src/routes/kontierung.js` (Kontierungs-POST ab Zeile ~274), `src/routes/freigabe2.js`, `src/routes/spesenFreigabe1.js`, `views/kontierung.ejs`, `views/freigabe2.ejs`, `views/spesen-freigabe1.ejs`
- Test: `test/integration/kontierung.test.js`, `test/integration/freigabe2.test.js`, `test/integration/spesenFreigabe1.test.js`, `test/verhalten/begruendung.test.js`

**Interfaces:**
- Produces `neueFehler() → { add(feld: string|null, text: string): void, liste: string[], proFeld: Record<string, string> }` (`liste`/`proFeld` als Getter; `feld` = **id des Eingabeelements**, `null` = Fehler ohne Feld; pro Feld zählt der erste Text).
- Routen rendern weiterhin `errors: string[]` (bestehende Tests prüfen die Texte) und zusätzlich `feldFehler: Record<string,string>`. Feld-ids: Kontierung `kontoId`, `absender`, `kreditorId`, `rechnungsnummer`, `begruendung`, `betrag`, `zahlungsziel`; Freigabe 2 `f2begruendung`, `zahlungsdatenBestaetigt`, `zahlungshinweiseBestaetigt`; Spesen-Freigabe 1 `sf1begruendung`.
- Produces `app.locals.feldFehlerAttr(feldFehler, id) → string` — `' aria-invalid="true" aria-describedby="<id>-fehler"'` oder `''` (mit `<%-` ausgeben). Feld bekommt zusätzlich Klasse `is-invalid`, darunter `<div class="invalid-feedback d-block" id="<id>-fehler">Text</div>`.
- Produces `_fehler_liste.ejs` `{ errors, feldFehler }`: `alert-danger` mit Überschrift "Bitte korrigieren:", jeder Text, der in `feldFehler` vorkommt, als `<a href="#<id>" class="alert-link">`, sonst als Text. Ersetzt die drei bisherigen Fehlerblöcke.
- Kontierung `enhance()` (searchable select): `aria-invalid`/`aria-describedby` vom `<select>` auf das sichtbare Combobox-Feld übernehmen (Klasse kommt schon über `className`).

- [ ] **Step 1: Failing tests:**
  - Unit `feldFehler.test.js`: `add('betrag','A'); add('betrag','B'); add(null,'C')` → `liste` = `['A','B','C']`, `proFeld` = `{ betrag: 'A' }`.
  - Integration `kontierung: Fehler stehen am Feld` — POST ohne Betrag → HTML matcht `/id="betrag"[^>]*is-invalid|is-invalid[^>]*id="betrag"/`, enthält `id="betrag-fehler"` mit "Bitte einen Betrag angeben." und `href="#betrag"`.
  - Integration `freigabe2: Begründung bei Konflikt am Feld` — Konflikt ja, leere Begründung → `f2begruendung` mit `is-invalid` und `f2begruendung-fehler`.
  - Integration `spesenFreigabe1: Begründung bei Ablehnung am Feld` analog `sf1begruendung`.
  - Verhalten `begruendung.test.js`: `Begründung wird bei Interessenskonflikt Pflicht` — Kontierung: "Interessenskonflikt" anklicken → `#begruendung` hat `required`, Label enthält "(Pflicht)"; zurück auf "Kein Interessenskonflikt" → nicht `required`, Label-Zusatz "(bei Ablehnung Pflicht)". Gleich auf Freigabe 2.
- [ ] **Step 2:** Tests ausführen → FAIL.
- [ ] **Step 3:** Implementieren. Label-Zusatz als `<span class="text-muted" data-begruendung-hinweis>`; das Umschalten im Inline-Skript der jeweiligen Seite (wie `aktualisiereTypUi` in `kontierung.ejs`), läuft auch einmal beim Laden.
- [ ] **Step 4:** `npm test` und `npm run test:verhalten` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Fehlermeldungen am Feld, Begründung nur bei Konflikt Pflicht`.

### Task 3: Ablehnen mit Rückfrage, "In den Pool legen" einheitlich

**Files:**
- Create: `views/_ablehnen_dialog.ejs`, `views/_zurueck_in_pool_dialog.ejs`, `test/verhalten/ablehnen.test.js`
- Modify: `views/kontierung.ejs`, `views/freigabe2.ejs`, `views/spesen-freigabe1.ejs`, `views/_job_aktionen.ejs`, `views/pool.ejs`, `src/routes/poolPage.js` (`alleKonten: listKonten(db)` nur wenn `meineKontierungen.length > 0`)
- Test: `test/integration/poolPage.test.js`

**Interfaces:**
- Produces `_ablehnen_dialog.ejs` `{ formId, begruendungId }`: Modal `#ablehnen-dialog`, Textarea `#ablehnen-dialog-begruendung` (required), Knöpfe "Abbrechen" (`btn-outline-secondary`) und "Ablehnen" (`btn-danger`). Ablauf: Der vorhandene Ablehnen-Knopf bleibt `type=submit name=aktion value=ablehnen` (ohne JS direkt). Das Skript im Partial fängt seinen `click` ab (`preventDefault`), öffnet den Dialog mit der Begründung aus `#<begruendungId>` vorbefüllt; Bestätigen schreibt den Text zurück und ruft `form.requestSubmit(ablehnenKnopf)`. Leere Begründung → Dialog bleibt offen, Feld `is-invalid`. Abbrechen schreibt den Dialogtext ebenfalls zurück.
- Kontierung: Der Code, der `required` der Pflichtfelder entfernt, muss vor `requestSubmit` laufen — als Funktion `entferneKontierungsPflicht()` herauslösen und von beiden Wegen aufrufen.
- Produces `_zurueck_in_pool_dialog.ejs` `{ alleKonten }`: der heutige Modal-Inhalt aus `kontierung.ejs` (Hinweis-Konto, Formular `POST /kontierung/:id/zurueck-in-pool`). Auf der Pool-Seite setzt ein Knopf `data-zurueck-in-pool="<jobId>"` die `action` des Formulars und öffnet den Dialog; `kontierung.ejs` nutzt dasselbe Partial.

- [ ] **Step 1: Failing tests** (`ablehnen.test.js`):
  - `Ablehnen öffnet Rückfrage, Abbrechen sendet nichts` — Freigabe 2 als `test-2`: Begründung "Test", Ablehnen klicken → Dialog sichtbar, Textarea = "Test"; Abbrechen → kein POST, `#f2begruendung` = "Test".
  - `Ablehnen bestätigen sendet aktion=ablehnen mit Begründung` — POST-Body enthält `aktion=ablehnen` und `begruendung=Grund`.
  - `Kontierung ablehnen mit leeren Pflichtfeldern geht durch` — Kontierung `ids.anna` als `test-1`, alle Felder leer, Ablehnen + Begründung bestätigen → Navigation weg von `/kontierung/<id>` (kein Browser-Validierungsstopp).
  - `Pool: In den Pool legen fragt Hinweis-Konto` — Pool als `test-1` (hat Kontierungen): Knopf öffnet Dialog mit `#hinweisKontoId`, Formular-`action` endet auf `/kontierung/<id>/zurueck-in-pool`.
  - Integration `poolPage: In-den-Pool-Knopf ohne JS bleibt Formular` — HTML enthält weiterhin ein `<form method="post" action="/kontierung/<id>/zurueck-in-pool">` mit `_csrf` (Grundlage ohne JS).
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test`, `npm run test:verhalten` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Rückfrage beim Ablehnen, einheitlicher Pool-Dialog`.

### Task 4: Browser-Popups ersetzen, Zuweisen ohne Neuladen

**Files:**
- Create: `views/_bestaetigen_dialog.ejs`, `test/verhalten/popups.test.js`
- Modify: `views/_seite_ende.ejs` (Dialog einbinden, auch bei `rahmen: 'ohne'`), `public/js/portal.js`, `public/js/belegUmschalter.js`, `views/pool.ejs`, `views/_kommentare.ejs`, `views/admin/backup.ejs`, `views/admin/zeitstempel-form.ejs`

**Interfaces:**
- Produces `window.Portal.bestaetigen({ titel: string, text: string, knopf: string, gefahr?: boolean }) → Promise<boolean>` — nutzt `#bestaetigen-dialog` (Bootstrap-Modal), Bestätigungsknopf `btn-danger` bei `gefahr`, sonst `btn-primary`; Escape/Abbrechen → `false`.
- Produces `form[data-bestaetigen="<Text>"]` (optional `data-bestaetigen-knopf`, `data-bestaetigen-gefahr`): Submit wird angehalten, nach `true` per `requestSubmit(submitter)` erneut ausgelöst (ein Flag verhindert die Endlosschleife; Sendestatus aus Task 1 greift erst beim zweiten Durchgang).
- Produces `window.Portal.meldung(ziel: HTMLElement, text: string, art: 'erfolg'|'fehler') → HTMLElement` — fügt `<div class="small text-success|text-danger" role="status">` nach `ziel` ein (ersetzt eine vorherige Meldung dort).
- Zuweisen Erfolg: Container (`[data-job-container]`) wird ersetzt durch Zeile/Kachel mit "An <Optionstext> gesendet ✓" (gleiche Technik wie heute beim Beanspruchen-Fehler); Fehler → `Portal.meldung(form, text, 'fehler')`. Kein `window.location.reload()` mehr.
- `belegUmschalter.js`: Fehler beim Auffrischen → `Portal.meldung(refreshBtn, 'Vorschau konnte nicht neu geladen werden.', 'fehler')`.
- Backup löschen: `data-bestaetigen="Backup wirklich löschen?" data-bestaetigen-knopf="Löschen" data-bestaetigen-gefahr`. Prüfnummer senden: `data-bestaetigen="Prüfnummer des letzten Pakets jetzt an die Revision senden?" data-bestaetigen-knopf="Senden"`. Kommentare: `await Portal.bestaetigen(...)` mit dem heutigen Text, Knopf "Trotzdem senden".

- [ ] **Step 1: Failing tests:**
  - Statischer Test in `test/unit/keineBrowserPopups.test.js`: kein `alert(`, `confirm(` oder `onsubmit="return confirm` in `views/**/*.ejs` und `public/js/*.js`.
  - Verhalten `Zuweisen ersetzt Zeile ohne Neuladen` — Pool als `test-4`: Person wählen, Senden → Text "gesendet ✓" sichtbar, `page.on('framenavigated')` feuert nicht.
  - Verhalten `Backup löschen fragt im Dialog` ist nicht prüfbar (Seite fehlt in der Test-Instanz) → stattdessen `data-bestaetigen-Formular` per `page.evaluate` einfügen: Abbrechen → kein Request; Bestätigen → genau 1 Request.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test`, `npm run test:verhalten` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Bestätigungsdialog statt Browser-Popups, Zuweisen ohne Neuladen`.

### Task 5: Kontierung — Aktionshierarchie

**Files:**
- Modify: `views/kontierung.ejs` (Knopfzeile ~Zeile 137–155, Zeile 10), `views/kontierung-aufsplitten.ejs` (Zeile 5)
- Test: `test/integration/kontierung.test.js`

**Interfaces:**
- Knopfzeile: "Kontieren" `btn btn-primary` (ohne `btn-sm`), "Ablehnen" `btn btn-outline-danger`, danach Bootstrap-Dropdown `Weitere Aktionen` (`btn btn-outline-secondary dropdown-toggle`) mit `dropdown-item`-Knöpfen: "Zurück in den Pool legen", "An Gruppe zurücksenden", "Rechnung aufsplitten" (öffnen die bestehenden Modals per `data-bs-toggle="modal"`), und — wenn Karten vorhanden und kein Splitkind — "Als Kreditkartenabrechnung übergeben …", das ein neues kleines Modal `#kk-abrechnung-modal` mit dem heutigen Karten-Formular öffnet.
- "Vorgangsnummer: <id> ·" entfällt (die Nummer steht im Titel); "Quelle: …" bleibt.

- [ ] **Step 1: Failing test** `kontierung: Nebenaktionen im Menü Weitere Aktionen` — HTML enthält `dropdown-toggle` mit "Weitere Aktionen", die Texte "Zurück in den Pool legen", "An Gruppe zurücksenden", "Rechnung aufsplitten" stehen innerhalb von `class="dropdown-menu`; `Vorgangsnummer:` kommt nicht vor; Karten-Formular `action="/kontierung/<id>/als-kk-abrechnung"` steht innerhalb `id="kk-abrechnung-modal"`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren; bestehende Tests, die "Vorgangsnummer" erwarten, auf den Titel umstellen.
- [ ] **Step 4:** `npm test` → PASS; `npm run test:responsive -- --seite=Kontierung` → keine neuen Verstösse.
- [ ] **Step 5:** Commit `feat(ui): Kontierung — Hauptaktion vorne, Nebenaktionen im Menü`.

### Task 6: Freigabe 2 — Entscheidungsblock

**Files:**
- Modify: `views/freigabe2.ejs`, `public/css/portal.css`
- Test: `test/integration/freigabe2.test.js`

**Interfaces:**
- Oben in der Karte `<div class="entscheidung">`: Betrag als `<div class="entscheidung-betrag">` (1.75rem, 600, `tabular-nums`; "—" ohne Betrag; Zusatz "Gutschrift" als Badge bei `job.typ === 'gutschrift'`), darunter Lieferant bzw. "Eingereicht von" (Spesen) und Konto.
- Übrige Angaben (Quelle, Absender, Rechnungsnummer, Zahlungsziel, Titel, Verwendungszweck, Auslage-Datum, Freigeber 1, Interessenskonflikt, Begründung) als `<dl class="kachel-angaben">` (vorhandene Klasse).
- Zahlungsdaten: `paymentReview.abgleich === 'abweichung'` → IBAN-Zeile in `<div class="alert alert-danger py-2">` statt Fliesstext.

- [ ] **Step 1: Failing tests:** `freigabe2: Betrag im Entscheidungsblock` (HTML enthält `class="entscheidung-betrag"` mit dem Betrag des Testjobs); `freigabe2: IBAN-Abweichung rot` (Fall aus `exportZahlungsintegritaet.test.js` mit Abweichung → `alert-danger` enthält "NICHT bei diesem Lieferanten hinterlegt").
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Freigabe 2 — Entscheidungsdaten oben`.

### Task 7: Aufgabenliste — Anzahl und Betrag

**Files:**
- Modify: `views/pool.ejs`, `views/_job_table.ejs`, `views/_job_kacheln.ejs`
- Test: `test/integration/poolPage.test.js`, `test/integration/kachelansicht.test.js` (Parität Tabelle/Kachel über `test/helpers/ansichtParitaet.js`)

**Interfaces:**
- Jede Abschnittsüberschrift: `Titel <span class="abschnitt-zahl">N</span>` (CSS: `fw-normal`, `--bs-secondary-color`, `tabular-nums`, `margin-left: .25rem`).
- Tabelle: Spalte "Betrag" nach "Konto", Zelle `class="text-end text-nowrap betrag"`, Inhalt `job.betrag || '—'`; Kopfzelle "Lieferant" statt "Kreditor". Kachel: `<dt>Betrag</dt><dd class="betrag">…</dd>` nach Konto.

- [ ] **Step 1: Failing tests:** `pool: Abschnitt zeigt Anzahl` (`Meine Freigaben <span class="abschnitt-zahl">1</span>` bei einem Freigabe-Job); `pool: Betrag in Tabelle und Kachel` (Betrag des Testjobs in beiden Ansichten, Paritätshelfer grün); `pool: Spalte heisst Lieferant` (`<th>Lieferant</th>`, kein `<th>Kreditor</th>`).
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Aufgabenliste mit Anzahl und Betrag`.

### Task 8: Begriffe und Schreibweise

**Files:**
- Create: `test/unit/schreibweise.test.js`
- Modify: alle Views mit "Schließen"/"ß", `views/freigabe2.ejs`, `src/services/paymentApproval.js`, `src/routes/freigabe2.js`, `src/routes/spesenFreigabe1.js` und weitere Fundstellen laut Step 3
- Test: `test/integration/exportZahlungsintegritaet.test.js:187` (Erwartung auf "für diesen Lieferanten")

**Interfaces:**
- `schreibweise.test.js` prüft (a) kein `ß` in `views/**/*.ejs`; (b) in `views/**/*.ejs` ausserhalb von `<% %>`-Blöcken und Attributwerten `name=`/`value=`/`id=` keines der Wörter `/\b(pruef\w*|geprueft|bestaetig\w*|geaendert|veraendert|waehrend|fuer|geklaert|\w*empfaenger|gueltig\w*|muessen)\b/i`; (c) dieselbe Liste in String-Literalen mit Leerzeichen in `src/services/paymentApproval.js`, `src/routes/freigabe2.js`, `src/routes/spesenFreigabe1.js`. Bezeichner ohne Leerzeichen (`'nicht_geprueft'`) sind ausgenommen.

- [ ] **Step 1:** Test schreiben → FAIL (listet Fundstellen).
- [ ] **Step 2:** Fundstellen korrigieren. Zusätzlich `grep -rnE "'[^'_]* [^'_]*(pruef|klaer|bestaet|aender|waehr|fuer|gueltig|muess)" src --include=*.js` durchgehen und nur Texte korrigieren, die Personen sehen (render/json/Mail-Text); Audit-Aktionsnamen und Kommentare nicht. Tests, die alte Schreibweise erwarten, mitziehen.
- [ ] **Step 3:** `npm test` → PASS.
- [ ] **Step 4:** Commit `fix(texte): einheitlich Schliessen, echte Umlaute, Lieferant`.

### Task 9: SVG-Symbole

**Files:**
- Modify: `package.json` (devDependency `"bootstrap-icons": "1.13.2"` exakt), `src/services/navigation.js`, `views/_seitenleiste.ejs`, `views/_seite_anfang.ejs` (☰, 🔄 kommt aus pool.ejs), `views/pool.ejs`, `views/_ansicht_umschalter.ejs`, `public/css/portal.css`, `src/app.js` (assetVersion)
- Create: `scripts/baueSymbole.js`, `public/vendor/bootstrap-icons/symbole.svg` (generiert, eingecheckt), `public/vendor/bootstrap-icons/LICENSE`, `views/_symbol.ejs`, `test/unit/symbole.test.js`

**Interfaces:**
- `navigation.js`: `symbol` wird ein Bootstrap-Icons-Name. Zuordnung — Portal: Aufgaben `inbox`, Spesen einreichen `plus-circle`, Meine Spesen `wallet2`, Abgeschlossene Rechnungen `check2-circle`, Kreditkartenbelege `credit-card`, Benachrichtigungen `bell`, Ferienmodus `sun`, Zeitstempel prüfen `patch-check`, Problem melden `bug`, Datenschutz `shield-lock`. Admin: Laufende Vorgänge `activity`, Abgelehnte Rechnungen `x-circle`, Altfälle `hourglass-split`, Konten `journal-text`, Kreditoren `building`, Kreditkarten `credit-card-2-front`, Personen `people`, Eskalationszeiten `alarm`, Mail-Einstellungen `envelope-at`, Erscheinungsbild `palette`, Module `grid-3x3-gap`, Zeitstempel `clock-history`, Ersteinrichtung `list-check`, Datenbank-Backup `database`, Datei-Quarantäne `shield-exclamation`, Mail-Protokoll `envelope-paper`, Sync-Übersicht `arrow-repeat`, Geplante Jobs `calendar-check`, Audit-Log `card-list`, Betrieb & Nutzung `speedometer2`, Testmodus `cone-striped`. Sonstige: Menü `list`, Farbmodus `circle-half`, Neu laden `arrow-clockwise`, Tabelle `table`, Kacheln `grid`. Fehlt ein Name in 1.13.2, bricht das Skript ab → nächstliegenden wählen und hier wie im Code eintragen.
- `scripts/baueSymbole.js`: liest die Namen aus `export const SYMBOLE` (neu in `navigation.js`: alle Namen inkl. "Sonstige"), baut aus `node_modules/bootstrap-icons/icons/<name>.svg` ein Sprite mit `<symbol id="<name>" viewBox="0 0 16 16">`, schreibt `public/vendor/bootstrap-icons/symbole.svg`. Aufruf `node scripts/baueSymbole.js`.
- `_symbol.ejs` `{ name }` → `<svg class="symbol" aria-hidden="true" focusable="false"><use href="/vendor/bootstrap-icons/symbole.svg?v=<%= locals.assetVersion || 0 %>#<%= name %>"></use></svg>`; CSS `.symbol { width: 1em; height: 1em; fill: currentColor; vertical-align: -.125em; }`.

- [ ] **Step 1: Failing test** `symbole.test.js`: jeder `symbol` in Portal- und Admin-Gruppen sowie jeder Eintrag in `SYMBOLE` hat ein `<symbol id="…">` in `symbole.svg`; die Symbole aller Portal- und Admin-Punkte sind untereinander eindeutig (kein Name doppelt).
- [ ] **Step 2:** → FAIL. **Step 3:** Paket installieren, Skript schreiben und ausführen, Views umstellen. Emoji/Unicode-Zeichen aus Navigation, Kopf und Ansichtswahl entfernen.
- [ ] **Step 4:** `npm test` → PASS; `npm run test:responsive` → keine neuen Verstösse.
- [ ] **Step 5:** Commit `feat(ui): einheitliche SVG-Symbole`.

### Task 10: Farbmodus-Menü mit "System"

**Files:**
- Modify: `src/middleware/branding.js` (`parseThemeCookie`, `loadBranding`), `views/_seite_anfang.ejs`, `public/js/portal.js`, `public/css/portal.css`
- Test: `test/unit/branding.test.js`, `test/integration/branding.test.js`, `test/integration/app.test.js:140`, `test/verhalten/farbmodus.test.js`

**Interfaces:**
- `parseThemeCookie(header) → 'hell'|'dunkel'|'system'|null`; `loadBranding`: Cookie `system` → `themeAttr = null` (Admin-Standard wird ignoriert). Neu `branding.farbmodusWahl: 'hell'|'dunkel'|'system'` (Cookie, sonst Admin-Standard, sonst `'system'`).
- Kopf: Dropdown, Knopf behält `id="theme-toggle"` (`aria-label="Farbmodus wählen"`, Symbol `circle-half`), Einträge `<button class="dropdown-item" data-farbmodus="hell|dunkel|system">` mit `aria-pressed` für die aktuelle Wahl.
- `portal.js`: Wahl setzt Cookie `theme=<wahl>;path=/;max-age=31536000;samesite=lax`, setzt `data-theme`/`data-bs-theme` (bei `system` nach `matchMedia('(prefers-color-scheme: dark)')` und hört auf deren `change`, solange `system` gilt). Übergang: Klasse `farbwechsel` auf `<html>` für 250 ms; CSS `.farbwechsel, .farbwechsel * { transition: background-color .25s, color .25s, border-color .25s !important; }`, unter `prefers-reduced-motion` keine Klasse setzen.

- [ ] **Step 1: Failing tests:** unit `parseThemeCookie('theme=system') === 'system'`; integration `Cookie system überschreibt Admin-Standard dunkel` (Admin-Standard `dunkel`, Cookie `theme=system` → `<html lang="de">` ohne `data-theme`); `app.test.js:140` auf das neue Markup anpassen (Logo steht weiterhin direkt vor dem Farbmodus-Bedienelement); Verhalten `farbmodus.test.js`: Playwright `colorScheme: 'light'`, Admin-Standard per DB auf `dunkel`, "System" wählen → nach Neuladen `data-bs-theme="light"`; "Dunkel" wählen → `data-bs-theme="dark"`, Cookie `theme=dunkel`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test`, `npm run test:verhalten` → PASS.
- [ ] **Step 5:** Commit `feat(ui): Farbmodus Hell/Dunkel/System`.

### Task 11: Klebende Kopfzeile ab 992 px

**Files:**
- Modify: `views/_seite_anfang.ejs`, `public/css/portal.css`, `public/js/portal.js`
- Test: `test/verhalten/kopfzeile.test.js`; `npm run test:responsive`

**Interfaces:**
- Testmodus-Band und `<header class="portal-kopf">` stehen in einem gemeinsamen `<div class="portal-oben">`. Ab 992 px: `.portal-oben { position: sticky; top: 0; z-index: 1030; }` (Band verliert dort sein eigenes `sticky`), Kopf `background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(16px) saturate(180%);`, statt `border-bottom` ein weicher Schatten `0 1px 0 var(--bs-border-color-translucent)`. Unter 992 px unverändert (Band-Regeln von heute).
- `@media (prefers-reduced-transparency: reduce)` und `@media (prefers-contrast: more)`: Hintergrund `var(--bg)` deckend, kein `backdrop-filter`; bei `more` zusätzlich `border-bottom: 1px solid var(--bs-emphasis-color)`.
- `portal.js`: `ResizeObserver` auf `.portal-oben` setzt `--portal-oben-hoehe` (px) auf `:root`; Seitenleiste `top: calc(var(--portal-oben-hoehe, 0px) + 1rem)` und `max-height: calc(100vh - var(--portal-oben-hoehe, 0px) - 2rem)`. Modal/Offcanvas-z-index bleibt darüber (1040+).

- [ ] **Step 1: Failing tests** (`kopfzeile.test.js`, 1280 px, Pool mit langer Liste): nach `window.scrollTo(0, 2000)` ist `header.portal-kopf` `getBoundingClientRect().top === 0`; die Seitenleiste überlappt den Kopf nicht (`seitenleiste.top >= kopf.bottom`); bei 768 px ist der Kopf nach dem Scrollen nicht mehr sichtbar (`bottom <= 0`); mit Testmodus (Responsive-Server läuft im Testmodus) liegt der Kopf direkt unter dem Band.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren.
- [ ] **Step 4:** `npm run test:verhalten`, `npm run test:responsive` (Band-Prüfung!) → PASS.
- [ ] **Step 5:** Commit `feat(ui): klebende, durchscheinende Kopfzeile ab Desktop`.

### Task 12: PDF-Rahmen, Knopf-Regel, Typografie

**Files:**
- Modify: `views/_brand_styles.ejs`, `public/css/portal.css`, `views/_zeitpunkt.ejs` (falls dort kein Element mit Klasse: `<span class="zeitpunkt">` ergänzen)
- Test: `test/integration/branding.test.js` (oder bestehender Test zu `_brand_styles`), `npm run test:responsive`

**Interfaces:**
- `_brand_styles.ejs`: `button { border-color: … }` entfernen. `.pdf-preview` hell: `border: 1px solid var(--bs-border-color); box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 4px 12px rgb(0 0 0 / .06);` — dunkle Regeln bleiben.
- `portal.css`: `.seitenkopf-titel { font-weight: 600; letter-spacing: -0.01em; }`; `.betrag, .beleg-nr, .zeitpunkt, .kachel-betrag, .entscheidung-betrag { font-variant-numeric: tabular-nums; }` (eine gemeinsame Regel, vorhandene Einzelangaben entfernen).

- [ ] **Step 1: Failing test:** gerenderte Seite enthält in `_brand_styles` kein `button { border-color` und kein `border: 2px solid #000`; `portal.css` enthält die gemeinsame `tabular-nums`-Regel mit `.zeitpunkt`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test`, `npm run test:responsive` (Kontrast/✕-Prüfung) → PASS.
- [ ] **Step 5:** Commit `style(ui): feiner PDF-Rahmen, Typografie-Feinschliff`.

### Task 13: Antippen, ganze Kachel, Vorschau aus dem Bild

**Files:**
- Modify: `public/css/portal.css`, `views/_job_kacheln.ejs`, `views/_job_aktionen.ejs`, `views/pool.ejs` (Vorschau-Dialog)
- Test: `test/verhalten/kacheln.test.js`, `test/integration/kachelansicht.test.js`

**Interfaces:**
- Antippen: `@media (pointer: coarse) { .btn { transition: transform .1s ease-out; } .btn:active:not(:disabled) { transform: scale(.97); } }`; unter `prefers-reduced-motion` keine `transform`.
- Kachel mit einer Hauptaktion (nicht `istPoolArtig`): Hauptaktions-Link bekommt `stretched-link`, Kachel `position-relative` + Klasse `kachel-klickbar` (Hover: `border-color: var(--brand-primary)`, `box-shadow` leicht; Fokus über `:has(.stretched-link:focus-visible)` sichtbar). Vorschaubild-Link und Formulare in der Kachel `position-relative z-2`, damit sie eigene Klicks behalten. Pool-Kacheln (zwei Aktionen) bleiben wie heute.
- Vorschau-Dialog (`#preview-dialog`): Klasse `vorschau-dialog`; beim Öffnen setzt das Skript `transform-origin` auf den Mittelpunkt des angeklickten Vorschaubilds relativ zum Dialog. CSS: `.vorschau-dialog[open] { transition: opacity .2s, transform .25s cubic-bezier(.2,.8,.2,1), overlay .25s allow-discrete, display .25s allow-discrete; } @starting-style { .vorschau-dialog[open] { opacity: 0; transform: scale(.92); } }`, `::backdrop` blendet mit `rgb(0 0 0 / .4)` ein; Schliessen-Knopf als `btn-close` (✕) mit `aria-label="Schliessen"`. Reduced motion: nur Opazität.

- [ ] **Step 1: Failing tests** (`kacheln.test.js`): `Klick auf Kachelfläche öffnet Hauptaktion` (Kacheln-Ansicht `?ansicht=kacheln` als `test-2`, Klick auf den Lieferant-Text → Navigation nach `/freigabe2/<id>`); `Klick auf Vorschaubild öffnet Vorschau, nicht Hauptaktion` (1280 px → `#preview-dialog[open]`, URL unverändert); `Vorschau-Dialog hat transform-origin vom Bild` (Wert ≠ `50% 50%`). Integration: Pool-Kacheln (`istPoolArtig`) enthalten kein `stretched-link`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test`, `npm run test:verhalten`, `npm run test:responsive` (Überlappungs-Prüfung!) → PASS.
- [ ] **Step 5:** Commit `feat(ui): Rückmeldung beim Antippen, klickbare Kacheln, Vorschau aus dem Bild`.

### Task 14: Abschluss

**Files:**
- Modify: `docs/rechnungs-workflow.md`, `docs/admin-bereich.md` (Ablehnen-Rückfrage, Weitere Aktionen, Farbmodus System, Symbole), `README.md` (Abschnitt Tests: `npm run test:verhalten`)

- [ ] **Step 1:** Doku nachziehen.
- [ ] **Step 2:** `npm test`, `npm run test:verhalten`, `npm run test:responsive` → alle grün; Ergebniszahlen notieren.
- [ ] **Step 3:** Sichtprüfung per Screenshot (Playwright, 1280 hell/dunkel, 360 hell): Pool, Kontierung, Freigabe 2, Admin-Übersicht nach `test-results/apple-design/`; auffällige Abweichungen beheben.
- [ ] **Step 4:** Commit `docs: Apple-Design-Durchgang dokumentiert`.
