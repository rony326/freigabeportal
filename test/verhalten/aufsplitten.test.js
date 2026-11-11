import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

// Das Aufsplitten verlangt einen Lieferanten: der im Kontierungsformular gewählte wird ins Popup
// übernommen und dort vorgewählt; ohne QR-Code steuert er den IBAN-Kasten (kontierung-iban.js).
test('Aufsplitten-Popup übernimmt den gewählten Lieferanten aus der Kontierung', async () => {
  const kreditorId = String(b.server.ids.langerKreditor);
  const page = await b.neueSeite(`/kontierung/${b.server.ids.anna}`, { als: 'test-1' });
  await page.evaluate((id) => {
    const select = document.getElementById('kreditorId');
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, kreditorId);
  await page.locator('.dropdown-toggle:has(+ .dropdown-menu [data-bs-target="#aufsplitten-modal"])').click();
  await page.locator('[data-bs-target="#aufsplitten-modal"]').click();
  const frame = page.frameLocator('#aufsplitten-frame');
  await frame.locator('#kreditorId').waitFor({ state: 'attached' });
  const src = await page.locator('#aufsplitten-frame').getAttribute('src');
  assert.match(src, new RegExp(`[?&]kreditorId=${kreditorId}(&|$)`));
  assert.equal(await frame.locator('#kreditorId').inputValue(), kreditorId);
});
