// B2, Etappe 2: Im Worker-Betrieb soll der Hauptprozess mupdf (WASM, ~55 MB) nicht laden. Geprüft wird zur Laufzeit
// in einem Kindprozess: ein Resolve-Hook (module.registerHooks) zeichnet jede Importkante auf, danach werden die
// Module importiert. Dynamische import()-Aufrufe (PDF_WORKER=aus) laufen dabei nicht, weil kein Auftrag ausgeführt wird.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const SRC = new URL('../../src/', import.meta.url);

// Kindprozess: Hook registrieren, Ziele importieren, Kanten {von, spec, nach} als JSON ausgeben.
const KIND = `
import { registerHooks } from 'node:module';
import { writeSync } from 'node:fs';
const kanten = [];
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    kanten.push({ von: ctx.parentURL ?? null, spec, nach: r.url });
    return r;
  },
});
for (const ziel of JSON.parse(process.argv[1])) await import(ziel);
// writeSync: process.stdout.write ginge bei process.exit() teilweise verloren.
writeSync(1, '\\n@@KANTEN@@' + JSON.stringify(kanten));
process.exit(0);
`;

function ladeKanten(ziele) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', KIND, JSON.stringify(ziele.map((z) => new URL(z, SRC).href))], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const marke = r.stdout.lastIndexOf('@@KANTEN@@');
  assert.ok(marke >= 0, `Kindprozess ohne Ergebnis (Status ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.slice(marke + '@@KANTEN@@'.length));
}

const relativ = (url) => (url?.startsWith(SRC.href) ? url.slice(SRC.href.length) : url);

// Module, die mupdf direkt importieren, und je Modul, wer es importiert.
function mupdfPfade(kanten) {
  const direkt = [...new Set(kanten.filter((k) => k.spec === 'mupdf').map((k) => relativ(k.von)))].sort();
  const importeure = Object.fromEntries(direkt.map((m) => [m, [...new Set(kanten.filter((k) => relativ(k.nach) === m).map((k) => relativ(k.von)))].sort()]));
  return { direkt, importeure };
}

const OHNE_HOOKS = typeof registerHooks !== 'function' && 'module.registerHooks fehlt in dieser Node-Version';

// Erlaubte Restpfade zu mupdf (Modul → Importeure). Leer: Seit die Testmodus-Beispieldaten ihre Vorschaubilder über
// den PDF-Worker rechnen (B2), lädt der Hauptprozess mupdf gar nicht mehr. Ein neuer Pfad lässt die Tests scheitern.
const RESTPFAD = {};

function nurBekannterRestpfad(ziel, { direkt, importeure }) {
  for (const modul of direkt) {
    assert.ok(Object.hasOwn(RESTPFAD, modul), `${ziel}: ${modul} importiert mupdf (neuer Pfad)`);
    assert.deepEqual(importeure[modul], RESTPFAD[modul], `${ziel}: ${modul} wird über einen neuen Pfad geladen`);
  }
}

test('B2 Etappe 2: Spesen und die Erzeugung von KK-Belegdateien laden mupdf überhaupt nicht', { skip: OHNE_HOOKS, timeout: 60_000 }, () => {
  for (const ziel of ['routes/spesen.js', 'services/kkBelegDatei.js', 'services/pdfArbeit.js']) {
    assert.deepEqual(mupdfPfade(ladeKanten([ziel])).direkt, [], `${ziel} lädt mupdf`);
  }
});

test('B2 Etappe 2: KK-Belege, KK-Abgleich und die n8n-Eingänge laden mupdf nicht', { skip: OHNE_HOOKS, timeout: 60_000 }, () => {
  for (const ziel of ['routes/kreditkarte.js', 'routes/kkAbgleich.js', 'services/kkBelegEingang.js', 'routes/n8n/kkBelege.js', 'routes/n8n/jobs.js']) {
    nurBekannterRestpfad(ziel, mupdfPfade(ladeKanten([ziel])));
  }
});

test('B2 Etappe 4: Kontierung und Aufsplitten (Beleg anhängen) laden mupdf überhaupt nicht', { skip: OHNE_HOOKS, timeout: 60_000 }, () => {
  for (const ziel of ['routes/kontierung.js', 'services/aufsplitten.js', 'services/belegAnhaengen.js']) {
    assert.deepEqual(mupdfPfade(ladeKanten([ziel])).direkt, [], `${ziel} lädt mupdf`);
  }
});

// Alle statischen Importe von src/index.js (ohne index.js selbst, das den Server starten würde).
test('B2: der Hauptprozess lädt mupdf nicht (auch nicht über die Testmodus-Beispieldaten)', { skip: OHNE_HOOKS, timeout: 60_000 }, () => {
  const index = readFileSync(new URL('index.js', SRC), 'utf8');
  const ziele = [...index.matchAll(/^import\s[^;]*?from\s+'(\.\/[^']+)'/gm)].map((m) => m[1].slice(2));
  assert.ok(ziele.includes('app.js'), 'Importe von src/index.js nicht gefunden');
  const pfade = mupdfPfade(ladeKanten(ziele));
  nurBekannterRestpfad('src/index.js', pfade);
  assert.deepEqual(pfade.direkt, Object.keys(RESTPFAD), 'Hauptprozess lädt mupdf');
});
