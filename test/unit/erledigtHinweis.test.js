import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erledigtHinweis } from '../../src/middleware/erledigtHinweis.js';

function lauf(method, path, body, ziel) {
  const gesetzt = [];
  const res = { locals: {}, cookie: (n, v) => gesetzt.push([n, v]), clearCookie() {}, redirect() {} };
  const req = { method, path, body, cookies: {} };
  erledigtHinweis()(req, res, () => {});
  res.redirect(ziel);
  return gesetzt;
}

test('Erledigt-Cookie: nur nach Beleg-Aktion mit Ziel /pool, mit passendem Text', () => {
  assert.deepEqual(lauf('POST', '/freigabe2/5', { aktion: 'ablehnen' }, '/pool'), [['erledigt', 'ablehnen']]);
  assert.deepEqual(lauf('POST', '/freigabe2/5', {}, '/pool'), [['erledigt', 'freigeben']]);
  assert.deepEqual(lauf('POST', '/kontierung/5', { aktion: 'kontieren' }, '/pool'), [['erledigt', 'kontieren']]);
  assert.deepEqual(lauf('POST', '/freigabe2/5', { interessenskonflikt: 'on' }, '/pool'), [['erledigt', 'konflikt']]);
  // Kontierung ohne aktion (z. B. Pool-Rücklegung): kein Hinweis, damit nichts Falsches steht.
  assert.deepEqual(lauf('POST', '/kontierung/5', {}, '/pool'), []);
  assert.deepEqual(lauf('POST', '/freigabe2/5', {}, '/anderswo'), []);
  assert.deepEqual(lauf('POST', '/meine-benachrichtigungen', { aktion: 'freigeben' }, '/pool'), []);
});
