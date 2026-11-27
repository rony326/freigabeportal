import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createKonto } from '../../src/db/kontenRepo.js';
import { createJob, getJobById } from '../../src/db/jobsRepo.js';
import { setBerechtigungenForPerson } from '../../src/db/personBerechtigungenRepo.js';
import { starteBrowser } from './helfer.js';

async function beispielPdf() {
  const doc = await PDFDocument.create();
  doc.addPage().drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
  return Buffer.from(await doc.save());
}

let b;
before(async () => {
  b = await starteBrowser();
  // Ein Konto, bei dem Anna (test-1) weder Freigeberin noch Stellvertretung ist.
  createKonto(b.server.db, { kontonummer: '7777', bezeichnung: 'Fremdes Konto', freigeber1Id: 'test-2', stellvertreter1Id: 'test-3', freigeber2Id: 'test-4', stellvertreter2Id: 'test-3' });
});
after(async () => { await b.stop(); });

// Aufsplitten als Assistent neben dem Beleg (views/_aufsplitten_assistent.ejs, public/js/aufsplitten-assistent.js).
const kontierung = () => `/kontierung/${b.server.ids.anna}`;
const BANNER = '[data-pflicht-banner="aufsplitten-form"]';

async function oeffnen(page) {
  await page.locator('#kontierung-bereich .dropdown-toggle').click();
  await page.locator('[data-aufsplitten-oeffnen]').click();
  await page.locator('#aufsplitten-bereich').waitFor({ state: 'visible' });
}

async function sichtbareSchritte(page) {
  const sichtbar = [];
  for (const n of ['1', '2', '3']) {
    if (await page.locator(`section[data-schritt="${n}"]`).isVisible()) sichtbar.push(n);
  }
  return sichtbar;
}

// Eigener Vorgang bei Anna (test-1) ohne QR-Code, mit den Werten eines n8n-Eingangs (KI-Werte, noch unbestätigt).
let vorgangNr = 0;
function neuerVorgang() {
  vorgangNr += 1;
  const { db, ids } = b.server;
  const id = createJob(db, {
    eingangAm: new Date().toISOString(), quelle: 'scanner', absender: null, dateiname: `Verhalten_${vorgangNr}.pdf`,
    pdfPfad: getJobById(db, ids.anna).pdf_pfad, dateiHash: `verhalten-aufsplitten-${vorgangNr}`,
  });
  db.prepare("UPDATE jobs SET status = 'zugewiesen', zugewiesen_an = 'test-1', rechnungsnummer = 'KI-4711', zahlungsziel = '2026-12-31', betrag_vorschlag = '120.00' WHERE id = ?").run(id);
  return id;
}

const weiter = (page) => page.locator('#split-weiter').click();
const zeile = (page, i) => page.locator('#teile-container .teil-zeile').nth(i);

async function konten(page) {
  return page.evaluate(() => [...document.querySelector('#teile-container select').options]
    .filter((o) => o.value && !o.disabled).map((o) => ({ id: o.value, text: o.textContent.trim(), eigen: o.hasAttribute('data-eigenes-konto') })));
}

async function schritt2(page, { gesamt = '210.00', versand = '10.00' } = {}) {
  await page.locator('#split-kreditorId').selectOption(String(b.server.ids.langerKreditor));
  await page.locator('#gesamtbetrag').fill(gesamt);
  await page.locator('#versandkosten').fill(versand);
  await weiter(page);
  await page.locator('section[data-schritt="2"]').waitFor({ state: 'visible' });
}

async function fuelleTeil(page, i, kontoId, betrag) {
  await zeile(page, i).locator('select[name="teilKontoId"]').selectOption(kontoId);
  await zeile(page, i).locator('input[name="teilBetrag"]').fill(betrag);
}

