// Vertrag von public/js/auffaelligkeiten.js, ohne Browser: das Skript läuft in einer vm mit einem
// minimalen DOM-Stub. Geprüft wird, was serverseitig sonst nicht prüfbar ist — Schliessen über
// „Abbrechen“/✕/Esc (hidden.bs.modal) leert den Hash, damit ein späteres normales Absenden das
// Popup erneut zeigt; „Geprüft, trotzdem speichern“ schickt den Hash mit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SKRIPT = readFileSync(new URL('../../public/js/auffaelligkeiten.js', import.meta.url), 'utf8');

function element(attrs = {}) {
  const listener = {};
  return {
    ...attrs,
    classList: { remove() {}, add() {} },
    setAttribute() {},
    addEventListener(typ, fn) { (listener[typ] ||= []).push(fn); },
    ausloesen(typ) { for (const fn of listener[typ] || []) fn({ type: typ }); },
  };
}

function aufbau() {
  const hash = element({ value: 'abc123', getAttribute: (n) => (n === 'data-hash' ? 'abc123' : null) });
  const datei = element({ value: 'C:\\fakepath\\beleg.png' });
  const bestaetigen = element();
  const modal = element({
    querySelector(sel) {
      if (sel === '[data-auffaelligkeiten-hash]') return hash;
      if (sel === '[data-auffaelligkeiten-bestaetigen]') return bestaetigen;
      return null;
    },
    querySelectorAll(sel) { return sel === 'input[type="file"]' ? [datei] : []; },
  });
  let gezeigt = false;
  const window = { bootstrap: { Modal: { getOrCreateInstance: () => ({ show() { gezeigt = true; } }) } } };
  const document = {
    querySelector: (sel) => (sel === '[data-auffaelligkeiten-modal]' ? modal : null),
    body: { appendChild() {} },
  };
  vm.runInNewContext(SKRIPT, { window, document });
  return { modal, hash, datei, bestaetigen, gezeigt: () => gezeigt };
}

test('auffaelligkeiten.js öffnet das Modal beim Laden', () => {
  assert.equal(aufbau().gezeigt(), true);
});

test('auffaelligkeiten.js leert beim Schliessen ohne Bestätigung Hash und nochmals gewählte Belege', () => {
  const { modal, hash, datei } = aufbau();
  modal.ausloesen('hidden.bs.modal');
  assert.equal(hash.value, '', 'ein normales Absenden danach muss das Popup erneut zeigen');
  assert.equal(datei.value, '', 'ein Beleg aus dem Modal darf nicht unbemerkt mitgeschickt werden');
});

test('auffaelligkeiten.js schickt den Hash mit „Geprüft, trotzdem speichern“ mit, auch nach vorherigem Schliessen', () => {
  const { modal, hash, bestaetigen } = aufbau();
  modal.ausloesen('hidden.bs.modal');
  bestaetigen.ausloesen('click');
  assert.equal(hash.value, 'abc123');
});
