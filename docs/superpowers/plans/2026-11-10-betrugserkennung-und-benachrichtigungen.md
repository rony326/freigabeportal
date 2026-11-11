# Betrugserkennung + Benachrichtigungen pro Ereignis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pflicht-IBAN pro Lieferant, Prüf-Popup mit erweiterten Betrugsprüfungen vor dem Speichern der Kontierung, eine Admin-Seite „Benachrichtigungen“ pro Ereignis, Logo-Fixes und durchgängige Du-Form.

**Architecture:** Alle Prüfungen sitzen in einem reinen Service (`src/services/betrugspruefung.js`), der eine Liste von Befunden liefert. Kontierung und Aufsplitten rufen ihn vor der Transaktion auf. Gibt es Befunde ohne passende Bestätigung (Hash), wird die Seite mit offenem Modal neu gerendert und nichts gespeichert. Die Benachrichtigungsseite wird von einer statischen Ereignis-Definition (`src/services/benachrichtigungsEreignisse.js`) getrieben. Sie liest und schreibt die bestehenden `admin_config`-Keys, Empfänger bleiben zeilenbasierter Text mit neuem Token `person:<id>`.

**Tech Stack:** Node ≥ 22, Express 4, EJS, better-sqlite3-artige `db` (`db.prepare`, `db.exec`), Bootstrap 5.3, `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-11-10-betrugserkennung-und-benachrichtigungen-design.md`. Die Executors lesen beides. Entwürfe: Design-Canvas „Betrugserkennung Entwürfe“ (Desktop), Boards 1–5.

## Global Constraints

- Alle neuen und geänderten UI- und Mailtexte in **Du-Form**.
- Kein Inline-`<script>`/`<style>` ohne `nonce="<%= locals.cspNonce %>"`. Client-Code gehört in `public/js/*.js` (CSP, siehe `test/integration/cspSweep.test.js`).
- Jede neue POST-Route mit `csrfProtection` und abgedeckt von `test/integration/csrfSweep.test.js`.
- Kein `alert()`/`confirm()` im Browser-JS (`test/unit/keineBrowserPopups.test.js`). Bestätigungen laufen über Bootstrap-Modals.
- Schwellen-Defaults (in `admin_config`): `pruefung_betrag_min_rechnungen=5`, `pruefung_betrag_faktor=3`, `pruefung_betrag_minimum=500`, `pruefung_neuer_kreditor_betrag=2000`, `pruefung_gleicher_betrag_tage=30`.
- Zahlungsarten exakt: `ueberweisung` (Default) | `dauerauftrag` | `lastschrift` | `kreditkarte`. IBAN-Pflicht nur für `ueberweisung` und `dauerauftrag`.
- Die hinterlegte IBAN erscheint auf Kontierungs- und Aufsplitten-Seiten **nie**, auch nicht teilweise.
- Neue IBANs entstehen nur im Admin (`quelle='manuell'`). Bestehende `quelle='bestaetigt'`-Zeilen bleiben gültig.
- Strenge IBAN-Prüfung (heute nur CH) bleibt für Spesen, QR und Zahlungsexport. Die internationale Prüfung gilt nur für Kreditor-Stammdaten.
- Testlauf: `npm test` muss am Ende jedes Tasks grün sein.

## Review Focus

1. **Betrag in anderem Format als im QR-Code** (`4780` vs `4780.00`, `4780,5` vs `4780.50`): D vergleicht numerisch auf Rappen, nicht als String. Test in Task 8.
2. **Formular nach dem Popup verändert und dann „trotzdem speichern“** (anderer Lieferant oder Betrag): Der Hash passt nicht mehr, es kommt ein neues Popup und nichts wird gespeichert. Test in Task 10.
3. **Empfänger-Person inzwischen inaktiv oder ohne Mail**: Sie wird beim Versand still übersprungen. Speichern eines anderen Ereignisses schlägt deswegen nicht fehl, die Anzeige markiert sie als „inaktiv“. Test in Task 14.
4. **Rechnung abgelehnt, überarbeitet und neu kontiert**: Die Prüfung läuft erneut. Die Freigabe-Ansicht zeigt die jüngste Bestätigung, ältere bleiben im Verlauf. Test in Task 12.
5. **IBAN-Eingabe mit Leerzeichen/Kleinbuchstaben** (Admin) und **`ibanEndung` in Kleinbuchstaben oder mit Leerzeichen**: Beides wird normalisiert. Tests in Task 4 und 9.

---

## Teil A — Kleinkram

### Task 1: Logo verlinkt auf die Startseite

**Files:**
- Modify: `views/_logo.ejs`
- Test: `test/integration/branding.test.js`

- [ ] **Step 1: Failing test** `test('Logo ist ein Link auf die Startseite', …)`: Branding mit Logo setzen (wie bestehende Logo-Tests in der Datei), eine Seite rendern, prüfen, dass `/<a href="\/" [^>]*aria-label="Zur Startseite"[^>]*>\s*<img[^>]+alt="Logo"/` matcht. Bei vorhandenem Dunkel-Logo stehen beide `<img>` im selben `<a>`.
- [ ] **Step 2:** `node --test test/integration/branding.test.js` → FAIL.
- [ ] **Step 3:** Beide `<img>` in `views/_logo.ejs` in ein `<a href="/" class="portal-logo-link" aria-label="Zur Startseite">` einpacken. `alt` der Bilder auf `""` setzen, damit der Screenreader nicht „Logo“ + Label doppelt liest, und den Test-Regex entsprechend auf `alt=""` anpassen.
- [ ] **Step 4:** Test → PASS. `npm test` → grün (`test/responsive`/Layout-Sweeps mitprüfen).
- [ ] **Step 5:** Commit `feat: Logo verlinkt auf die Startseite`.

### Task 2: Bug — Logo klebt mobil rechts trotz „links“

**Files:**
- Modify: `public/css/portal.css` (Bereich `@media` < 576 px, ~Z. 54–70) und/oder `views/_seite_anfang.ejs:73-104`
- Test: `test/responsive/` (bestehender Runner `npm run test:responsive`), zusätzlich ein Unit-Test, falls die Ursache im Template liegt

- [ ] **Step 1:** **REQUIRED SUB-SKILL: superpowers:systematic-debugging.** Bei 375 px reproduzieren: Logo „links“, mit/ohne Seitenleisten-Knopf (eingeloggt/ausgeloggt, z. B. `/abgemeldet`), mit/ohne Admin-Reiter. Box-Positionen von `.portal-kopf-marke` und `#theme-toggle` vergleichen.
- [ ] **Step 2:** Ursache belegen. Dann einen Test schreiben, der die Position prüft: Bei „links“ liegt die linke Kante des Logos links von der Seitenmitte. Er muss auf dem aktuellen Code fehlschlagen. Am bestehenden Responsive-Runner orientieren.
- [ ] **Step 3:** Fix minimal halten, Logo „Mitte“ und „rechts“ nicht verändern.
- [ ] **Step 4:** `npm run test:responsive` und `npm test` → grün. Fix kurz zurücknehmen, Test muss rot werden, dann Fix wieder rein.
- [ ] **Step 5:** Commit `fix: Logo bleibt auf dem Handy links, wenn so eingestellt`. Die Ursache steht in der Commit-Message.

### Task 3: Durchgängig Du-Form