test('Assistent öffnet neben dem Beleg und übernimmt die Werte', async () => {
  const kreditorId = String(b.server.ids.langerKreditor);
  const page = await b.neueSeite(kontierung(), { als: 'test-1' });
  const url = page.url();
  await page.evaluate((id) => {
    const setze = (feldId, wert) => { const f = document.getElementById(feldId); f.value = wert; f.dispatchEvent(new Event('change', { bubbles: true })); };
    setze('kreditorId', id);
    setze('betrag', '321.45');
    document.getElementById('typGutschrift').click();
    // Pflicht- und KI-Banner der Kontierung stehen oberhalb der geteilten Ansicht.
    document.querySelector('[data-pflicht-banner="kontierung-form"]').hidden = false;
  }, kreditorId);
  await oeffnen(page);

  assert.equal(page.url(), url, 'kein Neuladen');
  assert.equal(await page.locator('#kontierung-preview-frame').isVisible(), true);
  assert.equal(await page.locator('#kontierung-bereich').isVisible(), false);
  assert.equal(await page.locator('[data-pflicht-banner="kontierung-form"]').isVisible(), false);
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  assert.equal(await page.locator('#split-schritt-anzeige').textContent(), 'Schritt 1 von 3');
  assert.equal(await page.locator('#split-zurueck').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'split-ueberschrift');
  assert.equal(await page.locator('#split-kreditorId').inputValue(), kreditorId);
  assert.equal(await page.locator('#gesamtbetrag').inputValue(), '321.45');
  assert.equal(await page.locator('#split-typGutschrift').isChecked(), true);

  // Nur beim ersten Öffnen: eigene Eingaben im Assistenten bleiben.
  await page.locator('#gesamtbetrag').fill('99.00');
  await page.locator('[data-aufsplitten-abbrechen]').click();
  assert.equal(await page.locator('[data-pflicht-banner="kontierung-form"]').isVisible(), true);
  await oeffnen(page);
  assert.equal(await page.locator('#gesamtbetrag').inputValue(), '99.00');
});

test('Neu angelegter Lieferant und KI-Haken gehen in den Assistenten mit', async () => {
  const page = await b.neueSeite(`/kontierung/${neuerVorgang()}`, { als: 'test-1' });
  // Wie «+ Lieferant»: die neue Auswahl steht nur in der Kontierung.
  await page.evaluate(() => {
    const option = new Option('Neuer Lieferant <b>AG</b>', '987654', true, true);
    option.setAttribute('data-iban-pflicht', '1');
    document.getElementById('kreditorId').appendChild(option);
    document.getElementById('rechnungsnummer').value = 'RE-2';
    document.getElementById('rechnungsnummer').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('bestaetigt-betrag').click();
  });
  await oeffnen(page);
  assert.equal(await page.locator('#split-kreditorId').inputValue(), '987654');
  assert.equal(await page.locator('#split-kreditorId option:checked').textContent(), 'Neuer Lieferant <b>AG</b>');
  assert.equal(await page.locator('#split-rechnungsnummer').inputValue(), 'RE-2');
  assert.equal(await page.locator('#split-zahlungsziel').inputValue(), '2026-12-31');
  assert.equal(await page.locator('#split-bestaetigt-rechnungsnummer').isChecked(), true);
  assert.equal(await page.locator('#split-bestaetigt-betrag').isChecked(), true);
  assert.equal(await page.locator('#split-bestaetigt-zahlungsziel').isChecked(), false);
  assert.equal(await page.locator('#split-iban-manuell-kasten').isVisible(), true);

  // Offener KI-Haken: bleibt in Schritt 1, Meldung im Banner.
  await page.locator('#split-ibanEndung').fill('2957');
  await weiter(page);
  await page.locator(BANNER).waitFor({ state: 'visible' });
  assert.match(await page.locator(BANNER).textContent(), /automatisch erkannt[\s\S]*Zahlungsziel/);
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  await page.locator('label[for="split-bestaetigt-zahlungsziel"]').click();
  await weiter(page);
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  assert.equal(await page.locator(BANNER).isVisible(), false);

  // Später angelegter Lieferant: beim erneuten Öffnen auch auswählbar, die Auswahl im Assistenten bleibt.
  await page.locator('[data-aufsplitten-abbrechen]').click();
  await page.evaluate(() => document.getElementById('kreditorId').appendChild(new Option('Später AG', '987655', true, true)));
  await oeffnen(page);
  assert.equal(await page.locator('#split-kreditorId option[value="987655"]').count(), 1);
  assert.equal(await page.locator('#split-kreditorId').inputValue(), '987654');
});

