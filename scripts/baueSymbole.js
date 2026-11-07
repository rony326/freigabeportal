// Baut aus den benötigten Bootstrap-Icons ein SVG-Sprite (public/vendor/bootstrap-icons/symbole.svg).
// Aufruf: node scripts/baueSymbole.js — Ergebnis wird eingecheckt (kein Build-Schritt zur Laufzeit).
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SYMBOLE } from '../src/services/navigation.js';

const wurzel = fileURLToPath(new URL('..', import.meta.url));
const ziel = `${wurzel}public/vendor/bootstrap-icons/`;
mkdirSync(ziel, { recursive: true });

const teile = [...new Set(SYMBOLE)].sort().map((name) => {
  let svg;
  try {
    svg = readFileSync(`${wurzel}node_modules/bootstrap-icons/icons/${name}.svg`, 'utf8');
  } catch {
    throw new Error(`Symbol "${name}" fehlt in bootstrap-icons`);
  }
  const innen = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  return `<symbol id="${name}" viewBox="0 0 16 16">${innen}</symbol>`;
});

writeFileSync(`${ziel}symbole.svg`, `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${teile.join('\n')}\n</svg>\n`);
copyFileSync(`${wurzel}node_modules/bootstrap-icons/LICENSE`, `${ziel}LICENSE`);
console.log(`${teile.length} Symbole geschrieben`);
