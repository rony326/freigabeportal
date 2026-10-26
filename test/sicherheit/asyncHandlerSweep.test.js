import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { codeMaske, passendeKlammer, findeAsyncFunktionen } from '../helpers/asyncScan.js';
import { asyncHandler, asyncCallback } from '../../src/middleware/asyncHandler.js';
import { openDatabase } from '../../src/db/index.js';
import { seedDefaults } from '../../src/db/adminConfigRepo.js';
import { createKommentareRouter } from '../../src/routes/kommentare.js';

// Review Task 5, Fund 1: Express 4 reicht abgelehnte Promises aus async-Handlern nicht an den
// Fehler-Handler weiter → unhandledRejection → Prozess-Exit. Jeder async-Handler/-Rückruf in
// src/routes/**, src/middleware/** und src/app.js muss deshalb in asyncHandler(…) bzw.
// asyncCallback(next, …) stehen, oder sein ganzer Rumpf ist ein einziges try/catch.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function dateien(dir) {
  return readdirSync(dir).flatMap((name) => {
    const pfad = join(dir, name);
    return statSync(pfad).isDirectory() ? dateien(pfad) : pfad.endsWith('.js') ? [pfad] : [];
  });
}

// Rumpf besteht nur aus `try { … } catch (…) { … }` (optional `finally { … }`).
function nurTryCatch(src, maske, rumpfStart, rumpfEnde) {
  let i = rumpfStart + 1;
  const ueberspringe = () => { while (i < rumpfEnde && (/\s/.test(src[i]) || !maske[i])) i++; };
  const block = () => {
    ueberspringe();
    if (src[i] !== '{') return false;
    i = passendeKlammer(src, maske, i) + 1;
    return i > 0;
  };
  ueberspringe();
  if (!src.startsWith('try', i)) return false;
  i += 3;
  if (!block()) return false;
  ueberspringe();
  if (!src.startsWith('catch', i)) return false;
  i += 5;
  ueberspringe();
  if (src[i] === '(') i = src.indexOf(')', i) + 1;
  if (!block()) return false;
  ueberspringe();
  if (src.startsWith('finally', i)) { i += 7; if (!block()) return false; ueberspringe(); }
  return i >= rumpfEnde;
}

test('Sweep: jeder async-Handler in src/routes, src/middleware und app.js ist abgesichert', () => {
  const zuPruefen = [...dateien(join(ROOT, 'src', 'routes')), ...dateien(join(ROOT, 'src', 'middleware')), join(ROOT, 'src', 'app.js')];
  const verstoesse = [];
  let geprueft = 0;
  for (const datei of zuPruefen) {
    const src = readFileSync(datei, 'utf8');
    const maske = codeMaske(src);
    const ort = (index) => `${relative(ROOT, datei)}:${src.slice(0, index).split('\n').length}`;
    // Ausdrucks-Pfeile ohne Block-Rumpf (`async (req, res) => tuWas()`) findet findeAsyncFunktionen
    // nicht — für Handler-Signaturen deshalb zusätzlich jede `async (req…`-Stelle prüfen.
    for (const m of src.matchAll(/\basync\s*\(\s*_?req\b/g)) {
      if (!maske[m.index]) continue;
      if (!/asyncHandler\(\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) verstoesse.push(`${ort(m.index)} async-Route-Handler ohne asyncHandler(…)`);
    }
    for (const fn of findeAsyncFunktionen(src)) {
      geprueft++;
      assert.ok(fn.rumpfEnde > fn.rumpfStart, `Scanner fand kein Rumpf-Ende: ${ort(fn.index)}`);
      if (/^async\s+function\b/.test(fn.kopf)) continue; // Hilfsfunktion: Aufrufer awaitet sie
      if (/(asyncHandler\(|asyncCallback\(\s*next\s*,)\s*$/.test(fn.vorher)) continue;
      if (nurTryCatch(src, maske, fn.rumpfStart, fn.rumpfEnde)) continue;
      verstoesse.push(`${ort(fn.index)} ${fn.kopf.trim()} ohne asyncHandler/asyncCallback und ohne umschliessendes try/catch`);
    }
  }
  assert.ok(geprueft >= 50, `Scanner fand verdächtig wenige async-Funktionen (${geprueft})`);
  assert.deepEqual(verstoesse, []);
});

test('Sweep-Scanner erkennt einen ungeschützten Handler (Gegenprobe)', () => {
  const src = "router.post('/x', csrfProtection, async (req, res) => {\n  const a = `${1}{`;\n  machWas(/[{]/);\n  res.send(a);\n});\n";
  const [fn] = findeAsyncFunktionen(src);
  assert.ok(fn, 'Handler nicht gefunden');
  assert.equal(src.slice(fn.rumpfEnde), '});\n');
  assert.equal(nurTryCatch(src, codeMaske(src), fn.rumpfStart, fn.rumpfEnde), false);
  const geschuetzt = 'x(async () => { try { a(); } catch (e) { b(); } });';
  const [g] = findeAsyncFunktionen(geschuetzt);
  assert.equal(nurTryCatch(geschuetzt, codeMaske(geschuetzt), g.rumpfStart, g.rumpfEnde), true);
});

test('asyncHandler/asyncCallback reichen Fehler an next weiter (synchroner Throw und Ablehnung)', async () => {
  for (const fn of [async () => { throw new Error('sync'); }, () => Promise.reject(new Error('rej'))]) {
    let gesehen = null;
    await asyncHandler(fn)({}, {}, (err) => { gesehen = err; });
    assert.ok(gesehen instanceof Error);
    gesehen = null;
    await asyncCallback((err) => { gesehen = err; }, fn)(null);
    assert.ok(gesehen instanceof Error);
  }
});

// Nachweis am echten Router: ein synchron werfender DB-Aufruf (hier SQLITE-Fehler beim Laden des
// Jobs, wie bei SQLITE_FULL/BUSY) im async-Handler POST /kommentare/:jobId — dort ausserhalb jedes
// try/catch — ergibt eine 500-Antwort statt einer unhandledRejection, und der Prozess bedient danach
// weiterhin Anfragen.
test('DB-Throw im async-Handler ergibt 500 und der Prozess läuft weiter', async () => {
  const db = openDatabase(':memory:');
  seedDefaults(db);
  const config = { churchtools: {}, publicBaseUrl: 'http://portal.example.org' };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.currentPerson = { churchtools_person_id: 'p1', gruppen: [] }; next(); });
  app.use('/kommentare', createKommentareRouter({ db, config, mailer: null }));
  app.get('/lebt', (req, res) => res.send('ok'));
  app.use((err, req, res, next) => res.status(500).send(`Fehlerseite: ${err.message}`));

  const unbehandelt = [];
  const merke = (grund) => unbehandelt.push(grund);
  process.on('unhandledRejection', merke);
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/FROM jobs WHERE id/.test(sql)) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
    return original(sql);
  };
  try {
    const res = await request(app).post('/kommentare/1').type('form').send({ text: 'hallo' });
    assert.equal(res.status, 500);
    assert.match(res.text, /database or disk is full/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unbehandelt, [], 'keine unhandledRejection erwartet');
    const danach = await request(app).get('/lebt');
    assert.equal(danach.status, 200);
  } finally {
    process.off('unhandledRejection', merke);
    db.prepare = original;
    db.close();
  }
});