test('Weiter erst mit gültigen Angaben', async () => {
  const page = await b.neueSeite(kontierung(), { als: 'test-1' });
  await oeffnen(page);
  await page.locator('#split-kreditorId').selectOption(String(b.server.ids.langerKreditor));
  await page.locator('#gesamtbetrag').fill('');
  await weiter(page);
  await page.locator(BANNER).waitFor({ state: 'visible' });
  assert.match(await page.locator(BANNER).textContent(), /Gesamtbetrag/);
  assert.deepEqual(await sichtbareSchritte(page), ['1']);

  for (const [gesamt, versand, meldung] of [['abc', '', /gültigen Gesamtbetrag/], ['100.00', 'x', /gültige Versandkosten/], ['100.00', '100', /kleiner als der Gesamtbetrag/]]) {
    await page.locator('#gesamtbetrag').fill(gesamt);
    await page.locator('#versandkosten').fill(versand);
    await weiter(page);
    assert.match(await page.locator(BANNER).textContent(), meldung);
    assert.deepEqual(await sichtbareSchritte(page), ['1']);
  }

  await schritt2(page, { gesamt: '210.00', versand: '10.00' });
  assert.equal(await page.locator('#split-schritt-anzeige').textContent(), 'Schritt 2 von 3');
  const liste = await konten(page);
  const eigen = liste.find((k) => k.eigen);
  const fremd = liste.find((k) => !k.eigen);
  assert.ok(eigen && fremd);

  await fuelleTeil(page, 0, eigen.id, '120.00');
  assert.equal(await page.locator('#split-stand').textContent(), 'Verteilt 120.00 von 200.00 – offen 80.00');
  await weiter(page);
  await page.locator(BANNER).waitFor({ state: 'visible' });
  assert.match(await page.locator(BANNER).textContent(), /Mindestens zwei Teile/);
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  assert.match(await page.locator('#split-stand').textContent(), /offen 80\.00/);

  await fuelleTeil(page, 1, fremd.id, '90.00');
  assert.equal(await page.locator('#split-stand').textContent(), 'Verteilt 210.00 von 200.00 – 10.00 zu viel');
  await weiter(page);
  assert.match(await page.locator(BANNER).textContent(), /10\.00 zu viel/);
  assert.deepEqual(await sichtbareSchritte(page), ['2']);

  // Halb ausgefüllte Zeile.
  await page.locator('#zeile-hinzufuegen').click();
  await zeile(page, 2).locator('input[name="teilBetrag"]').fill('5');
  await weiter(page);
  assert.match(await page.locator(BANNER).textContent(), /Zeile 3: Konto/);
  await zeile(page, 2).locator('.zeile-entfernen').click();
  await zeile(page, 1).locator('input[name="teilBetrag"]').fill('80.00');
  assert.match(await page.locator('#split-stand').textContent(), /offen 0\.00/);

  // Konflikt: nur auf einem eigenen Konto zählt er (wie auf dem Server).
  await zeile(page, 1).locator('.konflikt-checkbox').check();
  await weiter(page);
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.match(await page.locator('#split-zusammenfassung').textContent(), /ohne Wirkung/);
  await page.locator('#split-zurueck').click();
  await zeile(page, 0).locator('.konflikt-checkbox').check();
  await weiter(page);
  assert.match(await page.locator(BANNER).textContent(), /Begründung/);
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  // Der Banner-Link führt zum Feld.
  await page.locator(`${BANNER} a`).first().click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'split-begruendung');
  await page.locator('#split-begruendung').fill('Mein Verein');
  await weiter(page);
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.match(await page.locator('#split-zusammenfassung').textContent(), /Interessenskonflikt/);
});

