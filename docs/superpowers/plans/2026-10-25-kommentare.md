# Kommentare an Rechnungen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rückfragen hängen unveränderlich an der Rechnung/Spesenposition, benachrichtigen die Beteiligten per Mail (gezielt per `@Name`), sind in Listen sichtbar und erscheinen auf dem finalen PDF.

**Architecture:** Neue Tabelle `kommentare` (append-only, zentrale Audit-Trigger) plus `kommentar_gelesen`; ein Service `src/services/kommentare.js` bündelt Sichtbarkeit, Beteiligte, `@Name`-Erkennung und Speichern; ein Router `/kommentare/:jobId` nimmt Kommentare entgegen; ein Partial `_kommentare.ejs` wird in die bestehenden Detailseiten eingebunden; `stampAndFinalize`/`stampGruppenDokument` zeichnen einen Abschnitt "Rückfragen und Kommentare".

**Tech Stack:** Node.js ESM, Express 4, EJS, node:sqlite, pdf-lib, `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-10-25-kommentare-design.md`

## Global Constraints

- Text: 1–2000 Zeichen nach `trim()`, nur Text, Zeilenumbrüche erhalten (Anzeige escaped, `white-space: pre-wrap`), nie HTML.
- Kommentare unveränderlich: `BEFORE UPDATE` und `BEFORE DELETE` Trigger mit `RAISE(ABORT, 'kommentare ist unveraenderlich')`; `kommentare` in die `tables`-Liste von `src/db/securitySchema.js` (Schlüssel `id`).
- Abgeschlossen (keine neuen Kommentare, bestehende sichtbar): Status `abgeschlossen`, `abgeholt`, `archiviert`, `geloescht` — als exportierte Konstante `KOMMENTAR_GESCHLOSSEN_STATUS`.
- Sehen/Kommentieren: `canViewJobPdf(db, config, person, job)` **oder** `personHasPermission(... 'vorgaenge_einsehen')` (bzw. die vorhandene Rechte-Prüfung, die `/admin/vorgaenge` nutzt). Niemand sonst, auch nicht über `@Name`.
- Mail-Typ `kommentar` (in den `mail_log`-CHECK per `erweitereCheckPerRebuild`, Vorlage in admin_config DEFAULTS + `TYP_ZU_KEY_INFIX`, nicht in `IMMER_SOFORT_TYPEN`). Nie an die schreibende Person; jede Person höchstens eine Mail pro Kommentar.
- Zeitpunkte Europe/Zurich (bestehende Hilfsfunktion/Partial `_zeitpunkt.ejs`).
- PDF: Abschnittstitel exakt "Rückfragen und Kommentare"; Zeile je Kommentar `<TT.MM.JJJJ HH:MM> — <Vorname Nachname>:` danach der Text; nicht-WinAnsi-Zeichen → `?`; Umbruch und Folgeseiten wie der Verlauf.
- Responsive (360 px), CSRF auf jedem Formular, `csrfSweep`/`layoutSweep` grün, jede Task endet mit `npm test` grün (aktuell 2140).

## Review Focus

1. Person mit Zugriff auf Rechnung A schickt einen Kommentar an `/kommentare/<B>` (fremde Rechnung) oder erwähnt jemanden ohne Zugriff → 403 bzw. Fehlermeldung, nichts gespeichert, keine Mail (Task 2 Test).
2. Kommentar mit Emoji/kyrillischen Zeichen und 2000 Zeichen ohne Leerzeichen → Portal zeigt Original, finales PDF wird erstellt (keine Stempel-Exception), Hash/Zeitstempel bleiben gültig (Task 4 Test).
3. Gleiche Person ist Freigeber 1, frühere Kommentatorin und erwähnt → genau eine Mail (Task 1 Test).
4. Kommentar wird abgeschickt, während eine zweite Person die Rechnung gerade abschliesst (Status wechselt zwischen Seitenaufruf und POST) → abgelehnt mit verständlicher Meldung (Task 2 Test).
5. Testmodus: Kommentar in der Spielwiese → nur Spiel-DB und Test-Postfach (Task 2 Test, mit `createApp({ testmodus: true })` wie in `test/integration/testmodusInstanz.test.js`).

---

### Task 1: Datenmodell und Kommentar-Service

**Files:**
- Modify: `src/db/index.js` (Tabellen + Trigger + mail_log-CHECK), `src/db/securitySchema.js` (`tables`), admin_config DEFAULTS (Vorlage `kommentar`), `src/services/mailTemplates.js` (`TYP_ZU_KEY_INFIX`)
- Create: `src/services/kommentare.js`
- Test: `test/unit/kommentare.test.js`