**Files:**
- Modify: `views/audit-pruefen.ejs`, `src/db/adminConfigRepo.js` (Standard-Mailtexte), weitere Fundstellen
- Test: Create `test/unit/duForm.test.js`

- [ ] **Step 1: Failing test** `test('Standard-Mailvorlagen und Views verwenden keine Sie-Form', …)`: Liest alle `DEFAULTS`-Werte aus `adminConfigRepo.js`, deren Key mit `mail_vorlage_` beginnt, sowie alle `views/**/*.ejs`. Assert kein Treffer für `/\b(Sie|Ihnen|Ihre?[mnrs]?)\b/`. Ausnahmen über eine Allowlist mit exakten Satzanfängen, wenn „Sie“ ein Pronomen in der 3. Person ist (heute: `zeitstempel-zertifikat.ejs` „Sie fasst …“, `kreditkarte.ejs` „Sie werden erst verbucht“, `admin/altfaelle-liste.ejs` „Sie werden nicht …“). Export `DEFAULTS` aus `adminConfigRepo.js`, falls es nicht schon exportiert ist.
- [ ] **Step 2:** Test → FAIL (mindestens `audit-pruefen.ejs`).
- [ ] **Step 3:** `views/audit-pruefen.ejs` und alle gefundenen Standardtexte auf Du umformulieren. Gespeicherte Admin-Anpassungen in der DB nicht anfassen. Auch Fehlermeldungen in `src/routes/**/*.js` greppen (`Sie `) und umstellen. Für Routen ist kein Test nötig.
- [ ] **Step 4:** `npm test` → grün. Bestehende Tests, die alte Texte erwarten, nachziehen (z. B. `test/integration/auditPruefen.test.js`).
- [ ] **Step 5:** Commit `refactor: Du-Form auch auf /audit-pruefen und in allen Standard-Mailtexten`.

---

## Teil B — Betrugserkennung

### Task 4: IBAN-Validierung international für Stammdaten

**Files:**
- Modify: `src/services/ibanUtils.js`, `src/services/paymentApproval.js` (Import von `ibanChecksumValid` umstellen)
- Test: Create `test/unit/ibanUtils.test.js` (oder erweitern, falls vorhanden)

**Interfaces — Produces:**
- `isValidIban(iban: string): boolean`: unverändert (CH-Muster). Für QR, Spesen und Export.
- `ibanChecksumValid(iban: string): boolean`: Mod-97, aus `paymentApproval.js` hierher verschoben und dort importiert.
- `isValidIbanInternational(iban: string): boolean`: normalisierte IBAN, Ländercode in `IBAN_LAENGEN`, Länge passt, Mod-97 gültig.
- `ibanLand(iban: string): string`: die ersten zwei Buchstaben.
- `ibanKurz(iban: string): string`: `"CH44 … 1234"` (Land + Prüfziffer, dann die letzten 4).

- [ ] **Step 1: Failing tests:**
  - `isValidIbanInternational('DE89 3704 0044 0532 0130 00'.replace(/\s/g,''))` → true
  - `'CH9300762011623852957'` → true
  - `'CH9300762011623852958'` (Prüfziffer falsch) → false
  - `'DE8937040044053201300'` (eine Stelle zu kurz) → false
  - `'XX00123'` → false
  - `isValidIban('DE89370400440532013000')` → false (bleibt streng)
  - `ibanKurz('CH9300762011623852957')` → `'CH93 … 2957'`
  - `normalizeIban(' ch93 0076 ')` → `'CH930076'`
- [ ] **Step 2:** `node --test test/unit/ibanUtils.test.js` → FAIL.
- [ ] **Step 3:** Implementieren. `IBAN_LAENGEN` als Objekt Land → Länge für alle SEPA-Länder plus die gängigen weiteren (offizielle SWIFT-IBAN-Registry; mindestens CH 21, LI 21, DE 22, AT 20, FR 27, IT 27, NL 18, BE 16, LU 20, ES 24, GB 22, DK 18, SE 24, NO 15, PL 28, PT 25, IE 22, CZ 24, HU 28).
- [ ] **Step 4:** Tests → PASS. `npm test` → grün.
- [ ] **Step 5:** Commit `feat: internationale IBAN-Prüfung für Lieferanten-Stammdaten`.

### Task 5: Schema — Zahlungsart, „Beträge schwanken“, Vollständigkeit

**Files:**
- Modify: `src/db/schema.sql` (Tabelle `kreditoren`), `src/db/index.js` (Migration im bestehenden `ALTER TABLE … ADD COLUMN`-Muster für `kreditoren`), `src/db/kreditorenRepo.js`
- Create: `test/helpers/kreditor.js`
- Test: `test/unit/kreditorenRepo.test.js`

**Interfaces — Produces:**
- Spalten `kreditoren.zahlungsart TEXT NOT NULL DEFAULT 'ueberweisung' CHECK (zahlungsart IN ('ueberweisung','dauerauftrag','lastschrift','kreditkarte'))` und `kreditoren.betrag_schwankt INTEGER NOT NULL DEFAULT 0`. Lässt `ALTER TABLE` kein CHECK zu, dann die Validierung im Repo.
- `export const ZAHLUNGSARTEN = ['ueberweisung','dauerauftrag','lastschrift','kreditkarte']`, `export const ZAHLUNGSART_LABEL = { ueberweisung: 'Überweisung', dauerauftrag: 'Dauerauftrag', lastschrift: 'Lastschrift', kreditkarte: 'Kreditkarte' }` in `kreditorenRepo.js`
- `createKreditor(db, { name, kontoId, zahlungsart = 'ueberweisung', betragSchwankt = false }) → id`
- `updateKreditor(db, id, { name, kontoId, zahlungsart, betragSchwankt })`
- `brauchtIban(zahlungsart: string): boolean`: true für `ueberweisung`/`dauerauftrag`
- `istKreditorVollstaendig(db, kreditor): boolean`: `!brauchtIban(kreditor.zahlungsart) || IBAN-Anzahl > 0`
- `listKreditorenWaehlbar(db): Kreditor[]`: aktive und vollständige, sortiert wie `listKreditoren`
- Test-Helper `test/helpers/kreditor.js`: `kreditorMitIban(db, { name, kontoId = null, iban = 'CH9300762011623852957', zahlungsart = 'ueberweisung' }) → id` (legt Kreditor + IBAN `manuell` an) und `kreditorOhneIbanPflicht(db, { name, kontoId = null }) → id` (`zahlungsart='lastschrift'`).

- [ ] **Step 1: Failing tests** in `kreditorenRepo.test.js`: Default-Zahlungsart `ueberweisung`; neuer Kreditor ohne IBAN → `istKreditorVollstaendig` false; mit IBAN → true; `lastschrift` ohne IBAN → true; `listKreditorenWaehlbar` enthält nur die vollständigen und keine inaktiven; ungültige Zahlungsart wirft.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementieren. Die Migration läuft idempotent auch auf bestehenden DBs (Muster: bestehende Spalten-Migrationen in `src/db/index.js`).
- [ ] **Step 4:** `npm test` → grün. Bestehende Tests bleiben unberührt, die Durchsetzung kommt erst in Task 7.
- [ ] **Step 5:** Commit `feat: Zahlungsart und Vollständigkeit für Lieferanten`.

### Task 6: Admin-Formular Lieferanten (Board 3)

