import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createApp } from '../../src/app.js';

function testConfig() {
  return {
    sessionSecret: 'test-secret',
    env: 'test',
    churchtools: { baseUrl: 'https://ct.example.org', groupIdBuchhaltung: '10', groupIdAdmin: '20' },
  };
}

test('GET /nonexistent-route-xyz renders with no data-theme attribute when default is system and no cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/nonexistent-route-xyz');
  assert.equal(res.status, 404);
  // Anchored to the <html> tag itself, not just "data-theme=" anywhere in the
  // document — the shared header partial's CSS unconditionally contains
  // `:root[data-theme="dunkel"]` / `:root:not([data-theme="hell"])`, so an
  // unanchored regex would match that static CSS regardless of whether the
  // <html> tag actually carries the attribute.
  assert.doesNotMatch(res.text, /<html lang="de" data-theme=/);
  db.close();
});

test('GET /nonexistent-route-xyz renders data-theme="dunkel" when a theme cookie is set', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/nonexistent-route-xyz').set('Cookie', 'theme=dunkel');
  assert.equal(res.status, 404);
  assert.match(res.text, /<html lang="de" data-theme="dunkel"/);
  db.close();
});

test('GET /branding/logo returns 404 when no logo is configured', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/branding/logo');
  assert.equal(res.status, 404);
  db.close();
});

test('the error page also renders the shared header partial', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_theme_default', 'hell');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /<html lang="de" data-theme="hell"/);
  db.close();
});

test('GET /branding/logo-dunkel liefert 404 ohne dunkles Logo', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/branding/logo-dunkel');
  assert.equal(res.status, 404);
  db.close();
});

test('obere Leiste: mit dunklem Logo zwei Bilder (hell/dunkel), ohne nur das helle', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_logo_pfad', '/tmp/logo.png');
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  const app = createApp({ db, config: testConfig() });
  let res = await request(app).get('/nonexistent-route-xyz');
  assert.match(res.text, /<img src="\/branding\/logo" alt="Logo"[^>]*class="[^"]*logo-hell/);
  assert.doesNotMatch(res.text, /\/branding\/logo-dunkel/);

  setConfigValue(db, 'branding_logo_dunkel_pfad', '/tmp/logo-dunkel.png');
  setConfigValue(db, 'branding_logo_dunkel_mimetype', 'image/png');
  res = await request(app).get('/nonexistent-route-xyz');
  assert.match(res.text, /<img src="\/branding\/logo" alt="Logo"[^>]*class="[^"]*logo-hell/);
  assert.match(res.text, /<img src="\/branding\/logo-dunkel" alt="Logo"[^>]*class="[^"]*logo-dunkel/);
  db.close();
});

test('portal.css: dunkles Logo nur im Dunkelmodus, beim Drucken immer das helle', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');
  assert.match(css, /\.logo-dunkel\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(css, /:root\[data-theme="dunkel"\]\s+\.logo-hell\.hat-dunkel\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(css, /:root\[data-theme="dunkel"\]\s+\.logo-dunkel\s*\{\s*display:\s*inline(-block)?;?\s*\}/);
  const druck = css.slice(css.indexOf('@media print'));
  assert.match(druck, /\.logo-dunkel\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(druck, /\.logo-hell\s*\{\s*display:\s*inline(-block)?\s*!important;?\s*\}/);
});

test('Cookie system überschreibt Admin-Standard dunkel', async () => {
  const db = openDatabase(':memory:');
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/does-not-exist').set('Cookie', 'theme=system');
  assert.equal(res.status, 404);
  assert.match(res.text, /<html lang="de">/);
  assert.match(res.text, /data-farbmodus="system"[^>]*aria-pressed="true"/);
  db.close();
});

test('Markenstile: kein globaler Button-Rand, feiner PDF-Rahmen mit Schatten', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: testConfig() });
  const res = await request(app).get('/nonexistent-route-xyz');
  assert.doesNotMatch(res.text, /button\s*\{\s*border-color/);
  assert.doesNotMatch(res.text, /border:\s*2px solid #000/);
  assert.match(res.text, /\.pdf-preview\s*\{[^}]*box-shadow:\s*0 1px 2px rgb\(0 0 0 \/ \.08\)/);
  db.close();
});

test('portal.css: gemeinsame tabular-nums-Regel inkl. .zeitpunkt', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');
  assert.match(css, /\.betrag,[^{]*\.zeitpunkt[^{]*\{\s*font-variant-numeric:\s*tabular-nums;/);
  assert.equal((css.match(/font-variant-numeric/g) || []).length, 1);
  assert.match(css, /\.seitenkopf-titel \{[^}]*font-weight: 600;\s*letter-spacing: -0\.01em;/);
});
