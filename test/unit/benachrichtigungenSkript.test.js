// Reine Funktionen von public/js/benachrichtigungen.js, ohne Browser: das Skript läuft in einer vm
// ohne passende DOM-Elemente und stellt window.Benachrichtigungen bereit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderTemplate } from '../../src/services/mailTemplates.js';

const SKRIPT = readFileSync(new URL('../../public/js/benachrichtigungen.js', import.meta.url), 'utf8');

function laden() {
  const window = {};
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  vm.runInNewContext(SKRIPT, { window, document });
  return window.Benachrichtigungen;
}

test('vorschau ersetzt bekannte Platzhalter, unbekannte bleiben stehen und werden gemeldet', () => {
  const { vorschau } = laden();
  const r = vorschau('Hallo %empfaengerName% %xy%', { empfaengerName: 'Anna' });
  assert.deepEqual({ text: r.text, unbekannt: [...r.unbekannt] }, { text: 'Hallo Anna %xy%', unbekannt: ['xy'] });
});

test('vorschau meldet jeden unbekannten Platzhalter einmal und rendert wie renderTemplate', () => {
  const { vorschau } = laden();
  const beispiele = { a: '1', b: '%a%' };
  const vorlage = '%a% %b% %c% %c% %toString% %% 50% %d-e%';
  const r = vorschau(vorlage, beispiele);
  assert.equal(r.text, renderTemplate(vorlage, beispiele));
  assert.deepEqual([...r.unbekannt], ['c', 'toString']);
});

test('vorschlaege: Gruppen und Personen (max. 8, Vor- und Nachname), bereits gewählte nicht', () => {
  const { vorschlaege } = laden();
  const personen = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Sandra Muster${i}` }));
  personen.push({ id: 'x', name: 'Marco Huber' });
  const daten = { nurEmail: false, personen, gruppen: [{ wert: 'gruppe:admin', label: 'Gruppe Admin' }, { wert: 'gruppe:buchhaltung', label: 'Gruppe Buchhaltung' }] };
  const leer = vorschlaege(daten, ['gruppe:admin'], '');
  assert.deepEqual([...leer.gruppen].map((g) => g.wert), ['gruppe:buchhaltung']);
  assert.equal(leer.personen.length, 8);
  assert.deepEqual([...vorschlaege(daten, [], 'hub').personen].map((p) => p.id), ['x']);
  assert.deepEqual([...vorschlaege(daten, [], 'marco').personen].map((p) => p.id), ['x']);
  assert.deepEqual([...vorschlaege(daten, ['person:x'], 'marco').personen], []);
  assert.deepEqual([...vorschlaege(daten, [], 'buch').gruppen].map((g) => g.wert), ['gruppe:buchhaltung']);
  assert.equal(vorschlaege(daten, [], 'anna@example.org').email, 'anna@example.org');
  assert.equal(vorschlaege(daten, [], 'anna').email, null);
});

test('vorschlaege bei nurEmail: keine Gruppen und keine Personen', () => {
  const { vorschlaege } = laden();
  const r = vorschlaege({ nurEmail: true, personen: [{ id: '1', name: 'Anna' }], gruppen: [{ wert: 'gruppe:admin', label: 'Gruppe Admin' }] }, [], 'a');
  assert.equal(r.gruppen.length, 0);
  assert.equal(r.personen.length, 0);
});
