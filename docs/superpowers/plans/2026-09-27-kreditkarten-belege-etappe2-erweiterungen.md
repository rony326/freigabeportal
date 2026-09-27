# Kreditkarten-Belege — Etappe 2 (Erweiterungen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six extensions on top of the Etappe-1 core: "Kauf getätigt von" (6d), PDF text analysis (shared base), reminder cron (6a), automatic card detection on n8n intake (6b), reconciliation suggestions (6c), receipt intake by mail via n8n (6e) and retention deletion of discarded receipts (6f).

**Architecture:** Pure additions to Etappe 1 — no new tables (all columns and CHECK values already exist since Etappe-1 Task 1). One shared text-analysis module (`src/services/pdfText.js` + `src/services/kkTextAnalyse.js`) feeds 6b, 6c and 6e. The reminder is a new cron job following the `freigabe2-erinnerungen` pattern; the retention deletion extends the existing nightly `pdf-bereinigung` job. Mail intake is a new n8n machine route whose logic lives in a reusable service (`kkBelegEingang.js`) so the future native mail module can call it.

**Tech Stack:** Node.js ≥ 22.13 (ESM), Express 4, `node:sqlite`, EJS, multer, mupdf (`page.toStructuredText().asText()`), `node:test` + supertest.

**Spec:** `docs/superpowers/specs/2026-09-27-kreditkarten-belege-design.md` section 6 (6a–6f). **Prerequisite:** `docs/superpowers/plans/2026-09-27-kreditkarten-belege-etappe1-kern.md` fully merged.

## Global Constraints

- Everything from the Etappe-1 plan's Global Constraints still applies.
- Suggestions are hints only: text extraction/parsing failures must never fail an upload, an n8n intake or the Abgleich page — catch, log, continue.
- Automatic card marking only when **exactly one** active card matches (absender pattern ∪ last-4-digit match). Module off ⇒ no automatic marking.
- Automatic marking writes `freigaben` with `person_id` = the card's responsible person, `ip = 'system'`, comment contains "automatisch erkannt" (FK is NOT NULL — established in Etappe-1 Task 7).
- `kk-beleg-eingegangen` mails are always sent immediately (never batched); `kk-beleg-erinnerung` respects the batching switch.
- Reminder threshold default 45 days; retention deletion default 90 days after `verworfen_am`. Only the files are deleted — the `kk_belege` row stays. `zugeordnet` receipts are never deleted.
- n8n intake: 422 `{ fehler: 'absender_unbekannt' }` for an unknown sender, 409 when the module is off, 400 for a bad file.
- mupdf text: `extrahierePdfText` reads at most 20 pages.

## Review Focus

1. **A statement PDF whose text contains the card's last four digits *and* another card's absender pattern matches** — two different cards ⇒ no automatic marking at all (normal pool flow). Test in Task 4.
2. **Two open receipts with the same amount, statement contains that amount once** — only one gets pre-checked; the one with a nearby date wins. Test in Task 2 (`berechneVorschlaege`) and Task 5.
3. **Scanned (image-only) statement / broken PDF** — text extraction yields nothing or throws; the n8n upload still returns 201, the Abgleich page still renders with no suggestions. Tests in Task 4 and Task 5.
4. **A mail-intake Entwurf for a person who may upload to several cards** — card stays empty; completing it requires choosing a card the person is allowed to use; Entwürfe never show up on the Abgleich page. Test in Task 6.
5. **Retention run twice, or file already gone** — second run changes nothing; a missing file still gets `datei_geloescht_am`. Test in Task 7.

---

### Task 1: „Kauf getätigt von“ (6d)

**Files:**
- Modify: `src/routes/kreditkarte.js`, `views/kreditkarte.ejs`, `views/kreditkarte-beleg-bearbeiten.ejs`
- Test: `test/integration/kreditkarte.test.js` (append)

**Interfaces:**
- Consumes: `listActivePersons`, `getPersonById` (`personenRepo.js`); `createKkBeleg`/`updateKkBelegDaten` already accept `gekauftVon` (Etappe-1 Task 2).
- Produces: form field `gekauftVon` on upload and edit (default: current person).

- [ ] **Step 1: Write the failing tests** (append to `test/integration/kreditkarte.test.js`)

```js
test('upload for someone else: gekauft_von is stored, and the buyer may edit the receipt', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '8.00', kaufdatum: '2026-09-01', beschreibung: 'Taxi', gekauftVon: '2' });
  assert.equal(res.status, 302);
  const [beleg] = listKkBelegeFuerPerson(t.db, '3');
  assert.equal(beleg.hochgeladen_von, '3');
  assert.equal(beleg.gekauft_von, '2');
  const alsKaeufer = await request(t.app).get(`/kreditkarte/belege/${beleg.id}/bearbeiten`).set('x-test-person-id', '2');
  assert.equal(alsKaeufer.status, 200);
  t.cleanup();
});

test('upload with an unknown gekauftVon person is rejected with 400', async () => {
  const t = setup();
  const res = await upload(t.app, '3', { kreditkarteId: String(t.offen), betrag: '8.00', kaufdatum: '2026-09-01', beschreibung: 'Taxi', gekauftVon: '999' });
  assert.equal(res.status, 400);
  t.cleanup();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/integration/kreditkarte.test.js`
Expected: the two new tests FAIL (`gekauft_von` is `'3'`; unknown person accepted).

- [ ] **Step 3: Implement**

In `src/routes/kreditkarte.js`:

- import `listActivePersons, getPersonById` from `../db/personenRepo.js`.
- In `pruefeFelder`, before `return`, add:

```js
    const gekauftVonId = (body.gekauftVon || '').trim() || req.currentPerson.churchtools_person_id;
    const gekauftVon = getPersonById(db, gekauftVonId);
    if (!gekauftVon || !gekauftVon.aktiv) errors.push('Bitte eine gültige Person für "Kauf getätigt von" wählen.');
```

  and add `gekauftVon: gekauftVonId` to the returned `werte`.
- In `POST /belege`, change `gekauftVon: personId(req)` to `gekauftVon: werte.gekauftVon` (keep `hochgeladenVon: personId(req)`; `...werte` already spreads it — make sure the explicit key comes **after** the spread or remove the explicit one).
- In `POST /belege/:id`, change `updateKkBelegDaten(db, beleg.id, { ...werte, gekauftVon: beleg.gekauft_von })` to `updateKkBelegDaten(db, beleg.id, werte)`.
- In `renderSeite` and `renderBearbeiten` pass `personen: listActivePersons(db)`; in `renderSeite`'s default `values` add `gekauftVon: personId(req)`; in the GET `/belege/:id/bearbeiten` values add `gekauftVon: beleg.gekauft_von`.

In both views add, next to the Konto select (`col-md-6`):

```ejs
            <div class="col-md-6">
              <label class="form-label" for="gekauftVon">Kauf getätigt von</label>
              <select class="form-select" id="gekauftVon" name="gekauftVon">
                <% personen.forEach((p) => { %>
                  <option value="<%= p.churchtools_person_id %>" <%= p.churchtools_person_id === String(values.gekauftVon) ? 'selected' : '' %>><%= p.vorname %> <%= p.nachname %></option>
                <% }) %>
              </select>
            </div>
```

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/integration/kreditkarte.test.js` — PASS; `npm test` — PASS.

```bash
git add src/routes/kreditkarte.js views/kreditkarte.ejs views/kreditkarte-beleg-bearbeiten.ejs test/integration/kreditkarte.test.js
git commit -m "feat(kreditkarten): record who made the purchase when uploading for someone else"
```

---

### Task 2: Textanalyse von Abrechnungen und Belegen

**Files:**
- Create: `src/services/pdfText.js`
- Create: `src/services/kkTextAnalyse.js`
- Test: `test/unit/kkTextAnalyse.test.js`, `test/unit/pdfText.test.js`

**Interfaces:**
- Produces (`pdfText.js`): `extrahierePdfText(pdfBuffer) → string` (throws on unreadable PDF; max 20 pages; pages joined by `\n`).
- Produces (`kkTextAnalyse.js`):
  - `findeBetraege(text) → Array<{ betrag: string /* '1234.50', signed */, zeile: number }>`
  - `findeDaten(text) → Array<{ datum: string /* 'YYYY-MM-DD' */, zeile: number }>`
  - `findeEndziffern(text) → Set<string>`
  - `schlageTotalVor(text) → string|null`
  - `analysiereText(text) → { betraege, daten, total }` (JSON-serializable; cached in `jobs.kk_text_betraege`)
  - `LEERE_ANALYSE` = `{ betraege: [], daten: [], total: null }`
  - `berechneVorschlaege(belege, analyse) → Map<belegId, 'betrag' | 'betrag_datum'>`

- [ ] **Step 1: Write the failing tests**

`test/unit/kkTextAnalyse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findeBetraege, findeDaten, findeEndziffern, schlageTotalVor, analysiereText, berechneVorschlaege } from '../../src/services/kkTextAnalyse.js';

const TEXT = [
  'Visa Business **** 4242',
  "03.09.2026  SBB Bern          CHF   12.50",
  "05.09.26    Druckerei AG      CHF 1'234.50",
  '07.09.2026  Gutschrift Hotel  CHF   80.00 CR',
  '2026-09-08  Taxi              -15,00',
  'Total zu bezahlen                   1152.00',
].join('\n');

test('findeBetraege normalizes thousands separators, comma decimals and credit markers', () => {
  const werte = findeBetraege(TEXT).map((b) => b.betrag);
  assert.deepEqual(werte, ['12.50', '1234.50', '-80.00', '-15.00', '1152.00']);
  assert.equal(findeBetraege(TEXT)[1].zeile, 2);
});