**Interfaces:**
- Tabellen: `kommentare(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), person_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000), erwaehnt TEXT NOT NULL DEFAULT '[]', erstellt_am TEXT NOT NULL)`, Index auf `job_id`; `kommentar_gelesen(job_id, person_id, zuletzt_am, PRIMARY KEY(job_id, person_id))` (darf aktualisiert werden, nicht audit-pflichtig).
- Produces (`src/services/kommentare.js`):
  - `KOMMENTAR_GESCHLOSSEN_STATUS` (Array)
  - `darfKommentareSehen(db, config, person, job) → boolean`
  - `darfKommentieren(db, config, person, job) → boolean` (sehen und Status nicht geschlossen)
  - `erwaehnbarePersonen(db, config, job) → [{ id, name }]` (alle aktiven Personen, für die `darfKommentareSehen` gilt, nach Name sortiert)
  - `findeErwaehnungen(text, kandidaten) → { ids: string[], unbekannt: string[] }` — erkennt `@Vorname Nachname` (längster passender Name gewinnt, gross/klein egal); `@` ohne passenden Kandidaten → `unbekannt`
  - `beteiligte(db, config, job, { schreiberId, erwaehntIds }) → personId[]` (Spec Entscheidung 3: zuständige Person via `ermittleZustaendigkeit`, Freigeber 1/2 des Kontos inkl. aktiver Vertretung, `eingereicht_von`, frühere Kommentierende, Erwähnte; gefiltert auf `darfKommentareSehen`; ohne Schreiber; ohne Duplikate)
  - `async erfasseKommentar(db, config, mailer, { job, person, text }) → { ok: true, id } | { ok: false, fehler: string[] }` — prüft Länge, `darfKommentieren`, Erwähnungen (unbekannt/nicht berechtigt → Fehler), speichert, schickt `sendNotification` Typ `kommentar` an `beteiligte`
  - `listeKommentare(db, jobId) → [{ id, text, erstellt_am, verfasser_name, person_id }]` chronologisch
  - `kommentarInfo(db, jobIds, personId) → Map<jobId, { anzahl, neu }>` (`neu` = Kommentare anderer seit `kommentar_gelesen.zuletzt_am`; ohne Eintrag zählen alle fremden)
  - `markiereGelesen(db, jobId, personId)`

- [ ] **Step 1: Failing tests:** Tabelle angelegt, UPDATE/DELETE wird abgewiesen, INSERT erscheint in `audit_ereignisse`; mail_log akzeptiert `kommentar` (auch nach Migration einer alten DB); Sichtbarkeit je Rolle (zuständig, F2, Vertretung, Einreicherin Spesen, `vorgaenge_einsehen`, fremde Person → false); `darfKommentieren` false für jeden Status aus `KOMMENTAR_GESCHLOSSEN_STATUS`; `findeErwaehnungen` mit "@Anna Beispiel", "@anna beispiel," "@Unbekannt"; Beteiligte ohne Schreiber und ohne Duplikat (Review Focus 3); Admin ohne Rolle nur bei Erwähnung; Text 0 / 2001 Zeichen → Fehler; `kommentarInfo` zählt `neu` korrekt vor/nach `markiereGelesen`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(kommentare): Datenmodell und Service`.

### Task 2: Kommentarbereich auf den Detailseiten

**Files:**
- Create: `src/routes/kommentare.js`, `views/_kommentare.ejs`, `views/kommentar-fehler.ejs`
- Modify: `src/app.js` (Mount `/kommentare`), die GET-Handler und Views von Kontierung (`src/routes/kontierung.js` `/:id`, `views/kontierung.ejs`), Freigabe 2 (`freigabe2.js`/`freigabe2.ejs`), Ablehnung (`ablehnung.js`/`abgelehnt.ejs`), Spesen-Freigabe 1 (`spesenFreigabe1.js`/`spesen-freigabe1.ejs`), Admin-Vorgang (`admin/vorgaenge.js` `/:id`/`admin/vorgang-detail.ejs`), abgeschlossene Ansicht (`zeitstempelPruefen.js` `GET /` mit `jobId`/`zeitstempel-pruefen.ejs`, nur lesend)
- Test: `test/integration/kommentare.test.js`, `csrfSweep`

**Interfaces:**
- Consumes: Task 1.
- `POST /kommentare/:jobId` (CSRF, angemeldet): Job laden, `erfasseKommentar`; Erfolg → Redirect auf `zurueck` (nur relative Pfade aus einer festen Liste von Präfixen: `/kontierung/`, `/freigabe2/`, `/ablehnung/`, `/spesen-freigabe1/` bzw. tatsächlicher Mount, `/admin/vorgaenge/`, `/zeitstempel-pruefen`; sonst Startseite) mit Anker `#kommentare`; nicht sichtbar → 403; Fehler → 422 `kommentar-fehler.ejs` (Meldungen, Text in Textarea zum erneuten Absenden, Link zurück).
- `_kommentare.ejs` erhält `{ kommentare, darfKommentieren, erwaehnbar, jobId, zurueck, csrfToken }`: Liste (Verfasser, `_zeitpunkt`, Text escaped mit `pre-wrap`), Formular mit Textarea (`maxlength=2000`), Auswahl "Person erwähnen" (`<select>` + kleines Skript fügt `@Name ` ein; ohne JS Freitext), Hinweis "Kommentare können nicht geändert werden"; bei geschlossenem Status nur Liste und Hinweis "Abgeschlossen — keine neuen Kommentare".
- Jede eingebundene GET-Route ruft `markiereGelesen` für die aktuelle Person.

