import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults, setConfigValue } from '../../src/db/adminConfigRepo.js';
import { loadBranding } from '../../src/middleware/branding.js';

function runMiddleware(db, cookieHeader) {
  const req = { headers: { cookie: cookieHeader } };
  const res = { locals: {} };
  let nextCalled = false;
  loadBranding(db)(req, res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
  return res.locals.branding;
}

test('with no cookie and theme default "system", themeAttr is null', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.themeAttr, null);
  db.close();
});

test('with no cookie and an admin default of "dunkel", themeAttr follows the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.themeAttr, 'dunkel');
  db.close();
});

test('a user theme cookie overrides the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, 'theme=hell');
  assert.equal(branding.themeAttr, 'hell');
  db.close();
});

test('an invalid theme cookie value is ignored, falling back to the admin default', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_theme_default', 'dunkel');
  const branding = runMiddleware(db, 'theme=lila; other=1');
  assert.equal(branding.themeAttr, 'dunkel');
  db.close();
});

test('branding exposes primaryColor, secondaryColor and hasLogo', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.primaryColor, '#2f4858');
  assert.equal(branding.secondaryColor, '#4d7ea8');
  assert.equal(branding.hasLogo, false);
  db.close();
});

test('hasLogo is true once both a logo path and mimetype are configured', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_logo_pfad', '/data/branding/logo.png');
  setConfigValue(db, 'branding_logo_mimetype', 'image/png');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.hasLogo, true);
  db.close();
});

test('hasLogo stays false when only the logo path is configured but the mimetype is missing', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_logo_pfad', '/data/branding/logo.png');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.hasLogo, false);
  db.close();
});

test('branding exposes the configured footerText', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'footer_text', 'Life Church Schaffhausen');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.footerText, 'Life Church Schaffhausen');
  db.close();
});

test('branding falls back to "Freigabeportal" for footerText when unset (no seedDefaults)', () => {
  const db = openDatabase(':memory:');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.footerText, 'Freigabeportal');
  db.close();
});

test('branding exposes the configured logoAusrichtung', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  setConfigValue(db, 'branding_logo_ausrichtung', 'mitte');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.logoAusrichtung, 'mitte');
  db.close();
});

test('branding falls back to "links" for logoAusrichtung when unset (no seedDefaults)', () => {
  const db = openDatabase(':memory:');
  const branding = runMiddleware(db, undefined);
  assert.equal(branding.logoAusrichtung, 'links');
  db.close();
});

test('bsThemeAttr maps dunkel to dark and hell to light, and stays null when themeAttr is null', () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  assert.equal(runMiddleware(db, 'theme=dunkel').bsThemeAttr, 'dark');
  assert.equal(runMiddleware(db, 'theme=hell').bsThemeAttr, 'light');
  assert.equal(runMiddleware(db, undefined).bsThemeAttr, null);
  db.close();
});
