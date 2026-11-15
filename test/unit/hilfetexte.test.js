import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hilfeFuer } from '../../src/services/hilfetexte.js';

test('Hilfetext: Unterseiten finden den Text ihrer Seite, unbekannte Seiten keinen', () => {
  assert.equal(hilfeFuer('/pool').titel, 'Hilfe: Aufgaben');
  assert.equal(hilfeFuer('/freigabe2/12').titel, 'Hilfe: Rechnung freigeben');
  assert.equal(hilfeFuer('/spesen/neu').titel, 'Hilfe: Spesen einreichen');
  assert.equal(hilfeFuer('/admin/konten'), null);
  assert.equal(hilfeFuer('/poolfremd'), null);
  assert.equal(hilfeFuer(''), null);
});