**Files:**
- Modify: `src/routes/admin/kreditoren.js`, `views/admin/kreditoren-liste.ejs` (+ ggf. Kreditor-Bearbeiten-View, im Router nachsehen)
- Test: `test/integration/admin/kreditoren.test.js`

**Interfaces — Consumes:** Task 4 (`isValidIbanInternational`, `ibanKurz`), Task 5 (Repo-Funktionen).

- [ ] **Step 1: Failing tests:**
  - `POST /admin/kreditoren` mit `zahlungsart=ueberweisung` ohne `iban` → 400, Fehler „Bei Überweisung und Dauerauftrag ist mindestens eine IBAN Pflicht.“, kein Kreditor angelegt.
  - Gleiches mit `iban='DE89 3704 0044 0532 0130 00'` → 302, Kreditor + IBAN `DE89370400440532013000` mit `quelle='manuell'`.
  - Mit `zahlungsart=lastschrift` ohne IBAN → 302.
  - `POST /admin/kreditoren/ibans` mit ungültiger Prüfziffer → 400 „IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht).“
  - IBAN löschen, wenn es die letzte eines `ueberweisung`-Kreditors ist → 400 „Die letzte IBAN kann nicht gelöscht werden, solange der Lieferant per Überweisung oder Dauerauftrag bezahlt wird.“, IBAN bleibt.
  - Bearbeiten: `zahlungsart` von `lastschrift` auf `dauerauftrag` ohne IBAN → 400. `betragSchwankt=on` wird gespeichert.
  - `GET /admin/kreditoren` zeigt bei einem unvollständigen Lieferanten das Badge „IBAN fehlt“ und oben „1 Lieferant ohne IBAN“ (Plural: „N Lieferanten ohne IBAN“), plus die Spalte Zahlungsart mit Label.
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren nach Board 3. Formulartexte:
  - Radio-Gruppe „Zahlungsart“ mit Hinweis „Überweisung und Dauerauftrag: mindestens eine IBAN ist Pflicht.“
  - Feld „IBAN“ im Anlege-Formular
  - Checkbox „Beträge schwanken stark: keine Warnung bei ungewöhnlich hohem Betrag“ mit Hinweis „z. B. bei Handwerkern oder Projekt-Lieferanten. Alle IBAN- und Duplikat-Prüfungen bleiben aktiv.“
  - Hinweis „Neue IBANs bitte nur aus einer unabhängigen Quelle übernehmen (Vertrag, Telefonat), nicht von einer Rechnung. Ausländische IBANs sind erlaubt.“

  IBANs werden in der Liste mit `ibanKurz` angezeigt.
- [ ] **Step 4:** Tests → PASS. `npm test` → grün.
- [ ] **Step 5:** Commit `feat: Lieferanten mit Zahlungsart und Pflicht-IBAN im Admin`.

### Task 7: Durchsetzung — nur vollständige Lieferanten wählbar, „IBAN merken“ entfällt

**Files:**
- Modify: `src/routes/kontierung.js` (GET `kreditoren: listKreditoren(db)` → `listKreditorenWaehlbar`; POST-Validierung; Aufsplitten GET/POST), `src/services/aufsplitten.js` (IBAN-merken-Reste), `src/routes/kkAbgleich.js:93,171`, Zuweisungsregel-Anwendung beim Eingang (`src/routes/n8n/jobs.js`, Funktion suchen, die über `zuweisungsregeln` den Kreditor setzt), `views/kontierung.ejs` (Checkbox `ibanMerken` entfernen), `views/kontierung-aufsplitten.ejs`
- Modify (Tests): alle Tests, die mit einem Kreditor ohne IBAN kontieren, aufsplitten oder abgleichen (`grep -rln "createKreditor(" test`)
- Test: `test/integration/kontierung.test.js`, `test/integration/kkAbgleich.test.js`, `test/integration/n8n/jobs.test.js`

**Interfaces — Consumes:** Task 5 (`listKreditorenWaehlbar`, `istKreditorVollstaendig`, Test-Helper).

- [ ] **Step 1: Failing tests:**
  - `GET /kontierung/:id` listet einen unvollständigen Lieferanten nicht im Dropdown `#kreditorId`.
  - `POST /kontierung/:id` mit einem unvollständigen `kreditorId` → 400, Feldfehler `kreditorId` „Dieser Lieferant hat noch keine IBAN. Bitte melde dich bei der Administration.“, nichts gespeichert.
  - Dasselbe für `POST /kontierung/:id/aufsplitten` (Zeilenfehler) und `POST …/kk-abgleich` (Fehler „Bitte einen gültigen Kartenherausgeber wählen.“).
  - Eingang über n8n mit Absender, dessen Regel auf einen unvollständigen Lieferanten zeigt → Job landet im Pool (`status` wie ohne Regel), nicht direkt zugewiesen.
  - `GET /kontierung/:id` mit QR-Daten enthält kein `name="ibanMerken"` mehr. `POST` mit `ibanMerken=on` legt keine `kreditor_ibans`-Zeile an.
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren. Dann die bestehenden Tests umstellen: Wo ein Test nicht von Betrugsprüfung handelt, `createKreditor(db, {…})` durch `kreditorOhneIbanPflicht(db, {…})` ersetzen. Das vermeidet sowohl Pflicht-IBAN als auch (ab Task 9) die manuelle IBAN-Kontrolle. Bestehende QR/IBAN-Tests (`kontierung.test.js` ~2525–2650 u. a.) auf `kreditorMitIban` umstellen. Deren Erwartungen ändern sich erst in Task 10.
- [ ] **Step 4:** `npm test` → grün.
- [ ] **Step 5:** Commit `feat: nur Lieferanten mit IBAN sind wählbar; „IBAN merken“ entfernt`.

### Task 8: Prüf-Service `betrugspruefung.js`

**Files:**
- Create: `src/services/betrugspruefung.js`
- Modify: `src/db/adminConfigRepo.js` (Defaults der 5 Schwellen-Keys, siehe Global Constraints)
- Test: Create `test/unit/betrugspruefung.test.js`

**Interfaces — Produces:**
```js
/** @typedef {{ code: string, schwere: 'rot'|'gelb', titel: string, text: string }} Befund */
export function ermittleBefunde(db, { job, kreditor, betrag, typ, ibanEndung = null }) → Befund[]   // sortiert: rot vor gelb, dann Code-Reihenfolge unten
export function befundeHash(befunde: Befund[]) → string     // sha256 hex über JSON von [{code,text}] in Sortierreihenfolge
export function brauchtManuelleIbanPruefung(job, kreditor, typ) → boolean  // !job.qr_iban && typ==='rechnung' && brauchtIban(kreditor.zahlungsart)
export function ibanEndungPasst(db, kreditorId, endung) → boolean        // normalisiert (trim, upper, ohne Leerzeichen), vergleicht mit den letzten 4 Zeichen jeder hinterlegten IBAN
export function normalisiereFirmenname(name) → string
export function namenPassen(a, b) → boolean
```
`job` ist die DB-Zeile (nutzt `id`, `qr_iban`, `qr_betrag`, `qr_creditor_name`). `betrag` ist der eingegebene String (Komma erlaubt). `typ` ∈ `rechnung|gutschrift`.

Codes und Texte (exakt, Du-Form; `X` = Platzhalter):

