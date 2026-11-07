import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

// Langer Inhalt, damit wirklich gescrollt werden kann.
async function verlaengern(page) {
  await page.evaluate(() => {
    const h = document.createElement('div');
    h.style.height = '4000px';
    (document.querySelector('.portal-inhalt') || document.body).appendChild(h);
  });
}
const rechteck = (page, sel) => page.locator(sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
});

test('1280 px: Kopf klebt nach dem Scrollen oben, Seitenleiste überlappt nicht', async () => {
  const page = await b.neueSeite('/pool', { breite: 1280 });
  await verlaengern(page);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(300);
  const oben = await rechteck(page, '.portal-oben');
  assert.equal(oben.top, 0);
  const kopf = await rechteck(page, 'header.portal-kopf');
  const band = await rechteck(page, '.testmodus-band');
  assert.ok(band.top === 0 && Math.abs(kopf.top - band.bottom) < 1.5, 'Kopf direkt unter dem Band');
  assert.ok(kopf.bottom > kopf.top);
  const leiste = await rechteck(page, '.portal-seitenleiste');
  assert.ok(leiste.top >= kopf.bottom - 0.5, `Seitenleiste ${leiste.top} unter Kopf ${kopf.bottom}`);
  await page.close();
});

test('1280 px: Farbmodus-Menü öffnet sich vollständig sichtbar', async () => {
  const page = await b.neueSeite('/pool', { breite: 1280 });
  await verlaengern(page);
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.click('#theme-toggle');
  await page.waitForSelector('.farbmodus-liste.show');
  const sichtbar = await page.locator('.farbmodus-liste [data-farbmodus="system"]').evaluate((e) => {
    const r = e.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return e.contains(t) || t === e;
  });
  assert.ok(sichtbar, 'letzter Menüpunkt ist nicht verdeckt');
  await page.close();
});

test('768 px: Kopf scrollt mit weg', async () => {
  const page = await b.neueSeite('/pool', { breite: 768 });
  await verlaengern(page);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(300);
  const kopf = await rechteck(page, 'header.portal-kopf');
  assert.ok(kopf.bottom <= 0, `Kopf bottom ${kopf.bottom}`);
  await page.close();
});
