// Responsive-Browsertest (npm run test:responsive): die Seitenliste deckt jede Seiten-View ab.
// Gleiche View-Menge wie im layoutSweep (views/*.ejs und views/admin/*.ejs ohne führenden "_").
// Läuft ohne Browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { SEITEN, AUSGENOMMEN, BREITEN } from '../responsive/seiten.js';

const viewsDir = new URL('../../views', import.meta.url).pathname;

function seitenViews() {
  const namen = (dir, praefix) => readdirSync(`${viewsDir}${dir}`)
    .filter((f) => f.endsWith('.ejs') && !f.startsWith('_'))
    .map((f) => `${praefix}${f.slice(0, -4)}`);
  return [...namen('', ''), ...namen('/admin', 'admin/')];
}

test('Responsive-Seitenliste: jede layoutSweep-Seite ist in SEITEN enthalten oder ausdrücklich ausgenommen', () => {
  const abgedeckt = new Set([...SEITEN.map((s) => s.view), ...AUSGENOMMEN.map((a) => a.view)]);
  const fehlend = seitenViews().filter((v) => !abgedeckt.has(v));
  assert.deepEqual(fehlend, [], `Views ohne Eintrag in test/responsive/seiten.js: ${fehlend.join(', ')}`);
});

test('Responsive-Seitenliste: keine veralteten Einträge, Ausnahmen begründet, nichts doppelt', () => {
  const views = new Set(seitenViews());
  for (const s of SEITEN) {
    assert.ok(views.has(s.view), `${s.name}: View ${s.view} gibt es nicht`);
    assert.ok(s.pfad.startsWith('/'), `${s.name}: Pfad muss mit / beginnen`);
  }
  for (const a of AUSGENOMMEN) {
    assert.ok(views.has(a.view), `Ausnahme ${a.view}: View gibt es nicht`);
    assert.ok(a.grund && a.grund.length > 10, `Ausnahme ${a.view}: Grund fehlt`);
    assert.ok(!SEITEN.some((s) => s.view === a.view), `Ausnahme ${a.view} steht auch in SEITEN`);
  }
  const namen = SEITEN.map((s) => s.name);
  assert.equal(new Set(namen).size, namen.length, 'Seitennamen müssen eindeutig sein (Screenshot-Dateinamen)');
});

test('Responsive-Seitenliste: Detailseiten und Fehlerzustände sind dabei', () => {
  const views = new Set(SEITEN.map((s) => s.view));
  for (const v of ['kontierung', 'freigabe2', 'spesen-freigabe1', 'abgelehnt', 'kk-abgleich', 'kontierung-aufsplitten',
    'admin/vorgang-detail', 'zeitstempel-pruefen', 'kommentar-fehler', 'meine-benachrichtigungen', 'testmodus-postfach']) {
    assert.ok(views.has(v), `Detailseite ${v} fehlt`);
  }
  const fehler = SEITEN.filter((s) => s.fehlerzustand || (s.status && s.status !== 200));
  assert.ok(fehler.length >= 2, 'mindestens zwei Fehlerzustände');
  for (const v of ['kontierung', 'spesen-neu']) {
    assert.ok(SEITEN.some((s) => s.view === v && s.fehlerzustand), `Fehlerzustand für ${v} fehlt`);
  }
});

test('Responsive-Breiten: 360 Handy, 768/1024 Tablet mit Touch, 1280 Desktop ohne Touch', () => {
  assert.deepEqual(BREITEN.map((b) => [b.breite, b.isMobile, b.hasTouch]), [
    [360, true, true], [768, false, true], [1024, false, true], [1280, false, false],
  ]);
});
