// Heuristiken für Kreditkartenabrechnungen. Liefern nur Vorschläge -- nichts hier darf eine
// fachliche Entscheidung erzwingen.

// Betrag: optionales Minus, Tausendertrenner ' ' oder Leerzeichen, genau zwei Nachkommastellen
// mit . oder ,, optional gefolgt von CR oder - (Gutschrift). Die Lookbehind/-ahead-Grenzen
// verhindern Treffer mitten in Datumsangaben (03.09.2026) oder Kartennummern.
const BETRAG_RE = /(?<![\d.,''])(-\s?)?(\d{1,3}(?:['' ]\d{3})+|\d+)[.,](\d{2})(?![\d.,])(\s?(?:CR\b|-))?/g;
const DATUM_RES = [
  { re: /\b(\d{2})\.(\d{2})\.(\d{4})\b/g, map: (m) => `${m[3]}-${m[2]}-${m[1]}` },
  { re: /\b(\d{2})\.(\d{2})\.(\d{2})\b(?!\.)/g, map: (m) => `20${m[3]}-${m[2]}-${m[1]}` },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, map: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { re: /\b(\d{2})\/(\d{2})\/(\d{4})\b/g, map: (m) => `${m[3]}-${m[2]}-${m[1]}` },
];
const ENDZIFFERN_RE = /[*Xx•]{2,4}(?:[ \-]?[*Xx•]{2,4}){0,3}[ \-]?(\d{4})(?!\d)/g;
const TOTAL_RE = /total|saldo|zu bezahlen|rechnungsbetrag/i;

export const LEERE_ANALYSE = Object.freeze({ betraege: [], daten: [], total: null });

// Belegzeilen sind kurz; längere Zeilen werden gekürzt, damit BETRAG_RE auf langen
// Zifferngruppen-Folgen nicht quadratisch zurücksetzt.
const MAX_ZEILENLAENGE = 500;

function zeilen(text) {
  return String(text || '').split(/\r?\n/).map((z) => z.slice(0, MAX_ZEILENLAENGE));
}

function istGueltigesDatum(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function betraegeInZeile(zeile) {
  // Datumsangaben vorher ausblenden, damit "03.09.26" nicht als 3.09 gelesen wird.
  let bereinigt = zeile;
  for (const { re } of DATUM_RES) bereinigt = bereinigt.replace(new RegExp(re.source, 'g'), (m) => ' '.repeat(m.length));
  const treffer = [];
  for (const m of bereinigt.matchAll(BETRAG_RE)) {
    const ganz = m[2].replace(/['' ]/g, '');
    const negativ = Boolean(m[1]) || Boolean(m[4]);
    treffer.push(`${negativ ? '-' : ''}${Number(`${ganz}.${m[3]}`).toFixed(2)}`);
  }
  return treffer;
}

export function findeBetraege(text) {
  const result = [];
  zeilen(text).forEach((zeile, i) => {
    for (const betrag of betraegeInZeile(zeile)) result.push({ betrag, zeile: i });
  });
  return result;
}

export function findeDaten(text) {
  const result = [];
  zeilen(text).forEach((zeile, i) => {
    const gefunden = [];
    for (const { re, map } of DATUM_RES) {
      for (const m of zeile.matchAll(new RegExp(re.source, 'g'))) {
        const iso = map(m);
        if (istGueltigesDatum(iso)) gefunden.push({ index: m.index, datum: iso });
      }
    }
    gefunden.sort((a, b) => a.index - b.index).forEach((g) => result.push({ datum: g.datum, zeile: i }));
  });
  return result;
}

export function findeEndziffern(text) {
  const result = new Set();
  const begrenzt = String(text || '').slice(0, 200000);
  for (const m of begrenzt.matchAll(ENDZIFFERN_RE)) result.add(m[1]);
  return result;
}

export function schlageTotalVor(text) {
  for (const zeile of zeilen(text)) {
    if (!TOTAL_RE.test(zeile)) continue;
    // Prefer amount directly after CHF token
    const chfIdx = /\bCHF\b/i.exec(zeile)?.index;
    if (chfIdx !== undefined) {
      const afterChf = zeile.slice(chfIdx);
      const betraege = betraegeInZeile(afterChf);
      if (betraege.length > 0) return betraege[0];
    }
    // Otherwise return last amount on the line
    const betraege = betraegeInZeile(zeile);
    if (betraege.length > 0) return betraege.at(-1);
  }
  return null;
}

export function analysiereText(text) {
  const begrenzt = String(text || '').slice(0, 200000);
  return { betraege: findeBetraege(begrenzt), daten: findeDaten(begrenzt), total: schlageTotalVor(begrenzt) };
}

function tageAbstand(a, b) {
  return Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000;
}

// Ein Beleg wird vorgeschlagen, wenn sein Betrag (Absolutwert -- Gutschriften stehen je nach Bank
// als "-", "CR" oder positiv da) in der Abrechnung vorkommt. Jede Fundstelle deckt höchstens
// einen Beleg ab; Belege mit passendem Datum (±3 Tage, gleiche Textzeile) kommen zuerst dran.
export function berechneVorschlaege(belege, analyse) {
  const a = analyse || LEERE_ANALYSE;
  const fundstellen = new Map();
  for (const { betrag, zeile } of a.betraege) {
    const key = Math.abs(Number(betrag)).toFixed(2);
    if (!fundstellen.has(key)) fundstellen.set(key, []);
    fundstellen.get(key).push(zeile);
  }
  const datenProZeile = new Map();
  for (const { datum, zeile } of a.daten) {
    if (!datenProZeile.has(zeile)) datenProZeile.set(zeile, []);
    datenProZeile.get(zeile).push(datum);
  }
  const kandidaten = belege
    .filter((b) => b.betrag != null)
    .map((b) => {
      const key = Math.abs(Number(b.betrag)).toFixed(2);
      const zeilenMitBetrag = fundstellen.get(key) || [];
      const datumZeile = b.kaufdatum
        ? zeilenMitBetrag.find((z) => (datenProZeile.get(z) || []).some((d) => tageAbstand(d, b.kaufdatum) <= 3))
        : undefined;
      return { beleg: b, key, datumZeile };
    })
    .filter((k) => (fundstellen.get(k.key) || []).length > 0)
    .sort((x, y) => Number(y.datumZeile !== undefined) - Number(x.datumZeile !== undefined));

  const vorschlaege = new Map();
  for (const k of kandidaten) {
    const frei = fundstellen.get(k.key);
    if (frei.length === 0) continue;
    const idx = k.datumZeile !== undefined && frei.includes(k.datumZeile) ? frei.indexOf(k.datumZeile) : 0;
    const genutzteZeile = frei.splice(idx, 1)[0];
    vorschlaege.set(k.beleg.id, k.datumZeile !== undefined && genutzteZeile === k.datumZeile ? 'betrag_datum' : 'betrag');
  }
  return vorschlaege;
}
