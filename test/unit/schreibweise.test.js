// Schreibweise-Sweep: Schweizer Rechtschreibung (kein "ß"), echte Umlaute in sichtbaren Texten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Bewusst NICHT abgedeckt: <script>-Blöcke, Attributwerte name/value/id/href/..., Mail-Variablen,
// sowie technische API-/TSA-/DB-Trigger-Texte und Logmeldungen in src/ (nur die Dateien in QUELLEN).
const VERBOTEN = /\b(pruef\w*|\w*geprueft|bestaetig\w*|\w*aender\w*|\w*aendert|veraendert|waehrend|fuer|geklaert|\w*empfaenger|\w*gueltig\w*|muessen|\w*staendig\w*|ueberein|\w*loesch\w*)\b/i;
const QUELLEN = [
  'src/services/paymentApproval.js', 'src/routes/freigabe2.js', 'src/routes/spesenFreigabe1.js',
  'src/services/exportSnapshot.js', 'src/services/verwaisteDateien.js', 'src/services/splitGruppenExport.js',
  'src/services/backup.js', 'src/services/offlineRestore.js', 'src/services/storageState.js',
  'src/services/altfaelle.js', 'src/routes/admin/altfaelle.js', 'src/services/sicherheitsalarme.js',
];

function ejsDateien(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...ejsDateien(p));
    else if (e.name.endsWith('.ejs')) out.push(p);
  }
  return out;
}

// Ersetzt Bereiche durch Leerzeichen, damit Zeilennummern erhalten bleiben.
function blank(s) { return s.replace(/[^\n]/g, ' '); }
function ohneCodeUndBezeichner(text) {
  return text
    .replace(/<%[\s\S]*?%>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script[\s\S]*?<\/script>/gi, blank) // JS-Bezeichner sind keine Texte
    .replace(/%\w+%/g, blank) // Mail-Vorlagenvariablen
    .replace(/\b(?:name|value|id|for|href|action|aria-labelledby|aria-controls|data-bs-target)\s*=\s*("[^"]*"|'[^']*')/g, blank)
    .replace(/(?<=\s)[\w:.-]+(?==["'])/g, blank) // Attributnamen (z. B. data-bestaetigen=)
    .replace(/(?<=\s)data-[\w-]+/g, blank); // boolesche data-Attribute
}

function treffer(text, datei, liste) {
  text.split('\n').forEach((zeile, i) => {
    const m = zeile.match(VERBOTEN);
    if (m) liste.push(`${datei}:${i + 1}: "${m[0]}"`);
  });
}

test('views: kein "ß" (Schweizer Schreibweise)', () => {
  const hits = [];
  for (const f of ejsDateien(path.join(ROOT, 'views'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((z, i) => {
      if (z.includes('ß')) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'ß gefunden:\n' + hits.join('\n'));
});

test('views: keine ASCII-Umschreibungen von Umlauten in sichtbaren Texten', () => {
  const hits = [];
  for (const f of ejsDateien(path.join(ROOT, 'views'))) {
    treffer(ohneCodeUndBezeichner(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f), hits);
  }
  assert.deepEqual(hits, [], 'ASCII-Umlaute:\n' + hits.join('\n'));
});

// Textliterale mit Leerzeichen in <%= %>-Ausdrücken (z. B. Ternary-Texte in Labels) sind sichtbar.
test('views: keine ASCII-Umlaute in Textliteralen innerhalb von <%= %>', () => {
  const hits = [];
  for (const f of ejsDateien(path.join(ROOT, 'views'))) {
    const text = fs.readFileSync(f, 'utf8');
    const re = /<%[=-]([\s\S]*?)%>/g;
    let m;
    while ((m = re.exec(text))) {
      const lit = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
      let l;
      while ((l = lit.exec(m[1]))) {
        if (l[2].includes(' ') && VERBOTEN.test(l[2])) {
          const zeile = text.slice(0, m.index).split('\n').length;
          hits.push(`${path.relative(ROOT, f)}:${zeile}: ${l[2].slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(hits, [], 'ASCII-Umlaute in Ausdrücken:\n' + hits.join('\n'));
});

test('Routen/Services: keine ASCII-Umlaute in Textliteralen mit Leerzeichen', () => {
  const hits = [];
  for (const rel of QUELLEN) {
    const zeilen = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    zeilen.forEach((z, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(z)) return;
      const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
      let m;
      while ((m = re.exec(z))) {
        if (m[2].includes(' ') && VERBOTEN.test(m[2])) hits.push(`${rel}:${i + 1}: ${m[2].slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [], 'ASCII-Umlaute in Literalen:\n' + hits.join('\n'));
});
