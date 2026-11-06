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
