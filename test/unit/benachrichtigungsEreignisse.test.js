import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEREICHE, EREIGNISSE, findeEreignis } from '../../src/services/benachrichtigungsEreignisse.js';
import { DEFAULTS } from '../../src/db/adminConfigRepo.js';
import { TYP_ZU_KEY_INFIX } from '../../src/services/mailTemplates.js';
import { IMMER_SOFORT_TYPEN } from '../../src/services/notify.js';

test('jede Vorlage gehört zu genau einem Ereignis', () => {
  for (const typ of Object.keys(TYP_ZU_KEY_INFIX)) {
    const treffer = EREIGNISSE.filter((e) => e.vorlagenTyp === typ);
    assert.equal(treffer.length, 1, `Vorlage ${typ}: ${treffer.length} Ereignisse`);
  }
  for (const e of EREIGNISSE.filter((x) => x.vorlagenTyp)) {
    assert.ok(TYP_ZU_KEY_INFIX[e.vorlagenTyp], `${e.id}: unbekannter Vorlagentyp`);
  }
});

test('alle Konfig-Schlüssel existieren in den Defaults', () => {
  for (const e of EREIGNISSE) {
    const keys = [...e.zeitKeys.map((z) => z.key), ...(e.empfaengerKey ? [e.empfaengerKey] : [])];
    for (const key of keys) assert.ok(Object.hasOwn(DEFAULTS, key), `${e.id}: ${key} fehlt in DEFAULTS`);
  }
});

test('Variablen kommen im Standardtext der Vorlage vor', () => {
  for (const e of EREIGNISSE.filter((x) => x.vorlagenTyp)) {
    const infix = TYP_ZU_KEY_INFIX[e.vorlagenTyp];
    const text = DEFAULTS[`mail_vorlage_${infix}_betreff`] + '\n' + DEFAULTS[`mail_vorlage_${infix}_text`];
    for (const v of e.variablen) assert.ok(text.includes(`%${v.name}%`), `${e.id}: %${v.name}% fehlt im Standardtext`);
  }
});

test('Ereignisse ohne Vorlage haben keine Variablen', () => {
  for (const e of EREIGNISSE.filter((x) => !x.vorlagenTyp)) assert.deepEqual(e.variablen, []);
});

test('Ids sind eindeutig und URL-sicher, Bereiche gültig', () => {
  const ids = EREIGNISSE.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of EREIGNISSE) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.ok(BEREICHE.includes(e.bereich), `${e.id}: Bereich ${e.bereich}`);
  }
});

test('sofort entspricht IMMER_SOFORT_TYPEN', () => {
  for (const e of EREIGNISSE.filter((x) => x.vorlagenTyp)) {
    assert.equal(e.sofort, IMMER_SOFORT_TYPEN.has(e.vorlagenTyp), e.id);
  }
});

test('findeEreignis und Sonderfelder', () => {
  assert.equal(findeEreignis('reminder').bereich, 'Rechnungen');
  assert.equal(findeEreignis('gibt-es-nicht'), undefined);
  assert.equal(findeEreignis('zusammenfassung').vorlagenTyp, 'digest');
  assert.equal(findeEreignis('auffaelligkeiten').zeitKeys.length, 5);
  assert.equal(findeEreignis('audit-pruefnummer').empfaengerArt, 'nurEmail');
  assert.equal(findeEreignis('reminder').empfaengerArt, 'alle');
  assert.equal(findeEreignis('audit-pruefnummer').empfaengerLeerErlaubt, true);
  assert.equal(findeEreignis('rapport-eskalation').empfaengerLeerErlaubt, true);
  assert.equal(findeEreignis('reminder').empfaengerLeerErlaubt, false);
  assert.equal(findeEreignis('sicherheitsalarm').vorlagenTyp, null);
});
