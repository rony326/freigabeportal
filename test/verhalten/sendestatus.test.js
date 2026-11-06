import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { starteBrowser } from './helfer.js';

let b;
before(async () => { b = await starteBrowser(); });
after(async () => { await b.stop(); });

async function kontierungSeite() {
  const page = await b.neueSeite(`/kontierung/${b.server.ids.anna}`, { als: 'test-1' });
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes(`/kontierung/${b.server.ids.anna}`)) posts.push(r); });
  // Antwort verzögern, damit die Seite nicht sofort wegnavigiert.
  await page.route(`**/kontierung/${b.server.ids.anna}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' });
  });
  return { page, posts };
}

// Die Pflichtfelder stehen im Formular nicht fix; für den Test genügt der Submit-Versuch des Browsers
// nicht, daher das Formular ohne Validierung absenden (Knopf mit Klick, novalidate setzen).
// Zwei schnelle Klicks im Seitenkontext. Der Zustand wird im selben evaluate gelesen: Solange die
// verzögerte Antwort aussteht, antwortet die Seite Playwright erst nach der Navigation.
// Mit `mitPageshow` wird danach ein pageshow(persisted) ausgelöst und der Zustand erneut gelesen.
function klickeKontieren(page, { mitPageshow = false } = {}) {
  return page.evaluate((mitPageshow) => {
    const lies = () => {
      const k = document.querySelector('button[name=aktion][value=kontieren]');
      return { busy: k.getAttribute('aria-busy'), spinner: k.querySelectorAll('.spinner-border').length, markiert: document.querySelectorAll('.wird-gesendet').length };
    };
    document.getElementById('kontierung-form').noValidate = true;
    const k = document.querySelector('button[name=aktion][value=kontieren]');
    k.click();
    k.click();
    const danach = lies();
    let zurueck = null;
    if (mitPageshow) {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      zurueck = lies();
    }
    return { danach, zurueck };
  }, mitPageshow);
}

test('sendestatus: zweiter Klick auf Kontieren sendet nicht', async () => {
  const { page, posts } = await kontierungSeite();
  const { danach: z } = await klickeKontieren(page);
  await page.waitForTimeout(300);
  assert.equal(posts.length, 1);
  assert.equal(z.busy, 'true');
  assert.equal(z.spinner, 1);
});

test('sendestatus: name/value des Knopfs wird mitgesendet', async () => {
  const { page, posts } = await kontierungSeite();
  await klickeKontieren(page);
  await page.waitForTimeout(300);
  assert.match(posts[0].postData() || '', /name="aktion"\r\n\r\nkontieren|aktion=kontieren/);
});

test('sendestatus: pageshow persisted setzt zurück', async () => {
  const { page } = await kontierungSeite();
  const { danach, zurueck: z } = await klickeKontieren(page, { mitPageshow: true });
  assert.equal(danach.busy, 'true');
  assert.equal(z.busy, null);
  assert.equal(z.markiert, 0);
});

test('sendestatus: Download-Formular bleibt bedienbar', async () => {
  const page = await b.neueSeite('/');
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'post'; f.action = '/nirgends'; f.setAttribute('data-kein-sendestatus', '');
    f.innerHTML = '<button type="submit" id="dl">Laden</button>';
    f.addEventListener('submit', (e) => e.preventDefault());
    document.body.appendChild(f);
  });
  await page.click('#dl');
  assert.equal(await page.locator('#dl').getAttribute('aria-busy'), null);
  assert.equal(await page.locator('.wird-gesendet').count(), 0);
});

test('sendestatus: Beanspruchen zeigt Spinner', async () => {
  const page = await b.neueSeite('/', { als: 'test-4' });
  await page.route('**/api/pool/*/beanspruchen', async (route) => {
    await new Promise((r) => setTimeout(r, 1000));
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"weg"}' });
  });
  const knopf = page.locator('.beanspruchen-btn:visible').first();
  await knopf.click({ noWaitAfter: true });
  await page.waitForSelector('.beanspruchen-btn[aria-busy=true]', { state: 'visible', timeout: 800 });
});