test('Enter sendet nicht ab, sondern geht einen Schritt weiter', async () => {
  const page = await b.neueSeite(`${kontierung()}?aufsplitten=1`, { als: 'test-1' });
  const url = page.url();
  await page.locator('#split-kreditorId').selectOption(String(b.server.ids.langerKreditor));
  await page.locator('#gesamtbetrag').fill('100.00');
  await page.locator('#gesamtbetrag').press('Enter');
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  assert.equal(page.url(), url);
  await zeile(page, 0).locator('input[name="teilBetrag"]').press('Enter');
  await page.locator(BANNER).waitFor({ state: 'visible' });
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  assert.equal(page.url(), url);
});

test('Abbrechen zeigt wieder die Kontierung, Eingaben und Pflicht-Banner funktionieren', async () => {
  const page = await b.neueSeite(kontierung(), { als: 'test-1' });
  const url = page.url();
  await page.locator('#rechnungsnummer').fill('R-123');
  await oeffnen(page);
  await page.locator('[data-aufsplitten-abbrechen]').click();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('#aufsplitten-bereich').isVisible(), false);
  assert.equal(await page.locator('#kontierung-bereich').isVisible(), true);
  assert.equal(await page.locator('#kontierung-bereich .dropdown-menu').isVisible(), false);
  assert.equal(await page.locator('#rechnungsnummer').inputValue(), 'R-123');
  assert.equal(await page.evaluate(() => document.activeElement.matches('#kontierung-bereich .dropdown-toggle')), true);
  await page.evaluate(() => { document.getElementById('kontoId').value = ''; });
  await page.locator('button[name="aktion"][value="kontieren"]').click();
  const banner = page.locator('[data-pflicht-banner="kontierung-form"]');
  await banner.waitFor({ state: 'visible' });
  assert.match(await banner.textContent(), /Konto/);
});

test('Vom Server abgelehnt: Start in Schritt 1, ein Link im KI-Banner führt auch aus Schritt 2 zum Feld', async () => {
  const page = await b.neueSeite(`/kontierung/${neuerVorgang()}?aufsplitten=1`, { als: 'test-1' });
  await Promise.all([
    page.waitForURL(/\/aufsplitten$/),
    page.evaluate(() => HTMLFormElement.prototype.submit.call(document.getElementById('aufsplitten-form'))),
  ]);
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  await page.evaluate(() => document.querySelector('#teile-container input').dispatchEvent(new CustomEvent('pflicht:zeige', { bubbles: true })));
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  await page.locator('#aufsplitten-bereich [data-ki-banner] a', { hasText: 'Zahlungsziel' }).click();
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'split-zahlungsziel');
});

