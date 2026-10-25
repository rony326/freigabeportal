import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.js';
import { setConfigValue } from '../../src/db/adminConfigRepo.js';
import { createTsaErreichbarkeit } from '../../src/services/statusTsa.js';

const warte = () => new Promise((r) => setTimeout(r, 10));

test('TSA-URL geändert: altes Ergebnis verworfen, sofort neuer Versuch', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const urls = [];
  const versuch = async (cfg) => { urls.push(cfg.url); if (cfg.url.includes('alt')) throw new Error('nein'); };
  const tsa = createTsaErreichbarkeit();
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://alt.example.org/tsr');
  tsa(db, {}, { versuch });
  await warte();
  assert.equal(tsa(db, {}, { versuch }).erreichbar, false);
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://neu.example.org/tsr');
  assert.equal(tsa(db, {}, { versuch }).erreichbar, null, 'altes Ergebnis darf nicht für die neue URL gelten');
  await warte();
  assert.equal(tsa(db, {}, { versuch }).erreichbar, true);
  assert.deepEqual(urls, ['https://alt.example.org/tsr', 'https://neu.example.org/tsr']);
});

test('TSA-URL während laufendem Versuch geändert: spätes Ergebnis der alten URL wird ignoriert', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let loeseAlt;
  const versuch = (cfg) => (cfg.url.includes('alt') ? new Promise((_, rej) => { loeseAlt = () => rej(new Error('nein')); }) : Promise.resolve());
  const tsa = createTsaErreichbarkeit();
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://alt.example.org/tsr');
  tsa(db, {}, { versuch });
  setConfigValue(db, 'zeitstempel_tsa_url', 'https://neu.example.org/tsr');
  tsa(db, {}, { versuch });
  await warte();
  loeseAlt();
  await warte();
  assert.equal(tsa(db, {}, { versuch }).erreichbar, true);
});