| code | schwere | titel | text |
|---|---|---|---|
| `iban_anderer_kreditor` | rot | IBAN gehört einem anderen Lieferanten | `Die IBAN auf der Rechnung (${ibanKurz}) ist bei «${andererName}» hinterlegt, nicht bei «${kreditor.name}».` |
| `iban_fremd` | rot | IBAN nicht hinterlegt | `Die IBAN auf der Rechnung (${ibanKurz}) stimmt mit keiner hinterlegten IBAN von «${kreditor.name}» überein.` |
| `iban_manuell_fremd` | rot | IBAN nicht hinterlegt (manuelle Prüfung) | `Die letzten 4 Zeichen (${endung}) passen zu keiner hinterlegten IBAN von «${kreditor.name}».` |
| `zahlungsart_ohne_iban` | gelb | Lieferant wird sonst per ${Label} bezahlt | `Diese Rechnung hat einen Einzahlungsschein, «${kreditor.name}» wird aber per ${Label} bezahlt.` |
| `name` | gelb | Name weicht ab | `Zahlungsempfänger im QR-Code: «${qr_creditor_name}» · Lieferant: «${kreditor.name}»` |
| `betrag_qr` | gelb | Betrag weicht ab | `QR-Code: ${fmt(qr)} · kontiert: ${fmt(betrag)}` |
| `betrag_hoch` | gelb | Ungewöhnlich hoher Betrag | `${faktorGerundet}-mal so hoch wie der Durchschnitt der letzten ${n} Rechnungen (${fmt(schnitt)})` |
| `neuer_kreditor` | gelb | Neuer Lieferant, hoher Betrag | `Erste Rechnung von «${kreditor.name}» über ${fmt(betrag)}.` |
| `gleicher_betrag` | gelb | Gleicher Betrag kurz hintereinander | `Gleicher Betrag wie Rechnung ${jobIds} vom ${datum} (innerhalb von ${tage} Tagen).` |

`fmt` = `CHF 4'870.00` (Schweizer Tausendertrennung, Währung `job.qr_waehrung` falls vorhanden, sonst `CHF`).

Regeln (aus der Spec, B4 + Klärungen):
- IBAN-Befunde nur, wenn `job.qr_iban` vorhanden und `brauchtIban(zahlungsart)`. `iban_anderer_kreditor` ersetzt `iban_fremd`. Bei `lastschrift`/`kreditkarte` mit QR nur `zahlungsart_ohne_iban`, keine IBAN-Befunde.
- `iban_manuell_fremd` nur, wenn `ibanEndung` übergeben und `!ibanEndungPasst`.
- `name` nur mit `qr_creditor_name`. `namenPassen`: Normalisierung (lowercase, NFD ohne Diakritika, ß→ss, Rechtsformen `ag|gmbh|sa|sarl|sàrl|klg|kg|ltd|llc|inc|ev|e\.v\.|co|cie|genossenschaft|stiftung|verein` als ganze Wörter entfernen, dann alles ausser `[a-z0-9]` entfernen). Passt, wenn ein Ergebnis das andere enthält **oder** die Levenshtein-Distanz ≤ 1 bei Länge ≥ 8 ist. Tests unten fixieren die Grenze.
- `betrag_qr`: numerisch auf Rappen (`Math.round(x*100)`), nur wenn `qr_betrag` gesetzt.
- E/F/G nur bei `typ==='rechnung'`. E nicht bei `kreditor.betrag_schwankt`. G nicht bei `dauerauftrag`/`lastschrift`.
- „Frühere kontierte Rechnungen“: Jobs mit `kreditor_id = kreditor.id`, `id != job.id`, `typ IS NULL OR typ='rechnung'`, `status NOT IN ('abgelehnt','geloescht','unzugewiesen','zugewiesen','aufgesplittet')`, `betrag IS NOT NULL`. E: die mit Freigabe-1-Zeitpunkt innerhalb von 12 Monaten, falls ≥ min. Anzahl, sonst alle. Die genaue Status-Liste vor dem Implementieren gegen die Statusmaschine in `docs/rechnungs-workflow.md` prüfen und im Test festhalten.
- G: Vergleich mit Jobs aus derselben Menge, deren Freigabe-1-Zeitpunkt (`freigaben.rolle='freigeber1'`) ≤ `tage` Tage zurückliegt, gleicher Betrag auf Rappen, `rechnungsnummer` verschieden.

- [ ] **Step 1: Failing tests** (je ein `test(...)`):
  - QR-IBAN bei anderem Kreditor hinterlegt → genau ein Befund `iban_anderer_kreditor` (kein `iban_fremd`), schwere rot.
  - QR-IBAN unbekannt → `iban_fremd`. QR-IBAN hinterlegt → kein IBAN-Befund.
  - `lastschrift`-Kreditor + QR → nur `zahlungsart_ohne_iban`, Titel „Lieferant wird sonst per Lastschrift bezahlt“.
  - `namenPassen('Muster Druck AG','MUSTER-DRUCK')` true; `('Muster Druck AG','Muster Druk GmbH')` false; `('Müller & Söhne GmbH','Mueller und Soehne')` → im Test festhalten, was die Regel ergibt; `('Gebäudereinigung Blitz GmbH','Gebaudereinigung Blitz')` true.
  - `betrag_qr`: QR `4870.00`, Betrag `4780` → Befund; QR `4780.00`, Betrag `4780` → keiner; Betrag `4780,5` vs QR `4780.50` → keiner.
  - E: 5 frühere à 950 → Betrag 4780 → `betrag_hoch` mit Text „5-mal so hoch wie der Durchschnitt der letzten 5 Rechnungen (CHF 950.00)“; 4 frühere → kein Befund; Betrag 400 bei Schnitt 100 → kein Befund (unter 500); `betrag_schwankt=1` → kein Befund; Gutschrift → kein Befund.
  - F: keine frühere Rechnung, Betrag 2000.00 → kein Befund; 2000.05 → `neuer_kreditor`.
  - G: frühere Rechnung gleicher Betrag, Freigabe vor 10 Tagen, andere Rechnungsnummer → Befund; vor 31 Tagen → keiner; `dauerauftrag` → keiner.
  - Sortierung: rot vor gelb.
  - `befundeHash` stabil bei gleicher Eingabe, anders bei geändertem Text.
  - `ibanEndungPasst(db, k, ' 2957 ')` true bei hinterlegter `CH9300762011623852957`, `'2958'` false, `'abcd'` gegen `…ABCD` true.
  - Schwellen aus `admin_config` überschreiben die Defaults (Faktor auf 10 → kein `betrag_hoch` bei 5×).
- [ ] **Step 2:** `node --test test/unit/betrugspruefung.test.js` → FAIL.
- [ ] **Step 3:** Implementieren (reine Funktionen + DB-Lesezugriffe, keine Schreibzugriffe, keine Mails).
- [ ] **Step 4:** Tests → PASS. `npm test` → grün.
- [ ] **Step 5:** Commit `feat: Prüf-Service für Auffälligkeiten bei der Kontierung`.

### Task 9: Manuelle IBAN-Kontrolle ohne QR-Code (Board 2)

**Files:**
- Modify: `src/routes/kontierung.js` (GET/POST), `views/kontierung.ejs`, Create `public/js/kontierung-iban.js` (Kasten ein/aus beim Lieferantenwechsel)
- Test: `test/integration/kontierung.test.js`

