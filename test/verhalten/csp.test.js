// Content-Security-Policy im echten Browser: keine Seite darf ein Skript oder einen Style-Block
// blockiert bekommen (fehlende Nonce, Inline-Ereignis-Attribut), und der Druck-Knopf funktioniert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';
import { SEITEN } from '../responsive/seiten.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

function pfadFuer(seite, ids) {
  return seite.pfad.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(ids[k]));
}

test('keine Seite der Seitenliste meldet eine CSP-Verletzung', async () => {
  const verstoesse = [];
  const gesehen = new Set();
  for (const seite of SEITEN) {
    const pfad = pfadFuer(seite, b.server.ids);
    if (gesehen.has(`${pfad}|${seite.als}`)) continue;
    gesehen.add(`${pfad}|${seite.als}`);
    const page = await b.neueSeite(pfad, { als: seite.als || 'test-4' });
    const meldungen = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to (execute|apply|load)/i.test(m.text())) meldungen.push(m.text()); });
    // Der Listener hängt erst nach dem ersten Laden: neu laden, damit alle Meldungen ankommen.
    await page.reload();
    await page.waitForLoadState('load');
    for (const t of meldungen) verstoesse.push(`${seite.name}: ${t}`);
    await page.close();
  }
  assert.deepEqual(verstoesse, []);
});

test('Zeitstempel-Prüfbescheinigung: der Druck-Knopf ruft window.print() auf', async () => {
  const page = await b.neueSeite(`/zeitstempel-pruefen/zertifikat?jobId=${b.server.ids.abgeschlossen}`);
  await page.evaluate(() => { window.__gedruckt = 0; window.print = () => { window.__gedruckt += 1; }; });
  const knopf = page.locator('[data-drucken]');
  assert.ok(await knopf.count() > 0, 'Druck-Knopf fehlt');
  await knopf.first().click();
  assert.equal(await page.evaluate(() => window.__gedruckt), 1);
  await page.close();
});
