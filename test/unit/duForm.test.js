import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../../src/db/adminConfigRepo.js';

const SIE = /\b(Sie|Ihnen|Ihre?[mnrs]?)\b/g;
const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../views');

// Ausnahmen: "Sie" als Pronomen der 3. Person. Exakte Satzanfaenge, keine Pauschalfreigabe.
const ERLAUBT = [
  'Sie fasst das Ergebnis',
  'Sie werden erst verbucht',
  'Sie werden nicht an n8n',
];

function ejsDateien(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ejsDateien(p);
    return e.name.endsWith('.ejs') ? [p] : [];
  });
}

function treffer(text) {
  const out = [];
  for (const m of text.matchAll(SIE)) {
    const ab = text.slice(m.index);
    if (ERLAUBT.some((a) => ab.startsWith(a))) continue;
    out.push(text.slice(Math.max(0, m.index - 20), m.index + 30).replace(/\s+/g, ' '));
  }
  return out;
}

test('Standard-Mailvorlagen und Views verwenden keine Sie-Form', () => {
  const funde = [];
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (key.startsWith('mail_vorlage_')) for (const t of treffer(String(value))) funde.push(`${key}: ${t}`);
  }
  for (const datei of ejsDateien(VIEWS)) {
    for (const t of treffer(fs.readFileSync(datei, 'utf8'))) funde.push(`${path.relative(VIEWS, datei)}: ${t}`);
  }
  assert.deepEqual(funde, []);
});