**Interfaces — Consumes:** Task 8 (`brauchtManuelleIbanPruefung`, `ibanEndungPasst`). **Produces:** Formularfeld `ibanEndung`. `<option data-iban-pflicht="1|0">` am Lieferanten-Dropdown.

- [ ] **Step 1: Failing tests:**
  - GET ohne QR, Lieferant `ueberweisung` vorausgewählt → Kasten mit Überschrift „Kein QR-Code: IBAN bitte von Hand prüfen“, Feld `name="ibanEndung"` mit Label „Letzte 4 Zeichen der IBAN“. Die HTML-Antwort enthält **nicht** die letzten 4 Zeichen der hinterlegten IBAN.
  - POST ohne `ibanEndung` → 400, Feldfehler `ibanEndung` „Bitte gib die letzten 4 Zeichen der IBAN auf der Rechnung ein.“, nichts gespeichert.
  - POST `ibanEndung=' 2957'` (passt) → 302 wie heute. Audit/Freigaben-Eintrag `iban_manuell_geprueft` mit Kommentar „IBAN manuell geprüft: Übereinstimmung (Eingabe 2957)“.
  - POST mit QR-Code oder bei `lastschrift`-Lieferant → `ibanEndung` nicht verlangt.
  - Gutschrift ohne QR → nicht verlangt.
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren.
  - Neue `freigaben.rolle`-Werte `iban_manuell_geprueft` und `auffaelligkeiten_bestaetigt` (letzteren braucht Task 10): CHECK-Constraint per Tabellen-Neuaufbau nach dem bestehenden Muster in `src/db/index.js` erweitern (`grep -n "rapport_markierung_aufgehoben" src/db/index.js`). Die Darstellung im Audit-Log (`views/_audit_log.ejs` bzw. die Rollen-Labels im Service) ergänzen.
  - Bei Nicht-Übereinstimmung wird hier noch **nicht** gestoppt: Task 10 macht daraus den Befund `iban_manuell_fremd`. Bis dahin Kommentar „keine Übereinstimmung“ loggen.
  - Clientseitig nur Ein- und Ausblenden des Kastens anhand `data-iban-pflicht` und Typ-Radio, kein Live-Abgleich (die Spec erlaubt ihn nur ohne Preisgabe, das sparen wir uns).
- [ ] **Step 4:** Tests → PASS. `npm test` → grün.
- [ ] **Step 5:** Commit `feat: IBAN-Kontrolle von Hand bei Rechnungen ohne QR-Code`.

### Task 10: Prüf-Popup bei der Kontierung + eine Warn-Mail (Board 1)

**Files:**
- Create: `src/db/auffaelligkeitenRepo.js`, `views/_auffaelligkeiten_modal.ejs`
- Modify: `src/db/schema.sql` + `src/db/index.js` (Tabelle), `src/routes/kontierung.js` (POST `/:id`, ersetzt den IBAN-Block ~Z. 469–504), `views/kontierung.ejs`, `public/js/portal.js` oder neue `public/js/auffaelligkeiten.js` (Modal beim Laden öffnen), `src/services/mailTemplates.js` (`TYP_ZU_KEY_INFIX`: `'iban-warnung'` → `'auffaelligkeiten-warnung': 'auffaelligkeiten_warnung'`), `src/services/notify.js` (`IMMER_SOFORT_TYPEN`), `src/db/adminConfigRepo.js` (Defaults `mail_vorlage_auffaelligkeiten_warnung_*`, alte `iban_warnung`-Keys entfernen), `src/routes/admin/mailEinstellungen.js` (Feld umbenennen, bis Task 16 die Seite ersetzt)
- Test: `test/integration/kontierung.test.js`, `test/unit/mailTemplates.test.js`

**Interfaces — Consumes:** Task 8 (`ermittleBefunde`, `befundeHash`), Task 9 (`ibanEndung`, Rolle `auffaelligkeiten_bestaetigt`). **Produces:**
- Tabelle `kontierung_auffaelligkeiten(id INTEGER PK, job_id INTEGER NOT NULL REFERENCES jobs(id), person_id TEXT NOT NULL, zeitpunkt TEXT NOT NULL, befunde_json TEXT NOT NULL, bemerkung TEXT)`
- `speichereBestaetigung(db, { jobId, personId, befunde, bemerkung }) → id` · `listBestaetigungen(db, jobId) → Array<{…, befunde: Befund[]}>` (neueste zuerst) · `letzteBestaetigung(db, jobId) → …|null`
- Formularfelder: `auffaelligkeitenHash` (hidden), `pruefBemerkung` (max. 500)
- Mailtyp `auffaelligkeiten-warnung`, Variablen: `jobDateiname`, `kreditorName`, `auffaelligkeiten` (Textliste „- Titel: Text“ je Zeile), `bestaetigtVon`, `bemerkung` (leer → „–“), `link`, `portalName`
- Standardtexte: Betreff `Freigabeportal: Auffälligkeiten bei Rechnung %jobDateiname%`. Text:
  `Hallo\n\n%bestaetigtVon% hat die Rechnung "%jobDateiname%" (Lieferant: %kreditorName%) trotz folgender Auffälligkeiten kontiert:\n\n%auffaelligkeiten%\n\nWie geprüft: %bemerkung%\n\nBitte schau sie dir vor der Freigabe genau an: %link%\n\nFreundliche Grüsse\n%portalName%`

Ablauf im POST: gilt für die Aktion „kontieren“ in allen Zweigen (normal, Interessenskonflikt-Eskalation, strikte Weiterleitung), weil überall Kontierungsdaten gespeichert werden. Nach der bestehenden Validierung, **vor** `db.exec('BEGIN')`:
1. `befunde = ermittleBefunde(db, { job, kreditor, betrag, typ: jobTyp, ibanEndung: brauchtManuelle ? ibanEndung : null })`
2. Wenn `befunde.length > 0 && req.body.auffaelligkeitenHash !== befundeHash(befunde)` → `res.status(200)` und die Kontierungsseite mit `values` (inkl. `ibanEndung`, `pruefBemerkung`) und `auffaelligkeiten: { befunde, hash, zeigeTelefonHinweis: befunde.some(b => b.code.startsWith('iban')) }` rendern. Return, keine DB-Änderung, keine Mail. Ein angehängter Beleg muss erneut gewählt werden: Hinweis im Modal „Einen angehängten Beleg musst du nach dem Speichern nochmals anhängen.“ nur, wenn `req.file` gesetzt war. Alternativ den Beleg-Upload vor dem Popup verbieten (Builder-Entscheid, im Commit begründen).
3. Sonst innerhalb der bestehenden Transaktion: `speichereBestaetigung` + `createFreigabe(rolle='auffaelligkeiten_bestaetigt', kommentar = befunde.map(b => b.titel).join('; ') + (bemerkung ? ` — Wie geprüft: ${bemerkung}` : ''))`.
4. Nach COMMIT: eine Mail pro Empfänger (Freigeber 1 + 2 des Kontos, kontierende Person, `resolveEmpfaenger(db, config, getConfigValue(db,'iban_abweichung_empfaenger'))`; Key bleibt aus Kompatibilität bestehen, Label ändert sich in Task 16). Den alten `iban_abweichung`-`freigaben`-Eintrag und die `iban-warnung`-Mail nicht mehr erzeugen.