test('findeBetraege ignores the card digits and dates', () => {
  assert.ok(!findeBetraege(TEXT).some((b) => b.betrag === '4242.00'));
});

test('findeDaten understands dd.mm.yyyy, dd.mm.yy and ISO', () => {
  assert.deepEqual(findeDaten(TEXT).map((d) => d.datum), ['2026-09-03', '2026-09-05', '2026-09-07', '2026-09-08']);
});

test('findeEndziffern finds masked card numbers in several styles', () => {
  assert.deepEqual([...findeEndziffern('Karte **** 4242')], ['4242']);
  assert.deepEqual([...findeEndziffern('XXXX XXXX XXXX 1234')], ['1234']);
  assert.deepEqual([...findeEndziffern('Kartennr. •••• 9876')], ['9876']);
  assert.deepEqual([...findeEndziffern('Konto 12345678')], []);
});

test('schlageTotalVor takes the last amount on the first Total/Saldo line', () => {
  assert.equal(schlageTotalVor(TEXT), '1152.00');
  assert.equal(schlageTotalVor('nichts hier'), null);
});

test('berechneVorschlaege: amount match, amount+date match, and duplicates only as often as the amount appears', () => {
  const analyse = analysiereText(TEXT);
  const belege = [
    { id: 1, betrag: '12.50', kaufdatum: '2026-09-20' }, // amount only (date too far)
    { id: 2, betrag: '12.50', kaufdatum: '2026-09-02' }, // amount + date (±3 days) — wins the single occurrence
    { id: 3, betrag: '80.00', kaufdatum: '2026-09-07' }, // credit shown as CR, beleg positive: matched by absolute value
    { id: 4, betrag: '99.00', kaufdatum: '2026-09-07' }, // not on the statement
  ];
  const v = berechneVorschlaege(belege, analyse);
  assert.equal(v.get(2), 'betrag_datum');
  assert.equal(v.has(1), false);
  assert.equal(v.get(3), 'betrag_datum');
  assert.equal(v.has(4), false);
});
```

`test/unit/pdfText.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrahierePdfText } from '../../src/services/pdfText.js';
import { buildPdfFixture } from '../helpers/pdfFixture.js';

test('extrahierePdfText returns the text of all pages', async () => {
  const pdf = await buildPdfFixture(['Karte **** 4242', 'Total 12.50']);
  const text = extrahierePdfText(pdf);
  assert.match(text, /4242/);
  assert.match(text, /Total 12\.50/);
});

