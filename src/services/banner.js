// Banner: Zeitfenster, Reihenfolge, Ausblenden und Eingabeprüfung.
export const BANNER_ARTEN = ['wartung', 'warnung', 'info'];
const REIHENFOLGE = { wartung: 0, warnung: 1, info: 2 };
export const BANNER_TEXT_MAX = 1000;

export function aktiveBanner(db, personId, jetzt = new Date()) {
  const iso = jetzt.toISOString();
  const zeilen = db
    .prepare(`SELECT b.id, b.art, b.text, b.link, b.von FROM banner b
      WHERE b.aktiv = 1 AND b.von <= ? AND b.bis >= ?
        AND NOT (b.art = 'info' AND EXISTS (SELECT 1 FROM banner_ausgeblendet a WHERE a.banner_id = b.id AND a.person_id = ?))`)
    .all(iso, iso, String(personId));
  zeilen.sort((a, b) => REIHENFOLGE[a.art] - REIHENFOLGE[b.art] || (a.von < b.von ? -1 : a.von > b.von ? 1 : a.id - b.id));
  return zeilen.map((z) => ({ id: z.id, art: z.art, text: z.text, link: z.link || null, wegklickbar: z.art === 'info' }));
}

export function blendeBannerAus(db, bannerId, personId) {
  const banner = db.prepare('SELECT art FROM banner WHERE id = ?').get(bannerId);
  if (!banner) return 'nicht_gefunden';
  if (banner.art !== 'info') return 'nicht_wegklickbar';
  db.prepare('INSERT OR IGNORE INTO banner_ausgeblendet (banner_id, person_id, zeitpunkt) VALUES (?, ?, ?)')
    .run(bannerId, String(personId), new Date().toISOString());
  return 'ok';
}

function istZeit(wert) {
  return typeof wert === 'string' && wert !== '' && !Number.isNaN(new Date(wert).getTime());
}

export function pruefeBannerEingabe({ art, text, link, von, bis } = {}) {
  const fehler = [];
  if (!BANNER_ARTEN.includes(art)) fehler.push('Art muss Info, Wartung oder Warnung sein.');
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.length < 1 || t.length > BANNER_TEXT_MAX) fehler.push(`Der Text muss zwischen 1 und ${BANNER_TEXT_MAX} Zeichen lang sein.`);
  if (link != null && String(link).trim() !== '') {
    const l = String(link).trim();
    const ok = /^https:\/\/[^\s]+$/i.test(l) || (/^\/[^\s]*$/.test(l) && !l.startsWith('//') && !l.includes('\\'));
    if (!ok) fehler.push('Der Link muss mit https:// oder / beginnen.');
  }
  if (!istZeit(von)) fehler.push('Beginn ist ungültig.');
  if (!istZeit(bis)) fehler.push('Ende ist ungültig.');
  if (istZeit(von) && istZeit(bis) && new Date(bis) < new Date(von)) fehler.push('Das Ende darf nicht vor dem Beginn liegen.');
  return fehler;
}