- [ ] **Step 1: Failing tests:**
  - QR-IBAN fremd, kein Hash → 200, Body enthält `id="auffaelligkeiten-modal"`, „Bitte Rechnung nochmals prüfen“, „IBAN nicht hinterlegt“, „Prüfe die Bankverbindung telefonisch beim Lieferanten“. Job-Status unverändert, keine `freigaben`-Zeile, `mail_log` leer.
  - Gleiches POST mit korrektem `auffaelligkeitenHash` (aus dem Body des ersten Response gelesen) und `pruefBemerkung='telefonisch bestätigt'` → 302, Status wie ohne Befund, genau eine `kontierung_auffaelligkeiten`-Zeile mit Bemerkung, eine `freigaben`-Zeile `auffaelligkeiten_bestaetigt`, `mail_log` mit `typ='auffaelligkeiten-warnung'` je Empfänger (3 Empfänger im Seed), Betreff enthält „Auffälligkeiten“, kein `iban-warnung`.
  - Hash aus Lauf 1, aber `betrag` geändert (neuer Befund `betrag_qr`) → wieder 200 mit Modal, nichts gespeichert. **(Review Focus 2)**
  - Keine Befunde → 302, keine Bestätigungszeile, keine Mail.
  - Manuelle Prüfung `ibanEndung='0000'` (passt nicht) → Modal mit „IBAN nicht hinterlegt (manuelle Prüfung)“.
  - Aktion `ablehnen` mit Befunden → kein Modal, Ablehnung wie bisher.
  - `test/unit/mailTemplates.test.js`: `getVorlage(db,'auffaelligkeiten-warnung')` liefert die Standardtexte; `'iban-warnung'` ist unbekannt.
  - Die bestehenden Tests „sends an IBAN-Abweichung warning mail …“ auf das neue Verhalten umschreiben (Hash-Roundtrip).
- [ ] **Step 2:** Tests → FAIL.
- [ ] **Step 3:** Implementieren. Modal nach Board 1, Bootstrap-Modal `#auffaelligkeiten-modal`, das beim Laden per JS geöffnet wird, wenn vorhanden.
  - Rote Befunde mit `alert-danger`-Farben, gelbe mit `alert-warning`.
  - Hinweisbox (nur bei IBAN-Befund): „Prüfe die Bankverbindung **telefonisch beim Lieferanten**, mit der Nummer aus deinen eigenen Unterlagen, nicht mit der auf der Rechnung.“
  - Feld „Wie hast du geprüft? (optional, erscheint im Audit-Log)“
  - Hinweis „Beim Speichern werden Freigeber 1 und 2 per Mail informiert.“
  - Knöpfe „Abbrechen“ (`data-bs-dismiss`) und „Geprüft, trotzdem speichern“ (`type=submit form="kontierung-form" name="aktion" value="kontieren"`). Hash und Bemerkung liegen als Felder im `kontierung-form`, per `form=`-Attribut.
  - Ohne JS: Modal-Inhalt steht als normaler Block über dem Formular (`noscript`-tauglich durch `.modal` mit Fallback-Klasse; Builder-Entscheid).
- [ ] **Step 4:** Tests → PASS. `npm test` → grün.
- [ ] **Step 5:** Commit `feat: Prüf-Popup vor dem Speichern und eine gemeinsame Warn-Mail`.

### Task 11: Prüf-Popup beim Aufsplitten

**Files:**
- Modify: `src/routes/kontierung.js` (POST `/:id/aufsplitten`), `src/services/aufsplitten.js` (IBAN-Warn-Block ~Z. 290–320 durch Befund-Flow ersetzen), `views/kontierung-aufsplitten.ejs` (Modal-Partial + `ibanEndung_<i>` pro Zeile ohne QR)
- Test: `test/integration/kontierung.test.js` (Aufsplitten-Tests ~1740 ff., 2525 ff.)

**Interfaces — Consumes:** Task 8, Task 10 (`_auffaelligkeiten_modal.ejs`, Repo, Mailtyp).

Regeln: Befunde je Teilzeile mit eigenem Lieferanten und Teilbetrag (`betrag` = Teilbetrag, `job` = Elternjob für QR-Daten). `betrag_qr` beim Aufsplitten **gegen den Gesamtbetrag** statt den Teilbetrag (Builder-Entscheid aus der Spec, hier fixiert). Titel im Modal mit Präfix „Teil N · “. Ein gemeinsamer Hash über alle Zeilen. Nach Bestätigung je Kind-Job eine `kontierung_auffaelligkeiten`-Zeile mit seinen Befunden und eine Mail je Kind mit Befunden.

