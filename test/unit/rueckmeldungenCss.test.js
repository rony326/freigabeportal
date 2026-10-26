// Rückmeldungen 2026-10-26 (Live-Portal, Dunkelmodus): statische Absicherung der CSS-Korrekturen.
// Die Browserprüfung (npm run test:responsive: schliessen, kontrast) misst die Wirkung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const css = readFileSync(new URL('../../public/css/portal.css', import.meta.url), 'utf8');

test('kompakte "Gespeichert."-Meldung: ✕ im Fluss statt absolut darunter heraushängend, Touch 44 px', () => {
  assert.match(css, /\.alert-kompakt\.alert-dismissible \.btn-close \{[^}]*position: static;/);
  const touch = css.slice(css.indexOf('@media (pointer: coarse)'));
  assert.match(touch, /\.alert-kompakt\.alert-dismissible \.btn-close \{\s*padding: calc\(\(44px - 1em\) \/ 2\);/);
});

test('jede einzeilige Erfolgsmeldung neben einem Knopf trägt alert-kompakt', () => {
  const dir = new URL('../../views/admin/', import.meta.url);
  for (const datei of readdirSync(dir).filter((d) => d.endsWith('.ejs'))) {
    const src = readFileSync(new URL(datei, dir), 'utf8');
    for (const m of src.matchAll(/class="alert [^"]*alert-dismissible[^"]*d-inline-flex[^"]*"/g)) {
      assert.match(m[0], /alert-kompakt/, `${datei}: ${m[0]}`);
    }
  }
});

test('farbig hinterlegte Tabellenzeilen: gedämpfte Schrift, Links und Umriss-Knopf aus der Zeilenschrift', () => {
  assert.match(css, /\.table > tbody > tr\[class\*="table-"\] \{\s*--bs-secondary-color: color-mix\(in srgb, var\(--bs-table-color\) 72%, transparent\);/);
  assert.match(css, /\.table > tbody > tr\[class\*="table-"\] \.btn-outline-primary \{\s*--bs-btn-color: var\(--bs-table-color\);/);
  assert.match(css, /\.table > tbody > tr\[class\*="table-"\] a:not\(\.btn\) \{/);
});

test('Spesen einreichen: ab xl hat "Beleg" Platz für die Dateiauswahl (Formular und Zeilen-Template gleich)', () => {
  const src = readFileSync(new URL('../../views/spesen-neu.ejs', import.meta.url), 'utf8');
  const beleg = [...src.matchAll(/<div class="(col-md-4 col-xl-\d+)"[^>]*>\s*'?\s*(?:\+\s*')?<label class="form-label small">Beleg/g)].map((m) => m[1]);
  assert.equal(beleg.length, 2, 'Beleg-Spalte im Formular und im Template');
  for (const klassen of beleg) assert.equal(klassen, 'col-md-4 col-xl-6');
});