test('extrahierePdfText throws on garbage', () => {
  assert.throws(() => extrahierePdfText(Buffer.from('kein pdf')));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/kkTextAnalyse.test.js test/unit/pdfText.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `src/services/pdfText.js`**

```js
import * as mupdf from 'mupdf';

const MAX_SEITEN = 20;

// Reiner Text aller Seiten (höchstens MAX_SEITEN) -- Grundlage für Kartenerkennung und
// Zuordnungs-Vorschläge. Gescannte Bild-PDFs liefern schlicht leeren Text; das ist kein Fehler.
export function extrahierePdfText(pdfBuffer) {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  try {
    const seiten = Math.min(doc.countPages(), MAX_SEITEN);
    const teile = [];
    for (let i = 0; i < seiten; i++) {
      const page = doc.loadPage(i);
      try {
        const st = page.toStructuredText();
        try {
          teile.push(st.asText());
        } finally {
          st.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return teile.join('\n');
  } finally {
    doc.destroy();
  }
}
```

- [ ] **Step 4: Implement `src/services/kkTextAnalyse.js`**

```js
// Heuristiken für Kreditkartenabrechnungen. Liefern nur Vorschläge -- nichts hier darf eine
// fachliche Entscheidung erzwingen.

// Betrag: optionales Minus, Tausendertrenner ' ’ oder Leerzeichen, genau zwei Nachkommastellen
// mit . oder ,, optional gefolgt von CR oder - (Gutschrift). Die Lookbehind/-ahead-Grenzen
// verhindern Treffer mitten in Datumsangaben (03.09.2026) oder Kartennummern.
const BETRAG_RE = /(?<![\d.,'’])(-\s?)?(\d{1,3}(?:['’ ]\d{3})+|\d+)[.,](\d{2})(?![\d.,])(\s?(?:CR\b|-))?/g;
const DATUM_RES = [
  { re: /\b(\d{2})\.(\d{2})\.(\d{4})\b/g, map: (m) => `${m[3]}-${m[2]}-${m[1]}` },
  { re: /\b(\d{2})\.(\d{2})\.(\d{2})\b(?!\.)/g, map: (m) => `20${m[3]}-${m[2]}-${m[1]}` },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, map: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /\b(\d{2})\/(\d{2})\/(\d{4})\b/g, map: (m) => `${m[3]}-${m[2]}-${m[1]}` },
];
const ENDZIFFERN_RE = /(?:[*Xx•]{2,}[\s*Xx•-]*)(\d{4})\b/g;
const TOTAL_RE = /total|saldo|zu bezahlen|rechnungsbetrag/i;

export const LEERE_ANALYSE = Object.freeze({ betraege: [], daten: [], total: null });

function zeilen(text) {
  return String(text || '').split(/\r?\n/);
}

function istGueltigesDatum(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function betraegeInZeile(zeile) {
  // Datumsangaben vorher ausblenden, damit "03.09.26" nicht als 3.09 gelesen wird.
  let bereinigt = zeile;
  for (const { re } of DATUM_RES) bereinigt = bereinigt.replace(new RegExp(re.source, 'g'), (m) => ' '.repeat(m.length));
  const treffer = [];
  for (const m of bereinigt.matchAll(BETRAG_RE)) {
    const ganz = m[2].replace(/['’ ]/g, '');
    const negativ = Boolean(m[1]) || Boolean(m[4]);
    treffer.push(`${negativ ? '-' : ''}${Number(`${ganz}.${m[3]}`).toFixed(2)}`);
  }
  return treffer;
}

export function findeBetraege(text) {
  const result = [];
  zeilen(text).forEach((zeile, i) => {
    for (const betrag of betraegeInZeile(zeile)) result.push({ betrag, zeile: i });
  });
  return result;
}

export function findeDaten(text) {
  const result = [];
  zeilen(text).forEach((zeile, i) => {
    const gefunden = [];
    for (const { re, map } of DATUM_RES) {
      for (const m of zeile.matchAll(new RegExp(re.source, 'g'))) {
        const iso = map(m);
        if (istGueltigesDatum(iso)) gefunden.push({ index: m.index, datum: iso });
      }
    }
    gefunden.sort((a, b) => a.index - b.index).forEach((g) => result.push({ datum: g.datum, zeile: i }));
  });
  return result;
}

export function findeEndziffern(text) {
  const result = new Set();
  for (const m of String(text || '').matchAll(ENDZIFFERN_RE)) result.add(m[1]);
  return result;
}

export function schlageTotalVor(text) {
  for (const zeile of zeilen(text)) {
    if (!TOTAL_RE.test(zeile)) continue;
    const betraege = betraegeInZeile(zeile);
    if (betraege.length > 0) return betraege.at(-1);
  }
  return null;
}

export function analysiereText(text) {
  return { betraege: findeBetraege(text), daten: findeDaten(text), total: schlageTotalVor(text) };
}

function tageAbstand(a, b) {
  return Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000;
}

// Ein Beleg wird vorgeschlagen, wenn sein Betrag (Absolutwert -- Gutschriften stehen je nach Bank
// als "-", "CR" oder positiv da) in der Abrechnung vorkommt. Jede Fundstelle deckt höchstens
// einen Beleg ab; Belege mit passendem Datum (±3 Tage, gleiche Textzeile) kommen zuerst dran.
export function berechneVorschlaege(belege, analyse) {
  const a = analyse || LEERE_ANALYSE;
  const fundstellen = new Map();
  for (const { betrag, zeile } of a.betraege) {
    const key = Math.abs(Number(betrag)).toFixed(2);
    if (!fundstellen.has(key)) fundstellen.set(key, []);
    fundstellen.get(key).push(zeile);
  }
  const datenProZeile = new Map();
  for (const { datum, zeile } of a.daten) {
    if (!datenProZeile.has(zeile)) datenProZeile.set(zeile, []);
    datenProZeile.get(zeile).push(datum);
  }
  const kandidaten = belege
    .filter((b) => b.betrag != null)
    .map((b) => {
      const key = Math.abs(Number(b.betrag)).toFixed(2);
      const zeilenMitBetrag = fundstellen.get(key) || [];
      const datumZeile = b.kaufdatum
        ? zeilenMitBetrag.find((z) => (datenProZeile.get(z) || []).some((d) => tageAbstand(d, b.kaufdatum) <= 3))
        : undefined;
      return { beleg: b, key, datumZeile };
    })
    .filter((k) => (fundstellen.get(k.key) || []).length > 0)
    .sort((x, y) => Number(y.datumZeile !== undefined) - Number(x.datumZeile !== undefined));

  const vorschlaege = new Map();
  for (const k of kandidaten) {
    const frei = fundstellen.get(k.key);
    if (frei.length === 0) continue;
    const idx = k.datumZeile !== undefined && frei.includes(k.datumZeile) ? frei.indexOf(k.datumZeile) : 0;
    const genutzteZeile = frei.splice(idx, 1)[0];
    vorschlaege.set(k.beleg.id, k.datumZeile !== undefined && genutzteZeile === k.datumZeile ? 'betrag_datum' : 'betrag');
  }
  return vorschlaege;
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/unit/kkTextAnalyse.test.js test/unit/pdfText.test.js`
Expected: PASS. If a regex edge case fails, fix the regex — do not loosen the test expectations.

- [ ] **Step 6: Commit**

```bash
git add src/services/pdfText.js src/services/kkTextAnalyse.js test/unit/kkTextAnalyse.test.js test/unit/pdfText.test.js
git commit -m "feat(kreditkarten): extract amounts, dates, card digits and totals from statement text"
```

---

### Task 3: Erinnerungs-Cron `kk-beleg-erinnerungen` (6a)

**Files:**
- Modify: `src/db/kkBelegeRepo.js`, `src/db/jobsRepo.js`
- Modify: `src/services/cronJobs.js`, `src/services/scheduler.js`, `src/routes/cron.js`
- Modify: `src/routes/admin/geplanteJobs.js`, `views/admin/geplante-jobs.ejs`
- Modify: `src/services/mailTemplates.js`, `src/db/adminConfigRepo.js`, `src/routes/admin/mailEinstellungen.js`, `views/admin/mail-einstellungen-form.ejs`
- Test: `test/unit/cronJobs.test.js` (append), `test/unit/scheduler.test.js` (adapt)

**Interfaces:**
- Produces (repos):
  - `listKkBelegeFuerErinnerung(db, schwelleIso) → row[]` (`offen` with `kaufdatum <= schwelleIso.slice(0,10)`, or `entwurf` with `hochgeladen_am <= schwelleIso`; and `letzte_erinnerung_am IS NULL OR <= schwelleIso`; joined `karte_bezeichnung`, `verantwortlich_id`)
  - `markKkBelegErinnert(db, id)`
  - `listKkAbrechnungenFuerErinnerung(db, schwelleIso) → row[]` (jobs `zugewiesen`, `kreditkarte_id` set, `kk_markiert_am <= schwelleIso`, `kk_erinnert_am IS NULL OR <= schwelleIso`)
  - `markKkAbrechnungErinnert(db, jobId)`
- Produces: `runKkBelegErinnerungenJob(db, config, mailer) → { status, belege, abrechnungen }` (status `'uebersprungen'` when module or job is off); POST `/internal/cron/kk-beleg-erinnerungen`; POST `/admin/geplante-jobs/kk-beleg-erinnerungen/jetzt-ausfuehren`.
- Config keys: `kk_beleg_erinnerungen_aktiv` (`'1'`), `kk_beleg_erinnerung_tage` (`'45'`), `cron_kk_beleg_erinnerungen_stunde` (`'8'`), `cron_kk_beleg_erinnerungen_minute` (`'0'`).
- Mail template type `kk-beleg-erinnerung`, variables `%empfaengerName% %eintraege% %anzahl% %tage% %link% %portalName%`.

- [ ] **Step 1: Write the failing tests** (append to `test/unit/cronJobs.test.js`; add imports for `createKreditkarte`, `createKkBeleg`, `getKkBelegById`, `markiereJobAlsKkAbrechnung`, `createJob`, `runKkBelegErinnerungenJob`, `setConfigValue`, `seedDefaults`, `upsertPerson`, `openDatabase` as needed)

```js
function kkSetup() {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  upsertPerson(db, { id: '1', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Hoch', nachname: 'Lader', email: 'h@example.org', gruppen: [] });
  const karte = createKreditkarte(db, { bezeichnung: 'Visa', verantwortlichId: '1', erfassungOffen: true });
  const sent = [];
  return { db, karte, sent, mailer: { async sendMail(m) { sent.push(m); } } };
}
const vorTagen = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('runKkBelegErinnerungenJob mails uploader and responsible person once per interval, one mail per recipient', async () => {
  const t = kkSetup();
  const alt1 = createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/a.pdf', betrag: '1.00', kaufdatum: vorTagen(50).slice(0, 10), beschreibung: 'Alt 1', status: 'offen' });
  createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/b.pdf', betrag: '2.00', kaufdatum: vorTagen(60).slice(0, 10), beschreibung: 'Alt 2', status: 'offen' });
  createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: '/tmp/c.pdf', betrag: '3.00', kaufdatum: vorTagen(5).slice(0, 10), beschreibung: 'Neu', status: 'offen' });
  const ergebnis = await runKkBelegErinnerungenJob(t.db, { publicBaseUrl: 'https://p.example.org' }, t.mailer);
  assert.equal(ergebnis.status, 'erfolg');
  assert.equal(ergebnis.belege, 2);
  assert.deepEqual(t.sent.map((m) => m.to).sort(), ['h@example.org', 'v@example.org']);
  assert.match(t.sent[0].text, /Alt 1/);
  assert.doesNotMatch(t.sent[0].text, /Neu/);
  assert.ok(getKkBelegById(t.db, alt1).letzte_erinnerung_am);
  t.sent.length = 0;
  await runKkBelegErinnerungenJob(t.db, { publicBaseUrl: 'https://p.example.org' }, t.mailer);
  assert.equal(t.sent.length, 0, 'no second reminder within the interval');
});

test('runKkBelegErinnerungenJob reminds the assignee of a marked statement that has not been reconciled', async () => {
  const t = kkSetup();
  const jobId = createJob(t.db, { eingangAm: vorTagen(50), quelle: 'scanner', absender: null, dateiname: 'abrechnung.pdf', pdfPfad: '/tmp/x.pdf' });
  markiereJobAlsKkAbrechnung(t.db, jobId, { kreditkarteId: t.karte, verantwortlichId: '1', ausStatus: 'unzugewiesen' });
  t.db.prepare('UPDATE jobs SET kk_markiert_am = ? WHERE id = ?').run(vorTagen(50), jobId);
  const ergebnis = await runKkBelegErinnerungenJob(t.db, { publicBaseUrl: 'https://p.example.org' }, t.mailer);
  assert.equal(ergebnis.abrechnungen, 1);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'v@example.org');
  assert.match(t.sent[0].text, /abrechnung\.pdf/);
});

test('runKkBelegErinnerungenJob is skipped when the module or the job is off', async () => {
  const t = kkSetup();
  setConfigValue(t.db, 'kk_beleg_erinnerungen_aktiv', '0');
  assert.equal((await runKkBelegErinnerungenJob(t.db, {}, t.mailer)).status, 'uebersprungen');
  setConfigValue(t.db, 'kk_beleg_erinnerungen_aktiv', '1');
  setConfigValue(t.db, 'modul_kreditkarten_aktiv', '0');
  assert.equal((await runKkBelegErinnerungenJob(t.db, {}, t.mailer)).status, 'uebersprungen');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/cronJobs.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Repos**

Append to `src/db/kkBelegeRepo.js`:

```js
export function listKkBelegeFuerErinnerung(db, schwelleIso) {
  return db
    .prepare(
      `SELECT b.*, k.bezeichnung AS karte_bezeichnung, k.verantwortlich_id AS verantwortlich_id
       FROM kk_belege b LEFT JOIN kreditkarten k ON k.id = b.kreditkarte_id
       WHERE ((b.status = 'offen' AND b.kaufdatum <= ?) OR (b.status = 'entwurf' AND b.hochgeladen_am <= ?))
         AND (b.letzte_erinnerung_am IS NULL OR b.letzte_erinnerung_am <= ?)
       ORDER BY b.kaufdatum, b.id`
    )
    .all(schwelleIso.slice(0, 10), schwelleIso, schwelleIso);
}

export function markKkBelegErinnert(db, id) {
  db.prepare('UPDATE kk_belege SET letzte_erinnerung_am = ? WHERE id = ?').run(new Date().toISOString(), id);
}
```

Append to `src/db/jobsRepo.js`:

```js
export function listKkAbrechnungenFuerErinnerung(db, schwelleIso) {
  return db
    .prepare(
      `SELECT j.*, k.bezeichnung AS karte_bezeichnung FROM jobs j JOIN kreditkarten k ON k.id = j.kreditkarte_id
       WHERE j.status = 'zugewiesen' AND j.kk_markiert_am <= ? AND (j.kk_erinnert_am IS NULL OR j.kk_erinnert_am <= ?)
       ORDER BY j.kk_markiert_am`
    )
    .all(schwelleIso, schwelleIso);
}

export function markKkAbrechnungErinnert(db, jobId) {
  db.prepare('UPDATE jobs SET kk_erinnert_am = ? WHERE id = ?').run(new Date().toISOString(), jobId);
}
```

- [ ] **Step 4: Config and template**

`src/db/adminConfigRepo.js` `DEFAULTS`:

```js
  kk_beleg_erinnerungen_aktiv: '1',
  kk_beleg_erinnerung_tage: '45',
  cron_kk_beleg_erinnerungen_stunde: '8',
  cron_kk_beleg_erinnerungen_minute: '0',
  mail_vorlage_kk_beleg_erinnerung_betreff: 'Freigabeportal: Offene Kreditkartenbelege',
  mail_vorlage_kk_beleg_erinnerung_text: 'Hallo %empfaengerName%,\n\nfolgende Kreditkartenbelege bzw. -abrechnungen sind seit mehr als %tage% Tagen offen (%anzahl%):\n\n%eintraege%\n\nBitte im Freigabeportal anmelden: %link%\n\nFreundliche Grüsse\n%portalName%',
```

`src/services/mailTemplates.js` `TYP_ZU_KEY_INFIX`: `'kk-beleg-erinnerung': 'kk_beleg_erinnerung',`
`src/routes/admin/mailEinstellungen.js` `VORLAGEN_FELDER`: `['kkBelegErinnerungBetreff', 'mail_vorlage_kk_beleg_erinnerung_betreff'], ['kkBelegErinnerungText', 'mail_vorlage_kk_beleg_erinnerung_text'],`
`views/admin/mail-einstellungen-form.ejs`: one more block (label "Kreditkartenbelege – Erinnerung") like the one added in Etappe-1 Task 7.

- [ ] **Step 5: Job in `src/services/cronJobs.js`**

Import the four repo functions and `sendNotificationMitVertretung`; add:

```js
export async function runKkBelegErinnerungenJob(db, config, mailer) {
  if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1' || getConfigValue(db, 'kk_beleg_erinnerungen_aktiv') !== '1') {
    return { status: 'uebersprungen' };
  }
  const gestartetAm = new Date().toISOString();
  try {
    const tage = Number(getConfigValue(db, 'kk_beleg_erinnerung_tage')) || 45;
    const schwelleIso = new Date(Date.now() - tage * 86400000).toISOString();
    const link = `${config.publicBaseUrl}/kreditkarte`;

    // Pro Empfänger eine Mail mit allen Belegen, für die er zuständig ist (hochgeladen, gekauft
    // oder verantwortlich) -- sonst bekäme die verantwortliche Person pro Beleg eine eigene Mail.
    const belege = listKkBelegeFuerErinnerung(db, schwelleIso);
    const proPerson = new Map();
    for (const b of belege) {
      const zeile = `- ${b.kaufdatum || b.hochgeladen_am.slice(0, 10)} ${b.betrag ?? '?'} ${b.beschreibung || '(noch zu ergänzen)'}${b.karte_bezeichnung ? ` (${b.karte_bezeichnung})` : ''}`;
      for (const personId of new Set([b.hochgeladen_von, b.gekauft_von, b.verantwortlich_id].filter(Boolean))) {
        if (!proPerson.has(personId)) proPerson.set(personId, []);
        proPerson.get(personId).push(zeile);
      }
    }
    for (const [personId, eintraege] of proPerson) {
      const person = getPersonById(db, personId);
      if (!person || !person.aktiv) continue;
      await sendNotification(db, mailer, {
        to: person.email,
        typ: 'kk-beleg-erinnerung',
        jobId: null,
        variablen: { empfaengerName: `${person.vorname} ${person.nachname}`, eintraege: eintraege.join('\n'), anzahl: eintraege.length, tage, link },
      });
    }
    for (const b of belege) markKkBelegErinnert(db, b.id);

    const abrechnungen = listKkAbrechnungenFuerErinnerung(db, schwelleIso);
    for (const job of abrechnungen) {
      const person = getPersonById(db, job.zugewiesen_an);
      if (person && person.aktiv) {
        await sendNotificationMitVertretung(db, mailer, {
          person,
          typ: 'kk-beleg-erinnerung',
          jobId: job.id,
          variablen: {
            eintraege: `- Abrechnung "${job.dateiname}" (${job.karte_bezeichnung}) wartet auf den Abgleich: ${config.publicBaseUrl}/kontierung/${job.id}/kk-abgleich`,
            anzahl: 1,
            tage,
            link: `${config.publicBaseUrl}/kontierung/${job.id}/kk-abgleich`,
            grund: 'Kreditkartenabrechnung wartet auf den Abgleich',
          },
        });
      }
      markKkAbrechnungErinnert(db, job.id);
    }

    const ergebnis = { status: 'erfolg', belege: belege.length, abrechnungen: abrechnungen.length };
    logCronLauf(db, { job: 'kk-beleg-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'erfolg', details: `Belege: ${ergebnis.belege}, Abrechnungen: ${ergebnis.abrechnungen}` });
    return ergebnis;
  } catch (err) {
    logCronLauf(db, { job: 'kk-beleg-erinnerungen', gestartetAm, beendetAm: new Date().toISOString(), status: 'fehler', details: err.message });
    return { status: 'fehler', error: err.message };
  }
}
```

(`mail_log.job_id` is nullable, so `jobId: null` is fine.)

- [ ] **Step 6: Scheduler, cron route, admin page**

`src/services/scheduler.js`: import `runKkBelegErinnerungenJob`; add `runKkBelegErinnerungenJob: kkBelegErinnerungenJob` to the injectable `jobs` destructuring and default object; add:

```js
  scheduleDaily(
    () => zahlOderStandard(getConfigValue(db, 'cron_kk_beleg_erinnerungen_stunde'), 8),
    () => zahlOderStandard(getConfigValue(db, 'cron_kk_beleg_erinnerungen_minute'), 0),
    async () => {
      const result = await kkBelegErinnerungenJob(db, config, mailer);
      if (result.status === 'fehler') console.error('Geplanter kk-beleg-erinnerungen-Lauf fehlgeschlagen:', result.error);
    }
  );
```

If `test/unit/scheduler.test.js` passes a full fake `jobs` object and asserts on the number of scheduled timers, add the new fake/expectation there.

`src/routes/cron.js`: import and add `router.post('/kk-beleg-erinnerungen', …)` identical in shape to `/freigabe2-erinnerungen`.

`src/routes/admin/geplanteJobs.js`:
- import `runKkBelegErinnerungenJob`;
- `ladeState` + the 400 re-render: add `kkBelegErinnerungenAktiv: getConfigValue(db, 'kk_beleg_erinnerungen_aktiv') === '1'`, `kkBelegErinnerungTage`, `cronKkBelegErinnerungenStunde`, `cronKkBelegErinnerungenMinute`, `kkBelegErinnerungenLog: listRecentCronLog(db, 'kk-beleg-erinnerungen', LOG_LIMIT)` (in the re-render use the submitted `req.body` values);
- POST: destructure `kkBelegErinnerungenAktiv, kkBelegErinnerungTage, kkBelegErinnerungenStunde, kkBelegErinnerungenMinute`; validate with `ganzzahlImBereich(kkBelegErinnerungTage, 1, 365, 'Kreditkartenbelege: Tage')`, `ganzzahlImBereich(kkBelegErinnerungenStunde, 0, 23, …)`, `ganzzahlImBereich(kkBelegErinnerungenMinute, 0, 59, …)`; save the four keys (`aktiv` → `'1'`/`'0'`);
- add `router.post('/kk-beleg-erinnerungen/jetzt-ausfuehren', …)` like the freigabe2 one, redirecting to `?getriggert=kk-beleg-erinnerungen`.

`views/admin/geplante-jobs.ejs`: add a settings block before "PDF-Bereinigung" (checkbox `kkBelegErinnerungenAktiv`, number inputs `kkBelegErinnerungTage`, `kkBelegErinnerungenStunde`, `kkBelegErinnerungenMinute`) and a "Kreditkartenbelege-Erinnerungen — Verlauf" section copied from the Freigabe2 one (lines 255–282) with the new names.

Existing tests that POST the full geplante-jobs form (`grep -rn "freigabe2ErinnerungenIntervallMinuten" test/`) must get the three new numeric fields in their payload, or they'll now fail validation.

- [ ] **Step 7: Run tests and commit**

Run: `node --test test/unit/cronJobs.test.js test/unit/scheduler.test.js test/integration/cron.test.js` and the admin geplante-jobs tests — PASS; `npm test` — PASS.

```bash
git add src/ views/ test/
git commit -m "feat(kreditkarten): daily reminder for long-open receipts and unreconciled statements"
```

---

### Task 4: Automatische Kartenerkennung beim n8n-Eingang (6b)

**Files:**
- Modify: `src/db/jobsRepo.js` (extract `bewerteAbsenderMuster`, export `normalizeAbsender`)
- Create: `src/services/kkErkennung.js`
- Modify: `src/routes/n8n/jobs.js`
- Modify: `src/routes/admin/kreditkarten.js`, `views/admin/kreditkarten-form.ejs` (field `absenderMuster`)
- Modify: `src/db/jobsRepo.js` (new `setKkTextAnalyse`)
- Test: `test/unit/kkErkennung.test.js`, `test/integration/n8n/jobs.test.js` (append), `test/unit/jobsRepo.test.js` (existing Zuweisungsregel tests must stay green)

**Interfaces:**
- Produces:
  - `bewerteAbsenderMuster(absender, muster) → 'exakt' | 'domain' | null` (exported from `jobsRepo.js`; `findMatchingZuweisungsregel` re-implemented on top of it with identical semantics)
  - `normalizeAbsender` exported
  - `erkenneKarte(db, { absender, text }) → { karte, grund } | null`
  - `setKkTextAnalyse(db, jobId, analyse)` — stores `JSON.stringify(analyse)` in `jobs.kk_text_betraege`

- [ ] **Step 1: Write the failing tests**

`test/unit/kkErkennung.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { upsertPerson } from '../../src/db/personenRepo.js';
import { createKreditkarte, setKreditkarteAktiv } from '../../src/db/kreditkartenRepo.js';
import { erkenneKarte } from '../../src/services/kkErkennung.js';

function setup() {
  const db = openDatabase(':memory:');
  upsertPerson(db, { id: '1', vorname: 'A', nachname: 'B', email: 'a@example.org', gruppen: [] });
  const visa = createKreditkarte(db, { bezeichnung: 'Visa', karteEndziffern: '4242', verantwortlichId: '1', erfassungOffen: true, absenderMuster: 'viseca.ch' });
  const master = createKreditkarte(db, { bezeichnung: 'Master', karteEndziffern: '1111', verantwortlichId: '1', erfassungOffen: true, absenderMuster: 'abrechnung@bank.example' });
  return { db, visa, master };
}

test('erkenneKarte by sender domain, by exact sender, and by card digits', () => {
  const { db, visa, master } = setup();
  assert.equal(erkenneKarte(db, { absender: 'Viseca <noreply@mail.viseca.ch>', text: '' }).karte.id, visa);
  assert.equal(erkenneKarte(db, { absender: 'abrechnung@bank.example', text: '' }).karte.id, master);
  assert.equal(erkenneKarte(db, { absender: null, text: 'Karte **** 1111' }).karte.id, master);
  db.close();
});

test('erkenneKarte returns null when nothing or more than one card matches, and ignores inactive cards', () => {
  const { db, visa } = setup();
  assert.equal(erkenneKarte(db, { absender: 'x@y.example', text: 'nichts' }), null);
  assert.equal(erkenneKarte(db, { absender: 'noreply@viseca.ch', text: 'Karte **** 1111' }), null);
  setKreditkarteAktiv(db, visa, false);
  assert.equal(erkenneKarte(db, { absender: 'noreply@viseca.ch', text: '' }), null);
  db.close();
});
```

Append to `test/integration/n8n/jobs.test.js` (add imports `createKreditkarte`, `buildPdfFixture` already imported, `listFreigabenByJob`):

```js
test('POST /api/n8n/jobs auto-marks a statement when exactly one card matches, mails the responsible person once', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  upsertPerson(db, { id: '1', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  createKreditkarte(db, { bezeichnung: 'Visa Jugend', karteEndziffern: '4242', verantwortlichId: '1', erfassungOffen: true });
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-kk-'));
  const mailer = createStubMailer();
  const app = buildTestApp(db, { ...testConfig(jobsDir), publicBaseUrl: 'https://p.example.org' }, mailer);
  const pdf = await buildPdfFixture(['Visa Business **** 4242', 'Total 12.50']);
  const res = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key').field('quelle', 'scanner').field('dateiname', 'abrechnung.pdf').attach('pdf', pdf, 'abrechnung.pdf');
  assert.equal(res.status, 201);
  const job = getJobById(db, res.body.id);
  assert.equal(job.status, 'zugewiesen');
  assert.equal(job.zugewiesen_an, '1');
  assert.ok(job.kreditkarte_id);
  assert.ok(JSON.parse(job.kk_text_betraege).betraege.length > 0);
  assert.match(listFreigabenByJob(db, job.id).at(-1).kommentar, /automatisch/);
  assert.equal(mailer.sent.length, 1);
  rmSync(jobsDir, { recursive: true, force: true });
});

test('POST /api/n8n/jobs does not auto-mark when the module is off, and still succeeds for an unreadable-text PDF', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  upsertPerson(db, { id: '1', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  createKreditkarte(db, { bezeichnung: 'Visa', karteEndziffern: '4242', verantwortlichId: '1', erfassungOffen: true });
  const jobsDir = mkdtempSync(join(tmpdir(), 'jobs-kk-'));
  const app = buildTestApp(db, testConfig(jobsDir), createStubMailer());
  const pdf = await buildPdfFixture(['Visa **** 4242']);
  const r1 = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key').field('quelle', 'scanner').field('dateiname', 'a.pdf').attach('pdf', pdf, 'a.pdf');
  assert.equal(getJobById(db, r1.body.id).kreditkarte_id, null);
  setConfigValue(db, 'modul_kreditkarten_aktiv', '1');
  const r2 = await request(app).post('/api/n8n/jobs').set('X-API-Key', 'n8n-key').field('quelle', 'scanner').field('dateiname', 'b.pdf').attach('pdf', PDF_BYTES, 'b.pdf');
  assert.equal(r2.status, 201);
  rmSync(jobsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/kkErkennung.test.js test/integration/n8n/jobs.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Extract the sender matcher in `src/db/jobsRepo.js`**

Export `normalizeAbsender` (`export function normalizeAbsender…`). Add, and rewrite `findMatchingZuweisungsregel` on top of it:

```js
// 'exakt' = ganze Adresse gleich (case-insensitive), 'domain' = Muster ohne @ passt auf die Domain
// oder eine Subdomain davon. Gleiche Regeln wie bisher in findMatchingZuweisungsregel, jetzt auch
// für die Kreditkarten-Erkennung nutzbar.
export function bewerteAbsenderMuster(absender, muster) {
  const normalized = normalizeAbsender(absender);
  if (!normalized || !muster) return null;
  const absenderLower = normalized.toLowerCase();
  const musterLower = muster.toLowerCase();
  if (musterLower === absenderLower) return 'exakt';
  if (musterLower.includes('@')) return null;
  const domain = extractDomain(absenderLower);
  if (domain && (domain === musterLower || domain.endsWith(`.${musterLower}`))) return 'domain';
  return null;
}

export function findMatchingZuweisungsregel(db, absender) {
  const regeln = listZuweisungsregeln(db);
  return (
    regeln.find((r) => bewerteAbsenderMuster(absender, r.absender_muster) === 'exakt') ||
    regeln.find((r) => bewerteAbsenderMuster(absender, r.absender_muster) === 'domain') ||
    null
  );
}

export function setKkTextAnalyse(db, jobId, analyse) {
  db.prepare('UPDATE jobs SET kk_text_betraege = ? WHERE id = ?').run(JSON.stringify(analyse), jobId);
}
```

Run `node --test test/unit/jobsRepo.test.js test/unit/zuweisungsregelnRepo.test.js test/integration/n8n/jobs.test.js` — existing Zuweisungsregel tests must stay green.

- [ ] **Step 4: `src/services/kkErkennung.js`**

```js
import { listKreditkarten } from '../db/kreditkartenRepo.js';
import { bewerteAbsenderMuster } from '../db/jobsRepo.js';
import { findeEndziffern } from './kkTextAnalyse.js';

export function erkenneKarte(db, { absender, text }) {
  const karten = listKreditkarten(db);
  const treffer = new Map();
  for (const karte of karten) {
    if (karte.absender_muster && bewerteAbsenderMuster(absender, karte.absender_muster)) treffer.set(karte.id, { karte, grund: 'Absender' });
  }
  const ziffern = findeEndziffern(text);
  for (const karte of karten) {
    if (karte.karte_endziffern && ziffern.has(karte.karte_endziffern)) {
      const vorher = treffer.get(karte.id);
      treffer.set(karte.id, { karte, grund: vorher ? 'Absender + Endziffern' : 'Endziffern' });
    }
  }
  return treffer.size === 1 ? [...treffer.values()][0] : null;
}
```

- [ ] **Step 5: Hook into `src/routes/n8n/jobs.js`**

Import `extrahierePdfText`, `analysiereText`, `erkenneKarte`, `markiereAlsKkAbrechnung`, `setKkTextAnalyse`. After the QR-scan `try/catch` and **before** `const job = getJobById(db, id);`, insert:

```js
        let kkMarkiert = false;
        if (getConfigValue(db, 'modul_kreditkarten_aktiv') === '1') {
          try {
            const text = extrahierePdfText(req.file.buffer);
            const erkennung = erkenneKarte(db, { absender, text });
            if (erkennung) {
              setKkTextAnalyse(db, id, analysiereText(text));
              const aktuell = getJobById(db, id);
              kkMarkiert = await markiereAlsKkAbrechnung(db, config, mailer, {
                job: aktuell, karte: erkennung.karte, markiertVon: null, ip: 'system', ausStatus: aktuell.status, kommentarZusatz: ` — ${erkennung.grund}`,
              });
            }
          } catch (err) {
            console.error(`Kreditkarten-Erkennung fehlgeschlagen für Job ${id}:`, err.message);
          }
        }
```

and change the existing notification condition from `if (job.status === 'zugewiesen') {` to `if (job.status === 'zugewiesen' && !kkMarkiert) {` (the KK mail already went out).

`markiereJobAlsKkAbrechnung` accepts `ausStatus = 'zugewiesen'` too, so a statement a Zuweisungsregel already routed to someone is re-routed to the card's responsible person — intended (card detection has priority, spec 6b).

- [ ] **Step 6: Admin form field**

`views/admin/kreditkarten-form.ejs` — after the Endziffern row add:

```ejs
      <div class="mb-3">
        <label class="form-label" for="absenderMuster">Absender der Abrechnungs-Mail <span class="text-muted">(optional, z.B. viseca.ch oder abrechnung@bank.ch)</span></label>
        <input class="form-control" id="absenderMuster" name="absenderMuster" value="<%= werte.absenderMuster %>">
        <div class="form-text">Trifft genau eine Karte zu (Absender oder letzte 4 Ziffern im PDF), wird die Abrechnung automatisch dieser Karte zugeordnet.</div>
      </div>
```

The router already reads/writes `absenderMuster` (Etappe-1 Task 4).

- [ ] **Step 7: Run tests and commit**

Run: `node --test test/unit/kkErkennung.test.js test/integration/n8n/jobs.test.js test/unit/jobsRepo.test.js` — PASS; `npm test` — PASS.

```bash
git add src/db/jobsRepo.js src/services/kkErkennung.js src/routes/n8n/jobs.js views/admin/kreditkarten-form.ejs test/
git commit -m "feat(kreditkarten): auto-assign incoming statements to a card by sender or last four digits"
```

---

### Task 5: Zuordnungs-Vorschläge auf der Abgleich-Seite (6c)

**Files:**
- Modify: `src/routes/kkAbgleich.js`, `views/kk-abgleich.ejs`
- Test: `test/integration/kkAbgleich.test.js` (append)

**Interfaces:**
- Consumes: `extrahierePdfText`, `analysiereText`, `LEERE_ANALYSE`, `berechneVorschlaege` (Task 2); `setKkTextAnalyse` (Task 4).
- Produces: each offered receipt carries `vorschlag: 'betrag' | 'betrag_datum' | null`; `werte.gesamtbetrag` falls back to the analysed total.

- [ ] **Step 1: Write the failing tests** (append to `test/integration/kkAbgleich.test.js`)

```js
test('GET kk-abgleich pre-checks receipts whose amount appears on the statement and fills the total', async () => {
  const t = await setup();
  writeFileSync(getJobById(t.db, t.jobId).pdf_pfad, await buildPdfFixture(['03.09.2026 SBB 12.50', 'Total zu bezahlen 12.50']));
  const treffer = await t.beleg('12.50', 'Zugticket');
  await t.beleg('77.00', 'Nicht auf der Abrechnung');
  const res = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`value="${treffer}"[^>]*checked`));
  assert.match(res.text, /Vorschlag: Betrag \+ Datum/);
  assert.match(res.text, /id="gesamtbetrag"[^>]*value="12.50"/);
  assert.ok(getJobById(t.db, t.jobId).kk_text_betraege, 'analysis is cached');
  t.cleanup();
});

test('GET kk-abgleich renders without suggestions when the statement text cannot be read', async () => {
  const t = await setup();
  writeFileSync(getJobById(t.db, t.jobId).pdf_pfad, Buffer.from('%PDF-1.4\nkaputt'));
  await t.beleg('12.50', 'Zugticket');
  const res = await request(t.app).get(`/kontierung/${t.jobId}/kk-abgleich`).set('x-test-person-id', '1');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Vorschlag:/);
  t.cleanup();
});
```

(The `id="gesamtbetrag"[^>]*value=` assertion depends on attribute order in the view: `id` before `value` — as written in Etappe-1 Task 8.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/integration/kkAbgleich.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

In `src/routes/kkAbgleich.js` import `readFileSync` (already), `extrahierePdfText`, `analysiereText`, `LEERE_ANALYSE`, `berechneVorschlaege`, `setKkTextAnalyse`. Add:

```js
  // Einmal pro Abrechnung berechnet und in jobs.kk_text_betraege gecacht. Scheitert die
  // Extraktion, wird eine leere Analyse gecacht -- keine Vorschläge, aber auch kein erneuter Versuch
  // bei jedem Seitenaufruf.
  function ladeAnalyse(job) {
    if (job.kk_text_betraege) {
      try {
        return JSON.parse(job.kk_text_betraege);
      } catch {
        return LEERE_ANALYSE;
      }
    }
    let analyse = LEERE_ANALYSE;
    try {
      analyse = analysiereText(extrahierePdfText(readFileSync(job.pdf_pfad)));
    } catch (err) {
      console.error(`Textanalyse der Abrechnung ${job.id} fehlgeschlagen:`, err.message);
    }
    setKkTextAnalyse(db, job.id, analyse);
    return analyse;
  }
```

Change `offeneBelege(karteId)` to `offeneBelege(karteId, analyse)` and add `vorschlag: vorschlaege.get(b.id) ?? null` to each mapped receipt, where `const vorschlaege = berechneVorschlaege(roheBelege, analyse);`. In `renderSeite`, compute `const analyse = ladeAnalyse(job);` and pass it to `offeneBelege`. In the GET handler, set `gesamtbetrag: job.betrag || job.qr_betrag || ladeAnalyse(job).total || ''`.

In `views/kk-abgleich.ejs`, change the checkbox `checked` expression to:

```ejs
<%= (zeilen.length > 0 ? zeilen.some((z) => z.art === 'beleg' && String(z.belegId) === String(b.id)) : (errors.length === 0 && b.vorschlag)) ? 'checked' : '' %>
```

and render the badge in place of the empty `<span class="vorschlag-badge"></span>`:

```ejs
                  <% if (b.vorschlag) { %><span class="badge text-bg-info"><%= b.vorschlag === 'betrag_datum' ? 'Vorschlag: Betrag + Datum' : 'Vorschlag: Betrag gefunden' %></span><% } %>
```

The page's existing JS already creates lines for pre-checked boxes on load (`document.querySelectorAll('.beleg-check:checked')…dispatchEvent`).

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/integration/kkAbgleich.test.js` — PASS; `npm test` — PASS.

```bash
git add src/routes/kkAbgleich.js views/kk-abgleich.ejs test/integration/kkAbgleich.test.js
git commit -m "feat(kreditkarten): suggest matching receipts and the statement total on the Abgleich page"
```

---

### Task 6: Belege per Mail über n8n (6e)

**Files:**
- Create: `src/services/kkBelegEingang.js`
- Create: `src/routes/n8n/kkBelege.js`
- Modify: `src/db/personenRepo.js` (`findActivePersonByEmail`), `src/db/kkBelegeRepo.js` (`aktiviereKkBelegEntwurf`)
- Modify: `src/routes/kreditkarte.js` (Ergänzen = edit of an `entwurf` → `offen`)
- Modify: `src/app.js`, `src/services/notify.js` (`IMMER_SOFORT_TYPEN`), `src/services/mailTemplates.js`, `src/db/adminConfigRepo.js`, `src/routes/admin/mailEinstellungen.js`, `views/admin/mail-einstellungen-form.ejs`
- Test: `test/integration/n8n/kkBelege.test.js`, `test/integration/kreditkarte.test.js` (append)

**Interfaces:**
- Produces:
  - `findActivePersonByEmail(db, email) → person|null`
  - `aktiviereKkBelegEntwurf(db, id) → boolean`
  - `nimmKkBelegEntgegen(db, config, mailer, { absender, buffer, mimetype, originalname }) → Promise<{ status: 201|422|409, body }>` (reusable by a future native mail module)
  - `POST /api/n8n/kk-belege` (X-API-Key; multipart `pdf` + `absender`)
  - Mail template type `kk-beleg-eingegangen` (always immediate), variables `%empfaengerName% %link% %portalName%`.

- [ ] **Step 1: Write the failing tests**

`test/integration/n8n/kkBelege.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/index.js';
import { upsertPerson } from '../../../src/db/personenRepo.js';
import { seedDefaults, setConfigValue } from '../../../src/db/adminConfigRepo.js';
import { createKreditkarte, setErfasser } from '../../../src/db/kreditkartenRepo.js';
import { getKkBelegById } from '../../../src/db/kkBelegeRepo.js';
import { requireApiKey } from '../../../src/middleware/apiKey.js';
import { createN8nKkBelegeRouter } from '../../../src/routes/n8n/kkBelege.js';
import { buildPdfFixture } from '../../helpers/pdfFixture.js';
import { PNG_1X1 } from '../../helpers/imageFixture.js';

function setup({ modul = '1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kk-mail-'));
  const config = { n8nApiKey: 'n8n-key', jobsDir: dir, publicBaseUrl: 'https://p.example.org' };
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'modul_kreditkarten_aktiv', modul);
  setConfigValue(db, 'mail_batching_aktiv', '1'); // proves kk-beleg-eingegangen bypasses batching
  upsertPerson(db, { id: '1', vorname: 'Ver', nachname: 'Antwortlich', email: 'v@example.org', gruppen: [] });
  upsertPerson(db, { id: '2', vorname: 'Anna', nachname: 'Kauf', email: 'Anna.Kauf@example.org', gruppen: [] });
  const karte = createKreditkarte(db, { bezeichnung: 'Visa Zu', verantwortlichId: '1', erfassungOffen: false });
  setErfasser(db, karte, ['2']);
  const sent = [];
  const app = express();
  app.use('/api/n8n/kk-belege', requireApiKey(config), createN8nKkBelegeRouter({ db, config, mailer: { async sendMail(m) { sent.push(m); } } }));
  return { db, app, karte, sent, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a known sender creates an Entwurf with the only allowed card pre-filled, plus suggestions, and gets an immediate mail', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['Quittung 03.09.2026', 'Total CHF 12.50']);
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'Anna <anna.kauf@example.org>').attach('pdf', pdf, 'quittung.pdf');
  assert.equal(res.status, 201);
  const b = getKkBelegById(t.db, res.body.id);
  assert.equal(b.status, 'entwurf');
  assert.equal(b.quelle, 'mail');
  assert.equal(b.hochgeladen_von, '2');
  assert.equal(b.kreditkarte_id, t.karte);
  assert.equal(b.betrag, '12.50');
  assert.equal(b.kaufdatum, '2026-09-03');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, 'Anna.Kauf@example.org');
  t.cleanup();
});

test('an image receipt by mail is converted to PDF', async () => {
  const t = setup();
  const res = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', PNG_1X1, { filename: 'foto.png', contentType: 'image/png' });
  assert.equal(res.status, 201);
  assert.ok(getKkBelegById(t.db, res.body.id).pdf_pfad.endsWith('.pdf'));
  t.cleanup();
});

test('unknown sender → 422, module off → 409, bad file → 400', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['x']);
  const r1 = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'fremd@example.org').attach('pdf', pdf, 'x.pdf');
  assert.equal(r1.status, 422);
  assert.equal(r1.body.fehler, 'absender_unbekannt');
  const r2 = await request(t.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', Buffer.from('nope'), 'x.pdf');
  assert.equal(r2.status, 400);
  t.cleanup();
  const t2 = setup({ modul: '0' });
  const r3 = await request(t2.app).post('/api/n8n/kk-belege').set('X-API-Key', 'n8n-key').field('absender', 'anna.kauf@example.org').attach('pdf', pdf, 'x.pdf');
  assert.equal(r3.status, 409);
  t2.cleanup();
});
```

Append to `test/integration/kreditkarte.test.js`:

```js
test('completing an Entwurf moves it to offen; the Entwurf is not offered on any card list before', async () => {
  const t = setup();
  const pdf = await buildPdfFixture(['Beleg']);
  const { pdfPfad } = await (await import('../../src/services/kkBelegDatei.js')).speichereKkBelegDatei({ jobsDir: t.dir }, pdf, 'application/pdf');
  const { createKkBeleg } = await import('../../src/db/kkBelegeRepo.js');
  const id = createKkBeleg(t.db, { kreditkarteId: null, hochgeladenVon: '3', gekauftVon: '3', quelle: 'mail', pdfPfad, status: 'entwurf' });
  const seite = await request(t.app).get('/kreditkarte').set('x-test-person-id', '3');
  assert.match(seite.text, /Zu ergänzen/);
  const res = await request(t.app).post(`/kreditkarte/belege/${id}`).set('x-test-person-id', '3')
    .field('kreditkarteId', String(t.offen)).field('betrag', '4.20').field('kaufdatum', '2026-09-01').field('beschreibung', 'Kaffee Team');
  assert.equal(res.status, 302);
  const b = getKkBelegById(t.db, id);
  assert.equal(b.status, 'offen');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM kk_beleg_ereignisse WHERE beleg_id = ? AND aktion = 'kk_beleg_ergaenzt'").get(id).n, 1);
  t.cleanup();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/integration/n8n/kkBelege.test.js test/integration/kreditkarte.test.js`
Expected: FAIL.

- [ ] **Step 3: Repos, template, immediate type**

`src/db/personenRepo.js`:

```js
export function findActivePersonByEmail(db, email) {
  if (!email) return null;
  const row = db.prepare('SELECT churchtools_person_id FROM personen WHERE aktiv = 1 AND LOWER(email) = LOWER(?) ORDER BY churchtools_person_id LIMIT 1').get(email.trim());
  return row ? getPersonById(db, row.churchtools_person_id) : null;
}
```

`src/db/kkBelegeRepo.js`:

```js
export function aktiviereKkBelegEntwurf(db, id) {
  const result = db
    .prepare("UPDATE kk_belege SET status = 'offen' WHERE id = ? AND status = 'entwurf' AND kreditkarte_id IS NOT NULL AND betrag IS NOT NULL AND kaufdatum IS NOT NULL AND beschreibung IS NOT NULL")
    .run(id);
  return result.changes > 0;
}
```

`src/services/notify.js`: `const IMMER_SOFORT_TYPEN = new Set(['sync-fehler', 'iban-warnung', 'kk-beleg-eingegangen']);` and extend the comment above it.
`src/services/mailTemplates.js`: `'kk-beleg-eingegangen': 'kk_beleg_eingegangen',`
`src/db/adminConfigRepo.js`:

```js
  mail_vorlage_kk_beleg_eingegangen_betreff: 'Freigabeportal: Kreditkartenbeleg eingegangen – bitte ergänzen',
  mail_vorlage_kk_beleg_eingegangen_text: 'Hallo %empfaengerName%,\n\ndein per Mail eingereichter Kreditkartenbeleg ist im Portal eingegangen. Bitte ergänze Karte, Betrag, Kaufdatum und Beschreibung: %link%\n\nFreundliche Grüsse\n%portalName%',
```

plus `VORLAGEN_FELDER` entries `kkBelegEingegangenBetreff/Text` and a form block "Kreditkartenbeleg eingegangen".

- [ ] **Step 4: `src/services/kkBelegEingang.js`**

```js
import { findActivePersonByEmail } from '../db/personenRepo.js';
import { normalizeAbsender } from '../db/jobsRepo.js';
import { getConfigValue } from '../db/adminConfigRepo.js';
import { createKkBeleg, logKkBelegEreignis } from '../db/kkBelegeRepo.js';
import { detectBelegMimetype } from './belegAnhaengen.js';
import { listErfassbareKarten } from './kkRechte.js';
import { speichereKkBelegDatei } from './kkBelegDatei.js';
import { extrahierePdfText } from './pdfText.js';
import { schlageTotalVor, findeDaten } from './kkTextAnalyse.js';
import { scanQrBill } from './qrBillScan.js';
import { sendNotification } from './notify.js';

// Gemeinsamer Einstieg für Belege, die per Mail eintreffen -- heute über n8n
// (routes/n8n/kkBelege.js), später auch vom nativen Mail-Modul aufrufbar. Liefert Status + Body,
// damit der Aufrufer selbst entscheidet, wie er antwortet.
export async function nimmKkBelegEntgegen(db, config, mailer, { absender, buffer }) {
  if (getConfigValue(db, 'modul_kreditkarten_aktiv') !== '1') return { status: 409, body: { fehler: 'modul_deaktiviert' } };
  const person = findActivePersonByEmail(db, normalizeAbsender(absender));
  if (!person) return { status: 422, body: { fehler: 'absender_unbekannt' } };
  const mimetype = buffer ? detectBelegMimetype(buffer) : null;
  if (!mimetype) return { status: 400, body: { fehler: 'datei_ungueltig' } };

  let betrag = null;
  let kaufdatum = null;
  if (mimetype === 'application/pdf') {
    try {
      const qr = scanQrBill(buffer);
      if (qr?.betrag) betrag = Number(qr.betrag).toFixed(2);
    } catch (err) {
      console.error('QR-Erkennung für Mail-Beleg fehlgeschlagen:', err.message);
    }
    try {
      const text = extrahierePdfText(buffer);
      betrag = betrag ?? schlageTotalVor(text);
      const heute = new Date().toISOString().slice(0, 10);
      kaufdatum = findeDaten(text).map((d) => d.datum).find((d) => d <= heute) ?? null;
    } catch (err) {
      console.error('Textanalyse für Mail-Beleg fehlgeschlagen:', err.message);
    }
  }

  const karten = listErfassbareKarten(db, person.churchtools_person_id);
  const { pdfPfad, thumbnailPfad } = await speichereKkBelegDatei(config, buffer, mimetype);
  const id = createKkBeleg(db, {
    kreditkarteId: karten.length === 1 ? karten[0].id : null,
    hochgeladenVon: person.churchtools_person_id,
    gekauftVon: person.churchtools_person_id,
    quelle: 'mail',
    pdfPfad,
    thumbnailPfad,
    betrag,
    kaufdatum,
    beschreibung: null,
    kontoId: null,
    status: 'entwurf',
  });
  logKkBelegEreignis(db, { belegId: id, personId: person.churchtools_person_id, aktion: 'kk_beleg_erfasst', kommentar: 'per Mail eingegangen' });
  await sendNotification(db, mailer, {
    to: person.email,
    typ: 'kk-beleg-eingegangen',
    jobId: null,
    variablen: { empfaengerName: `${person.vorname} ${person.nachname}`, link: `${config.publicBaseUrl}/kreditkarte/belege/${id}/bearbeiten` },
  });
  return { status: 201, body: { id, status: 'entwurf' } };
}
```

- [ ] **Step 5: Route `src/routes/n8n/kkBelege.js` and mount**

```js
import { Router } from 'express';
import multer from 'multer';
import { nimmKkBelegEntgegen } from '../../services/kkBelegEingang.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

export function createN8nKkBelegeRouter({ db, config, mailer }) {
  const router = Router();
  router.post('/', (req, res, next) => {
    upload.single('pdf')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) return res.status(400).json({ fehler: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'datei_zu_gross' : 'upload_fehler' });
        const { status, body } = await nimmKkBelegEntgegen(db, config, mailer, { absender: req.body.absender, buffer: req.file?.buffer });
        res.status(status).json(body);
      } catch (err) {
        next(err);
      }
    });
  });
  return router;
}
```

`src/app.js`: import and add after the `/api/n8n/backup` line:

```js
  app.use('/api/n8n/kk-belege', machineLimiter, requireApiKey(config), createN8nKkBelegeRouter({ db, config, mailer }));
```

(`/api/n8n/*` is already CSRF-exempt.)

- [ ] **Step 6: Ergänzen in `src/routes/kreditkarte.js`**

In `POST /belege/:id`, after the successful `updateKkBelegDaten` (and file replacement), replace the single `logKkBelegEreignis(… 'kk_beleg_geaendert' …)` with:

```js
          if (beleg.status === 'entwurf') {
            aktiviereKkBelegEntwurf(db, beleg.id);
            logKkBelegEreignis(db, { belegId: beleg.id, personId: personId(req), aktion: 'kk_beleg_ergaenzt', kommentar: null });
          } else {
            logKkBelegEreignis(db, { belegId: beleg.id, personId: personId(req), aktion: 'kk_beleg_geaendert', kommentar: req.file ? 'inkl. neuer Datei' : null });
          }
```

(import `aktiviereKkBelegEntwurf`). `pruefeFelder` already requires card, amount, date and description, so a completed Entwurf always satisfies `aktiviereKkBelegEntwurf`'s WHERE.

- [ ] **Step 7: Docs for n8n**

In `docs/n8n-schnittstelle.md` add a section "Kreditkarten-Beleg-Eingang": endpoint, fields (`pdf` — PDF/PNG/JPEG despite the name, `absender` — raw `From:` header), responses (201 `{id, status:'entwurf'}`, 400, 409, 422 `{fehler:'absender_unbekannt'}`), and a workflow sketch: IMAP trigger on a dedicated "belege@" mailbox → split attachments → one POST per attachment → on 422 send a reply "Absender unbekannt".

- [ ] **Step 8: Run tests and commit**

Run: `node --test test/integration/n8n/kkBelege.test.js test/integration/kreditkarte.test.js test/unit/notify.test.js` — PASS; `npm test` — PASS.

```bash
git add src/ views/ docs/n8n-schnittstelle.md test/
git commit -m "feat(kreditkarten): accept receipts by mail via n8n as drafts to be completed"
```

---

### Task 7: Fristlöschung verworfener Belege (6f)

**Files:**
- Modify: `src/db/kkBelegeRepo.js`, `src/services/cronJobs.js` (`runPdfBereinigungJob`), `src/db/adminConfigRepo.js`
- Modify: `src/routes/admin/geplanteJobs.js`, `views/admin/geplante-jobs.ejs`
- Test: `test/unit/cronJobs.test.js` (append)

**Interfaces:**
- Produces: `listVerworfeneKkBelegeZurLoeschung(db, schwelleIso) → row[]`, `markKkBelegDateiGeloescht(db, id)`; config key `kk_beleg_verworfen_loeschen_tage` (`'90'`); `runPdfBereinigungJob` result gains `kkBelegeGeloescht`.

- [ ] **Step 1: Write the failing test** (append to `test/unit/cronJobs.test.js`)

```js
test('runPdfBereinigungJob deletes files of receipts discarded longer than the retention period, keeps the row, is idempotent', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'kk-frist-'));
  const t = kkSetup();
  const datei = (name) => { const p = join(dir, name); writeFileSync(p, 'x'); return p; };
  const alt = createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: datei('alt.pdf'), thumbnailPfad: datei('alt.png'), betrag: '1.00', kaufdatum: '2026-01-01', beschreibung: 'alt', status: 'verworfen' });
  t.db.prepare('UPDATE kk_belege SET verworfen_am = ?, verworfen_grund = ? WHERE id = ?').run(vorTagen(100), 'doppelt', alt);
  const jung = createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: datei('jung.pdf'), betrag: '1.00', kaufdatum: '2026-01-01', beschreibung: 'jung', status: 'verworfen' });
  t.db.prepare('UPDATE kk_belege SET verworfen_am = ? WHERE id = ?').run(vorTagen(10), jung);
  const zugeordnet = createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: datei('zu.pdf'), betrag: '1.00', kaufdatum: '2026-01-01', beschreibung: 'zu', status: 'zugeordnet' });
  const weg = createKkBeleg(t.db, { kreditkarteId: t.karte, hochgeladenVon: '2', gekauftVon: '2', quelle: 'web', pdfPfad: join(dir, 'gibtsnicht.pdf'), betrag: '1.00', kaufdatum: '2026-01-01', beschreibung: 'weg', status: 'verworfen' });
  t.db.prepare('UPDATE kk_belege SET verworfen_am = ? WHERE id = ?').run(vorTagen(100), weg);

  const r1 = runPdfBereinigungJob(t.db, { jobsDir: dir });
  assert.equal(r1.kkBelegeGeloescht, 2);
  const a = getKkBelegById(t.db, alt);
  assert.equal(a.pdf_pfad, null);
  assert.equal(a.thumbnail_pfad, null);
  assert.ok(a.datei_geloescht_am);
  assert.equal(a.verworfen_grund, 'doppelt');
  assert.equal(existsSync(join(dir, 'alt.pdf')), false);
  assert.ok(getKkBelegById(t.db, jung).pdf_pfad);
  assert.ok(getKkBelegById(t.db, zugeordnet).pdf_pfad);
  assert.ok(getKkBelegById(t.db, weg).datei_geloescht_am);
  assert.equal(runPdfBereinigungJob(t.db, { jobsDir: dir }).kkBelegeGeloescht, 0);
  rmSync(dir, { recursive: true, force: true });
});
```

(`kkSetup`/`vorTagen` are defined in Task 3's additions to the same file.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/unit/cronJobs.test.js`
Expected: FAIL (`kkBelegeGeloescht` undefined).

- [ ] **Step 3: Implement**

`src/db/kkBelegeRepo.js`:

```js
export function listVerworfeneKkBelegeZurLoeschung(db, schwelleIso) {
  return db
    .prepare("SELECT * FROM kk_belege WHERE status = 'verworfen' AND verworfen_am <= ? AND datei_geloescht_am IS NULL ORDER BY id")
    .all(schwelleIso);
}

export function markKkBelegDateiGeloescht(db, id) {
  db.prepare('UPDATE kk_belege SET pdf_pfad = NULL, thumbnail_pfad = NULL, datei_geloescht_am = ? WHERE id = ? AND datei_geloescht_am IS NULL').run(new Date().toISOString(), id);
}
```

`src/db/adminConfigRepo.js` `DEFAULTS`: `kk_beleg_verworfen_loeschen_tage: '90',`

`src/services/cronJobs.js` in `runPdfBereinigungJob`, after the mail_log block:

```js
  // Verworfene Kreditkartenbelege: nach der Frist nur die Dateien löschen, die Zeile bleibt als
  // Nachweis (wer/wann/warum verworfen). Zugeordnete Belege sind Teil eines Buchungsdokuments und
  // werden hier nie angefasst.
  let kkBelegeGeloescht = 0;
  try {
    const tage = Number(getConfigValue(db, 'kk_beleg_verworfen_loeschen_tage')) || 90;
    const schwelle = new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString();
    for (const beleg of listVerworfeneKkBelegeZurLoeschung(db, schwelle)) {
      let alleWeg = true;
      for (const pfad of [beleg.pdf_pfad, beleg.thumbnail_pfad]) {
        if (!pfad) continue;
        try {
          if (existsSync(pfad)) unlinkSync(pfad);
        } catch (err) {
          console.error(`Löschen von ${pfad} (Kreditkartenbeleg ${beleg.id}) fehlgeschlagen:`, err.message);
          alleWeg = alleWeg && !existsSync(pfad);
        }
      }
      if (!alleWeg) continue;
      markKkBelegDateiGeloescht(db, beleg.id);
      logKkBelegEreignis(db, { belegId: beleg.id, personId: null, aktion: 'kk_beleg_datei_geloescht', kommentar: `Frist ${tage} Tage nach Verwerfen` });
      kkBelegeGeloescht += 1;
    }
  } catch (err) {
    console.error('Fristlöschung verworfener Kreditkartenbelege fehlgeschlagen:', err.message);
  }
```

Add `kkBelegeGeloescht` to `ergebnis` and append `, KK-Belege gelöscht: ${kkBelegeGeloescht}` to the `details` string. Import `listVerworfeneKkBelegeZurLoeschung, markKkBelegDateiGeloescht, logKkBelegEreignis`.

`src/routes/admin/geplanteJobs.js` / `views/admin/geplante-jobs.ejs`: in the "PDF-Bereinigung & Mail-Log-Retention" block add a number field `kkBelegVerworfenLoeschenTage` (label "Verworfene Kreditkartenbelege löschen nach (Tagen)", 1–3650); wire it through `ladeState` (`kkBelegVerworfenLoeschenTage: getConfigValue(db, 'kk_beleg_verworfen_loeschen_tage')`), the 400 re-render, validation (`ganzzahlImBereich(…, 1, 3650, …)`) and `setConfigValue`. Update existing tests that POST the full form with the new field.

Existing tests asserting the exact pdf-bereinigung `details` string (`grep -rn "Mail-Log bereinigt" test/`) need the new suffix.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/unit/cronJobs.test.js test/integration/pdfBereinigungEndToEnd.test.js` — PASS; `npm test` — PASS.

```bash
git add src/ views/ test/
git commit -m "feat(kreditkarten): delete files of discarded receipts after a retention period"
```

---

### Task 8: CSRF-Sweep und Dokumentation

**Files:**
- Modify: `test/integration/csrfSweep.test.js`
- Modify: `docs/kreditkarten-belege.md`, `docs/geplante-jobs-und-benachrichtigungen.md`, `docs/admin-bereich.md`, `docs/datenmodell.md`

- [ ] **Step 1: Sweep**

Append `'/admin/geplante-jobs/kk-beleg-erinnerungen/jetzt-ausfuehren'` to `SESSION_POST_ROUTES`. In the machine-routes test, add a request to `/api/n8n/kk-belege` with `X-API-Key: n8n-key` asserting `notEqual(res.status, 403)` like the existing `/api/n8n/jobs` check, and to `/internal/cron/kk-beleg-erinnerungen` like the other cron routes there.

Run: `node --test test/integration/csrfSweep.test.js` — PASS.

- [ ] **Step 2: Docs**

- `docs/kreditkarten-belege.md`: new sections for 6a–6f (reminder cron + config keys, automatic detection rules and priority over Zuweisungsregeln, suggestion heuristics and their limits, mail intake + Entwurf lifecycle, retention deletion). Replace the "Etappe 2 folgt" note.
- `docs/geplante-jobs-und-benachrichtigungen.md`: `kk-beleg-erinnerungen` job, the new pdf-bereinigung step, the three mail templates (which are batched, which are immediate).
- `docs/admin-bereich.md`: new geplante-jobs fields, card field "Absender der Abrechnungs-Mail".
- `docs/datenmodell.md`: note that `jobs.kk_text_betraege` holds the cached analysis JSON `{ betraege, daten, total }`.

- [ ] **Step 3: Full suite and commit**

Run: `npm test` — PASS.

```bash
git add test/integration/csrfSweep.test.js docs/
git commit -m "docs(kreditkarten): document the Etappe-2 extensions and cover new routes in the CSRF sweep"
```
