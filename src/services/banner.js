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
  // Link nochmals prüfen (Verteidigung in der Tiefe, falls er nicht über das Formular kam).
  return zeilen.map((z) => ({ id: z.id, art: z.art, text: z.text, link: z.link && linkGueltig(z.link) ? z.link : null, wegklickbar: z.art === 'info' }));
}

export function blendeBannerAus(db, bannerId, personId) {
  const banner = db.prepare('SELECT art FROM banner WHERE id = ?').get(bannerId);
  if (!banner) return 'nicht_gefunden';
  if (banner.art !== 'info') return 'nicht_wegklickbar';
  db.prepare('INSERT OR IGNORE INTO banner_ausgeblendet (banner_id, person_id, zeitpunkt) VALUES (?, ?, ?)')
    .run(bannerId, String(personId), new Date().toISOString());
  return 'ok';
}

// Nur https:// oder ein Portal-Pfad (kein //, kein Backslash).
export function linkGueltig(link) {
  const l = String(link).trim();
  return /^https:\/\/[^\s]+$/i.test(l) || (/^\/[^\s]*$/.test(l) && !l.startsWith('//') && !l.includes('\\'));
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
    if (!linkGueltig(link)) fehler.push('Der Link muss mit https:// oder / beginnen.');
  }
  if (!istZeit(von)) fehler.push('Beginn ist ungültig.');
  if (!istZeit(bis)) fehler.push('Ende ist ungültig.');
  if (istZeit(von) && istZeit(bis) && new Date(bis) < new Date(von)) fehler.push('Das Ende darf nicht vor dem Beginn liegen.');
  return fehler;
}

const ZEITZONE = 'Europe/Zurich';
const LOKAL_MUSTER = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function zurichTeile(datum) {
  const teile = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZEITZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(datum).map((t) => [t.type, t.value]));
  return teile;
}

// datetime-local ("2026-10-24T10:00") als Zürcher Ortszeit → ISO in UTC; ungültig → ''.
export function zurichLokalZuIso(wert) {
  const t = typeof wert === 'string' ? wert.match(LOKAL_MUSTER) : null;
  if (!t) return '';
  const [j, mo, d, h, mi] = t.slice(1).map(Number);
  const alsUtc = Date.UTC(j, mo - 1, d, h, mi);
  const probe = new Date(alsUtc);
  if (probe.getUTCFullYear() !== j || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) return '';
  // Versatz zweimal bestimmen, damit Umstellungstage stimmen.
  let ms = alsUtc;
  for (let i = 0; i < 2; i++) {
    const z = zurichTeile(new Date(ms));
    const zAlsUtc = Date.UTC(Number(z.year), Number(z.month) - 1, Number(z.day), Number(z.hour), Number(z.minute));
    ms = alsUtc - (zAlsUtc - ms);
  }
  return new Date(ms).toISOString();
}

// ISO → datetime-local-Wert in Zürcher Ortszeit (für Formulare).
export function isoZuZurichLokal(iso) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '';
  const z = zurichTeile(new Date(iso));
  return `${z.year}-${z.month}-${z.day}T${z.hour}:${z.minute}`;
}
