import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kiFelder, fehlendeBestaetigungen } from '../../src/services/kiBestaetigung.js';

const basis = { betrag: null, qr_betrag: null, betrag_vorschlag: null, rechnungsnummer: null, zahlungsziel: null };

test('kiFelder: nur Werte aus dem n8n-Upload eines noch nicht kontierten Vorgangs', () => {
  assert.deepEqual(kiFelder({ ...basis, rechnungsnummer: 'RE-1', zahlungsziel: '2026-12-31', betrag_vorschlag: '99.90' }),
    { rechnungsnummer: 'RE-1', zahlungsziel: '2026-12-31', betrag: '99.90' });
  assert.deepEqual(kiFelder(basis), { rechnungsnummer: null, zahlungsziel: null, betrag: null });
});

test('kiFelder: QR-Betrag ist verlässlich, der Upload-Betrag braucht dann keine Bestätigung', () => {
  assert.equal(kiFelder({ ...basis, qr_betrag: '120.00', betrag_vorschlag: '99.90' }).betrag, null);
});

test('kiFelder: nach der Kontierung (betrag gesetzt) ist nichts mehr zu bestätigen', () => {
  assert.deepEqual(kiFelder({ ...basis, betrag: '10.00', rechnungsnummer: 'RE-1', zahlungsziel: '2026-12-31' }),
    { rechnungsnummer: null, zahlungsziel: null, betrag: null });
});

test('fehlendeBestaetigungen: unveränderter KI-Wert ohne Haken fehlt, mit Haken oder geändert nicht', () => {
  const ki = { rechnungsnummer: 'RE-1', zahlungsziel: '2026-12-31', betrag: '99.90' };
  const werte = { rechnungsnummer: 'RE-1', zahlungsziel: '2026-12-31', betrag: '99,9' };
  assert.deepEqual(fehlendeBestaetigungen(ki, werte, {}), ['rechnungsnummer', 'zahlungsziel', 'betrag']);
  assert.deepEqual(fehlendeBestaetigungen(ki, werte, { bestaetigt_rechnungsnummer: '1', bestaetigt_betrag: '1' }), ['zahlungsziel']);
  assert.deepEqual(fehlendeBestaetigungen(ki, { rechnungsnummer: 'RE-2', zahlungsziel: '', betrag: '100.00' }, {}), []);
});

test('fehlendeBestaetigungen: Felder ohne KI-Wert werden nie verlangt; Haken muss genau "1" sein', () => {
  assert.deepEqual(fehlendeBestaetigungen({ rechnungsnummer: null, zahlungsziel: null, betrag: null }, { rechnungsnummer: 'X' }, {}), []);
  assert.deepEqual(fehlendeBestaetigungen({ rechnungsnummer: 'RE-1' }, { rechnungsnummer: 'RE-1' }, { bestaetigt_rechnungsnummer: ['1', '1'] }), ['rechnungsnummer']);
});

test('trenneKiHinweise: KI-Meldungen ins Banner, alles andere bleibt in der Fehlerliste', async () => {
  const { trenneKiHinweise, bestaetigungsMeldung } = await import('../../src/services/kiBestaetigung.js');
  const { hinweise, uebrige } = trenneKiHinweise(['Bitte ein Konto wählen.', bestaetigungsMeldung('zahlungsziel'), bestaetigungsMeldung('rechnungsnummer')]);
  assert.deepEqual(hinweise.map((h) => h.feld), ['zahlungsziel', 'rechnungsnummer']);
  assert.deepEqual(uebrige, ['Bitte ein Konto wählen.']);
});
