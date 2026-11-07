import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

// Eigener Server: das erfolgreiche Zuweisen verbraucht den Beispiel-Beleg im Pool.
let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

test('Zuweisen: Netzwerkfehler wird gemeldet', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  await page.route('**/pool/*/zuweisen', (route) => route.abort());
  const form = page.locator('.zuweisen-form:visible').first();
  await form.locator('select').selectOption({ index: 1 });
  await form.locator('button[type=submit]').click();
  await page.getByText('Netzwerkfehler – bitte erneut versuchen.').first().waitFor({ timeout: 5000 });
  await page.close();
});

test('Zuweisen senkt den Zähler des Abschnitts um 1', async () => {
  const page = await b.neueSeite('/pool', { als: 'test-4' });
  const form = page.locator('.zuweisen-form:visible').first();
  await form.waitFor();
  // Zähler des Abschnitts vor dem Ersetzen markieren, damit er danach noch auffindbar ist.
  await form.evaluate((f) => {
    const h2s = Array.from(document.querySelectorAll('h2')).filter((h) => h.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING);
    h2s.pop().querySelector('.abschnitt-zahl').id = 'test-zaehler';
  });
  const zahl = page.locator('#test-zaehler');
  const vorher = parseInt(await zahl.textContent(), 10);
  await form.locator('select').selectOption({ index: 1 });
  await form.locator('button[type=submit]').click();
  await page.locator('.text-success', { hasText: 'gesendet ✓' }).first().waitFor({ timeout: 5000 });
  assert.equal(parseInt(await zahl.textContent(), 10), vorher - 1);
  await page.close();
});
