import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';

let b;
before(async () => {
  b = await starteBrowser();
  setConfigValue(b.server.db, 'branding_theme_default', 'dunkel');
});
after(async () => { await b.stop(); });

test('Farbmodus-Menü: System folgt dem Betriebssystem (hell), Dunkel setzt Cookie', async () => {
  const page = await b.neueSeite('/pool', { colorScheme: 'light' });
  assert.equal(await page.getAttribute('html', 'data-bs-theme'), 'dark', 'Admin-Standard dunkel gilt ohne Cookie');
  await page.click('#theme-toggle');
  await page.click('[data-farbmodus="system"]');
  assert.equal(await page.getAttribute('html', 'data-bs-theme'), 'light');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'data-bs-theme'), 'light');
  await page.click('#theme-toggle');
  assert.equal(await page.getAttribute('[data-farbmodus="system"]', 'aria-pressed'), 'true');
  await page.click('[data-farbmodus="dunkel"]');
  assert.equal(await page.getAttribute('html', 'data-bs-theme'), 'dark');
  const cookies = await page.context().cookies();
  assert.equal(cookies.find((c) => c.name === 'theme')?.value, 'dunkel');
});
