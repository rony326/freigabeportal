import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

function merkePosts(page) {
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r); });
  return posts;
}

test('Ablehnen öffnet Rückfrage, Abbrechen sendet nichts', async () => {
  const page = await b.neueSeite(`/freigabe2/${b.server.ids.freigabe2}`, { als: 'test-2' });
  const posts = merkePosts(page);
  await page.fill('#f2begruendung', 'Test');
  await page.click('button[name=aktion][value=ablehnen]');
  await page.waitForSelector('#ablehnen-dialog.show');
  assert.equal(await page.inputValue('#ablehnen-dialog-begruendung'), 'Test');
  await page.fill('#ablehnen-dialog-begruendung', 'Test 2');
  await page.click('#ablehnen-dialog-abbrechen');
  await page.waitForSelector('#ablehnen-dialog', { state: 'hidden' });
  assert.equal(posts.length, 0);
  assert.equal(await page.inputValue('#f2begruendung'), 'Test 2');
  await page.close();
});

test('Leere Begründung hält den Dialog offen', async () => {
  const page = await b.neueSeite(`/freigabe2/${b.server.ids.freigabe2}`, { als: 'test-2' });
  const posts = merkePosts(page);
  await page.click('button[name=aktion][value=ablehnen]');
  await page.waitForSelector('#ablehnen-dialog.show');
  await page.click('#ablehnen-dialog-bestaetigen');
  assert.ok(await page.locator('#ablehnen-dialog-begruendung').evaluate((e) => e.classList.contains('is-invalid')));
  assert.equal(await page.locator('#ablehnen-dialog.show').count(), 1);
  assert.equal(posts.length, 0);
  await page.close();
});

test('Pool: In den Pool legen fragt Hinweis-Konto', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-1' });
  const knopf = page.locator('[data-zurueck-in-pool]:visible').first();
  const jobId = await knopf.getAttribute('data-zurueck-in-pool');
  await knopf.click();
  await page.waitForSelector('#zurueck-in-pool-modal.show');
  assert.ok(await page.locator('#hinweisKontoId').count() > 0);
  const action = await page.locator('#zurueck-in-pool-form').getAttribute('action');
  assert.ok(action.endsWith(`/kontierung/${jobId}/zurueck-in-pool`), action);
  await page.close();
});

test('Escape schliesst den Dialog und behält den getippten Text', async () => {
  const page = await b.neueSeite(`/freigabe2/${b.server.ids.freigabe2}`, { als: 'test-2' });
  const posts = merkePosts(page);
  await page.click('button[name=aktion][value=ablehnen]');
  await page.waitForSelector('#ablehnen-dialog.show');
  await page.fill('#ablehnen-dialog-begruendung', 'Getippt');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ablehnen-dialog', { state: 'hidden' });
  assert.equal(posts.length, 0);
  assert.equal(await page.inputValue('#f2begruendung'), 'Getippt');
  await page.close();
});

// Mutierende Tests zuletzt: der gemeinsame Server bleibt sonst nicht unverändert.
test('Ablehnen bestätigen sendet aktion=ablehnen mit Begründung', async () => {
  const page = await b.neueSeite(`/freigabe2/${b.server.ids.freigabe2}`, { als: 'test-2' });
  const postPromise = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/freigabe2/'));
  await page.click('button[name=aktion][value=ablehnen]');
  await page.waitForSelector('#ablehnen-dialog.show');
  await page.fill('#ablehnen-dialog-begruendung', 'Grund');
  await page.click('#ablehnen-dialog-bestaetigen');
  const body = (await postPromise).postData();
  assert.match(body, /aktion=ablehnen/);
  assert.match(body, /begruendung=Grund/);
  await page.close();
});

test('Kontierung ablehnen mit leeren Pflichtfeldern geht durch', async () => {
  const page = await b.neueSeite(`/kontierung/${b.server.ids.anna}`, { als: 'test-1' });
  const url = `/kontierung/${b.server.ids.anna}`;
  await page.evaluate(() => {
    for (const id of ['absender', 'rechnungsnummer', 'betrag', 'zahlungsziel']) document.getElementById(id).value = '';
  });
  await page.click('#ablehnen-btn');
  await page.waitForSelector('#ablehnen-dialog.show');
  await page.fill('#ablehnen-dialog-begruendung', 'Doppelt');
  await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(url)),
    page.click('#ablehnen-dialog-bestaetigen'),
  ]);
  await page.waitForURL((u) => u.pathname !== url);
  await page.close();
});
