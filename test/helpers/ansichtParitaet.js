// Hilfen für Tests der Ansichtswahl Tabelle/Kacheln (Task 7 ff.): Bereiche `div.ansicht-tabelle` /
// `div.ansicht-kacheln` aus dem HTML schneiden und deren Link-/Formularziele vergleichen.

// Liefert den vollständigen Inhalt jedes <div>, dessen class-Attribut `klasse` als Wort enthält,
// in Dokumentreihenfolge (verschachtelte <div> werden mitgezählt).
export function divBereiche(html, klasse) {
  const bereiche = [];
  const start = new RegExp(`<div\\b[^>]*\\bclass="(?:[^"]*\\s)?${klasse}(?:\\s[^"]*)?"[^>]*>`, 'g');
  let treffer;
  while ((treffer = start.exec(html)) !== null) {
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = treffer.index + treffer[0].length;
    let tiefe = 1;
    let t;
    while (tiefe > 0 && (t = tag.exec(html)) !== null) {
      tiefe += t[0].startsWith('</') ? -1 : 1;
    }
    const ende = t ? t.index + t[0].length : html.length;
    bereiche.push(html.slice(treffer.index, ende));
    start.lastIndex = ende;
  }
  return bereiche;
}

// Sortierte Liste aller href- und action-Werte (mit Duplikaten), z.B. ['href:/kontierung/3', 'action:/…'].
export function linkZiele(fragment) {
  const ziele = [];
  for (const m of fragment.matchAll(/\b(href|action)="([^"]*)"/g)) ziele.push(`${m[1]}:${m[2]}`);
  return ziele.sort();
}

// Paart die n-te `ansicht-tabelle` mit der n-ten `ansicht-kacheln` und liefert je Paar die Ziele.
// Voraussetzung: Ansicht 'auto' (beide Darstellungen gerendert).
export function ansichtPaare(html) {
  const tabellen = divBereiche(html, 'ansicht-tabelle');
  const kacheln = divBereiche(html, 'ansicht-kacheln');
  if (tabellen.length !== kacheln.length) {
    throw new Error(`ungleich viele Bereiche: ${tabellen.length} Tabellen, ${kacheln.length} Kachelbereiche`);
  }
  return tabellen.map((tabelle, i) => ({
    tabelle,
    kacheln: kacheln[i],
    tabellenZiele: linkZiele(tabelle),
    kachelZiele: linkZiele(kacheln[i]),
  }));
}

// Alle id="…"-Werte, die mehr als einmal vorkommen.
export function doppelteIds(html) {
  const gesehen = new Map();
  for (const m of html.matchAll(/\sid="([^"]*)"/g)) gesehen.set(m[1], (gesehen.get(m[1]) ?? 0) + 1);
  return [...gesehen].filter(([, n]) => n > 1).map(([id]) => id);
}
