import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

async function pruefe(pfad, als, { feld, konflikt, kein }) {
  const page = await b.neueSeite(pfad, { als });
  const hinweis = page.locator(`label[for="${feld}"] [data-begruendung-hinweis]`);
  assert.equal(await page.locator(`#${feld}`).evaluate((e) => e.required), false);
  assert.match(await hinweis.textContent(), /bei Ablehnung Pflicht/);
  await page.locator(konflikt).check();
  assert.equal(await page.locator(`#${feld}`).evaluate((e) => e.required), true);
  assert.match(await hinweis.textContent(), /Pflicht/);
  assert.doesNotMatch(await hinweis.textContent(), /bei Ablehnung/);
  await page.locator(kein).check();
  assert.equal(await page.locator(`#${feld}`).evaluate((e) => e.required), false);
  assert.match(await hinweis.textContent(), /bei Ablehnung Pflicht/);
  await page.close();
}

test('Begründung wird bei Interessenskonflikt Pflicht', async () => {
  await pruefe(`/kontierung/${b.server.ids.anna}`, 'test-1', { feld: 'begruendung', konflikt: '#konfliktJa', kein: '#konfliktNein' });
  await pruefe(`/freigabe2/${b.server.ids.freigabe2}`, 'test-2', { feld: 'f2begruendung', konflikt: '#f2konfliktJa', kein: '#f2konfliktNein' });
});

test('Fehlerlink zum Lieferanten fokussiert das sichtbare Suchfeld', async () => {
  const page = await b.neueSeite(`/kontierung/${b.server.ids.anna}`, { als: 'test-1' });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/kontierung/${b.server.ids.anna}`)),
    page.evaluate(() => {
      document.getElementById('kontierung-form').noValidate = true;
      document.querySelector('button[name=aktion][value=kontieren]').click();
    }),
  ]);
  await page.waitForSelector('.alert-danger a[href^="#kreditorId"]');
  await page.click('.alert-danger a[href^="#kreditorId"]');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'kreditorId-suche');
  await page.close();
});

test('Fehlerlink springt nicht unter die haftende Kopfleiste (1280 px)', async () => {
  const page = await b.neueSeite(`/kontierung/${b.server.ids.anna}`, { als: 'test-1', breite: 1280 });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/kontierung/${b.server.ids.anna}`)),
    page.evaluate(() => {
      document.getElementById('kontierung-form').noValidate = true;
      document.querySelector('button[name=aktion][value=kontieren]').click();
    }),
  ]);
  await page.waitForSelector('.alert-danger a[href^="#"]');
  const ziele = await page.$$eval('.alert-danger a[href^="#"]', (as) => as.map((a) => a.getAttribute('href').slice(1)));
  // Ein Feld mit Beschriftung weit unten wählen, damit wirklich gescrollt werden muss.
  let ziel = null;
  for (const id of ziele.reverse()) { if (await page.locator(`label[for="${id}"]`).count()) { ziel = id; break; } }
  assert.ok(ziel, 'Fehlerlink mit Beschriftung vorhanden');
  await page.setViewportSize({ width: 1280, height: 400 }); // niedrig, damit das Ziel wirklich an den oberen Rand scrollen muss
  // Der Link steht oben; erst nach unten scrollen und dann nach oben springen lassen (Ziel würde sonst am Rand kleben).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.evaluate((id) => document.querySelector(`.alert-danger a[href="#${id}"]`).click(), ziel);
  await page.waitForTimeout(800);
  const m = await page.evaluate((id) => ({
    kopfUnten: document.querySelector('.portal-oben').getBoundingClientRect().bottom,
    labelOben: (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.getElementById(id)).getBoundingClientRect().top,
  }), ziel);
  assert.ok(m.labelOben >= m.kopfUnten - 1, `Feld (${m.labelOben}) unter Kopfleiste (${m.kopfUnten})`);
  await page.close();
});