test('Der Beleg bleibt beim Scrollen im Blick, nur solange der Assistent offen ist', async () => {
  const page = await b.neueSeite(kontierung(), { als: 'test-1' });
  const belegPosition = () => page.evaluate(() => getComputedStyle(document.getElementById('kontierung-preview-frame').parentElement).position);
  const hoehe = () => page.evaluate(() => document.getElementById('kontierung-preview-frame').getBoundingClientRect().height);
  assert.equal(await belegPosition(), 'static');
  const normal = await hoehe();
  await oeffnen(page);
  assert.equal(await belegPosition(), 'sticky');
  await schritt2(page);
  for (let i = 0; i < 4; i += 1) await page.locator('#zeile-hinzufuegen').click();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const mass = await page.evaluate(() => {
    const frame = document.getElementById('kontierung-preview-frame').getBoundingClientRect();
    // Sichtbar ist nur, was unterhalb von klebender Kopfzeile samt Testmodus-Band liegt.
    const kopf = Math.max(0, document.querySelector('.portal-oben').getBoundingClientRect().bottom);
    return { sichtbar: Math.min(frame.bottom, window.innerHeight) - Math.max(frame.top, kopf), oben: frame.top, hoehe: frame.height, fenster: window.innerHeight, kopf, gescrollt: window.scrollY };
  });
  assert.ok(mass.gescrollt > mass.fenster, `Seite ist lang genug: ${JSON.stringify(mass)}`);
  assert.ok(mass.sichtbar > mass.fenster / 2, JSON.stringify(mass));
  // Auch ganz unten (Seitenfuss) verschwindet der obere Rand mit der PDF-Werkzeugleiste nicht unter der Kopfzeile.
  assert.ok(mass.oben >= mass.kopf, `ganz unter der Kopfzeile: ${JSON.stringify(mass)}`);
  await page.locator('[data-aufsplitten-abbrechen]').click();
  assert.equal(await belegPosition(), 'static');
  assert.equal(await hoehe(), normal);
});

test('Der Erklärtext steht nur in Schritt 2', async () => {
  const page = await b.neueSeite(`${kontierung()}?aufsplitten=1`, { als: 'test-1' });
  const text = page.getByText('Jede Zeile wird zu einer eigenständigen Rechnung');
  assert.equal(await text.isVisible(), false);
  await schritt2(page);
  assert.equal(await text.isVisible(), true);
  await fuelleTeil(page, 0, (await konten(page))[0].id, '120.00');
  await fuelleTeil(page, 1, (await konten(page))[0].id, '80.00');
  await weiter(page);
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.equal(await text.isVisible(), false);
});

// «+ Lieferant» in der Seitenleiste bleibt bei offenem Assistenten bedienbar: der echte Weg über den Dialog.
async function legeLieferantAn(page, name, iban) {
  await page.getByRole('button', { name: '+ Lieferant' }).click();
  const dialog = page.locator('#neuer-lieferant-modal');
  await dialog.locator('#neuer-lieferant-name').fill(name);
  await dialog.locator('#neuer-lieferant-iban').fill(iban);
  const antwort = page.waitForResponse((r) => r.url().endsWith('/kontierung/lieferanten'));
  await dialog.locator('#neuer-lieferant-speichern').click();
  const res = await antwort;
  assert.equal(res.status(), 201, await res.text());
  await dialog.waitFor({ state: 'hidden' });
  return page.locator('#kreditorId').inputValue();
}

for (const [fall, pfad, iban] of [
  ['im Browser geöffnet', '', 'AT61 1904 3002 3457 3201'],
  ['vom Server offen geliefert', '?aufsplitten=1', 'DE89 3704 0044 0532 0130 00'],
]) {
  test(`«+ Lieferant» bei offenem Assistenten (${fall}): neuer Lieferant ist dort gewählt, IBAN-Kasten folgt`, async () => {
    setBerechtigungenForPerson(b.server.db, 'test-1', ['kreditoren_verwalten']);
    const page = await b.neueSeite(`/kontierung/${neuerVorgang()}${pfad}`, { als: 'test-1' });
    if (!pfad) await oeffnen(page);
    assert.equal(await page.locator('#split-iban-manuell-kasten').isVisible(), false);
    const id = await legeLieferantAn(page, `Dialog AG ${fall}`, iban);
    assert.match(id, /^\d+$/);
    assert.equal(await page.locator('#split-kreditorId').inputValue(), id);
    assert.equal(await page.locator(`#split-kreditorId option[value="${id}"]`).getAttribute('data-iban-pflicht'), '1');
    await page.locator('#split-iban-manuell-kasten').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#split-ibanEndung').getAttribute('required') !== null, true);
  });
}