- [ ] **Step 1: Failing tests:** Split mit einer Zeile auf einen Lieferanten mit fremder QR-IBAN → 200 + Modal, kein Kind angelegt, Eltern-Status unverändert. Mit Hash → Kinder angelegt, Bestätigung am betroffenen Kind, eine Mail-Runde `auffaelligkeiten-warnung`. Zeile ohne QR mit `ueberweisung`-Lieferant ohne `ibanEndung_0` → 400 Zeilenfehler.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test` → grün.
- [ ] **Step 5:** Commit `feat: Prüf-Popup auch beim Aufsplitten`.

### Task 12: Bestätigte Auffälligkeiten in Freigabe-Ansichten (Board 4)

**Files:**
- Create: `views/_auffaelligkeiten_bestaetigt.ejs`
- Modify: `src/routes/freigabe2.js` + `views/freigabe2.ejs`, `views/kontierung.ejs` (bei erneuter Kontierung, z. B. nach strikter Weiterleitung an echten Freigeber 1 oder nach Überarbeitung), `views/admin/vorgang-detail.ejs` + Route
- Test: `test/integration/freigabe2.test.js`, `test/integration/kontierung.test.js`, Test für Vorgang-Detail (bestehende Datei unter `test/integration/admin/` suchen)

**Interfaces — Consumes:** Task 10 (`letzteBestaetigung`, `listBestaetigungen`).

- [ ] **Step 1: Failing tests:**
  - Freigabe-2-Seite eines Jobs mit Bestätigung zeigt „2 Auffälligkeiten, bewusst bestätigt“ (Zahl dynamisch, Singular „1 Auffälligkeit, bewusst bestätigt“), die Titel, „Bestätigt von Person1 Muster am “ + Datum (`dd.mm.yyyy, HH:MM`, Zeitzone wie sonst im Portal) und „Wie geprüft: «…»“ (nur bei Bemerkung).
  - Ohne Bestätigung: kein Kasten.
  - Job mit zwei Bestätigungen (abgelehnt → überarbeitet → neu kontiert) zeigt die jüngste. **(Review Focus 4)**
  - Admin-Vorgang-Detail zeigt denselben Kasten.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren nach Board 4 (rot umrandete Card, Kopf `alert-danger`-Farben). **Step 4:** `npm test` → grün.
- [ ] **Step 5:** Commit `feat: bestätigte Auffälligkeiten für Freigeber sichtbar`.

### Task 13: Testmodus-Beispieldaten + Doku Betrugserkennung

**Files:**
- Modify: `src/services/testmodus/beispieldaten.js` (Beispiel-Lieferanten mit Zahlungsart + IBAN, mindestens einer `lastschrift`), `docs/qr-bill-und-betrugserkennung.md` (neu strukturieren: Zahlungsart/Pflicht-IBAN, Prüfungen-Tabelle, Popup-Ablauf als Mermaid, manuelle Prüfung, Schwellen), `docs/datenmodell.md` (neue Spalten, Tabelle, Rollen), `docs/rechnungs-workflow.md` (Kontierung/Aufsplitten-Abschnitte)
- Test: `test/unit/testmodusSpielwiese.test.js` bzw. bestehender Beispieldaten-Test

- [ ] **Step 1:** Failing Test: Alle Beispiel-Lieferanten sind `istKreditorVollstaendig`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren + Doku. **Step 4:** `npm test` → grün.
- [ ] **Step 5:** Commit `docs: Betrugserkennung neu beschrieben; Testmodus-Lieferanten mit IBAN`.

---

## Teil C — Benachrichtigungen pro Ereignis

### Task 14: Empfänger-Token `person:<id>`

**Files:**
- Modify: `src/services/notify.js` (`resolveEmpfaenger`), `src/routes/admin/eskalation.js` (`validateEmpfaengerListe`, wird in Task 16 nach `src/services/empfaenger.js` verschoben)
- Test: `test/unit/notify.test.js`, `test/unit/` für den Validator

**Interfaces — Produces:**
- `resolveEmpfaenger(db, config, konfigWert)`: zusätzlich Zeilen `person:<churchtools_person_id>` → aktuelle Mail der Person, nur wenn die Person aktiv ist und eine Mail hat, sonst still übersprungen.
- `validateEmpfaengerListe(value, label, errors, { db, leerErlaubt = false })`: akzeptiert `person:<id>` nur, wenn die Person existiert (aktiv oder nicht, damit Speichern nicht an fremden Einträgen scheitert). `leerErlaubt` für Keys mit „leer = Default“ (`rapport_eskalation_empfaenger`, `audit_revision_empfaenger`).

- [ ] **Step 1: Failing tests:** `person:1` → `p1@example.org`; inaktive Person → `[]` ohne Fehler **(Review Focus 3)**; gemischte Liste dedupliziert; Validator lehnt `person:999` ab („unbekannte Person“) und akzeptiert `person:1`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren (Personen-Aktivflag: das Feld verwenden, das `listActivePersonsInGroup` nutzt). **Step 4:** `npm test` → grün.
- [ ] **Step 5:** Commit `feat: Personen als Mail-Empfänger referenzierbar`.

### Task 15: Ereignis-Definitionen

**Files:**
- Create: `src/services/benachrichtigungsEreignisse.js`
- Test: Create `test/unit/benachrichtigungsEreignisse.test.js`

**Interfaces — Produces:**
```js
export const BEREICHE = ['Allgemein','Rechnungen','Freigabe 2','Warnungen','Rapporte','Kreditkarten','System & Sicherheit'];
/** Ereignis: {
 *   id: string,                // URL-Segment, z. B. 'reminder'
 *   bereich: string, titel: string, beschreibung: string,
 *   vorlagenTyp: string|null,  // Schlüssel in TYP_ZU_KEY_INFIX; null = keine Vorlage (z. B. sicherheitsalarm)
 *   automatisch: string|null,  // fester Text "Wer bekommt automatisch"
 *   empfaengerKey: string|null,// admin_config-Key der Zusatzempfänger
 *   empfaengerLeerErlaubt: boolean,
 *   zeitKeys: Array<{ key: string, label: string, einheit: 'Stunden'|'CHF'|'Tage'|'Anzahl'|'Faktor' }>,
 *   sofort: boolean,           // Hinweis "wird immer sofort verschickt"
 *   variablen: Array<{ name: string, label: string, beispiel: string }>
 * } */
export const EREIGNISSE: Ereignis[];
export function findeEreignis(id) → Ereignis|undefined
```
Inhalt: die Liste aus Spec C, je bestehender Vorlage aus `TYP_ZU_KEY_INFIX` genau ein Ereignis (Zuordnung der Stunden- und Empfänger-Keys: `reminder_*`, `eskalation_*`, `freigabe2_*`, `rapport_*`, `iban_abweichung_empfaenger` → „Auffälligkeiten bei Kontierung“ (+ die 5 Schwellen-Keys als `zeitKeys`), `sync_fehler_empfaenger` → Sync-Fehler, `sicherheitsalarm_empfaenger` → neues Ereignis „Sicherheitsalarm“ ohne Vorlage, `audit_revision_empfaenger` → Audit-Prüfnummer). „Zusammenfassung & Versandzeit“ (`id: 'zusammenfassung'`) trägt die Digest-Vorlage und die Keys `mail_standard_benachrichtigung`, `mail_digest_wochentag`, `mail_batching_stunde`, `mail_batching_minute` (Sonderbehandlung in der Route). Variablenlisten aus den heutigen `form-text`-Hinweisen in `views/admin/mail-einstellungen-form.ejs` bzw. aus den Aufrufstellen (`grep -rn "typ: '<typ>'" src`).

- [ ] **Step 1: Failing tests:** Jede Vorlage aus `TYP_ZU_KEY_INFIX` gehört zu genau einem Ereignis. Jeder `zeitKey`/`empfaengerKey` existiert in den `adminConfigRepo`-Defaults. Alle `variablen.name` kommen im Standardtext der jeweiligen Vorlage vor oder werden an einer Aufrufstelle gesetzt (mindestens: im Standardtext). `findeEreignis('reminder').bereich === 'Rechnungen'`. Ids eindeutig, URL-sicher.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: Ereignis-Definitionen für Benachrichtigungen`.

### Task 16: Seite „Benachrichtigungen“ (serverseitig, Board 5)

**Files:**
- Create: `src/routes/admin/benachrichtigungen.js`, `views/admin/benachrichtigungen.ejs`, `src/services/empfaenger.js` (Validator aus `eskalation.js` hierher)
- Modify: `src/app.js` (Mount mit denselben Rechten wie heute `/admin/eskalation` und `/admin/mail-einstellungen`; Rechte-Middleware dort ablesen), Redirects `GET /admin/eskalation` → `/admin/benachrichtigungen/reminder`, `GET /admin/mail-einstellungen` → `/admin/benachrichtigungen/zusammenfassung`; alte Routen, Views und Tests entfernen. `views/admin/dashboard.ejs` (zwei Kacheln → eine „Benachrichtigungen“), `views/admin/geplante-jobs.ejs` (Links), `src/routes/admin/sync.js` + View (Feld `syncFehlerEmpfaenger` → Link „Empfänger einstellen → Benachrichtigungen“), `src/routes/admin/zeitstempel.js` + View (Feld `audit_revision_empfaenger` ebenso; `POST`-Pfad, der ihn setzt, entfernen), Navigation/Seitenleiste falls dort verlinkt, `test/integration/csrfSweep.test.js`
- Test: Create `test/integration/admin/benachrichtigungen.test.js`; alte Tests für eskalation/mail-einstellungen migrieren

