// Kleiner Quelltext-Scanner für den asyncHandler-Sweep: findet `async`-Funktionen (Pfeil und
// function) und deren Rumpf-Grenzen. Kein vollständiger JS-Parser, aber er überspringt Strings,
// Template-Literale (inkl. ${…}), Kommentare und Regex-Literale, sodass Klammern darin nicht zählen.

const REGEX_VORGAENGER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);

// Liefert eine Maske: true an Positionen, die Code sind (nicht String/Kommentar/Regex-Inhalt).
export function codeMaske(src) {
  const maske = new Array(src.length).fill(false);
  const stapel = []; // offene Template-Literale: Tiefe der ${-Klammern
  let i = 0;
  let letztesZeichen = '';
  const n = src.length;
  function template() {
    // i steht hinter dem öffnenden Backtick
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        maske[i] = maske[i + 1] = true;
        i += 2;
        code(1);
        continue;
      }
      i++;
    }
  }
  function code(tiefeStart) {
    let tiefe = tiefeStart;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") {
        i++;
        while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
        i++; letztesZeichen = 'a'; continue;
      }
      if (c === '`') { i++; template(); letztesZeichen = 'a'; continue; }
      if (c === '/' && REGEX_VORGAENGER.has(letztesZeichen)) {
        i++;
        let klasse = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '[') klasse = true;
          else if (d === ']') klasse = false;
          else if (d === '/' && !klasse) break;
          else if (d === '\n') break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        letztesZeichen = 'a'; continue;
      }
      maske[i] = true;
      if (c === '{') tiefe++;
      if (c === '}') {
        tiefe--;
        if (tiefeStart > 0 && tiefe === 0) { i++; return; }
      }
      if (!/\s/.test(c)) letztesZeichen = /[\w$)\]]/.test(c) ? 'a' : c;
      i++;
    }
  }
  code(0);
  return maske;
}

// Index der zur `{` an Position `start` passenden `}` (nur Code-Positionen zählen).
export function passendeKlammer(src, maske, start) {
  let tiefe = 0;
  for (let i = start; i < src.length; i++) {
    if (!maske[i]) continue;
    if (src[i] === '{') tiefe++;
    else if (src[i] === '}') { tiefe--; if (tiefe === 0) return i; }
  }
  return -1;
}

// Alle async-Funktionen: { index (Position von "async"), kopf, rumpfStart, rumpfEnde, vorher }.
export function findeAsyncFunktionen(src) {
  const maske = codeMaske(src);
  const treffer = [];
  const re = /\basync\b/g;
  let m;
  while ((m = re.exec(src))) {
    if (!maske[m.index]) continue;
    const rumpfStart = src.indexOf('{', m.index);
    if (rumpfStart < 0) continue;
    const kopf = src.slice(m.index, rumpfStart);
    // Nur Funktionen mit Block-Rumpf: "async (…) =>" oder "async function name(…)".
    if (!/^async\s*(\([^)]*\)\s*=>|\w+\s*=>|function\b[^{]*)\s*$/.test(kopf)) continue;
    const rumpfEnde = passendeKlammer(src, maske, rumpfStart);
    treffer.push({ index: m.index, kopf, rumpfStart, rumpfEnde, vorher: src.slice(Math.max(0, m.index - 40), m.index) });
  }
  return treffer;
}