// Titel und Schritt-Kopf liegen im Fenster und unterhalb dessen, was oben klebt (Kopfzeile bzw. Testmodus-Band).
async function wartetImBlick(page, selektor) {
  const mass = () => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    let kleben = 0;
    for (const e of document.querySelectorAll('.portal-oben, .testmodus-band')) {
      if (getComputedStyle(e).position === 'sticky') kleben = Math.max(kleben, e.getBoundingClientRect().bottom);
    }
    return { oben: r.top, unten: r.bottom, kleben, fenster: window.innerHeight };
  }, selektor);
  let m;
  for (let i = 0; i < 40; i += 1) { // sanftes Scrollen abwarten
    m = await mass();
    if (m.oben >= m.kleben && m.unten <= m.fenster) return;
    await page.waitForTimeout(50);
  }
  assert.fail(`${selektor} nicht im Blick: ${JSON.stringify(m)}`);
}

for (const [breite, hoehe] of [[360, 700], [800, 700], [1280, 800]]) {
  test(`Schrittwechsel am Ende eines langen Schritts zeigt Kopf, Titel und Banner (${breite}x${hoehe})`, async () => {
    const page = await b.neueSeite(`${kontierung()}?aufsplitten=1`, { als: 'test-1' });
    await page.setViewportSize({ width: breite, height: hoehe });
    await page.locator('#split-kreditorId').selectOption(String(b.server.ids.langerKreditor));
    await page.locator('#gesamtbetrag').fill('100.00');
    await page.locator('#versandkosten').press('Enter');
    await wartetImBlick(page, '#split-kopf');
    await wartetImBlick(page, '#split-schritt-2-titel');
    const eigen = (await konten(page))[0].id;
    await fuelleTeil(page, 0, eigen, '60.00');
    // Mehrere Teile: auch Schritt 3 ist höher als das Fenster, der Browser rückt also nicht von selbst nach oben.
    await fuelleTeil(page, 1, eigen, '10.00');
    for (let i = 2; i < 5; i += 1) {
      await page.locator('#zeile-hinzufuegen').click();
      await fuelleTeil(page, i, eigen, '10.00');
    }
    await zeile(page, 4).locator('input[name="teilPosition"]').press('Enter');
    await wartetImBlick(page, '#split-kopf');
    await wartetImBlick(page, '#split-schritt-3-titel');
    // Fehler beim unteren «Weiter»: das Banner oben in der Karte ist nicht von der Kopfzeile verdeckt.
    await page.locator('#split-zurueck').click();
    await zeile(page, 1).locator('input[name="teilBetrag"]').fill('30.00');
    await page.locator('#split-weiter-unten-2').click();
    await wartetImBlick(page, BANNER);
  });
}

test('«Zurück» und «Weiter» stehen auch am Ende von Schritt 1 und 2', async () => {
  const page = await b.neueSeite(`${kontierung()}?aufsplitten=1`, { als: 'test-1', breite: 360 });
  const url = page.url();
  assert.equal(await page.locator('#split-zurueck-unten-1').count(), 0);
  await page.locator('#split-kreditorId').selectOption(String(b.server.ids.langerKreditor));
  await page.locator('#gesamtbetrag').fill('');
  await page.locator('#split-weiter-unten-1').click();
  await page.locator(BANNER).waitFor({ state: 'visible' });
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  await page.locator('#gesamtbetrag').fill('100.00');
  await page.locator('#split-weiter-unten-1').click();
  assert.deepEqual(await sichtbareSchritte(page), ['2']);
  for (const id of ['#split-zurueck-unten-2', '#split-weiter-unten-2']) {
    const kasten = await page.locator(id).boundingBox();
    assert.ok(kasten.height >= 44 && kasten.width >= 44, `${id}: ${JSON.stringify(kasten)}`);
    assert.equal(await page.locator(id).getAttribute('type'), 'button');
  }
  await page.locator('#split-zurueck-unten-2').click();
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  assert.equal(await page.locator('#gesamtbetrag').inputValue(), '100.00');
  await page.locator('#split-weiter-unten-1').click();
  const eigen = (await konten(page))[0].id;
  await fuelleTeil(page, 0, eigen, '60.00');
  await fuelleTeil(page, 1, eigen, '40.00');
  await page.locator('#split-weiter-unten-2').click();
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.equal(page.url(), url);
});