**Interfaces — Consumes:** Task 14, 15, `renderTemplate`, `getVorlage`, `sendNotification` (Typ `testmail` existiert und ist sofort). **Produces:** Routen
- `GET /admin/benachrichtigungen` → 302 auf das erste Ereignis
- `GET /admin/benachrichtigungen/:id` → 404 bei unbekannt
- `POST /admin/benachrichtigungen/:id`: Felder `zeit_<key>`, `empfaenger` (Zeilen-Text, gleiche Syntax wie gespeichert), `betreff`, `text`
- `POST /admin/benachrichtigungen/:id/zuruecksetzen`: Vorlage auf Default (Keys löschen bzw. Default setzen, je nach `getVorlage`-Logik)
- `POST /admin/benachrichtigungen/:id/test-mail`: rendert mit `beispiel`-Werten, `sendNotification(db, mailer, { to: req.currentPerson.email, typ: 'testmail', variablen })` mit gerendertem Betreff/Text der Vorlage (prüfen, wie `testmail` Betreff/Text bezieht; bei Bedarf `gerendert`-Parameter von `reiheBenachrichtigungEin` nutzen), Audit-Log-Eintrag, Redirect mit Flash „Test-Mail an <mail> verschickt.“

Validierung: alle bisherigen Regeln aus `eskalation.js` und `mailEinstellungen.js` (positive Ganzzahlen, Stunde 0–23 usw., Pflicht-Hinweise Digest, Audit-Prüfnummer-Sonderlogik ~Z. 136–140) pro Ereignis übernehmen. Schwellen: Anzahl/Tage positive Ganzzahl, Faktor > 1 (Dezimal mit Punkt), CHF ≥ 0.

Markierung „angepasst“: `getConfigValue(key) !== DEFAULTS[key]` für Betreff oder Text.

Ansicht (ohne JS voll bedienbar):
- links die Ereignisliste nach `BEREICHE`, aktives Ereignis hervorgehoben, „angepasst“-Pill
- rechts drei nummerierte Sections „Wann“, „Wer bekommt die Mail“, „Was steht drin“ nach Board 5
- „Wer“ zeigt den `automatisch`-Text und darunter die Zusatzempfänger als Liste mit Namen: Gruppe → „Gruppe Buchhaltung“, Person → „Vorname Nachname“ (+ „inaktiv“-Badge), Mail → Adresse
- Ohne JS gibt es ein `<textarea name="empfaenger">` mit Hilfetext „Eine Zeile pro Empfänger: gruppe:buchhaltung, gruppe:admin, person:ID oder E-Mail-Adresse“. Task 17 ersetzt es progressiv.
- Sections ohne Inhalt entfallen: kein „Was“ bei `vorlagenTyp=null`, kein „Wer“-Zusatz ohne `empfaengerKey`.

- [ ] **Step 1: Failing tests:**
  - GET `/admin/benachrichtigungen/reminder` zeigt „Wann“, Wert von `reminder_stunden`, Empfänger „Gruppe Buchhaltung“, Betreff-Feld.
  - POST speichert Stunden, Empfänger `gruppe:admin\nperson:1` und Text. Danach zeigt die Liste bei „Erinnerung“ das Badge „angepasst“.
  - Ungültige Stunden → 400 mit Fehler, nichts gespeichert.
  - `zuruecksetzen` → Text = Default, Badge weg.
  - `test-mail` → `mail_log` mit `typ='testmail'` an die Admin-Mail, Betreff enthält den gerenderten Beispiel-Betreff.
  - `/admin/eskalation` und `/admin/mail-einstellungen` → 302 auf die neuen URLs.
  - Ereignis „sicherheitsalarm“ zeigt keinen „Was“-Block.
  - Ohne Recht → 403 (wie die alten Seiten).
  - CSRF-Sweep deckt die drei neuen POST-Routen ab.
  - Kein `gruppe:buchhaltung` als sichtbarer Text ausserhalb von Textarea und Hilfetext.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test` → grün (alte Tests für Eskalation, Mail-Einstellungen, Sync und Zeitstempel angepasst).
- [ ] **Step 5:** Commit `feat: Admin-Seite Benachrichtigungen pro Ereignis ersetzt Eskalationszeiten und Mail-Einstellungen`.

### Task 17: Komfort im Browser — Empfänger-Picker, Variablen-Knöpfe, Live-Vorschau

**Files:**
- Create: `public/js/benachrichtigungen.js`
- Modify: `views/admin/benachrichtigungen.ejs` (Datenattribute: `data-personen` als JSON in `<script type="application/json" nonce>` mit `{id, name, rolle}` nur aktiver Personen; `data-variablen`, `data-beispiele`)
- Test: `test/integration/admin/benachrichtigungen.test.js` (Markup-Anker), Unit-Test für die Render-Funktion, falls als ES-Modul testbar (sonst Builder-Entscheid)

Verhalten:
- **Picker:** Die Textarea wird versteckt (bleibt das gesendete Feld) und durch Kärtchen ersetzt. Gruppe und Person haben Icons wie in Board 5, jedes Kärtchen einen ×-Knopf mit `aria-label="<Name> entfernen"`. Darunter ein Suchfeld mit Vorschlagsliste: Abschnitt „Gruppen“ (Admin, Buchhaltung), „Personen“ (Treffer auf Vor- und Nachname, max. 8), letzte Zeile „Andere E-Mail-Adresse eingeben …“, die bei gültiger Mail die Adresse übernimmt. Tastatur: ↑/↓/Enter/Escape, `role="listbox"`/`option`, `aria-activedescendant`. Jede Änderung schreibt die Textarea neu.
- **Variablen-Knöpfe:** fügen `%name%` an der Cursorposition des zuletzt fokussierten Feldes ein (Betreff oder Text).
- **Live-Vorschau:** dieselbe Ersetzung wie `renderTemplate` (`/%([a-zA-Z0-9_]+)%/g`, unbekannte bleiben stehen) mit den `beispiel`-Werten. Unbekannte Platzhalter werden unter dem Text als Warnung „Unbekannter Platzhalter: %xy%“ angezeigt.
- Kein `innerHTML` mit Nutzertext (XSS): nur `textContent` bzw. DOM-Knoten.

- [ ] **Step 1: Failing tests:** Seite enthält `<script src="/js/benachrichtigungen.js"` mit Nonce-konformem Laden, das JSON-Datenelement, Knöpfe `class="var"` je Variable mit `data-var="empfaengerName"` und Label „Name“. Wenn die Render-Funktion exportierbar ist: `vorschau('Hallo %empfaengerName% %xy%', {empfaengerName:'Anna'})` → `{ text: 'Hallo Anna %xy%', unbekannt: ['xy'] }`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test` + `npm run test:responsive` → grün. Manuell im Browser bei 1280 px und 375 px prüfen (Skill `run`).
- [ ] **Step 5:** Commit `feat: Empfänger-Auswahl, Variablen-Knöpfe und Live-Vorschau`.

### Task 18: Doku, Release-Notes, Abschluss

**Files:**
- Modify: `docs/admin-bereich.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/README.md` (Index), `docs/testdrehbuch/` (neue Fälle: Pflicht-IBAN, Popup mit/ohne QR, Benachrichtigungsseite), `CHANGELOG.md`, Create `docs/releases/v1.1.0.md` (Versionsnummer mit dem User klären, bevor `package.json` geändert wird; bis dahin nur Notes-Entwurf)
- [ ] **Step 1:** Doku nachziehen. Jede in den Docs genannte Route oder Seite existiert, z. B. `grep -rn "/admin/eskalation\|/admin/mail-einstellungen\|IBAN merken" docs views src` → nur noch Redirect-Code und Changelog.
- [ ] **Step 2:** `npm test`, `npm run test:responsive`, `npm run test:verhalten` → alle grün.
- [ ] **Step 3:** Commit `docs: Betrugserkennung und Benachrichtigungen dokumentiert`.