- [ ] **Step 1: Failing tests:** Kommentar auf jeder der sechs Seiten sichtbar (Rolle mit Zugriff); POST speichert und leitet zurück; fremde Rechnung → 403, nichts gespeichert (Review Focus 1); `@` nicht berechtigte Person → 422 mit Namen in der Meldung, keine Mail; abgeschlossener Status → kein Formular, POST → 422 "abgeschlossen" (Review Focus 4); XSS `<script>` erscheint escaped; Mail an Beteiligte im `mail_log`, keine an Schreiber; offener Redirect `zurueck=https://evil` → Startseite; Testmodus-Instanz (Review Focus 5); `csrfSweep`.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(kommentare): Kommentarbereich auf den Rechnungsseiten`.

### Task 3: Anzeige in Listen

**Files:**
- Modify: Routen und Partials, die Vorgangslisten zeigen: `_job_table.ejs`, `_job_kacheln.ejs` (alle Einbindungen, z. B. `pool.ejs`), `_spesen_meine_tabelle.ejs`/`_spesen_meine_kacheln.ejs`, `_abgeschlossen_table.ejs`/`_abgeschlossen_kacheln.ejs`, `admin/_vorgaenge_kacheln.ejs`/`admin/vorgaenge-liste.ejs`, `admin/_abgelehnt_kacheln.ejs`/`admin/abgelehnt-liste.ejs`; neues Partial `views/_kommentar_marke.ejs`
- Test: `test/integration/kommentarListen.test.js`

**Interfaces:**
- Consumes: `kommentarInfo` (Task 1).
- Jede Liste erhält `kommentarInfo` (Map oder Objekt) im Render-Kontext; `_kommentar_marke.ejs` zeigt bei `anzahl > 0` Sprechblase (Bootstrap Icon `bi-chat-left-text`, sofern Icons vorhanden; sonst Textsymbol) + Anzahl, bei `neu > 0` Badge "neu"; `aria-label` "N Kommentare, davon M neu".

- [ ] **Step 1: Failing tests:** Liste mit Kommentaren zeigt Anzahl; "neu" für fremden Kommentar, verschwindet nach Öffnen der Detailseite; eigener Kommentar zählt nicht als neu; Vorgang ohne Kommentare ohne Marke; Tabelle und Kacheln.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test` (inkl. `layoutSweep`).
- [ ] **Step 5:** Commit `feat(kommentare): Anzahl und neu in den Listen`.

### Task 4: Kommentare auf dem finalen PDF

**Files:**
- Modify: `src/services/pdfStamp.js` (`stampAndFinalize`, `stampGruppenDokument`), `src/routes/freigabe2.js` (stampData), `src/services/splitGruppenExport.js` (je Position)
- Test: `test/unit/pdfStampKommentare.test.js`, bestehende Freigabe-2-/Splitgruppen-Integrationstests ergänzen

**Interfaces:**
- `stampData.kommentare = [{ zeitpunkt, verfasser, text }]` (optional, chronologisch); `gruppenData.positionen[i].kommentare` gleich aufgebaut.
- Exportierte Hilfe `winAnsiSicher(text) → string` (ersetzt nicht darstellbare Zeichen durch `?`, erhält Umlaute/ß/€).
- Abschnitt nach dem Verlauf, Titel "Rückfragen und Kommentare", Zeilenformat aus Global Constraints; ohne Kommentare kein Abschnitt; bei Gruppen je Position Untertitel mit Positionsnummer/Job-ID.

- [ ] **Step 1: Failing tests:** gestempeltes PDF enthält Titel und Kommentartext (Text extrahieren mit vorhandenem `pdfText.js`); Emoji/Kyrillisch → `?`, Stempeln wirft nicht (Review Focus 2); 2000-Zeichen-Wort und 30 Kommentare → Folgeseite, kein Text abgeschnitten; Gruppen-PDF mit Kommentaren je Teil; ohne Kommentare identische Seitenzahl wie vorher; Freigabe-2-Rundreise: Kommentar → Freigabe → PDF enthält Kommentar, Hash in DB passt zum gespeicherten PDF, Zeitstempel-Prüfung ok.
- [ ] **Step 2–4:** RED → implementieren → GREEN, `npm test`.
- [ ] **Step 5:** Commit `feat(kommentare): Kommentare auf dem finalen PDF`.

### Task 5: Dokumentation

**Files:**
- Modify: `docs/README.md` (falls Featureliste), passende Doku für Workflow/Freigabe (z. B. `docs/workflow*.md`), Mailvorlagen-Doku, `docs/architektur.md` (Tabelle, Router), Datenschutz-/Aufbewahrungsabschnitt (Kommentare unveränderlich, im Audit-Log)
- [ ] **Step 1:** Doku schreiben; Pfade, Routen, Vorlagen-Schlüssel per `grep` prüfen.
- [ ] **Step 2:** `npm test` → PASS.
- [ ] **Step 3:** Commit `docs: Kommentare an Rechnungen dokumentieren`.
