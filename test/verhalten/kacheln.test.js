import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => {
  b = await starteBrowser();
  // Vorschaubild für die Freigabe-2-Kachel (die Datei muss nicht existieren: der Link wird trotzdem gerendert).
  b.server.db.prepare('UPDATE jobs SET thumbnail_pfad = ? WHERE id = ?').run('/tmp/gibt-es-nicht.png', b.server.ids.freigabe2);
});
after(async () => { await b.stop(); });

test('Klick auf Kachelfläche öffnet Hauptaktion', async () => {
  const page = await b.neueSeite('/pool?ansicht=kacheln', { als: 'test-2', breite: 1280 });
  const kachel = page.locator(`#freigabe2-kachel-${b.server.ids.freigabe2}`);
  // Echter Mausklick auf die Titelzeile: der gestreckte Link der Kachel fängt ihn ab.
  const titel = kachel.locator('.fw-semibold').first();
  await titel.scrollIntoViewIfNeeded();
  const box = await titel.boundingBox();
  await page.mouse.click(box.x + 5, box.y + box.height / 2);
  await page.waitForURL((u) => u.pathname === `/freigabe2/${b.server.ids.freigabe2}`);
  await page.close();
});

test('Klick auf Vorschaubild öffnet Vorschau, nicht Hauptaktion', async () => {
  const page = await b.neueSeite('/pool?ansicht=kacheln', { als: 'test-2', breite: 1280 });
  const url = page.url();
  await page.locator(`#freigabe2-kachel-${b.server.ids.freigabe2} .thumbnail-link`).click();
  await page.waitForSelector('#preview-dialog[open]');
  assert.equal(page.url(), url);
  await page.close();
});

test('Vorschau-Dialog hat transform-origin vom Bild', async () => {
  const page = await b.neueSeite('/pool?ansicht=kacheln', { als: 'test-2', breite: 1280 });
  await page.locator(`#freigabe2-kachel-${b.server.ids.freigabe2} .thumbnail-link`).click();
  await page.waitForSelector('#preview-dialog[open]');
  await page.waitForTimeout(500);
  const d = await page.evaluate((id) => {
    const dlg = document.getElementById('preview-dialog');
    const bild = document.querySelector('#freigabe2-kachel-' + id + ' .thumbnail-link').getBoundingClientRect();
    const r = dlg.getBoundingClientRect();
    const [x, y] = getComputedStyle(dlg).transformOrigin.split(' ').map(parseFloat);
    return { x, y, erwartetX: bild.left + bild.width / 2 - r.left, erwartetY: bild.top + bild.height / 2 - r.top,
      inline: dlg.style.transformOrigin, breite: r.width, hoehe: r.height };
  }, b.server.ids.freigabe2);
  assert.ok(d.inline, 'transform-origin nicht gesetzt');
  assert.ok(Math.abs(d.x - d.erwartetX) < 3 && Math.abs(d.y - d.erwartetY) < 3, JSON.stringify(d));
  assert.ok(Math.abs(d.x - d.breite / 2) > 3 || Math.abs(d.y - d.hoehe / 2) > 3, 'Mitte des Dialogs');
  await page.close();
});

test('Gehaltener Druck auf die Kachelfläche (Touch) navigiert zur Hauptaktion', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const kontext = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, isMobile: true });
  const page = await kontext.newPage();
  await page.goto(`${b.server.url}/pool?ansicht=kacheln&als=test-2`);
  const titel = page.locator(`#freigabe2-kachel-${b.server.ids.freigabe2} .fw-semibold`).first();
  await titel.scrollIntoViewIfNeeded();
  const box = await titel.boundingBox();
  assert.ok(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'pointer: coarse');
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForURL((u) => u.pathname === `/freigabe2/${b.server.ids.freigabe2}`);
  await browser.close();
});