// Zuletzt: teilt den Vorgang wirklich auf.
test('Zusammenfassung zeigt Versandanteile, Zurück erhält die Eingaben, Aufsplitten landet im Pool', async () => {
  const page = await b.neueSeite(`${kontierung()}?aufsplitten=1`, { als: 'test-1' });
  await schritt2(page, { gesamt: '210.00', versand: '10.00' });
  const liste = await konten(page);
  const eigen = liste.find((k) => k.eigen);
  await fuelleTeil(page, 0, eigen.id, '120.00');
  await fuelleTeil(page, 1, eigen.id, '80,00');
  await zeile(page, 0).locator('.teil-beleg-input').setInputFiles({ name: 'einzel<beleg>.pdf', mimeType: 'application/pdf', buffer: await beispielPdf() });
  await page.locator('#zeile-hinzufuegen').click(); // leere Zeile zählt nicht
  await weiter(page);
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.equal(await page.locator('#split-weiter').isVisible(), false);
  const teile = page.locator('#split-zusammenfassung li');
  assert.equal(await teile.count(), 2);
  assert.match(await teile.nth(0).textContent(), new RegExp(`${eigen.text}[\\s\\S]*120\\.00[\\s\\S]*5\\.00[\\s\\S]*125\\.00[\\s\\S]*einzel<beleg>\\.pdf`));
  assert.match(await teile.nth(1).textContent(), /80\.00[\s\S]*5\.00[\s\S]*85\.00/);
  assert.match(await page.locator('#split-zusammenfassung').textContent(), /Summe 210\.00 = Gesamtbetrag 210\.00/);

  await page.locator('#split-zurueck').click();
  assert.equal(await zeile(page, 0).locator('input[name="teilBetrag"]').inputValue(), '120.00');
  assert.equal(await zeile(page, 1).locator('input[name="teilBetrag"]').inputValue(), '80,00');
  await page.locator('#split-zurueck').click();
  assert.equal(await page.locator('#versandkosten').inputValue(), '10.00');
  await weiter(page);
  await weiter(page);

  // Ein Pflicht-Banner-Link auf ein Feld eines früheren Schritts wechselt dorthin.
  await page.evaluate(() => { document.getElementById('gesamtbetrag').value = ''; });
  await page.getByRole('button', { name: 'Aufsplitten', exact: true }).click();
  await page.locator(BANNER).waitFor({ state: 'visible' });
  await page.locator(`${BANNER} a`, { hasText: 'Gesamtbetrag' }).click();
  assert.deepEqual(await sichtbareSchritte(page), ['1']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gesamtbetrag');
  await page.locator('#gesamtbetrag').fill('210.00');
  await weiter(page);
  await weiter(page);

  // QR-Betrag und IBAN des Belegs passen nicht: Prüf-Popup, Seite kommt in Schritt 3 zurück.
  await page.getByRole('button', { name: 'Aufsplitten', exact: true }).click();
  const popup = page.locator('#auffaelligkeiten-modal.show');
  await popup.waitFor({ state: 'visible' });
  assert.deepEqual(await sichtbareSchritte(page), ['3']);
  assert.match(await page.locator('#split-zusammenfassung').textContent(), /125\.00[\s\S]*85\.00/);
  await popup.locator('input[type="file"]').setInputFiles({ name: 'einzel.pdf', mimeType: 'application/pdf', buffer: await beispielPdf() });
  await popup.locator('[data-auffaelligkeiten-bestaetigen]').click();
  await page.waitForURL(/\/pool$/);
});
