import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

test('Zuweisen ersetzt Zeile ohne Neuladen', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  let navigiert = 0;
  page.on('framenavigated', () => { navigiert++; });
  const form = page.locator('.zuweisen-form:visible').first();
  await form.waitFor();
  const option = form.locator('select option:not([value=""])').first();
  const text = (await option.textContent()).trim();
  await form.locator('select').selectOption({ index: 1 });
  await form.locator('button[type=submit]').click();
  await page.getByText(`An ${text} gesendet ✓`).first().waitFor({ timeout: 5000 });
  assert.equal(navigiert, 0);
});

test('data-bestaetigen-Formular: Abbrechen sendet nichts, Bestätigen genau einmal', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  const posts = [];
  await page.route('**/testziel-bestaetigen', (route) => { posts.push(1); route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }); });
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.id = 'test-bestaetigen'; f.method = 'post'; f.action = '/testziel-bestaetigen';
    f.setAttribute('data-bestaetigen', 'Wirklich?'); f.setAttribute('data-bestaetigen-knopf', 'Löschen'); f.setAttribute('data-bestaetigen-gefahr', '');
    f.innerHTML = '<button type="submit" id="test-bestaetigen-knopf">Los</button>';
    document.querySelector('main').appendChild(f);
  });
  const dialog = page.locator('#bestaetigen-dialog');
  await page.click('#test-bestaetigen-knopf');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('bestaetigen-dialog').classList.contains('show'));
  await page.waitForTimeout(400);
  assert.match(await dialog.textContent(), /Wirklich\?/);
  await page.click('#bestaetigen-dialog-abbrechen');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForTimeout(300);
  assert.equal(posts.length, 0);

  await page.click('#test-bestaetigen-knopf');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#bestaetigen-dialog-ok.btn-danger').count());
  await Promise.all([page.waitForNavigation(), page.click('#bestaetigen-dialog-ok')]);
  assert.equal(posts.length, 1);
});

test('Gefahr-Bestätigung: Fokus liegt auf Abbrechen, Enter sendet nichts', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  let posts = 0;
  await page.route('**/testziel-gefahr', (route) => { posts++; route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }); });
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'post'; f.action = '/testziel-gefahr';
    f.setAttribute('data-bestaetigen', 'Wirklich?'); f.setAttribute('data-bestaetigen-gefahr', '');
    f.innerHTML = '<button type="submit" id="test-gefahr-knopf">Los</button>';
    document.querySelector('main').appendChild(f);
  });
  await page.click('#test-gefahr-knopf');
  await page.waitForFunction(() => document.getElementById('bestaetigen-dialog').classList.contains('show'));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'bestaetigen-dialog-abbrechen');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert.equal(posts, 0);
  await page.close();
});

test('Gefahr-Bestätigung ohne Dialog sendet nicht still ab (Rückfall auf window.confirm)', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  let posts = 0;
  await page.route('**/testziel-gefahr2', (route) => { posts++; route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }); });
  const gefragt = [];
  page.on('dialog', (d) => { gefragt.push(d.message()); d.dismiss(); });
  await page.evaluate(() => {
    document.getElementById('bestaetigen-dialog').remove();
    const f = document.createElement('form');
    f.method = 'post'; f.action = '/testziel-gefahr2';
    f.setAttribute('data-bestaetigen', 'Wirklich?'); f.setAttribute('data-bestaetigen-gefahr', '');
    f.innerHTML = '<button type="submit" id="test-gefahr-knopf2">Los</button>';
    document.querySelector('main').appendChild(f);
  });
  await page.click('#test-gefahr-knopf2');
  await page.waitForTimeout(500);
  assert.deepEqual(gefragt, ['Wirklich?']);
  assert.equal(posts, 0);
  await page.close();
});
