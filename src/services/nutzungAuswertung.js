// Auswertungen für Admin → Betrieb & Nutzung. Median/p90 werden in JS aus den Zeilen berechnet.
const LANGSAM_MIN_AUFRUFE = 20;
const LANGSAM_ANZAHL = 10;
const TOP_SEITEN_ANZAHL = 20;

export function median(werte) {
  if (werte.length === 0) return null;
  const s = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(s.length / 2);
  return s.length % 2 ? s[mitte] : Math.round((s[mitte - 1] + s[mitte]) / 2);
}

// Nearest-Rank: kleinster Wert, unter dem mindestens 90 % liegen.
export function p90(werte) {
  if (werte.length === 0) return null;
  const s = [...werte].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

const tagFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });

// Kalendertag in Zürcher Ortszeit, z. B. "2026-10-24".
function tagZurich(iso) {
  return tagFormat.format(new Date(iso));
}

function verteilung(zeilen, feld) {
  const zaehler = new Map();
  for (const z of zeilen) {
    const wert = z[feld] || 'unbekannt';
    zaehler.set(wert, (zaehler.get(wert) || 0) + 1);
  }
  return [...zaehler].map(([wert, anzahl]) => ({ wert, anzahl }))
    .sort((a, b) => b.anzahl - a.anzahl || a.wert.localeCompare(b.wert, 'de'));
}

export function uebersicht(db, { von, bis, personId = null }) {
  const personFilter = personId ? ' AND person_id = ?' : '';
  const parameter = personId ? [von, bis, String(personId)] : [von, bis];
  const aufrufe = db
    .prepare(`SELECT person_id, pfad_muster, dauer_ms, geraet_typ, browser, betriebssystem FROM nutzung_seitenaufrufe
      WHERE zeitpunkt >= ? AND zeitpunkt < ?${personFilter}`)
    .all(...parameter);

  const proSeite = new Map();
  for (const a of aufrufe) {
    let eintrag = proSeite.get(a.pfad_muster);
    if (!eintrag) proSeite.set(a.pfad_muster, (eintrag = { anzahl: 0, dauern: [] }));
    eintrag.anzahl += 1;
    if (Number.isFinite(a.dauer_ms)) eintrag.dauern.push(a.dauer_ms);
  }
  const seiten = [...proSeite].map(([pfadMuster, e]) => ({ pfadMuster, anzahl: e.anzahl, medianMs: median(e.dauern), p90Ms: p90(e.dauern), dauern: e.dauern.length }));
  const topSeiten = [...seiten]
    .sort((a, b) => b.anzahl - a.anzahl || a.pfadMuster.localeCompare(b.pfadMuster))
    .slice(0, TOP_SEITEN_ANZAHL)
    .map(({ pfadMuster, anzahl, medianMs }) => ({ pfadMuster, anzahl, medianMs }));
  const langsameSeiten = seiten
    .filter((s) => s.dauern >= LANGSAM_MIN_AUFRUFE)
    .sort((a, b) => b.p90Ms - a.p90Ms || a.pfadMuster.localeCompare(b.pfadMuster))
    .slice(0, LANGSAM_ANZAHL)
    .map(({ pfadMuster, anzahl, medianMs, p90Ms }) => ({ pfadMuster, anzahl, medianMs, p90Ms }));

  const fehlerZeiten = db
    .prepare(`SELECT zeitpunkt FROM betrieb_fehler WHERE zeitpunkt >= ? AND zeitpunkt < ?${personFilter}`)
    .all(...parameter);
  const proTag = new Map();
  for (const { zeitpunkt } of fehlerZeiten) {
    const tag = tagZurich(zeitpunkt);
    proTag.set(tag, (proTag.get(tag) || 0) + 1);
  }
  const fehlerProTag = [...proTag].map(([tag, anzahl]) => ({ tag, anzahl })).sort((a, b) => (a.tag < b.tag ? -1 : 1));

  return {
    aktivePersonen: new Set(aufrufe.map((a) => a.person_id)).size,
    seitenaufrufe: aufrufe.length,
    geraeteTypen: verteilung(aufrufe, 'geraet_typ'),
    browser: verteilung(aufrufe, 'browser'),
    betriebssysteme: verteilung(aufrufe, 'betriebssystem'),
    topSeiten,
    langsameSeiten,
    fehlerProTag,
  };
}

export function personDetail(db, personId) {
  const id = String(personId);
  return {
    anmeldungen: db.prepare('SELECT * FROM nutzung_anmeldungen WHERE person_id = ? ORDER BY zeitpunkt DESC, id DESC LIMIT 50').all(id),
    geraete: db.prepare('SELECT * FROM nutzung_geraete WHERE person_id = ? ORDER BY zuletzt_am DESC').all(id),
    letzteAufrufe: db.prepare('SELECT * FROM nutzung_seitenaufrufe WHERE person_id = ? ORDER BY zeitpunkt DESC, id DESC LIMIT 100').all(id),
    fehler: db.prepare('SELECT id, request_id, zeitpunkt, methode, pfad, status, meldung FROM betrieb_fehler WHERE person_id = ? ORDER BY zeitpunkt DESC LIMIT 100').all(id),
    meldungen: db.prepare('SELECT * FROM betrieb_fehlermeldungen WHERE person_id = ? ORDER BY zeitpunkt DESC, id DESC LIMIT 100').all(id),
  };
}
