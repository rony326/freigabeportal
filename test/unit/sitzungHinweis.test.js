import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fenster = {};
vm.runInNewContext(readFileSync(new URL('../../public/js/sitzungHinweis.js', import.meta.url), 'utf8'), { window: fenster });
const { zustand, text } = fenster.SitzungHinweis;
const MIN = 60 * 1000;

test('kein Hinweis, solange mehr als 10 Minuten bleiben', () => {
  assert.equal(zustand(0, 11 * MIN), 'ok');
});
test('Hinweis in den letzten 10 Minuten, abgelaufen danach', () => {
  assert.equal(zustand(0, 10 * MIN), 'bald');
  assert.equal(zustand(0, 1), 'bald');
  assert.equal(zustand(5, 5), 'abgelaufen');
});
test('Texte in Du-Form mit Uhrzeit', () => {
  assert.match(text('bald', '17:42'), /Deine Anmeldung läuft um 17:42 ab/);
  assert.match(text('bald', '17:42'), /sende deine Eingaben vorher ab/);
  assert.match(text('abgelaufen', '17:42'), /abgelaufen/);
});
