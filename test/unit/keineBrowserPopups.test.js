import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function dateien(dir, endung, treffer = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') dateien(p, endung, treffer); } else if (p.endsWith(endung)) treffer.push(p);
  }
  return treffer;
}

test('keine Browser-Popups (alert/confirm) in Views und Skripten', () => {
  const liste = [...dateien('views', '.ejs'), ...dateien('public/js', '.js')];
  const funde = [];
  for (const datei of liste) {
    fs.readFileSync(datei, 'utf8').split('\n').forEach((zeile, i) => {
      // Einzige erlaubte Ausnahme: letzter Rückfall für Gefahr-Bestätigungen, wenn der Dialog nicht angezeigt werden kann.
      if (datei.endsWith('public/js/portal.js') && zeile.includes('if (opt.gefahr) return Promise.resolve(window.confirm(')) return;
      if (/(^|[^\w.])(window\.)?(alert|confirm)\(/.test(zeile) || /onsubmit="return confirm/.test(zeile)) funde.push(`${datei}:${i + 1}`);
    });
  }
  assert.deepEqual(funde, []);
});
