import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNavFlags } from '../../src/middleware/nav.js';

function runLoadNavFlags(config, currentPerson, path) {
  const req = { currentPerson, path };
  const res = { locals: {} };
  let calledNext = false;
  loadNavFlags(config)(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

const CONFIG = { churchtools: { groupIdBuchhaltung: '10', groupIdAdmin: '20' } };

test('loadNavFlags sets isBuchhaltung/currentPath for a Buchhaltung member and calls next', () => {
  const { res, calledNext } = runLoadNavFlags(CONFIG, { gruppen: ['10'] }, '/pool');
  assert.equal(res.locals.isBuchhaltung, true);
  assert.equal(res.locals.isPortalAdmin, false);
  assert.equal(res.locals.currentPath, '/pool');
  assert.equal(calledNext, true);
});

test('loadNavFlags sets isPortalAdmin true for a Portal-Admin member', () => {
  const { res } = runLoadNavFlags(CONFIG, { gruppen: ['20'] }, '/admin');
  assert.equal(res.locals.isPortalAdmin, true);
  assert.equal(res.locals.isBuchhaltung, false);
});

test('loadNavFlags sets both flags false for an anonymous visitor (currentPerson null)', () => {
  const { res } = runLoadNavFlags(CONFIG, null, '/');
  assert.equal(res.locals.isBuchhaltung, false);
  assert.equal(res.locals.isPortalAdmin, false);
});
